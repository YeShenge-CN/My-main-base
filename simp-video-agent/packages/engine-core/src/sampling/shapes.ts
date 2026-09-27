/**
 * 精确几何的采样器：矩形与线段（P1 形状系统的第一批）。
 *
 * ★ 它们和曲线【不是一类东西】，这一点必须在类型与注释里说清楚：
 *   曲线需要 `samples` 这个旋钮，因为它是"用有限个点逼近一条连续曲线"，
 *   点少了会出折角（规范 §5 的抽样规则、校验器的 samples_low 都围绕它）。
 *   而矩形与线段的点数是【确定的】：
 *     矩形 = 四角（圆角时每角若干段）；线段 = 两个点。
 *   给它们编一个 samples 字段只会制造一个"调了没有用"的旋钮，
 *   所以 registry 里刻意不登记 samples。
 *
 * ★ 返回值统一是 Polyline（与 plot 同一形状），于是：
 *   · evaluate 的下游（world→pixel 变换、AABB、命中测试）一行都不用改；
 *   · `closed` 标志区分"要不要闭合成环"（矩形闭合、线段不闭合）——
 *     画笔据此决定 stroke() 还是 fill()+stroke()。
 *
 * ★ 生成的点在【世界坐标】里，且以对象原点为中心/相对原点 ——
 *   与 tf.x/tf.y 的整体搬运、tf.rotate 的旋转天然一致。
 */
import type { Vec2 } from '../math/vec2';
import type { Polyline } from './plot';

/** 圆角每 90° 用多少段逼近。4 段在 1080p 下已经看不出折角，而点数省 4 倍。 */
const ARC_SEGMENTS_PER_QUARTER = 6;

/**
 * 矩形：中心在原点，宽高由参数给定，可圆角。
 *
 * ★ 圆角半径会被夹到"半边长"，所以 radius 给大了不会画成怪异形状 ——
 *   模型很容易把 radius 填成比半边长还大，夹一下比让它报错友好（而且确定性）。
 */
export function sampleRect(width: number, height: number, radius: number): Polyline {
  const w = Math.max(1e-6, Math.abs(width));
  const h = Math.max(1e-6, Math.abs(height));
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(Math.max(0, radius), hw, hh);

  const points: Vec2[] = [];
  if (r <= 1e-9) {
    points.push({ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh });
    return { points, breaks: [0] };
  }

  // 四个圆角，从右下角开始逆时针（y 轴向上）
  const corners: readonly (readonly [number, number, number])[] = [
    [hw - r, -hh + r, -Math.PI / 2], // 右下
    [hw - r, hh - r, 0], // 右上
    [-hw + r, hh - r, Math.PI / 2], // 左上
    [-hw + r, -hh + r, Math.PI], // 左下
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= ARC_SEGMENTS_PER_QUARTER; i++) {
      const a = start + (Math.PI / 2) * (i / ARC_SEGMENTS_PER_QUARTER);
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return { points, breaks: [0] };
}

/** 线段：两个点，头部是否画箭头由调用方（画笔）按 style.head 决定。 */
export function sampleLine(from: readonly [number, number], to: readonly [number, number]): Polyline {
  return {
    points: [
      { x: Number(from[0]) || 0, y: Number(from[1]) || 0 },
      { x: Number(to[0]) || 0, y: Number(to[1]) || 0 },
    ],
    breaks: [0],
  };
}
