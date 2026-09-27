/**
 * 多镜头串行渲染的编排层（P12 第 6 条）。
 *
 * ★★ 本模块存在的全部理由是维护不变量 1：
 *    `evaluate(doc, t)` 只能保持"纯函数 + 单一绝对时间"的形状，
 *    镜头逻辑【不许】塞进求值里。所以镜头编排是 evaluate 外面的一层 select：
 *
 *        时间 → 属于哪个镜头 → 这个镜头该看哪些对象
 *
 *    三件事各自只做一件：
 *      planShotFrames     帧网格 + 每帧归属哪个镜头（纯数据，谁都能算）
 *      shotAt             某一时刻落在哪一镜
 *      sceneItemFilter    某镜头该显示哪些对象（作用在 RenderState.items 上）
 *
 * ★ 为什么"同一份帧计划"必须同时给导出、预览、面板用：
 *    只要有两处各自算一遍"这一帧属于哪一镜"，它们迟早会算出不同的答案，
 *    而症状是"预览看起来对、成片少了一段"这种最难查的东西。
 */
import type { ObjectId, SceneDoc, SceneId } from './doc/types';
import { sceneOrder } from './doc/types';
import type { RenderItem, RenderState } from './render-state';

/** 一个镜头在时间轴上的占用。end 取的是"下一镜起点"，所以是半开区间 [start, end)。 */
export interface ShotSpan {
  readonly sceneId: SceneId;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 一帧。
 *
 * `sceneId` 为 null = 这一帧落在【镜头之间的空档】里。
 * A1（镜头结束 = 下一镜起点）表达不了黑场，但空档仍会出现：
 * 删镜头不缩短片长、镜头起点可以留缝。这种帧渲染出来就是背景色，
 * 不需要任何特判 —— 没有镜头，就没有任何对象对得上。
 */
export interface ShotFrame {
  readonly frame: number;
  readonly t: number;
  readonly sceneId: SceneId | null;
}

/** 帧计划：面板 / 预览 / 导出都靠它把帧号、时刻、镜头对上。 */
export interface ShotTimeline {
  readonly fps: number;
  readonly duration: number;
  readonly frameCount: number;
  /** 空数组 = 没有镜头表 = 单镜头旧行为（全片一镜，不需要过滤）。 */
  readonly shots: readonly ShotSpan[];
  readonly frames: readonly ShotFrame[];
  /**
   * 空档（没有任何镜头覆盖的时刻），已成区间。
   * 有值不代表出错 —— 它是"这一段渲染出来是背景"的显式记录。
   */
  readonly gaps: readonly (readonly [number, number])[];
}

const NO_SPANS: readonly ShotSpan[] = [];

/** 文档有没有镜头表。空表与缺失都算"没有"。 */
export function hasSceneTable(doc: SceneDoc): boolean {
  return Array.isArray(doc.scenes) && doc.scenes.length > 0;
}

/**
 * 镜头占用区间。
 *
 * ★ 空 `scenes` 表返回空数组，而**不是**"一个覆盖全片的假镜头"：
 *   空表 = 单镜头旧行为，那时根本不需要按镜头过滤。
 *   在这里造一个假镜头，会让"有没有镜头表"这件事在多处出现两种表示。
 */
export function shotSpans(doc: SceneDoc): readonly ShotSpan[] {
  const ordered = sceneOrder(doc);
  if (ordered.length === 0) return NO_SPANS;
  return ordered.map((s, i) => {
    const next = ordered[i + 1];
    // A1：最后一镜到片长为止（meta.duration 是自由变量，见 reconcileDuration）
    const end = next === undefined ? doc.meta.duration : next.bornAt;
    return { sceneId: s.id, name: s.name, start: s.bornAt, end };
  });
}

/**
 * 某一时刻属于哪一镜。
 *
 * 区间是半开 [start, end)：t 恰好落在下一镜起点时算【下一镜】的，
 * 这与"上一镜在下一镜开始时结束"一致，不会让边界帧同时属于两镜。
 */
export function shotAt(spans: readonly ShotSpan[], t: number): SceneId | null {
  for (const span of spans) {
    if (t >= span.start && t < span.end) return span.sceneId;
  }
  return null;
}

/**
 * 帧计划。
 *
 * ★ frameCount 用 round(duration × fps)，与 encode.ts 的 frameCount 同一套口径。
 *   两处一旦分叉，成片的帧数就和渲染的帧数对不上了。
 *
 * ★ 最后一帧特判：整数帧网格下 t = (frameCount−1)/fps 通常【够不到】duration
 *   （duration=12、fps=60 时最后一帧 t=11.9833）。若最后一镜的起点落在
 *   11.9833 与 12 之间，它就会掉进空档 —— 成片以黑屏收尾。
 *   所以最后一帧归给最后一镜：宁可多给它一帧画面，也不要结尾黑一下。
 */
export function planShotFrames(doc: SceneDoc): ShotTimeline {
  const fps = doc.meta.fps;
  const duration = doc.meta.duration;
  const frameCount = Math.max(1, Math.round(duration * fps));
  const shots = shotSpans(doc);
  const lastSceneId = shots.length === 0 ? null : shots[shots.length - 1]!.sceneId;

  const frames: ShotFrame[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame / fps;
    const sceneId = frame === frameCount - 1 ? lastSceneId : shotAt(shots, t);
    frames.push({ frame, t, sceneId });
  }

  // 空档：只在【有镜头表】时才有意义（没有表就全片都"没有镜头"）
  const gaps: (readonly [number, number])[] = [];
  if (shots.length > 0) {
    if (shots[0]!.start > 0) gaps.push([0, shots[0]!.start]);
    for (let i = 0; i < shots.length - 1; i++) {
      const cur = shots[i]!;
      const next = shots[i + 1]!;
      if (next.start > cur.end) gaps.push([cur.end, next.start]);
    }
  }

  return { fps, duration, frameCount, shots, frames, gaps };
}

/** 第 N 帧属于哪一镜（越界返回 null）。 */
export function frameSceneId(timeline: ShotTimeline, frame: number): SceneId | null {
  return timeline.frames[frame]?.sceneId ?? null;
}

/**
 * 某镜头该显示哪些对象。
 *
 * 规则（每条都有对应断言）：
 *   scene 类  owner.sceneId === 本镜
 *   shared    【永远显示】—— 它存在的意义就是跨镜复用，按镜头过滤等于抹掉它
 *   global    【永远显示】—— 全片共用（规范 §11："global 对象完全不动"）
 *
 * ★ 文档【没有镜头表】时一律显示：那是单镜头旧行为，全片就一镜，
 *   过滤没有任何信息可依据，只会把对象误藏起来。
 *
 * ★ 指向不存在镜头的对象（悬空 owner）也一律显示：宁可多画，也不要静默丢内容。
 *   这种情况由校验器报 scene_ref_missing 让人去修，不该在这里被吞掉。
 *
 * ★ sceneId 为 null（空档帧）时返回"什么都不显示"：空档里本来就该只有背景。
 */
export function sceneItemFilter(doc: SceneDoc, sceneId: SceneId | null): (item: RenderItem) => boolean {
  if (!hasSceneTable(doc)) return () => true;
  if (sceneId === null) return () => false;

  const ownerScene = new Map<ObjectId, SceneId>();
  for (const [id, obj] of Object.entries(doc.objects)) {
    if (obj.owner.kind === 'scene') ownerScene.set(id, obj.owner.sceneId);
  }
  const known = new Set(sceneOrder(doc).map((s) => s.id));
  return (item) => {
    const owned = ownerScene.get(item.id);
    if (owned === undefined) return true; // shared / global：全镜可见
    if (!known.has(owned)) return true; // 悬空归属：交给校验器报，不在这里吞
    return owned === sceneId;
  };
}

/**
 * 按镜头过滤 RenderState。
 *
 * ★ 只重建 items，不动 t / camera / matrix —— 相机是全片的，
 *   它不该因为"这一帧属于哪一镜"而改变（相机 key 本来就是绝对时间）。
 */
export function filterRenderStateByScene(state: RenderState, doc: SceneDoc, sceneId: SceneId | null): RenderState {
  if (!hasSceneTable(doc)) return state;
  const keep = sceneItemFilter(doc, sceneId);
  const items = state.items.filter(keep);
  if (items.length === state.items.length) return state;
  return { ...state, items };
}
