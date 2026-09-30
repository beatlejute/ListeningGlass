'use strict';

// Страничный скрипт универсального ядра приёмов (IMPL-006).
// Реализует T1, T3, T5, T7, T8 из research/generic/techniques.js.
// Без переключателей приёмов в продукте и без доменных веток.

if (window.__listeningGlassCore) {
} else {
  window.__listeningGlassCore = true;
  document.documentElement.setAttribute('data-listening-glass-core', 'started');

  const RESUME_WINDOW_MS = 2000;
  const GESTURE_WINDOW_MS = 2000;

  // T1: видимость страницы всегда "visible"
  if (document.visibilityState !== undefined) {
    const nativeVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    if (nativeVisibility && nativeVisibility.get) {
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      } catch (e) { /* ignore */ }
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      } catch (e) { /* ignore */ }
    }
  }
  try {
    if ('webkitHidden' in Document.prototype) {
      Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
    }
  } catch (e) { /* ignore */ }
  try {
    if ('webkitVisibilityState' in Document.prototype) {
      Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
    }
  } catch (e) { /* ignore */ }

  // T3: глушить blur, pagehide, freeze (без глушения blur на полях ввода)
  const swallowTypes = ['blur', 'pagehide', 'freeze'];
  for (const target of [window, document]) {
    for (const type of swallowTypes) {
      target.addEventListener(type, (event) => {
        if (type === 'blur' && event.target && event.target !== window && event.target !== document) {
          const tag = event.target.tagName ? event.target.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) {
            return;
          }
        }
        if (event.target === window || event.target === document) {
          event.stopImmediatePropagation();
        }
      }, true);
    }
  }

  // T5: возобновить воспроизведение в пределах RESUME_WINDOW_MS после скрытия
  let hiddenAt = -Infinity;
  let resumeArmed = false;
  let lastPause = null;
  const nativePlay = HTMLMediaElement.prototype.play;
  window.addEventListener('visibilitychange', () => {
    const nativeVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let reallyHidden = false;
    if (nativeVisibilityState && nativeVisibilityState.get) {
      reallyHidden = nativeVisibilityState.get.call(document) !== 'visible';
    } else {
      reallyHidden = document.hidden === true || document.visibilityState === 'hidden';
    }
    if (!reallyHidden) {
      resumeArmed = false;
      return;
    }
    hiddenAt = Date.now();
    resumeArmed = true;
    if (lastPause && hiddenAt - lastPause.at < RESUME_WINDOW_MS) {
      const media = lastPause.media;
      if (media && typeof nativePlay.call === 'function') {
        resumeArmed = false;
        setTimeout(() => {
          nativePlay.call(media).catch(() => {});
        }, 300);
      }
    }
  }, true);

  document.addEventListener('pause', (event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || media.ended) return;
    lastPause = { media, at: Date.now() };
    const nativeVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let reallyHidden = false;
    if (nativeVisibilityState && nativeVisibilityState.get) {
      reallyHidden = nativeVisibilityState.get.call(document) !== 'visible';
    } else {
      reallyHidden = document.hidden === true || document.visibilityState === 'hidden';
    }
    if (reallyHidden && hiddenAt > 0 && Date.now() - hiddenAt < RESUME_WINDOW_MS) {
      resumeArmed = false;
      setTimeout(() => {
        nativePlay.call(media).catch(() => {});
      }, 300);
    }
  }, true);

  // T7: запрет disablePictureInPicture остаётся false; удалять атрибут с элементов
  if (window.HTMLVideoElement) {
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'disablePictureInPicture');
      if (desc && desc.set) {
        Object.defineProperty(HTMLVideoElement.prototype, 'disablePictureInPicture', {
          configurable: true,
          get: desc.get,
          set(value) {
            desc.set.call(this, false);
          },
        });
      }
    } catch (e) { /* ignore */ }

    const strip = (root) => {
      if (!root || !root.querySelectorAll) return;
      for (const video of root.querySelectorAll('video[disablepictureinpicture]')) {
        video.removeAttribute('disablepictureinpicture');
      }
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.hasAttribute('disablepictureinpicture')) {
          record.target.removeAttribute('disablepictureinpicture');
        }
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('video[disablepictureinpicture]')) {
            node.removeAttribute('disablepictureinpicture');
          }
          strip(node);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disablepictureinpicture'] });
    strip(document);
  }

  // T8: pause разрешён только в пределах GESTURE_WINDOW_MS от пользовательского жеста
  let lastGesture = -Infinity;
  for (const type of ['pointerdown', 'touchstart', 'keydown', 'click']) {
    window.addEventListener(type, (event) => {
      if (event.isTrusted) lastGesture = Date.now();
    }, true);
  }
  const nativePause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    const nativeVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    let reallyHidden = false;
    if (nativeVisibilityState && nativeVisibilityState.get) {
      reallyHidden = nativeVisibilityState.get.call(document) !== 'visible';
    } else {
      reallyHidden = document.hidden === true || document.visibilityState === 'hidden';
    }
    if (!reallyHidden || Date.now() - lastGesture < GESTURE_WINDOW_MS) {
      return nativePause.call(this);
    }
  };

  if (navigator.mediaSession) {
    const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      return setActionHandler(action, handler && (action === 'pause' || action === 'stop')
        ? (...args) => {
            lastGesture = Date.now();
            return handler(...args);
          }
        : handler);
    };
  }
}
