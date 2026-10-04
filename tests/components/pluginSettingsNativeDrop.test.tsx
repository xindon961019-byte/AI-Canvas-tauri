import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/store/useAppStore';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import { PhysicalPosition } from '@tauri-apps/api/dpi';

type ElementLike = { props: Record<string, unknown> & { children?: unknown } };
type NativeCallback = (event: { payload: DragDropEvent }) => Promise<void> | void;

function findZone(root: unknown): ElementLike | undefined {
  if (Array.isArray(root)) return root.map(findZone).find(Boolean);
  if (!root || typeof root !== 'object' || !('props' in root)) return undefined;
  const el = root as ElementLike;
  return String(el.props.className).includes('ui-dropzone') ? el : findZone(el.props.children);
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.doUnmock('react'); });

async function setup(options: { tauri?: boolean; delayedRegistration?: boolean; registrationError?: boolean } = {}) {
  const slots: unknown[] = [];
  let cursor = 0;
  let effects: Array<() => void | (() => void)> = [];
  vi.doMock('react', async () => ({
    ...await vi.importActual<typeof import('react')>('react'),
    useCallback: <T,>(callback: T) => callback,
    useMemo: <T,>(factory: () => T) => factory(),
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
    useRef: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState: <T,>(initial: T) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: T | ((previous: T) => T)) => {
        slots[index] = typeof next === 'function' ? (next as (previous: T) => T)(slots[index] as T) : next;
      }];
    },
  }));
  vi.doMock('framer-motion', () => ({ motion: { div: 'div' } }));
  vi.doMock('../../src/components/chat/ChatMarkdown', () => ({ default: () => null }));
  vi.doMock('../../src/components/shared/ModalOverlay', () => ({ default: () => null }));
  const toast = vi.fn();
  const install = vi.fn().mockResolvedValue(undefined);
  const paste = vi.fn();
  const store = {
    installedPlugins: [], installPluginBundle: install, showToast: toast,
    pasteExternalFromDataTransfer: paste,
  } as unknown as AppState;
  vi.doMock('../../src/store/useAppStore', () => ({
    useAppStore: Object.assign(<T,>(selector: (state: AppState) => T) => selector(store), { getState: () => store }),
    generateId: () => 'test', computeImageNodeDimensions: vi.fn(),
  }));
  vi.doMock('@xyflow/react', () => ({ useReactFlow: () => ({ screenToFlowPosition: (point: unknown) => point }) }));
  vi.doMock('../../src/services/fileService', () => ({
    isTauriEnv: () => options.tauri !== false,
    saveBinaryToLocalFile: vi.fn(), readBinaryFile: vi.fn(), copyFileToProjectData: vi.fn(), arrayBufferToBase64: vi.fn(),
  }));
  const manifestText = JSON.stringify({
    apiVersion: 1, id: 'com.example.drag', name: '拖放插件', version: '1.0.0',
    category: 'utility', runtime: 'python', entry: 'main.py', permissions: ['node.read', 'node.write'],
    contributes: { nodeTools: [{
      id: 'test', title: '测试', placements: ['node-context-menu'], nodeTypes: ['ai-text'],
      inputFields: ['output'], output: { mode: 'update-current', fields: ['output'] },
    }] },
  });
  const readPackage = vi.fn().mockResolvedValue({
    manifestText, manifest: JSON.parse(manifestText), source: 'define_plugin({"tools": {}})', resourcePayloads: [],
  });
  vi.doMock('../../src/services/fs/pluginPackageFiles', () => ({ readLocalPluginPackage: readPackage, selectNativePluginDirectory: vi.fn() }));
  const confirm = vi.fn().mockResolvedValue(true);
  vi.doMock('../../src/services/confirmDialog', () => ({ confirmAction: confirm }));
  let callback: NativeCallback | undefined;
  let finishRegistration: ((release: () => void) => void) | undefined;
  const release = vi.fn();
  const subscribe = vi.fn(async (handler: NativeCallback) => {
    callback = handler;
    if (options.registrationError) throw new Error('native listener unavailable');
    if (options.delayedRegistration) return new Promise<() => void>((resolve) => { finishRegistration = resolve; });
    return release;
  });
  vi.doMock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: subscribe }) }));
  const globalListen = vi.fn().mockResolvedValue(vi.fn());
  vi.doMock('@tauri-apps/api/event', () => ({ listen: globalListen }));
  vi.stubGlobal('window', { devicePixelRatio: 2, setTimeout: vi.fn(), clearTimeout: vi.fn() });
  const { default: PluginSettings } = await import('../../src/components/settings/PluginSettings');
  const { isExternalDropCaptured } = await import('../../src/utils/dropCapture');
  const render = () => { cursor = 0; effects = []; return findZone(PluginSettings())!; };
  const zone = render();
  if (zone.props.ref) {
    (zone.props.ref as { current: unknown }).current = {
      getBoundingClientRect: () => ({ left: 100, right: 200, top: 100, bottom: 200 }),
    };
  }
  const cleanups = effects.map((effect) => effect());
  const { useNodeCreation: createNodes } = await import('../../src/hooks/useNodeCreation');
  const canvas = createNodes();
  const dispose = () => cleanups.forEach((cleanup) => cleanup?.());
  if (options.tauri !== false) await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  return {
    zone, render, readPackage, install, confirm, toast, release, subscribe, globalListen, canvas, paste, manifestText,
    isExternalDropCaptured, dispose,
    finishRegistration: () => finishRegistration?.(release),
    send: async (payload: DragDropEvent) => { await callback?.({ payload }); },
  };
}

const drop = (x = 300): DragDropEvent => ({ type: 'drop', paths: ['G:/plugins/example'], position: new PhysicalPosition(x, 300) });

it('receives a native folder drop at scaled coordinates and uses the existing reviewed installation chain', async () => {
  const h = await setup();
  try {
    await h.send({ type: 'enter', paths: ['G:/plugins/example'], position: new PhysicalPosition(300, 300) });
    expect(h.render().props.className).toContain('is-dragover');
    await h.send(drop());
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(h.readPackage).toHaveBeenCalledExactlyOnceWith(['G:/plugins/example'], true);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.render().props.className).not.toContain('is-dragover');
    expect(h.globalListen).not.toHaveBeenCalled();
    const readDuplicate = vi.fn().mockResolvedValue(h.manifestText);
    (h.zone.props.onDrop as (event: unknown) => void)({
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      dataTransfer: { items: [], files: [{ name: 'manifest.json', text: readDuplicate }] },
    });
    expect(readDuplicate).not.toHaveBeenCalled();
    expect(h.install).toHaveBeenCalledOnce();
  } finally { h.dispose(); }
});

it('clears native hover on leave and ignores drops outside the zone', async () => {
  const h = await setup();
  try {
    await h.send({ type: 'over', position: new PhysicalPosition(300, 300) });
    expect(h.render().props.className).toContain('is-dragover');
    await h.send({ type: 'leave' });
    expect(h.render().props.className).not.toContain('is-dragover');
    await h.send(drop(500));
    expect(h.readPackage).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('accepts only one native installation while reading or awaiting review', async () => {
  const h = await setup();
  let approve!: (value: boolean) => void;
  h.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { approve = resolve; }));
  try {
    const first = h.send(drop());
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    await h.send(drop());
    expect(h.readPackage).toHaveBeenCalledOnce();
    approve(false);
    await first;
    expect(h.install).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('blocks canvas browser drops while open and restores them after listener cleanup', async () => {
  const h = await setup();
  const event = {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { files: [{}] }, clientX: 150, clientY: 150,
  };
  try {
    expect(h.isExternalDropCaptured()).toBe(true);
    await h.canvas.onDrop(event as unknown as React.DragEvent);
    expect(h.paste).not.toHaveBeenCalled();
  } finally { h.dispose(); }
  expect(h.release).toHaveBeenCalledOnce();
  expect(h.isExternalDropCaptured()).toBe(false);
  await h.send(drop());
  expect(h.readPackage).not.toHaveBeenCalled();
  await h.canvas.onDrop(event as unknown as React.DragEvent);
  expect(h.paste).toHaveBeenCalledOnce();
});

it('releases registration that finishes after the panel closes', async () => {
  const h = await setup({ delayedRegistration: true });
  h.dispose();
  h.finishRegistration();
  await vi.waitFor(() => expect(h.release).toHaveBeenCalledOnce());
  await h.send(drop());
  expect(h.readPackage).not.toHaveBeenCalled();
  expect(h.isExternalDropCaptured()).toBe(false);
});

it('keeps browser drag-and-drop available without registering a native listener', async () => {
  const h = await setup({ tauri: false });
  const event = {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { items: [], files: [
      { name: 'manifest.json', text: async () => h.manifestText },
      { name: 'main.py', text: async () => 'define_plugin({"tools": {}})' },
    ] },
  };
  try {
    await (h.zone.props.onDrop as (event: unknown) => void)(event);
    await vi.waitFor(() => expect(h.install).toHaveBeenCalledOnce());
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(h.isExternalDropCaptured()).toBe(true);
  } finally { h.dispose(); }
});

it('reports native registration failure so the user can use the directory picker', async () => {
  const h = await setup({ registrationError: true });
  try {
    await vi.waitFor(() => expect(h.toast).toHaveBeenCalledWith('拖放接收不可用，请点击选择插件文件夹', 'error'));
    expect(h.readPackage).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('reports an invalid folder dropped inside the zone instead of silently ignoring it', async () => {
  const h = await setup();
  h.readPackage.mockRejectedValueOnce(new Error('所选文件夹根目录缺少 manifest.json，请选择插件根目录'));
  try {
    await h.send(drop());
    expect(h.toast).toHaveBeenCalledWith('所选文件夹根目录缺少 manifest.json，请选择插件根目录', 'error');
    expect(h.install).not.toHaveBeenCalled();
    expect(h.render().props.className).not.toContain('is-dragover');
  } finally { h.dispose(); }
});
