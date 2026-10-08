import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AssetFileEntry } from '../../services/fileService';
import type { AssetImageBatchEntry, AssetImageBatchStatus } from '../../types/assetImage';
import { resolveVisionTextModel } from '../../services/ai/reversePrompt';
import { findBatchImagesWithPrompts, runAssetImageReverseBatch } from '../../services/assetImageBatchReverse';
import { useAppStore } from '../../store/useAppStore';
import ModelSelector from '../nodes/shared/ModelSelector';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';

const STATUS_LABELS: Record<AssetImageBatchStatus, string> = {
  queued: '待生成', running: '正在反推', saving: '正在保存', success: '已替换并保存', failed: '失败', cancelled: '已停止',
};

/** 当前筛选结果的快照；关闭或卸载时取消队列，不把后台控制器持久化。 */
export default function AssetImageBatchReverseDialog({ entries, onSaved, onClose }: {
  entries: AssetImageBatchEntry[];
  onSaved: (file: AssetFileEntry, tags: string[]) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [existingPrompts, setExistingPrompts] = useState<Set<number>>(() => new Set());
  const [checkingPrompts, setCheckingPrompts] = useState(true);
  const [promptCheckFailed, setPromptCheckFailed] = useState(false);
  const [promptCheckRetry, setPromptCheckRetry] = useState(0);
  const [rows, setRows] = useState<Array<{ status: AssetImageBatchStatus; message?: string }>>(() => entries.map(() => ({ status: 'queued' })));
  const [model, setModel] = useState(resolveVisionTextModel);
  const [concurrency, setConcurrency] = useState('3');
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState('');
  const [visibleCount, setVisibleCount] = useState(60);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const save = useAppStore((state) => state.saveAssetImageDetails);
  useEffect(() => {
    const controller = new AbortController();
    void findBatchImagesWithPrompts(entries, controller.signal).then((existing) => {
      if (controller.signal.aborted) return;
      setExistingPrompts(existing);
      setSelected(new Set(entries.map((_, index) => index).filter((index) => !existing.has(index))));
      setCheckingPrompts(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setPromptCheckFailed(true); setCheckingPrompts(false);
    });
    return () => controller.abort();
  }, [entries, promptCheckRetry]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);
  const close = useCallback(() => { controllerRef.current?.abort(); onClose(); }, [onClose]);
  useEffect(() => {
    // 比资产弹窗先消费 Esc，避免连带关闭下层资源窗口。
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [close]);

  const counts = { success: 0, failed: 0, pending: 0 };
  selected.forEach((index) => {
    if (rows[index].status === 'success') counts.success++;
    else if (rows[index].status === 'failed') counts.failed++;
    else counts.pending++;
  });
  const pending = [...selected].filter((index) => rows[index].status === 'queued' || rows[index].status === 'cancelled');
  const failed = [...selected].filter((index) => rows[index].status === 'failed');
  const start = async (indices: number[]) => {
    if (controllerRef.current || checkingPrompts || promptCheckFailed || !model?.model || !model.provider || !indices.length) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true); setStopping(false); setMessage('');
    setRows((current) => current.map((row, index) => indices.includes(index) ? { status: 'queued' } : row));
    try {
      await runAssetImageReverseBatch(indices.map((index) => entries[index]), {
        ...model, concurrency: Number(concurrency), signal: controller.signal, save,
        onUpdate: (index, status, detail) => {
          if (!mountedRef.current || controllerRef.current !== controller) return;
          setRows((current) => current.map((row, rowIndex) => rowIndex === indices[index] ? { status, message: detail } : row));
          if (status === 'success') setExistingPrompts((current) => new Set(current).add(indices[index]));
        },
        onSaved: (file, tags) => { if (mountedRef.current) onSaved(file, tags); },
      });
      if (mountedRef.current) setMessage(controller.signal.aborted ? '已停止，已保存的结果保留。可继续处理剩余图片。' : '本轮处理完成。失败项可单独重试。');
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) {
        const detail = error instanceof Error ? error.message : '批量反推启动失败';
        setMessage(detail);
        setRows((current) => current.map((row, index) => indices.includes(index) && row.status !== 'success' ? { status: 'failed', message: detail } : row));
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current) { setRunning(false); setStopping(false); }
    }
  };

  return <ModalOverlay isOpen onClose={close} closeOnBackdrop={false} ariaLabel="批量反推提示词和标签" zIndex={360}
    className="w-full max-w-3xl [&.glass-panel]:overflow-visible">
    <div className="ui-card flex max-h-[85vh] min-h-0 flex-col gap-3 p-3 [&.ui-card]:overflow-visible">
      <header className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-canvas-text"><Icon icon="lucide:sparkles" aria-hidden="true" />批量反推提示词和标签</h2>
        <button type="button" className="ui-close-btn" aria-label={running ? '关闭并停止批量反推' : '关闭批量反推'} onClick={close}><Icon icon="lucide:x" aria-hidden="true" /></button>
      </header>
      <p className="shrink-0 text-xs leading-relaxed text-canvas-text-secondary">来自当前文件夹或筛选结果，共 {entries.length} 张图片。已有提示词的图片默认不选中，可手动勾选替换。每张生成成功后直接替换并保存提示词和标签，参考图保留；失败项保留原内容。</p>
      <fieldset disabled={running} className="flex shrink-0 flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><label className="mb-2 block text-xs text-canvas-text-secondary">反推模型</label>
          <ModelSelector nodeType="ai-text" selectedModel={model?.model} selectedProvider={model?.provider} onSelect={(option) => setModel({ model: option.value, provider: option.provider })} /></div>
        <div><label className="mb-2 block text-xs text-canvas-text-secondary">同时处理</label>
          <Select value={concurrency} onChange={setConcurrency} disabled={running} aria-label="同时处理图片数" options={[3, 4, 5].map((value) => ({ value: String(value), label: `${value} 张` }))} /></div>
      </fieldset>
      <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-canvas-text-secondary">
        <span className="relative"><input id={`${id}-all`} type="checkbox" className="ui-checkbox" disabled={running || checkingPrompts || promptCheckFailed} checked={entries.length > 0 && selected.size === entries.length}
          onChange={(event) => setSelected(event.target.checked ? new Set(entries.map((_, index) => index)) : new Set())} /><label htmlFor={`${id}-all`}>全选</label></span>
        <span role="status" aria-live="polite">已选 {selected.size} · 成功 {counts.success} · 失败 {counts.failed} · 待处理 {counts.pending}</span>
        {checkingPrompts && <span role="status">正在识别已有提示词…</span>}
        {promptCheckFailed && <><span role="alert">提示词信息读取失败</span><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setCheckingPrompts(true); setPromptCheckFailed(false); setPromptCheckRetry((current) => current + 1); }}>重新读取</button></>}
      </div>
      <div className="ui-progress shrink-0" role="progressbar" aria-label="批量处理进度" aria-valuemin={0} aria-valuemax={selected.size || 1} aria-valuenow={counts.success + counts.failed}>
        <div className="ui-progress__bar" style={{ width: `${selected.size ? (counts.success + counts.failed) / selected.size * 100 : 0}%` }} />
      </div>
      <ul className="ui-list min-h-0 flex-1 overscroll-contain [&.ui-list]:overflow-y-auto" aria-label="待处理图片" aria-busy={checkingPrompts}>
        {entries.slice(0, visibleCount).map(({ file }, index) => <li key={file.assetId ?? file.path} className="ui-list__item shrink-0 text-left">
          <span className="relative shrink-0"><input id={`${id}-${index}`} type="checkbox" className="ui-checkbox" disabled={running || checkingPrompts || promptCheckFailed} checked={selected.has(index)}
            onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />
            <label htmlFor={`${id}-${index}`} aria-label={`选择 ${file.name}`} /></span>
          <img src={file.assetUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1"><p className="truncate text-xs text-canvas-text" title={file.name}>{file.name}</p>
            {rows[index].message && <p className="truncate text-xs text-canvas-text-secondary" title={rows[index].message}>{rows[index].message}</p>}</div>
          {existingPrompts.has(index) && <span className="ui-badge shrink-0">已有提示词</span>}
          <span className={`ui-badge shrink-0 ${rows[index].status === 'failed' ? 'ui-badge--danger' : rows[index].status === 'success' ? 'ui-badge--success' : 'ui-badge--primary'}`}>
            {(rows[index].status === 'running' || rows[index].status === 'saving') && <Icon icon="lucide:loader-circle" className="animate-spin" aria-hidden="true" />}{STATUS_LABELS[rows[index].status]}</span>
        </li>)}
        {visibleCount < entries.length && <li className="ui-list__item shrink-0"><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--block" onClick={() => setVisibleCount((current) => current + 60)}>显示更多（剩余 {entries.length - visibleCount} 张）</button></li>}
      </ul>
      {message && <p role="status" className="shrink-0 text-xs text-canvas-text-secondary">{message}</p>}
      <footer className="flex shrink-0 flex-wrap justify-end gap-2">
        <button type="button" className="ui-btn ui-btn--sm" onClick={close}>{running ? '关闭并停止' : '关闭'}</button>
        {running ? <button type="button" className="ui-btn ui-btn--sm" disabled={stopping} onClick={() => { setStopping(true); controllerRef.current?.abort(); }}>{stopping ? '正在停止…' : '停止'}</button>
          : <><button type="button" className="ui-btn ui-btn--sm" disabled={checkingPrompts || promptCheckFailed || !failed.length || !model?.model || !model.provider} onClick={() => void start(failed)}>重试失败项（{failed.length}）</button>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={checkingPrompts || promptCheckFailed || !pending.length || !model?.model || !model.provider} onClick={() => void start(pending)}>
              <Icon icon="lucide:sparkles" aria-hidden="true" />生成并替换（{pending.length}）</button></>}
      </footer>
    </div>
  </ModalOverlay>;
}
