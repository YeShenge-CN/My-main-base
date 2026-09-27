/**
 * 二维向量。
 *
 * 纯值对象：字段 readonly，所有运算函数都是纯函数，输入永不被修改。
 * 世界坐标系是数学坐标（y 轴向上），Vec2 本身不区分世界/像素空间，
 * 空间语义由使用方（Mat2D 的语义）决定。
 */

/** 二维向量。使用 {x, y} 而非元组，便于文档层直接序列化。 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** 浮点比较与退化判定的默认容差。 */
export const EPSILON = 1e-9;

export const ZERO: Vec2 = Object.freeze({ x: 0, y: 0 });
export const ONE: Vec2 = Object.freeze({ x: 1, y: 1 });
export const UNIT_X: Vec2 = Object.freeze({ x: 1, y: 0 });
export const UNIT_Y: Vec2 = Object.freeze({ x: 0, y: 1 });

/** 构造向量。 */
export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

/** 从 [x, y] 元组构造（Scene Doc 里的 pivot / domain 都是元组形式）。 */
export function fromTuple(t: readonly [number, number]): Vec2 {
  return { x: t[0], y: t[1] };
}

/** 转成元组。 */
export function toTuple(v: Vec2): [number, number] {
  return [v.x, v.y];
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** 标量乘法。 */
export function scale(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

export function negate(v: Vec2): Vec2 {
  return { x: -v.x, y: -v.y };
}

/** 逐分量乘法。 */
export function mul(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x * b.x, y: a.y * b.y };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 二维叉积的 z 分量（有向面积的两倍）。 */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function lengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  return lengthSq(sub(a, b));
}

/**
 * 单位化。
 * 零向量（或含非有限分量）返回 ZERO —— 明确不返回 NaN 向量，
 * 让"退化输入"传播为可判定的确定值，而不是污染整条求值链（不变量 1）。
 */
export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  if (!(len > EPSILON) || !Number.isFinite(len)) return ZERO;
  return { x: v.x / len, y: v.y / len };
}

/** 线性插值；k 不做夹紧（夹紧由 ease 层负责）。 */
export function lerp(a: Vec2, b: Vec2, k: number): Vec2 {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** 逆时针旋转 rad 弧度（数学坐标系，y 轴向上）。 */
export function rotate(v: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** 极角 atan2(y, x)，范围 (-PI, PI]。 */
export function angle(v: Vec2): number {
  return Math.atan2(v.y, v.x);
}

/** 逐分量相等判定，容差默认 EPSILON。 */
export function equals(a: Vec2, b: Vec2, eps: number = EPSILON): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** 是否为零向量（容差内）。 */
export function isZero(v: Vec2, eps: number = EPSILON): boolean {
  return Math.abs(v.x) <= eps && Math.abs(v.y) <= eps;
}

/** 分量是否全为有限数；采样器用它剔除 NaN/Inf。 */
export function isFiniteVec(v: Vec2): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y);
}

/** 调试用字符串。 */
export function format(v: Vec2, digits: number = 3): string {
  return '(' + v.x.toFixed(digits) + ', ' + v.y.toFixed(digits) + ')';
}
