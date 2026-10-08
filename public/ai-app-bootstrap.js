(() => {
  'use strict';

  const CHANNEL = 'ai-canvas-app-v1';
  const JSON_LIMIT = 64 * 1024;
  const INPUTS_LIMIT = 192 * 1024;
  const IMAGE_LIMIT = 3 * 1024 * 1024;
  const HTML_LIMIT = 64 * 1024;
  const CSS_LIMIT = 32 * 1024;
  const CODE_LIMIT = 64 * 1024;
  const root = document.getElementById('root');
  const style = document.getElementById('app-style');
  const sessionId = window.location.hash.slice(1);
  const eventTypes = ['click', 'input', 'change', 'submit'];
  const allowedTags = new Set(('a abbr article aside b blockquote br button caption circle code col colgroup dd defs details div dl dt ellipse em fieldset figcaption figure footer form g h1 h2 h3 h4 h5 h6 header hr i img input label legend li line main mark meter nav ol optgroup option p path polygon polyline pre progress rect section select small span strong sub summary sup svg table tbody td textarea th thead time title tr ul').split(' '));
  const allowedAttributes = new Set(('id class title role style name value type checked disabled readonly required multiple selected placeholder min max step maxlength rows cols for tabindex width height alt src open colspan rowspan scope datetime viewbox d fill stroke stroke-width stroke-linecap stroke-linejoin cx cy r rx ry x y x1 x2 y1 y2 points transform opacity preserveaspectratio').split(' '));
  let worker = null;
  let workerUrl = null;
  let startupTimer = null;
  let watchdogTimer = null;
  let watchdogId = null;
  let initialized = false;
  let actions = new Set();
  const executions = new Map();
  const resources = new Set();
  const uiHandlers = new Set();
  let workerRate = { start: 0, count: 0 };
  let eventRate = { start: 0, count: 0 };

  function json(value, maxBytes = JSON_LIMIT) {
    let count = 0;
    function visit(item, depth) {
      if (++count > 4096 || depth > 8) throw new Error('数据结构过大');
      if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (!item || typeof item !== 'object') throw new Error('只支持 JSON 数据');
      if (Array.isArray(item)) {
        if (item.length > 512) throw new Error('数组过大');
        for (const entry of item) visit(entry, depth + 1);
      } else {
        const keys = Object.keys(item);
        const prototype = Object.getPrototypeOf(item);
        if (keys.length > 128 || (prototype !== null && Object.getPrototypeOf(prototype) !== null)) throw new Error('对象无效');
        for (const key of keys) {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('对象键无效');
          visit(item[key], depth + 1);
        }
      }
    }
    visit(value, 0);
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new Error('数据超过大小限制');
    return JSON.parse(serialized);
  }

  function text(value, maxBytes) {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > maxBytes) throw new Error('文本超过大小限制');
    return value;
  }

  function validId(value) {
    return typeof value === 'string' && /^[a-zA-Z][\w:-]{0,79}$/.test(value);
  }

  function validRequestId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  }

  function imageSource(value) {
    if (typeof value !== 'string' || value.length > IMAGE_LIMIT) return false;
    const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2].length % 4 !== 0) return false;
    try {
      const header = atob(match[2].slice(0, 32));
      return (match[1] === 'png' && header.startsWith('\x89PNG\r\n\x1a\n'))
        || (match[1] === 'jpeg' && header.startsWith('\xff\xd8\xff'))
        || (match[1] === 'gif' && /^GIF8[79]a/.test(header))
        || (match[1] === 'webp' && header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP');
    } catch {
      return false;
    }
  }

  function css(value) {
    text(value, CSS_LIMIT);
    const normalized = value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd)).replace(/\\(.)/g, '$1');
    if (/(?:url\s*\(|@import|@font-face|image-set\s*\(|expression\s*\(|behavior\s*:|-moz-binding)/i.test(normalized)) throw new Error('样式不允许加载资源或执行代码');
    return value;
  }

  function sanitizeTree(container) {
    let count = 0;
    const ids = new Set();
    function visit(parent, depth) {
      if (depth > 24) throw new Error('界面嵌套过深');
      for (const node of [...parent.childNodes]) {
        if (++count > 1500) throw new Error('界面元素过多');
        if (node.nodeType === 3) continue;
        if (node.nodeType !== 1 || !allowedTags.has(node.localName.toLowerCase())) {
          node.remove();
          continue;
        }
        for (const attribute of [...node.attributes]) {
          const name = attribute.name.toLowerCase();
          const value = attribute.value;
          if ((!allowedAttributes.has(name) && !/^aria-[a-z-]+$/.test(name))
            || value.length > 10_000 || /^on/i.test(name)
            || (name === 'id' && (!validId(value) || ids.has(value)))
            || (name === 'src' && (node.localName !== 'img' || !imageSource(value)))
            || (name === 'type' && node.localName === 'input' && !/^(?:text|number|range|checkbox|radio|date|datetime-local|time|month|week|email|tel|search|password|color|hidden)$/.test(value))
            || (['fill', 'stroke'].includes(name) && /(?:url|[\\<>])/i.test(value))) {
            node.removeAttribute(attribute.name);
            continue;
          }
          if (name === 'id') ids.add(value);
          if (name === 'style') {
            try { css(value); } catch { node.removeAttribute(attribute.name); }
          }
        }
        visit(node, depth + 1);
      }
    }
    visit(container, 0);
    return container;
  }

  function render(value) {
    text(value, HTML_LIMIT);
    const template = document.createElement('template');
    template.innerHTML = value;
    root.replaceChildren(sanitizeTree(template.content));
  }

  function setImage(id, dataUrl) {
    if (!validId(id) || !imageSource(dataUrl)) throw new Error('图片预览无效');
    const element = root.querySelector(`img[id="${id}"]`);
    if (!element) throw new Error('图片预览目标不存在');
    element.setAttribute('src', dataUrl);
  }

  function send(kind, payload = {}) {
    window.parent.postMessage({ channel: CHANNEL, sessionId, kind, ...payload }, '*');
  }

  function stop(message) {
    if (worker) worker.terminate();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    worker = null;
    workerUrl = null;
    initialized = false;
    clearTimeout(startupTimer);
    clearTimeout(watchdogTimer);
    watchdogId = null;
    resources.clear();
    uiHandlers.clear();
    for (const [requestId, timer] of executions) {
      clearTimeout(timer);
      if (message) send('error', { requestId, message });
    }
    executions.clear();
    if (message) send('error', { message });
  }

  function rate(bucket, limit) {
    const now = Date.now();
    if (now - bucket.start >= 1000) { bucket.start = now; bucket.count = 0; }
    if (++bucket.count > limit) throw new Error('操作过于频繁');
  }

  function watch() {
    if (!worker) return;
    watchdogId = crypto.randomUUID();
    worker.postMessage({ kind: 'ping', id: watchdogId });
    watchdogTimer = setTimeout(() => stop('应用长时间无响应，已停止'), 2500);
  }

  function execute(message) {
    if (!initialized || !worker) throw new Error('应用尚未就绪');
    if (!validRequestId(message.requestId) || executions.size) throw new Error('应用正在执行其他操作');
    const timer = setTimeout(() => stop('应用操作超时，已停止'), 10_000);
    executions.set(message.requestId, timer);
    send('executing', { requestId: message.requestId, actionId: message.actionId ?? null });
    worker.postMessage(message);
  }

  function workerMain(initial, initialize) {
    'use strict';
    const post = self.postMessage.bind(self);
    const listen = self.addEventListener.bind(self);
    const timer = self.setTimeout.bind(self);
    const clear = self.clearTimeout.bind(self);
    const registered = new Map();
    const listeners = new Map();
    const pending = new Map();
    let currentState = initial.state;
    let busy = false;
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const emit = (kind, payload = {}) => post({ kind, ...payload });
    const app = Object.freeze({
      get inputs() { return copy(initial.inputs); },
      registerAction(id, handler) {
        if (!initial.actions.includes(id) || registered.has(id) || typeof handler !== 'function') throw new Error('动作与声明不匹配');
        registered.set(id, handler);
      },
      async runAction(id, input = {}) {
        const handler = registered.get(id);
        if (!handler) throw new Error('动作未注册');
        return handler(copy(input), app);
      },
      state: Object.freeze({
        get: () => copy(currentState),
        set(value) { currentState = copy(value); emit('state', { value: currentState }); },
      }),
      ui: Object.freeze({
        render: (html) => emit('render', { html }),
        setCss: (css) => emit('css', { css }),
        setImage: (id, dataUrl) => emit('image', { id, dataUrl }),
        on(type, id, handler) {
          if (!['click', 'input', 'change', 'submit'].includes(type) || !/^[a-zA-Z][\w:-]{0,79}$/.test(id) || typeof handler !== 'function' || (listeners.size >= 100 && !listeners.has(`${type}:${id}`))) throw new Error('界面事件无效');
          listeners.set(`${type}:${id}`, handler);
          emit('listen', { type, id });
        },
      }),
      resources: Object.freeze({
        list: () => copy(initial.inputs),
        readImage(nodeId) {
          if (typeof nodeId !== 'string' || !initial.inputs.some((item) => item.nodeId === nodeId) || pending.size >= 8) return Promise.reject(new Error('图片不在已绑定资源中'));
          const requestId = `r${crypto.randomUUID()}`;
          return new Promise((resolve, reject) => {
            const timeout = timer(() => { pending.delete(requestId); reject(new Error('图片读取超时')); }, 5000);
            pending.set(requestId, { resolve, reject, timeout });
            emit('resource-request', { requestId, nodeId });
          });
        },
      }),
    });
    listen('message', async ({ data }) => {
      if (!data || typeof data !== 'object') return;
      if (data.kind === 'ping') { emit('pong', { id: data.id }); return; }
      if (data.kind === 'resource-response') {
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId);
        clear(entry.timeout);
        if (data.ok) entry.resolve(data.value);
        else entry.reject(new Error(data.message || '图片读取失败'));
        return;
      }
      if (!['run', 'event'].includes(data.kind)) return;
      if (busy) { emit('error', { requestId: data.requestId, message: '应用正在执行其他操作' }); return; }
      busy = true;
      try {
        const handler = data.kind === 'run' ? registered.get(data.actionId) : listeners.get(`${data.type}:${data.elementId}`);
        if (data.kind === 'run' && !handler) throw new Error('动作未注册');
        const value = handler ? await handler(data.kind === 'run' ? data.input : data.event, app) : null;
        emit('result', { requestId: data.requestId, value: value === undefined ? null : value });
      } catch {
        emit('error', { requestId: data.requestId, message: '应用操作失败，请检查动作代码' });
      } finally {
        busy = false;
      }
    });
    // 生成代码只需要 SDK；网络、存储和额外 Worker 都不开放。
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'indexedDB', 'caches', 'navigator', 'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent']) {
      for (let target = self; target; target = Object.getPrototypeOf(target)) {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (target === self || descriptor?.configurable) {
          try { Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false }); } catch { /* CSP 仍会拒绝网络和脚本加载。 */ }
        }
      }
    }
    Promise.resolve().then(() => initialize(app)).then(() => {
      if (registered.size !== initial.actions.length) throw new Error('存在未注册动作');
      emit('initialized');
    }).catch(() => emit('error', { message: '应用初始化失败，请检查代码和动作声明' }));
  }

  function makeWorkerSource(definition, state, inputs) {
    const initial = JSON.stringify({ state, inputs, actions: definition.actions.map((action) => action.id) });
    return `(${workerMain.toString()})(${initial}, async function(app) {\n'use strict';\n${definition.code}\n});`;
  }

  function handleWorkerMessage(data) {
    if (!data || typeof data !== 'object') return;
    rate(workerRate, 120);
    switch (data.kind) {
      case 'initialized':
        if (initialized) throw new Error('重复初始化');
        initialized = true;
        clearTimeout(startupTimer);
        send('initialized');
        watch();
        break;
      case 'pong':
        if (!watchdogId || data.id !== watchdogId) return;
        clearTimeout(watchdogTimer);
        watchdogId = null;
        watchdogTimer = setTimeout(watch, 1000);
        break;
      case 'render': render(data.html); break;
      case 'css': style.textContent = css(data.css); break;
      case 'image': setImage(data.id, data.dataUrl); break;
      case 'state': send('state', { value: json(data.value) }); break;
      case 'listen':
        if (!eventTypes.includes(data.type) || !validId(data.id) || (uiHandlers.size >= 100 && !uiHandlers.has(`${data.type}:${data.id}`))) throw new Error('界面事件无效');
        uiHandlers.add(`${data.type}:${data.id}`);
        break;
      case 'resource-request':
        if (!validRequestId(data.requestId) || typeof data.nodeId !== 'string' || data.nodeId.length > 128 || resources.size >= 8 || resources.has(data.requestId)) throw new Error('资源请求无效');
        resources.add(data.requestId);
        send('resource-request', { requestId: data.requestId, nodeId: data.nodeId });
        break;
      case 'result':
      case 'error': {
        if (data.kind === 'error' && !data.requestId) { stop('应用运行失败，请检查代码'); break; }
        if (!executions.has(data.requestId)) return;
        const value = data.kind === 'result' ? json(data.value) : null;
        clearTimeout(executions.get(data.requestId));
        executions.delete(data.requestId);
        if (data.kind === 'result') send('result', { requestId: data.requestId, value });
        else send('error', { requestId: data.requestId, message: '应用操作失败，请检查动作代码' });
        break;
      }
      default: throw new Error('应用发送了未授权消息');
    }
  }

  function start(data) {
    if (worker) throw new Error('应用已初始化');
    const definition = data.definition;
    if (!definition || !Array.isArray(definition.actions) || definition.actions.length > 12 || !definition.actions.length) throw new Error('应用定义无效');
    text(definition.html, HTML_LIMIT);
    text(definition.css, CSS_LIMIT);
    text(definition.code, CODE_LIMIT);
    if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > 128 * 1024) throw new Error('应用定义过大');
    actions = new Set(definition.actions.map((action) => action.id));
    if (actions.size !== definition.actions.length || [...actions].some((id) => !validId(id))) throw new Error('动作声明无效');
    const state = json(data.state);
    const inputs = json(data.inputs, INPUTS_LIMIT);
    if (!Array.isArray(inputs) || inputs.length > 50) throw new Error('绑定资源过多');
    render(definition.html);
    style.textContent = css(definition.css);
    workerRate = { start: Date.now(), count: 0 };
    workerUrl = URL.createObjectURL(new Blob([makeWorkerSource(definition, state, inputs)], { type: 'text/javascript' }));
    const instance = new Worker(workerUrl);
    worker = instance;
    instance.addEventListener('message', ({ data: message }) => {
      if (worker !== instance) return;
      try { handleWorkerMessage(message); } catch { stop('应用消息无效，已停止'); }
    });
    instance.addEventListener('error', (event) => {
      event.preventDefault();
      if (worker === instance) stop('应用代码执行失败');
    });
    startupTimer = setTimeout(() => stop('应用初始化超时，已停止'), 5000);
  }

  function handleParentMessage(event) {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.sessionId !== sessionId) return;
    try {
      switch (data.kind) {
        case 'init': start(data); break;
        case 'run':
          if (!actions.has(data.actionId)) throw new Error('动作未声明');
          execute({ kind: 'run', requestId: data.requestId, actionId: data.actionId, input: json(data.input) });
          break;
        case 'resource-response':
          if (!resources.delete(data.requestId) || !worker) return;
          if (data.ok && !imageSource(data.value)) throw new Error('图片资源格式无效');
          worker.postMessage({ kind: 'resource-response', requestId: data.requestId, ok: data.ok === true, value: data.ok ? data.value : null, message: '图片资源不可用' });
          break;
        case 'cancel': stop(); break;
        case 'theme':
          if (!['dark', 'light'].includes(data.theme)) return;
          document.documentElement.setAttribute('data-theme', data.theme);
          if (data.variables && typeof data.variables === 'object') {
            for (const [name, value] of Object.entries(data.variables).slice(0, 64)) {
              if (/^--canvas-[a-z-]{1,60}$/.test(name) && typeof value === 'string' && value.length <= 128 && !/[;{}\\]/.test(value)) document.documentElement.style.setProperty(name, css(value));
            }
          }
          break;
      }
    } catch {
      if (validRequestId(data.requestId)) send('error', { requestId: data.requestId, message: '应用请求无效' });
      else stop('应用请求无效');
    }
  }

  function handleUiEvent(event) {
    if (event.type === 'submit' || event.target?.closest('a')) event.preventDefault();
    if (!worker || !initialized || executions.size) return;
    let element = event.target;
    while (element && element !== root && !uiHandlers.has(`${event.type}:${element.id}`)) element = element.parentElement;
    if (!element || element === root) return;
    try {
      rate(eventRate, 30);
      const values = Object.create(null);
      if (event.type === 'submit') {
        for (const control of [...element.querySelectorAll('input,select,textarea')].slice(0, 128)) {
          const key = control.name || control.id;
          if (validId(key) && !['constructor', 'prototype', '__proto__'].includes(key)) values[key] = control.type === 'checkbox' ? control.checked : control.value;
        }
      }
      execute({ kind: 'event', requestId: `e${crypto.randomUUID()}`, type: event.type, elementId: element.id, event: json({ value: String(event.target.value ?? '').slice(0, 10_000), checked: !!event.target.checked, values }) });
    } catch { stop('界面操作无效，已停止'); }
  }

  function boot() {
    let parentAccessible = true;
    try { void window.parent.document; } catch { parentAccessible = false; }
    if (!root || !style || !/^[\w-]{16,100}$/.test(sessionId) || window.parent === window || window.origin !== 'null' || parentAccessible) return;
    // 第一方启动链到这里就结束使命；先禁用后续脚本，再接收 AI 内容和启动 Worker。
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "script-src 'none'; worker-src blob:";
    document.head.appendChild(policy);
    window.addEventListener('message', handleParentMessage);
    window.addEventListener('pagehide', () => stop(), { once: true });
    for (const type of eventTypes) root.addEventListener(type, handleUiEvent);
    send('ready');
  }

  boot();
})();
