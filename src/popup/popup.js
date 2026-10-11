'use strict';

// Классические скрипты страницы делят одну глобальную область с site-list.js,
// поэтому список сайтов и его функции берём из модуля siteList, а не объявляем
// здесь: верхнеуровневое const STORAGE_KEY рядом с модульным даёт
// «Identifier 'STORAGE_KEY' has already been declared».

// activeTab даёт URL только вкладки, для которой пользователь открыл панель.
// Постоянный доступ к пользовательскому сайту запрашивается при включении.
async function getCurrentTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) {
        resolve({ url: undefined, host: null, hostname: null, scheme: null });
        return;
      }
      if (!tab.url) {
        resolve({ url: undefined, host: null, hostname: null, scheme: null });
        return;
      }
      try {
        const url = new URL(tab.url);
        resolve({ url: tab.url, host: url.host, hostname: url.hostname, scheme: url.protocol });
      } catch {
        resolve({ url: tab.url, host: null, hostname: null, scheme: null });
      }
    });
  });
}

// Шаблон для chrome.permissions.request: схема вкладки и хост без порта. Порт в
// шаблонах соответствия Chrome не участвует, поэтому http://127.0.0.1:8080
// покрыт шаблоном http://127.0.0.1/*.
function accessPattern(tab) {
  return `${tab.scheme}//${tab.hostname}/*`;
}

async function init() {
  const tab = await getCurrentTab();
  const hostEl = document.getElementById('current-host');
  const toggleArea = document.getElementById('toggle-area');
  const serviceMsg = document.getElementById('service-page-msg');
  const permissionMsg = document.getElementById('permission-msg');
  const reloadMsg = document.getElementById('reload-msg');
  const toggle = document.getElementById('host-toggle');
  const label = document.getElementById('state-label');
  const resetBtn = document.getElementById('reset-btn');

  if (siteList.isServicePage(tab && tab.url)) {
    hostEl.textContent = '—';
    toggleArea.classList.add('hidden');
    serviceMsg.classList.remove('hidden');
    serviceMsg.textContent = 'Switch unavailable on service pages (chrome://*, store pages).';
    return;
  }

  const host = tab.host;
  hostEl.textContent = host;

  if (!host) {
    toggleArea.classList.add('hidden');
    serviceMsg.classList.remove('hidden');
    serviceMsg.textContent = 'Switch unavailable on service pages (chrome://*, store pages).';
    return;
  }

  toggleArea.classList.remove('hidden');
  serviceMsg.classList.add('hidden');

  chrome.storage.local.get(siteList.STORAGE_KEY, (result) => {
    const state = siteList.sanitizeState(result && result[siteList.STORAGE_KEY]);
    const enabled = siteList.isHostEnabled(host, state);
    toggle.checked = enabled;
    label.textContent = getStateLabel(host, state);
  });

  function writeToggleState() {
    chrome.storage.local.get(siteList.STORAGE_KEY, (result) => {
      const state = siteList.sanitizeState(result && result[siteList.STORAGE_KEY]);
      const newState = toggle.checked
        ? siteList.addHostToState(host, state)
        : siteList.removeHostFromState(host, state);
      chrome.storage.local.set({ [siteList.STORAGE_KEY]: newState }, () => {
        label.textContent = getStateLabel(host, newState);
        reloadMsg.classList.remove('hidden');
        setTimeout(() => reloadMsg.classList.add('hidden'), 3000);
      });
    });
  }

  function getStateLabel(host, state) {
    const stateStr = siteList.hostState(host, state);
    if (stateStr === 'default') return 'Enabled by default';
    if (stateStr === 'added') return 'Enabled by you';
    return 'Disabled';
  }

  // Хост не из списка по умолчанию расширению не разрешён: доступ к нему
  // спрашивается диалогом, и только согласие записывает хост в список. Запрос —
  // первое действие обработчика: chrome.permissions.request выполняется лишь в
  // обработчике действия пользователя, а chrome.storage.local.get — уже
  // асинхронный шаг, после которого жест может не сохраниться.
  toggle.addEventListener('change', () => {
    if (!toggle.checked || siteList.DEFAULT_HOSTS.includes(host)) {
      permissionMsg.classList.add('hidden');
      writeToggleState();
      return;
    }

    chrome.permissions.request({ origins: [accessPattern(tab)] }, (granted) => {
      if (!granted || chrome.runtime.lastError) {
        toggle.checked = false;
        label.textContent = 'Disabled';
        permissionMsg.textContent = `Permission to run on ${host} was not granted, so the site was not added.`;
        permissionMsg.classList.remove('hidden');
        return;
      }
      permissionMsg.classList.add('hidden');
      writeToggleState();
    });
  });

  resetBtn.addEventListener('click', () => {
    chrome.storage.local.set({ [siteList.STORAGE_KEY]: siteList.resetState() }, () => {
      chrome.storage.local.get(siteList.STORAGE_KEY, (result) => {
        const state = siteList.sanitizeState(result && result[siteList.STORAGE_KEY]);
        toggle.checked = siteList.isHostEnabled(host, state);
        label.textContent = getStateLabel(host, state);
        reloadMsg.classList.remove('hidden');
        setTimeout(() => reloadMsg.classList.add('hidden'), 3000);
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
