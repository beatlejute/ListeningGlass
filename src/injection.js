'use strict';

// Сборка описаний контент-скриптов для динамической регистрации (тикет IMPL-005).
// Модуль чистый: работает с переданными хостами и не обращается к chrome.*,
// поэтому тестируется в Node. Слой регистрации — в src/background.js.

const CORE_SCRIPT_ID = 'listening-glass-core';
const YOUTUBE_SCRIPT_ID = 'listening-glass-youtube';

const CORE_SCRIPT_PATH = 'page/core.js';
const YOUTUBE_SCRIPT_PATH = 'page/youtube-adapter.js';

// Домены YouTube из таблицы плана. Адаптер не выполняется на остальных хостах,
// в том числе на music.youtube.com, которому из плана нужен только приём T1 ядра.
const YOUTUBE_ADAPTER_HOSTS = Object.freeze([
  'm.youtube.com',
  'www.youtube.com',
  'www.youtube-nocookie.com',
]);

// Хост вставляется в шаблон совпадения как есть: порт и поддомены значимы,
// унификация «www.» намеренно не выполняется (см. IMPL-004).
function hostToMatchPattern(host) {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (trimmed === '' || trimmed.includes('*') || trimmed.includes('/')) return null;
  return `*://${trimmed}/*`;
}

function toMatchPatterns(hosts) {
  const patterns = [];
  for (const host of hosts) {
    const pattern = hostToMatchPattern(host);
    if (pattern !== null && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

function createScriptRegistration(id, js, matches) {
  return {
    id,
    matches,
    js: [js],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: true,
    persistAcrossSessions: true,
  };
}

// Ядро выполняется на всех включённых хостах, адаптер YouTube — только на
// подмножестве доменов YouTube. Регистрация без единого совпадения недопустима,
// поэтому пустые ветки в результат не попадают.
function buildRegistrations({ coreHosts = [], youtubeHosts = [] } = {}) {
  const scripts = [];
  const coreMatches = toMatchPatterns(coreHosts);
  if (coreMatches.length > 0) {
    scripts.push(createScriptRegistration(CORE_SCRIPT_ID, CORE_SCRIPT_PATH, coreMatches));
  }
  const youtubeMatches = toMatchPatterns(youtubeHosts);
  if (youtubeMatches.length > 0) {
    scripts.push(createScriptRegistration(YOUTUBE_SCRIPT_ID, YOUTUBE_SCRIPT_PATH, youtubeMatches));
  }
  return scripts;
}

function scriptIds(registrations) {
  return [CORE_SCRIPT_ID, YOUTUBE_SCRIPT_ID];
}

const injectionApi = {
  CORE_SCRIPT_ID,
  YOUTUBE_SCRIPT_ID,
  CORE_SCRIPT_PATH,
  YOUTUBE_SCRIPT_PATH,
  YOUTUBE_ADAPTER_HOSTS,
  hostToMatchPattern,
  toMatchPatterns,
  buildRegistrations,
  scriptIds,
};

// Service worker подключает модуль через importScripts и обращается к нему
// как к глобальному injection, в Node — как к CommonJS-модулю.
globalThis.injection = injectionApi;

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = injectionApi;
}
