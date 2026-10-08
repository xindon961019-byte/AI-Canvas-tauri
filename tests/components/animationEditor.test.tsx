import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';

interface ElementLike { type: unknown; props: Record<string, unknown> & { children?: unknown } }
type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const driver = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as Array<{ current: unknown }>, effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, pending: [] as Array<() => void>,
  nodeData: {} as BaseNodeData, projectId: 'project-a', revision: 1,
  update: vi.fn(), toast: vi.fn(), upload: vi.fn(), preview: vi.fn(), close: vi.fn(), dispose: vi.fn(), openDialog: vi.fn(),
}));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => {
      const index = driver.stateIndex++;
      if (!(index in driver.values)) driver.values[index] = typeof initial === 'function' ? initial() : initial;
      return [driver.values[index], (value: unknown) => { driver.values[index] = typeof value === 'function' ? value(driver.values[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = driver.refIndex++;
      return driver.refs[index] ?? (driver.refs[index] = { current: initial });
    },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = driver.effectIndex++;
      const previous = driver.effects[index];
      if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
      driver.pending.push(() => {
        previous?.cleanup?.();
        driver.effects[index] = { deps, cleanup: effect() || undefined };
      });
    },
  };
});
vi.mock('../../src/store/useAppStore', () => {
  const state = () => ({
    nodes: [{ id: 'animation', data: driver.nodeData }], currentProjectId: driver.projectId,
    getCurrentRevision: () => driver.revision, updateNodeData: driver.update, showToast: driver.toast, openNodeDialog: driver.openDialog,
  });
  return { useAppStore: Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), { getState: state }) };
});
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/services/fileService', () => ({ uploadSourceFileToProject: driver.upload }));
vi.mock('../../src/services/animationService', async () => ({
  ...await vi.importActual<typeof import('../../src/services/animationService')>('../../src/services/animationService'),
  prepareAnimationPreview: driver.preview,
}));
vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('../../src/components/shared/ModalOverlay', () => ({ default: () => null }));
vi.mock('../../src/components/shared/Select', () => ({ default: () => null }));
vi.mock('../../src/components/shared/NumberStepper', () => ({ default: () => null }));
vi.mock('../../src/components/shared/PopupCloseButton', () => ({ default: () => null }));
import AnimationEditor from '../../src/components/nodes/shared/AnimationEditor';

function elements(root: unknown): ElementLike[] {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as ElementLike;
  return [element, ...elements(element.props.children)];
}
function text(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(text).join('');
  return root && typeof root === 'object' && 'props' in root ? text((root as ElementLike).props.children) : '';
}
function find(root: unknown, predicate: (element: ElementLike) => boolean) {
  const result = elements(root).find(predicate);
  if (!result) throw new Error('Missing editor control');
  return result;
}
function button(root: unknown, label: string) { return find(root, (element) => element.type === 'button' && text(element) === label); }
function click(element: ElementLike) { return (element.props.onClick as () => unknown)(); }
function change(element: ElementLike, value: unknown) { (element.props.onChange as (value: unknown) => void)(value); }
function render() {
  driver.stateIndex = 0; driver.refIndex = 0; driver.effectIndex = 0;
  const wrapper = AnimationEditor({ nodeId: 'animation', onClose: driver.close })!;
  const root = (wrapper.type as (props: typeof wrapper.props) => unknown)(wrapper.props);
  driver.pending.splice(0).forEach((effect) => effect());
  return root;
}
function unmount() { driver.effects.forEach((effect) => effect.cleanup?.()); driver.effects = []; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('window', globalThis);
  driver.values = []; driver.refs = []; driver.effects = []; driver.pending = [];
  driver.projectId = 'project-a'; driver.revision = 1;
  driver.nodeData = { type: 'ai-animation', label: '动画', status: 'success', imageUrl: 'original-image', animationSheet: { cols: 4, rows: 1, frameCount: 4, action: 'idle' } };
  driver.preview.mockReset().mockResolvedValue({ url: 'blob:processed', width: 400, height: 100, cols: 4, rows: 1, cellWidth: 100, cellHeight: 100, warnings: [], dispose: driver.dispose });
  driver.upload.mockReset(); driver.dispose.mockReset(); driver.update.mockReset(); driver.toast.mockReset(); driver.close.mockReset(); driver.openDialog.mockReset();
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('animation editor interactions', () => {
  it('steps from the playing frame into a paused selection and toggles guides without saving a draft', async () => {
    render();
    await vi.advanceTimersByTimeAsync(125); let root = render();
    click(find(root, (element) => element.props['aria-label'] === '下一帧')); root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-200%' });
    expect(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3')).props['aria-pressed']).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    click(find(root, (element) => element.props['aria-label'] === '显示对齐辅助线')); root = render();
    expect(find(root, (element) => element.props['aria-label'] === '显示对齐辅助线').props['aria-pressed']).toBe(false);
    expect(elements(root).some((element) => element.props.className === 'animation-anchor-axis')).toBe(false);
    expect(driver.update).not.toHaveBeenCalled();
  });
  it('closes the editor before opening generation, without applying its draft', () => {
    const root = render(); click(button(root, '生成帧动画'));
    expect(driver.close).toHaveBeenCalledOnce();
    expect(driver.openDialog).toHaveBeenCalledExactlyOnceWith('animation');
    expect(driver.close.mock.invocationCallOrder[0]).toBeLessThan(driver.openDialog.mock.invocationCallOrder[0]);
    expect(driver.update).not.toHaveBeenCalled();
  });
  it('shows the selected frame while paused, saves order and nudges in one action, and protects the last enabled frame', () => {
    let root = render();
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3')));
    root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-200%' });
    click(button(root, '前移')); root = render();
    change(find(root, (element) => element.props['aria-label'] === '帧横向偏移'), 3); root = render();
    click(button(root, '应用'));
    expect(driver.update).toHaveBeenCalledExactlyOnceWith('animation', expect.objectContaining({
      animationEdits: [
        { sourceIndex: 0, enabled: true, offsetX: 0, offsetY: 0 },
        { sourceIndex: 2, enabled: true, offsetX: 3, offsetY: 0 },
        { sourceIndex: 1, enabled: true, offsetX: 0, offsetY: 0 },
        { sourceIndex: 3, enabled: true, offsetX: 0, offsetY: 0 },
      ],
    }));
    for (const index of [1, 2, 4]) {
      click(find(root, (element) => element.type === 'button' && text(element).includes(`原帧 ${index}`))); root = render();
      change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } }); root = render();
    }
    click(find(root, (element) => element.type === 'button' && text(element).includes('原帧 3'))); root = render();
    expect(find(root, (element) => element.props.id === 'animation-enabled').props.disabled).toBe(true);
    change(find(root, (element) => element.props.id === 'animation-enabled'), { target: { checked: false } });
    root = render(); expect(find(root, (element) => element.props.id === 'animation-enabled').props.checked).toBe(true);
  });
  it('stops a single playback on the final frame and replays from the beginning', async () => {
    driver.nodeData.animationLoop = false;
    let root = render();
    for (let frame = 1; frame < 4; frame++) { await vi.advanceTimersByTimeAsync(125); root = render(); }
    expect(vi.getTimerCount()).toBe(0);
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '-300%' });
    click(button(root, '播放')); root = render();
    expect(find(root, (element) => element.props.alt === '动画预览').props.style).toMatchObject({ left: '0%' });
    expect(vi.getTimerCount()).toBe(1);
  });
  it.each(['project', 'revision'] as const)('rejects an editor draft after the %s changes', (kind) => {
    const root = render();
    if (kind === 'project') driver.projectId = 'project-b'; else driver.revision++;
    click(button(root, '应用')); click(button(root, '导入精灵图'));
    expect(driver.update).not.toHaveBeenCalled(); expect(driver.upload).not.toHaveBeenCalled();
    expect(driver.toast).toHaveBeenCalledWith('画布已变化，请重新打开帧编辑器', 'error');
  });
  it.each(['project', 'revision', 'close'] as const)('drops an imported result after %s and releases its preview', async (kind) => {
    const pending = deferred<Awaited<ReturnType<typeof driver.preview>>>();
    driver.upload.mockResolvedValue({ filePath: 'imported-sheet', fileName: 'sheet.png', dataUrl: 'imported-image' });
    driver.preview.mockReturnValue(pending.promise);
    const root = render(); click(button(root, '导入精灵图'));
    await Promise.resolve();
    if (kind === 'project') driver.projectId = 'project-b';
    else if (kind === 'revision') driver.revision++;
    else unmount();
    pending.resolve({ width: 400, height: 100, dispose: driver.dispose }); await vi.advanceTimersByTimeAsync(0);
    expect(driver.update).not.toHaveBeenCalled(); expect(driver.dispose).toHaveBeenCalledOnce();
  });
  it('imports the original image after validation and disposes only the temporary processed preview', async () => {
    driver.upload.mockResolvedValue({ filePath: 'imported-sheet', fileName: 'sheet.png', dataUrl: 'imported-image' });
    const root = render(); click(button(root, '导入精灵图')); await vi.advanceTimersByTimeAsync(0);
    expect(driver.update).toHaveBeenCalledExactlyOnceWith('animation', expect.objectContaining({ imageUrl: 'imported-image', filePath: 'imported-sheet', imageWidth: 400, imageHeight: 100 }));
    expect(driver.dispose).toHaveBeenCalledOnce(); expect(driver.close).toHaveBeenCalledOnce();
  });
});
