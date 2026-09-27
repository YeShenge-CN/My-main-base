/**
 * evaluate(doc, t) → RenderState（P0 第 7 步）。
 *
 * 纯函数：不碰 DOM、不读时钟、不取随机数（不变量 1）。
 * 浏览器预览与 headless 导出调用的是同一份代码，这是"预览=成片"的唯一保证。
 *
 * 当前支持的 shape 只有 plot2d（曲线）。其余 shape（paramCurve / contour /
 * region / scatter / vectorField / text / formula）需要各自的采样器，
 * 属于 P0 第 5 步的剩余部分 —— 未支持的 shape 会被静默跳过，
 * 由校验器（P7）负责报出来，而不是在这里抛异常打断整帧。
 */
import type { Effect, FieldRecord, SceneDoc, SceneObject } from './doc/types';
import { unwrapField } from './doc/fields';
import { applyEase, clamp01 } from './anim/ease';
import { evaluateObjectAnim, resolveItemStyle, type AnimatedObject } from './anim/track';
import { cameraMatrix, fitViewport, sampleCamera, worldToPixel, type CameraState } from './camera';
import type { Mat2D } from './math/mat2d';
import * as Mat from './math/mat2d';
import type { Vec2 } from './math/vec2';
import { compileExpr, type CompiledExpr } from './expr';
import { mixColor } from './render/color';
import { clipByArcLength, clipByDomain, samplePlot, type Polyline } from './sampling/plot';
import { sampleLine, sampleRect } from './sampling/shapes';
import type { Box, RenderItem, RenderState, TextPlacement } from './render-state';
import { alignOf, layoutText } from './render/text';
import { decodeFormulaGeometry } from './render/formula-geometry';
export { estimateTextWidth } from './render/text';

/* ── 缓存：采样结果按 (每帧不变的那部分输入) 复用 ──────────────────
 * 规范 §10 的"全量采样 + 可见子集绘制"要求采样不能在 t 上反复重算。
 * 这里用纯函数式记忆：key 覆盖全部输入，因此不改变可观测的纯函数性质。
 */
const exprCache = new Map<string, CompiledExpr | null>();
const sampleCache = new Map<string, Polyline>();

export function __clearEvaluateCaches(): void {
  exprCache.clear();
  sampleCache.clear();
}

function getExpr(source: string): CompiledExpr | null {
  const hit = exprCache.get(source);
  if (hit !== undefined) return hit;
  const compiled = compileExpr(source, ['x', 't']);
  const fn = compiled.ok ? compiled.eval : null;
  exprCache.set(source, fn);
  return fn;
}

function getSamples(fn: CompiledExpr, source: string, domain: readonly [number, number], samples: number): Polyline {
  const key = source + '|' + domain[0] + ',' + domain[1] + '|' + samples;
  const hit = sampleCache.get(key);
  if (hit !== undefined) return hit;
  const line = samplePlot(fn, domain, samples);
  sampleCache.set(key, line);
  return line;
}

/* ── 一帧的求值上下文 ─────────────────────────────────────────── */

/**
 * 一帧内复用的缓存。
 *
 * ★ 这些 Map 都是【纯计算的记忆】，key 覆盖全部输入，且在每次 evaluate 开头新建 ——
 *   所以它们不改变 evaluate 的纯函数性质（不变量 1），只是把"同一个对象一帧内
 *   被问好几次"变成一次。
 *
 * ★ `animCache` 是这一轮才加的，而它顺手修掉了一个真实的浪费：在此之前
 *   `evaluateObjectAnim(obj, t)` 对同一个对象会被调用两次（一次取 style/opacity，
 *   一次在父级链里取 tf），而它内部每次都要对关键帧数组排一遍序。
 */
interface FrameCtx {
  readonly doc: SceneDoc;
  readonly t: number;
  readonly animCache: Map<string, AnimatedObject>;
  readonly matCache: Map<string, Mat2D>;
  /**
   * 对象 id → 它在【父级坐标系】里被 moveAlong 指定的位置。
   * 空表表示这一帧没有任何 moveAlong（绝大多数帧）。
   */
  readonly positions: ReadonlyMap<string, Vec2>;
}

/** 探测上下文用的空位置表：它【不认】任何 moveAlong 覆盖（见 planMoveAlong）。 */
const NO_POSITIONS: ReadonlyMap<string, Vec2> = new Map<string, Vec2>();

/** 对象这一帧的动画结果（含缓存）。对象不存在时返回 null。 */
function animOf(ctx: FrameCtx, id: string): AnimatedObject | null {
  const hit = ctx.animCache.get(id);
  if (hit !== undefined) return hit;
  const obj = ctx.doc.objects[id];
  if (obj === undefined) return null;
  const anim = evaluateObjectAnim(obj, ctx.t);
  ctx.animCache.set(id, anim);
  return anim;
}

/**
 * 对象【自己】的局部变换 —— 动画叠加后，再叠上 moveAlong 对位置的覆盖。
 *
 * ★ 位置覆盖为什么放在这里而不是放进 resolveEffects：它影响的不只是画出来的
 *   点列，而是这个对象的【世界矩阵】。父级链、子级的跟随、包围盒、命中测试
 *   全都消费那个矩阵 —— 在画笔那一层做位移的话，子级就不会跟着走，
 *   而且预览与导出的位移量会各算一遍（那正是渲染层出现过三次分叉的地方）。
 */
function tfOf(ctx: FrameCtx, id: string): SceneObject['tf'] | null {
  const anim = animOf(ctx, id);
  if (anim === null) return null;
  const pos = ctx.positions.get(id);
  if (pos === undefined) return anim.tf;
  /**
   * ★ 效果覆盖动画：x/y 被路径位置取代，rotate / sx / sy / opacity 仍然是动画值。
   *   两者同时存在时"效果赢"是刻意的 —— 它的语义（"沿这条路走"）比一条
   *   tf.x 轨道更具体，而且它本来就是为"手工写两个关键帧"提供的替代品。
   */
  return { ...anim.tf, x: pos.x, y: pos.y };
}

/* ── 对象局部变换 ─────────────────────────────────────────────── */

/**
 * 对象局部变换矩阵。
 *
 * ★ tf 参数由调用方传入【动画叠加后】的值 —— 传 obj.tf 会把动画丢掉，
 *   那正是这个文件此前最大的一个洞。
 */
function objectMatrix(tf: SceneObject['tf']): Mat2D {
  return Mat.compose(
    Mat.translation(tf.x, tf.y),
    Mat.rotation(tf.rotate),
    Mat.scaling(tf.sx, tf.sy),
  );
}

/**
 * 父级链的最大深度。
 *
 * ★ 这是【防御】而不是业务规则：环由校验器（`parent_cycle`）报出来让人去修，
 *   但求值路径上绝不能因为一份坏文档就无限递归 —— 求值要能在任何输入上终止。
 *   超过深度就当成顶层对象处理，画面会不对，但不会挂。
 */
const MAX_PARENT_DEPTH = 64;

/**
 * 对象的【世界矩阵】= 父级链变换 ∘ 自己的变换。
 *
 * ★ 分组（`parent`）只有一个可观测后果，就是这里：把一条链乘起来。
 *   点列、文字锚点、包围盒、命中测试全都消费这个矩阵，
 *   所以"父级移动 → 子级跟着动"是免费的，不需要在各处特判。
 *
 * 缓存按对象 id 记忆（一帧内每个对象只算一次），并且**缓存的是纯计算结果**，
 * 不引入任何随时间变化的状态 —— `evaluate` 仍是纯函数。
 */
function worldMatrixOf(ctx: FrameCtx, objectId: string): Mat2D {
  const hit = ctx.matCache.get(objectId);
  if (hit !== undefined) return hit;

  const chain: { readonly id: string; readonly local: Mat2D }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = objectId;
  let depth = 0;

  // 先沿父级链自下而上收集（环与超深都在这里被截断）
  while (cursor !== undefined && depth < MAX_PARENT_DEPTH) {
    if (seen.has(cursor)) break; // 环：停在这里，别转死循环
    seen.add(cursor);
    const cached = ctx.matCache.get(cursor);
    if (cached !== undefined) break; // 祖先已经算过，从它接上即可
    const tf = tfOf(ctx, cursor);
    if (tf === null) break; // 对象不存在
    const obj: SceneObject | undefined = ctx.doc.objects[cursor];
    chain.push({ id: cursor, local: objectMatrix(tf) });
    cursor = obj?.parent;
    depth += 1;
  }

  // 再自顶向下乘：最靠根的那个先作用
  let acc = cursor === undefined ? Mat.identity() : ctx.matCache.get(cursor) ?? Mat.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    if (node === undefined) continue;
    acc = Mat.multiply(acc, node.local);
    ctx.matCache.set(node.id, acc);
  }
  return acc;
}


/* ── 效果解析 ─────────────────────────────────────────────────── */

interface DrawOnState {
  readonly progress: number;
  readonly mode: string;
}

/**
 * 高亮状态。
 *
 * `strength` 是 0..1 的进度；`intensity` 是"高亮到多强"（可以 >1 表示过曝）。
 * 画笔消费的是两者相乘后的结果，所以"轻微提示"与"强调"共用同一套机制。
 */
interface HighlightState {
  readonly strength: number;
  readonly color: string;
  readonly intensity: number;
}

interface EffectState {
  readonly drawOn: DrawOnState;
  readonly highlight: HighlightState | null;
  /**
   * 这一帧它在不在：0 = 不在，1 = 在。
   *
   * ★ 它与 `tf.opacity` 是【两件事】，不是替代关系：一个说"这一帧有没有它"
   *   （0 会让这一项根本不进 RenderState），一个说"它有多透明"。
   *   所以"第 1 秒出场 + 从 0 淡入"这种叠法不需要任何特判 —— 两者各管各的。
   *   （求值路径里的用法是"为 0 就整项跳过"，而不是把它乘进 opacity。）
   */
  readonly visibility: number;
}

const NO_EFFECT: EffectState = { drawOn: { progress: 1, mode: 'domain' }, highlight: null, visibility: 1 };

/** 效果参数里取一个数值（缺失 / 非有限时退回默认）。 */
function paramNumber(params: FieldRecord, key: string, fallback: number): number {
  const raw = Number(unwrapField(params[key]));
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * 算出某个时刻的【0..1 进度】：start 之前 0、start+duration 之后 1，中间按缓动。
 *
 * ★ 抽出来是因为 drawOn 与 highlight 用的是同一条时间曲线语义。
 *   duration ≤ 0 时退化成阶跃（不是"永远 0"，那会让效果看起来完全没生效）。
 */
function progressAt(t: number, start: number, duration: number, ease: string | undefined): number {
  const raw = duration <= 0 ? (t >= start ? 1 : 0) : (t - start) / duration;
  return applyEase(ease, clamp01(raw));
}

/**
 * 解析一个对象在这一时刻的全部效果。
 *
 * ★★ 它替换了以前那个"找到第一条 drawOn 就 return"的写法，原因是效果开始有
 *   【多种互不冲突的类型】了：drawOn 决定"画出多少几何"，highlight 决定
 *   "外观怎么被强调"，appear / disappear 决定"这一帧它在不在"。一个方框完全可以
 *   先长出来、再被高亮、最后消失 —— 用"第一条命中就返回"的写法，
 *   后一条效果会被静默丢掉（而丢掉一条效果是不会报错的）。
 *
 * ★ 同类型多条时的口径：**后定义的生效**（`Object.keys` 的顺序即文档顺序）。
 *   刻意不引入"叠加/混合"语义 —— 那需要回答一堆没有答案的问题
 *   （两条 drawOn 的进度怎么合？取 max？相乘？），而"用哪条"是确定的。
 */
function resolveEffects(doc: SceneDoc, objectId: string, t: number): EffectState {
  let drawOn: DrawOnState | null = null;
  let highlight: HighlightState | null = null;
  // 显隐：两个时刻各自独立（同类型多条仍是"后定义的生效"）
  let appearAt: number | null = null;
  let disappearAt: number | null = null;

  for (const id of Object.keys(doc.effects)) {
    const eff = doc.effects[id];
    if (eff === undefined || eff.target !== objectId) continue;

    if (eff.type === 'drawOn') {
      const start = paramNumber(eff.params, 'start', 0);
      const duration = paramNumber(eff.params, 'duration', 0);
      const mode = String(unwrapField(eff.params['mode']) ?? 'domain');
      drawOn = { progress: progressAt(t, start, duration, eff.ease), mode };
      continue;
    }

    if (eff.type === 'highlight') {
      const start = paramNumber(eff.params, 'start', 0);
      const duration = paramNumber(eff.params, 'duration', 1);
      const color = String(unwrapField(eff.params['color']) ?? '#ffd479');
      const intensity = paramNumber(eff.params, 'intensity', 1);
      highlight = { strength: progressAt(t, start, duration, eff.ease), color, intensity };
      continue;
    }

    /**
     * ★ appear / disappear 是【阶跃】不是渐变：比较的是时刻，不是进度。
     *   做成两个类型而不是一个带 mode 的类型，正是为了让
     *   "1 秒出现、5 秒消失"能同时挂上（见 registry 里那段注释）。
     */
    if (eff.type === 'appear') {
      appearAt = paramNumber(eff.params, 'at', 0);
      continue;
    }
    if (eff.type === 'disappear') {
      disappearAt = paramNumber(eff.params, 'at', 0);
    }
  }

  return {
    drawOn: drawOn ?? NO_EFFECT.drawOn,
    highlight,
    visibility: (appearAt !== null && t < appearAt ? 0 : 1) * (disappearAt !== null && t >= disappearAt ? 0 : 1),
  };
}

/* ── 沿路径移动（moveAlong）──────────────────────────────────── */

/**
 * 算出这一帧里所有 moveAlong 指定的位置。
 *
 * ★ 为什么单独一遍、而不是在 resolveEffects 里顺手算：
 *   位置要进【世界矩阵】（这样"父级在被移动 → 子级跟着走"是免费的），
 *   而算矩阵的时候又需要知道位置 —— 混在一起就会变成"边算边改缓存"，
 *   一个对象算到一半的位置会被另一个对象读到。分两遍之后，
 *   第一遍只读（不认任何覆盖），第二遍只写，缓存永远是一致的。
 *
 * ★★ 这一遍刻意【不认】moveAlong 覆盖："路径源自己也在被 moveAlong 驱动"
 *   这种叠法不支持，路径按源对象【未被该效果驱动】的位置算。
 *   代价是这条边界必须明说（文档、提示词、校验器都写），
 *   收益是这一遍不需要任何递归与环检测，结果与遍历顺序无关 ——
 *   而"结果依赖于谁先被算到"正是这类效果最容易长出来的隐蔽 bug。
 *
 * 返回：对象 id → 它在【父级坐标系】里的位置。返回值是纯的：同样的 (doc, t) 永远一样。
 */
function planMoveAlong(doc: SceneDoc, t: number): ReadonlyMap<string, Vec2> {
  const out = new Map<string, Vec2>();

  // 提前退出：绝大多数文档与绝大多数帧根本没有这类效果
  let any = false;
  for (const effId of Object.keys(doc.effects)) {
    if (doc.effects[effId]?.type === 'moveAlong') {
      any = true;
      break;
    }
  }
  if (!any) return out;

  /** 只读探测上下文：positions 是空表，所以它算出来的矩阵不含任何 moveAlong 覆盖。 */
  const probe: FrameCtx = {
    doc,
    t,
    animCache: new Map<string, AnimatedObject>(),
    matCache: new Map<string, Mat2D>(),
    positions: NO_POSITIONS,
  };

  for (const effId of Object.keys(doc.effects)) {
    const eff: Effect | undefined = doc.effects[effId];
    // 同类型多条时【后定义的生效】，与 drawOn / highlight 同一口径
    if (eff === undefined || eff.type !== 'moveAlong') continue;
    const target = eff.target;
    if (doc.objects[target] === undefined) continue; // 悬空 target 由校验器报出

    const sourceId = String(unwrapField(eff.params['source']) ?? '');
    if (sourceId === '') continue; // 没填源：不动，校验器报出
    const src = doc.objects[sourceId];
    if (src === undefined || src.shape !== 'line') continue; // 源不是线段：没有路径可走

    const k = progressAt(
      t,
      paramNumber(eff.params, 'start', 0),
      paramNumber(eff.params, 'duration', 0),
      eff.ease,
    );

    // 路径两端点在【世界】里取：线段的 from/to 是相对它自己原点的，所以要先过它的世界矩阵
    const from = vec2Of(unwrapField(src.params['from']), [-1, 0]);
    const to = vec2Of(unwrapField(src.params['to']), [1, 0]);
    const srcM = worldMatrixOf(probe, sourceId);
    const a = Mat.applyToPoint(srcM, { x: from[0], y: from[1] });
    const b = Mat.applyToPoint(srcM, { x: to[0], y: to[1] });
    // 直线路径：世界空间里线性插值就是"沿路径走"（两端点之间是仿射的）
    const world: Vec2 = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };

    /**
     * 世界点 → 本对象的【父级坐标系】。
     *
     * 对象自己的变换是 `T(x,y) · R · S`，位置只由 T 决定 —— 所以"把世界点换算回
     * 自己的平移量"就是"过一遍父级矩阵的逆"，本对象的 rotate/sx/sy 不参与。
     * 把它们也算进去会让"走到中点"变成"走到中点再被自己的旋转推偏"。
     */
    const targetObj = doc.objects[target];
    const parentId = targetObj?.parent;
    const parentM =
      parentId === undefined || parentId === ''
        ? Mat.identity()
        : worldMatrixOf(probe, parentId);
    const inv = Mat.invert(parentM);
    if (inv === null) continue; // 父级退化（缩放 0）：宁可不动，也不把 NaN 灌进矩阵
    out.set(target, Mat.applyToPoint(inv, world));
  }

  return out;
}

/**
 * 某个对象在时刻 t 的【世界原点】。
 *
 * ★ 它是给"命令层也需要知道一个对象在哪"的地方用的（目前只有 `camera_preset`
 *   的注视点）。那一处原来是直接读 `obj.tf.x / tf.y` 的 —— 在 `moveAlong`
 *   出现之后，`tf` 已经**不再是**"它在哪"的答案（位置可能被路径接管）。
 *   继续读 tf 的后果是：镜头对准了一个对象已经不在的地方，而画面上它明明在路径上。
 *
 *   "对象在哪"只能有一个答案，所以这里走的就是 `evaluate` 的那一套
 *   （动画 → 位置覆盖 → 父级链），而不是在旁边再算一遍。
 *
 * 求值失败（对象不存在）返回 null，调用方自己决定退路。
 */
export function worldOriginOf(doc: SceneDoc, objectId: string, t: number): Vec2 | null {
  if (doc.objects[objectId] === undefined) return null;
  const ctx: FrameCtx = {
    doc,
    t,
    animCache: new Map<string, AnimatedObject>(),
    matCache: new Map<string, Mat2D>(),
    positions: planMoveAlong(doc, t),
  };
  return Mat.applyToPoint(worldMatrixOf(ctx, objectId), { x: 0, y: 0 });
}

/* ── 文字 ─────────────────────────────────────────────────────── */

// 度量与排版都在 render/text.ts（纯函数模块）：折行必须只有一处实现，
// 否则两条渲染后端会折出不同的行 —— 那正是"预览 ≠ 成片"。
// estimateTextWidth 仍然从这里转出（历史调用方与测试直接用这个名字）。

/* ── 包围盒 ───────────────────────────────────────────────────── */

/** 把一个字段值读成 [x, y]。给 vec2 类字段（line 的 from / to）用。 */
function vec2Of(raw: unknown, fallback: readonly [number, number]): readonly [number, number] {
  if (Array.isArray(raw) && raw.length >= 2) {
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  return fallback;
}

function boxOf(points: readonly Vec2[]): Box {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ── 主入口 ───────────────────────────────────────────────────── */

export function evaluate(doc: SceneDoc, t: number): RenderState {
  const fit = fitViewport(doc.meta);
  const cam: CameraState = sampleCamera(doc.camera, t);
  const matrix = cameraMatrix(cam, fit);

  const items: RenderItem[] = [];
  const layers = [...doc.layers].sort((a, b) => a.order - b.order);
  /**
   * 一帧的求值上下文：动画结果、父级链矩阵都在里面按对象缓存。
   * `positions` 是 moveAlong 在这一帧指定的落点（先算好，后面只读）。
   */
  const ctx: FrameCtx = {
    doc,
    t,
    animCache: new Map<string, AnimatedObject>(),
    matCache: new Map<string, Mat2D>(),
    positions: planMoveAlong(doc, t),
  };

  for (const layer of layers) {
    for (const objectId of layer.objects) {
      const obj = doc.objects[objectId];
      if (obj === undefined) continue;

      // ── 动画必须先于一切几何计算（规范 §5 的 anim）──────────────
      //   在此之前 animate 的字段只存在于文档与面板里，画面完全看不见它。
      const anim = animOf(ctx, objectId);
      if (anim === null) continue;
      const tf = anim.tf;
      const baseStyle = resolveItemStyle(obj, anim.style);
      /**
       * ★ 一个对象可以有多种效果：drawOn 管"画出多少几何"，highlight 管"外观强调"，
       *   appear / disappear 管"这一帧它在不在"。三者互不冲突，所以必须【都】解析出来
       *   （以前是"找到第一条 drawOn 就返回"，后加的效果会被静默丢掉）。
       *   而且这里只调用一次 —— 同一份解析算两遍是"两处口径迟早分叉"的经典开局。
       */
      const effects = resolveEffects(doc, objectId, t);
      /**
       * ★ 真显隐：不在这一帧的对象【根本不进 RenderState】。
       *
       *   不是"画一层全透明"——那样它仍然在 RenderState 里（get_render_state 会把它
       *   报成 visible=0、包围盒与可见性统计也还算着它），于是"它还没出现"这句话
       *   在界面与给模型的反馈里都是假的。
       *   命中测试与画笔对两种情况本来就都跳过（见 engine-render/hit.ts），
       *   所以真正的差别在【它在不在这一帧】，而不是"能不能点中"。
       */
      if (effects.visibility <= 0) continue;
      const opacity = clamp01(tf.opacity);
      /**
       * ★ 世界矩阵 = 父级链 ∘ 自己。分组（`parent`）的全部可观测后果就在这一行：
       *   点列、文字锚点、包围盒全都乘它，所以"父级移动 → 子级跟着动"是免费的。
       *   moveAlong 指定的位置也在这里生效（tfOf 已经把它叠进自己的 tf）。
       */
      const local = worldMatrixOf(ctx, objectId);
      const hl = effects.highlight;
      /** 高亮强度（0 = 没高亮）。strength 是进度、intensity 是"高亮到多强"。 */
      const hlK = hl === null ? 0 : clamp01(hl.strength) * Math.max(0, hl.intensity);
      /**
       * 把高亮【烘进样式】。两种做法都能实现高亮，选这一种是因为它是【一处解析】：
       * 画笔只消费 RenderItem.style（已经是最终颜色），于是预览、headless 导出、
       * Chrome 导出三条路拿到同一份结果。让画笔自己解析效果的话，
       * "颜色渐变"就会有三份实现。
       */
      const itemStyle =
        hl === null || hlK <= 0
          ? baseStyle
          : {
              ...baseStyle,
              stroke: mixColor(baseStyle.stroke ?? doc.theme.accent, hl.color, hlK),
              // 发光跟着抬：暗背景上"只变色不加光"的强调力度是不够的
              glow: Math.min(1, (baseStyle.glow ?? 0) + hlK * 0.8),
              // 描边变粗一点：最直观的一环，而且不改变几何
              width: (baseStyle.width ?? 3) * (1 + hlK * 0.35),
            };

      // ── 文字：只把锚点经 M 变换到屏幕，字号【不随相机 scale 变化】（规范 §4）
      if (obj.shape === 'text') {
        const content = String(unwrapField(obj.params['content']) ?? '');
        if (content === '') continue;
        // 字号可以被动画驱动，但它永远不进 scale()
        const fontSize = itemStyle.fontSize ?? 20;
        const anchor = worldToPixel(Mat.applyToPoint(local, { x: 0, y: 0 }), fit, matrix);
        /**
         * ★ 折行与对齐【在这里算完】，画笔只按给定的行画。
         *   理由见 render/text.ts 的头注释：折行是画面的一部分，
         *   两个后端各量一次文本就会折出不同的行 —— 那是"预览 ≠ 成片"。
         */
        const align = alignOf(itemStyle.textAlign);
        const maxWidth = Math.max(0, Number(itemStyle.maxWidth ?? 0));
        const layout = layoutText(content, fontSize, maxWidth);
        const w = layout.width;
        const h = layout.height;
        /**
         * 锚点语义跟着对齐走（与 canvas 的 textAlign 一致）：
         *   left  → 世界原点是文字的【左】边中点；
         *   center→ 中点（旧行为，默认）；right → 右边中点。
         * 竖向上永远以整块文字的中线为准（多行时行是围绕锚点上下铺开的）。
         */
        const boxX = align === 'center' ? anchor.x - w / 2 : align === 'right' ? anchor.x - w : anchor.x;
        const boxY = anchor.y - h / 2;
        /**
         * ★ 文字的颜色走 `fill`（不是 stroke），所以高亮要作用在 fill 上 ——
         *   否则"高亮一行标题"会毫无效果。这条差异值得在这里显式写出来，
         *   因为它是 text 与 rect/line 唯一一处样式语义不同的地方。
         */
        const textStyle =
          hlK <= 0 || hl === null
            ? itemStyle
            : { ...itemStyle, fill: mixColor(itemStyle.fill ?? doc.theme.fg, hl.color, hlK) };
        items.push({
          id: objectId,
          kind: 'text',
          layerId: layer.id,
          order: items.length,
          box: { x: boxX, y: boxY, w, h },
          opacity,
          visibleFraction: 1,
          style: textStyle,
          text: {
            content,
            lines: layout.lines,
            anchor,
            fontSize,
            lineHeight: layout.lineHeight,
            bold: itemStyle.bold === true,
            cameraScale: cam.scale,
            align,
          },
        });
        continue;
      }

      /**
       * ── 公式：几何是【物化好的】（方案 B）────────────────────────
       *
       * ★ 求值层不认识 LaTeX：它只把 em 单位的点列按字号缩放、按锚点平移。
       *   于是两条渲染后端画的是同一份点列 —— "预览 = 成片"是结构性成立的，
       *   而不是靠两边实现得一样。
       *
       * ★ 与文字同一套锚点语义（align 决定锚点落在左/中/右），
       *   竖向以【基线】为准：几何的 y=0 就是基线，ascent 在它上面、depth 在下面。
       */
      if (obj.shape === 'formula') {
        const raw = String(unwrapField(obj.params['paths']) ?? '');
        const subpaths = decodeFormulaGeometry(raw);
        if (subpaths.length === 0) continue; // 坏几何不画，交给校验器报
        const size = itemStyle.fontSize ?? 24;
        const widthEm = Number(unwrapField(obj.params['width']) ?? 0);
        const ascentEm = Number(unwrapField(obj.params['ascent']) ?? 0);
        const depthEm = Number(unwrapField(obj.params['depth']) ?? 0);
        const align = alignOf(itemStyle.textAlign);
        const anchor = worldToPixel(Mat.applyToPoint(local, { x: 0, y: 0 }), fit, matrix);
        const w = widthEm * size;
        const h = (ascentEm + depthEm) * size;
        const boxX = align === 'center' ? anchor.x - w / 2 : align === 'right' ? anchor.x - w : anchor.x;
        const boxY = anchor.y - ascentEm * size;
        const px = subpaths.map((sp) => sp.map((p) => ({ x: anchor.x + p.x * size, y: anchor.y + p.y * size })));
        items.push({
          id: objectId,
          kind: 'formula',
          layerId: layer.id,
          order: items.length,
          box: { x: boxX, y: boxY, w, h },
          opacity,
          visibleFraction: 1,
          style: itemStyle,
          subpaths: px,
        });
        continue;
      }

      if (obj.shape !== 'plot2d' && obj.shape !== 'rect' && obj.shape !== 'line') continue; // 未支持的 shape 由校验器报出

      const effect = effects.drawOn;

      /**
       * ★ 三条形状分支的共同出口：都产出【世界坐标下的点列】，
       *   再统一走 world→pixel。这样"新加一个 shape"只需要加一个采样器，
       *   变换、AABB、命中测试、镜头过滤一律不用动。
       */
      let world: readonly Vec2[];
      let closed = false;
      let arrow = false;
      let pointCount: number;

      if (obj.shape === 'rect') {
        const line = sampleRect(
          Number(unwrapField(obj.params['width']) ?? 3),
          Number(unwrapField(obj.params['height']) ?? 1.6),
          Number(unwrapField(obj.params['radius']) ?? 0),
        );
        const visible = clipByArcLength(line.points, effect.progress);
        world = visible;
        closed = true;
        pointCount = line.points.length;
      } else if (obj.shape === 'line') {
        const from = vec2Of(unwrapField(obj.params['from']), [-1, 0]);
        const to = vec2Of(unwrapField(obj.params['to']), [1, 0]);
        const line = sampleLine(from, to);
        // 线段不做 clipByArcLength：它只有两个点，按弧长裁剪没有意义
        world = line.points;
        pointCount = line.points.length;
        if (String(unwrapField(obj.params['head']) ?? 'none') === 'arrow') {
          /**
           * ★ 这里只设【要不要画】。画多大是样式（`style.headSize`），
           *   由画笔在需要时自己取 —— 两者曾经共用一个字段，结果是
           *   head=none 的线照样画出箭头（像素测试抓到的）。
           */
          arrow = true;
        }
      } else {
        const exprSource = String(unwrapField(obj.params['expr']) ?? '');
        const domainRaw = unwrapField(obj.params['domain']);
        const domain: readonly [number, number] =
          Array.isArray(domainRaw) && domainRaw.length >= 2
            ? [Number(domainRaw[0]), Number(domainRaw[1])]
            : [-1, 1];
        const samples = Number(unwrapField(obj.params['samples']) ?? 2400);

        const fn = getExpr(exprSource);
        if (fn === null) continue;

        const line = getSamples(fn, exprSource, domain, samples);
        world =
          effect.mode === 'arc'
            ? clipByArcLength(line.points, effect.progress)
            : clipByDomain(line.points, effect.progress);
        pointCount = line.points.length;
      }

      const px: Vec2[] = [];
      for (const p of world) {
        px.push(worldToPixel(Mat.applyToPoint(local, p), fit, matrix));
      }

      items.push({
        id: objectId,
        kind: 'path',
        layerId: layer.id,
        order: items.length,
        box: boxOf(px),
        opacity,
        visibleFraction: effect.progress,
        pointCount,
        path: px,
        ...(closed ? { closed: true } : {}),
        ...(arrow ? { arrow: true } : {}),
        style: itemStyle,
      });
    }
  }

  return {
    t,
    viewport: { w: doc.meta.viewport[0], h: doc.meta.viewport[1] },
    camera: cam,
    matrix,
    // 如实交出这一帧的贴合参数（世界单位 ↔ 像素的换算就在里面，见 RenderState.fit）
    fit,
    items,
  };
}

export type { TextPlacement };
