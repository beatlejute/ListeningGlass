'use strict';

// E2E-тест ядра (QA-002): Chromium Playwright на локальных офлайн-фикстурах,
// по одной на каждый поведенческий шаблон из таблицы «Сайты по умолчанию»
// плана PLAN-001. Для каждой фикстуры — прогон без ядра (ограничение
// воспроизводится) и с ядром (снято).
//
// Загрузка через --load-extension (реальный сервис-воркер расширения)
// проверена и отклонена: chrome.scripting.registerContentScripts никогда не
// срабатывает в этом окружении — importScripts() внутри background.js
// стабильно падает с NetworkError «failed to load» на chromium-1208 и
// chromium-1217 playwright-core 1.58.2, при том что fetch() того же файла из
// того же контекста отдаёт 200 — see Result/Заметки тикета QA-002 за
// воспроизведение. Вместо этого содержимое src/page/core.js внедряется как
// init-script в main world до скриптов страницы — тот же приём, что уже
// проверен на реальных сайтах в QA-003 (research/harness/run.mjs, флаг
// --inject) и текстуально описан в заголовке run.mjs как эквивалент
// MAIN-world контент-скрипта на document_start.
//
// Включение хоста фикстур в список — тестовым способом: напрямую через
// src/site-list.js (addHostToState/isHostEnabled), без прохода через
// chrome.storage и service worker, которые в этом окружении недоступны.
//
// Изоляция: профиль браузера — временный каталог ОС (research/harness/run.mjs:49),
// фикстуры раздаёт локальный сервер на свободном порту. Удаление каталога и
// остановка сервера — в teardown при любом исходе (research/harness/run.mjs:137-140).

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES_DIR = path.join(ROOT, 'test/e2e/fixtures');
const CORE_JS_PATH = path.join(ROOT, 'src/page/core.js');
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const filePath = path.join(FIXTURES_DIR, rel);
    if (!filePath.startsWith(FIXTURES_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Тот же приём, что в research/harness/run.mjs (instrumentHidingOnly): нативные
// геттеры на Document.prototype подменяются управляемым флагом, чтобы можно было
// сымитировать скрытие страницы так же, как это видит настоящий свёрнутый браузер.
function instrumentHidingOnly() {
  window.__fakeHidden = false;
  const proto = Document.prototype;
  for (const [name, hiddenValue] of [['visibilityState', 'hidden'], ['hidden', true]]) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { configurable: true, get() { return window.__fakeHidden ? hiddenValue : desc.get.call(this); } });
  }
  const hasFocus = proto.hasFocus;
  proto.hasFocus = function () { return window.__fakeHidden ? false : hasFocus.call(this); };
}

async function setHidden(page, hidden) {
  await page.evaluate((value) => {
    window.__fakeHidden = value;
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }, hidden);
}

// core.js трогает document.documentElement на первой же строке (маркер
// data-listening-glass-core). Playwright добавляет init-script до появления
// documentElement (раньше, чем гарантия document_start у настоящего
// контент-скрипта) — необёрнутая инъекция валится TypeError'ом на этой
// строке и обрывает весь скрипт, ни одна техника (T1/T3/T5/T7/T8) не
// применяется. Найдено и подтверждено этим тестом (см. Result тикета
// QA-002) — дефект самого core.js: строка не защищена от document.documentElement
// === null. Обёртка ниже — только тестовый способ дать коду реальный шанс
// выполниться в этом окружении, содержимое core.js не меняется ни байтом.
function deferUntilDocumentElement(source) {
  return `(function(){function run(){${source}\n}
    if (document.documentElement) { run(); return; }
    new MutationObserver(function(_, obs) {
      if (document.documentElement) { obs.disconnect(); run(); }
    }).observe(document, { childList: true });
  })();`;
}

async function launchContext({ injectCore }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-profile-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROMIUM_EXE,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  await context.addInitScript(instrumentHidingOnly);
  if (injectCore) {
    const coreSource = fs.readFileSync(CORE_JS_PATH, 'utf8');
    await context.addInitScript({ content: deferUntilDocumentElement(coreSource) });
  }
  return { context, profileDir };
}

async function teardownContext({ context, profileDir } = {}) {
  if (context) await context.close().catch(() => {});
  if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

async function openFixture(context, port, fixture) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/${fixture}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function startPlayback(page) {
  await page.evaluate(() => document.getElementById('media').play());
  await page.waitForFunction(() => {
    const el = document.getElementById('media');
    return el && !el.paused && el.currentTime > 0;
  }, { timeout: 10000 });
}

// hasSource читает el.src (IDL-отражение атрибута, меняется сразу) и
// el.srcObject, а не currentSrc — currentSrc после removeAttribute('src') +
// load() ещё держит старый blob URL, пока не отработают отложенные шаги
// алгоритма загрузки медиа-ресурса. Тот же критерий, что в
// research/harness/run.mjs:snapshot() (readyState === 0 || !src).
async function snapshotMedia(page) {
  return page.evaluate(() => {
    const el = document.getElementById('media');
    return {
      paused: el.paused,
      hasSource: !!(el.src || el.srcObject),
      disablePiP: el.tagName === 'VIDEO' ? el.disablePictureInPicture : null,
      hasPipAttr: el.hasAttribute('disablepictureinpicture'),
    };
  });
}

const SCENARIOS = [
  {
    name: 'пауза при скрытии',
    fixture: 'pause-on-hidden.html',
    async run(page) {
      await setHidden(page, true);
      await page.waitForTimeout(300);
      const snap = await snapshotMedia(page);
      return { restricted: snap.paused, detail: snap };
    },
  },
  {
    name: 'блокировка play при скрытой странице',
    fixture: 'block-play-on-hidden.html',
    skipInitialPlayback: true,
    async run(page) {
      // Media начинает paused: play() из paused-состояния гарантированно
      // выстреливает событие 'play', которое и проверяет фикстура — повторный
      // play() уже играющего элемента событие не переиздаёт.
      await setHidden(page, true);
      await page.evaluate(() => document.getElementById('media').play().catch(() => {}));
      await page.waitForTimeout(300);
      const snap = await snapshotMedia(page);
      return { restricted: snap.paused, detail: snap };
    },
  },
  {
    name: 'выгрузка источника при скрытии',
    fixture: 'unload-source-on-hidden.html',
    async run(page) {
      await setHidden(page, true);
      await page.waitForTimeout(300);
      const snap = await snapshotMedia(page);
      return { restricted: !snap.hasSource, detail: snap };
    },
  },
  {
    name: 'перехват нативного play с отказом при скрытой странице',
    fixture: 'intercept-native-play-reject.html',
    async run(page) {
      await setHidden(page, true);
      const errorName = await page.evaluate(() =>
        document.getElementById('media').play().then(() => null, (e) => e.name));
      return { restricted: errorName === 'NotAllowedError', detail: { errorName } };
    },
  },
  {
    name: 'пауза по blur окна',
    fixture: 'pause-on-blur.html',
    async run(page) {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForTimeout(300);
      const snap = await snapshotMedia(page);
      return { restricted: snap.paused, detail: snap };
    },
  },
  {
    name: 'атрибут disablepictureinpicture',
    fixture: 'disable-pip-attribute.html',
    skipInitialPlayback: true,
    async run(page) {
      await page.waitForTimeout(500);
      const snap = await snapshotMedia(page);
      return { restricted: snap.disablePiP === true || snap.hasPipAttr, detail: snap };
    },
  },
];

describe('E2E ядро: ограничение сайта снимается ядром, не сервером', () => {
  let fixtureServer = null;
  let port = null;
  let baseline = null;
  let extended = null;

  before(async () => {
    const started = await startFixtureServer();
    fixtureServer = started.server;
    port = started.port;

    // Тестовое включение хоста фикстур в список — той же функцией, что и
    // popup/background в продукте, напрямую (см. заметку о service worker вверху файла).
    const fixtureHost = `127.0.0.1:${port}`;
    const state = siteList.addHostToState(fixtureHost, siteList.sanitizeState(null));
    assert.equal(siteList.isHostEnabled(fixtureHost, state), true,
      'хост фикстур должен быть включён в site-list тестовым способом');

    baseline = await launchContext({ injectCore: false });
    extended = await launchContext({ injectCore: true });
  });

  after(async () => {
    await teardownContext(baseline);
    await teardownContext(extended);
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.name} — без ядра ограничение воспроизводится, с ядром снято`, async () => {
      const basePage = await openFixture(baseline.context, port, scenario.fixture);
      const extPage = await openFixture(extended.context, port, scenario.fixture);
      try {
        if (!scenario.skipInitialPlayback) {
          await startPlayback(basePage);
          await startPlayback(extPage);
        }
        const baseResult = await scenario.run(basePage);
        const extResult = await scenario.run(extPage);
        assert.equal(baseResult.restricted, true,
          `без ядра ограничение должно воспроизводиться: ${JSON.stringify(baseResult.detail)}`);
        assert.equal(extResult.restricted, false,
          `с ядром ограничение должно быть снято: ${JSON.stringify(extResult.detail)}`);
      } finally {
        await basePage.close().catch(() => {});
        await extPage.close().catch(() => {});
      }
    });
  }
});
