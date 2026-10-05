import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabsProps } from '../../src/components/shared/Tabs';

interface Element {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
interface Animation {
  from: number;
  to: number;
  options: { onUpdate: (value: number) => void; onComplete: () => void; bounce: number; visualDuration: number };
  stop: ReturnType<typeof vi.fn>;
}
const driver = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>, refIndex: 0,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>, effectIndex: 0,
  pending: [] as Array<() => void>, reduceMotion: false,
  animate: vi.fn(), animations: [] as Animation[],
}));
vi.mock('react', async () => ({
  ...await vi.importActual<typeof import('react')>('react'),
  useRef: <T,>(initial: T) => {
    const index = driver.refIndex++;
    driver.refs[index] ??= { current: initial };
    return driver.refs[index];
  },
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
    const index = driver.effectIndex++;
    const previous = driver.effects[index];
    if (previous && deps.length === previous.deps.length && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    driver.pending.push(() => {
      previous?.cleanup?.();
      driver.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));
vi.mock('framer-motion', () => ({
  animate: driver.animate, motion: { button: 'button' }, useReducedMotion: () => driver.reduceMotion,
}));
import Tabs from '../../src/components/shared/Tabs';

const items = [
  { value: 'project', label: '项目文件', count: 0 },
  { value: 'disabled', label: '暂不可用', disabled: true },
  { value: 'creative', label: '创作资产', count: 12 },
  { value: 'ark', label: '方舟素材库' },
  { value: 'nodes', label: '节点列表', count: 36 },
];
function all(root: unknown): Element[] {
  if (Array.isArray(root)) return root.flatMap(all);
  if (!root || typeof root !== 'object' || !('props' in root)) return [];
  const element = root as Element;
  return [element, ...all(element.props.children)];
}
let list: EventTarget & { clientWidth: number; scrollLeft: number; scrollTo: ReturnType<typeof vi.fn> };
let content: {
  offsetWidth: number;
  style: { transform: string; removeProperty: ReturnType<typeof vi.fn> };
  lastElementChild: typeof buttons[number];
  querySelector: () => typeof buttons[number] | undefined;
  querySelectorAll: () => typeof buttons;
};
let buttons: Array<{ offsetLeft: number; offsetWidth: number; dataset: { tabValue: string }; focus: ReturnType<typeof vi.fn> }>;
let selected: string;
let observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>;
let tree: unknown;
const onChange = vi.fn();
function render(props: Partial<TabsProps> = {}) {
  selected = props.value ?? 'creative';
  driver.refIndex = 0; driver.effectIndex = 0;
  tree = Tabs({ items, value: selected, onChange, 'aria-label': '测试页签', ...props });
  for (const element of all(tree)) {
    if (element.props.role === 'tablist') (element.props.ref as { current: unknown }).current = list;
    if (element.props.className === 'ui-tabs__content') (element.props.ref as { current: unknown }).current = content;
  }
  driver.pending.splice(0).forEach((effect) => effect());
}
function tabs() { return all(tree).filter((element) => element.props.role === 'tab'); }
function key(index: number, value: string, extra: Record<string, unknown> = {}) {
  const event = { key: value, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
  (tabs()[index].props.onKeyDown as (event: unknown) => void)(event);
  return event;
}
function unmount() { driver.effects.splice(0).forEach((effect) => effect.cleanup?.()); }

beforeEach(() => {
  driver.refs = []; driver.effects = []; driver.pending = []; driver.animations = [];
  driver.reduceMotion = false;
  onChange.mockReset();
  driver.animate.mockReset().mockImplementation((from: number, to: number, options: Animation['options']) => {
    const animation = { from, to, options, stop: vi.fn() };
    driver.animations.push(animation);
    return animation;
  });
  buttons = items.map((item, index) => ({
    offsetLeft: index * 100, offsetWidth: 100, dataset: { tabValue: item.value }, focus: vi.fn(),
  }));
  list = Object.assign(new EventTarget(), {
    clientWidth: 200, scrollLeft: 0,
    scrollTo: vi.fn(({ left }: { left: number }) => { list.scrollLeft = left; }),
  });
  content = {
    offsetWidth: 500,
    style: { transform: '', removeProperty: vi.fn(() => { content.style.transform = ''; }) },
    lastElementChild: buttons[buttons.length - 1],
    querySelector: () => buttons.find((button) => button.dataset.tabValue === selected),
    querySelectorAll: () => buttons,
  };
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.push(this); }
  });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe('公用 Tabs', () => {
  it('保留零计数、无计数和禁用项，仅当前可用页签进入 Tab 顺序', () => {
    render();
    expect(tabs().map((tab) => tab.props.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(tabs().map((tab) => tab.props['aria-selected'])).toEqual([false, false, true, false, false]);
    expect(all(tabs()[0]).find((element) => element.props.className === 'ui-tabs__count')?.props.children).toBe(0);
    expect(all(tabs()[3]).some((element) => element.props.className === 'ui-tabs__count')).toBe(false);
    (tabs()[1].props.onClick as () => void)();
    expect(onChange).not.toHaveBeenCalled();
    (tabs()[4].props.onClick as () => void)();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('nodes');
  });

  it('方向键跳过禁用项、循环导航，Home/End 定位两端并阻止祖先处理', () => {
    render({ value: 'project' });
    const event = key(0, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('creative');
    expect(buttons[2].focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    key(0, 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('nodes');
    key(2, 'End');
    expect(onChange).toHaveBeenLastCalledWith('nodes');
    render({ value: 'creative' });
    key(2, 'Home');
    expect(onChange).toHaveBeenLastCalledWith('project');
    const calls = onChange.mock.calls.length;
    expect(key(2, 'Tab').preventDefault).not.toHaveBeenCalled();
    key(2, 'ArrowRight', { ctrlKey: true });
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('未知或禁用的选中值提供首个可用焦点入口，空列表无焦点和动画', () => {
    render({ value: 'disabled' });
    expect(tabs()[0].props.tabIndex).toBe(0);
    render({ value: 'unknown', items: [] });
    expect(tabs()).toHaveLength(0);
    expect(driver.animations[0]?.stop).toHaveBeenCalled();
  });

  it('中间项的目标在容器中央，经过过冲位置再回到目标', () => {
    render();
    const animation = driver.animations[0];
    expect(animation.to).toBe(150);
    expect(animation.options).toMatchObject({ visualDuration: 0.5, bounce: 0.35 });
    animation.options.onUpdate(160);
    expect(list.scrollLeft).toBeGreaterThan(animation.to);
    animation.options.onUpdate(153);
    animation.options.onComplete();
    expect(list.scrollLeft).toBe(150);
    expect(content.style.transform).toBe('');
  });

  it.each([
    { value: 'nodes', from: 0, target: 300, overshoot: 330, transform: 'translate3d(-12px, 0, 0)' },
    { value: 'project', from: 200, target: 0, overshoot: -30, transform: 'translate3d(12px, 0, 0)' },
  ])('边界 $value 保留最多 12px 的越位，完成后清除位移', ({ value, from, target, overshoot, transform }) => {
    list.scrollLeft = from;
    render({ value });
    const animation = driver.animations[0];
    expect(animation.to).toBe(target);
    animation.options.onUpdate(overshoot);
    expect(list.scrollLeft).toBe(target);
    expect(content.style.transform).toBe(transform);
    animation.options.onComplete();
    expect(content.style.transform).toBe('');
  });

  it('快速切换从当前位置重定位，旧动画停止且临时位移清理', () => {
    render({ value: 'nodes' });
    const first = driver.animations[0];
    first.options.onUpdate(310);
    render({ value: 'creative' });
    expect(first.stop).toHaveBeenCalled();
    expect(content.style.transform).toBe('');
    expect(driver.animations[1]).toMatchObject({ from: 300, to: 150 });
  });

  it.each(['wheel', 'pointerdown'])('手动 %s 中止动画，重选同一项可重新居中', (event) => {
    render();
    const animation = driver.animations[0];
    animation.options.onUpdate(80);
    list.dispatchEvent(new Event(event));
    expect(animation.stop).toHaveBeenCalled();
    expect(content.style.transform).toBe('');
    (tabs()[2].props.onClick as () => void)();
    expect(driver.animations[1]).toMatchObject({ from: 80, to: 150 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('容器缩窄与计数导致的内容宽度变化重新定位，不因相同测量重启动画', () => {
    render();
    observers[0].callback();
    expect(driver.animations).toHaveLength(1);
    list.clientWidth = 160;
    observers[0].callback();
    expect(driver.animations[0].stop).toHaveBeenCalled();
    expect(driver.animations[1].to).toBe(170);
    buttons[2].offsetLeft = 220;
    content.offsetWidth = 520;
    observers[0].callback();
    expect(driver.animations[2].to).toBe(190);
  });

  it('减少动态效果直接定位，禁用 hover/tap 动画；无需滚动时不创建动画', () => {
    driver.reduceMotion = true;
    render({ size: 'sm' });
    expect(list.scrollTo).toHaveBeenCalledWith({ left: 150, behavior: 'instant' });
    expect(driver.animate).not.toHaveBeenCalled();
    expect(tabs()[2].props.whileHover).toBeUndefined();
    expect(all(tree)[0].props.className).toContain('ui-tabs--sm');
    driver.reduceMotion = false;
    list.clientWidth = 600; list.scrollLeft = 0;
    render();
    expect(driver.animate).not.toHaveBeenCalled();
  });

  it('卸载清理动画、位移、尺寸监听和用户交互监听', () => {
    render({ value: 'nodes' });
    const animation = driver.animations[0];
    animation.options.onUpdate(310);
    unmount();
    expect(animation.stop).toHaveBeenCalled();
    expect(content.style.transform).toBe('');
    expect(observers[0].disconnect).toHaveBeenCalled();
    const calls = animation.stop.mock.calls.length;
    list.dispatchEvent(new Event('wheel'));
    list.dispatchEvent(new Event('pointerdown'));
    expect(animation.stop).toHaveBeenCalledTimes(calls);
  });
});
