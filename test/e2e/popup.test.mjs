'use strict';

// E2E-тест панели (QA-008): Chromium Playwright открывает реальную страницу
// панели src/popup/popup.html для вкладки с хостом фикстуры, переключает сайт
// и проверяет записанное в storage значение и текст состояния после
// повторного открытия панели.
//
// Загрузка через --load-extension не используется по той же причине, что
// задокументирована в QA-002 (test/e2e/core.test.mjs) и QA-006
// (test/e2e/injection.test.mjs): в этом окружении она ненадёжна. Для панели
// есть дополнительная причина не открывать её как обычную вкладку через
// --load-extension: настоящий action-popup — не вкладка, chrome.tabs.query
// внутри него разрешается в активную вкладку окна, которому принадлежит
// popup, а не в саму popup-страницу. Открытие popup.html как обычной
// вкладки эту семантику не воспроизводит: сама вкладка стала бы «активной»,
// и chrome.tabs.query вернул бы её собственный chrome-extension:// URL
// вместо хоста фикстуры.
//
// Вместо этого тест грузит src/popup/popup.html/.css/.js без изменений через
// локальный HTTP-сервер и подменяет глобальный chrome — chrome.tabs.query
// возвращает фиксированный хост фикстуры, chrome.storage.local читает и
// пишет через тот же сервер (эндпоинт /__storage__, состояние хранится в
// процессе Node, а не в браузере) — так «повторное открытие» панели
// (перезагрузка страницы) видит то же самое persisted-состояние, что видел
// бы настоящий chrome.storage.local между открытиями popup. Продуктовый код
// popup.js выполняется реальный, без переопределений его собственной логики.
//
// Изоляция как в QA-002: профиль браузера — временный каталог ОС, раздача
// панели и storage — локальный сервер на свободном порту. Удаление каталога
// и остановка сервера — в teardown (after()) при любом исходе.

import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const POPUP_DIR = path.join(ROOT, 'src/popup');
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Бэкенд chrome.storage.local: состояние живёт в процессе Node, переживает
// перезагрузку страницы — так же, как настоящий storage переживает закрытие
// и повторное открытие popup-окна.
function startPopupServer() {
  let storageState = { added: [], excluded: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    if (url.pathname === '/__storage__') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          storageState = JSON.parse(body);
          res.writeHead(200).end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(storageState));
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'popup.html';
    const filePath = path.join(POPUP_DIR, rel);
    if (!filePath.startsWith(POPUP_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, getState: () => storageState }));
  });
}

// Подменяет chrome.tabs.query (возвращает фиксированный хост фикстуры как
// URL активной вкладки) и chrome.storage.local (get/set — через fetch к
// /__storage__ того же сервера, callback-based API как в реальном chrome.*).
function installChromeStub(fixtureUrl) {
  window.chrome = {
    tabs: {
      query(_options, callback) {
        callback([{ url: fixtureUrl }]);
      },
    },
    storage: {
      local: {
        get(key, callback) {
          fetch('/__storage__')
            .then((r) => r.json())
            .then((state) => callback({ [key]: state }));
        },
        set(items, callback) {
          const key = Object.keys(items)[0];
          fetch('/__storage__', { method: 'POST', body: JSON.stringify(items[key]) })
            .then(() => { if (callback) callback(); });
        },
      },
    },
  };
}

async function launchPopupContext() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-popup-profile-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROMIUM_EXE,
    headless: true,
  });
  return { context, profileDir };
}

async function teardownContext({ context, profileDir } = {}) {
  if (context) await context.close().catch(() => {});
  if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

function readPanel(page) {
  return page.evaluate(() => ({
    host: document.getElementById('current-host').textContent,
    checked: document.getElementById('host-toggle').checked,
    label: document.getElementById('state-label').textContent,
    toggleHidden: document.getElementById('toggle-area').classList.contains('hidden'),
  }));
}

describe('E2E панель: переключение сайта сохраняется между открытиями', () => {
  let popupServer = null;
  let port = null;
  let getState = null;
  let popup = null;
  let fixtureHost = null;

  before(async () => {
    const started = await startPopupServer();
    popupServer = started.server;
    port = started.port;
    getState = started.getState;
    fixtureHost = `127.0.0.1:${port}`;

    popup = await launchPopupContext();
    await popup.context.addInitScript(installChromeStub, `http://${fixtureHost}/watch`);
  });

  after(async () => {
    await teardownContext(popup);
    if (popupServer) await new Promise((resolve) => popupServer.close(resolve));
  });

  test('панель для не включённого хоста фикстуры показывает Disabled', async () => {
    const page = await popup.context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/popup.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('state-label').textContent !== '—');
      const panel = await readPanel(page);
      assert.equal(panel.host, fixtureHost, 'панель должна показать хост фикстуры из chrome.tabs.query');
      assert.equal(panel.toggleHidden, false, 'переключатель должен быть виден для обычного (не служебного) хоста');
      assert.equal(panel.checked, false, 'хост фикстуры не входит в набор по умолчанию — должен быть выключен');
      assert.equal(panel.label, 'Disabled');
      assert.deepEqual(getState(), { added: [], excluded: [] }, 'до переключения storage не тронут');
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('переключение хоста в панели пишет значение в storage и сохраняется после повторного открытия', async () => {
    const page = await popup.context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/popup.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('state-label').textContent !== '—');

      // Клик по .slider, а не по самому #host-toggle: input скрыт (width/height
      // 0, opacity 0) под видимым слайдером внутри <label>, клик по слайдеру —
      // естественный способ переключить чекбокс через нативную связку label→input.
      await page.click('#toggle-area .slider');
      await page.waitForFunction(() => document.getElementById('state-label').textContent === 'Enabled');

      const afterToggle = await readPanel(page);
      assert.equal(afterToggle.checked, true);
      assert.equal(afterToggle.label, 'Enabled');
      assert.deepEqual(getState(), { added: [fixtureHost], excluded: [] },
        'переключение должно записать хост фикстуры в storage (siteList.added)');

      // «Повторное открытие» панели — новая загрузка popup.html, ровно как
      // при закрытии и повторном клике по иконке расширения: JS-состояние
      // страницы обнуляется, а chrome.storage.local (здесь — сервер) остаётся.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('state-label').textContent !== '—');
      const afterReopen = await readPanel(page);
      assert.equal(afterReopen.host, fixtureHost);
      assert.equal(afterReopen.checked, true, 'после повторного открытия переключатель должен остаться включён');
      assert.equal(afterReopen.label, 'Enabled', 'после повторного открытия текст состояния должен остаться Enabled');
    } finally {
      await page.close().catch(() => {});
    }
  });
});
