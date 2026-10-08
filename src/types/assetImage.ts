import type { AssetFileEntry } from '../services/fileService';

/** 图片信息独立于标签和生成历史；不持久化原图绝对路径或运行期 URL。 */
export interface AssetImageReference {
  id: string;
  name: string;
  relativePath: string;
  digest: string;
  bytes: number;
}

export interface AssetImageRecord {
  id: string;
  assetId: string;
  contentDigest: string;
  fileName: string;
  prompt: string;
  references: AssetImageReference[];
  revision: number;
  updatedAt: number;
}

export interface AssetImageIdentity {
  assetId: string;
  digest: string;
  bytes: number;
}

export interface AssetImageReferenceView extends AssetImageReference {
  url: string | null;
}

export interface AssetImageSaveInput {
  identity: AssetImageIdentity;
  record: AssetImageRecord | null;
  prompt: string;
  references: AssetImageReference[];
  /** 仅调用期使用，不能持久化。 */
  newReferencePaths: string[];
  /** 批量反推时与提示词原子替换；基线用于拒绝调用期间发生的标签修改。 */
  tagReplacement?: AssetImageTagReplacement;
}

export interface AssetImageTagReplacement {
  tags: string[];
  expected: { tags: string[]; updatedAt: number } | null;
}

/** 批量任务仅存活于当前资源窗口，不持久化磁盘路径和控制器。 */
export interface AssetImageBatchEntry {
  file: AssetFileEntry;
  projectId?: string;
}

export type AssetImageBatchStatus = 'queued' | 'running' | 'saving' | 'success' | 'failed' | 'cancelled';

export interface AssetImageLoadedDetails {
  identity: AssetImageIdentity | null;
  record: AssetImageRecord | null;
  references: AssetImageReferenceView[];
  warning: string | null;
  contentChanged: boolean;
}
