import type { AssetFileEntry, FileTransferOptions } from './fileService';
import type { AssetImageBatchEntry, AssetImageBatchStatus, AssetImageRecord, AssetImageSaveInput } from '../types/assetImage';
import { getAssetImageRecords, getAssetIndexById, getAssetMetaById } from './indexedDbService';
import { loadAssetImageHistory } from './assetImageDetails';
import { findSavedAssetImage, fingerprintAssetImage, identifyAssetImage } from './fs/assetImageMetadata';
import { reversePromptAndTags } from './ai/reversePrompt';

interface BatchOptions {
  model: string;
  provider: string;
  concurrency: number;
  signal: AbortSignal;
  save: (file: AssetFileEntry, input: AssetImageSaveInput, options?: FileTransferOptions) => Promise<AssetImageRecord>;
  onUpdate: (index: number, status: AssetImageBatchStatus, message?: string) => void;
  onSaved: (file: AssetFileEntry, tags: string[]) => void;
}

/** 只读识别已有提示词；保存记录优先于生成历史，不为列表读取原图或登记资产。 */
export async function findBatchImagesWithPrompts(entries: readonly AssetImageBatchEntry[], signal: AbortSignal): Promise<Set<number>> {
  const records = await getAssetImageRecords(signal);
  const savedPrompts = new Map<string, boolean>();
  records.forEach((record) => savedPrompts.set(record.assetId, !!record.prompt.trim() || !!savedPrompts.get(record.assetId)));
  const existing = new Set<number>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      signal.throwIfAborted();
      const index = cursor++;
      const { file, projectId } = entries[index];
      const hasSaved = file.assetId ? savedPrompts.get(file.assetId) : undefined;
      const hasPrompt = hasSaved ?? !!(await loadAssetImageHistory(file, projectId, signal))?.prompt?.trim();
      signal.throwIfAborted();
      if (hasPrompt) existing.add(index);
    }
  }));
  return existing;
}

/** 有界队列；结果只通过既有 Store Action 提交，不自动重试、合并标签或写入画布。 */
export async function runAssetImageReverseBatch(entries: readonly AssetImageBatchEntry[], options: BatchOptions): Promise<void> {
  const { signal, onUpdate } = options;
  const states: AssetImageBatchStatus[] = entries.map(() => 'queued');
  const update = (index: number, status: AssetImageBatchStatus, message?: string) => {
    states[index] = status;
    onUpdate(index, status, message);
  };
  let cursor = 0;
  try {
    signal.throwIfAborted();
    const worker = async () => {
      while (!signal.aborted) {
        const index = cursor++;
        if (index >= entries.length) return;
        const { file, projectId } = entries[index];
        update(index, 'running');
        try {
          if (file.category !== 'image' || !file.assetUrl || file.availability === 'offline') throw new Error('图片不可用');
          // 已有身份只读复核，避免重新登记资产时触发旧标签迁移并覆盖现有标签。
          const indexed = file.assetId ? await getAssetIndexById(file.assetId) : undefined;
          const pathKey = (path: string) => {
            const normalized = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
            return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
          };
          if (file.assetId && (!indexed || pathKey(indexed.path) !== pathKey(file.path))) throw new Error('资产位置已变化，请刷新后重试');
          const identity = indexed ? { assetId: indexed.assetId, ...await fingerprintAssetImage(file.path, signal) }
            : await identifyAssetImage(file, projectId, signal);
          const saved = await findSavedAssetImage(identity, signal);
          if (saved.ambiguous) throw new Error('存在多个匹配记录，请先单独确认此图片的信息');
          const baseline = await getAssetMetaById(identity.assetId);
          signal.throwIfAborted();
          const result = await reversePromptAndTags({ imageUrls: [file.assetUrl], model: options.model, provider: options.provider, signal });
          signal.throwIfAborted();
          update(index, 'saving');
          await options.save({ ...file, assetId: identity.assetId }, {
            identity, record: saved.record, prompt: result.prompt,
            references: saved.record?.references ?? [], newReferencePaths: [],
            tagReplacement: { tags: result.tags, expected: baseline ? { tags: [...baseline.tags], updatedAt: baseline.updatedAt } : null },
          }, { signal });
          // 保存事务完成后即为成功，不能因紧接着发生的停止而将已提交项标记为失败。
          update(index, 'success');
          options.onSaved({ ...file, assetId: identity.assetId }, result.tags);
        } catch (error) {
          update(index, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? '已停止，原内容保留'
            : error instanceof Error ? error.message : '生成或保存失败，原内容保留');
        }
      }
    };
    const concurrency = Number.isFinite(options.concurrency) ? Math.min(5, Math.max(3, Math.floor(options.concurrency))) : 3;
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  } finally {
    if (signal.aborted) states.forEach((status, index) => {
      if (status !== 'success' && status !== 'failed') update(index, 'cancelled', '已停止，原内容保留');
    });
  }
}
