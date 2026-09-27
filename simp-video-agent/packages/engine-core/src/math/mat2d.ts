/**
 * 2D 仿射矩阵。
 *
 * 存储顺序与 Canvas2D 的 setTransform / DOMMatrix 完全一致：
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 *
 * 点变换：
 *     x' = a*x + c*y + e
 *     y' = b*x + d*y + f
 *
 * 乘法约定：multiply(A, B) === A · B，即"先施加 B，再施加 A"。
 * compose(A, B, C) === A · B · C，与书写顺序一致（最左边的最后施加）。
 * 相机矩阵 M = T(cx,cy) · S(scale) · R(rotate) · T(-pivot·base) 直接照抄这条约定。
 *
 * 关于"旋转方向"：本矩阵是纯代数对象。在数学坐标系（y 轴向上）里
 * rotation(θ) 表示逆时针转 θ；同一个矩阵作用在像素坐标系（y 轴向下）上
 * 视觉上是顺时针。y 轴翻转由 worldToPixel 的 -base 负责，不在这里。
 *
 * 所有函数都是纯函数，输入永不被修改（不变量 1）。
 */
import type { Vec2 } from './vec2';
import { EPSILON } from './vec2';

export interface Mat2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** 六元组形式，直接喂给 CanvasRenderingContext2D.setTransform。 */
export type TransformTuple = readonly [number, number, number, number, number, number];

/** 构造。 */
export function of(a: number, b: number, c: number, d: number, e: number, f: number): Mat2D {
  return { a, b, c, d, e, f };
}

export function identity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** 平移矩阵。 */
export function translation(tx: number, ty: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/** 缩放矩阵；sy 省略时等比。 */
export function scaling(sx: number, sy: number = sx): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** 旋转矩阵（数学坐标系下逆时针 rad 弧度）。 */
export function rotation(rad: number): Mat2D {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/**
 * 矩阵乘法：返回 A · B（先施加 B，再施加 A）。
 */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/**
 * 从左到右复合：compose(A, B, C) === A · B · C。
 * 无参数时返回单位矩阵。
 */
export function compose(...ms: readonly Mat2D[]): Mat2D {
  let out = identity();
  for (const m of ms) out = multiply(out, m);
  return out;
}

/** 变换一个点（含平移）。 */
export function applyToPoint(m: Mat2D, p: Vec2): Vec2 {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

/** 变换一个方向/增量（忽略平移）。 */
export function applyToVector(m: Mat2D, v: Vec2): Vec2 {
  return {
    x: m.a * v.x + m.c * v.y,
    y: m.b * v.x + m.d * v.y,
  };
}

/** 行列式（有向面积缩放因子）。 */
export function determinant(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}

/**
 * 求逆。矩阵奇异（行列式为 0）或结果含非有限分量时返回 null。
 *
 * 返回 null 而不是 NaN 矩阵，是为了让"不可逆"成为一个必须被调用方
 * 显式处理的分支，而不是静默地把 NaN 注入整条求值链。
 */
export function invert(m: Mat2D): Mat2D | null {
  const det = determinant(m);
  if (det === 0 || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  const out: Mat2D = {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
  return isFiniteMat(out) ? out : null;
}

/**
 * 基向量长度，即两个轴向上的缩放倍数。
 * 描边宽度、圆角、发光半径在相机变换后要乘的正是这个量。
 */
export function scaleOf(m: Mat2D): Vec2 {
  return { x: Math.hypot(m.a, m.b), y: Math.hypot(m.c, m.d) };
}

/** 平均缩放（等比相机下 x 与 y 相同；非等比时取几何平均）。 */
export function averageScale(m: Mat2D): number {
  const s = scaleOf(m);
  return Math.sqrt(Math.abs(s.x * s.y));
}

export function isFiniteMat(m: Mat2D): boolean {
  return (
    Number.isFinite(m.a) &&
    Number.isFinite(m.b) &&
    Number.isFinite(m.c) &&
    Number.isFinite(m.d) &&
    Number.isFinite(m.e) &&
    Number.isFinite(m.f)
  );
}

export function equals(m1: Mat2D, m2: Mat2D, eps: number = EPSILON): boolean {
  return (
    Math.abs(m1.a - m2.a) <= eps &&
    Math.abs(m1.b - m2.b) <= eps &&
    Math.abs(m1.c - m2.c) <= eps &&
    Math.abs(m1.d - m2.d) <= eps &&
    Math.abs(m1.e - m2.e) <= eps &&
    Math.abs(m1.f - m2.f) <= eps
  );
}

export function isIdentity(m: Mat2D, eps: number = EPSILON): boolean {
  return equals(m, identity(), eps);
}

export function toTransform(m: Mat2D): TransformTuple {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

export function fromTransform(t: TransformTuple): Mat2D {
  return of(t[0], t[1], t[2], t[3], t[4], t[5]);
}

/** 调试用字符串。 */
export function format(m: Mat2D, digits: number = 3): string {
  return (
    'Mat2D[a=' +
    m.a.toFixed(digits) +
    ' b=' +
    m.b.toFixed(digits) +
    ' c=' +
    m.c.toFixed(digits) +
    ' d=' +
    m.d.toFixed(digits) +
    ' e=' +
    m.e.toFixed(digits) +
    ' f=' +
    m.f.toFixed(digits) +
    ']'
  );
}
