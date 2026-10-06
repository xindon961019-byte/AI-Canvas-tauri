import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../store/useAppStore';
import { loadRecentAssets, type RecentAssetEntry } from '../../services/fs/recentAssets';
import { shortFolderName } from '../../utils/assetFormat';
import { useResourceVideoPreview } from '../../hooks/useResourceVideoPreview';
import AssetThumb from '../shared/AssetThumb';

const AssetImagePreview = lazy(() => import('./AssetImagePreview'));

/** 启动页的轻量资源入口；不扫描整个目录，不挂载画布或生成业务。 */
export default function RecentAssetsSection() {
  const { projects, folderRoots, revision, panelOpen, openLibrary, markUsed } = useAppStore(useShallow((state) => ({
    projects: state.projects, folderRoots: state.config.assetFolders,
    revision: state.recentAssetsRevision, panelOpen: state.assetsPanelOpen,
    openLibrary: state.setAssetsPanelOpen, markUsed: state.markAssetUsed,
  })));
  const scope = useMemo(() => ({ folderRoots: folderRoots ?? [], projectIds: projects.map((project) => project.id) }), [folderRoots, projects]);
  const scopeKey = JSON.stringify(scope);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ scope: string; entries: RecentAssetEntry[]; error: boolean }>();
  const [imageId, setImageId] = useState<string | null>(null);
  const entries = result?.scope === scopeKey ? result.entries : [];
  const image = entries.find((entry) => entry.file.assetId === imageId);
  if (imageId && !image) setImageId(null);
  const video = useResourceVideoPreview(scopeKey, entries.map((entry) => entry.file.assetId!));
  const showAll = useCallback(() => openLibrary(true, 'page', { tab: 'permanent', folder: { kind: 'all' } }), [openLibrary]);

  useEffect(() => {
    const request = new AbortController();
    void loadRecentAssets(scope, request.signal).then((items) => {
      if (!request.signal.aborted) setResult({ scope: scopeKey, entries: items, error: false });
    }, () => {
      if (!request.signal.aborted) setResult({ scope: scopeKey, entries: [], error: true });
    });
    return () => request.abort();
  }, [scope, scopeKey, revision, panelOpen, refresh]);
  useEffect(() => {
    const onFocus = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <section className="mt-6 border-t border-canvas-border pt-3" aria-label="最近使用资源">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon icon="mdi:folder-multiple-image" width="18" className="text-canvas-text-secondary" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-canvas-text">资源库</h2>
          <span className="text-xs text-canvas-text-muted">最近使用</span>
        </div>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={showAll}>
          进入资源库 <Icon icon="mdi:arrow-right" width="16" aria-hidden="true" />
        </button>
      </div>

      {entries.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {entries.map(({ file, projectId, usedAt }) => (
            <article key={file.assetId} className="ui-card ui-card--interactive min-w-0" data-recent-asset={file.assetId}>
              <div className="relative aspect-video overflow-hidden [&_.assets-card-img-wrap]:h-full [&_.assets-card-img]:h-full [&_.assets-card-icon-wrap]:h-full [&_.assets-card-text-wrap]:h-full [&_.resource-video-preview]:h-full">
                <AssetThumb name={file.name} category={file.category} assetUrl={file.assetUrl} filePath={file.path} size={file.size}
                  videoPresentation="fullscreen" videoProjectId={projectId} videoExpanded={video.expandedId === file.assetId}
                  onVideoExpandedChange={(expanded) => {
                    video.setExpanded(expanded ? file.assetId! : null);
                    if (expanded) { setImageId(null); void markUsed(file); }
                  }}
                  onImagePreview={file.category === 'image' ? () => {
                    video.setExpanded(null); setImageId(file.assetId!); void markUsed(file);
                  } : undefined} />
                {file.category !== 'image' && file.category !== 'video' && (
                  <button type="button" className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                    aria-label={`在资源库查看 ${file.name}`} onClick={() => openLibrary(true, 'page', projectId
                      ? { tab: 'project', projectId } : { tab: 'permanent', folder: file.source === 'folder' && file.folderRoot
                        ? { kind: 'folder', rootPath: file.folderRoot, relativePath: file.relativePath?.split('/').slice(0, -1).join('/') ?? '' } : { kind: 'all' } })} />
                )}
              </div>
              <div className="min-w-0 p-2">
                <p className="truncate text-[10px] text-canvas-text-muted" title={new Date(usedAt).toLocaleString()}>
                  {projectId ? projects.find((project) => project.id === projectId)?.name ?? '项目素材'
                    : file.folderRoot ? shortFolderName(file.folderRoot) : '全局资产'}
                </p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex min-h-28 flex-col justify-center gap-3 rounded-lg bg-canvas-surface p-3">
          <p className="text-xs text-canvas-text-muted" role={result?.error ? 'status' : undefined}>
            {!result || result.scope !== scopeKey ? '正在读取最近使用…' : result.error
              ? '最近使用读取失败，可直接进入资源库。' : '暂无最近使用素材。预览或成功拖入画布后，会显示在这里。'}
          </p>
          <div className="flex flex-wrap gap-2">
            {(folderRoots ?? []).slice(0, 6).map((root) => (
              <button key={root} type="button" className="ui-btn ui-btn--secondary ui-btn--sm max-w-48"
                onClick={() => openLibrary(true, 'page', { tab: 'permanent', folder: { kind: 'folder', rootPath: root, relativePath: '' } })}>
                <Icon icon="mdi:folder-outline" width="16" aria-hidden="true" /><span className="truncate">{shortFolderName(root)}</span>
              </button>
            ))}
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={showAll}>浏览资源库</button>
          </div>
        </div>
      )}
      {image && <Suspense fallback={<p role="status" className="mt-2 text-xs text-canvas-text-muted">正在打开图片预览…</p>}>
        <AssetImagePreview key={image.file.assetId} files={[image.file]} initialPath={image.file.path}
          projectId={image.projectId} onClose={() => setImageId(null)} />
      </Suspense>}
    </section>
  );
}
