import { memo, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { BaseNodeData } from '../../types';
import { useT } from '../../i18n';
import { normalizeAiAppReference } from '../../services/aiApps/aiAppSchema';
import AiAppDialog from './AiAppDialog';

function AiAppNode({ id, data, selected }: { id: string; data: BaseNodeData; selected?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const app = useMemo(() => {
    try { return normalizeAiAppReference(data.aiApp); }
    catch { return undefined; }
  }, [data.aiApp]);
  const result = app?.savedResult;
  const summary = result === undefined ? undefined
    : typeof result === 'string' ? result : JSON.stringify(result);

  return (
    <>
      <div
        className={`node-wrapper w-80 overflow-hidden rounded-xl border bg-canvas-card text-canvas-text shadow-xl ${selected ? 'border-brand' : 'border-canvas-border'}`}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (app) setOpen(true);
        }}
      >
        <header className="flex items-center gap-2 border-b border-canvas-border bg-canvas-surface p-3">
          <Icon icon="lucide:app-window" width={18} height={18} className="shrink-0 text-brand-light" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{app?.title || t('AI 应用')}</div>
            <div className="mt-0.5 text-[10px] text-canvas-text-muted">{t('AI 应用 · 由 Agent / MCP 创建')}</div>
          </div>
          {app && <span className="ui-badge ui-badge--outline">v{app.revision}</span>}
        </header>
        <div className="space-y-2 p-3">
          <p className="line-clamp-3 text-[11px] leading-5 text-canvas-text-secondary">
            {app?.description || t('应用定义不可用，请让 AI 修复这个节点。')}
          </p>
          {app && (
            <div className="flex items-center justify-between gap-2 text-[11px] text-canvas-text-muted">
              <span>{t('绑定 {count} 个画布素材', { count: app.inputNodeIds.length })}</span>
              <span>{t('{count} 个动作', { count: app.actions.length })}</span>
            </div>
          )}
          {summary !== undefined && (
            <div className="rounded-lg border border-canvas-border bg-canvas-surface p-2">
              <div className="mb-1 text-[10px] text-canvas-text-muted">{t('已保存的结果')}</div>
              <p className="line-clamp-3 break-words whitespace-pre-wrap text-[11px] leading-4 text-canvas-text-secondary">
                {summary.slice(0, 600)}
              </p>
            </div>
          )}
          <button
            type="button"
            className="ui-btn ui-btn--primary nodrag w-full"
            disabled={!app}
            onClick={(event) => { event.stopPropagation(); setOpen(true); }}
          >
            <Icon icon="lucide:expand" width={14} height={14} aria-hidden="true" />
            {t('打开应用')}
          </button>
        </div>
      </div>
      {open && app && (
        <AiAppDialog
          key={app.instanceId}
          nodeId={id}
          app={app}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export default memo(AiAppNode);
