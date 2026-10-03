import { readFileToDataUrl } from './fileService';
import { corsSafeFetch } from './ai/httpTransport';
import type { ModelProtocolPrepareConfig } from '../types/aiTypes';

export type CreativeMaterialKind = 'image' | 'audio';

export interface CreativeMaterialUploadInput {
  fileId: string;
  fileName: string;
  source: string;
  kind: CreativeMaterialKind;
}

export interface CreativeMaterialUploadResult extends CreativeMaterialUploadInput {
  url: string;
  status: 'uploaded' | 'reused';
}

interface BatchUploadItem {
  fileId?: unknown;
  url?: unknown;
  status?: unknown;
  error?: unknown;
  originalName?: unknown;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
}

async function sourceToBlob(
  source: string,
  kind: CreativeMaterialKind,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  const dataUrl = await readFileToDataUrl(source, { kind, signal });
  if (!dataUrl) throw new Error('无法读取参考素材文件');
  const response = await fetch(dataUrl, { signal });
  if (!response.ok) throw new Error(`无法读取参考素材文件 (${response.status})`);
  return response.blob();
}

/** 将本地参考素材批量上传，返回按 fileId 对应的 HTTPS 公网 URL。 */
export async function uploadCreativeMaterials(
  materials: readonly CreativeMaterialUploadInput[],
  credential: string,
  uploadConfig: NonNullable<ModelProtocolPrepareConfig['upload']>,
  signal?: AbortSignal,
): Promise<CreativeMaterialUploadResult[]> {
  if (materials.length === 0) return [];
  if (materials.length > 20) throw new Error('创想素材接口一次最多上传 20 个文件');
  if (!credential.trim()) throw new Error('未配置素材上传凭证，请在设置中填写');
  if (new Set(materials.map((item) => item.fileId)).size !== materials.length) {
    throw new Error('素材上传 fileId 不能重复');
  }

  const formData = new FormData();
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    formData.append(`${uploadConfig.fileListField}[${index}].${uploadConfig.fileIdField}`, material.fileId);
    const blob = await sourceToBlob(material.source, material.kind, signal);
    formData.append(`${uploadConfig.fileListField}[${index}].${uploadConfig.fileField}`, blob, material.fileName || `${material.fileId}`);
  }

  // Use the same Tauri-native transport as model requests. A plain WebView
  // fetch is blocked by CORS on desktop and surfaces only as "Load failed".
  const response = await corsSafeFetch(uploadConfig.url, {
    method: uploadConfig.method,
    headers: { [uploadConfig.credentialHeader]: credential.trim() },
    body: formData,
    signal,
  });
  const payload = await response.json().catch(() => null) as { error?: unknown; data?: { items?: BatchUploadItem[] } } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `素材批量上传失败 (${response.status})`);
  }

  const readPath = (value: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>((current, key) => (
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  ), value);
  const items = readPath(payload, uploadConfig.responseItemsPath);
  if (!Array.isArray(items)) throw new Error('素材批量上传返回格式不正确');
  const byFileId = new Map<string, BatchUploadItem>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const fileId = readPath(item, uploadConfig.responseFileIdPath);
    if (typeof fileId === 'string') byFileId.set(fileId, item as BatchUploadItem);
  }

  return materials.map((material) => {
    const item = byFileId.get(material.fileId);
    const url = item ? readPath(item, uploadConfig.responseUrlPath) : undefined;
    const status = item && uploadConfig.responseStatusPath
      ? readPath(item, uploadConfig.responseStatusPath)
      : undefined;
    if (!item || status === 'failed' || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      const reason = typeof item?.error === 'string' ? item.error : '没有返回有效的 HTTP(S) 公网 URL';
      throw new Error(`素材 ${material.fileName || material.fileId} 上传失败：${reason}`);
    }
    return { ...material, url, status: status === 'reused' ? 'reused' : 'uploaded' };
  });
}
