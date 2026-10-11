'use strict';

// E2E-тест внедрения по списку сайтов (QA-006, переписан в QA-012): страничный
// скрипт приходит из загруженного расширения — решение о внедрении принимает
// service worker расширения, а не сам тест.
//
// Chromium запускается с --load-extension на каталог расширения и
// --disable-extensions-except на него же (тот же приём, что в E2E-тесте ядра),
// тест дожидается service worker. Хост фикстур — из набора по умолчанию,
// который расширение обслуживает без выдачи доступа: правило
// --host-resolver-rules направляет его запросы на локальный сервер фикстур,
// поэтому страница открывается по своему обычному адресу и попадает под
// регистрацию расширения. Хост не из набора по умолчанию автотесту недоступен:
// его добавление идёт через диалог разрешений.
//
// Список сайтов меняется тем же путём, что из панели: читается текущее
// состояние списка, затем siteList.addHostToState/removeHostFromState и запись
// ключа siteList в chrome.storage.local из контекста расширения.
// Перерегистрацию выполняет service worker по chrome.storage.onChanged; тест
// дожидается, пока новая регистрация станет видна через chrome.scripting, и
// только после этого открывает страницу — так же, как реальная вкладка получает
// новую регистрацию на следующей загрузке.
//
// Три состояния на хосте из набора по умолчанию: «не включён» — хост исключён,
// страница без маркера ядра; «добавлен» — исключение снято, на следующей
// загрузке маркер есть; «удалён» — хост исключён снова, маркера нет.
//
// Изоляция: профиль браузера — временный каталог ОС, фикстуры — локальный
// сервер на свободном порту, teardown в after() при любом исходе.

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
const EXTENSION_DIR = path.join(ROOT, 'src');
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Хост из набора по умолчанию (src/site-list.js): расширение обслуживает его без
// выдачи доступа пользователем. Значение — из прочитанного списка, а не по
// памяти: несовпадение падает на первом же утверждении below.
const FIXTURE_HOST = 'rutube.ru';
assert.ok(siteList.DEFAULT_HOSTS.includes(FIXTURE_HOST),
  `хост фикстур ${FIXTURE_HOST} должен входить в набор по умолчанию`);

const CORE_MATCH = `*://${FIXTURE_HOST}/*`;
const CORE_MARKER_ATTR = 'data-listening-glass-core';

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

// Регистрация появляется и меняется асинхронно: service worker синхронизирует
// список при установке, при запуске и на каждое изменение chrome.storage. Ждём
// нужного состояния регистрации, а не считаем, что оно уже наступило.
async function readCoreRegistration(worker) {
  return worker.evaluate(async () => {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const core = scripts.find((script) => script.id === 'listening-glass-core');
    return { matches: core ? core.matches : [] };
  }).catch((error) => ({ error: String(error && error.message) }));
}

async function waitForCoreRegistration(worker, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCoreRegistration(worker);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

// Запись списка из контекста расширения — как это делает панель: то же чтение
// текущего состояния, те же функции site-list и тот же ключ хранилища.
async function writeSiteList(worker, state) {
  await worker.evaluate(([key, value]) => chrome.storage.local.set({ [key]: value }),
    [siteList.STORAGE_KEY, state]);
}

async function openFixture(context) {
  const page = await context.newPage();
  await page.goto(`http://${FIXTURE_HOST}/plain.html`, { waitUntil: 'domcontentloaded' });
  return page;
}

function readMarker(page) {
  return page.evaluate((attr) => document.documentElement && document.documentElement.getAttribute(attr),
    CORE_MARKER_ATTR);
}

async function teardownContext({ context, profileDir } = {}) {
  if (context) await context.close().catch(() => {});
  if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

describe('E2E внедрение: страничный скрипт следует за состоянием хоста в списке сайтов', () => {
  let fixtureServer = null;
  let port = null;
  let browser = null;
  let worker = null;
  let listState = null;

  before(async () => {
    const started = await startFixtureServer();
    fixtureServer = started.server;
    port = started.port;

    // Адрес страницы — обычный адрес хоста из набора по умолчанию, а соединение
    // уходит на сервер фикстур.
    const resolverRule = `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1:${port}`;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-injection-profile-'));
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_EXE,
      headless: true,
      args: [
        resolverRule,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    browser = { context, profileDir };

    let extWorker = context.serviceWorkers()[0];
    if (!extWorker) extWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    worker = extWorker;

    // Исходное состояние списка — пустое, как у свежей установки: хост из набора
    // по умолчанию включён. Ждём, пока service worker это зарегистрирует, иначе
    // первое ожидание «хост исключён» прошло бы на ещё не выполненной установке.
    const initial = await waitForCoreRegistration(worker, (result) => result.matches.includes(CORE_MATCH));
    assert.ok(initial.matches.includes(CORE_MATCH),
      `service worker должен зарегистрировать страничный скрипт на хосте фикстур: ${JSON.stringify(initial)}`);

    listState = siteList.sanitizeState(null);
  });

  after(async () => {
    await teardownContext(browser);
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  test('до включения хоста страничный скрипт не выполняется', async () => {
    listState = siteList.removeHostFromState(FIXTURE_HOST, listState);
    assert.equal(siteList.isHostEnabled(FIXTURE_HOST, listState), false,
      'хост фикстуры не должен быть включён после исключения');
    await writeSiteList(worker, listState);

    const registered = await waitForCoreRegistration(worker, (result) => !result.matches.includes(CORE_MATCH));
    assert.ok(!registered.matches.includes(CORE_MATCH),
      `исключённый хост не должен оставаться в регистрации: ${JSON.stringify(registered)}`);

    const page = await openFixture(browser.context);
    try {
      assert.equal(await readMarker(page), null,
        'скрипт не должен выполниться на выключенном хосте');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('после добавления хоста скрипт выполняется на следующей загрузке', async () => {
    listState = siteList.addHostToState(FIXTURE_HOST, listState);
    assert.equal(siteList.isHostEnabled(FIXTURE_HOST, listState), true,
      'хост фикстуры должен быть включён после возврата в список');
    await writeSiteList(worker, listState);

    const registered = await waitForCoreRegistration(worker, (result) => result.matches.includes(CORE_MATCH));
    assert.ok(registered.matches.includes(CORE_MATCH),
      `включённый хост должен появиться в регистрации: ${JSON.stringify(registered)}`);

    const page = await openFixture(browser.context);
    try {
      await page.waitForFunction(
        (attr) => document.documentElement && document.documentElement.getAttribute(attr) === 'started',
        CORE_MARKER_ATTR, { timeout: 10000 });
      assert.equal(await readMarker(page), 'started',
        'маркер ядра должен появиться на documentElement следующей загрузки');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('после удаления хоста скрипт снова не выполняется', async () => {
    listState = siteList.removeHostFromState(FIXTURE_HOST, listState);
    assert.equal(siteList.isHostEnabled(FIXTURE_HOST, listState), false,
      'хост фикстуры не должен быть включён после удаления');
    await writeSiteList(worker, listState);

    const registered = await waitForCoreRegistration(worker, (result) => !result.matches.includes(CORE_MATCH));
    assert.ok(!registered.matches.includes(CORE_MATCH),
      `удалённый хост не должен оставаться в регистрации: ${JSON.stringify(registered)}`);

    const page = await openFixture(browser.context);
    try {
      assert.equal(await readMarker(page), null,
        'скрипт не должен выполниться после удаления хоста со следующей загрузки');
    } finally {
      await page.close().catch(() => {});
    }
  });
});
