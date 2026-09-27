/**
 * 缓动函数库。
 *
 * 刻意保持小而封闭：缓动名会进 FieldRegistry 的 enum（按 shape / effect 的 ease 字段），
 * 所以新增一个名字等于新增一个契约。未登记的 ease 名一律回退到 linear，
 * 不抛异常 —— 求值路径不允许因为一个笔误把整帧打断（与"确定性"同源）。
 */

export type EaseName =
  | 'linear'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutBack';

export type EaseFn = (k: number) => number;

/**
 * 夹紧到 [0,1]。ease 的输入永远是归一化进度。
 * 只有 NaN 归 0：+Infinity 是"远超终点"（夹到 1），-Infinity 是"远在起点之前"（夹到 0）。
 */
export function clamp01(k: number): number {
  if (Number.isNaN(k)) return 0;
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

export const EASES: Readonly<Record<EaseName, EaseFn>> = {
  linear: (k) => k,
  easeInCubic: (k) => k * k * k,
  easeOutCubic: (k) => 1 - Math.pow(1 - k, 3),
  easeInOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  // 刻意会过冲（>1）：pushIn 这类镜头用它做出"顶一下"的手感
  easeOutBack: (k) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  },
};

export const EASE_NAMES: readonly EaseName[] = [
  'linear',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeOutBack',
];

/** 按名字取缓动；未知名回退 linear。 */
export function easeFn(name: string | undefined): EaseFn {
  if (name !== undefined && Object.prototype.hasOwnProperty.call(EASES, name)) {
    return EASES[name as EaseName];
  }
  return EASES.linear;
}

/**
 * 施加缓动。输入先夹紧到 [0,1]。
 * 返回值【不】夹紧 —— easeOutBack 需要过冲。
 */
export function applyEase(name: string | undefined, k: number): number {
  return easeFn(name)(clamp01(k));
}
