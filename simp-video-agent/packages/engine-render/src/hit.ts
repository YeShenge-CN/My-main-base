/**
 * 命中测试（P9 第 6 条）。
 *
 * 每帧的屏幕 AABB 已经在 RenderState 里了（evaluate 算好的），这里只做两件事：
 *   1. 按【绘制逆序】遍历 —— 后画的在上面，先命中
 *   2. 细线（path）不能只测包围盒，要测到折线的真实距离，并给 4px 宽容度
 *
 * 注意：这里的 AABB 是世界矩形经相机矩阵变换后的结果，不是"自己再算一遍"。
 * 两处各算一次就会出现"看得见却点不中"。
 */
import type { RenderState, RenderItem } from '@sva/engine-core';

export interface HitResult {
  readonly id: string;
  readonly kind: RenderItem['kind'];
  readonly layerId: string;
  /** 到该图形的距离（像素）。包围盒命中时为 0，细线命中时为真实距离。 */
  readonly distance: number;
}

export interface HitOptions {
  /** 细线宽容度（像素）。规范给的是 4。 */
  readonly tolerancePx?: number;
}

export const DEFAULT_HIT_TOLERANCE_PX = 4;

function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const px0 = px - ax;
    const py0 = py - ay;
    return px0 * px0 + py0 * py0;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

function inBox(item: RenderItem, px: number, py: number, tol: number): boolean {
  const b = item.box;
  return px >= b.x - tol && px <= b.x + b.w + tol && py >= b.y - tol && py <= b.y + b.h + tol;
}

function pathDistance(item: RenderItem, px: number, py: number): number {
  const pts = item.path;
  if (pts === undefined || pts.length === 0) return Number.POSITIVE_INFINITY;
  if (pts.length === 1) {
    const p = pts[0];
    if (p === undefined) return Number.POSITIVE_INFINITY;
    return Math.hypot(px - p.x, py - p.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a === undefined || b === undefined) continue;
    const d = distanceToSegmentSq(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 返回【最上面】那个命中的项。没命中返回 null。 */
export function hitTest(state: RenderState, px: number, py: number, opts: HitOptions = {}): HitResult | null {
  const all = hitTestAll(state, px, py, opts);
  return all[0] ?? null;
}

/** 命中栈，从最上面到最下面。面板的"点穿透选中"用的是它。 */
export function hitTestAll(
  state: RenderState,
  px: number,
  py: number,
  opts: HitOptions = {},
): readonly HitResult[] {
  const tol = opts.tolerancePx ?? DEFAULT_HIT_TOLERANCE_PX;
  const out: HitResult[] = [];

  // ★ 绘制逆序：后画的在上层
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item === undefined) continue;
    if (item.visibleFraction <= 0 || item.opacity <= 0) continue;

    if (item.kind === 'path' || item.kind === 'points') {
      // 细线：先过一遍包围盒（便宜的剪枝），再算真实距离
      if (!inBox(item, px, py, tol)) continue;
      const d = pathDistance(item, px, py);
      if (d <= tol) out.push({ id: item.id, kind: item.kind, layerId: item.layerId, distance: d });
      continue;
    }

    if (inBox(item, px, py, 0)) {
      out.push({ id: item.id, kind: item.kind, layerId: item.layerId, distance: 0 });
    }
  }
  return out;
}
