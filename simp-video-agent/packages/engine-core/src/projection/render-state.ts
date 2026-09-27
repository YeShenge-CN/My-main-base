/**
 * get_render_state(t) —— 文字版的屏幕状态。
 *
 * 规范 §10：「看图前先试 get_render_state(t) —— 文字版坐标/占位信息通常就够判断重叠，
 * 比看图便宜几百倍。顺序永远是：计算优先，视觉兜底。」
 *
 * 所以这一层的目标不是"给模型看画面"，而是把【判断重叠、遮挡、越界所需要的最小数字】
 * 用最省 token 的形式交出去：每项的屏幕 AABB、文本占位、相机 scale，外加画布外项数。
 */
import type { Box, RenderItem, RenderItemKind, RenderState } from '../render-state';
import type { DocMeta, SceneDoc } from '../doc/types';
import type { RenderStateProducer } from '../render-state';
import { fitViewport } from '../camera';
import { TokenBudget } from './tokens';

/** 屏幕框。保留一位小数 —— 判断重叠不需要更多精度，但能省不少 token。 */
export type BoxTuple = readonly [number, number, number, number];

export interface TextPlaceholder {
  /** 文本内容。过长时截断（截断信息对"是否重叠"无影响） */
  readonly content: string;
  readonly anchor: readonly [number, number];
  readonly fontSize: number;
  readonly align: string;
}

export interface RenderItemView {
  readonly id: string;
  readonly kind: RenderItemKind;
  readonly layer: string;
  /** [x, y, w, h]，屏幕像素 */
  readonly box: BoxTuple;
  readonly opacity: number;
  /** drawOn 的可见比例 */
  readonly visible: number;
  readonly points?: number;
  readonly text?: TextPlaceholder;
}

export interface RenderStateView {
  readonly t: number;
  readonly viewport: readonly [number, number];
  readonly cameraScale: number;
  /**
   * ★★ 坐标契约（模型此前拿不到它，只能靠试）。
   *
   *   `tf.x / tf.y` 是【世界单位】，而 items 里的 box 是【像素】。
   *   没有这一节，模型就不知道"1 世界单位 = 多少像素"，也不知道世界的边界在哪。
   *
   *   实测（压力测试 #6/#17）：模型写出 `tf.y = 105` 想"把标题移到顶部"，
   *   而 worldHeight=9 时可见范围只有 ±4.5 —— 于是标题落到屏幕 y≈3015、飞出画布，
   *   模型随后把剩下所有轮次花在 y=105 → 1 → -74 → -95 → 3.5 之间来回猜。
   *   **它缺的不是审美判断，是一个我早就知道的常数。**
   */
  readonly world: {
    /** 世界宽高（文档 meta） */
    readonly width: number;
    readonly height: number;
    /** 1 世界单位 = 多少像素（base = min(viewport/world)） */
    readonly pixelsPerUnit: number;
    /** 世界坐标下的可见矩形。恒以原点为中心：[-W/2, W/2] × [-H/2, H/2]。 */
    readonly visible: {
      readonly x: readonly [number, number];
      readonly y: readonly [number, number];
    };
    /** 相机平移量在【世界单位】里（与 tf 同单位，可直接相加） */
    readonly tx: number;
    readonly ty: number;
    /** 一句话提醒；字段名自解释能力有限，契约值得写死一遍 */
    readonly note: string;
  };
  readonly items: readonly RenderItemView[];
  /** 完全落在画布外的项数（构图越界的快速信号） */
  readonly offscreen: number;
  /** 因为预算被省掉的项数 */
  readonly omitted?: number;
}

export interface RenderStateQuery {
  readonly tokenBudget?: number;
  readonly maxTextChars?: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function boxTuple(b: Box): BoxTuple {
  return [round1(b.x), round1(b.y), round1(b.w), round1(b.h)];
}

function isOffscreen(b: Box, w: number, h: number): boolean {
  return b.x + b.w < 0 || b.y + b.h < 0 || b.x > w || b.y > h;
}

/**
 * 坐标契约那一节。
 *
 * ★ 缺了 fit（手搓的 RenderState / 旧调用方）时用 meta 现算 —— 契约本身来自
 *   (viewport, world, camera)，不该依赖 evaluate 有没有填 fit。
 *
 * ★ 但 meta 必须由调用方给：世界宽高【猜不出来】（viewport 是 480×270 还是
 *   1920×1080 与世界 16×9 的比值差 4 倍）。给一个拍脑袋的默认值会让模型拿到
 *   一个"看起来像真的"的错误换算 —— 那比不给更坏。
 */
function worldSection(state: RenderState, meta: DocMeta): RenderStateView['world'] {
  const fit = state.fit ?? fitViewport(meta);
  return {
    width: round2(fit.worldWidth),
    height: round2(fit.worldHeight),
    pixelsPerUnit: round2(fit.base),
    visible: {
      x: [-round2(fit.worldWidth / 2), round2(fit.worldWidth / 2)],
      y: [-round2(fit.worldHeight / 2), round2(fit.worldHeight / 2)],
    },
    tx: round2(state.camera.tx),
    ty: round2(state.camera.ty),
    note:
      'tf.x / tf.y 是【世界单位】（y 轴向上，原点在画面中心），items 的 box 是【像素】。' +
      '1 世界单位 = ' + round2(fit.base) + 'px。世界坐标的可见范围就是 visible。',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function itemView(item: RenderItem, maxTextChars: number): RenderItemView {
  const base = {
    id: item.id,
    kind: item.kind,
    layer: item.layerId,
    box: boxTuple(item.box),
    opacity: round1(item.opacity * 1000) / 1000,
    visible: round1(item.visibleFraction * 1000) / 1000,
  };
  const withPoints = item.pointCount === undefined ? base : { ...base, points: item.pointCount };
  if (item.text === undefined) return withPoints;
  const content =
    item.text.content.length > maxTextChars
      ? item.text.content.slice(0, maxTextChars) + '…'
      : item.text.content;
  return {
    ...withPoints,
    text: {
      content,
      anchor: [round1(item.text.anchor.x), round1(item.text.anchor.y)],
      fontSize: item.text.fontSize,
      align: item.text.align,
    },
  };
}

/** 纯投影：RenderState → 文字视图。不调用 evaluate，因此可以单独测试。 */
export function projectRenderState(
  state: RenderState,
  meta: DocMeta,
  opts: RenderStateQuery = {},
): RenderStateView {
  const budget = opts.tokenBudget ?? 1500;
  const maxTextChars = opts.maxTextChars ?? 40;
  const w = state.viewport.w;
  const h = state.viewport.h;

  const sorted = [...state.items].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const shell: RenderStateView = {
    t: state.t,
    viewport: [w, h],
    cameraScale: round1(state.camera.scale * 1000) / 1000,
    world: worldSection(state, meta),
    items: [],
    offscreen: sorted.filter((i) => isOffscreen(i.box, w, h)).length,
  };

  const items: RenderItemView[] = [];
  let omitted = 0;
  const tb = new TokenBudget(budget);
  tb.spend(JSON.stringify(shell));

  for (const item of sorted) {
    const view = itemView(item, maxTextChars);
    if (tb.trySpend(JSON.stringify(view))) {
      items.push(view);
    } else {
      omitted++;
    }
  }

  return omitted === 0 ? { ...shell, items } : { ...shell, items, omitted };
}

/**
 * 工具入口。produce 就是 evaluate(doc, t)（P0 第 7 步）。
 * 这里不直接 import evaluate，是为了让投影层可以在 evaluate 落地之前就被完整测试。
 */
export function getRenderState(
  doc: SceneDoc,
  t: number,
  produce: RenderStateProducer,
  opts: RenderStateQuery = {},
): RenderStateView {
  return projectRenderState(produce(doc, t), doc.meta, opts);
}
