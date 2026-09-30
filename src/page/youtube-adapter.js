'use strict';

// Страничный скрипт адаптера YouTube (тикет IMPL-005): точка входа,
// зарегистрированная в main world на document_start во всех фреймах
// и только на доменах YouTube из таблицы плана (IMPL-007).
//
// Плеер YouTube на m.youtube.com останавливает видео, пока страница скрыта,
// если не включён экспериментальный флаг mweb_allow_background_playback, и
// запрещает Picture-in-Picture флагами uniplayer_block_pip и
// html5_picture_in_picture_blocking_*. Флаги лежат в ytcfg
// → WEB_PLAYER_CONTEXT_CONFIGS[*].serializedExperimentFlags (строка
// «имя=значение&…») и читаются плеером ОДИН РАЗ при его создании. Значит
// подмена обязана случиться раньше первого ytcfg.set(...), который страница
// делает на document_start, — этот скрипт и стоит в этой точке.
//
// Поведение взято из прототипа: prototype/page.js:18-25 (флаги),
// :44-121 (подмена строки и перехват ytcfg), :193-198 (window._lact).

if (window.__listeningGlassYouTube) {
} else {
  window.__listeningGlassYouTube = true;
  document.documentElement.setAttribute('data-listening-glass-youtube', 'started');

  // Окно «Video paused. Continue watching?» отсчитывается от последней
  // активности пользователя (window._lact) и появляется, когда значение
  // устарело. Обновляем его, чтобы на длинном прослушивании окно не выскакивало.
  const LACT_REFRESH_MS = 60 * 1000;

  // Флаги и значения из раздела «Адаптер YouTube» плана.
  const FORCED_FLAGS = {
    mweb_allow_background_playback: 'true',
    uniplayer_block_pip: 'false',
    html5_picture_in_picture_blocking_ontimeupdate: 'false',
    html5_picture_in_picture_blocking_onresize: 'false',
    html5_picture_in_picture_blocking_document_fullscreen: 'false',
    html5_picture_in_picture_blocking_standard_api: 'false',
  };

  const state = { flagsPatched: 0, log: [] };

  function log(message) {
    state.log.push(`${new Date().toISOString().slice(11, 19)} ${message}`);
    if (state.log.length > 50) state.log.shift();
  }

  function whenDomReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true });
    } else {
      callback();
    }
  }

  // Разбор и сборка строки флагов. Флаг, которого нет, дописывается в конец;
  // флаг, встречающийся дважды, переписывается в обоих местах, потому что
  // map проходит по всем частям строки, а не только по первому совпадению.
  // Части без '=' не обрезаются до пустой строки: split отдаёт всю часть,
  // и неизвестный флаг с '=' сохраняется целиком.
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
        state.flagsPatched++;
      }
    }
  }

  // Формы вызова ytcfg.set: set('KEY', value) и set({KEY: value, …}).
  function patchSetArgs(args) {
    if (args.length > 1) {
      if (args[0] === 'WEB_PLAYER_CONTEXT_CONFIGS') patchPlayerConfigs(args[1]);
    } else if (args[0] && typeof args[0] === 'object') {
      patchPlayerConfigs(args[0].WEB_PLAYER_CONTEXT_CONFIGS);
    }
  }

  function storedPlayerConfigs(cfg) {
    try {
      return cfg && typeof cfg.get === 'function' ? cfg.get('WEB_PLAYER_CONTEXT_CONFIGS') : null;
    } catch (error) {
      return null;
    }
  }

  // ytcfg.set() кладёт конфиг в хранилище страницы, поэтому конфиги плеера
  // подменяются на входе в set — до того, как их прочитает плеер.
  const hookedConfigs = new WeakSet();

  function hookYtcfg(cfg) {
    if (!cfg || typeof cfg !== 'object' || hookedConfigs.has(cfg)) return;
    hookedConfigs.add(cfg);

    let setImpl = cfg.set;
    function set(...args) {
      try {
        patchSetArgs(args);
      } catch (error) {
        log(`flag patch failed: ${error && error.message}`);
      }
      return setImpl.apply(this, args);
    }

    // Геттер возвращает нашу обёртку и скрывает её от простой проверки
    // ytcfg.set === setImpl; сеттер оставлен, чтобы страница могла заменить
    // перехватываемый метод целиком. Переопределение метода объекта
    // не даёт записи в accessor, поэтому переустановка до создания плеера
    // остаётся перехваченной.
    try {
      Object.defineProperty(cfg, 'set', {
        configurable: true,
        enumerable: true,
        get: () => (typeof setImpl === 'function' ? set : setImpl),
        set: (value) => { setImpl = value; },
      });
    } catch (error) {
      log(`ytcfg.set hook failed: ${error && error.message}`);
    }

    // Конфиги могли прийти в хранилище до перехвата: подменяем их сразу.
    patchPlayerConfigs(storedPlayerConfigs(cfg));
  }

  // Страница объявляет `var ytcfg = {...}`: объявление без присваивания не
  // трогает уже существующее свойство, а вот присваивание ниже вызовет наш
  // сеттер. Поэтому accessor ставится здесь, до скриптов страницы.
  let ytcfgValue = window.ytcfg;
  hookYtcfg(ytcfgValue);

  try {
    Object.defineProperty(window, 'ytcfg', {
      configurable: true,
      enumerable: true,
      get: () => ytcfgValue,
      set: (value) => {
        ytcfgValue = value;
        hookYtcfg(value);
      },
    });
  } catch (error) {
    // Свойство уже объявлено как неконфигурируемое — accessor не поставить.
    // Объект, лежащий в window.ytcfg, перехвачен hookYtcfg выше; новых
    // присваиваний не будет, потому что страницу это не сорвёт.
    log('ytcfg already declared, hooked in place');
  }

  // Окно «Video paused. Continue watching?» считает возраст window._lact.
  setInterval(() => {
    if (typeof window._lact === 'number') window._lact = Date.now();
  }, LACT_REFRESH_MS);

  // Плееры, созданные после document_start (переходы внутри приложения),
  // берут флаги из того же хранилища — конфиги подменяются ещё раз.
  whenDomReady(() => {
    patchPlayerConfigs(storedPlayerConfigs(ytcfgValue));
  });

  // Состояние наружу: по нему тесты и ручные проверки читают счётчик
  // подменённых конфигов и журнал, не завися от приватных переменных.
  Object.assign(window.__listeningGlassYouTube, state, {
    FORCED_FLAGS,
    patchFlagString,
    patchPlayerConfigs,
    patchSetArgs,
    hookYtcfg,
  });
}
