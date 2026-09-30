'use strict';

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import siteList from '../src/site-list.js';

const {
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
} = siteList;

const EXPECTED_DEFAULT_HOSTS = [
  'm.youtube.com',
  'www.youtube.com',
  'www.youtube-nocookie.com',
  'music.youtube.com',
  'rutube.ru',
  'm.twitch.tv',
  'www.twitch.tv',
  'www.tiktok.com',
  'music.apple.com',
];

function createInMemoryChromeStorage(initial = {}) {
  let store = { ...initial };
  return {
    storage: {
      local: {
        get(key, callback) {
          callback(key in store ? { [key]: store[key] } : {});
        },
        set(values, callback) {
          store = { ...store, ...values };
          if (callback) callback();
        },
      },
    },
  };
}

beforeEach(() => {
  globalThis.chrome = createInMemoryChromeStorage();
});

describe('DEFAULT_HOSTS — набор доменов по умолчанию', () => {
  test('целиком совпадает со списком девяти доменов', () => {
    assert.deepEqual([...DEFAULT_HOSTS].sort(), [...EXPECTED_DEFAULT_HOSTS].sort());
  });

  for (const host of EXPECTED_DEFAULT_HOSTS) {
    test(`isHostEnabled — "${host}" включён по умолчанию без пользовательского стейта`, () => {
      assert.equal(isHostEnabled(host, sanitizeState(null)), true);
    });
  }
});

describe('extractHost — edge case: порт', () => {
  test('хост без порта', () => {
    assert.equal(extractHost('https://example.com/path'), 'example.com');
  });

  test('хост с портом — отдельный хост от версии без порта', () => {
    assert.equal(extractHost('https://example.com:8080/path'), 'example.com:8080');
    assert.notEqual(extractHost('https://example.com:8080/path'), extractHost('https://example.com/path'));
  });
});

describe('extractHost — edge case: вариант www.', () => {
  test('www. и без www. — разные хосты', () => {
    assert.equal(extractHost('https://www.example.com'), 'www.example.com');
    assert.equal(extractHost('https://example.com'), 'example.com');
    assert.notEqual(extractHost('https://www.example.com'), extractHost('https://example.com'));
  });

  test('без явного добавления пользователем www.youtube.com включён, youtube.com — нет', () => {
    const state = sanitizeState(null);
    assert.equal(isHostEnabled('www.youtube.com', state), true);
    assert.equal(isHostEnabled('youtube.com', state), false);
  });
});

describe('extractHost — edge case: схемы кроме http/https', () => {
  for (const url of ['ftp://example.com', 'chrome://extensions', 'chrome-extension://abcdefgh/page.html', 'file:///etc/passwd']) {
    test(`схема из "${url}" не даёт хост`, () => {
      assert.equal(extractHost(url), null);
    });
  }

  test('http: и https: — разрешённые схемы', () => {
    assert.equal(extractHost('http://example.com'), 'example.com');
    assert.equal(extractHost('https://example.com'), 'example.com');
  });

  test('не-URL строка не даёт хост', () => {
    assert.equal(extractHost('not a url'), null);
  });
});

describe('sanitizeState — edge case: пустой и повреждённый storage', () => {
  test('null и undefined дают пустой стейт', () => {
    assert.deepEqual(sanitizeState(null), { added: [], excluded: [] });
    assert.deepEqual(sanitizeState(undefined), { added: [], excluded: [] });
  });

  test('не-объект даёт пустой стейт', () => {
    assert.deepEqual(sanitizeState('corrupted'), { added: [], excluded: [] });
    assert.deepEqual(sanitizeState(42), { added: [], excluded: [] });
  });

  test('не-массивы в полях added/excluded отбрасываются', () => {
    assert.deepEqual(sanitizeState({ added: 'nope', excluded: null }), { added: [], excluded: [] });
  });

  test('нестроковые элементы массивов отфильтровываются', () => {
    assert.deepEqual(
      sanitizeState({ added: ['a.com', 1, null], excluded: [2, 'b.com', undefined] }),
      { added: ['a.com'], excluded: ['b.com'] }
    );
  });

  test('повреждённый storage — домены по умолчанию всё равно включены', () => {
    assert.equal(isHostEnabled('rutube.ru', sanitizeState('corrupted')), true);
    assert.equal(isHostEnabled('rutube.ru', sanitizeState(null)), true);
  });
});

describe('isHostEnabled / addHostToState / removeHostFromState', () => {
  test('добавленный пользователем хост включён', () => {
    const state = addHostToState('added-by-user.com', sanitizeState(null));
    assert.equal(isHostEnabled('added-by-user.com', state), true);
  });

  test('неизвестный хост без добавления выключен', () => {
    assert.equal(isHostEnabled('unknown.example', sanitizeState(null)), false);
  });

  test('удаление хоста по умолчанию помечает его исключённым, а не удаляет из набора', () => {
    const state = removeHostFromState('rutube.ru', sanitizeState(null));
    assert.equal(isHostEnabled('rutube.ru', state), false);
    assert.ok(DEFAULT_HOSTS.includes('rutube.ru'));
    assert.deepEqual(state.excluded, ['rutube.ru']);
  });

  test('повторное удаление хоста по умолчанию не дублирует исключение', () => {
    let state = removeHostFromState('rutube.ru', sanitizeState(null));
    state = removeHostFromState('rutube.ru', state);
    assert.deepEqual(state.excluded, ['rutube.ru']);
  });

  test('повторное добавление ранее исключённого хоста по умолчанию снимает исключение', () => {
    let state = removeHostFromState('rutube.ru', sanitizeState(null));
    assert.equal(isHostEnabled('rutube.ru', state), false);
    state = addHostToState('rutube.ru', state);
    assert.equal(isHostEnabled('rutube.ru', state), true);
  });

  test('удаление пользовательского хоста убирает его из added', () => {
    let state = addHostToState('custom.example', sanitizeState(null));
    assert.equal(isHostEnabled('custom.example', state), true);
    state = removeHostFromState('custom.example', state);
    assert.equal(isHostEnabled('custom.example', state), false);
    assert.deepEqual(state.excluded, []);
  });

  test('повторное добавление того же хоста не дублирует запись', () => {
    let state = addHostToState('dup.example', sanitizeState(null));
    state = addHostToState('dup.example', state);
    assert.deepEqual(state.added, ['dup.example']);
  });
});

describe('resetState', () => {
  test('возвращает пустой стейт', () => {
    assert.deepEqual(resetState(), { added: [], excluded: [] });
  });
});

describe('обёртки над chrome.storage.local — подменная реализация storage в памяти', () => {
  test('isUrlEnabled — включённый по умолчанию хост без записей в storage', async () => {
    assert.equal(await isUrlEnabled('https://www.youtube.com/watch?v=1'), true);
  });

  test('isUrlEnabled — недопустимая схема не читает storage и даёт false', async () => {
    globalThis.chrome = undefined;
    assert.equal(await isUrlEnabled('chrome://extensions'), false);
  });

  test('addSite записывает хост в storage, isUrlEnabled видит изменение', async () => {
    assert.equal(await isUrlEnabled('https://added.example'), false);
    const added = await addSite('https://added.example');
    assert.equal(added, true);
    assert.equal(await isUrlEnabled('https://added.example'), true);
  });

  test('removeSite для сайта по умолчанию исключает его через storage', async () => {
    assert.equal(await isUrlEnabled('https://rutube.ru'), true);
    const removed = await removeSite('https://rutube.ru');
    assert.equal(removed, true);
    assert.equal(await isUrlEnabled('https://rutube.ru'), false);
  });

  test('resetToDefault возвращает список к умолчанию после исключений и добавлений', async () => {
    await removeSite('https://rutube.ru');
    await addSite('https://added.example');
    assert.equal(await isUrlEnabled('https://rutube.ru'), false);
    assert.equal(await isUrlEnabled('https://added.example'), true);

    await resetToDefault();

    assert.equal(await isUrlEnabled('https://rutube.ru'), true);
    assert.equal(await isUrlEnabled('https://added.example'), false);
  });

  test('addSite/removeSite с недопустимой схемой не пишут в storage и возвращают false', async () => {
    const chromeStub = globalThis.chrome;
    let setCalled = false;
    const originalSet = chromeStub.storage.local.set.bind(chromeStub.storage.local);
    chromeStub.storage.local.set = (values, callback) => {
      setCalled = true;
      originalSet(values, callback);
    };
    assert.equal(await addSite('ftp://example.com'), false);
    assert.equal(await removeSite('ftp://example.com'), false);
    assert.equal(setCalled, false);
  });
});
