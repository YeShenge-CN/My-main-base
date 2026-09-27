/**
 * 时间轴（P9 第 7 条）：Canvas 画轨道，DOM 画标签。
 *
 * 为什么这么分：标签是文字，交给 DOM 才有正确的字体、选中、可访问性；
 * 轨道是几何，交给 Canvas 才不会在几百段区间上产生几百个 DOM 节点。
 *
 * ★ 时间轴画布同样【不乘 devicePixelRatio】（P9 的星号条）。
 *   代价是高分屏上略软；收益是"面板里任何一块画布"都不存在
 *   "CSS 像素 ≠ 画布像素"这种会在预览上出人命的差异。预览那块更是硬要求。
 */
import type { ShotSpan, TimelineEvent } from '@sva/engine-core';
import { clear, h } from './dom';
import type { TrimTarget } from './scene-edit';

export const LANE_HEIGHT = 22;

export interface TimelineHost {
  /** 拖动/点击时间轴 → 移动播放头 */
  readonly onSeek: (t: number) => void;
  /** 点击某个镜头块 → 选中它（并跳到它的起点） */
  readonly onSelectScene?: (sceneId: string) => void;
  /**
   * 拖动镜头接缝 / 片尾时【实时】回调（只更新预览，不提交）。
   *
   * ★ 分"拖动"与"提交"两个回调是刻意的：拖一次会产生几十个中间值，
   *   每个都提交会往 Journal 里灌一串没人想撤销的中间态。
   */
  readonly onTrimPreview?: (target: TrimTarget, t: number) => number | void;
  /** 松手 → 提交一条命令（走唯一写路径）。 */
  readonly onTrimCommit?: (target: TrimTarget, t: number) => void;
}

const LANE_COLOR: Readonly<Record<string, string>> = {
  object: '#4ea1ff',
  effect: '#ffb454',
  marker: '#8ee06a',
  camera: '#c792ea',
  anim: '#63d2ff',
};

const LANE_ORDER: readonly string[] = ['object', 'effect', 'anim', 'camera', 'marker'];

/**
 * 镜头泳道。
 *
 * ★ 它画在【所有轨道的上面】，而且是 canvas 上方的独立 DOM 条而不是一条 lane：
 *   镜头的边界是"这一帧该看什么"的判据，比任何一条对象轨道都更基础 ——
 *   埋在轨道中间会让人以为它和 anim 是一个层级的东西。
 *
 *   交互（点一下跳到那一镜）也放在这里，因为"分镜"这件事在面板上只有这一个入口。
 */
/**
 * 镜头泳道 + **可拖的接缝**。
 *
 * ★ 拖接缝为什么落在"后一镜的 bornAt"上：镜头表是 A1（不存 end，
 *   "某镜结束 = 下一镜起点"），所以边界只有一个真源。拖它 = 前镜变长、后镜变短。
 * ★ 片尾那一个手柄改的是 meta.duration（整片长度）—— 与 PR 拖时间线末端同义。
 * ★ 没有镜头表时也画【一整块】"全片"，这样单镜头文档同样能把片尾拉长/缩短 ——
 *   否则"拉长镜头"这个动作在单镜头文档里根本没有入口（而那是最常见的文档形态）。
 */
function buildShotLane(
  shots: readonly ShotSpan[],
  duration: number,
  host: TimelineHost,
): { readonly el: HTMLElement; readonly setCurrent: (sceneId: string | null) => void } {
  const lane = h('div', { class: 'tl-shots' });
  const pct = (t: number): number => (duration <= 0 ? 0 : (t / duration) * 100);

  /** 把一个手柄的时间换算成秒（横坐标 → 时间）。 */
  const timeAt = (clientX: number): number => {
    const rect = lane.getBoundingClientRect();
    const k = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
    return Math.max(0, k * duration);
  };

  /**
   * 给一个目标接上拖动：拖动中只回调 onTrimPreview（画面实时跟），
   * 松手才 onTrimCommit（一条命令）。捕获指针，拖到手柄外面也不会掉。
   */
  const attachDrag = (handle: HTMLElement, target: TrimTarget, apply: (at: number) => void): void => {
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      handle.setPointerCapture(ev.pointerId);
      handle.classList.add('on');
      document.body.classList.add('trimming');
      const move = (m: PointerEvent): void => {
        const raw = timeAt(m.clientX);
        // ★ 用回调【返回】的时间来挪接缝，而不是鼠标原始位置：夹下限、吸附帧网格
        //   这些规则只在 scene-edit 里有一份，时间轴照着结果画，就不会拖到引擎不接受的位置。
        const at = host.onTrimPreview?.(target, raw);
        apply(typeof at === 'number' ? at : raw);
      };
      const up = (m: PointerEvent): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.classList.remove('on');
        document.body.classList.remove('trimming');
        try {
          handle.releasePointerCapture(m.pointerId);
        } catch {
          // 指针已经没了（比如鼠标移出窗口）—— 不影响提交
        }
        host.onTrimCommit?.(target, timeAt(m.clientX));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  };

  /** 每个镜头块与它两端的接缝手柄 —— 拖动时要【就地】改它们的几何。 */
  type ShotView = {
    readonly sceneId: string;
    readonly start: number;
    readonly end: number;
    readonly block: HTMLElement;
    left: HTMLElement | null;
    right: HTMLElement | null;
  };
  const views: ShotView[] = [];

  /**
   * 换「当前镜」高亮。
   *
   * ★ 播放头拖动时画布那条红线只重画一次画布，泳道的高亮若不跟着换，
   *   就会出现「红线在第二镜里、高亮的却是第一镜」——两者读的必须是同一个判据。
   *   所以面板把 currentScene()（与渲染同一套帧计划算出来的）一起传进来。
   */
  const setCurrent = (sceneId: string | null): void => {
    for (const v of views) v.block.classList.toggle('cur', sceneId !== null && v.sceneId === sceneId);
  };

  /**
   * 拖动中的局部重排：只动被拖的那一处和它的邻居，不重建 DOM。
   *
   * ★ 它保证的是「手在哪儿、缝就在哪儿」：拖动时若只有画面跟、缝不跟，
   *   手感就变成「拖一个看不见的东西」（PR 里那条缝是一路跟着鼠标走的）。
   * ★ 镜头【块】本身也跟着伸缩，与人眼对「拉长 / 缩短」的预期一致。
   */
  const previewLayout = (target: TrimTarget, at: number): void => {
    if (target.kind === 'end') {
      const last = views[views.length - 1];
      if (last === undefined) return;
      last.block.style.width = Math.max(0.5, pct(at - last.start)).toFixed(4) + '%';
      if (last.right !== null) last.right.style.left = pct(at).toFixed(4) + '%';
      return;
    }
    const i = views.findIndex((v) => v.sceneId === target.sceneId);
    if (i <= 0) return;
    const prev = views[i - 1];
    const self = views[i];
    if (prev === undefined || self === undefined) return;
    if (prev.right !== null) prev.right.style.left = pct(at).toFixed(4) + '%';
    prev.block.style.width = Math.max(0.5, pct(at - prev.start)).toFixed(4) + '%';
    self.block.style.left = pct(at).toFixed(4) + '%';
    self.block.style.width = Math.max(0.5, pct(self.end - at)).toFixed(4) + '%';
    if (self.left !== null) self.left.style.left = pct(at).toFixed(4) + '%';
  };

  if (shots.length === 0) {
    // 单镜头文档：一整块"全片"，右边缘可拖（改片长）
    const block = h(
      'div',
      { class: 'tl-shot tl-whole', style: 'left:0%;width:100%', title: '全片（没有镜头表）· 拖右边缘改片长' },
      '全片 ' + duration.toFixed(2) + 's',
    );
    lane.append(block);
    const handle = h('div', { class: 'tl-trim', style: 'left:100%', title: '拖我改片长' });
    const end: TrimTarget = { kind: 'end' };
    attachDrag(handle, end, (at) => {
      block.style.width = pct(at).toFixed(4) + '%';
      handle.style.left = pct(at).toFixed(4) + '%';
    });
    lane.append(handle);
    return { el: lane, setCurrent };
  }

  for (const shot of shots) {
    const left = pct(shot.start);
    const width = pct(shot.end) - left;
    const block = h(
      'button',
      {
        class: 'tl-shot',
        type: 'button',
        style: 'left:' + left.toFixed(4) + '%;width:' + Math.max(0.5, width).toFixed(4) + '%',
        title: shot.name + '（' + shot.start.toFixed(2) + 's → ' + shot.end.toFixed(2) + 's）· 点一下跳到这一镜',
      },
      shot.name,
    );
    block.addEventListener('click', () => {
      host.onSeek(shot.start);
      host.onSelectScene?.(shot.sceneId);
    });
    lane.append(block);
    const view: ShotView = { sceneId: shot.sceneId, start: shot.start, end: shot.end, block, left: null, right: null };
    views.push(view);

    /**
     * 左边缘：只有【非第一镜】才有手柄，而且它拖的同样是这一镜自己的 bornAt。
     * 第一镜的起点是整片开头，不给拖（挪它只会留下黑场）。
     */
    const isFirst = Math.abs(shot.start - (shots[0]?.start ?? 0)) < 1e-9;
    if (!isFirst) {
      const lh = h('div', { class: 'tl-trim', style: 'left:' + left.toFixed(4) + '%', title: '拖我改这一镜的起点（前一镜会跟着变长/变短）' });
      const ltarget: TrimTarget = { kind: 'boundary', sceneId: shot.sceneId };
      view.left = lh;
      attachDrag(lh, ltarget, (at) => previewLayout(ltarget, at));
      lane.append(lh);
    }

    /** 右边缘：最后一镜 = 片尾（改片长），其余 = 与下一镜的接缝。 */
    const isLast = Math.abs(shot.end - duration) < 1e-9;
    const rh = h('div', {
      class: 'tl-trim' + (isLast ? ' tl-trim-end' : ''),
      style: 'left:' + pct(shot.end).toFixed(4) + '%',
      title: isLast ? '拖我改片长' : '拖我改这一镜的结束（下一镜会跟着变长/变短）',
    });
    const rtarget: TrimTarget = isLast ? { kind: 'end' } : { kind: 'boundary', sceneId: shot.sceneId };
    view.right = rh;
    attachDrag(rh, rtarget, (at) => previewLayout(rtarget, at));
    lane.append(rh);
  }
  return { el: lane, setCurrent };
}

export interface TimelineExtras {
  /** 镜头占用区间。空数组 = 没有镜头表（单镜头旧行为），不画泳道。 */
  readonly shots?: readonly ShotSpan[];
  /** 当前播放头所在的镜头（给泳道高亮用）。 */
  readonly currentScene?: string | null;
}

/**
 * 渲染时间轴，并返回一个【只动播放头】的句柄。
 *
 * ★ 为什么需要它：播放头以前只在整个面板刷新时重画，于是
 *   "拖红线"与"播放"两种情况下红线都不动 —— 而画面在动。
 *   用户看到的正是"红线卡住、画面在跑"。现在拖动/播放只调 setPlayhead（几毫秒），
 *   不重建 DOM、不重算轨道。
 */
export interface TimelineHandle {
  /**
   * 只更新播放头（拖动 / 播放时每帧调它）。
   *
   * sceneId = 这一刻属于哪一镜（面板用与渲染同一套帧计划算出来）。
   * 省略 = 不动高亮；传 null = 落在空档（没有高亮）。
   */
  setPlayhead(t: number, sceneId?: string | null): void;
}

export function renderTimeline(
  root: HTMLElement,
  events: readonly TimelineEvent[],
  duration: number,
  playhead: number,
  host: TimelineHost,
  extras: TimelineExtras = {},
): TimelineHandle {
  clear(root);

  let head = playhead;
  const shots = extras.shots ?? [];
  const currentScene = extras.currentScene ?? null;
  // ★ 泳道【总是】画：没有镜头表时它是一整块"全片"，于是单镜头文档也能拖片尾。
  const lane = buildShotLane(shots, duration, host);
  lane.setCurrent(currentScene);
  root.append(lane.el);

  const lanes = LANE_ORDER.filter((lane) => events.some((e) => e.kind === lane));
  const labels = h('div', { class: 'tl-labels' });
  // 镜头泳道占 label 列的一行，否则标签与轨道会错开一行 —— 错开之后
  // "哪个标签对应哪条轨道"就全靠猜了。
  labels.append(h('div', { class: 'tl-label', style: 'height:' + LANE_HEIGHT + 'px' }, 'shots'));
  for (const lane of lanes) {
    labels.append(h('div', { class: 'tl-label', style: 'height:' + LANE_HEIGHT + 'px' }, lane));
    labels.append(h('div', { class: 'tl-label', style: 'height:' + LANE_HEIGHT + 'px' }, ''));
  }
  const totalLanes = lanes.length * 2;
  const canvas = h('canvas', { class: 'tl-canvas' });
  canvas.height = Math.max(LANE_HEIGHT, totalLanes * LANE_HEIGHT);

  const scroller = h('div', { class: 'tl-scroll' }, labels, canvas);
  root.append(scroller);

  const draw = (): void => {
    // ★ 画布像素 = CSS 像素，不乘 dpr
    const cssWidth = Math.max(120, canvas.clientWidth);
    canvas.width = cssWidth;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f131b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const toX = (t: number): number => (duration <= 0 ? 0 : (t / duration) * canvas.width);

    // 秒刻度
    ctx.strokeStyle = '#222a38';
    ctx.fillStyle = '#5b6a83';
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    const stepSec = duration > 20 ? 5 : duration > 5 ? 1 : 0.5;
    for (let t = 0; t <= duration + 1e-9; t += stepSec) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      ctx.fillText(t.toFixed(stepSec < 1 ? 1 : 0) + 's', x + 3, 10);
    }

    lanes.forEach((lane, i) => {
      const y = i * LANE_HEIGHT * 2 + LANE_HEIGHT;
      ctx.fillStyle = LANE_COLOR[lane] ?? '#888';
      for (const e of events) {
        if (e.kind !== lane) continue;
        const x0 = toX(e.t);
        const x1 = toX(e.end ?? e.t);
        const w = Math.max(3, x1 - x0);
        ctx.globalAlpha = e.end === undefined ? 0.95 : 0.55;
        ctx.fillRect(x0, y + 3, w, LANE_HEIGHT - 8);
        ctx.globalAlpha = 1;
        if (e.end === undefined) {
          // 瞬时事件画成菱形
          ctx.beginPath();
          ctx.moveTo(x0, y + LANE_HEIGHT / 2 - 5);
          ctx.lineTo(x0 + 5, y + LANE_HEIGHT / 2);
          ctx.lineTo(x0, y + LANE_HEIGHT / 2 + 5);
          ctx.lineTo(x0 - 5, y + LANE_HEIGHT / 2);
          ctx.closePath();
          ctx.fill();
        }
      }
    });

    // 播放头
    const px = Math.round(toX(head)) + 0.5;
    ctx.strokeStyle = '#ff5f6d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  };

  const seekFromEvent = (ev: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const k = rect.width <= 0 ? 0 : (ev.clientX - rect.left) / rect.width;
    host.onSeek(Math.max(0, Math.min(duration, k * duration)));
  };
  canvas.addEventListener('pointerdown', (ev) => {
    /**
     * ★ 按下即生效、拖动持续生效（画面实时跟）—— 之前只有 pointerdown 与 pointermove，
     *   但**播放头自己不重画**，所以看起来像"拖不动"。现在每次 seek 都 setPlayhead。
     */
    const seekAndPaint = (m: MouseEvent): void => {
      seekFromEvent(m);
      const rect = canvas.getBoundingClientRect();
      const k = rect.width <= 0 ? 0 : (m.clientX - rect.left) / rect.width;
      setPlayhead(Math.max(0, Math.min(duration, k * duration)));
    };
    seekAndPaint(ev);
    const move = (m: MouseEvent): void => seekAndPaint(m);
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  /**
   * 只更新播放头：改一个数、重画一次画布。
   * ★ 不重建 DOM、不碰泳道（拖动时才几毫秒）。
   */
  function setPlayhead(t: number, sceneId?: string | null): void {
    head = t;
    if (sceneId !== undefined) lane.setCurrent(sceneId);
    draw();
  }

  // 布局完成后再画一次（首次 clientWidth 可能是 0）
  draw();
  requestAnimationFrame(draw);
  return { setPlayhead };
}
