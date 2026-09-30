'use strict';

// Service worker (тикет IMPL-005): держит регистрацию страничных скриптов
// в соответствии со списком сайтов.
//
// Способ внедрения выбран по spikes/injection/RESULT.md от 2026-09-30:
// динамическая регистрация в Яндекс Браузере на Android работает
// («Динамическая регистрация: да»), поэтому весь список сайтов — и набор
// по умолчанию, и пользовательские хосты — регистрируется динамически.
// Статическая регистрация из манифеста в этом случае не годится: она не
// может сузиться до включённых хостов, а совпадения нельзя менять без
// переустановки расширения.

// importScripts выполняет модули в той же глобальной области, что и этот файл:
// их верхнеуровневые const и function — общие глобальные имена. Объявить здесь
// такое же имя нельзя: загрузка воркера падает с «Identifier … has already been
// declared» (прежняя деструктуризация YOUTUBE_ADAPTER_HOSTS, DEFAULT_HOSTS…,
// HUMAN-002 на Android, 2026-09-30). Поэтому модули — только через их
// пространства имён injection и siteList.
importScripts('injection.js', 'site-list.js');

function readListState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(siteList.STORAGE_KEY, (result) => {
      resolve(siteList.sanitizeState(result && result[siteList.STORAGE_KEY]));
    });
  });
}

function enabledHosts(state) {
  return [...siteList.DEFAULT_HOSTS, ...state.added].filter(
    (host, index, hosts) => hosts.indexOf(host) === index && siteList.isHostEnabled(host, state),
  );
}

function youtubeHosts(hosts) {
  return hosts.filter((host) => injection.YOUTUBE_ADAPTER_HOSTS.includes(host));
}

// Синхронизация идемпотентна: перед регистрацией снимаются прежние записи,
// иначе повторный вызов падает с «Duplicate script ID». Вызовов несколько —
// при установке, при запуске браузера, при каждом пробуждении service worker
// и при изменении списка.
async function applyRegistrations() {
  const state = await readListState();
  const coreHosts = enabledHosts(state);
  const registrations = injection.buildRegistrations({
    coreHosts,
    youtubeHosts: youtubeHosts(coreHosts),
  });

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: injection.scriptIds(registrations) });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: existing.map((script) => script.id) });
  }
  if (registrations.length > 0) {
    await chrome.scripting.registerContentScripts(registrations);
  }
  return registrations;
}

// Вызовы выстраиваются в очередь: onInstalled и запуск воркера идут
// одновременно, две параллельные проверки видят пустой список и вторая
// регистрация падает с «Duplicate script ID».
let queue = Promise.resolve();

function sync() {
  queue = queue.then(applyRegistrations).catch((error) => {
    console.error('Content script registration failed:', error && error.message);
  });
  return queue;
}

chrome.runtime.onInstalled.addListener(() => {
  sync();
});

chrome.runtime.onStartup.addListener(() => {
  sync();
});

// Изменение списка применяется без переустановки: новая регистрация
// действует на следующих загрузках страниц, уже открытые вкладки не трогаются.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && siteList.STORAGE_KEY in changes) {
    sync();
  }
});

sync();
