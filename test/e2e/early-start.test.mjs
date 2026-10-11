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
const CORE_JS = path.join(ROOT, 'src/page/core.js');
const YOUTUBE_JS = path.join(ROOT, 'src/page/youtube-adapter.js');
const CHROMIUM = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

function startPageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>early-start</title></head><body>early</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function instrumentHidingOnly() {
  window.__fakeHidden = false;
  const proto = Document.prototype;
  for (const [n, v] of [['visibilityState', 'hidden'], ['hidden', true]]) {
    const d = Object.getOwnPropertyDescriptor(proto, n);
    Object.defineProperty(proto, n, { configurable: true, get() { return window.__fakeHidden ? v : d.get.call(this); } });
  }
  const h = proto.hasFocus;
  proto.hasFocus = function () { return window.__fakeHidden ? false : h.call(this); };
}

async function setHidden(page, hidden) {
  await page.evaluate((v) => { window.__fakeHidden = v; document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); }, hidden);
}

describe('early-start', () => {
  let context, profileDir, server, port;
  before(async () => {
    ({ server, port } = await startPageServer());
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-early-'));
    context = await chromium.launchPersistentContext(profileDir, { executablePath: CHROMIUM, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    await context.addInitScript(instrumentHidingOnly);
    const coreSrc = fs.readFileSync(CORE_JS, 'utf8');
    const ytSrc = fs.readFileSync(YOUTUBE_JS, 'utf8');
    await context.addInitScript({ content: coreSrc });
    await context.addInitScript({ content: ytSrc });
  });
  after(async () => {
    if (context) await context.close().catch(() => {});
    if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  test('no pageerror and markers started', async () => {
    const pageErrors = [];
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForTimeout(300);
    assert.strictEqual(pageErrors.length, 0, 'page errors: ' + pageErrors.join('; '));
    const coreAttr = await page.evaluate(() => document.documentElement && document.documentElement.getAttribute('data-listening-glass-core'));
    const ytAttr = await page.evaluate(() => document.documentElement && document.documentElement.getAttribute('data-listening-glass-youtube'));
    assert.strictEqual(coreAttr, 'started');
    assert.strictEqual(ytAttr, 'started');
  });
  test('hidden false when instrumented hidden', async () => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await setHidden(page, true);
    await page.waitForTimeout(100);
    const hidden = await page.evaluate(() => document.hidden);
    assert.strictEqual(hidden, false);
  });
});
