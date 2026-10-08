import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { ANIMATION_ACTION_LABELS, type AnimationAction, type BaseNodeData } from '../../../types';
import type { AnimationFrameEdit, AnimationProcessing, AnimationSheet } from '../../../types/animation';
import { useAppStore } from '../../../store/useAppStore';
import { animationEdits, animationFrameStyle, animationProcessing, animationSheet, prepareAnimationPreview, type AnimationPreview } from '../../../services/animationService';
import { completeCanvasDerivation, isCanvasDerivationFresh, registerCanvasDerivation } from '../../../services/canvasDerivationGuard';
import { uploadSourceFileToProject } from '../../../services/fileService';
import { useT } from '../../../i18n';
import ModalOverlay from '../../shared/ModalOverlay';
import Select from '../../shared/Select';
import NumberStepper from '../../shared/NumberStepper';
import PopupCloseButton from '../../shared/PopupCloseButton';

export default function AnimationEditor({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const data = useAppStore((state) => state.nodes.find((node) => node.id === nodeId)?.data);
  const projectId = useAppStore((state) => state.currentProjectId);
  if (!data || data.type !== 'ai-animation') return null;
  return <Editor key={`${projectId}:${nodeId}:${data.filePath ?? ''}`} nodeId={nodeId} data={data} projectId={projectId} onClose={onClose} />;
}

function Editor({ nodeId, data, projectId, onClose }: { nodeId: string; data: BaseNodeData; projectId: string | null; onClose: () => void }) {
  const t = useT();
  const [baseRevision] = useState(() => useAppStore.getState().getCurrentRevision());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [sheet, setSheet] = useState(() => animationSheet(data));
  const [processing, setProcessing] = useState(() => animationProcessing(data));
  const [edits, setEdits] = useState(() => animationEdits(data));
  const [selected, setSelected] = useState(edits[0].sourceIndex);
  const [fps, setFps] = useState(Math.min(24, Math.max(1, data.animationFps ?? 8)));
  const [loop, setLoop] = useState(data.animationLoop ?? true);
  const [playing, setPlaying] = useState(true);
  const [playhead, setPlayhead] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewState, setPreviewState] = useState<{ key: string; value?: AnimationPreview; error?: string }>();
  const [guides, setGuides] = useState(true);
  const requestKey = JSON.stringify([data.filePath, sheet, processing]);
  const preview = previewState?.key === requestKey ? previewState.value : undefined;
  const error = previewState?.key === requestKey ? previewState.error : undefined;
  const enabled = useMemo(() => edits.filter((edit) => edit.enabled), [edits]);
  const selectedEdit = edits.find((edit) => edit.sourceIndex === selected) ?? edits[0];
  const current = playing ? enabled[Math.min(playhead, enabled.length - 1)] : selectedEdit;
  const endedOnce = !loop && playhead >= enabled.length - 1;
  const stopped = !playing || endedOnce;
  const layout = preview ?? { cols: sheet.cols, rows: sheet.rows, cellWidth: (data.imageWidth ?? sheet.cols) / sheet.cols, cellHeight: (data.imageHeight ?? sheet.rows) / sheet.rows };
  const src = preview?.url ?? data.imageUrl;
  const selectedPosition = edits.indexOf(selectedEdit);
  const actionLabel = Object.hasOwn(ANIMATION_ACTION_LABELS, sheet.action)
    ? t(ANIMATION_ACTION_LABELS[sheet.action as AnimationAction]) : sheet.action;
  const stepFrame = (delta: number) => {
    const position = edits.indexOf(current);
    setSelected(edits[(position + delta + edits.length) % edits.length].sourceIndex);
    setPlaying(false);
  };

  useEffect(() => {
    if (!data.filePath) return;
    let active = true;
    let prepared: AnimationPreview | undefined;
    const timer = window.setTimeout(() => {
      void prepareAnimationPreview(data.filePath!, sheet, processing).then((value) => {
        if (!active) { value.dispose(); return; }
        prepared = value;
        setPreviewState({ key: requestKey, value });
      }).catch((reason: unknown) => {
        if (active) setPreviewState({ key: requestKey, error: reason instanceof Error ? reason.message : String(reason) });
      });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); prepared?.dispose(); };
  }, [data.filePath, processing, requestKey, sheet]);

  useEffect(() => {
    if (stopped || !src) return;
    const timer = window.setInterval(() => setPlayhead((position) => loop ? (position + 1) % enabled.length : Math.min(position + 1, enabled.length - 1)), 1000 / fps);
    return () => window.clearInterval(timer);
  }, [enabled.length, fps, loop, stopped, src]);

  const patchProcessing = (patch: Partial<AnimationProcessing>) => setProcessing((value) => ({ ...value, ...patch }));
  const patchFrame = (patch: Partial<AnimationFrameEdit>) => {
    if (patch.enabled === false && selectedEdit.enabled && enabled.length === 1) return;
    setEdits((values) => values.map((edit) => edit.sourceIndex === selectedEdit.sourceIndex ? { ...edit, ...patch } : edit));
  };
  const patchSheet = (patch: Partial<AnimationSheet>) => {
    const next = { ...sheet, ...patch };
    next.frameCount = Math.min(256, next.cols * next.rows, next.frameCount);
    setSheet(next);
    setEdits(Array.from({ length: next.frameCount }, (_, sourceIndex) => ({ sourceIndex, enabled: true, offsetX: 0, offsetY: 0 })));
    setSelected(0); setPlayhead(0);
  };
  const move = (delta: number) => {
    const from = edits.findIndex((edit) => edit.sourceIndex === selectedEdit.sourceIndex);
    const to = from + delta;
    if (to < 0 || to >= edits.length) return;
    const next = [...edits]; [next[from], next[to]] = [next[to], next[from]]; setEdits(next);
  };

  const isCurrentEditor = () => {
    const state = useAppStore.getState();
    return mounted.current && state.currentProjectId === projectId && state.getCurrentRevision() === baseRevision
      && state.nodes.find((node) => node.id === nodeId)?.data.filePath === data.filePath;
  };
  const apply = () => {
    const state = useAppStore.getState();
    if (!isCurrentEditor()) { state.showToast(t('画布已变化，请重新打开帧编辑器'), 'error'); return; }
    state.updateNodeData(nodeId, { animationSheet: sheet, animationProcessing: processing, animationEdits: edits, animationFps: fps, animationLoop: loop });
    onClose();
  };

  const importSheet = async () => {
    const state = useAppStore.getState();
    if (!isCurrentEditor()) { state.showToast(t('画布已变化，请重新打开帧编辑器'), 'error'); return; }
    const guard = registerCanvasDerivation(state, nodeId);
    if (!guard) { state.showToast(t('请先保存项目再导入动画'), 'error'); return; }
    setBusy(true);
    try {
      const result = await uploadSourceFileToProject('.png,.webp,.jpg,.jpeg', projectId);
      if (!result || !mounted.current || !isCanvasDerivationFresh(guard, useAppStore.getState())) return;
      if (!result.filePath) throw new Error(t('动画原图未保存到项目目录'));
      const checked = await prepareAnimationPreview(result.filePath, sheet, processing);
      try {
        if (!mounted.current || !isCanvasDerivationFresh(guard, useAppStore.getState())) return;
        useAppStore.getState().updateNodeData(nodeId, {
          imageUrl: result.dataUrl, thumbnailUrl: result.dataUrl, sourceUrl: result.dataUrl,
          filePath: result.filePath, fileName: result.fileName, imageWidth: checked.width, imageHeight: checked.height,
          animationSheet: sheet, animationProcessing: processing, animationEdits: edits, animationFps: fps, animationLoop: loop,
          status: 'success', error: undefined,
        });
        onClose();
      } finally { checked.dispose(); }
    } catch (reason) {
      if (mounted.current && isCanvasDerivationFresh(guard, useAppStore.getState())) state.showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally { completeCanvasDerivation(guard); if (mounted.current) setBusy(false); }
  };

  return <ModalOverlay isOpen onClose={onClose} ariaLabel={t('编辑帧动画')} className="animation-editor" draggable>
    <div className="ui-card__header animation-editor-header" data-modal-drag-handle>
      <span className="animation-editor-icon"><Icon icon="mdi:animation-play-outline" width="20" /></span>
      <div className="min-w-0 flex-1"><h2 className="text-sm font-medium">{t('帧动画')}</h2><p className="ui-hint truncate">{actionLabel} · {t('{count} 帧', { count: enabled.length })} · {sheet.cols} × {sheet.rows}</p></div>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => void importSheet()}><Icon icon="mdi:tray-arrow-up" width="14" />{busy ? t('正在导入') : t('导入精灵图')}</button>
      <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={busy} onClick={() => {
        if (!isCurrentEditor()) { useAppStore.getState().showToast(t('画布已变化，请重新打开帧编辑器'), 'error'); return; }
        onClose(); useAppStore.getState().openNodeDialog(nodeId);
      }}><Icon icon="mdi:creation-outline" width="14" />{t('生成帧动画')}</button>
      <PopupCloseButton onClick={onClose} />
    </div>
    <div className="animation-editor-workspace">
      <section className="animation-editor-preview-panel" aria-label={t('动画预览')}>
        <div className="animation-editor-toolbar p-3">
          <div className="flex items-center gap-1">
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('上一帧')} disabled={!src} onClick={() => stepFrame(-1)}><Icon icon="mdi:skip-previous" width="16" /></button>
            <button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={!src} onClick={() => { setPlaying(stopped); if (stopped) setPlayhead(0); }}><Icon icon={stopped ? 'mdi:play' : 'mdi:pause'} width="16" />{stopped ? t('播放') : t('暂停')}</button>
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('下一帧')} disabled={!src} onClick={() => stepFrame(1)}><Icon icon="mdi:skip-next" width="16" /></button>
            <span className="ui-hint tabular-nums ml-1">{edits.indexOf(current) + 1} / {edits.length}</span>
          </div>
          <div className="flex items-center gap-3">
            <NumberStepper value={fps} min={1} max={24} unit="fps" aria-label={t('播放帧率')} onChange={setFps} size="sm" />
            <div className="animation-editor-check"><input id={`${nodeId}-loop`} className="ui-checkbox" type="checkbox" checked={loop} onChange={(event) => { setLoop(event.target.checked); setPlayhead(0); }} /><label htmlFor={`${nodeId}-loop`}>{t('循环播放')}</label></div>
            <button type="button" className={`ui-btn ui-btn--ghost ui-btn--sm${guides ? ' is-active' : ''}`} aria-label={t('显示对齐辅助线')} aria-pressed={guides} onClick={() => setGuides((value) => !value)}><Icon icon="mdi:vector-line" width="16" /></button>
          </div>
        </div>
        <div className="animation-editor-stage">
          {src ? <div className="animation-editor-preview animation-cell" style={{ aspectRatio: `${layout.cellWidth} / ${layout.cellHeight}`, width: `min(100cqw, ${100 * layout.cellWidth / layout.cellHeight}cqh)` }}>
            <img src={src} alt={t('动画预览')} className="animation-frame-sheet" style={animationFrameStyle(layout, current)} draggable={false} />
            {guides && <><span className="animation-anchor-axis" />{processing.ground && <span className="animation-anchor-baseline" style={{ bottom: `${processing.margin * 100}%` }} />}</>}
          </div> : <div className="ui-empty"><Icon icon="mdi:animation-play-outline" width="40" /><span className="text-sm">{t('开始制作帧动画')}</span><span className="ui-hint">{t('导入精灵图，或选择模型生成角色动作')}</span></div>}
        </div>
        <div className="animation-editor-status px-3 pb-3" aria-live="polite">
          {error ? <span className="ui-error" role="alert">{error}</span>
            : data.filePath && !preview ? <span className="ui-hint">{t('正在处理动画预览')}</span>
              : preview?.warnings.length ? <span className="ui-hint">{preview.warnings.join('；')}</span>
                : <span className="ui-hint">{t('点击下方帧卡片，暂停并编辑此帧')}</span>}
          <span className="ui-hint tabular-nums">{Math.round(layout.cellWidth)} × {Math.round(layout.cellHeight)} px</span>
        </div>
      </section>
      <aside className="animation-editor-sidebar p-3 ui-stack" aria-label={t('帧动画参数')}>
        <section className="ui-card">
          <div className="ui-card__header flex items-center justify-between"><span>{t('选中帧')}</span><span className="ui-badge ui-badge--primary">{String(selectedPosition + 1).padStart(2, '0')}</span></div>
          <div className="ui-card__body ui-stack">
            <div className="flex items-center justify-between gap-2"><div className="animation-editor-check"><input id={`${nodeId}-enabled`} className="ui-checkbox" type="checkbox" checked={selectedEdit.enabled} disabled={selectedEdit.enabled && enabled.length === 1} onChange={(event) => patchFrame({ enabled: event.target.checked })} /><label htmlFor={`${nodeId}-enabled`}>{t('保留此帧')}</label></div><span className="ui-hint">{t('原帧')} {selectedEdit.sourceIndex + 1}</span></div>
            <label className="animation-editor-field"><span className="ui-label">{t('横向偏移')}</span><NumberStepper value={selectedEdit.offsetX} min={-layout.cellWidth} max={layout.cellWidth} unit="px" aria-label={t('帧横向偏移')} onChange={(offsetX) => patchFrame({ offsetX })} size="sm" /></label>
            <label className="animation-editor-field"><span className="ui-label">{t('纵向偏移')}</span><NumberStepper value={selectedEdit.offsetY} min={-layout.cellHeight} max={layout.cellHeight} unit="px" aria-label={t('帧纵向偏移')} onChange={(offsetY) => patchFrame({ offsetY })} size="sm" /></label>
            <div className="flex items-center gap-1"><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={selectedPosition === 0} onClick={() => move(-1)}><Icon icon="mdi:arrow-left" width="13" />{t('前移')}</button><button type="button" className="ui-btn ui-btn--secondary ui-btn--sm" disabled={selectedPosition === edits.length - 1} onClick={() => move(1)}>{t('后移')}<Icon icon="mdi:arrow-right" width="13" /></button><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ml-auto" onClick={() => patchFrame({ offsetX: 0, offsetY: 0 })}>{t('重置偏移')}</button></div>
          </div>
        </section>
        <section className="ui-card">
          <div className="ui-card__header">{t('角色对齐')}</div>
          <div className="ui-card__body ui-stack">
            <label className="ui-field"><span className="ui-label">{t('横向锚点')}</span><Select value={processing.alignment} onChange={(alignment) => patchProcessing({ alignment })} options={[
              { value: 'foot', label: t('脚部 Alpha 中心') }, { value: 'alpha', label: t('整体 Alpha 质心') }, { value: 'none', label: t('保留原始位置') },
            ]} /></label>
            <div className="animation-editor-check"><input id={`${nodeId}-ground`} className="ui-checkbox" type="checkbox" checked={processing.ground} onChange={(event) => patchProcessing({ ground: event.target.checked })} /><label htmlFor={`${nodeId}-ground`}>{t('统一脚底基线')}</label></div>
            <label className="animation-editor-field"><span className="ui-label">{t('安全边距')}</span><NumberStepper value={Math.round(processing.margin * 100)} min={0} max={20} unit="%" onChange={(margin) => patchProcessing({ margin: margin / 100 })} size="sm" /></label>
            <p className="ui-hint">{t('跳跃动作请关闭基线，保留上下轨迹。')}</p>
          </div>
        </section>
        <details className="ui-card animation-editor-source">
          <summary className="ui-card__header">{t('原图与切帧')}<Icon icon="mdi:chevron-down" width="16" /></summary>
          <div className="ui-card__body ui-stack">
            <label className="ui-field"><span className="ui-label">{t('背景清理')}</span><Select value={processing.chromaKey} onChange={(chromaKey) => patchProcessing({ chromaKey })} options={[
              { value: 'auto', label: t('自动检测') }, { value: 'magenta', label: t('品红底色') }, { value: 'green', label: t('绿色底色') }, { value: 'none', label: t('保留原始透明度') },
            ]} /></label>
            <label className="animation-editor-field"><span className="ui-label">{t('底色容差')}</span><NumberStepper value={processing.keyThreshold} min={1} max={160} onChange={(keyThreshold) => patchProcessing({ keyThreshold })} size="sm" /></label>
            <label className="ui-field"><span className="ui-label">{t('切帧方式')}</span><Select value={processing.segmentation} onChange={(segmentation) => patchProcessing({ segmentation })} options={[
              { value: 'projection', label: t('寻找透明间隔') }, { value: 'grid', label: t('严格等分宫格') },
            ]} /></label>
            <label className="animation-editor-field"><span className="ui-label">{t('宫格列数')}</span><NumberStepper value={sheet.cols} min={1} max={32} onChange={(cols) => patchSheet({ cols })} size="sm" /></label>
            <label className="animation-editor-field"><span className="ui-label">{t('宫格行数')}</span><NumberStepper value={sheet.rows} min={1} max={32} onChange={(rows) => patchSheet({ rows })} size="sm" /></label>
            <label className="animation-editor-field"><span className="ui-label">{t('原图帧数')}</span><NumberStepper value={sheet.frameCount} min={1} max={Math.min(256, sheet.cols * sheet.rows)} onChange={(frameCount) => patchSheet({ frameCount })} size="sm" /></label>
            <p className="ui-hint">{t('调整宫格会重置帧排序与偏移。')}</p>
          </div>
        </details>
      </aside>
    </div>
    <section className="animation-editor-timeline p-3" aria-label={t('帧序列')}>
      <div className="flex items-center justify-between gap-2 mb-2"><span className="ui-label">{t('帧序列')} <span className="ui-hint ml-1">{enabled.length} / {edits.length}</span></span><span className="ui-hint">{t('选择帧后可调整顺序、偏移或停用')}</span></div>
      <div className="animation-editor-frames" role="group" aria-label={t('帧列表')}>
        {edits.map((edit, index) => <button type="button" key={edit.sourceIndex} className={`ui-card p-2 animation-editor-tile${selected === edit.sourceIndex ? ' is-selected' : ''}${edit.enabled ? '' : ' is-disabled'}`} aria-pressed={selected === edit.sourceIndex} onClick={() => { setSelected(edit.sourceIndex); setPlaying(false); }}>
          <div className="animation-editor-tile-image animation-cell">{src && <div className="animation-editor-tile-crop animation-cell" style={{ aspectRatio: `${layout.cellWidth} / ${layout.cellHeight}`, width: `min(100cqw, ${100 * layout.cellWidth / layout.cellHeight}cqh)` }}><img src={src} alt="" className="animation-frame-sheet" style={animationFrameStyle(layout, edit)} draggable={false} /></div>}</div>
          <span className="animation-editor-tile-label"><span>{String(index + 1).padStart(2, '0')}</span><span>{t('原帧')} {edit.sourceIndex + 1}{edit.enabled ? '' : ` · ${t('已停用')}`}</span></span>
        </button>)}
      </div>
    </section>
    <div className="ui-card__footer animation-editor-footer p-3">
      <span className="ui-hint flex items-center gap-2"><Icon icon="mdi:shield-check-outline" width="14" />{t('原图保留，应用后可撤销')}</span>
      <div className="flex gap-2"><button type="button" className="ui-btn ui-btn--ghost" onClick={onClose}>{t('取消')}</button><button type="button" className="ui-btn ui-btn--primary" disabled={busy || !!error || (!!data.filePath && !preview)} onClick={apply}>{t('应用')}</button></div>
    </div>
  </ModalOverlay>;
}
