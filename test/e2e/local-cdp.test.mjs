import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const CHROMIUM_EXE = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright/chromium-1217/chrome-win64/chrome.exe');

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Регрессия FIX-012 (дефект QA-016): обнаружение локального CDP уходило через
// авторизующий прокси из окружения и падало с 407. Тест поднимает синтетический
// прокси, отвечающий 407, и утверждает, что connectLocalCDP проходит обнаружение
// в обход прокси для всех loopback-хостов, тогда как прямой connectOverCDP и
// запросы к внешним адресам по-прежнему идут через прокси.
test('local CDP bypasses a 407 proxy only for discovery and leaves proxy settings intact', async () => {
  const proxyRequests = [];
  const discoveryRequests = [];
  const proxy = http.createServer((req, res) => {
    proxyRequests.push(req.url);
    res.writeHead(407).end();
  });
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lg-e2e-cdp-profile-'));
  let context;
  let discovery;
  try {
    const proxyPort = await listen(proxy, '127.0.0.1');
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_EXE,
      headless: true,
      args: ['--remote-debugging-port=0'],
    });
    const [debugPort, debugPath] = (await fsp.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    discovery = http.createServer((req, res) => {
      discoveryRequests.push(req.url);
      assert.equal(req.url, '/json/version/');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${debugPort}${debugPath}` }));
    });
    const discoveryPort = await listen(discovery, '::');
    // Only the child receives synthetic proxy settings; no real proxy credentials
    // are copied to its environment or printed in failure output.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(http_proxy|https_proxy|all_proxy|no_proxy|npm_config_.*proxy)$/i.test(key)) delete env[key];
    }
    env.HTTP_PROXY = env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.NO_PROXY = 'unrelated.invalid';
    const helper = new URL('./local-cdp.mjs', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { chromium } from 'playwright-core';
      import { connectLocalCDP } from ${JSON.stringify(helper)};
      const endpoint = process.argv[1];
      const before = { ...process.env };
      await assert.rejects(chromium.connectOverCDP(endpoint), /Unexpected status 407/);
      const remote = await connectLocalCDP(endpoint);
      try {
        const session = await remote.newBrowserCDPSession();
        const version = await session.send('Browser.getVersion');
        assert.ok(version.product.includes('Chrome'));
        await session.detach();
      } finally {
        await remote.close();
      }
      assert.deepEqual({ ...process.env }, before);
      // The unfixed HTTP transport still uses the proxy after the local bypass.
      await assert.rejects(chromium.connectOverCDP('http://outbound.invalid:9222'), /Unexpected status 407/);
    `;
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const endpoint = `http://${host}:${discoveryPort}`;
      await run(process.execPath, ['--input-type=module', '-e', script, endpoint], { env, timeout: 30000 });
    }
    assert.deepEqual(discoveryRequests, Array(3).fill('/json/version/'));
    assert.deepEqual(proxyRequests, ['127.0.0.1', 'localhost', '[::1]'].flatMap((host) => [
      `/http://${host}:${discoveryPort}/json/version/`,
      '/http://outbound.invalid:9222/json/version/',
    ]));
  } finally {
    if (discovery) await close(discovery);
    await close(proxy);
    if (context) await context.close();
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
});
