'use strict';

const STORAGE_KEY = 'siteList';

const DEFAULT_HOSTS = Object.freeze([
  'm.youtube.com',
  'www.youtube.com',
  'www.youtube-nocookie.com',
  'music.youtube.com',
  'rutube.ru',
  'm.twitch.tv',
  'www.twitch.tv',
  'www.tiktok.com',
  'music.apple.com',
]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function extractHost(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
  return url.host;
}

function emptyState() {
  return { added: [], excluded: [] };
}

function sanitizeState(state) {
  if (!state || typeof state !== 'object') return emptyState();
  const added = Array.isArray(state.added)
    ? state.added.filter((host) => typeof host === 'string')
    : [];
  const excluded = Array.isArray(state.excluded)
    ? state.excluded.filter((host) => typeof host === 'string')
    : [];
  return { added, excluded };
}

function isHostEnabled(host, state, defaultHosts = DEFAULT_HOSTS) {
  const safeState = sanitizeState(state);
  if (safeState.excluded.includes(host)) return false;
  if (defaultHosts.includes(host)) return true;
  return safeState.added.includes(host);
}

function addHostToState(host, state) {
  const safeState = sanitizeState(state);
  const excluded = safeState.excluded.filter((h) => h !== host);
  const added = safeState.added.includes(host)
    ? safeState.added
    : [...safeState.added, host];
  return { added, excluded };
}

function removeHostFromState(host, state, defaultHosts = DEFAULT_HOSTS) {
  const safeState = sanitizeState(state);
  if (defaultHosts.includes(host)) {
    const excluded = safeState.excluded.includes(host)
      ? safeState.excluded
      : [...safeState.excluded, host];
    return { added: safeState.added, excluded };
  }
  return {
    added: safeState.added.filter((h) => h !== host),
    excluded: safeState.excluded,
  };
}

function resetState() {
  return emptyState();
}

function readState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(sanitizeState(result && result[STORAGE_KEY]));
    });
  });
}

function writeState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
  });
}

async function isUrlEnabled(input) {
  const host = extractHost(input);
  if (host === null) return false;
  const state = await readState();
  return isHostEnabled(host, state);
}

async function addSite(input) {
  const host = extractHost(input);
  if (host === null) return false;
  const state = await readState();
  await writeState(addHostToState(host, state));
  return true;
}

async function removeSite(input) {
  const host = extractHost(input);
  if (host === null) return false;
  const state = await readState();
  await writeState(removeHostFromState(host, state));
  return true;
}

async function resetToDefault() {
  await writeState(resetState());
}

const api = {
  STORAGE_KEY,
  DEFAULT_HOSTS,
  extractHost,
  sanitizeState,
  isHostEnabled,
  addHostToState,
  removeHostFromState,
  resetState,
  isUrlEnabled,
  addSite,
  removeSite,
  resetToDefault,
};

// Service worker подключает модуль через importScripts и обращается к нему
// как к глобальному siteList, в Node — как к CommonJS-модулю.
globalThis.siteList = api;

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = api;
}
