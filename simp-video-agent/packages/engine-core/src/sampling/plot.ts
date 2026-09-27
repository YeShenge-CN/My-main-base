/**
 * 曲线采样。
 *
 * ★ 规范 §5：samples 永远是【全定义域】的采样数。
 *   绘制过程动画是"全量采样 + 可见子集绘制"，绝不是"改小定义域重新采样" ——
 *   后者会让左段点密度不断变化，视觉一直抖。
 *
 * NaN / Inf 处断开成独立线段，而不是把非有限值连进去。
 */
import type { Vec2 } from '../math/vec2';
import type { CompiledExpr, Env } from '../expr';

export interface Polyline {
  readonly points: readonly Vec2[];
  /** 第 i 段从 points[breaks[i]] 开始。breaks[0] 恒为 0。 */
  readonly breaks: readonly number[];
}

export function samplePlot(
  fn: CompiledExpr,
  domain: readonly [number, number],
  samples: number,
  extraEnv: Env = {},
): Polyline {
  const lo = domain[0];
  const hi = domain[1];
  const n = Math.max(2, Math.floor(samples));
  const step = n === 1 ? 0 : (hi - lo) / (n - 1);

  const points: Vec2[] = [];
  const breaks: number[] = [0];
  let open = false;

  for (let i = 0; i < n; i++) {
    const x = lo + i * step;
    const y = fn({ ...extraEnv, x });
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      open = false;
      continue;
    }
    if (!open) {
      breaks.push(points.length);
      open = true;
    }
    points.push({ x, y });
  }
  if (breaks.length > 1 && breaks[0] === 0) breaks.shift();
  if (breaks.length === 0 || breaks[0] !== 0) breaks.unshift(0);
  return { points, breaks };
}

/** 累积弧长表。drawOn 的 arc 模式用它做二分反查。 */
export function cumulativeArcLength(points: readonly Vec2[]): readonly number[] {
  const out: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    out.push((out[i - 1] ?? 0) + (Number.isFinite(d) ? d : 0));
  }
  return out;
}

/**
 * 折线前 fraction 比例（按弧长）。O(log n) 二分。
 * fraction >= 1 时原样返回（不复制）。
 */
export function clipByArcLength(
  points: readonly Vec2[],
  fraction: number,
): readonly Vec2[] {
  if (fraction >= 1) return points;
  if (fraction <= 0 || points.length === 0) return [];
  const cum = cumulativeArcLength(points);
  const total = cum[cum.length - 1] ?? 0;
  if (!(total > 0)) return points.slice(0, 1);
  const target = total * fraction;

  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  // 在 lo-1 与 lo 之间按比例插入一个精确点
  const prev = points[lo - 1];
  const cur = points[lo];
  const c0 = cum[lo - 1] ?? 0;
  const c1 = cum[lo] ?? c0;
  if (prev === undefined || cur === undefined || c1 <= c0) return points.slice(0, lo);
  const k = (target - c0) / (c1 - c0);
  return [...points.slice(0, lo), { x: prev.x + (cur.x - prev.x) * k, y: prev.y + (cur.y - prev.y) * k }];
}

/** 按定义域比例取前 fraction（mode: 'domain'）。 */
export function clipByDomain(points: readonly Vec2[], fraction: number): readonly Vec2[] {
  if (fraction >= 1) return points;
  if (fraction <= 0 || points.length === 0) return [];
  const count = Math.max(1, Math.ceil(points.length * fraction));
  return points.slice(0, count);
}
