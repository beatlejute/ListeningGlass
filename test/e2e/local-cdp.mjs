import http from 'node:http';
import { chromium } from 'playwright-core';

function requireLoopback(url, protocol) {
  if (url.protocol !== protocol || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) {
    throw new Error('Local CDP requires a loopback URL without credentials');
  }
}

export async function connectLocalCDP(endpoint) {
  const url = new URL(endpoint);
  requireLoopback(url, 'http:');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += 'json/version/';
  // Discovery is issued with Node's own HTTP client: unlike Playwright's
  // transport it does not route through the environment proxy
  // (HTTP_PROXY/HTTPS_PROXY), so an authenticating proxy never sees this
  // loopback request. `agent: false` disables the shared keep-alive agent.
  // Passing the discovered WS URL explicitly makes Playwright skip its own
  // proxied /json/version/ lookup.
  const info = await new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Local CDP discovery returned ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('Local CDP discovery timed out')));
  });
  const websocket = new URL(info.webSocketDebuggerUrl);
  requireLoopback(websocket, 'ws:');
  return chromium.connectOverCDP(websocket.href);
}
