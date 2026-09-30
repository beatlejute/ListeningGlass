'use strict';

const STORAGE_KEY = 'siteList';
const DEFAULT_HOSTS = [
  'm.youtube.com', 'www.youtube.com', 'www.youtube-nocookie.com',
  'music.youtube.com', 'rutube.ru', 'm.twitch.tv', 'www.twitch.tv',
  'www.tiktok.com', 'music.apple.com',
];

function sanitizeState(state) {
  if (!state || typeof state !== 'object') return { added: [], excluded: [] };
  const added = Array.isArray(state.added) ? state.added.filter(h => typeof h === 'string') : [];
  const excluded = Array.isArray(state.excluded) ? state.excluded.filter(h => typeof h === 'string') : [];
  return { added, excluded };
}

function isHostEnabled(host, state) {
  const s = sanitizeState(state);
  if (s.excluded.includes(host)) return false;
  if (DEFAULT_HOSTS.includes(host)) return true;
  return s.added.includes(host);
}

function addHost(host, state) {
  const s = sanitizeState(state);
  const excluded = s.excluded.filter(h => h !== host);
  const added = s.added.includes(host) ? s.added : [...s.added, host];
  return { added, excluded };
}

function removeHost(host, state) {
  const s = sanitizeState(state);
  if (DEFAULT_HOSTS.includes(host)) {
    const excluded = s.excluded.includes(host) ? s.excluded : [...s.excluded, host];
    return { added: s.added, excluded };
  }
  return { added: s.added.filter(h => h !== host), excluded: s.excluded };
}

function resetState() {
  return { added: [], excluded: [] };
}

function getServicePage() {
  return /^chrome:|chrome-extension:|https?:\/\/chrome\.google\.com\/webstore/.test(window.location.href) ? true : false;
}

async function getCurrentTabHost() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        resolve(null);
        return;
      }
      try {
        const url = new URL(tab.url);
        resolve(url.host || null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function init() {
  const host = await getCurrentTabHost();
  const hostEl = document.getElementById('current-host');
  const toggleArea = document.getElementById('toggle-area');
  const serviceMsg = document.getElementById('service-page-msg');
  const reloadMsg = document.getElementById('reload-msg');
  const toggle = document.getElementById('host-toggle');
  const label = document.getElementById('state-label');
  const resetBtn = document.getElementById('reset-btn');

  if (!host) {
    hostEl.textContent = '—';
    toggleArea.classList.add('hidden');
    serviceMsg.classList.remove('hidden');
    serviceMsg.textContent = 'Cannot read current page host.';
    return;
  }

  hostEl.textContent = host;

  if (/^chrome:/.test(host) || /chrome\.google\.com/.test(host) || host === 'store') {
    toggleArea.classList.add('hidden');
    serviceMsg.classList.remove('hidden');
    serviceMsg.textContent = 'Switch unavailable on service pages (chrome://*, store pages).';
    return;
  }

  toggleArea.classList.remove('hidden');
  serviceMsg.classList.add('hidden');

  chrome.storage.local.get(STORAGE_KEY, (result) => {
    const state = sanitizeState(result && result[STORAGE_KEY]);
    const enabled = isHostEnabled(host, state);
    toggle.checked = enabled;
    label.textContent = enabled ? 'Enabled' : 'Disabled';
  });

  toggle.addEventListener('change', () => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const state = sanitizeState(result && result[STORAGE_KEY]);
      const newEnabled = toggle.checked;
      let newState;
      if (newEnabled) {
        newState = addHost(host, state);
      } else {
        newState = removeHost(host, state);
      }
      chrome.storage.local.set({ [STORAGE_KEY]: newState }, () => {
        const state = sanitizeState(newState);
        label.textContent = isHostEnabled(host, newState) ? 'Enabled' : 'Disabled';
        reloadMsg.classList.remove('hidden');
        setTimeout(() => reloadMsg.classList.add('hidden'), 3000);
      });
    });
  });

  resetBtn.addEventListener('click', () => {
    chrome.storage.local.set({ [STORAGE_KEY]: resetState() }, () => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const state = sanitizeState(result && result[STORAGE_KEY]);
        toggle.checked = isHostEnabled(host, state);
        label.textContent = isHostEnabled(host, state) ? 'Enabled' : 'Disabled';
        reloadMsg.classList.remove('hidden');
        setTimeout(() => reloadMsg.classList.add('hidden'), 3000);
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
