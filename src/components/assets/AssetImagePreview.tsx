import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AssetFileEntry } from '../../services/fileService';
import type { HistoryRecord } from '../../services/indexedDbService';
import { describeAssetImageHistory, loadAssetImageDetails, resolvePromptImageReferences } from '../../services/assetImageDetails';
import { useAppStore } from '../../store/useAppStore';
import type { AssetImageLoadedDetails, AssetImageReferenceView } from '../../types/assetImage';
import { MAX_ASSET_IMAGE_PROMPT, MAX_ASSET_IMAGE_REFERENCES, pickAssetImageReferences, previewPendingAssetImageReferences, resolveAssetImageReferences } from '../../services/fs/assetImageMetadata';
import { copyText } from '../../services/clipboardService';
import { formatSize } from '../../utils/assetFormat';
import ModalOverlay from '../shared/ModalOverlay';
import ZoomableImage from '../shared/ZoomableImage';
import { getNodeMetaMap } from '../nodes/shared/mentionEditorDom';
import { renderPromptWithChips } from '../nodes/shared/PromptChipViewer';

/** 资产库专用图片预览。列表与画布保留原状态，历史信息按图片身份只读加载。 */
export default function AssetImagePreview({ files, initialPath, projectId: fallbackProjectId, projectIdForFile, onClose }: {
  files: AssetFileEntry[];
  initialPath: string;
  projectId?: string;
  projectIdForFile?: (file: AssetFileEntry) => string | undefined;
  onClose: () => void;
}) {
  const [activePath, setActivePath] = useState(initialPath);
  const [retry, setRetry] = useState(0);
  const [imageRetry, setImageRetry] = useState(0);
  const [failedImage, setFailedImage] = useState('');
  const [dimensions, setDimensions] = useState<{ key: string; width: number; height: number } | null>(null);
  const [metadata, setMetadata] = useState<{ key: string; history: HistoryRecord | null; saved: AssetImageLoadedDetails | null; error: boolean } | null>(null);
  const [copyStatus, setCopyStatus] = useState<{ key: string; message: string } | null>(null);
  const saveAction = useAppStore((state) => state.saveAssetImageDetails);
  const nodes = useAppStore((state) => state.nodes ?? []);
  const dramaAssets = useAppStore((state) => state.dramaAssets);
  const nodeMetaMap = useMemo(() => getNodeMetaMap(nodes), [nodes]);
  const [promptReferences, setPromptReferences] = useState<AssetImageReferenceView[]>([]);
  const [draft, setDraft] = useState<{ key: string; prompt: string; references: AssetImageReferenceView[]; pending: Array<{ path: string; name: string; url: string }> } | null>(null);
  const [operation, setOperation] = useState<{ key: string; message: string; busy: boolean } | null>(null);
  const [referenceState, setReferencePreview] = useState<{ key: string; url: string; name: string } | null>(null);
  const [leaveRequest, setLeaveRequest] = useState<{ direction?: -1 | 1 } | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const activeKeyRef = useRef('');
  const draftRef = useRef(false);
  const leavePanelRef = useRef<HTMLDivElement | null>(null);
  const promptHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const infoContentRef = useRef<HTMLDivElement | null>(null);
  const index = files.findIndex((file) => file.path === activePath);
  const file = files[index];
  const projectId = file ? projectIdForFile?.(file) ?? fallbackProjectId : fallbackProjectId;
  const queryKey = JSON.stringify([file?.path, file?.assetUrl, projectId, retry]);
  const referencePreview = referenceState?.key === queryKey ? referenceState : null;
  const imageKey = JSON.stringify([file?.path, file?.assetUrl, imageRetry]);
  const history = metadata?.key === queryKey ? metadata.history : null;
  const saved = metadata?.key === queryKey ? metadata.saved : null;
  const editing = draft?.key === queryKey;
  const busy = operation?.key === queryKey && operation.busy;
  const prompt = saved?.record?.prompt ?? history?.prompt ?? '';
  const referenceViews = useMemo(() => {
    if (editing) return draft?.references ?? [];
    const savedRefs = saved?.references ?? [];
    if (savedRefs.length === 0) return promptReferences;
    const seenUrls = new Set(savedRefs.map((r) => r.url).filter(Boolean));
    const merged = [...savedRefs];
    for (const ref of promptReferences) {
      if (ref.url && !seenUrls.has(ref.url)) {
        seenUrls.add(ref.url);
        merged.push(ref);
      }
    }
    return merged;
  }, [editing, draft?.references, saved?.references, promptReferences]);
  const canEdit = !!saved?.identity && metadata?.key === queryKey && !metadata.error;

  const loading = metadata?.key !== queryKey;
  const metadataError = metadata?.key === queryKey && metadata.error;
  const details = useMemo(() => history ? describeAssetImageHistory(history) : [], [history]);
  const close = useCallback(() => {
    if (draftRef.current) { setLeaveRequest({}); return; }
    onClose();
  }, [onClose]);
  const navigate = useCallback((direction: -1 | 1) => {
    if (draftRef.current) { setLeaveRequest({ direction }); return; }
    setActivePath((path) => {
      const current = files.findIndex((entry) => entry.path === path);
      return current < 0 ? path : files[current + direction]?.path ?? path;
    });
  }, [files]);

  useEffect(() => {
    if (!file) { onClose(); return; }
    const controller = new AbortController();
    void loadAssetImageDetails(file, projectId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setMetadata({ key: queryKey, history: result.history, saved: result, error: false });
    }).catch(() => {
      if (!controller.signal.aborted) setMetadata({ key: queryKey, history: null, saved: null, error: true });
    });
    return () => controller.abort();
  }, [file, queryKey, projectId, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const effectiveProjectId = projectId || history?.projectId;
    void resolvePromptImageReferences(prompt, {
      nodes,
      dramaAssets,
      projectId: effectiveProjectId,
      signal: controller.signal,
    }).then((refs) => {
      if (!controller.signal.aborted) setPromptReferences(refs);
    }).catch(() => {
      if (!controller.signal.aborted) setPromptReferences([]);
    });
    return () => controller.abort();
  }, [prompt, nodes, dramaAssets, projectId, history?.projectId]);

  useEffect(() => () => {
    operationRef.current?.abort();
    activeKeyRef.current = '';
  }, [queryKey]);
  useEffect(() => { draftRef.current = editing; activeKeyRef.current = queryKey; }, [editing, queryKey]);
  useEffect(() => {
    if (operation?.key === queryKey && operation.message === '已保存') {
      promptHeadingRef.current?.focus({ preventScroll: true });
      if (infoContentRef.current) infoContentRef.current.scrollTop = 0;
    }
  }, [operation, queryKey]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && leaveRequest) {
        const buttons = leavePanelRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
        if (buttons?.length) {
          const current = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
          buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
          event.preventDefault(); event.stopImmediatePropagation();
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (referencePreview) setReferencePreview(null); else if (leaveRequest) setLeaveRequest(null); else close(); return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return;
      if (referencePreview || leaveRequest || draftRef.current) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); event.stopImmediatePropagation(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
    };
    // 在背景画布与资产库的键盘监听器之前消费按键。
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [close, navigate, referencePreview, leaveRequest]);

  if (!file || !file.assetUrl) return null;
  const shownImageKey = referencePreview ? `${referencePreview.url}:${imageRetry}` : imageKey;
  const broken = failedImage === shownImageKey;
  const startEdit = () => {
    setDraft({ key: queryKey, prompt, references: saved?.references ?? [], pending: [] });
    setOperation(null);
  };
  const addReferences = async () => {
    if (!editing || busy) return;
    const key = queryKey;
    setOperation({ key, message: '正在选择参考图…', busy: true });
    try {
      const paths = await pickAssetImageReferences();
      if (activeKeyRef.current !== key) return;
      if (draft.references.length + draft.pending.length + paths.length > MAX_ASSET_IMAGE_REFERENCES) throw new Error('最多添加 16 张参考图');
      const views = await previewPendingAssetImageReferences(paths);
      if (activeKeyRef.current !== key) return;
      setDraft((current) => current?.key === key ? { ...current, pending: [...current.pending, ...views] } : current);
      setOperation(null);
    } catch { if (activeKeyRef.current === key) setOperation({ key, message: '添加失败，请检查图片类型、数量或访问权限后重试', busy: false }); }
  };
  const saveEdit = async () => {
    if (!editing || !saved?.identity || busy) return;
    const key = queryKey;
    const controller = new AbortController();
    operationRef.current = controller;
    setOperation({ key, message: '正在保存…', busy: true });
    try {
      const record = await saveAction(file, { identity: saved.identity, record: saved.record, prompt: draft.prompt,
        references: draft.references.map(({ id, name, relativePath, digest, bytes }) => ({ id, name, relativePath, digest, bytes })), newReferencePaths: draft.pending.map((reference) => reference.path) }, {
        signal: controller.signal, onProgress: ({ transferredBytes, totalBytes }) => {
          if (activeKeyRef.current === key) setOperation({ key, message: totalBytes ? `正在复制参考图 ${Math.round(transferredBytes / totalBytes * 100)}%` : '正在复制参考图…', busy: true });
        },
      });
      // 事务已经提交后，取消或预览读取失败不能把成功保存报告成失败。
      if (activeKeyRef.current !== key) return;
      setMetadata({ key, history, saved: { ...saved, record, references: record.references.map((reference) => ({ ...reference, url: null })), warning: null }, error: false });
      setDraft(null); setOperation({ key, message: '已保存', busy: false });
      const references = await resolveAssetImageReferences(record.references, controller.signal).catch(() => record.references.map((reference) => ({ ...reference, url: null })));
      if (activeKeyRef.current !== key) return;
      setMetadata({ key, history, saved: { ...saved, record, references, warning: null }, error: false });
    } catch {
      if (activeKeyRef.current === key) setOperation({ key, message: controller.signal.aborted ? '已取消，草稿仍保留' : '保存失败：原图可能已变化、信息发生冲突或目录不可用。草稿仍保留，可重试或取消编辑。', busy: false });
    } finally { if (operationRef.current === controller) operationRef.current = null; }
  };
  const pixelSize = dimensions?.key === imageKey ? `${dimensions.width} × ${dimensions.height}` : null;

  return <ModalOverlay isOpen onClose={close} ariaLabel="图片与生成信息" className="asset-image-preview"
    zIndex={360} motionPreset="quick" backdropBlur={false} closeOnBackdrop={false}>
    <img className="asset-image-preview-backdrop" src={file.assetUrl} alt="" aria-hidden="true" />
    <div className="asset-image-preview-layout">
      <div className="asset-image-preview-stage" onLoadCapture={(event) => {
        const image = event.target as HTMLImageElement;
        if (!referencePreview && image.tagName === 'IMG' && image.naturalWidth > 0 && image.naturalHeight > 0) {
          setDimensions({ key: imageKey, width: image.naturalWidth, height: image.naturalHeight });
        }
      }}>
        {broken ? <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-3 text-canvas-text-secondary">
          <Icon icon="lucide:image-off" className="h-8 w-8" aria-hidden="true" />
          <p>图片加载失败</p><button type="button" className="ui-btn ui-btn--sm" onClick={() => setImageRetry((value) => value + 1)}>重新加载图片</button>
        </div> : <ZoomableImage key={shownImageKey} src={referencePreview?.url ?? file.assetUrl} alt={referencePreview?.name ?? file.name} className="fullscreen-img-view"
          onError={() => setFailedImage(shownImageKey)} />}
        {referencePreview && <button type="button" className="ui-btn absolute left-3 top-3" onClick={() => setReferencePreview(null)}><Icon icon="lucide:arrow-left" aria-hidden="true" />返回原图</button>}
      </div>
      <aside className="asset-image-preview-info" aria-label="图片提示词和参数">
        <header className="flex shrink-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas-hover text-canvas-text-secondary"><Icon icon="lucide:image" className="h-4 w-4" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1"><h1 className="break-words text-sm font-semibold text-canvas-text">{file.name}</h1>
            <p className="pt-1 text-xs text-canvas-text-muted" aria-live="polite">{index + 1} / {files.length}</p></div>
          <button type="button" className="ui-close-btn" aria-label="关闭图片预览" title="关闭（Esc）" onClick={close}><Icon icon="lucide:x" aria-hidden="true" /></button>
        </header>
        <div ref={infoContentRef} className="asset-image-preview-info-content">
          <section className="ui-card asset-image-preview-section p-3" aria-label="提示词">
            <div className="flex items-center justify-between gap-2 pb-2"><h2 ref={promptHeadingRef} tabIndex={-1} className="flex items-center gap-2 text-xs font-medium text-canvas-text-secondary"><Icon icon="lucide:sparkles" className="h-3.5 w-3.5" aria-hidden="true" />提示词</h2>
              <button type="button" className="ui-btn ui-btn--sm" disabled={!prompt.trim()} onClick={() => {
                if (!prompt) return;
                const key = queryKey;
                void copyText(prompt).then((copied) => setCopyStatus({ key, message: copied ? '提示词已复制' : '复制失败，请重试' }));
              }}><Icon icon="lucide:copy" aria-hidden="true" />复制提示词</button>
            </div>
            {!loading && !metadataError && (referenceViews.length > 0 || editing) && <div className="asset-image-preview-references">
              {referenceViews.map((reference) => <div className="asset-image-preview-reference" key={reference.id}>
                <button type="button" aria-label={`查看参考图 ${reference.name}`} title={`查看参考图 ${reference.name}`} disabled={!reference.url} onClick={() => setReferencePreview({ key: queryKey, url: reference.url!, name: reference.name })}>
                  {reference.url ? <img src={reference.url} alt={reference.name} /> : <span className="text-xs text-canvas-text-muted">参考图不可用</span>}
                </button>
                {editing && <button type="button" className="ui-close-btn asset-image-preview-reference-remove" disabled={busy} aria-label={`移除参考图 ${reference.name}`}
                  onClick={() => setDraft((current) => current ? { ...current, references: current.references.filter((item) => item.id !== reference.id) } : current)}><Icon icon="lucide:x" aria-hidden="true" /></button>}
              </div>)}
              {editing && draft.pending.map((reference, i) => <div className="asset-image-preview-reference" key={`${i}:${reference.path}`}>
                <button type="button" aria-label={`查看待保存参考图 ${reference.name}`} onClick={() => setReferencePreview({ key: queryKey, url: reference.url, name: reference.name })}><img src={reference.url} alt={reference.name} /></button>
                <button type="button" className="ui-close-btn asset-image-preview-reference-remove" disabled={busy} aria-label={`移除待保存参考图 ${reference.name}`}
                  onClick={() => setDraft((current) => current ? { ...current, pending: current.pending.filter((_, index) => index !== i) } : current)}><Icon icon="lucide:x" aria-hidden="true" /></button>
              </div>)}
              {editing && <button type="button" className="ui-icon-btn asset-image-preview-add-reference" aria-label="添加参考图" title="添加本地参考图" disabled={busy} onClick={() => void addReferences()}><Icon icon="lucide:plus" aria-hidden="true" /></button>}
            </div>}
            {loading ? <p role="status" className="text-xs text-canvas-text-muted">正在读取生成信息…</p>
              : metadataError ? <div role="alert" className="space-y-2 text-xs text-canvas-text-secondary"><p>生成信息读取失败</p>
                <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setRetry((value) => value + 1)}>重试读取</button></div>
              : editing ? <textarea className="ui-textarea asset-image-preview-editor" aria-label="编辑图片提示词" value={draft.prompt} maxLength={MAX_ASSET_IMAGE_PROMPT} disabled={busy}
                onChange={(event) => setDraft((current) => current ? { ...current, prompt: event.target.value } : current)} />
              : <p className="asset-image-preview-prompt whitespace-pre-wrap break-words text-sm leading-relaxed text-canvas-text">{renderPromptWithChips(prompt, {
                  nodes,
                  dramaAssets,
                  nodeMetaMap,
                  emptyText: saved?.record ? '尚未填写提示词' : history ? '此记录未保存提示词' : '暂无生成信息',
                  onPreviewImage: (preview) => setReferencePreview({ key: queryKey, url: preview.url, name: preview.name }),
                })}</p>}
            {saved?.warning && <p className="pt-2 text-xs text-canvas-text-muted">{saved.warning}</p>}
            {canEdit && <div className="flex justify-end gap-2 pt-2">
              {editing ? <><button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => { setDraft(null); setOperation(null); }}>取消编辑</button>
                <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => void saveEdit()}>保存</button></>
                : <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={startEdit}><Icon icon="lucide:pencil" aria-hidden="true" />编辑提示词与参考图</button>}
            </div>}
            {operation?.key === queryKey && <div className="pt-2 text-xs text-canvas-text-secondary" role="status">{operation.message}{busy && operation.message !== '正在选择参考图…' && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => operationRef.current?.abort()}>取消保存</button>}</div>}
            {copyStatus?.key === queryKey && <p role="status" className="pt-2 text-xs text-canvas-text-secondary">{copyStatus.message}</p>}
          </section>
          <section className="asset-image-preview-parameters" aria-label="生成参数">
            <h2 className="flex items-center gap-2 pb-3 text-xs font-medium text-canvas-text-secondary"><Icon icon="lucide:info" className="h-3.5 w-3.5" aria-hidden="true" />参数与文件信息</h2>
            <dl className="ui-card asset-image-preview-section space-y-3 p-3 text-sm">
              {details.map(({ label, value }) => <div className="flex items-start justify-between gap-3" key={label}>
                <dt className="shrink-0 text-canvas-text-muted">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-right text-canvas-text">{value}</dd>
              </div>)}
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">图片尺寸</dt><dd className="text-canvas-text">{pixelSize ?? (broken ? '无法读取' : '正在读取…')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">文件大小</dt><dd className="text-canvas-text">{file.size > 0 ? formatSize(file.size) : '未知'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-canvas-text-muted">来源</dt><dd className="text-canvas-text">{file.source === 'folder' ? '外部文件夹' : file.source === 'global' ? '导入文件' : '项目文件'}</dd></div>
            </dl>
            {!loading && !metadataError && !history && !saved?.record && <p className="pt-3 text-xs leading-relaxed text-canvas-text-muted">此图片未关联到保留的生成记录，可手动编辑提示词和参考图。</p>}
          </section>
        </div>
        <footer className="asset-image-preview-footer">
          <p className="pb-2 text-center text-xs text-canvas-text-muted">双击缩放 · 拖动查看 · Esc 关闭</p>
          <div className="flex gap-2">
            <button type="button" className="ui-btn ui-btn--block" aria-label="上一张图片" title="上一张（←）" disabled={index <= 0} onClick={() => navigate(-1)}><Icon icon="lucide:arrow-left" aria-hidden="true" />上一张</button>
            <button type="button" className="ui-btn ui-btn--primary ui-btn--block" aria-label="下一张图片" title="下一张（→）" disabled={index >= files.length - 1} onClick={() => navigate(1)}>下一张<Icon icon="lucide:arrow-right" aria-hidden="true" /></button>
          </div>
        </footer>
      </aside>
    </div>
    {leaveRequest && <ModalOverlay isOpen onClose={() => setLeaveRequest(null)} ariaLabel="未保存的图片信息" zIndex={370} closeOnBackdrop={false}>
      <div ref={leavePanelRef} role="alertdialog" className="ui-card p-3 space-y-3"><p className="text-sm text-canvas-text">图片信息尚未保存，要放弃这次编辑吗？</p>
        <div className="flex justify-end gap-2"><button type="button" className="ui-btn" onClick={() => setLeaveRequest(null)}>继续编辑</button>
          <button type="button" className="ui-btn ui-btn--danger" disabled={busy} onClick={() => {
            const direction = leaveRequest.direction; setDraft(null); draftRef.current = false; setLeaveRequest(null);
            if (direction) navigate(direction); else onClose();
          }}>放弃编辑</button></div>
      </div>
    </ModalOverlay>}
  </ModalOverlay>;
}
