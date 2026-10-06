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
}

export interface AssetImageLoadedDetails {
  identity: AssetImageIdentity | null;
  record: AssetImageRecord | null;
  references: AssetImageReferenceView[];
  warning: string | null;
  contentChanged: boolean;
}
