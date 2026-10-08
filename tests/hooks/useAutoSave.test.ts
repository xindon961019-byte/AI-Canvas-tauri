import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { BaseNodeData } from '../../src/types';

const driver = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  pending: vi.fn(async (_projectId: string) => [] as import('../../src/services/indexedDb/mediaRelocations').MediaRelocation[]),
  directory: vi.fn(async (id: string) => `D:/data/${id}`),
  move: vi.fn(async (path: string | undefined, dir: string, folder: string | null) => {
    if (!path) return null;
    const name = path.replaceAll('\\', '/').split('/').pop();
    const target = `${dir}/${folder ? `${folder}/` : ''}${name}`;
    return path === target ? null : target;
  }),
  finish: vi.fn(async () => undefined),
}));

// 在 Node 环境驱动 effect 生命周期；Hook 和分组 Store 使用生产实现。
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { driver.effects.push(effect); },
}));
vi.mock('../../src/services/fileService', async (original) => ({
  ...await original<typeof import('../../src/services/fileService')>(),
  getProjectDataDir: driver.directory,
  moveProjectFileToFolder: driver.move,
  finishProjectFileRelocation: driver.finish,
  getAssetUrlFromPath: vi.fn(async (path: string) => `asset://${path}`),
  ensureGroupFolder: vi.fn(async () => null),
  removeEmptyProjectGroupFolder: vi.fn(async () => undefined),
}));
vi.mock('../../src/services/indexedDb/mediaRelocations', async (original) => ({
  ...await original<typeof import('../../src/services/indexedDb/mediaRelocations')>(),
  pendingMediaRelocations: driver.pending,
  persistMediaRelocation: vi.fn(async () => undefined),
  completeMediaRelocation: vi.fn(async () => undefined),
}));

import {
  captureNodeDataReferences,
  hasNodeDataReferenceChanges,
  useAutoSave as mountAutoSave,
} from '../../src/hooks/useAutoSave';
import { useAppStore } from '../../src/store/useAppStore';
import { PROJECT_DISK_CHANGED_EVENT } from '../../src/services/fileService';

let cleanup: (() => void) | undefined;
const mediaNode = (): Node<BaseNodeData> => ({
  id: 'a', type: 'ai-image', position: { x: 0, y: 0 },
  data: { label: 'a', type: 'ai-image', filePath: 'D:/data/p1/a.png', imageUrl: 'asset://D:/data/p1/a.png' },
});
function mount() {
  mountAutoSave();
  const effect = driver.effects.pop()!;
  cleanup = effect() || undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  vi.clearAllMocks();
  driver.effects = [];
  driver.pending.mockReset().mockResolvedValue([]);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentProjectId: 'p1', nodes: [mediaNode()],
    saveCurrentProjectSilent: vi.fn(async () => 'p1') });
});
afterEach(async () => {
  cleanup?.();
  cleanup = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAutoSave node data tracking', () => {
  it('detects immutable node content updates', () => {
    const originalData = { label: '原内容', output: '第一版' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data: originalData }]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { ...originalData, output: '第二版' } },
    ], baseline)).toBe(true);
  });

  it('ignores node wrapper changes when data is unchanged', () => {
    const data = { label: '文本节点', output: '内容' };
    const baseline = captureNodeDataReferences([{ id: 'node-1', data }]);

    expect(hasNodeDataReferenceChanges([{ id: 'node-1', data }], baseline)).toBe(false);
  });

  it('detects added nodes', () => {
    const baseline = captureNodeDataReferences([]);

    expect(hasNodeDataReferenceChanges([
      { id: 'node-1', data: { label: '新节点' } },
    ], baseline)).toBe(true);
  });
});

describe('useAutoSave with the group file Store', () => {
  it('does not sync or save after pure selection and position pauses', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.setState({ nodes: [{ ...useAppStore.getState().nodes[0], selected: true, position: { x: 100, y: 200 } }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.pending).not.toHaveBeenCalled();
    expect(driver.directory).not.toHaveBeenCalled();
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('saves body edits once without rescanning unrelated group media', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.getState().updateNodeDataTransient('a', { output: '修改后的正文' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.directory).not.toHaveBeenCalled();
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });

  it('archives a parentId change even when the group member array is unchanged', async () => {
    useAppStore.setState({ groups: [{ id: 'g', name: '镜头', nodeIds: [], color: '#888', createdAt: 0 }] });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    useAppStore.setState({ nodes: [{ ...mediaNode(), parentId: 'g' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useAppStore.getState().nodes[0].data.filePath).toBe('D:/data/p1/镜头/a.png');
    expect(driver.finish).toHaveBeenCalled();
    const save = vi.mocked(useAppStore.getState().saveCurrentProjectSilent);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(driver.finish.mock.invocationCallOrder[0]);
  });

  it('archives a group name change without relying on a group node data update', async () => {
    useAppStore.setState({
      nodes: [{ ...mediaNode(), parentId: 'g', data: { ...mediaNode().data, filePath: 'D:/data/p1/旧镜头/a.png' } }],
      groups: [{ id: 'g', name: '旧镜头', nodeIds: ['a'], color: '#888', createdAt: 0 }],
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.setState({ groups: [{ ...useAppStore.getState().groups[0], name: '新镜头' }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(useAppStore.getState().nodes[0].data.filePath).toBe('D:/data/p1/新镜头/a.png');
  });

  it('checks initial and reopened projects without writing a clean project', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p1');
    driver.pending.mockClear();
    useAppStore.setState({ currentProjectId: null });
    useAppStore.setState({ currentProjectId: 'p1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p1');
    expect(useAppStore.getState().saveCurrentProjectSilent).not.toHaveBeenCalled();
  });

  it('recovers a switched project after the previous project releases its IO slot', async () => {
    let release!: (moves: []) => void;
    driver.pending.mockImplementationOnce(() => new Promise<[]>((resolve) => { release = resolve; }));
    mount();
    const oldPath = 'D:/data/p2/old.png';
    const newPath = 'D:/data/p2/new.png';
    driver.pending.mockResolvedValueOnce([{ oldPath, newPath, projectId: 'p2', assetUrl: `asset://${newPath}`, relativePath: 'new.png' }]);
    vi.mocked(useAppStore.getState().saveCurrentProjectSilent).mockResolvedValue('p2');
    useAppStore.setState({ currentProjectId: 'p2', nodes: [] });
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.pending).toHaveBeenCalledWith('p2');
    expect(driver.finish).toHaveBeenCalledWith(oldPath, newPath, 'D:/data/p2');
  });

  it('still saves disk changes when the canvas signatures are unchanged', async () => {
    mount();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllMocks();
    window.dispatchEvent(new Event(PROJECT_DISK_CHANGED_EVENT));
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().saveCurrentProjectSilent).toHaveBeenCalledOnce();
  });
});
