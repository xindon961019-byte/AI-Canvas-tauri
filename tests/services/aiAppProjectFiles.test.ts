import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FileInfo {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
}

const driver = vi.hoisted(() => ({
  info: new Map<string, FileInfo>(),
  data: new Map<string, Uint8Array>(),
  exists: vi.fn(), lstat: vi.fn(), readFile: vi.fn(),
  getProjectDataDir: vi.fn(), isTauriEnv: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: driver.exists, lstat: driver.lstat, readFile: driver.readFile,
  mkdir: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('../../src/services/fs/core', () => ({
  getProjectDataDir: driver.getProjectDataDir, isTauriEnv: driver.isTauriEnv,
  joinPath: (...parts: string[]) => parts.join('/'),
  ensureProjectDataDir: vi.fn(), notifyProjectDiskChanged: vi.fn(),
}));

import { readBoundedProjectFile } from '../../src/services/fs/projectFiles';

const input = { projectId: 'project-a', relativePath: 'images/input.png', maxBytes: 16 };
const root = '/projects/project-a';
const path = `${root}/images/input.png`;

beforeEach(() => {
  vi.resetAllMocks();
  driver.info.clear();
  driver.data.clear();
  driver.info.set(root, { isDirectory: true, isFile: false, isSymlink: false, size: 0 });
  driver.info.set(`${root}/images`, { isDirectory: true, isFile: false, isSymlink: false, size: 0 });
  driver.info.set(path, { isDirectory: false, isFile: true, isSymlink: false, size: 4 });
  driver.data.set(path, new Uint8Array([1, 2, 3, 4]));
  driver.getProjectDataDir.mockImplementation(async (projectId: string) => `/projects/${projectId}`);
  driver.isTauriEnv.mockReturnValue(true);
  driver.exists.mockImplementation(async (target: string) => driver.info.has(target));
  driver.lstat.mockImplementation(async (target: string) => {
    const info = driver.info.get(target);
    if (!info) throw new Error('missing');
    return info;
  });
  driver.readFile.mockImplementation(async (target: string) => {
    const data = driver.data.get(target);
    if (!data) throw new Error('missing');
    return data;
  });
});

describe('AI 应用项目素材有界读取', () => {
  it('先校验项目目录、父目录、普通文件和体积，再读取已授权项目文件', async () => {
    expect(await readBoundedProjectFile(input)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(driver.getProjectDataDir).toHaveBeenCalledWith('project-a');
    expect(driver.lstat.mock.calls.map(([target]) => target)).toEqual([root, `${root}/images`, path]);
    expect(driver.readFile).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each([17, 0, -1, NaN, Infinity, 1.5])('文件大小 %s 无效或超额时不读取正文', async (size) => {
    driver.info.set(path, { isDirectory: false, isFile: true, isSymlink: false, size });
    await expect(readBoundedProjectFile(input)).rejects.toThrow('读取上限');
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it.each(['../private.png', '/etc/private.png', 'images/../../private.png', 'images/../private.png', 'C:\\private.png'])(
    '路径 %s 无法越过项目相对路径边界', async (relativePath) => {
      await expect(readBoundedProjectFile({ ...input, relativePath })).rejects.toThrow('路径不安全');
      expect(driver.readFile).not.toHaveBeenCalled();
      expect(driver.getProjectDataDir).not.toHaveBeenCalled();
    },
  );

  it.each([root, `${root}/images`, path])('拒绝符号链接 %s', async (target) => {
    driver.info.set(target, { ...driver.info.get(target)!, isSymlink: true });
    await expect(readBoundedProjectFile(input)).rejects.toThrow('符号链接');
    expect(driver.readFile).not.toHaveBeenCalled();
  });

  it.each([new Uint8Array([1]), new Uint8Array(5), new Uint8Array(17)])('读期间文件体积变化后拒绝交付字节 %#', async (data) => {
    driver.data.set(path, data);
    await expect(readBoundedProjectFile(input)).rejects.toThrow('读取期间发生变化');
  });

  it('拒绝其他项目、非普通文件和无效上限', async () => {
    await expect(readBoundedProjectFile({ ...input, projectId: 'project-b' })).rejects.toThrow('项目目录不存在');
    driver.info.set(path, { isDirectory: true, isFile: false, isSymlink: false, size: 4 });
    await expect(readBoundedProjectFile(input)).rejects.toThrow('不是普通文件');
    for (const maxBytes of [0, -1, NaN, Infinity]) {
      await expect(readBoundedProjectFile({ ...input, maxBytes })).rejects.toThrow('上限无效');
    }
    expect(driver.readFile).not.toHaveBeenCalled();
  });
});
