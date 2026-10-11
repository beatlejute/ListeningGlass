'use strict';

// QA-010: тесты исполняют исходник адаптера src/page/youtube-adapter.js в node:vm
// с подменными window и document и читают результат через ytcfg — так же, как его
// видит страница YouTube. Образец vm-контекста — test/background-scope.test.mjs:21-48.
// Копий функций адаптера в файле нет: единственный источник поведения — исходник.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_FILE = 'src/page/youtube-adapter.js';
const ADAPTER_SOURCE = fs.readFileSync(path.join(ROOT, ADAPTER_FILE), 'utf8');

// Значения взяты из снятого с m.youtube.com ytcfg (qa/youtube.md:20-33): страница
// отдаёт четыре конфига WEB_PLAYER_CONTEXT_CONFIG_ID_MWEB_*, в строке флагов стоят
// uniplayer_block_pip=true и пять html5_picture_in_picture_blocking_*=true, а
// mweb_allow_background_playback YouTube не выставляет вовсе.
const REAL_CONFIG_ID = 'WEB_PLAYER_CONTEXT_CONFIG_ID_MWEB_WATCH';

function realFlagString({ duplicatePip = false, omitPip = false } = {}) {
  const pairs = [
    'uniplayer_block_pip=true',
    'html5_picture_in_picture_blocking_ontimeupdate=true',
    'html5_picture_in_picture_blocking_onresize=true',
    'html5_picture_in_picture_blocking_document_fullscreen=true',
    'html5_picture_in_picture_blocking_standard_api=true',
  ].filter((pair) => !(omitPip && pair.startsWith('uniplayer_block_pip=')));
  if (duplicatePip) pairs.push('uniplayer_block_pip=true');
  return pairs.join('&');
}

function realConfigs(flags) {
  return { [REAL_CONFIG_ID]: { serializedExperimentFlags: flags } };
}

// Страница: window, document, ytcfg и таймеры — подменные объекты в памяти, файлов тест не пишет.
function createPage() {
  const intervals = [];
  const store = new Map();
  const ytcfg = {
    get: (key) => store.get(key),
    set(...args) {
      if (args.length > 1) store.set(args[0], args[1]);
      else if (args[0] && typeof args[0] === 'object') {
        for (const [key, value] of Object.entries(args[0])) store.set(key, value);
      }
    },
  };
  const attributes = {};
  const context = vm.createContext({
    console,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    document: {
      readyState: 'complete',
      documentElement: { setAttribute: (name, value) => { attributes[name] = value; } },
      addEventListener() {},
    },
  });
  context.window = context;
  context.self = context;
  context.__createYtcfg = () => ytcfg;
  return { context, intervals, ytcfg };
}

function startAdapter(context) {
  vm.runInContext(ADAPTER_SOURCE, context, { filename: ADAPTER_FILE });
}

// Страница объявляет `var ytcfg` и кладёт конфиги плеера — форма вызова ytcfg.set
// бывает парой ключ–значение и объектом (src/page/youtube-adapter.js:88-95).
function pageStoresConfigs(context, configs, { form }) {
  context.__configs = configs;
  const call =
    form === 'pair'
      ? "ytcfg.set('WEB_PLAYER_CONTEXT_CONFIGS', __configs);"
      : 'ytcfg.set({ WEB_PLAYER_CONTEXT_CONFIGS: __configs });';
  vm.runInContext(`var ytcfg = __createYtcfg(); ${call}`, context, { filename: 'page.js' });
}

// Строка флагов читается тем же способом, что и на странице: через ytcfg.get.
function storedFlags(ytcfg, configId = REAL_CONFIG_ID) {
  return ytcfg.get('WEB_PLAYER_CONTEXT_CONFIGS')[configId].serializedExperimentFlags;
}

test('флаг есть — uniplayer_block_pip заменяется значением из FORCED_FLAGS', () => {
  const { context, ytcfg } = createPage();
  startAdapter(context);
  pageStoresConfigs(context, realConfigs(realFlagString()), { form: 'pair' });

  const flags = storedFlags(ytcfg);
  assert.ok(flags.includes('uniplayer_block_pip=false'), flags);
  assert.ok(!flags.includes('uniplayer_block_pip=true'), flags);
  assert.ok(flags.includes('html5_picture_in_picture_blocking_ontimeupdate=false'), flags);
  assert.ok(flags.includes('mweb_allow_background_playback=true'), flags);
});

test('флага нет — дописывается парой имя=значение из FORCED_FLAGS', () => {
  const { context, ytcfg } = createPage();
  startAdapter(context);
  pageStoresConfigs(context, realConfigs(realFlagString({ omitPip: true })), { form: 'pair' });

  const flags = storedFlags(ytcfg);
  assert.ok(flags.includes('uniplayer_block_pip=false'), flags);
  assert.ok(!flags.includes('uniplayer_block_pip=true'), flags);
});

test('флаг встречается дважды — заменяются оба вхождения', () => {
  const { context, ytcfg } = createPage();
  startAdapter(context);
  pageStoresConfigs(context, realConfigs(realFlagString({ duplicatePip: true })), { form: 'pair' });

  const found = storedFlags(ytcfg).split('&').filter((part) => part.startsWith('uniplayer_block_pip='));
  assert.equal(found.length, 2);
  assert.deepEqual(found, ['uniplayer_block_pip=false', 'uniplayer_block_pip=false']);
});

test('ytcfg объявлен до скрипта — конфиги из хранилища подменяются на месте', () => {
  const { context, ytcfg } = createPage();
  context.__configs = realConfigs(realFlagString());
  vm.runInContext(
    "var ytcfg = __createYtcfg(); ytcfg.set('WEB_PLAYER_CONTEXT_CONFIGS', __configs);",
    context,
    { filename: 'page.js' },
  );

  startAdapter(context);

  const stored = storedFlags(ytcfg);
  assert.ok(stored.includes('uniplayer_block_pip=false'), stored);
  assert.ok(!stored.includes('uniplayer_block_pip=true'), stored);
  assert.ok(stored.includes('mweb_allow_background_playback=true'), stored);

  pageStoresConfigs(context, realConfigs(realFlagString()), { form: 'pair' });

  const afterSet = storedFlags(ytcfg);
  assert.ok(afterSet.includes('uniplayer_block_pip=false'), afterSet);
  assert.ok(!afterSet.includes('uniplayer_block_pip=true'), afterSet);
});

test('ytcfg.set с объектом — конфиги плеера подменяются', () => {
  const { context, ytcfg } = createPage();
  startAdapter(context);
  pageStoresConfigs(context, realConfigs(realFlagString()), { form: 'object' });

  const flags = storedFlags(ytcfg);
  assert.ok(flags.includes('uniplayer_block_pip=false'), flags);
  assert.ok(!flags.includes('uniplayer_block_pip=true'), flags);
  assert.ok(flags.includes('mweb_allow_background_playback=true'), flags);
});

test('ytcfg.set с парой ключ–значение — конфиги плеера подменяются', () => {
  const { context, ytcfg } = createPage();
  startAdapter(context);
  pageStoresConfigs(context, realConfigs(realFlagString()), { form: 'pair' });

  const flags = storedFlags(ytcfg);
  assert.ok(flags.includes('uniplayer_block_pip=false'), flags);
  assert.ok(flags.includes('mweb_allow_background_playback=true'), flags);
});

test('window._lact обновляется раз в 60 с на подменных таймерах', () => {
  const { context, intervals } = createPage();
  startAdapter(context);
  vm.runInContext('window._lact = 1000;', context);

  const refresh = intervals.find((entry) => entry.ms === 60 * 1000);
  assert.ok(refresh, `интервал 60000 мс не зарегистрирован: ${JSON.stringify(intervals.map((i) => i.ms))}`);

  refresh.fn();

  assert.ok(context._lact > 1000, `_lact не обновлён: ${context._lact}`);
});
