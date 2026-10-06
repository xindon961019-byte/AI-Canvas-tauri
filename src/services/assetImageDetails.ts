import { findImageHistoryByReferences, getNodeHistoryEntries, type HistoryRecord } from './indexedDbService';
import { getFileCategory, type AssetFileEntry } from './fileService';
import type { AssetImageLoadedDetails, AssetImageReferenceView } from '../types/assetImage';
import { findSavedAssetImage, identifyAssetImage, resolveAssetImageReferences } from './fs/assetImageMetadata';
import { isTauriEnv } from './fs/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { parseDramaMentionId, type DramaAssetLibrary } from '../types/dramaAssets';
import { resolveDramaActionMediaRef } from './dramaAssetPrompt';
import { bestNodeThumb } from '../components/nodes/shared/mentionEditorDom';

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function safeLocalAssetUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  if (!IS_TAURI) return filePath;
  try {
    return convertFileSrc(filePath);
  } catch {
    return filePath;
  }
}

/** 仅在打开预览后读取，精确匹配图片身份；查询不产生任何持久化写入。 */
export function loadAssetImageHistory(file: AssetFileEntry, projectId?: string, signal?: AbortSignal): Promise<HistoryRecord | null> {
  return findImageHistoryByReferences([file.path, ...(file.assetUrl ? [file.assetUrl] : [])], projectId, signal);
}

export async function loadAssetImageDetails(file: AssetFileEntry, projectId?: string, signal?: AbortSignal): Promise<AssetImageLoadedDetails & { history: HistoryRecord | null }> {
  const history = await loadAssetImageHistory(file, projectId, signal);
  if (!isTauriEnv()) return { identity: null, record: null, references: [], history, contentChanged: false, warning: '编辑和添加参考图仅支持桌面应用' };
  const identity = await identifyAssetImage(file, projectId, signal);
  const saved = await findSavedAssetImage(identity, signal);
  const references = saved.record ? await resolveAssetImageReferences(saved.record.references, signal) : [];
  return { identity, record: saved.record, references, contentChanged: saved.contentChanged,
    history: saved.contentChanged && !saved.record ? null : history,
    warning: saved.ambiguous ? '找到多个相同内容的信息记录，未自动关联' : saved.contentChanged && !saved.record ? '原图内容已变化，旧提示词与参考图仍保留' : null };
}

const IMAGE_PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ['imageSize', '生成尺寸'], ['aspectRatio', '宽高比'], ['resolution', '分辨率'],
  ['quality', '质量'], ['seed', '随机种子'], ['steps', '采样步数'],
  ['guidanceScale', '引导强度'], ['cfgScale', '提示词强度'], ['sampler', '采样器'],
  ['scheduler', '调度器'], ['negativePrompt', '反向提示词'],
];

/** 只展示已保存的参数白名单，不显示凭据、路径或任意嵌套对象。 */
export function describeAssetImageHistory(history: HistoryRecord): Array<{ label: string; value: string }> {
  const details: Array<{ label: string; value: string }> = [];
  if (history.model) details.push({ label: '模型', value: history.model });
  if (history.provider) details.push({ label: '供应商', value: history.provider });
  for (const [key, label] of IMAGE_PARAMETERS) {
    const value = history.params?.[key];
    if (typeof value === 'string' && value.trim() || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
      details.push({ label, value: String(value) });
    }
  }
  if (Number.isFinite(history.timestamp) && history.timestamp > 0) {
    details.push({ label: '生成时间', value: new Date(history.timestamp).toLocaleString() });
  }
  return details;
}

/**
 * 从提示词文本中提取所有引用的图片（包括 @{nodeId:label}、@asset{path}、@drama{id:name}），
 * 供资产详情展示为参考图列表并支持全屏预览。
 */
export async function resolvePromptImageReferences(
  prompt: string,
  options?: {
    nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
    dramaAssets?: DramaAssetLibrary;
    projectId?: string;
    signal?: AbortSignal;
  },
): Promise<AssetImageReferenceView[]> {
  if (!prompt || typeof prompt !== 'string') return [];
  const regex = /@asset\{([^}]+)\}|@drama\{([^:]+):([^}]+)\}|@\{([^:]+):([^}]+)\}/g;
  const references: AssetImageReferenceView[] = [];
  const seenUrls = new Set<string>();
  const nodes = options?.nodes;
  const dramaAssets = options?.dramaAssets;
  const projectId = options?.projectId;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (match[1] !== undefined) {
      let path = match[1];
      try { path = decodeURIComponent(match[1]); } catch { /* 保留原值 */ }
      const name = path.split(/[\\/]/).pop() || '参考图';
      if (getFileCategory(name) === 'image') {
        const url = safeLocalAssetUrl(path) || path;
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          references.push({
            id: `prompt-ref-asset:${path}`,
            name,
            relativePath: '',
            digest: '',
            bytes: 0,
            url,
          });
        }
      }
    } else if (match[2] !== undefined) {
      const dramaId = match[2];
      const dramaName = match[3] || '资产参考';
      if (dramaAssets) {
        const { assetId, referenceImageId, actionId, actionMediaId } = parseDramaMentionId(dramaId);
        const found = dramaAssets.characters.find((a) => a.id === assetId)
          || dramaAssets.scenes.find((a) => a.id === assetId)
          || dramaAssets.props.find((a) => a.id === assetId);
        let url: string | undefined;
        let name = dramaName;

        if (actionId !== undefined) {
          const media = resolveDramaActionMediaRef(found, actionId, actionMediaId);
          if (media && media.kind !== 'video') {
            url = media.url;
            name = `${found?.name ?? ''} ${media.label || '动作'}`.trim();
          }
        } else if (found) {
          const picked = referenceImageId && found.kind === 'character'
            ? found.referenceImages?.find((img) => img.id === referenceImageId)
            : undefined;
          if (picked) {
            url = picked.imageUrl;
            name = `${found.name} · 参考图`;
          } else if (found.imageNodeId && nodes) {
            const node = nodes.find((n) => n.id === found.imageNodeId);
            url = bestNodeThumb(node?.data ?? {}) || (node?.data?.imageUrl as string | undefined) || found.imageUrl;
            name = found.name;
          } else {
            url = found.imageUrl;
            name = found.name;
          }
        }
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          references.push({
            id: `prompt-ref-drama:${dramaId}`,
            name,
            relativePath: '',
            digest: '',
            bytes: 0,
            url,
          });
        }
      }
    } else if (match[4] !== undefined) {
      const nodeId = match[4];
      const label = match[5] || '生成图像';
      let url: string | undefined;
      let name = label;

      if (nodeId.includes('/cell/')) {
        const [parentId, , cellIdxStr] = nodeId.split('/');
        const cellIdx = Number.parseInt(cellIdxStr, 10);
        const parentNode = nodes?.find((n) => n.id === parentId);
        if (parentNode) {
          const overrides = (parentNode.data?.storyboardOverrides as Array<{ url?: string } | null> | undefined) ?? [];
          url = overrides[cellIdx]?.url || (parentNode.data?.imageUrl as string | undefined);
          name = `${parentNode.data?.label || '分镜'} 格${cellIdx + 1}`;
        }
      } else {
        const node = nodes?.find((n) => n.id === nodeId);
        if (node) {
          name = (node.data?.label as string) || label;
          url = bestNodeThumb(node.data ?? {})
            || (node.data?.imageUrl as string | undefined)
            || (node.data?.thumbnailUrl as string | undefined);
          if (!url && typeof node.data?.filePath === 'string' && node.data.filePath) {
            url = safeLocalAssetUrl(node.data.filePath);
          }
          if (!url && node.data?.type === 'ai-director' && Array.isArray(node.data.directorCaptureUrls)) {
            url = node.data.directorCaptureUrls.find((u) => typeof u === 'string' && u.trim());
          }
        } else if (projectId) {
          try {
            const entries = await getNodeHistoryEntries(projectId, nodeId);
            const mediaEntry = entries.find((e) => e.status === 'success' && (e.mediaUrl || e.filePath));
            if (mediaEntry) {
              url = mediaEntry.mediaUrl || (mediaEntry.filePath ? safeLocalAssetUrl(mediaEntry.filePath) : undefined);
              name = mediaEntry.nodeLabel || label;
            }
          } catch {
            // 忽略读取历史错误
          }
        }
      }
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        references.push({
          id: `prompt-ref-node:${nodeId}`,
          name,
          relativePath: '',
          digest: '',
          bytes: 0,
          url,
        });
      }
    }
  }

  return references;
}

