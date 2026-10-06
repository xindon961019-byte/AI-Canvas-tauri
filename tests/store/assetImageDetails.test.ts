import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import type { AppState } from '../../src/store/useAppStore';
const driver = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../src/services/fs/assetImageMetadata', () => ({ saveAssetImageMetadata: driver.save }));
import { createUISlice } from '../../src/store/store.ui';

beforeEach(() => { driver.save.mockReset(); });
describe('asset image save action', () => {
  it('delegates the exact file, revision and cancellation options without optimistic shared-state writes', async () => {
    const set = vi.fn();
    const slice = createUISlice(set, () => ({} as AppState), {} as StoreApi<AppState>);
    const file = { path: '/image.png', name: 'image.png', category: 'image' as const, size: 4 };
    const input = { identity: { assetId: 'asset', digest: 'a'.repeat(64), bytes: 4 }, record: null, prompt: '提示词', references: [], newReferencePaths: [] };
    const options = { signal: new AbortController().signal, onProgress: vi.fn() };
    const saved = { prompt: '提示词', revision: 1 };
    driver.save.mockResolvedValueOnce(saved);
    expect(await slice.saveAssetImageDetails(file, input, options)).toBe(saved);
    expect(driver.save).toHaveBeenCalledExactlyOnceWith(file, input, options);
    driver.save.mockRejectedValueOnce(new Error('conflict'));
    await expect(slice.saveAssetImageDetails(file, input, options)).rejects.toThrow('conflict');
    expect(set).not.toHaveBeenCalled();
  });
});
