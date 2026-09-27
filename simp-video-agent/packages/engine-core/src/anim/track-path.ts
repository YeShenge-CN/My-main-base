/**
 * 轨道路径解析（anim 的键）。
 *
 * 单独成文件，是为了让校验器（validate/）能只依赖这一小块做结构检查，
 * 而不必把表达式编译器与采样逻辑一起拖进来。
 *
 * ★ params.* 的轨道【不支持】，而且是刻意的：
 *   params 是 geometry 类（改它必须重新采样），而规范 §5 钉死了
 *   "samples 永远是全定义域采样、绘制动画用可见子集绘制"。
 *   让 params.expr 跟着 t 逐帧重采样会直接违反那条不变量。
 *   所以这里只认 tf 与 style，params 一律返回 null，由调用方报出来。
 */

export type TrackZone = 'tf' | 'style';

export interface TrackPath {
  /** 接受 'tf.opacity'（对象相对）与 'objects.<id>.tf.opacity'（完整）两种写法。 */
  readonly zone: TrackZone;
  /** 字段名，如 'opacity'、'width'。 */
  readonly key: string;
}

/** 可动画的 tf 字段。与 registry 的 object.tf 分组一一对应。 */
export const TF_KEYS: readonly string[] = ['x', 'y', 'rotate', 'sx', 'sy', 'opacity'];

/**
 * 解析轨道路径。不支持的路径返回 null —— 由调用方报出来，不静默忽略。
 *
 * 为什么同时收两种写法：文档里的 anim 键按规范是对象相对（'tf.opacity'），
 * 但 locks 与 affectedPaths 用的是完整路径（'objects.plot#1.style.width'）。
 * 让模型在两者之间猜格式是没必要的摩擦，所以两种都认，内部统一到 zone+key。
 */
export function parseTrackPath(path: string): TrackPath | null {
  const parts = path.split('.');
  const offset = parts[0] === 'objects' && parts.length >= 4 ? 2 : 0;
  const zone = parts[offset];
  const key = parts[offset + 1];
  if (zone === undefined || key === undefined) return null;
  if (offset === 2 && parts.length !== 4) return null;
  if (offset === 0 && parts.length !== 2) return null;
  if (zone === 'tf' || zone === 'style') return { zone, key };
  return null;
}

/** 这条路径是不是本版本支持的轨道。 */
export function isAnimatablePath(path: string): boolean {
  const parsed = parseTrackPath(path);
  if (parsed === null) return false;
  if (parsed.zone === 'tf') return TF_KEYS.includes(parsed.key);
  return true; // style 的字段合法性由绘制层决定；这里不假装知道 shape
}
