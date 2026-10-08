import { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { AiAppReference, AiAppUiSession, AiAppUiSnapshot } from '../../types/aiApp';
import { resolveAppearanceMode, installSystemAppearanceListener } from '../../services/appearance/appearanceRuntime';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';

export default function AiAppDialog({ nodeId, app, onClose }: {
  nodeId: string;
  app: AiAppReference;
  onClose: () => void;
}) {
  const t = useT();
  const themeMode = useAppStore((state) => state.config.appearance?.mode ?? state.config.theme);
  const [session, setSession] = useState<AiAppUiSession | null>(null);
  const [snapshot, setSnapshot] = useState<AiAppUiSnapshot>({ busy: false });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<'run' | 'save' | null>(null);
  const [saved, setSaved] = useState(false);
  const sessionRef = useRef<AiAppUiSession | null>(null);
  const activeRef = useRef(true);
  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  const operationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    activeRef.current = true;
    void import('../../services/aiApps/aiAppRuntime').then(({ createAiAppUiSession }) => {
      if (cancelled || !activeRef.current || generationRef.current !== generation) return null;
      return createAiAppUiSession({
        nodeId,
        onChange: (next) => {
          if (cancelled || !activeRef.current || generationRef.current !== generation) return;
          if (next.closed) {
            operationRef.current += 1;
            pendingRef.current = false;
            setPending(null);
          }
          setSnapshot(next);
          setSaved(false);
        },
      });
    }).then((next) => {
      if (!next) return;
      if (cancelled || !activeRef.current || generationRef.current !== generation) {
        next.dispose();
        return;
      }
      sessionRef.current = next;
      setSession(next);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (cancelled || !activeRef.current || generationRef.current !== generation) return;
      setError(cause instanceof Error ? cause.message : t('应用加载失败'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
      activeRef.current = false;
      generationRef.current += 1;
      pendingRef.current = false;
      operationRef.current += 1;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [nodeId, app.instanceId, attempt, t]);

  useEffect(() => {
    const updateTheme = () => session?.updateTheme(resolveAppearanceMode(themeMode));
    updateTheme();
    if (themeMode === 'system') return installSystemAppearanceListener(updateTheme);
  }, [session, themeMode]);

  const close = () => {
    activeRef.current = false;
    generationRef.current += 1;
    pendingRef.current = false;
    operationRef.current += 1;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    onClose();
  };
  const ready = Boolean(session) && !snapshot.closed;
  const busy = !snapshot.closed && (snapshot.busy || pending !== null);

  const run = async (actionId: string) => {
    const current = sessionRef.current;
    if (!current || !ready || pendingRef.current || busy) return;
    const operation = ++operationRef.current;
    pendingRef.current = true;
    setPending('run');
    setError(undefined);
    setSaved(false);
    try {
      const result = await current.run(actionId);
      if (!activeRef.current || operationRef.current !== operation) return;
      setSnapshot({ busy: false, result, actionId });
    } catch (cause) {
      if (activeRef.current && operationRef.current === operation) {
        setError(cause instanceof Error ? cause.message : t('应用执行失败'));
      }
    } finally {
      if (activeRef.current && operationRef.current === operation) {
        pendingRef.current = false;
        setPending(null);
      }
    }
  };

  const save = async () => {
    const current = sessionRef.current;
    if (!current || !ready || pendingRef.current || busy) return;
    const operation = ++operationRef.current;
    pendingRef.current = true;
    setPending('save');
    setError(undefined);
    try {
      await current.save();
      if (activeRef.current && operationRef.current === operation) setSaved(true);
    } catch (cause) {
      if (activeRef.current && operationRef.current === operation) {
        setError(cause instanceof Error ? cause.message : t('保存失败'));
      }
    } finally {
      if (activeRef.current && operationRef.current === operation) {
        pendingRef.current = false;
        setPending(null);
      }
    }
  };

  const stop = () => {
    operationRef.current += 1;
    generationRef.current += 1;
    pendingRef.current = false;
    sessionRef.current?.cancel();
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPending(null);
    setSnapshot({ busy: false });
    setError(t('操作已停止，可重新加载应用'));
    setSaved(false);
  };
  const retry = () => {
    generationRef.current += 1;
    operationRef.current += 1;
    pendingRef.current = false;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
    setPending(null);
    setSnapshot({ busy: false });
    setError(undefined);
    setLoading(true);
    setSaved(false);
    setAttempt((value) => value + 1);
  };
  const result = snapshot.result === undefined ? app.savedResult : snapshot.result;
  const summary = result === undefined ? undefined
    : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const message = error || snapshot.error || (snapshot.closed ? t('应用已停止，请重新加载') : undefined);

  return (
    <ModalOverlay
      isOpen
      ariaLabel={app.title}
      onClose={close}
      className="h-[calc(100dvh-32px)] max-h-[1000px] w-[calc(100vw-32px)] max-w-[1400px] border-canvas-border"
      motionPreset="quick"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-canvas-border p-3">
        <Icon icon="lucide:app-window" width={18} height={18} className="shrink-0 text-brand-light" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-canvas-text">{app.title}</h2>
          <p className="mt-0.5 truncate text-[11px] text-canvas-text-muted">{app.description}</p>
        </div>
        <span className="ui-badge ui-badge--outline">v{app.revision}</span>
        <PopupCloseButton onClick={close} ariaLabel={t('关闭应用')} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas-bg">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border p-2">
          {app.actions.map((action) => {
            const needsInput = Boolean(action.inputSchema.required?.length);
            return (
              <button
                key={action.id}
                type="button"
                className="ui-btn ui-btn--secondary ui-btn--sm max-w-full"
                title={needsInput ? t('请在应用内填写参数，或由 Agent / MCP 传入参数') : action.description || action.title}
                disabled={!ready || busy || needsInput}
                onClick={() => { if (!needsInput) void run(action.id); }}
              >
                <span className="truncate">{action.title}{needsInput ? t('（需填写参数）') : ''}</span>
              </button>
            );
          })}
          <span role="status" className="ml-auto text-[11px] text-canvas-text-secondary">
            {loading ? t('正在加载应用…') : !ready ? t('应用未就绪') : busy ? t('处理中…') : t('就绪')}
          </span>
          <button type="button" className="ui-btn ui-btn--danger ui-btn--sm" disabled={!session || !busy || pending === 'save'} onClick={stop}>
            {t('停止')}
          </button>
          {app.actions.some((action) => action.inputSchema.required?.length) && (
            <p className="basis-full text-[11px] text-canvas-text-muted">{t('带必填参数的动作请在应用内填写，或由 Agent / MCP 传入参数。')}</p>
          )}
        </div>
        {message && (
          <div role="alert" className="ui-alert ui-alert--danger m-2">
            <span className="min-w-0 flex-1 break-words">{message}</span>
            {!loading && !busy && (
              <button
                type="button"
                className="ui-btn ui-btn--secondary ui-btn--sm"
                onClick={retry}
              >
                {t('重试')}
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1 bg-canvas-surface">
          {loading && <div className="ui-empty h-full"><span className="ui-spinner" aria-hidden="true" /><p>{t('正在加载应用…')}</p></div>}
          {session && (
            <iframe
              ref={(element) => session.attach(element?.contentWindow ?? null)}
              src={session.src}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              title={app.title}
              className="block h-full w-full border-0 bg-canvas-surface"
            />
          )}
        </div>
        {summary !== undefined && (
          <details className="shrink-0 border-t border-canvas-border p-2 text-[11px] text-canvas-text-secondary">
            <summary className="cursor-pointer">{t('结果摘要')}</summary>
            <pre className="ui-scroll mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas-card p-2">{summary.slice(0, 4000)}</pre>
          </details>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-canvas-border p-3">
        <span role={saved ? 'status' : undefined} className="text-[11px] text-canvas-text-muted">
          {saved ? t('状态与结果已保存') : t('关闭前可保存当前状态与结果')}
        </span>
        <button type="button" className="ui-btn ui-btn--primary" disabled={!ready || busy} onClick={() => void save()}>
          <Icon icon="lucide:save" width={14} height={14} aria-hidden="true" />
          {pending === 'save' ? t('保存中…') : t('保存状态与结果')}
        </button>
      </footer>
    </ModalOverlay>
  );
}
