import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '@iconify/react';
import { releaseViewportVideoElement } from './viewportVideoResource';

export interface VideoPlayerMetadata { width: number; height: number; duration: number }
export interface VideoPlayerProps {
  src?: string;
  poster?: string;
  name: string;
  autoPlay?: boolean;
  unavailable?: boolean;
  className?: string;
  onMetadata?: (metadata: VideoPlayerMetadata) => void;
  onError?: () => void;
  onEnded?: () => void;
  /** 全屏预览宿主可提供关闭入口；普通嵌入不拦截页面 Esc。 */
  onEscape?: () => void;
}

function timeLabel(seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function seekPreview(video: HTMLVideoElement | null, time: number) {
  if (video && video.readyState > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration);
}

function VideoSeekPreview({ src, time }: { src: string; time: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { seekPreview(videoRef.current, time); }, [time, src]);
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.src = src;
    return () => releaseViewportVideoElement(video);
  }, [src]);
  return <div className="ui-video-player__seek-preview" aria-hidden="true">
    {failed ? <span className="text-xs text-canvas-text-muted">预览不可用</span>
      : <video ref={videoRef} src={src} muted playsInline preload="metadata" tabIndex={-1} onLoadedMetadata={(event) => seekPreview(event.currentTarget, time)} onError={() => setFailed(true)} />}
    <span className="ui-video-player__seek-time">{timeLabel(time)}</span>
  </div>;
}

/** UI Kit 视频播放器：调用方提供可播放地址，不依赖 Store、文件服务或生成历史。 */
export default function VideoPlayer({ src, poster, name, autoPlay = false, unavailable = false, className = '', onMetadata, onError, onEnded, onEscape }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const progressInputRef = useRef<HTMLInputElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [menu, setMenu] = useState<'speed' | 'time' | null>(null);
  const [remainingTime, setRemainingTime] = useState(false);
  const [hover, setHover] = useState<{ ratio: number; time: number } | null>(null);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ src: string; width: number; height: number; duration: number } | null>(null);
  const mediaInfo = dimensions?.src === src ? dimensions : null;
  const duration = mediaInfo && Number.isFinite(mediaInfo.duration) && mediaInfo.duration > 0 ? mediaInfo.duration : 0;
  const played = duration ? Math.min(100, Math.max(0, time / duration * 100)) : 0;
  const buffered = duration ? Math.min(100, Math.max(played, bufferedEnd / duration * 100)) : 0;
  const silent = muted || volume === 0;
  const updateBuffer = (video: HTMLVideoElement) => {
    let end = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) end = video.buffered.end(i);
    }
    setBufferedEnd(end);
  };
  const play = () => {
    const video = videoRef.current; if (!video || !src) return;
    if (video.error || !video.getAttribute('src')) { video.src = src; video.load(); }
    void video.play().catch(() => { if (videoRef.current === video && video.getAttribute('src') === src) setBlocked(true); });
  };
  const fullscreen = () => {
    const operation = document.fullscreenElement ? document.exitFullscreen?.() : stageRef.current?.requestFullscreen?.();
    if (operation) void operation.catch(() => setFullscreenError(true));
    else setFullscreenError(true);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let current = true;
    // 清理移除 src，StrictMode 重放时必须重新恢复。
    video.src = src;
    if (autoPlay) void video.play().catch(() => { if (current) setBlocked(true); });
    return () => { current = false; releaseViewportVideoElement(video); };
  }, [src, autoPlay]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      // 仅处理自己的全屏或菜单；嵌入页面时不抢占其他组件的 Esc。
      const fullscreenElement = document.fullscreenElement;
      if (fullscreenElement) {
        if (fullscreenElement === stageRef.current || stageRef.current?.contains(fullscreenElement)) event.stopImmediatePropagation();
        return;
      }
      if (!onEscape && !stageRef.current?.contains(event.target as Node)) return;
      if (!menu && !onEscape) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (menu) { setMenu(null); controlsRef.current?.querySelector<HTMLButtonElement>(`[data-video-${menu}-trigger]`)?.focus(); }
      else onEscape?.();
    };
    window.addEventListener('keydown', keyboard, true);
    return () => window.removeEventListener('keydown', keyboard, true);
  }, [onEscape, menu]);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video || !src) return;
    let frame: number;
    const refresh = () => {
      if (video.paused || video.ended) return;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const position = Math.min(video.duration, Math.max(0, video.currentTime));
        // 仅刷新进度几何，信息面板与时间文字保持媒体事件的更新频率。
        progressRef.current?.style.setProperty('--video-played', `${position / video.duration * 100}%`);
        if (progressInputRef.current) progressInputRef.current.value = String(position);
      }
      frame = requestAnimationFrame(refresh);
    };
    frame = requestAnimationFrame(refresh);
    return () => cancelAnimationFrame(frame);
  }, [playing, src]);

  useEffect(() => {
    if (!menu) return;
    popupRef.current?.querySelector<HTMLElement>(menu === 'speed' ? 'input' : '[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      // 按钮等交互目标先完成自己的点击；例如关闭预览不应被收起菜单打断。
      if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
      if (!controlsRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [menu]);

  return (
    <div ref={stageRef} className={`ui-video-player ${className}`} aria-label={`${name} 视频播放器`}>
        <div className="ui-video-player__view">
        {src ? <>
          <video ref={videoRef} src={src} poster={poster} playsInline preload="auto" aria-label={`${name} 视频播放`}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setDimensions({ src, width: video.videoWidth, height: video.videoHeight, duration: video.duration });
              updateBuffer(video);
              onMetadata?.({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
            }}
            onTimeUpdate={(event) => { setTime(event.currentTarget.currentTime); updateBuffer(event.currentTarget); }}
            onProgress={(event) => updateBuffer(event.currentTarget)}
            onPlay={() => { setPlaying(true); setBlocked(false); setFailed(null); }}
            onPause={(event) => { setPlaying(false); setTime(event.currentTarget.currentTime); }}
            onEnded={(event) => { setPlaying(false); setTime(event.currentTarget.currentTime); onEnded?.(); }}
            onSeeking={(event) => setTime(event.currentTarget.currentTime)}
            onSeeked={(event) => setTime(event.currentTarget.currentTime)}
            onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }}
            onRateChange={(event) => setRate(event.currentTarget.playbackRate)}
            onError={() => { setPlaying(false); setFailed(src); setBlocked(true); onError?.(); }} />
          {(blocked || failed === src) && <button type="button" className="ui-btn ui-video-player__retry" onClick={play}>{failed === src ? '视频加载失败，点击重试' : '点击播放'}</button>}
        </> : <p role="status" className="text-sm text-canvas-text-muted">{unavailable ? '视频不可用' : '加载视频…'}</p>}
        </div>
        <div ref={controlsRef} className="ui-video-player__controls p-3" aria-label="视频播放控件">
          <div ref={progressRef} className="ui-video-player__progress" style={{ '--video-played': `${played}%`, '--video-buffered': `${buffered}%` } as CSSProperties}
            onPointerMove={(event) => {
              if (!duration || !src || event.pointerType === 'touch') return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
              setHover({ ratio, time: Math.round(ratio * duration * 5) / 5 });
            }} onPointerLeave={() => setHover(null)}>
          <div className="ui-video-player__progress-track" aria-hidden="true"><span className="ui-video-player__progress-empty" /><span className="ui-video-player__progress-buffer" /><span className="ui-video-player__progress-played" /></div>
          {duration > 0 && <span className="ui-video-player__progress-marker" aria-hidden="true" />}
          <input ref={progressInputRef} type="range" data-native-range className="ui-video-player__range-hit" min={0} max={duration || 1} step={0.01} value={Math.min(time, duration)} disabled={!duration}
            aria-label="播放进度" aria-valuetext={`${timeLabel(time)} / ${timeLabel(duration)}`}
            onChange={(event) => { const video = videoRef.current; if (video && duration) { video.currentTime = Number(event.currentTarget.value); setTime(video.currentTime); } }} />
          {hover && src && <div className="ui-video-player__seek-anchor" style={{ '--video-hover': `${hover.ratio * 100}%` } as CSSProperties}><VideoSeekPreview key={src} src={src} time={hover.time} /></div>}
          </div>
          <div className="ui-video-player__control-row">
            <div className="ui-video-player__control-left">
              <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={playing ? '暂停视频' : '播放视频'} disabled={!src}
                onClick={() => { if (videoRef.current?.paused) play(); else videoRef.current?.pause(); }}><Icon icon={playing ? 'lucide:pause' : 'lucide:play'} className="ui-video-player__play-icon" aria-hidden="true" /></button>
              <div className="ui-video-player__control-anchor">
                <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__speed-trigger" data-video-speed-trigger
                  aria-label="播放速度" aria-haspopup="dialog" aria-expanded={menu === 'speed'} disabled={!src} onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>{rate}×</button>
                {menu === 'speed' && <div ref={popupRef} className="ui-menu ui-menu--up ui-video-player__speed-popover p-3" role="dialog" aria-label="播放速度设置">
                  <h2 className="pb-3 text-sm font-semibold text-canvas-text">播放速度</h2>
                  <div className="ui-video-player__speed-options">{[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => <button type="button" key={value}
                    className={`ui-btn ui-btn--ghost ui-video-player__speed-option${rate === value ? ' is-selected' : ''}`} aria-label={`${value} 倍速`} aria-pressed={rate === value}
                    onClick={() => { if (videoRef.current) videoRef.current.playbackRate = value; }}>{value}</button>)}</div>
                  <div className="ui-video-player__value-track" style={{ '--video-value': `${(rate - 0.25) / 1.75 * 100}%` } as CSSProperties}><span aria-hidden="true" className="ui-video-player__value-fill" /><span aria-hidden="true" className="ui-video-player__value-marker" />
                    <input className="ui-video-player__range-hit" type="range" data-native-range min={0.25} max={2} step={0.25} value={rate} aria-label="调整播放速度"
                      onChange={(event) => { if (videoRef.current) videoRef.current.playbackRate = Number(event.currentTarget.value); }} />
                  </div>
                </div>}
              </div>
              <div className="ui-video-player__volume">
                <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control" aria-label={silent ? '取消静音' : '静音视频'} disabled={!src}
                  onClick={() => { const video = videoRef.current; if (!video) return; if (silent) { if (!video.volume) video.volume = 1; video.muted = false; } else video.muted = true; }}><Icon icon={silent ? 'lucide:volume-x' : 'lucide:volume-2'} aria-hidden="true" /></button>
                <div className="ui-video-player__value-track ui-video-player__volume-track" style={{ '--video-value': `${silent ? 0 : volume * 100}%` } as CSSProperties}><span aria-hidden="true" className="ui-video-player__value-fill" /><span aria-hidden="true" className="ui-video-player__value-marker" />
                  <input className="ui-video-player__range-hit" type="range" data-native-range min={0} max={1} step={0.01} value={silent ? 0 : volume} aria-label="视频音量" disabled={!src}
                    onChange={(event) => { const video = videoRef.current; if (video) { video.volume = Number(event.currentTarget.value); video.muted = video.volume === 0; } }} />
                </div>
              </div>
            </div>
            <div className="ui-video-player__time-format ui-video-player__control-anchor">
              <time className="text-sm font-medium tabular-nums text-canvas-text">{remainingTime ? `-${timeLabel(duration - time)}` : timeLabel(time)} / {timeLabel(duration)}</time>
              <button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__time-trigger" data-video-time-trigger aria-label="时间显示格式" aria-haspopup="menu" aria-expanded={menu === 'time'} onClick={() => setMenu(menu === 'time' ? null : 'time')}><Icon icon="lucide:chevron-down" aria-hidden="true" /></button>
              {menu === 'time' && <div ref={popupRef} className="ui-menu ui-menu--up ui-video-player__time-popover" role="menu" aria-label="时间显示格式选项"
                onKeyDown={(event) => {
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
                  const index = options.indexOf(event.target as HTMLButtonElement);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                  event.preventDefault(); event.stopPropagation(); options[next]?.focus();
                }}>
                {[false, true].map((value) => <button type="button" key={String(value)} className={`ui-menu__item${remainingTime === value ? ' is-active' : ''}`} role="menuitemradio" aria-checked={remainingTime === value}
                  onClick={() => { setRemainingTime(value); setMenu(null); controlsRef.current?.querySelector<HTMLButtonElement>('[data-video-time-trigger]')?.focus(); }}>{value ? '剩余时间 / 总时长' : '已播放 / 总时长'}</button>)}
              </div>}
            </div>
            <div className="flex justify-end"><button type="button" className="ui-btn ui-btn--ghost ui-video-player__control ui-video-player__fullscreen-control" aria-label="全屏播放视频" onClick={fullscreen}><Icon icon="lucide:expand" aria-hidden="true" /></button></div>
          </div>
          {fullscreenError && <p role="status" className="pt-2 text-xs text-canvas-text-secondary">此窗口暂不支持播放器全屏</p>}
        </div>
      </div>
  );
}
