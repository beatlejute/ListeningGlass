'use strict';

// Service worker загружает модули через importScripts: они выполняются в той же
// глобальной области, что и src/background.js, и их верхнеуровневые const и
// function становятся общими глобальными именами. Повторное объявление такого
// имени в background.js ломает загрузку воркера — в Яндекс Браузере на Android
// (HUMAN-002, 2026-09-30): «Service worker registration failed. Status code: 15»,
// «Failed to execute 'importScripts' on 'WorkerGlobalScope': Identifier … has
// already been declared». Тесты модулей по отдельности этого не видят, поэтому
// здесь все три файла выполняются в одном контексте, как их грузит браузер.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function workerContext() {
  const registered = [];
  const listener = () => ({ addListener() {} });
  const context = vm.createContext({
    console,
    Promise,
    chrome: {
      runtime: { onInstalled: listener(), onStartup: listener() },
      storage: {
        local: { get: (key, callback) => callback({}) },
        onChanged: listener(),
      },
      scripting: {
        getRegisteredContentScripts: async () => [],
        unregisterContentScripts: async () => {},
        registerContentScripts: async (scripts) => { registered.push(...scripts); },
      },
    },
  });
  context.globalThis = context;
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
    }
  };
  return { context, registered };
}

test('background.js loads its modules via importScripts in one global scope', () => {
  const { context } = workerContext();
  assert.doesNotThrow(() => {
    vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  });
  assert.equal(typeof context.injection, 'object');
  assert.equal(typeof context.siteList, 'object');
});

test('the worker registers page scripts for the default sites on start', async () => {
  const { context, registered } = workerContext();
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  for (let i = 0; i < 20 && registered.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const matches = registered.flatMap((script) => script.matches);
  assert.ok(registered.length > 0, 'registerContentScripts вызван');
  assert.ok(matches.includes('*://music.apple.com/*'), 'сайт из списка по умолчанию зарегистрирован');
});
