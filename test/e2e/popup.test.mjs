'use strict';

// E2E-тест панели (QA-013, переписан из QA-008): панель проверяется как часть
// настоящего расширения. Chromium запускается с --load-extension на каталог
// расширения и --disable-extensions-except на него же, тест дожидается service
// worker (context.serviceWorkers() / waitForEvent('serviceworker')) и читает
// chrome.storage.local из контекста расширения. Глобальный chrome.* тест не
// подменяет: прежняя версия подменяла chrome.tabs.query и chrome.storage.local,
// из-за чего «включала» хост, которого настоящее расширение не видит, и
// скрывала главный дефект панели.
//
// CDP вызывает настоящее действие расширения для вкладки сайта: Chromium
// выдаёт activeTab и открывает action-popup, а не вкладку с popup.html.
//
// Хост сценария — из набора по умолчанию (src/site-list.js): правило
// --host-resolver-rules направляет его запросы на локальный сервер фикстур,
// поэтому вкладка открывается по своему обычному адресу и видна расширению.
//
// Изоляция: профиль браузера — временный каталог ОС, фикстуры раздаёт локальный
// сервер на свободном порту. Удаление каталога и остановка сервера — в teardown
// (after()) при любом исходе.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { connectLocalCDP } from './local-cdp.mjs';
import siteList from '../../src/site-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES_DIR = path.join(ROOT, 'test/e2e/fixtures');
const EXTENSION_DIR = path.join(ROOT, 'src');
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const PANEL_PATH = 'popup/popup.html';

// Хост из набора по умолчанию (src/site-list.js): расширение обслуживает его без
// выдачи доступа пользователем. Значение — из прочитанного списка, а не по
// памяти: несовпадение падает на первом же утверждении below.
const FIXTURE_HOST = 'rutube.ru';
assert.ok(siteList.DEFAULT_HOSTS.includes(FIXTURE_HOST),
  `хост фикстур ${FIXTURE_HOST} должен входить в набор по умолчанию`);

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

async function teardownContext({ context, profileDir, connections = [] } = {}) {
  for (const connection of connections) await connection.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

async function openSiteTab(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

// Настоящее действие расширения выдаёт activeTab только выбранной вкладке.
async function openPanelTab({ context, endpoint, connections }, worker, panelUrl, siteTab) {
  await siteTab.bringToFront();
  const cdp = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }],
    });
    const target = targetInfos.find((tab) => tab.url === siteTab.url());
    assert.ok(target, 'CDP должен найти вкладку сайта');
    await cdp.send('Extensions.triggerAction', {
      id: new URL(worker.url()).host, targetId: target.targetId,
    });
    const deadline = Date.now() + 15000;
    while (true) {
      const targets = await cdp.send('Target.getTargets');
      if (targets.targetInfos.some((item) => item.url === panelUrl)) break;
      assert.ok(Date.now() < deadline, 'action-popup должен появиться за 15 секунд');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await cdp.detach();
  }
  // Второе CDP-подключение идёт через connectLocalCDP: он сам обнаруживает
  // локальный CDP в обход авторизующего прокси из окружения (дефект QA-016,
  // FIX-012), а не через прокси-зависимый HTTP-транспорт Playwright. Подключение
  // видит action-popup, который не появляется в context.pages() исходного
  // pipe-подключения Playwright.
  const remote = await connectLocalCDP(endpoint);
  connections.push(remote);
  const popup = remote.contexts()[0].pages().find((page) => page.url() === panelUrl);
  assert.ok(popup, 'действие расширения должно открыть настоящий action-popup');
  return popup;
}

// Ждём асинхронного чтения состояния из настоящего storage расширения.
async function waitForPanelReady(page) {
  await page.waitForFunction(
    () => document.getElementById('state-label').textContent !== '—',
    undefined,
    { polling: 100, timeout: 15000 },
  );
}

function readPanel(page) {
  return page.evaluate(() => ({
    host: document.getElementById('current-host').textContent,
    checked: document.getElementById('host-toggle').checked,
    label: document.getElementById('state-label').textContent,
    toggleHidden: document.getElementById('toggle-area').classList.contains('hidden'),
    message: document.getElementById('service-page-msg').textContent,
    messageHidden: document.getElementById('service-page-msg').classList.contains('hidden'),
  }));
}

describe('E2E панель: переключение сайта сохраняется между открытиями', () => {
  let fixtureServer = null;
  let port = null;
  let browser = null;
  let worker = null;
  let panelUrl = null;

  // Значение ключа siteList читается из контекста расширения — тот же storage,
  // которым пользуется панель, без подмены chrome.storage.local.
  function readSiteList() {
    return worker.evaluate((key) => new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result ? result[key] : undefined));
    }), siteList.STORAGE_KEY);
  }

  before(async () => {
    const started = await startFixtureServer();
    fixtureServer = started.server;
    port = started.port;

    // Адрес страницы — обычный адрес хоста из набора по умолчанию, а соединение
    // уходит на сервер фикстур.
    const resolverRule = `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1:${port}`;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-popup-profile-'));
    const portServer = http.createServer();
    await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
    const debugPort = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_EXE,
      headless: false,
      args: [
        `--remote-debugging-port=${debugPort}`,
        '--enable-unsafe-extension-debugging',
        resolverRule,
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    browser = { context, profileDir, endpoint: `http://127.0.0.1:${debugPort}`, connections: [] };
    const cdp = await context.browser().newBrowserCDPSession();
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      browser.processId = processInfo.find((process) => process.type === 'browser').id;
    } finally {
      await cdp.detach();
    }

    let extWorker = context.serviceWorkers()[0];
    if (!extWorker) extWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    worker = extWorker;
    panelUrl = `chrome-extension://${new URL(worker.url()).host}/${PANEL_PATH}`;
    assert.ok(panelUrl.startsWith('chrome-extension://'),
      `service worker должен принадлежать расширению: ${worker.url()}`);
  });

  after(async () => {
    await teardownContext(browser);
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  test('панель для вкладки на хосте из набора по умолчанию выключает сайт, пишет его в excluded и показывает то же после повторного открытия', async () => {
    const siteTab = await openSiteTab(browser.context, `http://${FIXTURE_HOST}/plain.html`);
    let panel = null;
    try {
      panel = await openPanelTab(browser, worker, panelUrl, siteTab);
      await waitForPanelReady(panel);

      const initial = await readPanel(panel);
      assert.equal(initial.host, FIXTURE_HOST,
        `панель должна показать хост активной вкладки, а не свой собственный URL: ${JSON.stringify(initial)}`);
      assert.equal(initial.toggleHidden, false, 'переключатель должен быть виден для обычного хоста');
      assert.equal(initial.checked, true, 'хост из набора по умолчанию включён до переключения');
      assert.equal(initial.label, 'Enabled by default', `подпись сайта из набора по умолчанию: ${JSON.stringify(initial.label)}`);
      assert.equal(siteList.sanitizeState(await readSiteList()).excluded.includes(FIXTURE_HOST), false,
        'до переключения хост фикстуры не должен быть исключён');

      // Клик по .slider, а не по самому #host-toggle: input скрыт (width/height
      // 0, opacity 0) под видимым слайдером внутри <label>, клик по слайдеру —
      // естественный способ переключить чекбокс через нативную связку label→input.
      await panel.bringToFront();
      await panel.click('#toggle-area .slider');
      await panel.waitForFunction(() => document.getElementById('state-label').textContent === 'Disabled',
        undefined, { polling: 100, timeout: 15000 });

      const afterToggle = await readPanel(panel);
      assert.equal(afterToggle.checked, false);
      assert.equal(afterToggle.label, 'Disabled');

      const stored = siteList.sanitizeState(await readSiteList());
      assert.ok(stored.excluded.includes(FIXTURE_HOST),
        `выключение сайта должно записать хост в excluded: ${JSON.stringify(stored)}`);
      assert.equal(siteList.isHostEnabled(FIXTURE_HOST, stored), false,
        'хост фикстуры должен быть выключен по записанному списку');
    } finally {
      if (panel) await panel.close().catch(() => {});
    }

    // Повторный вызов действия открывает новую панель: её JS-состояние обнуляется,
    // chrome.storage.local расширения остаётся.
    let reopened = null;
    try {
      reopened = await openPanelTab(browser, worker, panelUrl, siteTab);
      await waitForPanelReady(reopened);
      const afterReopen = await readPanel(reopened);
      assert.equal(afterReopen.host, FIXTURE_HOST);
      assert.equal(afterReopen.checked, false, 'после повторного открытия переключатель должен остаться выключенным');
      assert.equal(afterReopen.label, 'Disabled', 'подпись должна соответствовать выключенному сайту');
    } finally {
      if (reopened) await reopened.close().catch(() => {});
      await siteTab.close().catch(() => {});
    }
  });

  test('хост не из набора по умолчанию: панель показывает сайт вкладки и даёт включить его', async () => {
    const siteTab = await openSiteTab(browser.context, `http://127.0.0.1:${port}/plain.html`);
    let panel = null;
    try {
      panel = await openPanelTab(browser, worker, panelUrl, siteTab);
      await waitForPanelReady(panel);

      const observed = await readPanel(panel);
      assert.equal(observed.host, `127.0.0.1:${port}`,
        `панель должна показать хост активной вкладки не из набора по умолчанию: ${JSON.stringify(observed)}`);
      assert.equal(observed.toggleHidden, false,
        `переключатель должен быть доступен для обычного сайта: ${JSON.stringify(observed)}`);
      assert.equal(observed.label, 'Disabled');
      const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
      assert.ok(manifest.permissions.includes('activeTab'));
      assert.equal(manifest.permissions.includes('tabs'), false);
      // Подтверждаем настоящий системный запрос только в процессе тестового
      // браузера, не подменяя permissions API и не выдавая доступ заранее.
      await panel.click('#toggle-area .slider');
      await new Promise((resolve) => setTimeout(resolve, 500));
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `
        Add-Type -AssemblyName UIAutomationClient;
        $root = [System.Windows.Automation.AutomationElement]::RootElement;
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition);
        foreach ($window in $windows) {
          if ($window.Current.ProcessId -eq ${browser.processId}) {
            $dialogs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
              [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window));
            foreach ($dialog in $dialogs) {
              if ($dialog.Current.Name -like '*Listening Glass*') {
                $buttons = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                  [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button));
                foreach ($button in $buttons) {
                  if ($button.Current.Name -eq 'Разрешить' -or $button.Current.Name -eq 'Allow') {
                    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();
                    exit 0;
                  }
                }
              }
            }
          }
        }
        throw 'Listening Glass permission dialog not found';
      `], { encoding: 'utf8', timeout: 10000 });
      await panel.waitForFunction(() => document.getElementById('state-label').textContent === 'Enabled by you',
        undefined, { polling: 100, timeout: 15000 });
      assert.ok(siteList.sanitizeState(await readSiteList()).added.includes(`127.0.0.1:${port}`));
      assert.equal(await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), true);
      await panel.close();
      panel = await openPanelTab(browser, worker, panelUrl, siteTab);
      await waitForPanelReady(panel);
      const reopened = await readPanel(panel);
      assert.equal(reopened.checked, true);
      assert.equal(reopened.label, 'Enabled by you');
    } finally {
      if (panel) await panel.close().catch(() => {});
      await siteTab.close().catch(() => {});
    }
  });
});
