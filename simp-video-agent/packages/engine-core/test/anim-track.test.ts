import { describe, expect, it } from 'vitest';
import {
  collectStructuralTrackProblems,
  evaluateObjectAnim,
  resolveItemStyle,
  sampleTrack,
  __clearTrackCaches,
} from '../src/anim/track';
import { isAnimatablePath, parseTrackPath } from '../src/anim/track-path';
import { evaluate } from '../src/evaluate';
import type { AnimTrack, SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject } from './fixtures';

/**
 * 动画求值（规范 §5 的 anim）。
 *
 * 这一组测试存在的理由：在它之前，obj.anim 写进文档、会被 set_motion 改、
 * 会被 retime 顺延、面板会标"动画驱动"、soft 锁会提示"会覆盖动画" ——
 * 而 evaluate() 从来不读它，画面一秒都不动，且没有任何东西报错。
 * 所以这里的断言不只是"函数返回什么"，更是"动画到底有没有影响画面"。
 */

function objWithAnim(anim: Record<string, AnimTrack>, over: Partial<SceneObject> = {}): SceneObject {
  return { ...makeObject('plot#1', 'plot2d'), anim, ...over };
}

describe('轨道路径解析', () => {
  it('同时接受对象相对与完整两种写法', () => {
    expect(parseTrackPath('tf.opacity')).toEqual({ zone: 'tf', key: 'opacity' });
    expect(parseTrackPath('style.width')).toEqual({ zone: 'style', key: 'width' });
    expect(parseTrackPath('objects.plot#1.tf.opacity')).toEqual({ zone: 'tf', key: 'opacity' });
    expect(parseTrackPath('objects.plot#1.style.glow')).toEqual({ zone: 'style', key: 'glow' });
  });

  it('params.* 与其它路径一律不认（几何类字段不能逐帧驱动）', () => {
    expect(parseTrackPath('params.expr')).toBeNull();
    expect(parseTrackPath('params.samples')).toBeNull();
    expect(parseTrackPath('objects.plot#1.params.expr')).toBeNull();
    expect(parseTrackPath('tf')).toBeNull();
    expect(parseTrackPath('tf.opacity.extra')).toBeNull();
    expect(isAnimatablePath('params.expr')).toBe(false);
  });

  it('tf 只认登记过的那六个字段', () => {
    expect(isAnimatablePath('tf.opacity')).toBe(true);
    expect(isAnimatablePath('tf.bogus')).toBe(false);
  });
});

describe('关键帧轨道采样', () => {
  const keys: AnimTrack = {
    kind: 'keys',
    keys: [
      { t: 0, v: 0 },
      { t: 2, v: 1, ease: 'linear' },
    ],
  };

  it('区间内线性插值（未标注 ease 时也是线性）', () => {
    expect(sampleTrack(keys, 1)).toEqual({ ok: true, value: 0.5 });
  });

  it('range 外不外推：取首/末关键帧', () => {
    expect(sampleTrack(keys, -5)).toEqual({ ok: true, value: 0 });
    expect(sampleTrack(keys, 99)).toEqual({ ok: true, value: 1 });
  });

  it('按【左端关键帧】标注的 ease 插值', () => {
    const eased: AnimTrack = {
      kind: 'keys',
      keys: [
        { t: 0, v: 0, ease: 'easeInOutCubic' },
        { t: 2, v: 1 },
      ],
    };
    // easeInOutCubic 在中点恰好 0.5
    expect(sampleTrack(eased, 1)).toEqual({ ok: true, value: 0.5 });
    const quarter = sampleTrack(eased, 0.5);
    expect(quarter.ok).toBe(true);
    expect(quarter.value).not.toBe(0.25); // 确实不是线性
  });

  it('关键帧没排序也算对（求值不允许改写文档）', () => {
    const messy: AnimTrack = { kind: 'keys', keys: [{ t: 2, v: 1 }, { t: 0, v: 0 }] };
    const before = messy.keys.map((k) => k.t);
    expect(sampleTrack(messy, 1)).toEqual({ ok: true, value: 0.5 });
    expect(messy.keys.map((k) => k.t)).toEqual(before); // 原数组没被动过
  });

  it('空 keys 明确报 empty_keys，而不是静默返回 undefined', () => {
    expect(sampleTrack({ kind: 'keys', keys: [] }, 1)).toEqual({ ok: false, reason: 'empty_keys' });
  });

  it('颜色这种没有中间值的字段：在左侧关键帧上跳变', () => {
    const color: AnimTrack = {
      kind: 'keys',
      keys: [
        { t: 0, v: '#4ea1ff' },
        { t: 2, v: '#ff0000' },
      ],
    };
    // 中点仍然是【合法颜色】，而不是拼出来的半截字符串
    expect(sampleTrack(color, 1)).toEqual({ ok: true, value: '#4ea1ff' });
    expect(sampleTrack(color, 2)).toEqual({ ok: true, value: '#ff0000' });
  });

  it('布尔同样是跳变', () => {
    const flag: AnimTrack = { kind: 'keys', keys: [{ t: 0, v: true }, { t: 1, v: false }] };
    expect(sampleTrack(flag, 0.5)).toEqual({ ok: true, value: true });
    expect(sampleTrack(flag, 1)).toEqual({ ok: true, value: false });
  });

  it('向量逐分量插值', () => {
    const vec: AnimTrack = { kind: 'keys', keys: [{ t: 0, v: [0, 0] }, { t: 2, v: [2, 4] }] };
    const r = sampleTrack(vec, 1);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([1, 2]);
  });
});

describe('表达式轨道', () => {
  /**
   * ★ clamp 的参数序：clamp(v, lo, hi) —— 与规范 §7 的例子一致。
   *
   * 这里曾经有一个真实缺陷：实现是 clamp(lo, v, hi)，于是规范 §7 的
   * `clamp(t/2.2,0,1)` 会变成 lo=t/2.2、v=0 → 恒等于 t/2.2，完全不夹，
   * 而且不报错。规范是锁定契约、模型也照它写，所以改的是实现。
   */
  it('expr 轨道按 t 求值（clamp(v,lo,hi)，即规范 §7 的写法）', () => {
    const track: AnimTrack = { kind: 'expr', expr: 'clamp(t/2.2,0,1)' };
    expect(sampleTrack(track, 0)).toEqual({ ok: true, value: 0 });
    expect(sampleTrack(track, 1.1)).toEqual({ ok: true, value: 0.5 });
    expect(sampleTrack(track, 5)).toEqual({ ok: true, value: 1 });
  });

  it('clamp 三个方向都对：低于下界夹到下界、高于上界夹到上界、中间原样', () => {
    const track: AnimTrack = { kind: 'expr', expr: 'clamp(t,2,4)' };
    expect(sampleTrack(track, -1).value).toBe(2);
    expect(sampleTrack(track, 3).value).toBe(3);
    expect(sampleTrack(track, 99).value).toBe(4);
  });

  it('旧参数序不再有特殊含义（避免有人照旧写法继续写）', () => {
    // clamp(0,t,1) 现在读作 v=0, lo=t, hi=1 → 结果随 lo 变化，不再是"夹到 [0,1]"
    expect(sampleTrack({ kind: 'expr', expr: 'clamp(0,t,1)' }, 3).value).toBe(3);
  });

  it('编译不过 → expr_failed；算出 NaN/Inf → non_finite（都不静默）', () => {
    const bad: AnimTrack = { kind: 'expr', expr: 'sin(' };
    const inf: AnimTrack = { kind: 'expr', expr: '1/0' };
    const wrongVar: AnimTrack = { kind: 'expr', expr: 'x*2' };
    expect(sampleTrack(bad, 1).reason).toBe('expr_failed');
    expect(sampleTrack(inf, 1).reason).toBe('non_finite');
    // 用错变量名（用了 x）也编译不过 —— 动画表达式只有 t
    expect(sampleTrack(wrongVar, 1).reason).toBe('expr_failed');
  });
});

describe('对象级求值：动画只覆盖它驱动的字段', () => {
  it('tf 动画覆盖静态值，没被驱动的字段保持原样', () => {
    const obj = objWithAnim(
      { 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } },
      { tf: { x: 3, y: 4, rotate: 0, sx: 1, sy: 1, opacity: 1 } },
    );
    const at0 = evaluateObjectAnim(obj, 0);
    expect(at0.tf.opacity).toBe(0);
    expect(at0.tf.x).toBe(3); // 静态值没有被抹掉
    expect(at0.tf.y).toBe(4);
    expect(evaluateObjectAnim(obj, 0.5).tf.opacity).toBe(0.5);
    expect(Object.keys(at0.issues)).toEqual([]);
  });

  it('style 动画进入 animatedStyle，静态 style 不受影响', () => {
    const obj = objWithAnim({
      'style.width': { kind: 'keys', keys: [{ t: 0, v: 1 }, { t: 2, v: 5 }] },
    });
    const r = evaluateObjectAnim(obj, 1);
    expect(r.style['width']).toBe(3);
    const styled = resolveItemStyle(obj, r.style);
    expect(styled.width).toBe(3);
    // 没被动画驱动的 stroke 仍来自静态 style
    expect(styled.stroke).toBe('#4ea1ff');
  });

  it('写坏的轨道不写入，但会被报出来（画面不因此崩，问题也不消失）', () => {
    const obj = objWithAnim({
      'params.expr': { kind: 'expr', expr: 'sin(x)' },
      'tf.bogus': { kind: 'keys', keys: [{ t: 0, v: 1 }] },
      'tf.opacity': { kind: 'expr', expr: 'sin(' },
      'tf.x': { kind: 'keys', keys: [] },
    });
    const r = evaluateObjectAnim(obj, 0);
    expect(Object.keys(r.issues).sort()).toEqual(['params.expr', 'tf.bogus', 'tf.opacity', 'tf.x']);
    expect(r.tf.opacity).toBe(1); // 退回静态值（fixture 的 opacity 是 1）
    expect(r.tf.x).toBe(0);
  });

  it('没有动画的对象：tf 原样返回（结构共享），不产生新矩阵输入', () => {
    const obj = makeObject('plot#1');
    const r = evaluateObjectAnim(obj, 1);
    expect(r.tf).toBe(obj.tf);
    expect(r.style).toEqual({});
  });
});

describe('动画真的影响画面（evaluate 端到端）', () => {
  function docWith(anim: Record<string, AnimTrack>, tf?: Partial<SceneObject['tf']>): SceneDoc {
    const base = makeDoc(1);
    const obj = objWithAnim(anim, tf === undefined ? {} : { tf: { ...makeObject('p').tf, ...tf } });
    return { ...base, objects: { 'plot#1': obj } };
  }

  it('淡入：opacity 轨道让 t 处的项透明度按动画走', () => {
    const doc = docWith({
      'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] },
    });
    const item = (t: number): number => evaluate(doc, t).items[0]?.opacity ?? -1;
    expect(item(0)).toBe(0);
    expect(item(1)).toBeCloseTo(0.5, 9);
    expect(item(2)).toBe(1);
    expect(item(5)).toBe(1); // 不外推
  });

  it('位移动画：tf.x 变化会让屏幕 AABB 真的移动', () => {
    const doc = docWith(
      { 'tf.x': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 2, v: 4 }] } },
    );
    const x0 = evaluate(doc, 0).items[0]?.box.x ?? 0;
    const x2 = evaluate(doc, 2).items[0]?.box.x ?? 0;
    // 4 个世界单位 × base(120，1920×1080 / 16×9)
    expect(x2 - x0).toBeCloseTo(480, 6);
  });

  it('线宽动画进 RenderItem.style（画笔消费它，所以画面会变粗）', () => {
    const doc = docWith({
      'style.width': { kind: 'keys', keys: [{ t: 0, v: 1 }, { t: 2, v: 6 }] },
    });
    expect(evaluate(doc, 0).items[0]?.style?.width).toBe(1);
    expect(evaluate(doc, 2).items[0]?.style?.width).toBe(6);
  });

  it('颜色动画进 RenderItem.style.stroke（字符串按跳变）', () => {
    const doc = docWith({
      'style.stroke': {
        kind: 'keys',
        keys: [
          { t: 0, v: '#4ea1ff' },
          { t: 1, v: '#ff0000' },
        ],
      },
    });
    expect(evaluate(doc, 0).items[0]?.style?.stroke).toBe('#4ea1ff');
    expect(evaluate(doc, 1).items[0]?.style?.stroke).toBe('#ff0000');
  });

  it('文字字号可以被动画驱动，但依然不进 scale()', () => {
    const base = makeDoc(1);
    const text = makeObject('label#1', 'text', {
      params: { content: { v: '标题' } },
      style: { size: { v: 20 }, fill: { v: '#ffffff' } },
      anim: { 'style.size': { kind: 'keys', keys: [{ t: 0, v: 12 }, { t: 2, v: 48 }] } },
    });
    const doc: SceneDoc = {
      ...base,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['label#1'] }],
      objects: { 'label#1': text },
    };
    const t0 = evaluate(doc, 0).items[0];
    const t2 = evaluate(doc, 2).items[0];
    expect(t0?.text?.fontSize).toBe(12);
    expect(t2?.text?.fontSize).toBe(48);
    // 相机 scale 是独立字段，绝不与字号相乘
    expect(t0?.text?.cameraScale).toBe(1);
  });

  it('同一 doc + 同一 t 反复求值结果一致（不变量 1）', () => {
    const doc = docWith({
      'tf.opacity': { kind: 'expr', expr: 'clamp(t/2,0,1)' },
      'style.glow': { kind: 'keys', keys: [{ t: 0, v: 0.2 }, { t: 3, v: 0.9 }] },
    }, { x: 1 });
    __clearTrackCaches();
    const a = JSON.stringify(evaluate(doc, 1.234));
    const b = JSON.stringify(evaluate(doc, 1.234));
    expect(a).toBe(b);
  });
});

describe('结构性问题汇总（给校验器）', () => {
  it('报出 params 轨道、非法 tf 字段、空 keys、编译失败的表达式', () => {
    const base = makeDoc(1);
    const obj = objWithAnim({
      'params.expr': { kind: 'expr', expr: 'sin(x)' },
      'tf.bogus': { kind: 'keys', keys: [{ t: 0, v: 1 }] },
      'tf.opacity': { kind: 'keys', keys: [] },
      'style.width': { kind: 'expr', expr: 'sin(' },
    });
    const doc: SceneDoc = { ...base, objects: { 'plot#1': obj } };
    const problems = collectStructuralTrackProblems(doc);
    expect(problems.map((p) => p.path + ':' + p.reason).sort()).toEqual([
      'params.expr:unsupported_zone',
      'style.width:expr_failed',
      'tf.bogus:unsupported_zone',
      'tf.opacity:empty_keys',
    ]);
  });

  it('合法轨道不产生任何问题', () => {
    const base = makeDoc(1);
    const obj = objWithAnim({
      'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
      'style.width': { kind: 'expr', expr: 'clamp(t,1,6)' },
    });
    expect(collectStructuralTrackProblems({ ...base, objects: { 'plot#1': obj } })).toEqual([]);
  });
});

describe('样式解析只有一份实现', () => {
  it('动画值优先于静态值，字段缺失时退回静态', () => {
    const obj = makeObject('plot#1', 'plot2d', {
      style: { stroke: { v: '#111111' }, width: { v: 2, min: 1, max: 9 }, glow: { v: 0.3 } },
    });
    const merged = resolveItemStyle(obj, { width: 7 });
    expect(merged).toEqual({ stroke: '#111111', width: 7, glow: 0.3 });
  });

  it('把动画显式驱动成 0 是有效取值，不会被当成"没有动画"', () => {
    const obj = makeObject('plot#1', 'plot2d', { style: { glow: { v: 0.6 } } });
    expect(resolveItemStyle(obj, { glow: 0 }).glow).toBe(0);
  });
});
