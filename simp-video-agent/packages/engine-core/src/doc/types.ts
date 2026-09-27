/**
 * Scene Doc 的类型骨架（规范 §5）。
 *
 * 本文件只定义【结构】：谁装什么、谁引用谁。字段级的取值约束一律不在这里 ——
 * 那是 FieldRegistry 的职责（规范 §6）。等 P2 item 2 把字段全量登记进去后，
 * params / style 的宽松 Record 会换成按 shape 生成的强类型。
 */
import type { DocValue } from '../registry/types';

export type ObjectId = string;
export type EffectId = string;
export type LayerId = string;
export type MarkerId = string;
export type SceneId = string;

/** 字段取值的可序列化原子类型。 */
export type FieldAtom = string | number | boolean | readonly number[];
export type FieldRecord = Readonly<Record<string, DocValue<FieldAtom>>>;

export interface DocMeta {
  readonly fps: number;
  /** 导出像素尺寸。canvas.width/height 就是它，永不使用 devicePixelRatio。 */
  readonly viewport: readonly [number, number];
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly duration: number;
  readonly seed: number;
}

export interface Theme {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  readonly glow: number;
}

export interface Layer {
  readonly id: LayerId;
  readonly depth: number;
  readonly order: number;
  readonly parallax: number;
  readonly objects: readonly ObjectId[];
}

/** 场景归属：决定写权限与 retime 行为（规范 §11）。 */
export type OwnerInfo =
  | { readonly kind: 'scene'; readonly sceneId: SceneId; readonly bornAt: number }
  | { readonly kind: 'global' }
  | { readonly kind: 'shared'; readonly sharedId: string; readonly usageWindows: readonly (readonly [number, number])[] };

export interface ObjectTransform {
  readonly x: number;
  readonly y: number;
  readonly rotate: number;
  readonly sx: number;
  readonly sy: number;
  readonly opacity: number;
}

export type EaseNameValue = string;

export interface AnimKey {
  readonly t: number;
  readonly v: FieldAtom;
  readonly ease?: EaseNameValue;
}

/** 一条动画轨道。keys 与 expr 二选一（kind 判别）。 */
export type AnimTrack =
  | { readonly kind: 'keys'; readonly keys: readonly AnimKey[] }
  | { readonly kind: 'expr'; readonly expr: string };

/** 轨道路径 → 轨道。路径形如 'tf.opacity'、'style.width'。 */
export type AnimTracks = Readonly<Record<string, AnimTrack>>;

export interface SceneObject {
  readonly shape: string;
  readonly owner: OwnerInfo;
  /**
   * 父对象 id（可选）。给了就【继承父级的变换】。
   *
   * ★★ 这是"分组"的落地方式，而不是一个新 shape。
   *
   *   理由：分组要的只有一件事 —— **整体移动 / 旋转 / 缩放一组东西**。
   *   那件事的本质是"变换链"，不是"一个叫 group 的图形"。
   *   做成 shape 会立刻冒出三个假问题：group 自己的包围盒怎么算、
   *   它怎么被画出来、它能不能有 style。而做成父子关系，这三个问题都不存在。
   *
   * ★ 它顺带激活了三件早就存在、却几乎没用过的东西：
   *   `tf.rotate` / `tf.sx` / `tf.sy`（绕自己的原点旋缩）此前对单个方框
   *   毫无意义 —— 现在"让整组倾斜 15°"是一行命令。
   *
   * ★ 刻意不做的事：不引入"布局引擎"（自动排布 / flex / 网格）。
   *   规范 §14 明确不做过度工程；"一组方块整体挪一下"是真实需求，
   *   "自动算 20 个方块的位置"不是 —— 那件事该由 Agent 算好再写进来。
   */
  readonly parent?: ObjectId;
  /** 几何类字段：改动触发重采样 */
  readonly params: FieldRecord;
  /** 绘制类字段：改动只重绘 */
  readonly style: FieldRecord;
  readonly tf: ObjectTransform;
  readonly anim: AnimTracks;
  readonly effects: readonly EffectId[];
}

export interface Effect {
  readonly type: string;
  readonly target: ObjectId;
  readonly params: FieldRecord;
  readonly ease?: EaseNameValue;
}

export interface CameraKey {
  readonly t: number;
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly rotate: number;
  readonly pivot: readonly [number, number];
  readonly ease?: EaseNameValue;
}

export interface Camera {
  readonly keys: readonly CameraKey[];
}

export interface Marker {
  readonly id: MarkerId;
  readonly t: number;
}

/* ── 镜头表（P12）──────────────────────────────────────────── */

/**
 * 一个镜头。
 *
 * ★ A1：**结束时刻不存**，由"下一个镜头的起点"派生（见 sceneEnd）。
 *   理由是规范 §2 不变量 1 的推论：派生量不该有第二份真源 ——
 *   存了 start/end 之后，"删掉中间一镜"就必然出现"上一个的 end 与下一个的
 *   start 谁说了算"的问题，而这类不一致在撤销/retime 之后尤其难查。
 *   代价是表达不了"镜头之间的黑场"：真需要黑场时再加显式的 gap，
 *   不要现在就为它引入第二个真源。
 *
 * ★ bornAt 是【引擎推导】的：对象被创建在哪个镜头，就是那个镜头的 bornAt。
 *   命令与模型都不声明它（规范 §4 信任边界：模型只表达意图）。
 */
export interface Scene {
  readonly id: SceneId;
  readonly name: string;
  readonly bornAt: number;
}

/**
 * 镜头表的查询与派生。整份代码里【只此一处】定义这些规则。
 *
 * scenes 的顺序不是真源：一律用 sceneOrder() 归一化后再说话，
 * 这样"表里写乱了顺序"不会变成画面上的怪事。
 *
 * ★ 读的时候一律经 scenesOf()，不要直接 `doc.scenes`：
 *   类型上它是必填，但运行期有两类文档没有这个字段 ——
 *   存量的 out/*.json（加字段之前落盘的）与手写测试字面量。
 *   它们都等价于"空表 = 单镜头"，而不是"坏文档"。
 */

/** 镜头表；缺失视为空表（存量文档 / 单镜头）。 */
function scenesOf(doc: SceneDoc): readonly Scene[] {
  return Array.isArray(doc.scenes) ? doc.scenes : [];
}

/** 按 bornAt 升序（bornAt 相同则按 id）归一化的镜头表。 */
export function sceneOrder(doc: SceneDoc): readonly Scene[] {
  return [...scenesOf(doc)].sort((a, b) => (a.bornAt - b.bornAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function findScene(doc: SceneDoc, sceneId: SceneId): Scene | undefined {
  return scenesOf(doc).find((s) => s.id === sceneId);
}

/**
 * 某镜的结束时刻 = 下一镜的起点；最后一镜到整片时长为止。
 *
 * ⚠️ 依赖 meta.duration 已经与镜头表对齐（reconcileDuration）。目前还没有任何命令
 *    能改 scenes，所以两者不可能不一致；等 set_scene / retime 接进来时，
 *    每一条改 scenes 的命令都必须调 reconcileDuration，否则这里会算出
 *    "结束早于开始"的窗口。
 */
export function sceneEnd(doc: SceneDoc, sceneId: SceneId): number {
  const ordered = sceneOrder(doc);
  const idx = ordered.findIndex((s) => s.id === sceneId);
  if (idx < 0) return doc.meta.duration;
  const next = ordered[idx + 1];
  return next === undefined ? doc.meta.duration : next.bornAt;
}

/** 某镜的 [起点, 结束点]。镜头不存在时退化成 [0, duration]（由校验器报出）。 */
export function sceneWindow(doc: SceneDoc, sceneId: SceneId): readonly [number, number] {
  const scene = findScene(doc, sceneId);
  if (scene === undefined) return [0, doc.meta.duration];
  return [scene.bornAt, sceneEnd(doc, sceneId)];
}

/** 最深（最靠后）的那一镜。空表返回 undefined。 */
export function lastScene(doc: SceneDoc): Scene | undefined {
  const ordered = sceneOrder(doc);
  return ordered[ordered.length - 1];
}

/**
 * 把 meta.duration 与镜头表对齐（B1 的"缓存维护"）。
 *
 * ★ 这里必须说清一件容易写错的事：`{id, name, bornAt}` **派生不出时长**。
 *   最后一镜的结束点就是 meta.duration 本身（见 sceneEnd），它是自由变量 ——
 *   想"让 duration 由镜头表算出来"就必须给最后一镜存一个 end，
 *   而那正是 A2，被否掉了。
 *
 *   所以 B1 在这里落地成一条【单向】规则，而不是双向同步：
 *     duration 绝不短于最后一镜的起点（短了就是"镜头落在片长之外"，非法）；
 *     但 duration **永不自动缩短** —— 否则"追加一镜"会顺手把前一片尾截掉，
 *     那种静默丢内容比数字不一致危险得多。
 *   片长的收短只能由显式的 set_meta(duration) 或删镜头的人来做。
 *
 *   另外：空表时原样返回。规范里的"没有镜头表"= 旧行为（单镜头），
 *   不是"片长为 0"。
 */
export function reconcileDuration(doc: SceneDoc): SceneDoc {
  const last = lastScene(doc);
  if (last === undefined) return doc;
  if (doc.meta.duration >= last.bornAt) return doc;
  return { ...doc, meta: { ...doc.meta, duration: last.bornAt } };
}

/** 锁：hard = 用户手动改过；soft = AI 仍拥有但当前被动画驱动（规范 §8）。 */
export interface LockEntry {
  readonly by: 'user' | 'ai';
  readonly at: number;
}

/**
 * 锁的两档。
 *   hard  用户手动改过 → 必须 request_patch + 用户同意
 *   soft  AI 仍拥有   → AI 可改，但若当前被动画驱动，必须说明"会覆盖动画"
 */
export type LockClass = 'hard' | 'soft';

/** 锁分档规则。整个仓库只在这里定义一次。 */
export function lockClassOf(entry: LockEntry): LockClass {
  return entry.by === 'user' ? 'hard' : 'soft';
}

/* ── 音频 / 字幕（P11）───────────────────────────────────────── */

export type AudioKind = 'narration' | 'bgm' | 'sfx';

export interface AudioTrack {
  readonly id: string;
  /** 本机音频文件路径（导出时才用得上，文档里只记路径） */
  readonly src: string;
  /** 相对镜头起点的秒数 */
  readonly startAt: number;
  /** 线性增益 0..2，1 为原音量 */
  readonly gain: number;
  readonly kind: AudioKind;
}

export interface CaptionCue {
  readonly t: number;
  readonly dur: number;
  readonly text: string;
}

export interface CaptionTrack {
  readonly id: string;
  readonly cues: readonly CaptionCue[];
}

export interface SceneDoc {
  readonly schemaVersion: number;
  /** 单调递增整数，禁用 hash 与时间戳 */
  readonly docVersion: number;
  readonly meta: DocMeta;
  readonly theme: Theme;
  readonly layers: readonly Layer[];
  readonly objects: Readonly<Record<ObjectId, SceneObject>>;
  readonly effects: Readonly<Record<EffectId, Effect>>;
  readonly camera: Camera;
  readonly markers: readonly Marker[];
  /**
   * 镜头表（P12）。
   *
   * ★ 必填而不是可选：可选字段会让"这份文档是不是多镜头"变成运行期的分支，
   *   而规范通篇没给这个自由度。空数组 = 单镜头（旧行为），这是唯一的口径。
   */
  readonly scenes: readonly Scene[];
  readonly locks: Readonly<Record<string, LockEntry>>;
  readonly audioTracks: readonly AudioTrack[];
  readonly captionTracks: readonly CaptionTrack[];
}

/**
 * 对象的时间窗。整份代码里【只此一处】定义它。
 *
 * ★ 三档 owner 的规则（P12 落地口径，A1 + B1）：
 *
 *   scene   [该镜的 bornAt, 该镜的结束时刻]
 *           结束时刻 = 下一镜的起点（A1），最后一镜到 meta.duration。
 *           ★ 左端取的是 **scene 表的 bornAt**，不是 owner.bornAt ——
 *             派生量不该有第二份真源：owner.bornAt 是落盘的缓存，
 *             两者不一致时报 scene_born_at_mismatch 由人去修，
 *             但"画在哪一段时间里"只认一处。
 *   shared  各 usageWindows 的并集。★ 刻意【不】按镜头裁剪：shared 的存在意义
 *           就是跨镜复用，裁掉窗口就等于把它的复用性抹了。
 *   global  [0, meta.duration]。★ 刻意【不】随镜头移动：它是全片共用的东西
 *           （规范 §11："global 对象完全不动"）。
 *
 * ★ 空 scenes 表 = 旧行为（单镜头）：scene 类右端退回 meta.duration。
 *   这样加 scenes 字段本身不会改变任何现有文档的时间窗语义。
 */
export function objectTimeWindow(doc: SceneDoc, obj: SceneObject): readonly [number, number] {
  const owner = obj.owner;
  if (owner.kind === 'shared') {
    if (owner.usageWindows.length === 0) return [0, doc.meta.duration];
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const w of owner.usageWindows) {
      if (w[0] < lo) lo = w[0];
      if (w[1] > hi) hi = w[1];
    }
    return [lo, hi];
  }
  // 空表：scene 的右端只能是 meta.duration（旧行为）
  if (scenesOf(doc).length === 0) return [owner.kind === 'scene' ? owner.bornAt : 0, doc.meta.duration];
  if (owner.kind === 'scene') return sceneWindow(doc, owner.sceneId);
  return [0, doc.meta.duration];
}

/** 对象所在的图层 id（按 layers[].objects 反查）。找不到返回 undefined。 */
export function layerOfObject(doc: SceneDoc, id: ObjectId): LayerId | undefined {
  for (const layer of doc.layers) {
    if (layer.objects.includes(id)) return layer.id;
  }
  return undefined;
}
