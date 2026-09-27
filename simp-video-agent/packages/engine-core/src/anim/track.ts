/**
 * 动画轨道求值（规范 §5 的 anim）。
 *
 * ★ 这个文件补的是一个【真空洞】：在此之前，obj.anim 全仓库只有四处读它
 *   —— projection/timeline（列出按键）、projection/field-state 与 projection/locks
 *   （判断"是否动画驱动"）、doc/shift（retime 顺延），而 evaluate() 从来不读。
 *   于是 `"tf.opacity": {keys:[{t:0,v:0},{t:0.6,v:1}]}` 这样一条动画：
 *   能写进文档、会被 set_motion 改、会被 retime 顺延、面板会给它画"动画驱动"的蓝点、
 *   soft 锁会提示"会覆盖动画" —— 而画面一秒都不动。
 *   这是最坏的一类缺陷：没有任何东西报错，判据（issues=0）还会把它记成成功。
 *
 * ── 支持范围（刻意画清边界，不假装全能）────────────────────────
 *   tf.*        全套（x/y/rotate/sx/sy/opacity）
 *   数值 style.* 全套（plot2d 的 width/glow，text 的 size）
 *   字符串 / 布尔 style.* 只做【跳变】，不做插值（见下）
 *
 *   ★ params.*（expr / domain / samples）的轨道【不支持】，而且是刻意的：
 *     params 是 geometry 类，改它必须重新采样；而规范 §5 钉死了
 *     "samples 永远是全定义域采样、绘制动画用可见子集绘制"。
 *     让 params.expr 跟着 t 逐帧重采样会直接违反那条不变量。
 *     这条路径由 validateMotion 报 anim_track_unsupported，绝不静默忽略。
 *
 * ── 关于非数值的插值语义 ───────────────────────────────────
 *   颜色 '#4ea1ff' 与布尔 true 都没有"中间值"。选择【在左侧关键帧上跳变】，
 *   而不是让调用方去拼半个颜色串 —— 后者会造出 '#4ea1ff' 与 '#ff0000' 之间的
 *   非法颜色，一路渗进渲染层。
 *
 * 纯函数、无宿主依赖（不变量 1）。表达式编译结果按源码字符串记忆化，
 * key 覆盖全部输入，所以不改变可观测的纯函数性质。
 */
import type { AnimTrack, FieldAtom, SceneDoc, SceneObject } from '../doc/types';
import { parseTrackPath, TF_KEYS, type TrackPath } from './track-path';
import { compileExpr, type CompiledExpr } from '../expr';
import { applyEase, clamp01 } from './ease';
import { mixColor, parseColor } from '../render/color';
import { REGISTRY } from '../registry/fields';
import { findField } from '../registry/schema';

/* ══════════════════════════════════════════════════════════════
 * 1. 表达式轨道
 * ══════════════════════════════════════════════════════════════ */

const exprCache = new Map<string, CompiledExpr | null>();

function exprFor(source: string): CompiledExpr | null {
  const hit = exprCache.get(source);
  if (hit !== undefined) return hit;
  // 动画表达式只允许 t：它描述的是"这个字段随时间怎么走"。
  const compiled = compileExpr(source, ['t']);
  const fn = compiled.ok ? compiled.eval : null;
  exprCache.set(source, fn);
  return fn;
}

export function __clearTrackCaches(): void {
  exprCache.clear();
}

/* ══════════════════════════════════════════════════════════════
 * 2. 关键帧查找与插值
 * ══════════════════════════════════════════════════════════════ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumericPair(a: FieldAtom, b: FieldAtom): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every(isFiniteNumber) && b.every(isFiniteNumber);
}

function lerpAtom(a: FieldAtom, b: FieldAtom, k: number): FieldAtom | null {
  if (isFiniteNumber(a) && isFiniteNumber(b)) return a + (b - a) * k;
  if (Array.isArray(a) && Array.isArray(b) && isNumericPair(a, b)) {
    return a.map((v, i) => v + ((b[i] as number) - v) * k);
  }
  return null; // 不可插值
}

/**
 * 两个字符串之间插值 —— **只在颜色字段上**（见 SampleMode）。
 *
 * ★ 为什么必须区分字段类型，而不是"字符串就试试颜色"：
 *   颜色插值只有对颜色才有意义。对一个普通字符串字段（未来的 label / 公式）
 *   做同样的事，会把"到点换值"变成"中间出现一个谁也没写过的值"——
 *   那是语义上的错，不是精度上的错。
 */
function lerpColor(a: FieldAtom, b: FieldAtom, k: number): string | null {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (parseColor(a) === null || parseColor(b) === null) return null;
  return mixColor(a, b, k);
}

/**
 * 两个关键帧值之间插值。
 *
 * 顺序是刻意的：**先试数值/向量，再试颜色，最后放弃（跳变）**。
 * 这样 `mode` 只描述"字符串那一支额外允许什么"，而不是"只允许什么" ——
 * 漏掉这一点会让被误判成 color 的数值轨道整条失效
 * （实测：`sampleTrack(数值轨道, 0.5, 'color')` 曾返回左端值）。
 */
function blendAtoms(a: FieldAtom, b: FieldAtom, k: number, mode: SampleMode): FieldAtom | null {
  const numeric = lerpAtom(a, b, k);
  if (numeric !== null) return numeric;
  if (mode === 'color') return lerpColor(a, b, k);
  return null;
}

/**
 * 轨道的插值模式。
 *
 * `color` 时字符串之间走颜色插值；其余情况字符串"插不动就跳变"（原有语义）。
 * 调用方（evaluateObjectAnim）按 FieldRegistry 判定该字段是不是颜色。
 */
export type SampleMode = 'plain' | 'color';

/** 找到 t 之前（含）最后一个关键帧的下标；t 在所有按键之前时返回 -1。 */
function lastKeyAt(keys: readonly { readonly t: number }[], t: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const key = keys[mid];
    if (key === undefined) break;
    if (key.t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/* ══════════════════════════════════════════════════════════════
 * 3. 采样单条轨道
 * ══════════════════════════════════════════════════════════════ */

export interface SampleOutcome {
  /** true 表示这条轨道在 t 处有确定取值，value 有效。 */
  readonly ok: boolean;
  readonly value?: FieldAtom;
  /** ok 为 false 时的原因，供校验器与回执使用。 */
  readonly reason?: 'empty_keys' | 'expr_failed' | 'non_finite';
}

const EMPTY_KEYS: SampleOutcome = { ok: false, reason: 'empty_keys' };
const EXPR_FAILED: SampleOutcome = { ok: false, reason: 'expr_failed' };
const NON_FINITE: SampleOutcome = { ok: false, reason: 'non_finite' };

/**
 * 在时刻 t 采样一条轨道。
 *
 * 语义（与 sampleCamera 保持同一套约定，减少两处各说各话）：
 *   - t 在第一个关键帧之前 → 取第一帧；t 在最后一帧之后 → 取最后一帧（不外推）
 *   - 区间内按【左端关键帧】标注的 ease 插值
 *   - 关键帧不按 t 排序时也正确（内部先按 t 排一次）
 */
export function sampleTrack(track: AnimTrack, t: number, mode: SampleMode = 'plain'): SampleOutcome {
  if (track.kind === 'expr') {
    const fn = exprFor(track.expr);
    if (fn === null) return EXPR_FAILED;
    const v = fn({ t });
    return isFiniteNumber(v) ? { ok: true, value: v } : NON_FINITE;
  }

  // 不做原地 sort：动画轨道是文档的一部分，求值过程不允许改写它的数组顺序。
  const keys = [...track.keys].sort((a, b) => a.t - b.t);
  const first = keys[0];
  if (first === undefined) return EMPTY_KEYS;
  if (t <= first.t) return { ok: true, value: first.v };
  const last = keys[keys.length - 1];
  if (last === undefined) return { ok: true, value: first.v };
  if (t >= last.t) return { ok: true, value: last.v };

  const i = lastKeyAt(keys, t);
  const a = keys[i];
  const b = keys[i + 1];
  if (a === undefined) return { ok: true, value: first.v };
  if (b === undefined) return { ok: true, value: last.v };

  const span = b.t - a.t;
  const raw = span <= 0 ? 1 : (t - a.t) / span;
  const k = applyEase(a.ease, clamp01(raw));
  /**
   * ★ 颜色字段走颜色插值（`mixColor`），其余字符串"插不动就跳变"。
   *   这就是颜色与开关类字段的语义差别：开关只有"什么时候换"，
   *   而颜色有"中间色"——而中间色正是"渐变/淡入高亮"这类效果的载体。
   */
  const blended = blendAtoms(a.v, b.v, k, mode);
  return { ok: true, value: blended === null ? a.v : blended };
}

/* ══════════════════════════════════════════════════════════════
 * 4. 对象级求值
 * ══════════════════════════════════════════════════════════════ */

export type AnimIssues = Readonly<Record<string, SampleOutcome['reason']>>;

/**
 * 这条轨道该用哪种插值模式。
 *
 * ★ 判据来自 FieldRegistry —— **字段类型只有一处真源**（规范 §6）。
 *   所以这里不去猜"这个字符串看起来像不像颜色"，而是问 registry
 *   "`<shape>.style.<key>` 登记成 color 了吗"。将来加一个字符串字段时，
 *   它会自动落到 `plain`（到点换值），不需要改这里。
 *
 * registry 里查不到（测试用手写分组、或未登记的 shape）时一律 `plain`：
 * 宁可"颜色跳变"，也不要凭字段名猜类型。
 */
function sampleModeFor(obj: SceneObject, parsed: TrackPath): SampleMode {
  if (parsed.zone !== 'style') return 'plain';
  const spec = findField(REGISTRY, 'shape', obj.shape, 'style', parsed.key);
  return spec?.type === 'color' ? 'color' : 'plain';
}

export interface AnimatedObject {
  /** 动画【覆盖后】的变换。没有被动画驱动的字段保持静态值。 */
  readonly tf: SceneObject['tf'];
  /** 动画【覆盖后】的数值/字符串 style 字段。未被驱动的字段不出现。 */
  readonly style: Readonly<Record<string, FieldAtom>>;
  /** 轨道路径 → 失败原因。只有出问题的轨道才出现。 */
  readonly issues: AnimIssues;
}

/**
 * 对一个对象在时刻 t 求值：把 anim 里所有轨道叠加到静态值上。
 *
 * 出问题的轨道【不写入】，因此调用方拿到的永远是"能画的值"；
 * 问题本身通过 issues 报出来（校验器据此出 Issue），
 * 而不是让一条写坏的动画把整帧打断（与 evaluate 的容错口径一致）。
 */
export function evaluateObjectAnim(obj: SceneObject, t: number): AnimatedObject {
  const tf: Record<string, number> = {
    x: obj.tf.x,
    y: obj.tf.y,
    rotate: obj.tf.rotate,
    sx: obj.tf.sx,
    sy: obj.tf.sy,
    opacity: obj.tf.opacity,
  };
  const style: Record<string, FieldAtom> = {};
  const issues: Record<string, SampleOutcome['reason']> = {};

  let touchedTf = false;

  for (const path of Object.keys(obj.anim)) {
    const track = obj.anim[path];
    if (track === undefined) continue;
    const parsed = parseTrackPath(path);
    if (parsed === null) {
      issues[path] = 'expr_failed'; // 路径不合法：报出来，不静默
      continue;
    }
    const sampled = sampleTrack(track, t, sampleModeFor(obj, parsed));
    if (!sampled.ok) {
      issues[path] = sampled.reason ?? 'expr_failed';
      continue;
    }
    const value = sampled.value;
    if (value === undefined) continue;

    if (parsed.zone === 'tf') {
      if (!TF_KEYS.includes(parsed.key)) {
        issues[path] = 'expr_failed';
        continue;
      }
      if (!isFiniteNumber(value)) {
        issues[path] = 'non_finite';
        continue;
      }
      tf[parsed.key] = value;
      touchedTf = true;
    } else {
      style[parsed.key] = value;
    }
  }

  return {
    tf: touchedTf ? (tf as unknown as SceneObject['tf']) : obj.tf,
    style,
    issues,
  };
}

/* ══════════════════════════════════════════════════════════════
 * 5. 样式解析（画布与预览共用的唯一一处）
 * ══════════════════════════════════════════════════════════════ */

/** 绘制一个对象所需的样式。线宽用【世界单位】表示，由画笔乘相机 scale。 */
export interface ResolvedItemStyle {
  readonly stroke?: string;
  readonly width?: number;
  readonly glow?: number;
  /** 屏幕空间文字的字号（像素）——永不受相机 scale 影响。 */
  readonly fontSize?: number;
  /**
   * 内部填充色（只有 rect 这类"有面积"的 shape 用）。
   *
   * ★ 它与 stroke 是【两个独立的东西】，而在这一版之前它们被混在一起：
   *   `stroke = firstString(of('stroke'), of('fill'))` —— 对 text 是对的
   *   （文字的 fill 就是它的颜色），对 rect 就错了：方块会失去描边色。
   *   现在 fill 有自己的一格，text 那条回退保留（它的 fill 仍是文字颜色）。
   */
  readonly fill?: string;
  /** 填充不透明度。只作用于填充，不作用于描边 —— "半透明底 + 实心边"因此可直接做出来。 */
  readonly fillOpacity?: number;
  /**
   * 折线末端的箭头大小（世界单位）。
   *
   * ★ 它是【几何】而不是线宽：箭头不会跟着线宽一起变粗。
   *   放进样式解析而不是让画笔回头读 params，是因为"动画/样式覆盖"那条路
   *   必须只有一处（否则预览与导出会各读一份，这正是这个接口诞生的原因）。
   */
  readonly headSize?: number;
  /**
   * 文字的对齐方式（'left' | 'center' | 'right'）。
   *
   * ★ 它是【字符串枚举】而不是数值：动画插值对它没有意义（到点跳变），
   *   所以它落在 sampleModeFor 的 plain 那一支 —— 与其它非颜色字符串同一口径。
   */
  readonly textAlign?: string;
  /** 文字换行宽度（像素，0 = 不换行）。它【可以】被动画驱动（是数值）。 */
  readonly maxWidth?: number;
  /** 粗体（自托管的 700 字重）。布尔值，不做插值。 */
  readonly bold?: boolean;
}

function atom(value: unknown): FieldAtom | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && !Array.isArray(value) && 'v' in (value as Record<string, unknown>)) {
    return (value as { v: FieldAtom }).v;
  }
  return value as FieldAtom;
}

function firstString(...values: (FieldAtom | undefined)[]): string | undefined {
  for (const v of values) if (typeof v === 'string') return v;
  return undefined;
}

function firstNumber(...values: (FieldAtom | undefined)[]): number | undefined {
  for (const v of values) if (isFiniteNumber(v)) return v;
  return undefined;
}

/**
 * 解析一个对象在某时刻的绘制样式。
 *
 * ★ 这是"动画影响外观"的必经之路：画笔原来各自去读静态 style，
 *   动画值根本没有出口。现在动画值优先于静态值，且解析只在这里做一次 ——
 *   engine-core 求值、画布预览、headless 导出、面板四处共用同一处判定，
 *   不会出现"预览里是动画色、导出时是静态色"这种分叉。
 */
export function resolveItemStyle(obj: SceneObject, animatedStyle: Readonly<Record<string, FieldAtom>> = {}): ResolvedItemStyle {
  const staticOf = (key: string): FieldAtom | undefined => atom(obj.style[key]);
  const of = (key: string): FieldAtom | undefined =>
    Object.prototype.hasOwnProperty.call(animatedStyle, key) ? animatedStyle[key] : staticOf(key);

  const style: {
    stroke?: string;
    width?: number;
    glow?: number;
    fontSize?: number;
    fill?: string;
    fillOpacity?: number;
    headSize?: number;
    textAlign?: string;
    maxWidth?: number;
    bold?: boolean;
  } = {};

  const stroke = firstString(of('stroke'), of('fill'));
  const width = firstNumber(of('width'));
  const glow = firstNumber(of('glow'));
  // size 是屏幕空间字号：它也可以被动画驱动，但绝不参与相机 scale。
  const fontSize = firstNumber(of('size'));
  // ★ 填充有自己的一格。text 的 fill 仍然是它的"颜色"（上面那行回退管），
  //   而 rect 的 fill 是底色 —— 两者不能共用一格，否则方块会丢掉描边色。
  const fill = firstString(of('fill'));
  const fillOpacity = firstNumber(of('fillOpacity'));
  const headSize = firstNumber(of('headSize'));
  // 文字排版：对齐（字符串，到点换值）与换行宽度（数值，可插值）
  const textAlign = firstString(of('align'));
  const maxWidth = firstNumber(of('maxWidth'));
  const bold = of('bold') === true;

  if (stroke !== undefined) style.stroke = stroke;
  if (width !== undefined) style.width = width;
  if (glow !== undefined) style.glow = glow;
  if (fontSize !== undefined) style.fontSize = fontSize;
  if (fill !== undefined) style.fill = fill;
  if (fillOpacity !== undefined) style.fillOpacity = fillOpacity;
  if (headSize !== undefined) style.headSize = headSize;
  if (textAlign !== undefined) style.textAlign = textAlign;
  if (maxWidth !== undefined) style.maxWidth = maxWidth;
  if (bold) style.bold = true;
  return style;
}

/* ══════════════════════════════════════════════════════════════
 * 6. 文档级汇总（给校验器用）
 * ══════════════════════════════════════════════════════════════ */

export interface TrackProblem {
  readonly objectId: string;
  readonly path: string;
  readonly reason: NonNullable<SampleOutcome['reason']> | 'unsupported_zone';
}

/**
 * 扫全文档的轨道，报出【结构性】问题（不依赖 t）：
 *   - 路径不合法 / tf 字段名不存在
 *   - 表达式编译不过、空 keys
 *   - params.* 轨道（本版本不支持，必须说出来）
 * 数值层面的 NaN 由 validateMotion 在若干个 t 上采样后报出。
 */
export function collectStructuralTrackProblems(doc: SceneDoc): readonly TrackProblem[] {
  const out: TrackProblem[] = [];
  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    if (obj === undefined) continue;
    for (const path of Object.keys(obj.anim)) {
      const track = obj.anim[path];
      if (track === undefined) continue;
      const parsed = parseTrackPath(path);
      if (parsed === null) {
        // params.*（含 expr）落在这里：几何类字段不能逐帧驱动。
        out.push({ objectId: id, path, reason: 'unsupported_zone' });
        continue;
      }
      if (parsed.zone === 'tf' && !TF_KEYS.includes(parsed.key)) {
        out.push({ objectId: id, path, reason: 'unsupported_zone' });
        continue;
      }
      if (track.kind === 'keys' && track.keys.length === 0) {
        out.push({ objectId: id, path, reason: 'empty_keys' });
        continue;
      }
      if (track.kind === 'expr' && exprFor(track.expr) === null) {
        out.push({ objectId: id, path, reason: 'expr_failed' });
      }
    }
  }
  return out;
}
