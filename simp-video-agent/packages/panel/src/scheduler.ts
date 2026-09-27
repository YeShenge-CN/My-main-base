/**
 * 脏标记 + 单次调度（P9 第 5 条）。
 *
 * ★ 不常驻 requestAnimationFrame。
 *   常驻 rAF 在"文档没变、鼠标没动"的时候也在烧 CPU 和电，
 *   而且会让面板在后台标签页里行为诡异。这里只在 invalidate() 之后
 *   调度【一帧】，画完就停；静态时渲染次数是 0。
 *
 * requestFrame 是注入的，所以这个模块可以脱离浏览器被单测 ——
 * 否则"静态时零开销"只能靠肉眼看任务管理器。
 */
export interface FrameSchedulerOptions {
  readonly requestFrame: (cb: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** 真正干活的地方。只在有脏标记时被调用；参数是注入时钟的时间戳。 */
  readonly render: (nowMs?: number) => void;
  /**
   * 渲染时的时间戳（毫秒）。省略则用全局 performance.now()。
   *
   * ★ 它必须能被注入，否则这个模块【没法测】：
   *   而"静态时零渲染、播放时按帧推进"正是它唯一的职责，
   *   一个测不到的实现等于没有保证。浏览器里调用方传 requestAnimationFrame 的
   *   时间戳即可，测试里传一个手动前进的时钟。
   */
  readonly now?: () => number;
}

export interface FrameScheduler {
  /** 打脏标记。重复调用只会在同一帧里合并成一次渲染。 */
  invalidate(reason?: string): void;
  readonly dirty: boolean;
  readonly pending: boolean;
  /** 同步强制渲染一次（截图/测试用，绕过调度） */
  flush(): void;
  stats(): { readonly renders: number; readonly scheduled: number; readonly coalesced: number };
  dispose(): void;
}

export function createFrameScheduler(opts: FrameSchedulerOptions): FrameScheduler {
  let dirty = false;
  let handle: number | null = null;
  let disposed = false;
  let renders = 0;
  let scheduled = 0;
  let coalesced = 0;

  const run = (): void => {
    handle = null;
    if (disposed) return;
    if (!dirty) return; // 二次保险：没有脏标记就什么都不做
    dirty = false;
    renders += 1;
    const stamp = opts.now?.();
    if (stamp === undefined) opts.render();
    else opts.render(stamp);
  };

  return {
    invalidate(): void {
      if (disposed) return;
      if (dirty) coalesced += 1;
      dirty = true;
      if (handle === null) {
        scheduled += 1;
        handle = opts.requestFrame(run);
      }
    },
    get dirty(): boolean {
      return dirty;
    },
    get pending(): boolean {
      return handle !== null;
    },
    flush(): void {
      if (handle !== null && opts.cancelFrame !== undefined) {
        opts.cancelFrame(handle);
        handle = null;
      }
      dirty = true;
      run();
    },
    stats(): { renders: number; scheduled: number; coalesced: number } {
      return { renders, scheduled, coalesced };
    },
    dispose(): void {
      disposed = true;
      if (handle !== null && opts.cancelFrame !== undefined) opts.cancelFrame(handle);
      handle = null;
      dirty = false;
    },
  };
}
