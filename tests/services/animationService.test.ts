import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseNodeData } from '../../src/types';
import type { AnimationPreviewResult } from '../../src/types/animation';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), projectDir: vi.fn(), tauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../src/services/fs/core', () => ({ getProjectDataDir: mocks.projectDir, isTauriEnv: mocks.tauri }));
import { animationEdits, animationFrameStyle, animationProcessing, animationResultPatch, animationSheet, prepareAnimationPreview } from '../../src/services/animationService';

const data = (patch: Partial<BaseNodeData> = {}): BaseNodeData => ({ type: 'ai-animation', label: '动画', status: 'idle', ...patch });
afterEach(() => { vi.restoreAllMocks(); mocks.invoke.mockReset(); mocks.projectDir.mockReset(); mocks.tauri.mockReset().mockReturnValue(false); });

describe('animation source and non-destructive edits', () => {
  it('keeps the current sheet layout when the next generation frame count changes', () => {
    const original = animationResultPatch(data({ animationFrames: 12, animationAction: 'run' }));
    expect(animationSheet(data({ ...original, animationFrames: 8 }))).toEqual({ cols: 4, rows: 3, frameCount: 12, action: 'run' });
    expect(animationResultPatch(data({ animationFrames: 8, animationEdits: [{ sourceIndex: 0, enabled: false, offsetX: 0, offsetY: 0 }] })).animationEdits).toBeUndefined();
  });
  it('preserves jump displacement by default and honours an explicit grounding choice', () => {
    expect(animationProcessing(data({ animationAction: 'jump' })).ground).toBe(false);
    const processing = { ...animationProcessing(data()), ground: true };
    expect(animationProcessing(data({ animationAction: 'jump', animationProcessing: processing })).ground).toBe(true);
  });
  it('rejects corrupted persisted geometry and stale or all-disabled edits', () => {
    const node = data({ animationSheet: { cols: 0, rows: 1, frameCount: 0, action: 'idle' } });
    expect(animationSheet(node).frameCount).toBe(8);
    const edits = animationEdits(node).map((edit) => ({ ...edit, enabled: false }));
    expect(animationEdits(data({ animationEdits: edits })).every((edit) => edit.enabled)).toBe(true);
    edits[0] = { ...edits[0], sourceIndex: 99, enabled: true };
    expect(animationEdits(data({ animationEdits: edits }))[0].sourceIndex).toBe(0);
  });
  it('maps source order and pixel nudges to the same cell coordinate system', () => {
    expect(animationFrameStyle({ cols: 4, rows: 2, cellWidth: 100, cellHeight: 200 }, { sourceIndex: 5, enabled: true, offsetX: 10, offsetY: -20 }))
      .toEqual({ width: '400%', height: '200%', left: '-90%', top: '-110%', clipPath: 'inset(50% 50% 0% 25%)' });
  });
  it('keeps fractional offsets when reopening and maps them without rounding', () => {
    const edits = animationEdits(data());
    edits[0] = { ...edits[0], offsetX: 0.5, offsetY: -1.5 };
    expect(animationEdits(data({ animationEdits: edits }))).toEqual(edits);
    expect(animationFrameStyle({ cols: 4, rows: 2, cellWidth: 100, cellHeight: 200 }, edits[0]))
      .toMatchObject({ left: '0.5%', top: '-0.75%' });
    for (const invalid of [NaN, Infinity, -Infinity]) {
      const corrupted = edits.map((edit) => ({ ...edit }));
      corrupted[0].offsetX = invalid;
      expect(animationEdits(data({ animationEdits: corrupted }))[0].offsetX).toBe(0);
      corrupted[0] = { ...edits[0], offsetY: invalid };
      expect(animationEdits(data({ animationEdits: corrupted }))[0].offsetY).toBe(0);
    }
  });
  it('creates a transient preview and revokes it exactly once', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const frames = Array.from({ length: 8 }, (_, sourceIndex) => ({ sourceIndex, sourceRect: { x: 0, y: 0, w: 10, h: 10 }, contentBounds: { x: 1, y: 1, w: 8, h: 8 }, anchorX: 5, offsetX: 0, offsetY: 0 }));
    mocks.invoke.mockResolvedValue({ pngBase64: 'aGk=', width: 40, height: 20, cellWidth: 10, cellHeight: 10, cols: 4, rows: 2, frames, warnings: [] } satisfies AnimationPreviewResult);
    const sheet = animationSheet(data()); const processing = animationProcessing(data());
    const result = await prepareAnimationPreview('runtime-only-input', sheet, processing);
    expect(mocks.invoke).toHaveBeenCalledWith('preview_sprite_sheet', { inputPath: 'runtime-only-input', options: { cols: 4, rows: 2, frameCount: 8, ...processing } });
    expect(result).not.toHaveProperty('pngBase64');
    expect(create).toHaveBeenCalledOnce(); result.dispose(); result.dispose(); expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview');
  });
  it('does not create a Blob for incomplete native results', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    mocks.invoke.mockResolvedValue({ pngBase64: '', frames: [], cellWidth: 10, cellHeight: 10 });
    await expect(prepareAnimationPreview('input', animationSheet(data()), animationProcessing(data()))).rejects.toThrow('响应无效');
    expect(create).not.toHaveBeenCalled();
  });
  it('binds the disk cache directory to the explicitly supplied project', async () => {
    mocks.tauri.mockReturnValue(true);
    let resolveDirectory!: (directory: string) => void;
    mocks.projectDir.mockImplementation(() => new Promise<string>((resolve) => { resolveDirectory = resolve; }));
    mocks.invoke.mockResolvedValue({ pngBase64: '', frames: [], cellWidth: 10, cellHeight: 10 });
    const request = prepareAnimationPreview('runtime-only-input', animationSheet(data()), animationProcessing(data()), 'project-original');
    expect(mocks.projectDir).toHaveBeenCalledExactlyOnceWith('project-original');
    expect(mocks.invoke).not.toHaveBeenCalled();
    resolveDirectory('project-cache-root');
    await expect(request).rejects.toThrow('响应无效');
    expect(mocks.invoke).toHaveBeenCalledWith('preview_sprite_sheet', expect.objectContaining({ projectDir: 'project-cache-root' }));
  });
  it('keeps preview available without a resolvable project cache', async () => {
    mocks.tauri.mockReturnValue(true);
    mocks.projectDir.mockRejectedValue(new Error('cache unavailable'));
    mocks.invoke.mockResolvedValue({ pngBase64: '', frames: [], cellWidth: 10, cellHeight: 10 });
    await expect(prepareAnimationPreview('input', animationSheet(data()), animationProcessing(data()), 'project-original')).rejects.toThrow('响应无效');
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('projectDir');
  });
});
