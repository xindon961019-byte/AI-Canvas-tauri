import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForCanvasFirstPaint } from '../../src/services/canvasReadyService';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function paint() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { vi.useRealTimers(); });

describe('project canvas first paint', () => {
  it('waits for viewport adjustment and two paint frames', async () => {
    const ready = vi.fn();
    let resolve!: (value: boolean) => void;
    waitForCanvasFirstPaint(() => new Promise<boolean>((done) => { resolve = done; }), ready);
    await vi.advanceTimersByTimeAsync(0);
    paint(); paint();
    expect(ready).not.toHaveBeenCalled();
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    paint();
    expect(ready).not.toHaveBeenCalled();
    paint();
    expect(ready).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    paint(); paint();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('enters a virtualized canvas when fitView never resolves, without waiting forever', async () => {
    const ready = vi.fn();
    waitForCanvasFirstPaint(() => new Promise(() => {}), ready);
    await vi.advanceTimersByTimeAsync(1999);
    paint(); paint();
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    paint(); paint();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('does not notify twice when fitView completes after the deadline', async () => {
    const ready = vi.fn();
    let resolve!: () => void;
    waitForCanvasFirstPaint(() => new Promise<void>((done) => { resolve = done; }), ready);
    await vi.advanceTimersByTimeAsync(2000);
    paint(); paint();
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    paint(); paint();
    expect(ready).toHaveBeenCalledOnce();
  });

  it.each(['reject', 'throw'] as const)('releases the display wait on a fitView %s', async (mode) => {
    const ready = vi.fn();
    waitForCanvasFirstPaint(() => {
      if (mode === 'throw') throw new Error('Viewport unavailable');
      return Promise.reject(new Error('Viewport unavailable'));
    }, ready);
    await vi.advanceTimersByTimeAsync(0);
    paint(); paint();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('cancels both the deadline and a late promise when switching projects', async () => {
    const ready = vi.fn();
    let resolve!: () => void;
    const cancel = waitForCanvasFirstPaint(() => new Promise<void>((done) => { resolve = done; }), ready);
    await vi.advanceTimersByTimeAsync(0);
    cancel(); resolve();
    await vi.advanceTimersByTimeAsync(3000);
    paint(); paint();
    expect(ready).not.toHaveBeenCalled();
  });

  it('cancels between layout and paint when the canvas unmounts', async () => {
    const ready = vi.fn();
    const cancel = waitForCanvasFirstPaint(() => Promise.resolve(true), ready);
    await vi.advanceTimersByTimeAsync(0);
    paint(); cancel(); paint();
    expect(ready).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});
