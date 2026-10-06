import { stat } from '@tauri-apps/plugin-fs';
import { copyAssetFileToFolder, finishAssetFileMove, type FileTransferOptions } from '../fileService';
import { completeMediaRelocation, pendingMediaRelocations, persistMediaRelocation, type MediaRelocation } from '../indexedDb/mediaRelocations';
import { getAssetIndexById } from '../indexedDbService';
import { getGlobalFilesDir, resolveAssetFolderDirectory, type AssetFolderSelection } from './assetLibrary';
import { getRelativeAssetPath, identifyAsset } from './assetIndex';
import { getAssetUrlFromPath, notifyProjectDiskChanged, type AssetFileEntry } from './core';

const MOVE_DOMAIN = 'global-assets';
const normalize = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (path: string) => /^[a-z]:\//i.test(normalize(path)) || normalize(path).startsWith('//') ? normalize(path).toLowerCase() : normalize(path);
const parent = (path: string) => normalize(path).slice(0, normalize(path).lastIndexOf('/'));
const checkCancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('文件操作已取消', 'AbortError'); };

async function destinationInfo(selection: AssetFolderSelection, roots: readonly string[]) {
  const directory = await resolveAssetFolderDirectory(selection, roots);
  const globalRoot = await getGlobalFilesDir();
  const rootPath = selection.kind === 'folder' ? selection.rootPath : globalRoot;
  if (!rootPath) throw new Error('无法访问目标目录');
  return { directory, rootPath: normalize(rootPath), source: key(rootPath) === key(globalRoot ?? '') ? 'global' as const : 'folder' as const };
}

/** 先完成副本及持久化引用迁移，再回收源文件；失败不删除源文件。 */
export async function moveAssetFile(
  file: AssetFileEntry, selection: AssetFolderSelection, roots: readonly string[],
  onRelocated: (move: MediaRelocation) => void, options?: FileTransferOptions,
): Promise<{ path: string; moved: boolean }> {
  if (file.category !== 'image' || !['global', 'folder'].includes(file.source ?? '') || file.availability === 'offline') {
    throw new Error('仅支持移动全局资产中的本地图片');
  }
  const globalRoot = await getGlobalFilesDir();
  const sourceRoot = [globalRoot, ...roots].find((root) => root && getRelativeAssetPath(file.path, root) !== undefined);
  if (!sourceRoot) throw new Error('源文件不在已登记的资产目录内');
  const destination = await destinationInfo(selection, roots);
  checkCancelled(options?.signal);
  if (key(parent(file.path)) === key(destination.directory)) return { path: file.path, moved: false };

  // 上次引用已提交但回收失败时，重试原操作；不再创建第二份副本。
  let move = (await pendingMediaRelocations(MOVE_DOMAIN)).find((item) => item.assetMove
    && key(item.oldPath) === key(file.path) && key(parent(item.newPath)) === key(destination.directory));
  if (!move) {
    const previous = file.assetId ? await getAssetIndexById(file.assetId) : undefined;
    if (previous && key(previous.path) !== key(file.path)) throw new Error('资产位置已变化，请刷新列表后重试');
    const identity = await identifyAsset(file.path, { assetId: file.assetId, source: file.source as 'global' | 'folder', rootPath: sourceRoot });
    const copy = await copyAssetFileToFolder(file.path, destination.directory, options);
    checkCancelled(options?.signal);
    const targetStat = await stat(copy.path);
    const relativePath = getRelativeAssetPath(copy.path, destination.rootPath);
    if (!relativePath) throw new Error('目标文件位置无效，原文件已保留');
    move = { oldPath: normalize(file.path), newPath: normalize(copy.path), oldAssetUrl: file.assetUrl,
      assetUrl: await getAssetUrlFromPath(copy.path), relativePath, projectId: MOVE_DOMAIN,
      assetMove: { assetId: identity.assetId, rootPath: destination.rootPath, source: destination.source, digest: copy.digest, totalBytes: copy.totalBytes,
        mtimeMs: targetStat.mtime?.getTime() ?? 0 } };
    checkCancelled(options?.signal);
    await persistMediaRelocation(move);
  }
  onRelocated(move);
  checkCancelled(options?.signal);
  await finishAssetFileMove(move.oldPath, { path: move.newPath, digest: move.assetMove!.digest, totalBytes: move.assetMove!.totalBytes });
  await completeMediaRelocation(move);
  notifyProjectDiskChanged();
  return { path: move.newPath, moved: true };
}

/** 外部拖入是复制导入；每个文件独立落盘，取消保留已完成的副本。 */
export async function importAssetFilesToFolder(paths: readonly string[], selection: AssetFolderSelection, roots: readonly string[], options?: FileTransferOptions): Promise<number> {
  if (!paths.length || paths.length > 100) throw new Error('每次可拖入 1–100 个文件');
  const destination = await destinationInfo(selection, roots);
  let completed = 0;
  for (const path of [...new Set(paths)]) {
    checkCancelled(options?.signal);
    const copy = await copyAssetFileToFolder(path, destination.directory, options);
    await identifyAsset(copy.path, { rootPath: destination.rootPath, source: destination.source });
    completed++;
    notifyProjectDiskChanged();
  }
  return completed;
}
