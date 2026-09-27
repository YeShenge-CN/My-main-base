import { describe, expect, it } from 'vitest';
import { createFrameScheduler } from '../src/scheduler';

/**
 * 帧调度器（P9 第 5 条）。
 *
 * 它唯一的承诺是：静态时零渲染、脏了才渲染、同一帧里多次 invalidate 只画一次。
 * 这三件事以前没法测 —— 因为时间戳来自 requestAnimationFrame，测试里拿不到。
 * 现在时钟是注入的，所以"播放时按帧推进"也能被断言。
 */

interface Harness {
  readonly scheduler: ReturnType<typeof createFrameScheduler>;
  readonly frames: number[];
  readonly rendered: number[];
  advance(ms: number): void;
  flushFrame(): void;
  readonly pending: () => number;
}

function harness(): Harness {
  let clock = 0;
  const frames: number[] = [];
  const rendered: number[] = [];
  const queue = new Map<number, () => void>();
  let nextHandle = 1;

  const scheduler = createFrameScheduler({
    requestFrame: (cb) => {
      const handle = nextHandle++;
      queue.set(handle, cb);
      frames.push(clock);
      return handle;
    },
    cancelFrame: (handle) => {
      queue.delete(handle);
    },
    render: (nowMs) => {
      rendered.push(nowMs ?? -1);
    },
    now: () => clock,
  });

  return {
    scheduler,
    frames,
    rendered,
    advance: (ms) => {
      clock += ms;
    },
    flushFrame: () => {
      const first = [...queue.entries()][0];
      if (first === undefined) return;
      queue.delete(first[0]);
      first[1]();
    },
    pending: () => queue.size,
  };
}

describe('帧调度器：静态零开销', () => {
  it('没有 invalidate 就一个请求都不发、一次都不画', () => {
    const h = harness();
    h.flushFrame();
    expect(h.frames).toEqual([]);
    expect(h.rendered).toEqual([]);
    expect(h.scheduler.stats()).toEqual({ renders: 0, scheduled: 0, coalesced: 0 });
  });

  it('invalidate 只调度【一帧】，画完就停（不常驻 rAF）', () => {
    const h = harness();
    h.scheduler.invalidate();
    expect(h.frames.length).toBe(1);
    h.flushFrame();
    expect(h.rendered.length).toBe(1);
    expect(h.pending()).toBe(0);
    expect(h.scheduler.pending).toBe(false);
    // 再刷一次帧队列也不会多画
    h.flushFrame();
    expect(h.rendered.length).toBe(1);
  });

  it('同一帧里多次 invalidate 合并成一次渲染', () => {
    const h = harness();
    h.scheduler.invalidate();
    h.scheduler.invalidate();
    h.scheduler.invalidate();
    expect(h.frames.length).toBe(1); // 只请求了一帧
    h.flushFrame();
    expect(h.rendered.length).toBe(1);
    const stats = h.scheduler.stats();
    expect(stats.renders).toBe(1);
    expect(stats.scheduled).toBe(1);
    expect(stats.coalesced).toBe(2);
  });

  it('渲染时拿到的是【注入时钟】的时间戳（播放推进要靠它）', () => {
    const h = harness();
    h.advance(120);
    h.scheduler.invalidate();
    h.flushFrame();
    expect(h.rendered).toEqual([120]);
    h.advance(16);
    h.scheduler.invalidate();
    h.flushFrame();
    expect(h.rendered).toEqual([120, 136]);
  });

  it('flush 绕过调度同步渲染一次（截图/测试用）', () => {
    const h = harness();
    h.scheduler.flush();
    expect(h.rendered.length).toBe(1);
    expect(h.scheduler.dirty).toBe(false);
  });

  it('dispose 之后不再调度也不再渲染', () => {
    const h = harness();
    h.scheduler.invalidate();
    h.scheduler.dispose();
    h.flushFrame();
    expect(h.rendered).toEqual([]);
    h.scheduler.invalidate();
    expect(h.frames.length).toBe(1); // dispose 前的那个请求，之后没有新的
  });
});
