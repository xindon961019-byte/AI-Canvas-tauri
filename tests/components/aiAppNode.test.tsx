import { isValidElement, type ReactElement } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { AiAppReference, AiAppUiSnapshot } from '../../src/types/aiApp';

const hooks = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[],
  effects: [] as Array<() => void | (() => void)>,
}));
const mocks = vi.hoisted(() => ({
  create: vi.fn(), attach: vi.fn(), dispose: vi.fn(), run: vi.fn(), save: vi.fn(),
  cancel: vi.fn(), theme: vi.fn(), close: vi.fn(), state: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  memo: <T,>(component: T) => component,
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: <T,>(initial: T) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useState: <T,>(initial: T | (() => T)) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index], (next: T | ((current: T) => T)) => {
      hooks.values[index] = typeof next === 'function' ? (next as (current: T) => T)(hooks.values[index] as T) : next;
    }];
  },
}));
vi.mock('../../src/store/useAppStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state()),
}));
vi.mock('../../src/services/aiApps/aiAppRuntime', () => ({ createAiAppUiSession: mocks.create }));
vi.mock('../../src/i18n', () => ({
  useT: () => (text: string, vars?: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => String(vars?.[key] ?? match)),
}));

import AiAppNode from '../../src/components/nodes/AiAppNode';
import AiAppDialog from '../../src/components/nodes/AiAppDialog';
import PopupCloseButton from '../../src/components/shared/PopupCloseButton';

const app: AiAppReference = {
  version: 1,
  instanceId: 'instance-1',
  definition: { relativePath: `ai-apps/${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64), bytes: 512 },
  title: '分镜检查台',
  description: '检查画布里的分镜素材',
  revision: 1,
  actions: [{ id: 'scan', title: '检查素材', inputSchema: { type: 'object', properties: {} } }],
  inputNodeIds: ['node-source'],
  savedState: {},
  savedResult: '上次检查结果',
};
let cleanups: Array<() => void>;

function elements(root: unknown): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(root)) return [];
  return [root, ...elements(root.props.children)];
}
function text(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(text).join('');
  return isValidElement<{ children?: unknown }>(root) ? text(root.props.children) : '';
}
function renderDialog(definition: AiAppReference = app) {
  hooks.index = 0;
  hooks.effects = [];
  return AiAppDialog({ nodeId: 'app-node', app: definition, onClose: mocks.close });
}
function button(label: string) {
  const target = elements(renderDialog()).find((element) => element.type === 'button' && text(element) === label);
  expect(target, label).toBeDefined();
  return target!;
}
function click(label: string) {
  return (button(label).props.onClick as () => void | Promise<void>)();
}
async function mount() {
  renderDialog();
  const cleanup = hooks.effects[0]();
  if (cleanup) cleanups.push(cleanup);
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled());
  await vi.waitFor(() => expect(elements(renderDialog()).some((element) => element.type === 'iframe')).toBe(true));
}
function onChange(snapshot: AiAppUiSnapshot) {
  mocks.create.mock.calls.at(-1)![0].onChange(snapshot);
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.values = [];
  cleanups = [];
  mocks.state.mockReturnValue({ config: { theme: 'dark' } });
  mocks.create.mockResolvedValue({
    src: 'blob:http://localhost/app-session', attach: mocks.attach, dispose: mocks.dispose,
    run: mocks.run, save: mocks.save, cancel: mocks.cancel, updateTheme: mocks.theme,
  });
  mocks.run.mockResolvedValue({ missing: 2 });
  mocks.save.mockResolvedValue(undefined);
});
afterEach(() => { cleanups.forEach((cleanup) => cleanup()); });

describe('AI app node and dialog', () => {
  it.each([
    {}, { ...app, inputNodeIds: null }, { ...app, actions: null },
    { ...app, actions: [{ id: 'scan', title: '检查素材', inputSchema: { type: 'string' } }] },
    { ...app, definition: { ...app.definition, relativePath: '../../private.json' } },
  ])('keeps malformed restored app data from crashing the canvas %#', (restored) => {
    hooks.index = 0;
    const tree = AiAppNode({ id: 'app-node', data: { aiApp: restored } as unknown as BaseNodeData });
    expect(text(tree)).toContain('应用定义不可用');
    expect(elements(tree).find((element) => element.type === 'button')!.props.disabled).toBe(true);
    expect(elements(tree).some((element) => element.type === AiAppDialog)).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('shows the saved summary without starting a session and opens the app only on demand', () => {
    hooks.index = 0;
    const tree = AiAppNode({ id: 'app-node', data: { aiApp: app } as BaseNodeData, selected: true });
    expect(text(tree)).toContain('绑定 1 个画布素材');
    expect(text(tree)).toContain('上次检查结果');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(elements(tree).some((element) => element.type === AiAppDialog)).toBe(false);
    const open = elements(tree).find((element) => element.type === 'button')!;
    (open.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: vi.fn() });
    hooks.index = 0;
    const opened = AiAppNode({ id: 'app-node', data: { aiApp: app } as BaseNodeData });
    const dialog = elements(opened).find((element) => element.type === AiAppDialog)!;
    expect(dialog).toBeDefined();
    hooks.index = 0;
    const afterSave = AiAppNode({ id: 'app-node', data: { aiApp: { ...app, revision: 2 } } as BaseNodeData });
    expect(elements(afterSave).find((element) => element.type === AiAppDialog)!.key).toBe(dialog.key);
  });

  it('attaches an opaque sandbox and calls save only after an explicit user click', async () => {
    await mount();
    const frame = elements(renderDialog()).find((element) => element.type === 'iframe')!;
    expect(frame.props.sandbox).toBe('allow-scripts');
    expect(frame.props.srcDoc).toBeUndefined();
    expect(frame.props.referrerPolicy).toBe('no-referrer');
    const frameWindow = {} as Window;
    (frame.props.ref as (element: { contentWindow: Window }) => void)({ contentWindow: frameWindow });
    expect(mocks.attach).toHaveBeenCalledWith(frameWindow);
    click('检查素材');
    click('检查素材');
    await vi.waitFor(() => expect(text(renderDialog())).toContain('"missing": 2'));
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith('scan');
    expect(mocks.save).not.toHaveBeenCalled();
    click('保存状态与结果');
    await vi.waitFor(() => expect(text(renderDialog())).toContain('状态与结果已保存'));
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it('requires app or Agent input for actions with mandatory parameters', async () => {
    await mount();
    const tree = renderDialog({ ...app, actions: [{
      id: 'scan', title: '检查素材', inputSchema: {
        type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'],
      },
    }] });
    const action = elements(tree).find((element) => element.type === 'button' && text(element).includes('需填写参数'))!;
    expect(action.props.disabled).toBe(true);
    expect(text(tree)).toContain('带必填参数的动作请在应用内填写');
    (action.props.onClick as () => void)();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('keeps the last frame visible after the session closes and requires retry before running or saving', async () => {
    let resolveRun!: (value: string) => void;
    mocks.run.mockImplementationOnce(() => new Promise((resolve) => { resolveRun = resolve; }));
    await mount();
    const frame = elements(renderDialog()).find((element) => element.type === 'iframe')!;
    click('检查素材');
    onChange({ busy: false, closed: true, error: '应用运行超时' });
    const closed = renderDialog();
    expect(text(closed)).toContain('应用未就绪');
    expect(elements(closed).find((element) => element.type === 'iframe')!.props.src).toBe(frame.props.src);
    expect(button('检查素材').props.disabled).toBe(true);
    expect(button('保存状态与结果').props.disabled).toBe(true);
    click('检查素材');
    click('保存状态与结果');
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(button('重试').props.disabled).not.toBe(true);
    resolveRun('迟到的结果');
    await Promise.resolve();
    expect(text(renderDialog())).not.toContain('迟到');
    click('重试');
    cleanups.shift()!();
    await mount();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(button('检查素材').props.disabled).toBe(false);
    expect(button('保存状态与结果').props.disabled).toBe(false);
  });

  it('keeps an open session usable after an individual action fails', async () => {
    await mount();
    onChange({ busy: false, closed: false, error: '本次动作失败' });
    expect(text(renderDialog())).toContain('本次动作失败');
    expect(button('检查素材').props.disabled).toBe(false);
    expect(button('保存状态与结果').props.disabled).toBe(false);
    click('检查素材');
    await vi.waitFor(() => expect(text(renderDialog())).toContain('"missing": 2'));
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('disposes on close and rejects late results and state callbacks without persisting them', async () => {
    let resolveRun!: (value: string) => void;
    mocks.run.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
    await mount();
    click('检查素材');
    const close = elements(renderDialog()).find((element) => element.type === PopupCloseButton)!;
    (close.props.onClick as () => void)();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    onChange({ busy: false, result: '迟到的状态' });
    resolveRun('迟到的结果');
    await Promise.resolve();
    expect(text(renderDialog())).not.toContain('迟到');
    expect(mocks.save).not.toHaveBeenCalled();
    cleanups.shift()!();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('stops the old session and offers reload while ignoring its late completion', async () => {
    let resolveRun!: (value: string) => void;
    mocks.run.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));
    await mount();
    click('检查素材');
    expect(button('停止').props.disabled).toBe(false);
    click('停止');
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(elements(renderDialog()).some((element) => element.type === 'iframe')).toBe(false);
    expect(button('检查素材').props.disabled).toBe(true);
    expect(button('重试')).toBeDefined();
    onChange({ busy: false, result: '迟到的状态' });
    resolveRun('迟到的结果');
    await Promise.resolve();
    expect(text(renderDialog())).not.toContain('迟到');
    click('重试');
    cleanups.shift()!();
    await mount();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(button('检查素材').props.disabled).toBe(false);
  });

  it('disposes a session that finishes opening after the dialog closes', async () => {
    let complete!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    renderDialog();
    const cleanup = hooks.effects[0]();
    if (cleanup) cleanups.push(cleanup);
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const close = elements(renderDialog()).find((element) => element.type === PopupCloseButton)!;
    (close.props.onClick as () => void)();
    complete({ dispose: mocks.dispose });
    await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledOnce());
    expect(elements(renderDialog()).some((element) => element.type === 'iframe')).toBe(false);
  });

  it('allows retry after startup failure and forwards both light and dark theme settings', async () => {
    mocks.create.mockRejectedValueOnce(new Error('定义校验失败'));
    renderDialog();
    const cleanup = hooks.effects[0]();
    if (cleanup) cleanups.push(cleanup);
    await vi.waitFor(() => expect(text(renderDialog())).toContain('定义校验失败'));
    click('重试');
    cleanups.shift()!();
    await mount();
    renderDialog();
    hooks.effects[1]();
    expect(mocks.theme).toHaveBeenLastCalledWith('dark');
    mocks.state.mockReturnValue({ config: { theme: 'dark', appearance: { mode: 'light' } } });
    renderDialog();
    hooks.effects[1]();
    expect(mocks.theme).toHaveBeenLastCalledWith('light');
  });
});
