/**
 * 关键帧编辑（§7 第 4 条）：时间轴上的关键帧手柄。
 *
 * ★ 在这之前，面板里唯一能对动画做的事是那个 ◆ 开关 —— 它只会生成一条
 *   "从 0 淡入到当前值"的默认轨道，**时间点改不了**（交接文档的原话）。
 *   于是"这一刻太早/太晚"只能整条轨道重写，或者去求 AI。
 *
 * ★ 与 `command-path.ts` / `scene-edit.ts` 同一条理由：规则必须抽成纯函数。
 *   "拖到哪里算合法"（吸附帧网格、夹在相邻帧之间、不许越出镜头）是真规则，
 *   而 `set_motion` 是**整条轨道替换**语义 —— 拖错一格就是把整条动画写坏，
 *   没有"撤销一步"这种东西可以依赖。
 *
 * ★ 取值一律走引擎的 `evaluateObjectAnim`，不在这里重实现插值：
 *   "插一个关键帧但动画形状不变"这件事，靠的就是"新帧的取值 = 那一刻求值出来的值"。
 *   自己写一份线性插值就会与缓动、颜色插值两处口径分叉。
 */
import {
  evaluateObjectAnim,
  type AnimKey,
  type AnimTrack,
  type FieldAtom,
  type SceneObject,
} from '@sva/engine-core';

/** 一条轨道的手柄行。expr 轨道没有手柄可拖，但要显示出来（否则用户以为它丢了）。 */
export interface KeyframeRow {
  readonly track: string;
  /** 'keys' 才有手柄；'expr' 只有一行说明。 */
  readonly kind: 'keys' | 'expr';
  readonly keys: readonly AnimKey[];
  readonly expr?: string;
}

/** 按 t 升序。文档里不保证有序，而"第几个手柄"必须与显示顺序一致。 */
export function sortedKeys(keys: readonly AnimKey[]): readonly AnimKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** 选中对象身上所有轨道的行（顺序 = anim 的键顺序，稳定）。 */
export function keyframeRows(obj: SceneObject): readonly KeyframeRow[] {
  const out: KeyframeRow[] = [];
  for (const track of Object.keys(obj.anim)) {
    const tr = obj.anim[track];
    if (tr === undefined) continue;
    if (tr.kind === 'expr') {
      out.push({ track, kind: 'expr', keys: [], expr: tr.expr });
      continue;
    }
    out.push({ track, kind: 'keys', keys: sortedKeys(tr.keys) });
  }
  return out;
}

/** 一帧的长度（秒）。 */
export function frameStep(fps: number): number {
  return fps > 0 ? 1 / fps : 0;
}

/** 吸附到帧网格并夹进 [0, duration] —— 与播放头用的是同一套离散化。 */
export function snapTime(t: number, fps: number, duration: number): number {
  const step = frameStep(fps);
  const snapped = step > 0 ? Math.round(t / step) * step : t;
  return Math.min(duration, Math.max(0, snapped));
}

export interface MoveBounds {
  readonly duration: number;
  readonly fps: number;
}

/**
 * 把第 index 个关键帧挪到 t。
 *
 * 规则（三条都有断言）：
 *   · 吸附帧网格并夹进 [0, duration]；
 *   · **不许越过邻居**（每个方向都留一帧的间隙）—— 越过之后"第 index 个"指谁就变了，
 *     而手柄是按位置抓的，用户会看到它跳到自己手指外面；
 *   · 结果仍然按 t 升序（所以"第 index 个"在返回数组里位置不变）。
 *
 * 返回新数组；原数组不动（文档不可变）。
 */
export function moveKey(
  keys: readonly AnimKey[],
  index: number,
  t: number,
  bounds: MoveBounds,
): readonly AnimKey[] {
  const sorted = sortedKeys(keys);
  const target = sorted[index];
  const step = frameStep(bounds.fps);
  if (target === undefined) return sorted;

  const before = sorted[index - 1];
  const after = sorted[index + 1];
  const lo = before === undefined ? 0 : before.t + step;
  const hi = after === undefined ? bounds.duration : after.t - step;
  const snapped = snapTime(t, bounds.fps, bounds.duration);
  // ★ 邻居夹得比边界更紧时，**以邻居为准**（宁可挪不动，也不要越过它）
  const lower = Math.min(lo, target.t);
  const upper = Math.max(hi, target.t);
  const next = Math.min(upper, Math.max(lower, snapped));

  return sorted.map((k, i) => (i === index ? { ...k, t: next } : k));
}

/** 删掉第 index 个关键帧。删空返回 []，调用方据此**删掉整条轨道**（空轨道是校验错误）。 */
export function removeKey(keys: readonly AnimKey[], index: number): readonly AnimKey[] {
  return sortedKeys(keys).filter((_, i) => i !== index);
}

/**
 * 在 t 处插一个关键帧，取值 = 该时刻【求值出来的当前值】。
 *
 * ★ 这是"插帧不改变动画形状"的判据：新帧落在原曲线上，所以前后画面一模一样，
 *   用户拿到的是一个可以接着拖的把手，而不是一次意外的跳变。
 *
 * 同一帧里已经有关键帧时返回 null（不给插两个 —— 那会让"第几个"变得没有意义）。
 */
export function insertKeyAt(
  obj: SceneObject,
  track: string,
  keys: readonly AnimKey[],
  t: number,
  bounds: MoveBounds,
): readonly AnimKey[] | null {
  const at = snapTime(t, bounds.fps, bounds.duration);
  // ★ 判据是【吸附后落在同一帧】，不是"距离小于半帧"：
  //   关键帧的位置永远是帧网格上的点，所以"同一帧"就是"吸附后相等"。
  if (keys.some((k) => snapTime(k.t, bounds.fps, bounds.duration) === at)) return null;
  const v = animatedValueAt(obj, track, at);
  if (v === null) return null;
  return sortedKeys([...keys, { t: at, v }]);
}

/**
 * 某条轨道在 t 处的当前取值 —— 走引擎的求值路径（含缓动与颜色插值）。
 *
 * 拿不到（没登记的 zone、求值失败）时返回 null：宁可插不进去，
 * 也不要插一个"我猜的值"，那会在下一帧变成一次无法解释的跳变。
 */
export function animatedValueAt(obj: SceneObject, track: string, t: number): FieldAtom | null {
  const dot = track.indexOf('.');
  if (dot < 0) return null;
  const zone = track.slice(0, dot);
  const key = track.slice(dot + 1);
  const anim = evaluateObjectAnim(obj, t);
  if (zone === 'tf') {
    const v = (anim.tf as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' ? v : null;
  }
  if (zone === 'style') {
    const v = anim.style[key];
    return v === undefined ? null : v;
  }
  return null;
}

/** 把一组关键帧包成 `set_motion` 要的轨道节点；空数组 = 删掉这条轨道（返回 null）。 */
export function trackOf(keys: readonly AnimKey[]): AnimTrack | null {
  return keys.length === 0 ? null : { kind: 'keys', keys: [...keys] };
}
