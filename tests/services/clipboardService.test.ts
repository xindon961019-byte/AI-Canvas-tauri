import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyImage, copyFile, readClipboardFolders } from '../../src/services/clipboardService';

const native = vi.hoisted(() => ({ invoke: vi.fn(), tauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => native.tauri }));

class ClipboardItemMock {
  readonly data: Record<string, Promise<string | Blob>>;

  static supports(type: string) {
    return type === 'image/png';
  }

  constructor(data: Record<string, Promise<string | Blob>>) {
    this.data = data;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clipboardService.copyImage', () => {
  it('在图片读取完成前调用 clipboard.write，保留 WebKit 用户手势', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchPending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const write = vi.fn(async (items: ClipboardItemMock[]) => {
      const blob = await items[0].data['image/png'];
      expect(blob).toBeInstanceOf(Blob);
      expect((blob as Blob).type).toBe('image/png');
    });
    vi.stubGlobal('fetch', vi.fn(() => fetchPending));
    vi.stubGlobal('ClipboardItem', ClipboardItemMock);
    vi.stubGlobal('navigator', { clipboard: { write } });

    const result = copyImage('data:image/png;base64,cG5n');
    expect(write).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      status: 200,
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    } as Response);
    await expect(result).resolves.toBe(true);
  });
});

describe('folder clipboard interoperability', () => {
  it('writes a directory through the system file clipboard and reads the current clipboard each time', async () => {
    native.tauri = true;
    native.invoke.mockReset().mockResolvedValueOnce(undefined).mockResolvedValueOnce(['/library/人物']).mockResolvedValueOnce(['/library/场景']);
    await expect(copyFile('/library/人物')).resolves.toBe(true);
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'copy_files_to_clipboard', { paths: ['/library/人物'] });
    await expect(readClipboardFolders()).resolves.toEqual(['/library/人物']);
    await expect(readClipboardFolders()).resolves.toEqual(['/library/场景']);
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'read_asset_folder_clipboard');
  });
  it('propagates native authorization failures and does not claim a browser folder clipboard', async () => {
    native.tauri = true;
    native.invoke.mockReset().mockRejectedValue(new Error('未授权目录'));
    await expect(readClipboardFolders()).rejects.toThrow('未授权目录');
    native.tauri = false;
    await expect(copyFile('/library/人物')).resolves.toBe(false);
    await expect(readClipboardFolders()).rejects.toThrow('仅支持桌面');
    expect(native.invoke).toHaveBeenCalledTimes(1);
    native.tauri = true;
  });
});
