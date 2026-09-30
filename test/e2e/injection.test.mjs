'use strict';

// E2E-тест внедрения по списку сайтов (QA-006): на хосте фикстуры до включения
// страничный скрипт не выполняется, после добавления хоста выполняется на
// следующей загрузке страницы, после удаления снова не выполняется.
//
// Реальная регистрация через chrome.scripting.registerContentScripts
// (src/background.js) не наблюдаема в этом окружении: то же ограничение, что
// нашла и задокументировала QA-002 (test/e2e/core.test.mjs) — importScripts()
// внутри background.js падает под --load-extension. Переподтверждено здесь
// заново (не из памяти): под chromium-1217, playwright-core 1.58, после
// загрузки расширения через --load-extension=src и ожидания service worker
// (context.waitForEvent('serviceworker')), chrome.scripting доступен
// (typeof chrome.scripting !== 'undefined'), но обращение к
// globalThis.injection/globalThis.siteList из воркера даёт
// `ReferenceError: siteList is not defined` — importScripts('injection.js',
// 'site-list.js') не выполнился, ни один globalThis.* модуль не появился,
// chrome.scripting.getRegisteredContentScripts() после onInstalled пуст.
//
// Вместо загрузки настоящего расширения тест воспроизводит решение о
// внедрении той же логикой, что использует src/background.js
// (enabledHosts: src/background.js:31-35) — напрямую вызывая production-модули
// src/site-list.js (isHostEnabled) и src/injection.js (hostToMatchPattern,
// toMatchPatterns), — и подаёт содержимое src/page/core.js через отдельный
// HTTP-эндпоинт фикстур-сервера, который на каждый запрос заново решает,
// положен ли текущему хосту скрипт, по актуальному состоянию списка сайтов.
// Один и тот же контекст браузера (один профиль, без переустановки) грузит
// фикстуру заново на каждом шаге теста — так же, как реальная вкладка была бы
// переинъецирована на следующей навигации после смены регистрации.
//
// Изоляция как в QA-002: профиль браузера — временный каталог ОС, фикстуры —
// локальный сервер на свободном порту, teardown в after() при любом исходе.

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import siteList from '../../src/site-list.js';
import injection from '../../src/injection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES_DIR = path.join(ROOT, 'test/e2e/fixtures');
const CORE_JS_PATH = path.join(ROOT, 'src/page/core.js');
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

const coreSource = fs.readFileSync(CORE_JS_PATH, 'utf8');

// Та же проверка, что делает src/background.js перед регистрацией
// (enabledHosts): объединение набора по умолчанию и пользовательских хостов,
// без дублей, отфильтрованное по isHostEnabled. Пересчитывается на каждый
// запрос фикстур-сервера, поэтому отражает текущее, а не начальное состояние.
function computeCoreHosts(state) {
  const merged = [...siteList.DEFAULT_HOSTS, ...state.added].filter(
    (host, index, hosts) => hosts.indexOf(host) === index,
  );
  return merged.filter((host) => siteList.isHostEnabled(host, state));
}

function isHostInjected(fixtureHost, state) {
  const matches = injection.toMatchPatterns(computeCoreHosts(state));
  return matches.includes(injection.hostToMatchPattern(fixtureHost));
}

function startFixtureServer(getState, getFixtureHost) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    if (url.pathname === '/__inject__') {
      if (isHostInjected(getFixtureHost(), getState())) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(coreSource);
      } else {
        res.writeHead(204).end();
      }
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'plain.html';
    const filePath = path.join(FIXTURES_DIR, rel);
    if (!filePath.startsWith(FIXTURES_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = path.extname(filePath) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// В контексте один раз регистрируется init-script, который на КАЖДОЙ
// навигации заново спрашивает сервер, положен ли этой загрузке страничный
// скрипт (fetch, не синхронно — как и реальный chrome.scripting, решение
// действует на момент загрузки, а не фиксируется один раз при старте
// браузера). Так смена списка сайтов между загрузками страницы моделирует
// «применяется без переустановки» без обращения к сломанному в этом
// окружении service worker.
function injectionProbe() {
  window.__listeningGlassInjectDone = fetch('/__inject__')
    .then((r) => (r.status === 200 ? r.text() : null))
    .then((src) => { if (src) new Function(src)(); })
    .catch(() => {});
}

async function openFixtureAndWait(context, port) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/plain.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__listeningGlassInjectDone);
  return page;
}

describe('E2E внедрение: страничный скрипт следует за состоянием хоста в списке сайтов', () => {
  let fixtureServer = null;
  let port = null;
  let context = null;
  let profileDir = null;
  let state = null;
  let fixtureHost = null;

  before(async () => {
    state = siteList.sanitizeState(null);
    const started = await startFixtureServer(() => state, () => fixtureHost);
    fixtureServer = started.server;
    port = started.port;
    fixtureHost = `127.0.0.1:${port}`;

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-injection-profile-'));
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_EXE,
      headless: true,
    });
    await context.addInitScript(injectionProbe);
  });

  after(async () => {
    if (context) await context.close().catch(() => {});
    if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  test('до включения хоста страничный скрипт не выполняется', async () => {
    assert.equal(siteList.isHostEnabled(fixtureHost, state), false,
      'хост фикстуры не должен быть включён на старте');
    const page = await openFixtureAndWait(context, port);
    try {
      const injected = await page.evaluate(() => window.__listeningGlassCore === true);
      assert.equal(injected, false, 'скрипт не должен выполниться на выключенном хосте');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('после добавления хоста скрипт выполняется на следующей загрузке', async () => {
    state = siteList.addHostToState(fixtureHost, state);
    assert.equal(siteList.isHostEnabled(fixtureHost, state), true,
      'хост фикстуры должен быть включён после добавления');
    const page = await openFixtureAndWait(context, port);
    try {
      const injected = await page.evaluate(() => window.__listeningGlassCore === true);
      const marker = await page.evaluate(() =>
        document.documentElement.getAttribute('data-listening-glass-core'));
      assert.equal(injected, true, 'скрипт должен выполниться на следующей загрузке после добавления хоста');
      assert.equal(marker, 'started', 'маркер ядра должен появиться на documentElement');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('после удаления хоста скрипт снова не выполняется', async () => {
    state = siteList.removeHostFromState(fixtureHost, state);
    assert.equal(siteList.isHostEnabled(fixtureHost, state), false,
      'хост фикстуры должен быть выключен после удаления');
    const page = await openFixtureAndWait(context, port);
    try {
      const injected = await page.evaluate(() => window.__listeningGlassCore === true);
      assert.equal(injected, false, 'скрипт не должен выполниться после удаления хоста со следующей загрузки');
    } finally {
      await page.close().catch(() => {});
    }
  });
});
