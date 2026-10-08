import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import type { OrbSize, OrbState } from '../../vendor/generation-effects/thinking-orbs/src';
import type { BorderBeamColorVariant, BorderBeamSize } from '../../vendor/generation-effects/border-beam/src';
import type { MetalFxPreset } from '../../vendor/generation-effects/metal-fx/src';
import LazyLoadBoundary from '../shared/LazyLoadBoundary';

const ThinkingOrb = lazy(() => import('../../vendor/generation-effects/thinking-orbs/src').then((m) => ({ default: m.ThinkingOrb })));
const BorderBeam = lazy(() => import('../../vendor/generation-effects/border-beam/src').then((m) => ({ default: m.BorderBeam })));
const MetalFx = lazy(() => import('../nodes/shared/PolishMetalFx'));
const MetalText = lazy(() => import('../../vendor/generation-effects/metal-fx/src').then((m) => ({ default: m.MetalText })));
const MetalBadge = lazy(() => import('../../vendor/generation-effects/metal-fx/src').then((m) => ({ default: m.MetalBadge })));

const ORB_STATES: OrbState[] = ['working', 'searching', 'solving', 'listening', 'connecting', 'composing', 'breathing', 'weaving', 'shaping'];
type Effect = 'beam' | 'orb' | 'metal';
type MetalType = 'circle' | 'text' | 'button' | 'badge';

function Choices<T extends string | number>({ label, value, items, onChange }: {
  label: string; value: T; items: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void;
}) {
  return <div className="ui-stack ui-stack--tight" role="group" aria-label={label}>
    <span className="ui-label">{label}</span>
    <div className="flex flex-wrap gap-1">
      {items.map((item) => <button key={item.value} type="button" className={`ui-chip ${value === item.value ? 'is-active' : ''}`}
        aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}
    </div>
  </div>;
}

function RangeControl({ label, value, min, max, step, onChange, unit = '' }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; unit?: string;
}) {
  return <label className="ui-stack ui-stack--tight">
    <span className="ui-row ui-row--between ui-label">{label}<output className="tabular-nums">{value.toFixed(2)}{unit}</output></span>
    <input aria-label={label} className="ui-slider" type="range" min={min} max={max} step={step} value={value}
      onChange={(event) => onChange(Number(event.target.value))} />
  </label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <div className="ui-row ui-row--between">
    <span className="ui-label">{label}</span>
    <button type="button" className="ui-switch" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)} />
  </div>;
}

export default function StyleGuideGenerationEffects({ theme }: { theme: 'dark' | 'light' }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [effect, setEffect] = useState<Effect>('beam');
  const [paused, setPaused] = useState(false);
  const [orbState, setOrbState] = useState<OrbState>('composing');
  const [orbSize, setOrbSize] = useState<OrbSize>(64);
  const [speed, setSpeed] = useState(1);
  const [beamSize, setBeamSize] = useState<BorderBeamSize>('md');
  const [beamColor, setBeamColor] = useState<BorderBeamColorVariant>('colorful');
  const [duration, setDuration] = useState(5);
  const [staticColors, setStaticColors] = useState(false);
  const [metalType, setMetalType] = useState<MetalType>('circle');
  const [metalPreset, setMetalPreset] = useState<MetalFxPreset | ''>('');
  const [glow, setGlow] = useState(true);
  const [reflection, setReflection] = useState(true);
  const [cursorLight, setCursorLight] = useState(true);
  const [strength, setStrength] = useState(0.85);
  const [copied, setCopied] = useState('');
  const reduceMotion = useReducedMotion();
  const mounted = visible && pageVisible;
  const playing = mounted && !paused && !reduceMotion;
  const preset = metalPreset || (theme === 'light' ? 'silver' : 'chromatic');
  const pulse = beamSize === 'pulse-inner' || beamSize === 'pulse-outside';
  const reflectionTargets = reflection && playing ? [searchRef] : [];

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(stage);
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!mounted || effect !== 'metal') return;
    let cancelled = false;
    let restore: (() => void) | undefined;
    void import('../../vendor/generation-effects/metal-fx/src').then((module) => {
      if (cancelled) return;
      const previous = module.CURSOR_LIGHT.enabled;
      module.setCursorLightConfig({ enabled: cursorLight && playing });
      restore = () => module.setCursorLightConfig({ enabled: previous });
    }).catch(() => {});
    return () => { cancelled = true; restore?.(); };
  }, [mounted, effect, cursorLight, playing]);

  const fallback = <span className="ui-spinner" role="img" aria-label="正在加载特效" />;
  const source = effect === 'beam' ? 'border-beam' : effect === 'orb' ? 'thinking-orbs' : 'metal-fx';
  const reflectionProp = reflection && playing ? ' reflectionTargets={[searchRef]}' : '';
  const metalImport = metalType === 'text' ? "import { MetalText } from './vendor/generation-effects/metal-fx/src';"
    : metalType === 'badge' ? "import { MetalBadge } from './vendor/generation-effects/metal-fx/src';"
      : "import MetalFx from './components/nodes/shared/PolishMetalFx';";
  const metalExample = metalType === 'text'
    ? `<MetalText font="600 32px/1.2 sans-serif" color="var(--theme-text)" preset="${preset}" theme="${theme}" strength={${strength}} glow={${glow}} paused={${!playing}}${reflectionProp}>AI Canvas</MetalText>`
    : metalType === 'badge'
      ? `<MetalBadge preset="${preset}" theme="${theme}" strength={${strength}} disableGlow={${!glow}} paused={${!playing}}${reflectionProp}>Pro</MetalBadge>`
      : `<MetalFx variant="${metalType}" preset="${preset}" theme="${theme}" strength={${strength}} disableGlow={${!glow}} paused={${!playing}} normalizeHostStyles={false} innerShadow${reflectionProp}>\n  <button className="${metalType === 'circle' ? 'ui-icon-btn rounded-full' : 'ui-btn rounded-full'}">${metalType === 'circle' ? '↑' : 'AI 润色'}</button>\n</MetalFx>`;
  const code = effect === 'beam'
    ? `import { BorderBeam } from './vendor/generation-effects/border-beam/src';\n\n<BorderBeam size="${beamSize}" colorVariant="${beamColor}" duration={${duration}} strength={${strength}} theme="${theme}" paused={${!playing}} staticColors={${staticColors}}>\n  <div className="ui-card p-3">生成图像中…</div>\n</BorderBeam>`
    : effect === 'orb'
      ? `import { ThinkingOrb } from './vendor/generation-effects/thinking-orbs/src';\n\n<ThinkingOrb state="${orbState}" size={${orbSize}} speed={${speed}} theme="${theme}" paused={${!playing}} />`
      : `import { useRef } from 'react';\n${metalImport}\n\nconst searchRef = useRef<HTMLDivElement>(null);\n\n<div className="ui-row flex-wrap justify-center gap-5">\n  <div ref={searchRef} className="ui-input-group w-44 shrink-0 [&.ui-input-group]:rounded-full">\n    <input className="ui-input" placeholder="搜索…" />\n  </div>\n${metalExample.split('\n').map((line) => `  ${line}`).join('\n')}\n</div>`;

  const metalProps = { preset, theme, strength, paused: !playing, reflectionTargets };
  const preview = effect === 'beam'
    ? <BorderBeam key={beamSize} className={beamSize === 'sm' ? '' : 'w-full max-w-sm'} size={beamSize} colorVariant={beamColor}
      duration={duration} strength={strength} theme={theme} paused={!playing} staticColors={staticColors} borderRadius={14}>
      {beamSize === 'sm' ? <button type="button" className="ui-btn rounded-[14px]">生成图像</button>
        : <div className="ui-stack rounded-[14px] border border-canvas-border bg-canvas-card p-3">
          <span className="ui-title">生成图像中…</span>
          <div className="h-2 w-2/5 rounded-full bg-canvas-border" /><div className="h-2 w-full rounded-full bg-canvas-border" /><div className="h-2 w-4/5 rounded-full bg-canvas-border" />
        </div>}
    </BorderBeam>
    : effect === 'orb'
      ? <ThinkingOrb state={orbState} size={orbSize} speed={speed} theme={theme} paused={!playing} />
      : <div className="ui-row flex-wrap justify-center gap-5">
        <div ref={searchRef} className="ui-input-group w-44 shrink-0 [&.ui-input-group]:rounded-full">
          <input className="ui-input" aria-label="金属反射预览背景" placeholder="搜索…" readOnly />
        </div>
        {metalType === 'text' ? <MetalText {...metalProps} font="600 32px/1.2 sans-serif" color="var(--theme-text)" glow={glow}>AI Canvas</MetalText>
          : metalType === 'badge' ? <MetalBadge {...metalProps} disableGlow={!glow} scale={1.5}>Pro</MetalBadge>
            : <MetalFx {...metalProps} variant={metalType} disableGlow={!glow} normalizeHostStyles={false} innerShadow>
              {metalType === 'circle' ? <button type="button" className="ui-icon-btn rounded-full" aria-label="预览生成按钮">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 19V5m-7 7 7-7 7 7" />
                </svg>
              </button> : <button type="button" className="ui-btn rounded-full">AI 润色</button>}
            </MetalFx>}
      </div>;

  return <div ref={stageRef} className="ui-stack">
    <Choices<Effect> label="特效" value={effect} onChange={setEffect} items={[
      { value: 'beam', label: '边框流光' }, { value: 'orb', label: '思考球' }, { value: 'metal', label: '金属效果' },
    ]} />
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="ui-card min-w-0">
        <div className="ui-card__body ui-stack h-full">
          <div className="flex min-h-72 flex-1 items-center justify-center p-3">
            {mounted ? <LazyLoadBoundary label="生成特效" errorFallback={fallback}>
              <Suspense fallback={fallback}>{preview}</Suspense>
            </LazyLoadBoundary> : <span className="text-xs text-canvas-text-muted">滚动到此处播放</span>}
          </div>
          <div className="ui-row justify-center">
            <button type="button" className="ui-btn ui-btn--sm" aria-pressed={paused} disabled={Boolean(reduceMotion)} onClick={() => setPaused((value) => !value)}>
              {reduceMotion ? '已减少动态' : paused ? '继续播放' : '暂停预览'}
            </button>
          </div>
        </div>
      </div>
      <div className="ui-card min-w-0">
        <div className="ui-card__body ui-stack ui-stack--loose">
          {effect === 'beam' ? <>
            <Choices label="动画方式" value={pulse ? 'pulse' : 'rotate'} onChange={(value) => setBeamSize(value === 'pulse' ? 'pulse-outside' : 'md')}
              items={[{ value: 'rotate', label: '流转' }, { value: 'pulse', label: '呼吸' }]} />
            <Choices<BorderBeamSize> label="边框类型" value={beamSize} onChange={setBeamSize} items={pulse
              ? [{ value: 'pulse-outside', label: '外发光' }, { value: 'pulse-inner', label: '内发光' }]
              : [{ value: 'md', label: '卡片' }, { value: 'line', label: '底边' }, { value: 'sm', label: '小按钮' }]} />
            <Choices<BorderBeamColorVariant> label="流光配色" value={beamColor} onChange={setBeamColor}
              items={(['colorful', 'mono', 'ocean', 'sunset'] as const).map((value, index) => ({ value, label: ['多彩', '单色', '海洋', '日落'][index] }))} />
            <RangeControl label="周期" value={duration} min={1} max={10} step={0.1} unit="s" onChange={setDuration} />
            <Toggle label="固定色相" checked={staticColors} onChange={setStaticColors} />
          </> : effect === 'orb' ? <>
            <Choices<OrbState> label="思考球状态" value={orbState} onChange={setOrbState} items={ORB_STATES.map((value) => ({ value, label: value }))} />
            <Choices<OrbSize> label="尺寸" value={orbSize} onChange={setOrbSize} items={[{ value: 64, label: '64px' }, { value: 20, label: '20px' }]} />
            <RangeControl label="速度" value={speed} min={0.25} max={2} step={0.05} unit="×" onChange={setSpeed} />
          </> : <>
            <Choices<MetalType> label="金属类型" value={metalType} onChange={setMetalType} items={[
              { value: 'circle', label: '圆形按钮' }, { value: 'text', label: '文字' }, { value: 'button', label: '胶囊按钮' }, { value: 'badge', label: '徽标' },
            ]} />
            <Choices<MetalFxPreset | ''> label="金属配色" value={metalPreset} onChange={setMetalPreset} items={[
              { value: '', label: '跟随主题' }, { value: 'chromatic', label: '彩色' }, { value: 'silver', label: '银色' }, { value: 'gold', label: '金色' },
            ]} />
            <Toggle label="光晕" checked={glow} onChange={setGlow} />
            <Toggle label="邻近反射" checked={reflection} onChange={setReflection} />
            <Toggle label="光标反光" checked={cursorLight} onChange={setCursorLight} />
          </>}
          {effect !== 'orb' && <RangeControl label="效果强度" value={strength} min={0} max={1} step={0.05} onChange={setStrength} />}
        </div>
      </div>
    </div>
    <div className="ui-card">
      <div className="ui-card__body ui-stack">
        <div className="ui-row ui-row--between flex-wrap">
          <code className="ui-code text-[11px]">src/vendor/generation-effects/{source}/src</code>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={async () => {
            try { await navigator.clipboard.writeText(code); setCopied(code); } catch { setCopied(''); }
          }}>{copied === code ? '已复制 JSX' : '复制 JSX 用法'}</button>
        </div>
        <pre className="m-0 overflow-x-auto text-[11px] text-canvas-text-secondary"><code>{code}</code></pre>
      </div>
    </div>
    <p className="m-0 text-xs text-canvas-text-muted">明暗主题跟随窗口，离屏自动停止；系统减少动态时显示静态预览。按钮仅演示，不提交生成任务。金属效果在不支持 WebGL2 时保留普通内容。</p>
  </div>;
}
