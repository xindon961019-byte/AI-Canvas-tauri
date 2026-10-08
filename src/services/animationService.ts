/** 原图留在项目文件中；原生 PNG 响应仅转为调用期 Blob，不进入持久化。 */
import { invoke } from '@tauri-apps/api/core';
import type { CSSProperties } from 'react';
import type { BaseNodeData } from '../types';
import { ANIMATION_FRAME_GRIDS } from '../types';
import type { AnimationFrameEdit, AnimationPreviewResult, AnimationProcessing, AnimationSheet } from '../types/animation';

type AnimationSourceData = Pick<BaseNodeData, 'animationSheet' | 'animationFrames' | 'animationAction'>;

export function animationSheet(data: AnimationSourceData): AnimationSheet {
  const configured = data.animationFrames ?? 8;
  const count = Object.hasOwn(ANIMATION_FRAME_GRIDS, configured) ? configured : 8;
  const sheet = data.animationSheet;
  if (sheet && [sheet.cols, sheet.rows, sheet.frameCount].every((value) => Number.isInteger(value) && value >= 1 && value <= 256)
    && sheet.frameCount <= sheet.cols * sheet.rows) return sheet;
  return { ...ANIMATION_FRAME_GRIDS[count], frameCount: count, action: data.animationAction ?? 'idle' };
}

export function animationProcessing(data: AnimationSourceData & Pick<BaseNodeData, 'animationProcessing'>): AnimationProcessing {
  return data.animationProcessing ?? {
    chromaKey: 'auto', keyThreshold: 55, segmentation: 'projection', alignment: 'foot',
    ground: animationSheet(data).action !== 'jump', margin: 0.1,
  };
}

export function animationEdits(data: AnimationSourceData & Pick<BaseNodeData, 'animationEdits'>): AnimationFrameEdit[] {
  const count = animationSheet(data).frameCount;
  const edits = data.animationEdits;
  if (edits?.length === count && new Set(edits.map((edit) => edit.sourceIndex)).size === count
    && edits.every((edit) => Number.isInteger(edit.sourceIndex) && edit.sourceIndex >= 0 && edit.sourceIndex < count
      && Number.isInteger(edit.offsetX) && Number.isInteger(edit.offsetY)) && edits.some((edit) => edit.enabled)) return edits;
  return Array.from({ length: count }, (_, sourceIndex) => ({ sourceIndex, enabled: true, offsetX: 0, offsetY: 0 }));
}

export function animationResultPatch(data: BaseNodeData): Partial<BaseNodeData> {
  const frameCount = data.animationFrames ?? 8;
  return {
    animationSheet: { ...ANIMATION_FRAME_GRIDS[frameCount], frameCount, action: data.animationAction ?? 'idle' },
    animationEdits: undefined,
  };
}

export function animationFrameStyle(
  layout: Pick<AnimationPreviewResult, 'cols' | 'rows' | 'cellWidth' | 'cellHeight'>,
  edit: AnimationFrameEdit,
): CSSProperties {
  return {
    width: `${layout.cols * 100}%`, height: `${layout.rows * 100}%`,
    left: `${-(edit.sourceIndex % layout.cols) * 100 + edit.offsetX / layout.cellWidth * 100}%`,
    top: `${-Math.floor(edit.sourceIndex / layout.cols) * 100 + edit.offsetY / layout.cellHeight * 100}%`,
    // 偏移只移动当前帧，不能把相邻宫格露到空出来的区域。
    clipPath: `inset(${Math.floor(edit.sourceIndex / layout.cols) / layout.rows * 100}% ${(layout.cols - 1 - edit.sourceIndex % layout.cols) / layout.cols * 100}% ${(layout.rows - 1 - Math.floor(edit.sourceIndex / layout.cols)) / layout.rows * 100}% ${(edit.sourceIndex % layout.cols) / layout.cols * 100}%)`,
  };
}

export interface AnimationPreview extends Omit<AnimationPreviewResult, 'pngBase64'> {
  url: string;
  dispose: () => void;
}

export async function prepareAnimationPreview(inputPath: string, sheet: AnimationSheet, processing: AnimationProcessing): Promise<AnimationPreview> {
  const result = await invoke<AnimationPreviewResult>('preview_sprite_sheet', {
    inputPath, options: { cols: sheet.cols, rows: sheet.rows, frameCount: sheet.frameCount, ...processing },
  });
  if (!result.pngBase64 || result.pngBase64.length > 96 * 1024 * 1024
    || result.frames.length !== sheet.frameCount || result.cellWidth < 1 || result.cellHeight < 1) {
    throw new Error('原生动画预览响应无效');
  }
  const binary = atob(result.pngBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const { pngBase64: _pixels, ...metadata } = result;
  let disposed = false;
  return { ...metadata, url, dispose: () => { if (!disposed) { URL.revokeObjectURL(url); disposed = true; } } };
}
