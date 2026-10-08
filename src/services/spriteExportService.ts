/**
 * spriteExportService — Sprite Sheet 切帧导出
 * 扩展名决定格式：.gif 动图、.png 序列帧、.json 图集与元数据。
 */
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { AnimationFrameEdit, AnimationProcessing } from '../types/animation';

export interface SpriteExportResult {
  files: string[];
  frame_width: number;
  frame_height: number;
  format?: 'gif' | 'png' | 'json';
  frame_count?: number;
}

export interface SpriteExportOptions {
  inputPath: string;
  defaultName: string;
  cols: number;
  rows: number;
  frameCount: number;
  fps: number;
  processing?: AnimationProcessing;
  edits?: AnimationFrameEdit[];
  loop?: boolean;
  action?: string;
}

/** 用户取消对话框时返回 null。 */
export async function exportSpriteFrames(
  options: SpriteExportOptions,
): Promise<SpriteExportResult | null> {
  const safeName = options.defaultName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'sprite';
  const outputPath = await save({
    defaultPath: `${safeName}.gif`,
    filters: [
      { name: 'GIF 动图', extensions: ['gif'] },
      { name: 'PNG 序列帧', extensions: ['png'] },
      { name: 'PNG 图集 + JSON 元数据', extensions: ['json'] },
    ],
  });
  if (!outputPath) return null;

  const json: string = await invoke('export_sprite_frames', {
    inputPath: options.inputPath,
    outputPath,
    cols: options.cols,
    rows: options.rows,
    frameCount: options.frameCount,
    fps: options.fps,
    looping: options.loop ?? true,
    action: options.action,
    edits: options.edits,
    options: options.processing ? {
      cols: options.cols, rows: options.rows, frameCount: options.frameCount, ...options.processing,
    } : undefined,
  });
  return JSON.parse(json) as SpriteExportResult;
}
