/** 最近使用的持久化记录只保存稳定身份，不复制文件路径或媒体正文。 */
export interface AssetUsageRecord {
  assetId: string;
  usedAt: number;
}
