/** 非破坏性 Sprite 处理参数；不保存文件路径、像素正文或运行时对象。 */
export interface AnimationProcessing {
  chromaKey: 'auto' | 'magenta' | 'green' | 'none';
  keyThreshold: number;
  segmentation: 'grid' | 'projection';
  alignment: 'foot' | 'alpha' | 'none';
  ground: boolean;
  margin: number;
}

export interface AnimationSheet {
  cols: number;
  rows: number;
  frameCount: number;
  action: string;
}

export interface AnimationFrameEdit {
  sourceIndex: number;
  enabled: boolean;
  offsetX: number;
  offsetY: number;
}

export interface AnimationRect { x: number; y: number; w: number; h: number }

/** 原生预览响应。pngBase64 仅用于调用过程，不进入 Store 或 IndexedDB。 */
export interface AnimationPreviewResult {
  pngBase64: string;
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
  frames: Array<{
    sourceIndex: number;
    sourceRect: AnimationRect;
    contentBounds: AnimationRect;
    anchorX: number;
    offsetX: number;
    offsetY: number;
  }>;
  warnings: string[];
}
