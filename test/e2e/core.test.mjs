'use strict';

// E2E-тест ядра (QA-011): ядро приходит только из загруженного расширения.
// Chromium запускается с --load-extension на каталог расширения и
// --disable-extensions-except на него же, тест дожидается service worker
// (context.serviceWorkers() / waitForEvent('serviceworker')), ждёт регистрации
// страничного скрипта ядра на хосте фикстур и только после этого открывает
// страницы. Сбоев регистрации и внедрения тест не прячет: если регистрации нет
// или ядро не снимает ограничение, падает утверждение, а не прогон.
//
// Хост фикстур — из набора по умолчанию, который расширение обслуживает без
// правки списка сайтов: правило --host-resolver-rules направляет его запросы на
// локальный сервер фикстур, поэтому страница открывается по своему обычному
// адресу и попадает под регистрацию расширения.
//
// Два прогона: «без расширения» — тот же Chromium без флагов расширения,
// ограничение фикстуры воспроизводится; «с расширением» — ядро его снимает.
//
// Скрытие имитируется как в research/harness/run.mjs (instrumentHidingOnly):
// нативные геттеры Document.prototype подменяются управляемым флагом, чтобы
// страница видела скрытие так же, как его видит свёрнутый браузер.
//
// Изоляция: профили браузера — временные каталоги ОС, фикстуры раздаёт
// локальный сервер на свободном порту. Удаление каталогов и остановка сервера —
// в teardown при любом исходе.

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

// Хост из набора по умолчанию (src/site-list.js): расширение обслуживает его
// без выдачи доступа пользователем. Значение — из прочитанного списка, а не по
// памяти: несовпадение падает на первом же утверждении below.
const FIXTURE_HOST = 'rutube.ru';
assert.ok(siteList.DEFAULT_HOSTS.includes(FIXTURE_HOST),
  `хост фикстур ${FIXTURE_HOST} должен входить в набор по умолчанию`);

const CORE_SCRIPT_ID = 'listening-glass-core';

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

// Тот же приём, что в research/harness/run.mjs (instrumentHidingOnly).
function instrumentHidingOnly() {
  window.__fakeHidden = false;
  window.__nativeMediaPause = HTMLMediaElement.prototype.pause;
  if (navigator.mediaSession) {
    const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    window.__mediaSessionActions = {};
    navigator.mediaSession.setActionHandler = function (action, handler) {
      window.__mediaSessionActions[action] = handler;
      return setActionHandler(action, handler);
    };
  }
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

async function openFixture(context, fixture) {
  const page = await context.newPage();
  await page.goto(`http://${FIXTURE_HOST}/${fixture}`, { waitUntil: 'domcontentloaded' });
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

// Регистрация появляется асинхронно: service worker синхронизирует список при
// установке и при своём запуске. Ждём её появления, а не считаем, что она уже
// есть к моменту, когда воркер стал виден тесту.
async function waitForCoreRegistration(worker, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await worker.evaluate(async () => {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const core = scripts.find((script) => script.id === 'listening-glass-core');
      return core ? { id: core.id, matches: core.matches, runAt: core.runAt, world: core.world } : null;
    }).catch((error) => ({ error: String(error && error.message) }));
    if (last && last.id) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

async function teardownContext({ context, profileDir } = {}) {
  if (context) await context.close().catch(() => {});
  if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

describe('E2E ядро: ограничение сайта снимается ядром загруженного расширения', () => {
  let fixtureServer = null;
  let port = null;
  let withoutExtension = null;
  let withExtension = null;
  let coreRegistration = null;

  before(async () => {
    const started = await startFixtureServer();
    fixtureServer = started.server;
    port = started.port;

    // Правило резолвера общее для обоих прогонов: адрес страницы — обычный
    // адрес хоста из набора по умолчанию, а соединение уходит на сервер фикстур.
    const resolverRule = `--host-resolver-rules=MAP ${FIXTURE_HOST} 127.0.0.1:${port}`;

    // Прогон «без расширения»: тот же Chromium, без флагов расширения.
    const plainProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-plain-profile-'));
    const plainContext = await chromium.launchPersistentContext(plainProfileDir, {
      executablePath: CHROMIUM_EXE,
      headless: true,
      args: [resolverRule, '--autoplay-policy=no-user-gesture-required'],
    });
    await plainContext.addInitScript(instrumentHidingOnly);
    withoutExtension = { context: plainContext, profileDir: plainProfileDir };

    // Прогон «с расширением»: тот же Chromium с загруженным каталогом
    // расширения. Ждём service worker расширения — без него страничный скрипт
    // не регистрируется, и тест обязан это увидеть, а не молча пройти.
    const extProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-e2e-extension-profile-'));
    const extContext = await chromium.launchPersistentContext(extProfileDir, {
      executablePath: CHROMIUM_EXE,
      headless: true,
      args: [
        resolverRule,
        '--autoplay-policy=no-user-gesture-required',
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    await extContext.addInitScript(instrumentHidingOnly);
    withExtension = { context: extContext, profileDir: extProfileDir };

    let worker = extContext.serviceWorkers()[0];
    if (!worker) worker = await extContext.waitForEvent('serviceworker', { timeout: 15000 });
    withExtension.workerUrl = worker.url();
    coreRegistration = await waitForCoreRegistration(worker);
  });

  after(async () => {
    await teardownContext(withoutExtension);
    await teardownContext(withExtension);
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
  });

  test('service worker загруженного расширения зарегистрировал страничный скрипт ядра на хосте фикстур', () => {
    assert.ok(withExtension.workerUrl.startsWith('chrome-extension://'),
      `service worker должен принадлежать расширению: ${withExtension.workerUrl}`);
    assert.ok(coreRegistration && coreRegistration.id === CORE_SCRIPT_ID,
      `регистрация ядра должна быть видна из service worker: ${JSON.stringify(coreRegistration)}`);
    assert.ok(coreRegistration.matches.includes(`*://${FIXTURE_HOST}/*`),
      `ядро должно быть зарегистрировано на хосте фикстур: ${JSON.stringify(coreRegistration.matches)}`);
  });

  for (const scenario of SCENARIOS) {
    test(`${scenario.name} — без расширения ограничение воспроизводится, с расширением снято`, async () => {
      const plainPage = await openFixture(withoutExtension.context, scenario.fixture);
      const extPage = await openFixture(withExtension.context, scenario.fixture);
      try {
        if (!scenario.skipInitialPlayback) {
          await startPlayback(plainPage);
          await startPlayback(extPage);
        }
        const plainResult = await scenario.run(plainPage);
        const extResult = await scenario.run(extPage);
        assert.equal(plainResult.restricted, true,
          `без расширения ограничение должно воспроизводиться: ${JSON.stringify(plainResult.detail)}`);
        assert.equal(extResult.restricted, false,
          `с расширением ограничение должно быть снято: ${JSON.stringify(extResult.detail)}`);
      } finally {
        await plainPage.close().catch(() => {});
        await extPage.close().catch(() => {});
      }
    });
  }

  test('системная команда MediaSession play возобновляет скрытое воспроизведение после browser pause', async () => {
    const results = [];
    for (const delay of [2500]) {
      const plainPage = await openFixture(withoutExtension.context, 'pause-on-hidden.html');
      const extPage = await openFixture(withExtension.context, 'pause-on-hidden.html');
      try {
        await startPlayback(plainPage);
        await startPlayback(extPage);
        for (const page of [plainPage, extPage]) {
          const supported = await page.evaluate(() => {
            if (!navigator.mediaSession || !window.__mediaSessionActions) return false;
            const media = document.getElementById('media');
            navigator.mediaSession.setActionHandler('pause', () => media.pause());
            navigator.mediaSession.setActionHandler('play', () => {});
            return true;
          });
          assert.equal(supported, true, 'MediaSession actions should be available in Chromium');
          await setHidden(page, true);
        }
        await Promise.all([plainPage.waitForTimeout(delay), extPage.waitForTimeout(delay)]);
        for (const page of [plainPage, extPage]) {
          await page.evaluate(() => window.__mediaSessionActions.pause());
          await page.waitForFunction(() => document.getElementById('media').paused);
        }
        for (const page of [plainPage, extPage]) {
          await page.evaluate(() => window.__mediaSessionActions.play());
        }
        results.push({
          delay,
          withoutExtensionPaused: await plainPage.evaluate(() => document.getElementById('media').paused),
          withExtensionPlaying: await extPage.waitForFunction(() => !document.getElementById('media').paused, { timeout: 2000 })
            .then(() => true, () => false),
        });
      } finally {
        await plainPage.close().catch(() => {});
        await extPage.close().catch(() => {});
      }
    }
    assert.deepEqual(results, [
      { delay: 2500, withoutExtensionPaused: true, withExtensionPlaying: true },
    ]);
  });

  for (const pauseDelay of [300, 2500]) {
    test(`QA-014 native pause/play при скрытой странице, задержка ${pauseDelay} мс`, async () => {
      const plainPage = await openFixture(withoutExtension.context, 'block-play-on-hidden.html');
      const extPage = await openFixture(withExtension.context, 'block-play-on-hidden.html');
      try {
        for (const page of [plainPage, extPage]) {
          await startPlayback(page);
          // Порядок и интервалы research/harness/run.mjs:117-140:
          // скрытие → задержка → native pause → 2500 мс → native play → 3500 мс.
          // Методы из чистого realm обходят оверрайды страницы и ядра,
          // без вызова обработчиков MediaSession.
          await page.evaluate(() => {
            const frame = document.createElement('iframe');
            document.body.appendChild(frame);
            window.__browserMediaMethods = {
              pause: frame.contentWindow.HTMLMediaElement.prototype.pause,
              play: frame.contentWindow.HTMLMediaElement.prototype.play,
            };
            frame.remove();
          });
          await setHidden(page, true);
        }
        await Promise.all([plainPage, extPage].map(async (page) => {
          await page.waitForTimeout(pauseDelay);
          const paused = await page.evaluate(() => {
            const media = document.getElementById('media');
            window.__browserMediaMethods.pause.call(media);
            return media.paused;
          });
          assert.equal(paused, true, 'нативная пауза должна реально остановить медиа');
          await page.waitForTimeout(2500);
          await page.evaluate(() => window.__browserMediaMethods.play
            .call(document.getElementById('media')).catch(() => {}));
        }));
        const before = await Promise.all([plainPage, extPage].map((page) =>
          page.evaluate(() => document.getElementById('media').currentTime)));
        await Promise.all([plainPage.waitForTimeout(3500), extPage.waitForTimeout(3500)]);
        const [plain, extended] = await Promise.all([plainPage, extPage].map((page) =>
          page.evaluate(() => {
            const media = document.getElementById('media');
            return { paused: media.paused, time: media.currentTime };
          })));
        assert.equal(plain.paused, true, 'без расширения скрытый native play блокируется фикстурой');
        assert.ok(plain.time <= before[0] + 1, 'без расширения время не должно продолжать идти');
        assert.equal(extended.paused, false, 'с расширением native play возобновляет скрытое медиа');
        assert.ok(extended.time > before[1] + 1, 'после native play время должно продвинуться более чем на секунду');
      } finally {
        await plainPage.close().catch(() => {});
        await extPage.close().catch(() => {});
      }
    });
  }

  test('TikTok: browser pause after delayed page hiding is resumed by the universal core', async () => {
    const plainPage = await openFixture(withoutExtension.context, 'pause-on-hidden.html');
    const extPage = await openFixture(withExtension.context, 'pause-on-hidden.html');
    try {
      await startPlayback(plainPage);
      await startPlayback(extPage);
      await Promise.all([setHidden(plainPage, true), setHidden(extPage, true)]);
      await Promise.all([plainPage.waitForTimeout(2500), extPage.waitForTimeout(2500)]);
      await Promise.all([plainPage, extPage].map((page) => page.evaluate(() => {
        window.__nativeMediaPause.call(document.getElementById('media'));
      })));
      await plainPage.waitForFunction(() => document.getElementById('media').paused);
      const resumed = await extPage.waitForFunction(() => !document.getElementById('media').paused, { timeout: 1500 })
        .then(() => true, () => false);
      assert.equal(resumed, true, 'playback should resume after a delayed pause while hidden');
    } finally {
      await plainPage.close().catch(() => {});
      await extPage.close().catch(() => {});
    }
  });
});
