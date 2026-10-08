import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bootstrap = readFileSync(new URL('../../public/ai-app-bootstrap.js', import.meta.url), 'utf8');
const hostHtml = readFileSync(new URL('../../public/ai-app-host.html', import.meta.url), 'utf8');
const channel = 'ai-canvas-app-v1';
const sessionId = 'session_12345678901234567890';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function pngWithMetadata() {
  const image = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
  const content = Buffer.from(`Comment\0${'x'.repeat(80_000)}`);
  const body = Buffer.concat([Buffer.from('tEXt'), content]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(content.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return `data:image/png;base64,${Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)]).toString('base64')}`;
}

interface SandboxDefinition {
  html: string;
  css: string;
  code: string;
  actions: Array<{ id: string; title: string }>;
}

interface TreeNode {
  nodeType: number;
  localName: string;
  attributes: Array<{ name: string; value: string }>;
  childNodes: TreeNode[];
  remove: () => void;
  removeAttribute: (name: string) => void;
}

function tree(localName: string, attributes: Record<string, string> = {}, childNodes: TreeNode[] = []): TreeNode {
  const result: TreeNode = {
    nodeType: 1,
    localName,
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    childNodes,
    remove: () => undefined,
    removeAttribute(name) { result.attributes = result.attributes.filter((attribute) => attribute.name !== name); },
  };
  for (const child of childNodes) child.remove = () => { result.childNodes = result.childNodes.filter((node) => node !== child); };
  return result;
}

function harness() {
  const outgoing: Array<Record<string, unknown>> = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  const parent = { postMessage: (data: Record<string, unknown>) => outgoing.push(data) };
  const elements = new Map<string, { localName: string; setAttribute: ReturnType<typeof vi.fn> }>();
  const root = {
    replaceChildren: vi.fn(), addEventListener: vi.fn(),
    querySelector: (selector: string) => {
      const element = elements.get(/^img\[id="([^"]+)"\]$/.exec(selector)?.[1] ?? '');
      return element?.localName === 'img' ? element : null;
    },
  };
  const style = { textContent: '' };
  class TestWorker {
    static latest: TestWorker;
    readonly listeners = new Map<string, (event: { data: unknown; preventDefault: () => void }) => void>();
    readonly messages: Array<Record<string, unknown>> = [];
    readonly terminate = vi.fn();
    constructor() { TestWorker.latest = this; }
    addEventListener(type: string, handler: (event: { data: unknown; preventDefault: () => void }) => void) { this.listeners.set(type, handler); }
    postMessage(data: Record<string, unknown>) { this.messages.push(data); }
    emit(data: unknown) { this.listeners.get('message')?.({ data, preventDefault: () => undefined }); }
  }
  const context = {
    window: { parent, location: { hash: `#${sessionId}` }, origin: 'null', addEventListener: vi.fn() },
    document: {
      getElementById: (id: string) => id === 'root' ? root : style,
      createElement: () => ({ content: tree('template'), innerHTML: '' }),
      documentElement: { setAttribute: vi.fn(), style: { setProperty: vi.fn() } },
    },
    Object,
    TextEncoder,
    Blob,
    URL: { createObjectURL: () => 'blob:isolated-test', revokeObjectURL: vi.fn() },
    Worker: TestWorker,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' },
    atob,
    setTimeout: (callback: () => void, ms: number) => { timers.set(++timerId, { callback, ms }); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
    __sandbox: undefined as unknown,
  };
  vm.runInNewContext(bootstrap.replace('  boot();', '  globalThis.__sandbox = { json, imageSource, css, sanitizeTree, makeWorkerSource, handleParentMessage, handleUiEvent };'), context);
  const api = context.__sandbox as {
    json: (value: unknown, limit?: number) => unknown;
    imageSource: (value: unknown) => boolean;
    css: (value: string) => string;
    sanitizeTree: (value: TreeNode) => TreeNode;
    makeWorkerSource: (definition: SandboxDefinition, state: unknown, inputs: unknown[]) => string;
    handleParentMessage: (event: { source: unknown; data: Record<string, unknown> }) => void;
    handleUiEvent: (event: { type: string; target: unknown; preventDefault: () => void }) => void;
  };
  const send = (data: Record<string, unknown>, source: unknown = parent) => api.handleParentMessage({ source, data: { channel, sessionId, ...data } });
  return { api, outgoing, send, timers, elements, worker: () => TestWorker.latest, parent };
}

const definition: SandboxDefinition = {
  html: '<button id="scan">检查</button>',
  css: 'button { padding: 8px; }',
  code: 'app.registerAction("scan", (input, app) => ({ count: app.inputs.length, input }));',
  actions: [{ id: 'scan', title: '检查' }],
};

describe('AI app isolated host', () => {
  it('keeps generated scripts out of the DOM and narrows the inherited policy', () => {
    const loader = /<script nonce="__TAURI_SCRIPT_NONCE__">([\s\S]*?)<\/script>/.exec(hostHtml)?.[1];
    expect(loader).toBeTruthy();
    // 改 loader 时按实际源码重算哈希，测试会提醒同步宿主页里的 CSP。
    const hash = createHash('sha256').update(loader ?? '').digest('base64');
    expect(hostHtml).toContain(`script-src 'sha256-${hash}' 'nonce-__TAURI_SCRIPT_NONCE__'`);
    expect(hostHtml.match(/__TAURI_SCRIPT_NONCE__/g)).toHaveLength(2);
    expect(loader).not.toContain('__TAURI_SCRIPT_NONCE__');
    expect(hostHtml.match(/<script\b/g)).toHaveLength(1);
    expect(hostHtml).not.toMatch(/script-src[^;]*(?:'self'|http:|https:|blob:)/);
    expect(hostHtml).toContain("connect-src 'none'");
    expect(hostHtml).toContain('worker-src blob:');
    expect(hostHtml).toContain("form-action 'none'");
    expect(hostHtml).not.toMatch(/unsafe-eval|'strict-dynamic'|script-src[^;]*unsafe-inline/);
    expect(bootstrap).not.toMatch(/\beval\s*\(|new Function\s*\(|createElement\(['"]script/);
    expect(bootstrap).toContain("window.origin !== 'null'");
    expect(bootstrap).toContain('event.source !== window.parent');
    expect(bootstrap).toContain('policy.content = "script-src \'none\'; worker-src blob:"');
    expect(bootstrap.indexOf('document.head.appendChild(policy)')).toBeLessThan(bootstrap.indexOf("window.addEventListener('message', handleParentMessage)"));
  });

  it.each([false, true])('loads only the fixed bootstrap with the policy nonce when native values differ (packaged=%s)', (packaged) => {
    let index = 0;
    const html = packaged ? hostHtml.replace(/__TAURI_SCRIPT_NONCE__/g, () => `${++index}123456789`) : hostHtml;
    const loader = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/.exec(html);
    const policy = /<meta id="app-policy"[^>]+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const policyNonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    const element: Record<string, string> = {};
    const createElement = vi.fn(() => element);
    const appendChild = vi.fn();
    const getElementById = vi.fn(() => ({ content: policy }));
    vm.runInNewContext(loader?.[2] ?? '', { document: { currentScript: { nonce: loader?.[1] }, getElementById, createElement, head: { appendChild } } });
    expect(getElementById).toHaveBeenCalledExactlyOnceWith('app-policy');
    expect(createElement).toHaveBeenCalledExactlyOnceWith('script');
    expect(element).toEqual({ src: './ai-app-bootstrap.js', nonce: policyNonce });
    expect(appendChild).toHaveBeenCalledExactlyOnceWith(element);
    expect(policy).toContain(`'sha256-${createHash('sha256').update(loader?.[2] ?? '').digest('base64')}'`);
    if (packaged) expect(element.nonce).not.toBe(loader?.[1]);
    expect(loader?.[2]).not.toMatch(/innerHTML|textContent|location|parent|postMessage|eval|Function/);
  });

  it('rejects non-JSON, oversized, deeply nested and prototype-shaped values', () => {
    const { api } = harness();
    expect(api.json({ list: [1, '中文', false, null] })).toEqual({ list: [1, '中文', false, null] });
    expect(() => api.json({ bad: Number.NaN })).toThrow();
    expect(() => api.json({ bad: undefined })).toThrow();
    expect(() => api.json(JSON.parse('{"__proto__":{}}'))).toThrow();
    expect(() => api.json(new Date())).toThrow();
    expect(() => api.json('中文', 4)).toThrow();
    expect(() => api.json(Array(513).fill(0))).toThrow();
    expect(() => api.json({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } })).toThrow();
  });

  it('only admits bounded raster image data with matching headers', () => {
    const { api } = harness();
    expect(api.imageSource(png)).toBe(true);
    for (const value of ['https://example.com/a.png', 'blob:example', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`]) {
      expect(api.imageSource(value)).toBe(false);
    }
  });

  it('mounts raster previews above the HTML and attribute budgets through the controlled image bridge', () => {
    const h = harness();
    const dataUrl = pngWithMetadata();
    expect(dataUrl.length).toBeGreaterThan(64 * 1024);
    expect(h.api.imageSource(dataUrl)).toBe(true);
    const image = { localName: 'img', setAttribute: vi.fn() };
    h.send({ kind: 'init', definition: { ...definition, html: '<img id="preview" alt="素材预览">' }, state: {}, inputs: [] });
    h.elements.set('preview', image);
    h.worker().emit({ kind: 'image', id: 'preview', dataUrl });
    expect(image.setAttribute).toHaveBeenCalledWith('src', dataUrl);
    expect(h.worker().terminate).not.toHaveBeenCalled();
    expect(h.outgoing.some((message) => message.kind === 'image')).toBe(false);
  });

  it.each([
    { id: 'outside', localName: undefined, dataUrl: png },
    { id: 'preview', localName: 'div', dataUrl: png },
    { id: 'preview"]', localName: 'img', dataUrl: png },
    { id: 'preview', localName: 'img', dataUrl: 'https://example.com/image.png' },
    { id: 'preview', localName: 'img', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { id: 'preview', localName: 'img', dataUrl: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
  ])('rejects image bridge writes outside valid raster img targets ($id / $localName)', ({ id, localName, dataUrl }) => {
    const h = harness();
    h.send({ kind: 'init', definition, state: {}, inputs: [] });
    const target = { localName: localName ?? 'img', setAttribute: vi.fn() };
    if (localName) h.elements.set(id, target);
    h.worker().emit({ kind: 'image', id, dataUrl });
    expect(target.setAttribute).not.toHaveBeenCalled();
    expect(h.worker().terminate).toHaveBeenCalledOnce();
  });

  it('strips active tags, navigation, file pickers and executable attributes before mounting', () => {
    const { api } = harness();
    const button = tree('button', { id: 'scan', onclick: 'steal()', style: 'background: url(https://bad.test)' });
    const duplicate = tree('span', { id: 'scan' });
    const link = tree('a', { href: 'javascript:steal()', target: '_top' });
    const image = tree('img', { src: png, onerror: 'steal()', srcset: 'https://bad.test/a.png 2x' });
    const input = tree('input', { type: 'file', formaction: 'https://bad.test' });
    const svg = tree('svg', {}, [tree('foreignObject'), tree('path', { d: 'M0 0L1 1', fill: 'url(https://bad.test)' })]);
    const container = tree('template', {}, [tree('script'), tree('iframe'), button, duplicate, link, image, input, svg]);
    api.sanitizeTree(container);
    expect(container.childNodes.map((node) => node.localName)).toEqual(['button', 'span', 'a', 'img', 'input', 'svg']);
    expect(button.attributes).toEqual([{ name: 'id', value: 'scan' }]);
    expect(duplicate.attributes).toEqual([]);
    expect(link.attributes).toEqual([]);
    expect(image.attributes).toEqual([{ name: 'src', value: png }]);
    expect(input.attributes).toEqual([]);
    expect(svg.childNodes.map((node) => node.localName)).toEqual(['path']);
    expect(svg.childNodes[0].attributes).toEqual([{ name: 'd', value: 'M0 0L1 1' }]);
  });

  it('rejects CSS resource loading through comments and escaped identifiers', () => {
    const { api } = harness();
    expect(api.css('button { padding: 8px; color: var(--canvas-text); }')).toContain('padding');
    for (const value of ['@import "https://bad.test";', 'a{background:u\\72l(https://bad.test)}', 'a{background:u/**/rl(https://bad.test)}', 'a{behavior:foo}', '@font-face{font-family:test}']) expect(() => api.css(value)).toThrow();
  });

  it('binds parent messages, accepts UUID requests, and terminates a worker that forges host effects', () => {
    const h = harness();
    h.send({ kind: 'init', definition, state: {}, inputs: [] }, {});
    h.send({ kind: 'init', sessionId: 'wrong', definition, state: {}, inputs: [] });
    expect(h.worker()).toBeUndefined();
    h.send({ kind: 'init', definition, state: {}, inputs: [] });
    h.worker().emit({ kind: 'initialized' });
    h.send({ kind: 'run', requestId: '12345678-1234-4234-8234-123456789012', actionId: 'scan', input: {} });
    expect(h.worker().messages.at(-1)?.kind).toBe('run');
    h.worker().emit({ kind: 'effect', operation: 'write-file' });
    expect(h.worker().terminate).toHaveBeenCalledOnce();
    expect(h.outgoing.some((message) => message.kind === 'effect')).toBe(false);
    expect(h.outgoing.some((message) => message.kind === 'error')).toBe(true);
  });

  it('stops an unresponsive startup and an unresponsive initialized worker', () => {
    const startup = harness();
    startup.send({ kind: 'init', definition, state: {}, inputs: [] });
    [...startup.timers.values()].find((timer) => timer.ms === 5000)?.callback();
    expect(startup.worker().terminate).toHaveBeenCalledOnce();
    const running = harness();
    running.send({ kind: 'init', definition, state: {}, inputs: [] });
    running.worker().emit({ kind: 'initialized' });
    [...running.timers.values()].find((timer) => timer.ms === 2500)?.callback();
    expect(running.worker().terminate).toHaveBeenCalledOnce();
  });

  it('announces UI execution before forwarding events and ignores late messages after cancellation', () => {
    const h = harness();
    h.send({ kind: 'init', definition, state: {}, inputs: [] });
    const oldWorker = h.worker();
    oldWorker.emit({ kind: 'listen', type: 'click', id: 'scan' });
    oldWorker.emit({ kind: 'initialized' });
    const button = { id: 'scan', value: '', checked: false, parentElement: null, closest: () => null };
    const icon = { id: 'icon', parentElement: button, closest: () => null };
    h.api.handleUiEvent({ type: 'click', target: icon, preventDefault: () => undefined });
    expect(h.outgoing.at(-1)).toMatchObject({ kind: 'executing', actionId: null, requestId: expect.stringMatching(/^e/) });
    expect(oldWorker.messages.at(-1)).toMatchObject({ kind: 'event', elementId: 'scan' });
    h.send({ kind: 'cancel' });
    const count = h.outgoing.length;
    oldWorker.emit({ kind: 'state', value: { stale: true } });
    oldWorker.emit({ kind: 'initialized' });
    expect(h.outgoing).toHaveLength(count);
  });

  it('rejects undeclared actions and malformed resource responses without forwarding them', () => {
    const h = harness();
    h.send({ kind: 'init', definition, state: {}, inputs: [] });
    h.worker().emit({ kind: 'initialized' });
    h.send({ kind: 'run', requestId: 'run-1', actionId: 'not-declared', input: {} });
    expect(h.worker().messages.some((message) => message.kind === 'run')).toBe(false);
    h.worker().emit({ kind: 'resource-request', requestId: 'resource-1', nodeId: 'bound-node' });
    h.send({ kind: 'resource-response', requestId: 'resource-1', ok: true, value: 'data:image/svg+xml;base64,PHN2Zz4=' });
    expect(h.worker().messages.some((message) => message.kind === 'resource-response')).toBe(false);
  });

  it('runs registered actions in the worker, clones state and disables ambient capabilities', async () => {
    const { api } = harness();
    const outgoing: Array<Record<string, unknown>> = [];
    let receive: (event: { data: Record<string, unknown> }) => Promise<void> = async () => undefined;
    const scope: Record<string, unknown> = {
      postMessage: (message: Record<string, unknown>) => outgoing.push(message),
      addEventListener: (_type: string, listener: typeof receive) => { receive = listener; },
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => 'test-resource' },
      Worker: () => { throw new Error('must not construct'); },
      fetch: () => { throw new Error('must not fetch'); },
    };
    scope.self = scope;
    const source = api.makeWorkerSource({ ...definition, code: 'app.registerAction("scan", async (input, app) => { const state = app.state.get(); state.count += 1; app.state.set(state); return { count: app.inputs.length, state, input, network: typeof fetch, childWorker: typeof Worker }; });' }, { count: 0 }, [{ nodeId: 'image-1' }]);
    vm.runInNewContext(source, scope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outgoing).toContainEqual({ kind: 'initialized' });
    await receive({ data: { kind: 'run', requestId: 'run-1', actionId: 'scan', input: { selected: true } } });
    expect(outgoing).toContainEqual({ kind: 'state', value: { count: 1 } });
    expect(outgoing).toContainEqual({ kind: 'result', requestId: 'run-1', value: { count: 1, state: { count: 1 }, input: { selected: true }, network: 'undefined', childWorker: 'undefined' } });
  });

  it('lets UI handlers reuse declared actions and returns their result without a visible page', async () => {
    const { api } = harness();
    const outgoing: Array<Record<string, unknown>> = [];
    let receive: (event: { data: Record<string, unknown> }) => Promise<void> = async () => undefined;
    const scope: Record<string, unknown> = {
      postMessage: (message: Record<string, unknown>) => outgoing.push(message),
      addEventListener: (_type: string, listener: typeof receive) => { receive = listener; },
      setTimeout,
      clearTimeout,
      crypto: { randomUUID: () => 'test-resource' },
    };
    scope.self = scope;
    vm.runInNewContext(api.makeWorkerSource({ ...definition, code: `app.registerAction("scan", (input) => ({ selected: input.value })); app.ui.setImage("preview", ${JSON.stringify(png)}); app.ui.on("click", "scan", (event) => app.runAction("scan", event));` }, {}, []), scope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outgoing).toContainEqual({ kind: 'listen', type: 'click', id: 'scan' });
    expect(outgoing).toContainEqual({ kind: 'image', id: 'preview', dataUrl: png });
    await receive({ data: { kind: 'event', requestId: 'event-1', type: 'click', elementId: 'scan', event: { value: 'picked' } } });
    expect(outgoing).toContainEqual({ kind: 'result', requestId: 'event-1', value: { selected: 'picked' } });
  });
});
