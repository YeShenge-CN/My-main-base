/**
 * 五个分组的校验器（规范 §6 / §9）。
 *
 * 它们是【各自独立注册的模块】，不由 FieldRegistry 生成。
 * FieldRegistry 只提供"超范围"这类字段级检查的元数据；像"samples 是否够密"
 * 这种在 registry 里没有对应字段的规则，必须是独立检查项。
 *
 * ★ 阈值分两类，不能混：
 *   【字段级约束】从 FieldRegistry 取（通过 numericRangeOf）。手写一份就等于
 *     让"模型看见的范围"和"引擎接受的范围"各自漂移 —— 规范 §6 明说不允许。
 *   【引擎策略目标】留在这里，但必须写明它是策略而不是字段约束
 *     （例如"低于下限时自动提升到 2400"：2400 不是字段的合法上界，
 *      也不该塞进 registry —— registry 里塞策略，三份产物会一起被污染）。
 */
import type { SceneDoc } from '../doc/types';
import { findScene, sceneOrder } from '../doc/types';
import { unwrapField } from '../doc/fields';
import { decodeFormulaGeometry } from '../render/formula-geometry';
import { compileExpr } from '../expr';
import { evaluate } from '../evaluate';
import { collectStructuralTrackProblems, sampleTrack } from '../anim/track';
import { nearestMarker } from '../doc/shift';
import type { Box, RenderItem } from '../render-state';
import type { Command } from '../command/commands';
import type { Issue, ValidatorGroup } from './types';
import { REGISTRY } from '../registry/fields';
import { numericRangeOf } from '../registry/schema';

/** 从 registry 取一个数值字段的边界；拿不到就抛（静默退回手写值是最坏的选择）。 */
function boundOf(groupId: string, field: string): { readonly min: number; readonly max: number } {
  const range = numericRangeOf(REGISTRY, groupId, field);
  if (range?.min === undefined || range.max === undefined) {
    throw new Error('registry 里 ' + groupId + '.' + field + ' 没有登记数值边界');
  }
  return { min: range.min, max: range.max };
}

/**
 * 采样数下限由 registry 决定（shape.plot2d.params.samples 的 min）。
 * 它在 registry 里是 16（"能画出来"的技术下限），而视觉上够不够密是另一回事 ——
 * 所以下面还有一个引擎自己的 MIN_SAMPLES。
 */
export const SAMPLES_REGISTRY_MIN = boundOf('shape.plot2d.params', 'samples').min;

/** 采样数的【视觉】下限。低于它曲线在屏幕上会出现折角。这是引擎策略，不是字段约束。 */
export const MIN_SAMPLES = 400;
/**
 * "采样过低"时自动提升到的目标值。★ 引擎策略，刻意不进 registry：
 * registry 描述的是字段的合法取值域，不是"我们希望它取多少"。
 */
export const AUTO_SAMPLES = 2400;
/** drawOn 时长的下限（秒）来自 registry —— 它同时也是 schema 里的 minimum。 */
export const MIN_DRAWON_DURATION = boundOf('effect.drawOn.params', 'duration').min;
/**
 * "忘了写 duration"时自动补上的值。★ 引擎策略，刻意不进 registry。
 *
 * 刻意不用 MIN_DRAWON_DURATION：那个 0.2 秒是"技术上能画出来"的下限，
 * 拿来当默认值会得到一个几乎看不见的生长动画（实测模型每次都要多花一轮改回来）。
 * 2 秒是"人眼能看出在生长"的量级。
 */
export const AUTO_DRAWON_DURATION = 2;
/**
 * 对象在画布上的最小可见【边长】占比（相对视口长边）。
 *
 * 刻意不用面积：曲线是一维对象，屏幕包围盒的高度恒为 0（水平线）或很窄，
 * 面积指标会把一条横贯画面的正弦曲线判成"看不见"。
 */
export const MIN_VISIBLE_EXTENT_RATIO = 0.02;

/**
 * 可读元素（文字 / 公式）的最小字号。
 *
 * ★★ 引擎【策略】目标，不是字段约束 —— 与 MIN_SAMPLES 是同一类判断：
 *   registry 里 size 的 min 是 6（"技术上能画出来"），而 6px 的中文在 960×540 上
 *   根本读不出来。**字段约束管"能不能画"，这里管"读不读得到"。**
 *   所以它刻意不进 registry：registry 描述合法取值域，不是"我们希望它取多少"。
 */
export const MIN_READABLE_FONT_SIZE_PX = 16;
/** 公式的下限更高一点：字形更密（上下标、分数线），同样像素更难认。 */
export const MIN_FORMULA_FONT_SIZE_PX = 18;

/**
 * 可读元素离画布边缘的安全边距（像素）。
 *
 * 与提示词里「画面规范」那一节的数字是同一个 —— 两边不一致的话，
 * 模型按提示词做，引擎却按另一个数报错（或反过来），那比不报还糟。
 */
export const SAFE_MARGIN_PX = 24;

/**
 * 可读元素的包围盒最多允许多大比例落在画布外。
 *
 * 0.25 是"明显被裁"的量级：抗锯齿与斜体字形的边界溢出不该被报出来，
 * 而"半个标题在画外"必须被报出来。
 */
export const MAX_CLIPPED_FRACTION = 0.25;

/** 两个可读元素的盒子重叠到多少才算"压住了"（相对【较小】那个的面积）。 */
export const MIN_OVERLAP_RATIO = 0.15;

const SAMPLE_TIMES = 5;

/* ══════════════════ environment：引用完整性 ══════════════════ */

export function validateEnvironment(doc: SceneDoc): readonly Issue[] {
  const out: Issue[] = [];

  // 效果的 target 悬空
  for (const effId of Object.keys(doc.effects)) {
    const eff = doc.effects[effId];
    if (eff === undefined) continue;
    if (doc.objects[eff.target] === undefined) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'effect_target_missing',
        path: 'effects.' + effId + '.target',
        message: '效果 ' + effId + ' 指向不存在的对象 ' + eff.target + '，它永远不会被绘制。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'delete_effect', target: effId }],
      });
    }

    /**
     * ── moveAlong 的路径来源（P2）─────────────────────────────
     *
     * ★ 这些是【引擎判定】而不是模型自己声明的适用性（不变量 4）：
     *   求值路径上遇到坏引用只会静默不动（画面里对象就杵在原地），
     *   如果不说出来，"没动"和"没写"在回执里长得一模一样。
     */
    if (eff.type !== 'moveAlong') continue;
    const source = String(unwrapField(eff.params['source']) ?? '');
    const path = 'effects.' + effId + '.params.source';
    if (source === '') {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'move_along_source_missing',
        path,
        message:
          'moveAlong 没有指定 source —— 没有路径可走，这个对象会一直待在原地。' +
          'source 要填一个 line 对象的 id（形如 line#1），它从 from 走到 to。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'delete_effect', target: effId }],
      });
      continue;
    }
    if (source === eff.target) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'move_along_source_self',
        path,
        message: 'moveAlong 的 source 就是它自己（' + source + '）：路径取自自己的话，它不会移动。',
        fixClass: 'agent',
      });
      continue;
    }
    const src = doc.objects[source];
    if (src === undefined) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'move_along_source_missing',
        path,
        message:
          'moveAlong 的 source 指向不存在的对象 ' + source + '，它不会移动。' +
          '路径必须是一个【已经存在】的 line 对象。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'delete_effect', target: effId }],
      });
      continue;
    }
    if (src.shape !== 'line') {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'move_along_source_not_line',
        path,
        message:
          'moveAlong 的 source（' + source + '）是 ' + src.shape + '，不是 line —— ' +
          '只有 line 才有"起点→终点"这条路径。要么把它换成一个 line 对象，' +
          '要么改成给 ' + eff.target + ' 写 tf.x / tf.y 的关键帧。',
        fixClass: 'agent',
      });
    }
  }

  /**
   * ── 显隐窗口（P2 第四条）──────────────────────────────────────
   *
   * "出现得比消失还晚"的对象整片都不在画面里。求值路径对此【什么都不做】
   * （它只是一次时刻比较），于是症状是一整片空白 ——
   * 而"什么都没有"是人从画面上最反推不出原因的一种失败。
   *
   * 判据用 `>=`（与求值路径同一口径）：`appear.at === disappear.at` 时
   * 可见窗口是空集，不是"闪一帧"。
   */
  const appearAt = new Map<string, number>();
  const disappearOf = new Map<string, { at: number; effId: string }>();
  for (const effId of Object.keys(doc.effects)) {
    const eff = doc.effects[effId];
    if (eff === undefined) continue;
    const at = Number(unwrapField(eff.params['at']));
    if (!Number.isFinite(at)) continue;
    if (eff.type === 'appear') appearAt.set(eff.target, at);
    else if (eff.type === 'disappear') disappearOf.set(eff.target, { at, effId });
  }
  for (const [target, dis] of disappearOf) {
    const app = appearAt.get(target);
    if (app === undefined || app < dis.at) continue;
    out.push({
      severity: 'error',
      group: 'environment',
      code: 'visibility_window_empty',
      path: 'effects.' + dis.effId + '.params.at',
      message:
        target + ' 的出现时刻（' + app + 's）不早于消失时刻（' + dis.at + 's），' +
        '所以它整片都不会出现在画面里。把出现时刻改早、或把消失时刻改晚。',
      fixClass: 'agent',
    });
  }

  // 图层里挂了不存在的对象；以及对象不在任何图层
  const inLayer = new Set<string>();
  for (const layer of doc.layers) {
    for (const objectId of layer.objects) {
      if (doc.objects[objectId] === undefined) {
        out.push({
          severity: 'error',
          group: 'environment',
          code: 'layer_ref_dangling',
          path: 'layers.' + layer.id + '.objects',
          message: '图层 ' + layer.id + ' 引用了不存在的对象 ' + objectId + '。',
          fixClass: 'auto',
          suggestedFix: [{ op: 'unlink_object', layerId: layer.id, objectId }],
        });
      } else {
        inLayer.add(objectId);
      }
    }
  }

  const firstLayer = doc.layers[0];
  for (const objectId of Object.keys(doc.objects)) {
    if (inLayer.has(objectId)) continue;
    const fix: Command[] =
      firstLayer === undefined
        ? []
        : [{ op: 'link_object', layerId: firstLayer.id, objectId }];
    out.push({
      severity: 'warn',
      group: 'environment',
      code: 'object_not_in_layer',
      path: 'objects.' + objectId,
      message: '对象 ' + objectId + ' 不属于任何图层，因此不会被绘制。',
      fixClass: fix.length === 0 ? 'human' : 'auto',
      ...(fix.length === 0 ? {} : { suggestedFix: fix }),
    });
  }

  /**
   * ── 公式几何（方案 B：几何由工具物化）────────────────────────
   *
   * 求值层遇到解不出点列的公式【什么都不画】（与其它容错口径一致）——
   * 于是画面上少了一个东西，而「少了东西」最难从画面上反推原因。
   * 所以必须在这里报出来：要么是工具写坏了，要么是文档被人手改过。
   */
  for (const objectId of Object.keys(doc.objects)) {
    const obj = doc.objects[objectId];
    if (obj === undefined || obj.shape !== 'formula') continue;
    const raw = String(unwrapField(obj.params['paths']) ?? '');
    if (decodeFormulaGeometry(raw).length === 0) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'formula_geometry_missing',
        path: 'objects.' + objectId + '.params.paths',
        message:
          objectId + ' 是公式对象，但它的矢量轮廓解不出任何子路径 —— 求值时会什么都不画。' +
          '不要手改几何：用 render_formula 重新生成一次（几何必须由 LaTeX 算出来）。',
        fixClass: 'agent',
      });
    }
    if (String(unwrapField(obj.params['source']) ?? '').trim() === '') {
      out.push({
        severity: 'warn',
        group: 'environment',
        code: 'formula_source_missing',
        path: 'objects.' + objectId + '.params.source',
        message: objectId + ' 没有留下 LaTeX 源码 —— 几何还在，但没人知道它画的是什么，也重画不出来。',
        fixClass: 'agent',
      });
    }
  }

  // ── 镜头归属（P12）─────────────────────────────────────────
  // ★ 只检查【有镜头表的】文档。理由：空表 = 单镜头（旧行为），这时
  //   owner.sceneId 只是个占位名字、谁都不解析它（时间窗退回 [bornAt, duration]），
  //   为一个不参与任何计算的字段报 error 就是纯噪声 —— 存量文档与全部测试夹具
  //   都会被它淹掉。反过来说，表一旦存在，悬空引用就是真的 bug，
  //   那时它会让对象的时间窗与写权限悄悄退化，必须在提交回执里说出来。
  //
  // ★ 这里【没有】"owner.bornAt 必须等于 scene.bornAt" 的校验：
  //   bornAt 是缓存、表的 bornAt 才是真源（见 doc/types.ts 的 objectTimeWindow），
  //   既然谁都不读那份缓存，不一致就没有可观测后果。这正是不变量 1 的推论 ——
  //   派生量的副本最好是干脆不存在，而不是"存在并且还要人盯着"。
  // ★ 用 sceneOrder() 而不是 doc.scenes.length：增量文档（out/*.json 里加字段之前
  //   落盘的那些）根本没有 scenes 字段，直接读 .length 会在校验器里抛异常 ——
  //   而校验器是最不该抛异常的地方。sceneOrder 把"缺失"归一化成空表。
  if (sceneOrder(doc).length > 0) {
    for (const objectId of Object.keys(doc.objects)) {
      const owner = doc.objects[objectId]?.owner;
      if (owner === undefined || owner.kind !== 'scene') continue;
      if (findScene(doc, owner.sceneId) === undefined) {
        out.push({
          severity: 'error',
          group: 'environment',
          code: 'scene_ref_missing',
          path: 'objects.' + objectId + '.owner.sceneId',
          message:
            '对象 ' + objectId + ' 属于镜头 ' + owner.sceneId + '，但镜头表里没有这一镜。' +
            '它仍然会被绘制，但时间窗与写权限都退化了（时间窗变成整片）。' +
            '要么补上这一镜，要么把它改到已有的镜头上。',
          fixClass: 'human',
        });
      }
    }
  }

  // ── 父子关系（分组）─────────────────────────────────────────
  // ★ 求值路径上对环与超深都有防御（见 evaluate.ts 的 MAX_PARENT_DEPTH），
  //   所以这里报的是"文档有问题"，不是"引擎会挂"。两件事都要有：
  //   防御保证任何输入都能终止；校验器保证问题被人看见。
  for (const objectId of Object.keys(doc.objects)) {
    const obj = doc.objects[objectId];
    if (obj === undefined || obj.parent === undefined) continue;

    if (doc.objects[obj.parent] === undefined) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'parent_missing',
        path: 'objects.' + objectId + '.parent',
        message: '对象 ' + objectId + ' 的父级 ' + obj.parent + ' 不存在，它会按顶层对象处理（位置可能与预期不符）。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'set_parent', target: objectId, parent: null }],
      });
      continue;
    }

    // 沿父级链走一遍，看会不会回到自己
    const seen = new Set<string>([objectId]);
    let cursor: string | undefined = obj.parent;
    let cycle = false;
    for (let depth = 0; depth < 512 && cursor !== undefined; depth++) {
      if (seen.has(cursor)) {
        cycle = true;
        break;
      }
      seen.add(cursor);
      cursor = doc.objects[cursor]?.parent;
    }
    if (cycle) {
      out.push({
        severity: 'error',
        group: 'environment',
        code: 'parent_cycle',
        path: 'objects.' + objectId + '.parent',
        message:
          '对象 ' + objectId + ' 的父级链绕回了自己（' + [...seen].join(' → ') + '）。' +
          '求值时会在环处截断，画面会不对 —— 必须解开。',
        fixClass: 'human',
      });
    }
  }

  return out;
}

/* ══════════════════ semantic：表达式与类型 ══════════════════ */

export function validateSemantic(doc: SceneDoc): readonly Issue[] {
  const out: Issue[] = [];

  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    if (obj === undefined || obj.shape !== 'plot2d') continue;
    const expr = String(unwrapField(obj.params['expr']) ?? '');
    const compiled = compileExpr(expr, ['x', 't']);
    if (!compiled.ok) {
      out.push({
        severity: 'error',
        group: 'semantic',
        code: 'expr_compile_failed',
        path: id + '.params.expr',
        message: '表达式无法编译（' + compiled.error.code + '）：' + compiled.error.message,
        fixClass: 'auto',
        // 兜底成常量 0：曲线会退化成一条贴轴的直线，但它至少是可渲染、可继续编辑的，
        // 而且模型/用户能立刻看出"这里被兜底了"。抛异常打断整帧才是更坏的选择。
        suggestedFix: [{ op: 'set_expression', target: id, expr: '0' }],
      });
      continue;
    }
    const env = { x: 0, t: 0 };
    const value = compiled.eval(env);
    if (!Number.isFinite(value)) {
      out.push({
        severity: 'warn',
        group: 'semantic',
        code: 'expr_non_finite_at_origin',
        path: id + '.params.expr',
        message: '表达式在 x=0 处取不到有限值（' + String(value) + '）。',
        fixClass: 'agent',
      });
    }
  }

  return out;
}

/* ══════════════════ motion：时间轴上的行为 ══════════════════ */

export function validateMotion(doc: SceneDoc): readonly Issue[] {
  const out: Issue[] = [];

  for (const effId of Object.keys(doc.effects)) {
    const eff = doc.effects[effId];
    if (eff === undefined || eff.type !== 'drawOn') continue;
    const start = Number(unwrapField(eff.params['start']) ?? 0);
    const rawDuration = unwrapField(eff.params['duration']);
    const duration = Number(rawDuration ?? 0);
    /**
     * ★ "没写 duration" 与 "把它写成了 0 或负数" 是两件不同的事，以前共用一个 code。
     *
     * 实测代价：模型把效果参数写在了 effect 的顶层（少了 params 一层），
     * 于是 params 落地成 {} —— duration 根本不存在。而回执说的是
     * "drawOn 的时长是 0，曲线永远画不出来"，模型完全看不出"参数层级写错了"，
     * 只能反复试。缺参数要明说缺参数。
     */
    if (rawDuration === undefined) {
      out.push({
        severity: 'error',
        group: 'motion',
        code: 'drawon_duration_missing',
        path: effId + '.params.duration',
        message:
          'drawOn 没有指定 duration，它会被当成 0（曲线永远画不出来）。' +
          '效果参数必须放在 effect.params 里，别写在 effect 的顶层。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'set_effect', target: effId, duration: AUTO_DRAWON_DURATION }],
      });
      continue;
    }
    if (!(duration > 0)) {
      out.push({
        severity: 'error',
        group: 'motion',
        code: 'drawon_duration_nonpositive',
        path: effId + '.params.duration',
        message: 'drawOn 的时长是 ' + duration + '，曲线永远画不出来。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'set_effect', target: effId, duration: MIN_DRAWON_DURATION }],
      });
      continue;
    }
    const end = start + duration;
    if (end > doc.meta.duration) {
      out.push({
        severity: 'warn',
        group: 'motion',
        code: 'drawon_overruns_shot',
        path: effId + '.params.duration',
        at: doc.meta.duration,
        message: 'drawOn 在 ' + end.toFixed(2) + 's 结束，超出了镜头时长 ' + doc.meta.duration + 's。',
        fixClass: 'auto',
        suggestedFix: [
          { op: 'set_effect', target: effId, duration: Math.max(MIN_DRAWON_DURATION, doc.meta.duration - start) },
        ],
      });
    }
  }

  // ── 动画轨道（规范 §5 的 anim）───────────────────────────────
  // ★ 这些检查是在 evaluate 真的开始读 anim 之后才有意义的。
  //   在此之前 anim 是个装饰：写坏了没人管，因为根本没人读它。
  for (const problem of collectStructuralTrackProblems(doc)) {
    const path = problem.objectId + '.anim.' + problem.path;
    if (problem.reason === 'unsupported_zone') {
      out.push({
        severity: 'error',
        group: 'motion',
        code: 'anim_track_unsupported',
        path,
        message:
          '轨道 ' + problem.path + ' 不是可动画的字段。本版本只支持 tf.* 与 style.*：' +
          'params.*（expr / domain / samples）属于 geometry 类，改它必须重新采样，' +
          '而规范要求 samples 永远是全定义域的采样数 —— 逐帧重采样会让左段点密度一直抖。',
        fixClass: 'agent',
      });
      continue;
    }
    if (problem.reason === 'empty_keys') {
      out.push({
        severity: 'error',
        group: 'motion',
        code: 'anim_track_empty',
        path,
        message: '轨道 ' + problem.path + ' 一个关键帧都没有，它不会有任何效果。',
        fixClass: 'auto',
        // 删掉一条空轨道是唯一确定的修复，没有美学判断
        suggestedFix: [{ op: 'set_motion', target: problem.objectId, field: problem.path, node: null }],
      });
      continue;
    }
    out.push({
      severity: 'error',
      group: 'motion',
      code: 'anim_expr_compile_failed',
      path,
      message: '轨道 ' + problem.path + ' 的表达式编译不过，这条动画会被忽略。',
      fixClass: 'agent',
    });
  }

  // 数值层面的问题：在若干时刻上采样，看有没有非有限值
  if (doc.meta.duration > 0) {
    const times = [0, doc.meta.duration / 2, doc.meta.duration];
    for (const id of Object.keys(doc.objects)) {
      const obj = doc.objects[id];
      if (obj === undefined) continue;
      for (const field of Object.keys(obj.anim)) {
        const track = obj.anim[field];
        if (track === undefined) continue;
        for (const at of times) {
          const sampled = sampleTrack(track, at);
          if (sampled.ok || sampled.reason === 'empty_keys' || sampled.reason === 'expr_failed') {
            // 结构性原因上面已经报过，不重复
            continue;
          }
          out.push({
            severity: 'warn',
            group: 'motion',
            code: 'anim_track_non_finite',
            path: id + '.anim.' + field,
            at,
            message:
              '轨道 ' + field + ' 在 t=' + at + 's 处取不到有限值，该时刻会退回静态值。',
            fixClass: 'agent',
          });
          break; // 一条轨道只报一次，避免刷屏
        }
      }
    }
  }

  // ── 音频（P11）─────────────────────────────────────────────
  for (const a of doc.audioTracks) {
    if (a.startAt >= doc.meta.duration) {
      out.push({
        severity: 'error',
        group: 'motion',
        code: 'audio_starts_beyond_shot',
        path: a.id + '.startAt',
        message: '音频轨 ' + a.id + ' 的起点 ' + a.startAt + 's 已经超出镜头时长 ' + doc.meta.duration + 's。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'set_audio', target: a.id, startAt: 0 }],
      });
    }
    // 旁白对齐标记（P11 第 5 条）：narration 的起点应当落在某个 marker 上
    if (a.kind === 'narration' && doc.markers.length > 0) {
      const near = nearestMarker(doc, a.startAt);
      if (near !== undefined && Math.abs(near - a.startAt) > 1e-6) {
        out.push({
          severity: 'warn',
          group: 'motion',
          code: 'narration_off_marker',
          path: a.id + '.startAt',
          at: a.startAt,
          message: '旁白 ' + a.id + ' 起点 ' + a.startAt + 's 不落在任何标记上（最近的标记在 ' + near + 's）。',
          fixClass: 'auto',
          suggestedFix: [{ op: 'set_audio', target: a.id, startAt: near }],
        });
      }
    }
  }

  return out;
}

/* ══════════════════ export：成片质量 ══════════════════ */

export function validateExport(doc: SceneDoc): readonly Issue[] {
  const out: Issue[] = [];

  /**
   * 空镜头。
   *
   * ★ 这是压力测试实测出来的一个真空洞：一份【没有任何可绘制对象】的文档
   *   能带着 issues=0 通过全部五个校验器，因为每个校验器都在遍历"已有的东西"。
   *   于是"做完了"和"什么都没做/做不了"在引擎侧完全不可区分 ——
   *   completion 臂 #19/#20 就是这样：Agent 读完摘要、看到 objects: []、
   *   调 finish_shot 收尾，而判据只能记成"一次写入都没成功"。
   *
   *   fixClass 是 agent 而不是 human：该建曲线还是该向用户澄清意图，
   *   是叙事判断，引擎不许替它决定。这条规则只负责把"空"这件事说出来。
   */
  if (Object.keys(doc.objects).length === 0) {
    out.push({
      severity: 'warn',
      group: 'export',
      code: 'empty_shot',
      path: 'objects',
      message:
        '这份文档里没有任何可绘制对象，渲染出来是一张空背景。' +
        '如果这一镜本来就该有内容，请先建对象；如果任务要求改的是"已有的某条曲线"而它并不存在，' +
        '应当明确报告这一点，而不是当作已完成。',
      fixClass: 'agent',
    });
  }

  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    if (obj === undefined || obj.shape !== 'plot2d') continue;
    const samples = Number(unwrapField(obj.params['samples']) ?? 0);
    if (samples < MIN_SAMPLES) {
      out.push({
        severity: 'warn',
        group: 'export',
        code: 'samples_low',
        path: id + '.params.samples',
        message:
          '采样数 ' + samples + ' 低于下限 ' + MIN_SAMPLES + '，导出时曲线会出现折角。' +
          '注意：这是全定义域的采样数，绘制动画不会重新采样。',
        fixClass: 'auto',
        suggestedFix: [{ op: 'set_sampling', target: id, samples: AUTO_SAMPLES }],
      });
    }
  }

  if (doc.meta.duration < 1) {
    out.push({
      severity: 'error',
      group: 'export',
      code: 'duration_too_short',
      path: 'meta.duration',
      message: '镜头时长是 ' + doc.meta.duration + 's，短到无法成片。',
      fixClass: 'human',
    });
  }

  return out;
}

/* ══════════════════ layout：屏幕空间 ══════════════════ */
/**
 * 这一组需要 evaluate 出来的真实几何。全部标 agent —— 构图好不好是美学判断。
 *
 * ★★ 第二十九轮按 §0.28 作业 1（a）补齐了【表现层】自检。
 *   在此之前这一组只有两条：整段都在画外、整段都太小。于是"Agent 自检"能回答的
 *   只有「引擎与形状对不对」，回答不了「画得对不对」——
 *   文字出画 / 被裁 / 字号太小 / 两个元素压在一起，一条都报不出来。
 *
 * ★ 新四条【只对可读元素（文字 / 公式）生效】，这是刻意的：
 *   曲线穿过画面边缘、填充区域互相叠压都是构图常态（甚至是想要的），
 *   而"半个标题在画外""两块文字压在一起"无论怎么看都是缺陷。
 *   把判据挂在"可读"这个语义上，比按形状名单打补丁更不容易长出假阳性。
 */

/** 可读元素：文字与公式。 */
function isReadable(item: RenderItem): boolean {
  return item.kind === 'text' || item.kind === 'formula';
}

/** 字号取 evaluate 真正用的那个值（公式的 style.fontSize 可能没写，求值层默认 24）。 */
function fontSizeOf(item: RenderItem): number {
  if (item.text !== undefined) return item.text.fontSize;
  return item.style?.fontSize ?? 24;
}

function fontSizeFloorOf(item: RenderItem): number {
  return item.kind === 'formula' ? MIN_FORMULA_FONT_SIZE_PX : MIN_READABLE_FONT_SIZE_PX;
}

/** 盒子落在画布外的面积占比（0 = 完全在画内，1 = 完全在画外）。 */
function clippedFraction(box: Box, vw: number, vh: number): number {
  const area = box.w * box.h;
  if (!(area > 0)) return 0;
  const ox = Math.min(box.x + box.w, vw) - Math.max(box.x, 0);
  const oy = Math.min(box.y + box.h, vh) - Math.max(box.y, 0);
  const inside = Math.max(0, ox) * Math.max(0, oy);
  return Math.min(1, Math.max(0, 1 - inside / area));
}

/** 盒子到最近画布边的距离（负数 = 已经出去了）。 */
function marginOf(box: Box, vw: number, vh: number): number {
  return Math.min(box.x, box.y, vw - (box.x + box.w), vh - (box.y + box.h));
}

/** 两个盒子的重叠面积 / 较小那个的面积。 */
function overlapRatio(a: Box, b: Box): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  if (!(minArea > 0)) return 0;
  return (ox * oy) / minArea;
}

function px(n: number): number {
  return Math.round(n * 10) / 10;
}

interface ReadableSample {
  readonly t: number;
  readonly item: RenderItem;
  readonly vw: number;
  readonly vh: number;
}

/**
 * 新四条：字号太小 / 被裁 / 贴边 / 压在一起。
 *
 * ★ 判据一律写成「每一个看得见的采样都成立」——宁可少报，不可乱报。
 *   一个"每帧都被裁"的标题是真缺陷；一个"滑入过程中有一帧贴边"的标题不是。
 *   假阳性的代价在这个项目里特别高：模型会照着它去改一份本来就合格的文档
 *   （§0.28 作业 1 的验收第 2 条就是专门防这个的）。
 */
function readableIssues(samplesOf: ReadonlyMap<string, readonly ReadableSample[]>): readonly Issue[] {
  const out: Issue[] = [];
  const readings: { id: string; samples: readonly ReadableSample[] }[] = [];
  for (const [id, samples] of samplesOf) {
    // 只关心真的看得见的采样：opacity 0 / drawOn 未开始的对象不该被报"太靠边"
    const visible = samples.filter((s) => s.item.opacity > 0 && s.item.visibleFraction > 0);
    if (visible.length === 0) continue;
    readings.push({ id, samples: visible });
  }

  for (const { id, samples } of readings) {
    const first = samples[0];
    if (first === undefined) continue;
    const label = first.item.kind === 'formula' ? '公式' : '文字';
    const floor = fontSizeFloorOf(first.item);

    // ① 被画面边缘裁掉（每一帧都被裁掉一大块，但没到"完全看不见"）
    const clipped = samples.map((s) => clippedFraction(s.item.box, s.vw, s.vh));
    const worstClip = Math.max(...clipped);
    const clipAll = clipped.every((f) => f > MAX_CLIPPED_FRACTION && f < 1);
    if (clipAll) {
      const at = samples[clipped.indexOf(worstClip)]?.t ?? first.t;
      out.push({
        severity: 'warn',
        group: 'layout',
        code: 'text_clipped',
        path: 'objects.' + id,
        at,
        message:
          label + '对象 ' + id + ' 有 ' + Math.round(worstClip * 100) + '% 的面积落在画布外（每一帧都如此）。' +
          '用 set_transform 把它挪回画面内，或者缩短内容 / 调小换行宽度。',
        fixClass: 'agent',
      });
      continue;
    }

    // ② 字号太小
    const biggest = Math.max(...samples.map((s) => fontSizeOf(s.item)));
    if (biggest < floor) {
      out.push({
        severity: 'warn',
        group: 'layout',
        code: 'text_too_small',
        path: 'objects.' + id,
        at: first.t,
        message:
          label + '对象 ' + id + ' 的字号只有 ' + px(biggest) + 'px，低于可读下限 ' + floor + 'px。' +
          '屏幕空间的字号【不随相机缩放】，调小它就真的小了 —— 用 set_style 的 size 调回来。',
        fixClass: 'agent',
      });
      continue;
    }

    // ③ 贴边（完全在画内，但离边缘太近）—— 只在每一帧都贴边时报
    const margins = samples.map((s) => marginOf(s.item.box, s.vw, s.vh));
    const worstMargin = Math.min(...margins);
    if (margins.every((m) => m >= 0) && worstMargin < SAFE_MARGIN_PX) {
      const at = samples[margins.indexOf(worstMargin)]?.t ?? first.t;
      out.push({
        severity: 'info',
        group: 'layout',
        code: 'text_in_safe_margin',
        path: 'objects.' + id,
        at,
        message:
          label + '对象 ' + id + ' 离画布边缘只有 ' + px(worstMargin) + 'px，低于安全边距 ' +
          SAFE_MARGIN_PX + 'px。往里挪一点 —— 贴边的东西在投影或裁切时会先被切掉。',
        fixClass: 'agent',
      });
    }
  }

  // ④ 两个可读元素压在一起（每一帧都压着 —— 动画里的擦身而过不算）
  for (let i = 0; i < readings.length; i++) {
    for (let j = i + 1; j < readings.length; j++) {
      const a = readings[i];
      const b = readings[j];
      if (a === undefined || b === undefined) continue;
      const byT = new Map(b.samples.map((s) => [s.t, s]));
      let both = 0;
      let hit = 0;
      let worst = 0;
      let worstT = 0;
      for (const sa of a.samples) {
        const sb = byT.get(sa.t);
        if (sb === undefined) continue;
        both += 1;
        const ratio = overlapRatio(sa.item.box, sb.item.box);
        if (ratio > worst) {
          worst = ratio;
          worstT = sa.t;
        }
        if (ratio >= MIN_OVERLAP_RATIO) hit += 1;
      }
      if (both > 0 && hit === both) {
        out.push({
          severity: 'warn',
          group: 'layout',
          code: 'text_overlap',
          path: 'objects.' + a.id,
          at: worstT,
          message:
            '文字/公式 ' + a.id + ' 与 ' + b.id + ' 的盒子有 ' + Math.round(worst * 100) +
            '% 重叠（每一帧都压在一起）。挪开其中一个，或者把两段并成一段。',
          fixClass: 'agent',
        });
      }
    }
  }

  return out;
}

export function validateLayout(doc: SceneDoc): readonly Issue[] {
  const out: Issue[] = [];
  const ids = Object.keys(doc.objects);
  if (ids.length === 0 || doc.meta.duration <= 0) return out;

  const times: number[] = [];
  for (let i = 0; i < SAMPLE_TIMES; i++) {
    times.push((doc.meta.duration * (i + 0.5)) / SAMPLE_TIMES);
  }

  /**
   * ★ 求值从「每个对象各算一遍」改成「每个采样时刻算一遍」。
   *   原来最坏是 objects × SAMPLE_TIMES 次 evaluate（100 个对象 = 500 次整档重算）；
   *   更重要的是，新的「两个元素压在一起」是【跨对象】检查 ——
   *   在旧结构里（每次只看一个 id）根本写不出来。
   */
  const frames = times.map((t) => ({ t, state: evaluate(doc, t) }));
  const samplesOf = new Map<string, ReadableSample[]>();
  for (const { t, state } of frames) {
    for (const item of state.items) {
      if (!isReadable(item)) continue;
      const entry: ReadableSample = { t, item, vw: state.viewport.w, vh: state.viewport.h };
      const list = samplesOf.get(item.id);
      if (list === undefined) samplesOf.set(item.id, [entry]);
      else list.push(entry);
    }
  }

  // ── 老账（行为与第二十九轮之前逐字一致）：整段都在画外 / 整段都太小 ──
  for (const id of ids) {
    let alwaysOff = true;
    let alwaysTiny = true;
    let worstOff: number | null = null;
    let worstTiny: number | null = null;

    for (const { t, state } of frames) {
      const item = state.items.find((i) => i.id === id);
      if (item === undefined) {
        // 这个时刻根本没画出来（drawOn 还没开始之类的）—— 不算越界
        continue;
      }
      const vw = state.viewport.w;
      const vh = state.viewport.h;
      const box = item.box;
      const outside =
        box.x + box.w < 0 || box.y + box.h < 0 || box.x > vw || box.y > vh;
      const extent = Math.max(box.w, box.h) / Math.max(vw, vh);
      if (!outside) alwaysOff = false;
      else if (worstOff === null) worstOff = t;
      /**
       * ★★ 第二十九轮：可读元素【不走】「太小」这条判据。
       *
       *   文字的可读性由【字号】决定（见新四条的 text_too_small），
       *   而不是它占屏幕的比例 —— 一行 18px 的注释本来就不该占满画面。
       *   旧的 0.02 比例在 1920 宽的画布上等于 38px，于是所有小于 38px 的标注
       *   都会被误报成「几乎是看不见的」，而模型会照着它去放大一份本来合格的画面 ——
       *   这正是 §0.28 作业 1 验收第 2 条（「已经合格时不许瞎改」）要防的事。
       *   曲线/散点/区域仍然走这条：它们没有"字号"，只有"占多大"。
       */
      if (isReadable(item) || extent >= MIN_VISIBLE_EXTENT_RATIO) alwaysTiny = false;
      else if (worstTiny === null) worstTiny = t;
    }

    if (alwaysOff && worstOff !== null) {
      out.push({
        severity: 'warn',
        group: 'layout',
        code: 'object_offscreen',
        path: 'objects.' + id,
        at: worstOff,
        message: '对象 ' + id + ' 在整段镜头里始终落在画面之外。',
        // 构图问题需要视觉判断：是相机该动，还是对象该挪，还是本该删掉。
        fixClass: 'agent',
      });
    } else if (alwaysTiny && worstTiny !== null) {
      out.push({
        severity: 'info',
        group: 'layout',
        code: 'object_too_small',
        path: 'objects.' + id,
        at: worstTiny,
        message:
          '对象 ' + id + ' 在画面上的最大边长占比始终低于 ' + MIN_VISIBLE_EXTENT_RATIO +
          '，几乎是看不见的。',
        fixClass: 'agent',
      });
    }
  }

  out.push(...readableIssues(samplesOf));

  return out;
}

export const VALIDATORS: Readonly<Record<ValidatorGroup, (doc: SceneDoc) => readonly Issue[]>> = {
  environment: validateEnvironment,
  semantic: validateSemantic,
  motion: validateMotion,
  layout: validateLayout,
  export: validateExport,
};

export const ALL_GROUPS: readonly ValidatorGroup[] = [
  'environment',
  'semantic',
  'motion',
  'layout',
  'export',
];
