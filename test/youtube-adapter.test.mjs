import assert from 'assert';
import test from 'node:test';

// Функции из адаптера YouTube для тестирования
const FORCED_FLAGS = {
  mweb_allow_background_playback: 'true',
  uniplayer_block_pip: 'false',
  html5_picture_in_picture_blocking_ontimeupdate: 'false',
  html5_picture_in_picture_blocking_onresize: 'false',
  html5_picture_in_picture_blocking_document_fullscreen: 'false',
  html5_picture_in_picture_blocking_standard_api: 'false',
};

function patchFlagString(flags) {
  const missing = new Set(Object.keys(FORCED_FLAGS));
  const parts = (flags ? flags.split('&') : []).map((part) => {
    const name = part.split('=', 1)[0];
    if (!Object.prototype.hasOwnProperty.call(FORCED_FLAGS, name)) return part;
    missing.delete(name);
    return `${name}=${FORCED_FLAGS[name]}`;
  });
  for (const name of missing) parts.push(`${name}=${FORCED_FLAGS[name]}`);
  return parts.join('&');
}

function patchPlayerConfigs(configs) {
  if (!configs || typeof configs !== 'object') return;
  for (const config of Object.values(configs)) {
    if (config && typeof config.serializedExperimentFlags === 'string') {
      config.serializedExperimentFlags = patchFlagString(config.serializedExperimentFlags);
    }
  }
}

function patchSetArgs(args) {
  if (args.length > 1) {
    if (args[0] === 'WEB_PLAYER_CONTEXT_CONFIGS') patchPlayerConfigs(args[1]);
  } else if (args[0] && typeof args[0] === 'object') {
    patchPlayerConfigs(args[0].WEB_PLAYER_CONTEXT_CONFIGS);
  }
}

test('Флаг uniplayer_block_pip заменяется', () => {
  const input = 'some_flag=value&uniplayer_block_pip=true&other=test';
  const result = patchFlagString(input);
  assert(result.includes('uniplayer_block_pip=false'));
  assert(!result.includes('uniplayer_block_pip=true'));
});

test('Отсутствующий флаг дописывается', () => {
  const input = 'some_flag=value&other=test';
  const result = patchFlagString(input);
  assert(result.includes('uniplayer_block_pip=false'));
  assert(result.includes('mweb_allow_background_playback=true'));
});

test('Флаг дважды заменяется в обоих местах', () => {
  const input = 'uniplayer_block_pip=true&other=test&uniplayer_block_pip=true';
  const result = patchFlagString(input);
  const matches = result.split('&').filter(p => p.startsWith('uniplayer_block_pip='));
  assert.equal(matches.length, 2);
  assert(matches.every(m => m === 'uniplayer_block_pip=false'));
});

test('Пустая строка флагов - все флаги дописаны', () => {
  const input = '';
  const result = patchFlagString(input);
  assert(result.includes('mweb_allow_background_playback=true'));
  assert(result.includes('uniplayer_block_pip=false'));
  assert(result.includes('html5_picture_in_picture_blocking_ontimeupdate=false'));
});

test('null строка флагов - все флаги дописаны', () => {
  const input = null;
  const result = patchFlagString(input);
  assert(result.includes('mweb_allow_background_playback=true'));
  assert(result.includes('uniplayer_block_pip=false'));
});

test('Конфиги с serializedExperimentFlags патчатся', () => {
  const configs = {
    config1: {
      serializedExperimentFlags: 'uniplayer_block_pip=true&other=value',
    },
    config2: {
      serializedExperimentFlags: 'some_flag=val',
    },
  };
  patchPlayerConfigs(configs);
  assert(configs.config1.serializedExperimentFlags.includes('uniplayer_block_pip=false'));
  assert(configs.config1.serializedExperimentFlags.includes('mweb_allow_background_playback=true'));
  assert(configs.config2.serializedExperimentFlags.includes('mweb_allow_background_playback=true'));
});

test('Конфиги без serializedExperimentFlags не вызывают ошибок', () => {
  const configs = {
    config1: { other: 'value' },
    config2: null,
  };
  assert.doesNotThrow(() => {
    patchPlayerConfigs(configs);
  });
});

test('patchSetArgs с двумя аргументами - ключ и значение объект', () => {
  const configs = {
    config1: {
      serializedExperimentFlags: 'uniplayer_block_pip=true',
    },
  };
  const args = ['WEB_PLAYER_CONTEXT_CONFIGS', configs];
  patchSetArgs(args);
  assert(configs.config1.serializedExperimentFlags.includes('uniplayer_block_pip=false'));
});

test('patchSetArgs с одним аргументом - объект с WEB_PLAYER_CONTEXT_CONFIGS', () => {
  const configs = {
    config1: {
      serializedExperimentFlags: 'uniplayer_block_pip=true',
    },
  };
  const args = [{ WEB_PLAYER_CONTEXT_CONFIGS: configs }];
  patchSetArgs(args);
  assert(configs.config1.serializedExperimentFlags.includes('uniplayer_block_pip=false'));
});

test('ytcfg объявлен до скрипта - начальные конфиги патчатся', () => {
  const mockGlobal = {
    ytcfg: {
      get: (key) => {
        if (key === 'WEB_PLAYER_CONTEXT_CONFIGS') {
          return {
            config1: { serializedExperimentFlags: 'uniplayer_block_pip=true' },
          };
        }
        return null;
      },
      set: () => {},
    },
  };
  const configs = mockGlobal.ytcfg.get('WEB_PLAYER_CONTEXT_CONFIGS');
  patchPlayerConfigs(configs);
  assert(configs.config1.serializedExperimentFlags.includes('uniplayer_block_pip=false'));
});

test('Множество конфигов - все патчатся', () => {
  const configs = {
    1: { serializedExperimentFlags: 'uniplayer_block_pip=true' },
    2: { serializedExperimentFlags: 'some=value' },
    3: { serializedExperimentFlags: '' },
    4: { other: 'field' },
  };
  patchPlayerConfigs(configs);
  assert(configs['1'].serializedExperimentFlags.includes('uniplayer_block_pip=false'));
  assert(configs['2'].serializedExperimentFlags.includes('mweb_allow_background_playback=true'));
  assert(configs['3'].serializedExperimentFlags.includes('mweb_allow_background_playback=true'));
});

test('Сохранение остальных флагов при замене', () => {
  const input = 'custom_flag=custom_value&uniplayer_block_pip=true&another=test';
  const result = patchFlagString(input);
  assert(result.includes('custom_flag=custom_value'));
  assert(result.includes('another=test'));
  assert(result.includes('uniplayer_block_pip=false'));
});
