/**
 * 控件路径 → 领域化命令：面板这一侧的"人与 AI 同一条 CommandBus"。
 *
 * ★ 为什么单独一个模块（§7 第 0 条的修法）：
 *   它以前内联在 `app.ts` 的渲染闭包里，于是【只能靠真开浏览器点一下】才能测。
 *   而它断掉的时候**什么都不报**：控件画出来了、拖了没反应、也不报错 ——
 *   highlight / moveAlong 的效果参数从落地那天起就是死的，没人发现。
 *   抽成纯函数之后，"每个效果字段都有一条命令"这件事可以毫秒级断言。
 *
 * ★ 效果参数为什么需要 `doc`：`eff#1.params.*` 该派发到哪条命令取决于
 *   `doc.effects['eff#1'].type` —— 路径里不含类型信息。
 *   drawOn → set_effect / highlight → set_highlight / moveAlong → set_move_along
 *   三者字段集【不同】，靠字段名猜必然猜错（"给高亮设置 mode"是合法形状、
 *   但语义上是错的，而引擎会照收）。
 */
import { REGISTRY, groupFor, type Command, type Effect, type SceneDoc } from '@sva/engine-core';

/** 效果编辑命令的三个 op（每种效果一条 —— 见 commands.ts 里 SetHighlightCommand 的注释）。 */
type EffectEditOp = 'set_effect' | 'set_highlight' | 'set_move_along' | 'set_visibility';

interface EffectEditSpec {
  readonly op: EffectEditOp;
  /**
   * 这条命令认的字段。
   *
   * ★ 必须与 registry 的 `effect.<type>.params.fields` 逐字一致 ——
   *   `command-path.test.ts` 里有一条断言逐类型比对。
   *   少了：registry 里有控件、命令层却会静默丢掉这个字段；
   *   多了：命令层收得下、registry 里却没有对应的控件，是死字段。
   *   两种偏差都必须在测试里红，而不是在界面上静默。
   */
  readonly fields: readonly string[];
}

/**
 * 效果类型 → 编辑命令。
 *
 * 加一种效果类型时，这里与 registry 的 `effect.<type>.params` 必须一起改 ——
 * 有断言守着（否则"效果参数改不动"会以完全一样的方式复发）。
 */
export const EFFECT_EDITS: Readonly<Record<string, EffectEditSpec>> = {
  drawOn: { op: 'set_effect', fields: ['start', 'duration', 'mode', 'tip'] },
  highlight: { op: 'set_highlight', fields: ['start', 'duration', 'color', 'intensity'] },
  moveAlong: { op: 'set_move_along', fields: ['source', 'start', 'duration'] },
  /**
   * 显隐的两种效果【共用一条 op】：它们的字段集完全一样（只有一个 `at`），
   * 而 set_visibility 会检查效果类型 —— 这正是"字段集相同就共用"的判据。
   */
  appear: { op: 'set_visibility', fields: ['at'] },
  disappear: { op: 'set_visibility', fields: ['at'] },
};

/** 两个数的向量（vec2 字段：line 的 from/to、plot2d 的 domain）。 */
function isVec2(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number');
}

/** 命令的值：Editable 只收这三个原子类型（对象/数组走各自的字段形态）。 */
function isAtom(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** `eff#1.params.<key>` → 对应效果类型的那条编辑命令。不是效果路径就返回 null。 */
function effectEditCommand(effect: Effect, id: string, key: string, value: unknown): Command | null {
  const spec = EFFECT_EDITS[effect.type];
  if (spec === undefined) return null;
  if (!spec.fields.includes(key)) return null;
  if (!isAtom(value)) return null;
  /**
   * ★ 这里有一处（且只有这一处）类型断言：命令的字段集在【类型层】是封闭的
   *   （每种效果一个 interface），而这里是按字符串动态拼的。
   *   断言之所以安全，靠的是 `EFFECT_EDITS` 那两列 + 两条断言：
   *   表里的字段 = registry 的字段，且每条命令真的能写进文档（见 command-path.test.ts）。
   */
  return { op: spec.op, target: id, [key]: value } as unknown as Command;
}

/**
 * 点分路径 → 领域化命令。面板与 AI 走的是同一条路。
 *
 * 三种路径形态：
 *   `plot#1.style.width`   对象样式
 *   `plot#1.tf.y`          对象变换
 *   `plot#1.params.samples` 对象几何
 *   `eff#1.params.color`   效果参数（要 `doc` 才知道派发到哪条命令）
 *
 * 返回 null = 这个控件【没有】对应的命令。调用方必须把它说出来，
 * 不能像以前那样 `if (cmd === null) return;` —— 那正是"拖着没反应也不报错"的来源。
 */
export function commandForPath(path: string, value: unknown, doc: SceneDoc): Command | null {
  const parts = path.split('.');
  const target = parts[0];
  if (target === undefined || parts.length < 3) return null;
  const zone = parts[1];
  const key = parts.slice(2).join('.');

  // ── 效果参数：先认效果 id（效果 id 与对象 id 前缀不同，不会撞）──
  const effect = doc.effects[target];
  if (effect !== undefined && zone === 'params') {
    return effectEditCommand(effect, target, key, value);
  }

  if (zone === 'style') {
    if (key === 'width' && typeof value === 'number') return { op: 'set_style', target, width: value };
    if (key === 'glow' && typeof value === 'number') return { op: 'set_style', target, glow: value };
    if (key === 'stroke' && typeof value === 'string') return { op: 'set_style', target, stroke: value };
    // 第十七轮补上的四个（此前面板画着控件却没有命令能改，拖了只回一句"改不动"）
    if (key === 'fill' && typeof value === 'string') return { op: 'set_style', target, fill: value };
    if (key === 'fillOpacity' && typeof value === 'number') return { op: 'set_style', target, fillOpacity: value };
    if (key === 'headSize' && typeof value === 'number') return { op: 'set_style', target, headSize: value };
    if (key === 'size' && typeof value === 'number') return { op: 'set_style', target, size: value };
    // 文字排版（P3 第一块）：对齐是字符串枚举、换行宽度是数值（都可走 set_style）
    if (key === 'align' && typeof value === 'string') return { op: 'set_style', target, align: value };
    if (key === 'maxWidth' && typeof value === 'number') return { op: 'set_style', target, maxWidth: value };
    if (key === 'bold' && typeof value === 'boolean') return { op: 'set_style', target, bold: value };
    return null;
  }
  if (zone === 'tf') {
    if (typeof value !== 'number') return null;
    if (key === 'x') return { op: 'set_transform', target, x: value };
    if (key === 'y') return { op: 'set_transform', target, y: value };
    if (key === 'rotate') return { op: 'set_transform', target, rotate: value };
    if (key === 'sx') return { op: 'set_transform', target, sx: value };
    if (key === 'sy') return { op: 'set_transform', target, sy: value };
    if (key === 'opacity') return { op: 'set_transform', target, opacity: value };
    return null;
  }
  /**
   * 几何参数：**按对象的形状派发**（与效果那条按 eff.type 派发同一个思路）。
   *
   * ★ 字段名本身不含形状信息（三种形状都有 width，含义却完全不同：
   *   曲线的 width 是线宽、矩形的 width 是几何宽度），所以只能问文档。
   *   引擎那三条命令各自检查形状 —— 派发错了会被当场拒，不会写进错的字段。
   */
  if (zone === 'params') {
    const shape = doc.objects[target]?.shape;
    if (shape === 'rect') {
      if (key === 'width' && typeof value === 'number') return { op: 'set_rect', target, width: value };
      if (key === 'height' && typeof value === 'number') return { op: 'set_rect', target, height: value };
      if (key === 'radius' && typeof value === 'number') return { op: 'set_rect', target, radius: value };
      return null;
    }
    if (shape === 'line') {
      if (key === 'from' && isVec2(value)) return { op: 'set_line', target, from: [value[0], value[1]] };
      if (key === 'to' && isVec2(value)) return { op: 'set_line', target, to: [value[0], value[1]] };
      if (key === 'head' && typeof value === 'string') return { op: 'set_line', target, head: value };
      return null;
    }
    if (shape === 'text') {
      if (key === 'content' && typeof value === 'string') return { op: 'set_text', target, content: value };
      return null;
    }
    // plot2d（以及未登记的形状）：曲线自己的三个参数
    if (key === 'expr' && typeof value === 'string') return { op: 'set_expression', target, expr: value };
    if (key === 'samples' && typeof value === 'number') return { op: 'set_sampling', target, samples: value };
    if (key === 'domain' && isVec2(value)) {
      return { op: 'set_sampling', target, domain: [Number(value[0]), Number(value[1])] };
    }
  }
  return null;
}

/** registry 里某个效果类型的参数分组（断言与诊断用）。 */
export function effectParamFields(type: string): readonly string[] {
  const group = groupFor(REGISTRY, 'effect', type, 'params');
  return group === undefined ? [] : Object.keys(group.fields);
}
