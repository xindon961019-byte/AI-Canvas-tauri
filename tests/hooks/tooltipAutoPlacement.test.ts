import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({ effect: null as (() => (() => void) | void) | null }));
vi.mock('react', () => ({ useEffect: (effect: () => (() => void) | void) => { driver.effect = effect; } }));
import { useTooltipAutoPlacement } from '../../src/hooks/useTooltipAutoPlacement';

class DomElement {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = '';
  textContent = '';
  isConnected = true;
  parent: DomElement | null = null;
  children: DomElement[] = [];
  rect = { left: 100, top: 100, right: 280, bottom: 160, width: 180, height: 60 };
  getBoundingClientRect() { return this.rect; }
  closest(): DomElement | null {
    if ('tooltip' in this.dataset) return this;
    return this.parent?.closest() ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  }
  appendChild(child: DomElement) { child.parent = this; this.children.push(child); }
  replaceChildren(...children: DomElement[]) { this.children = children; }
  remove() { this.isConnected = false; }
}

let doc: EventTarget & { body: DomElement; createElement: () => DomElement };
let win: EventTarget & { innerWidth: number; innerHeight: number };
let target: DomElement;
let cleanup: (() => void) | void;
let mutation: () => void;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
const tip = () => doc.body.children[0];
function event(type: string, element: DomElement | null, x = 200, y = 220, relatedTarget: DomElement | null = null) {
  const value = new Event(type);
  Object.defineProperty(value, 'target', { value: element });
  Object.assign(value, { clientX: x, clientY: y, relatedTarget });
  doc.dispatchEvent(value);
}
function flushFrames() {
  const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0));
}
function show(x = 200, y = 220) {
  event('pointerover', target, x, y); vi.advanceTimersByTime(800);
}

beforeEach(() => {
  vi.useFakeTimers(); frames = new Map(); frameId = 0;
  doc = Object.assign(new EventTarget(), { body: new DomElement(), createElement: () => new DomElement() });
  win = Object.assign(new EventTarget(), {
    innerWidth: 800, innerHeight: 600, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  });
  target = new DomElement();
  target.rect = { left: 100, top: 100, right: 300, bottom: 400, width: 200, height: 300 };
  target.dataset = { tooltip: '提示词：夜晚的森林。拖拽到画布可添加节点', tooltipAnchor: 'pointer', tooltipPos: 'bottom' };
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win); vi.stubGlobal('Element', DomElement);
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  useTooltipAutoPlacement(); cleanup = driver.effect!();
});
afterEach(() => {
  if (cleanup) cleanup();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('鼠标位置的资产悬浮提示', () => {
  it('延迟显示在指针旁，等待期间使用最新鼠标位置', () => {
    event('pointerover', target, 150, 180); vi.advanceTimersByTime(799);
    expect(tip().dataset.open).toBeUndefined();
    event('pointermove', target, 250, 280); vi.advanceTimersByTime(1);
    expect(tip().dataset.open).toBe('true');
    expect(tip().style).toMatchObject({ left: '262px', top: '292px' });
    expect(tip().textContent).toBe(target.dataset.tooltip);
  });

  it('同一帧内合并鼠标移动，提示跟随最后位置', () => {
    show(); event('pointermove', target, 260, 300); event('pointermove', target, 300, 340);
    expect(frames.size).toBe(1);
    expect(tip().style.left).toBe('212px');
    flushFrames(); expect(tip().style).toMatchObject({ left: '312px', top: '352px' });
  });

  it('在右侧和底部改向左上，极窄窗口仍保留边距', () => {
    show(790, 590);
    expect(tip().style).toMatchObject({ left: '598px', top: '518px' });
    expect(tip().dataset.position).toBe('top');
    win.innerWidth = 100; win.innerHeight = 40;
    win.dispatchEvent(new Event('resize'));
    expect(tip().style).toMatchObject({ left: '8px', top: '8px' });
  });

  it('异步提示词改变尺寸后按当前指针重新避让，文本保持纯文本', () => {
    show(790, 590);
    target.dataset.tooltip = '<img src=x onerror=alert(1)> 提示词';
    tip().rect.width = 300; tip().rect.height = 200; mutation();
    expect(tip().textContent).toBe(target.dataset.tooltip);
    expect(tip().children).toHaveLength(0);
    expect(tip().style).toMatchObject({ left: '478px', top: '378px' });
  });

  it('键盘聚焦沿用卡片定位，鼠标移开且焦点保留时切回卡片', () => {
    event('focusin', target); vi.advanceTimersByTime(800);
    expect(tip().style).toMatchObject({ left: '110px', top: '406px' });
    event('pointerover', target, 400, 300); flushFrames();
    expect(tip().style).toMatchObject({ left: '412px', top: '312px' });
    event('pointerout', target, 400, 300); flushFrames();
    expect(tip().style).toMatchObject({ left: '110px', top: '406px' });
  });

  it('其他控件保持原有定位，卡片子元素可找到鼠标锚点', () => {
    delete target.dataset.tooltipAnchor; show();
    expect(tip().style).toMatchObject({ left: '110px', top: '406px' });
    event('pointermove', target, 500, 450); expect(frames.size).toBe(0);
    event('pointerout', target);
    target.dataset.tooltipAnchor = 'pointer';
    const image = new DomElement(); image.parent = target;
    event('pointerover', image, 210, 220); vi.advanceTimersByTime(800);
    expect(tip().style).toMatchObject({ left: '222px', top: '232px' });
  });

  it('移开、清空提示、卸载时隐藏并释放定时器与逐帧定位', () => {
    show(); event('pointermove', target, 300, 300); event('pointerout', target);
    expect(frames.size).toBe(0); expect(tip().dataset.open).toBeUndefined();
    show(); target.dataset.tooltip = ''; mutation(); expect(tip().dataset.open).toBeUndefined();
    target.dataset.tooltip = '提示词'; event('pointerout', target); show();
    event('pointermove', target, 350, 350); expect(frames.size).toBe(1);
    if (cleanup) cleanup(); cleanup = undefined;
    expect(frames.size).toBe(0); expect(tip().isConnected).toBe(false);
    event('pointerover', target); vi.advanceTimersByTime(800); expect(frames.size).toBe(0);
  });
});
