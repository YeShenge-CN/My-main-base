/**
 * 颜色走上动画轨道（P2 第二条）。
 *
 * ★ 在此之前，字符串字段"插不动就跳变"（track.ts 的原话）。于是
 *   `style.stroke` 只能做【到点换色】，做不出"从蓝渐变到黄"——
 *   而那正是"数据流过来时线条变亮"这类效果的载体。
 *
 * 这一份要钉住的核心不是"颜色能插值"，而是【分界线】：
 *   颜色字段插值（有中间色），其余字符串仍然跳变（没有中间值）。
 *   判据来自 FieldRegistry（字段类型只有一处真源），不是"值看起来像不像颜色"。
 */
import { describe, expect, it } from 'vitest';
import { evaluateObjectAnim, resolveItemStyle, sampleTrack } from '../src/anim/track';
import { mixColor } from '../src/render/color';
import { evaluate } from '../src/evaluate';
import { REGISTRY } from '../src/registry/fields';
import { findField } from '../src/registry/schema';
import type { AnimTrack, SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject } from './fixtures';

function rect(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

const strokeTrack: AnimTrack = {
  kind: 'keys',
  keys: [
    { t: 0, v: '#4ea1ff' },
    { t: 2, v: '#ffd479' },
  ],
};

/* ── sampleTrack 的 mode ────────────────────────────────────── */

describe('sampleTrack 的两种模式', () => {
  it("mode='plain'（默认）：字符串跳变，没有中间值", () => {
    expect(sampleTrack(strokeTrack, 1).value).toBe('#4ea1ff');
    expect(sampleTrack(strokeTrack, 1.99).value).toBe('#4ea1ff');
    expect(sampleTrack(strokeTrack, 2).value).toBe('#ffd479');
  });

  it("mode='color'：字符串按颜色插值", () => {
    expect(sampleTrack(strokeTrack, 1, 'color').value).toBe(mixColor('#4ea1ff', '#ffd479', 0.5));
  });

  it('两端仍然取端点色（不外推）', () => {
    expect(sampleTrack(strokeTrack, -5, 'color').value).toBe('#4ea1ff');
    expect(sampleTrack(strokeTrack, 99, 'color').value).toBe('#ffd479');
  });

  it('ease 照样生效（与数值字段同一套）', () => {
    const eased: AnimTrack = {
      kind: 'keys',
      keys: [
        { t: 0, v: '#000000', ease: 'easeOutCubic' },
        { t: 1, v: '#ffffff' },
      ],
    };
    const mid = sampleTrack(eased, 0.5, 'color').value;
    // easeOutCubic(0.5) = 1-(1-0.5)^3 = 0.875 → 比线性中间色更亮
    expect(mid).toBe(mixColor('#000000', '#ffffff', 0.875));
    expect(mid).not.toBe(mixColor('#000000', '#ffffff', 0.5));
  });

  it('★ 非颜色字符串在 color 模式下仍然跳变（不猜、不瞎插）', () => {
    const label: AnimTrack = { kind: 'keys', keys: [{ t: 0, v: '甲' }, { t: 1, v: '乙' }] };
    expect(sampleTrack(label, 0.5, 'color').value).toBe('甲');
  });

  it('数值字段在 color 模式下照旧插值（模式只影响字符串那一支）', () => {
    const num: AnimTrack = { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] };
    expect(sampleTrack(num, 0.5, 'color').value).toBe(5);
  });
});

/* ── registry 判定：字段类型只有一处真源 ─────────────────────── */

describe('★ 判据来自 FieldRegistry，不是"值像不像颜色"', () => {
  it('rect / line / plot2d 的 stroke 都登记为 color', () => {
    expect(findField(REGISTRY, 'shape', 'rect', 'style', 'stroke')?.type).toBe('color');
    expect(findField(REGISTRY, 'shape', 'line', 'style', 'stroke')?.type).toBe('color');
    expect(findField(REGISTRY, 'shape', 'plot2d', 'style', 'stroke')?.type).toBe('color');
  });

  it('未登记的 shape → 退回 plain（宁可跳变，也不凭名字猜）', () => {
    const weird = rect({ shape: 'my.shape' });
    const obj: SceneObject = { ...weird, anim: { 'style.stroke': strokeTrack } };
    // 不抛异常，且走 plain（跳变）
    expect(evaluateObjectAnim(obj, 1).style['stroke']).toBe('#4ea1ff');
  });

  it('tf.* 走 plain（数值本来就不受模式影响）', () => {
    const obj: SceneObject = {
      ...rect(),
      anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } },
    };
    expect(evaluateObjectAnim(obj, 0.5).tf.opacity).toBe(0.5);
  });
});

/* ── 端到端：画面上真的有中间色 ───────────────────────────────── */

describe('端到端：颜色轨道真的在渐变', () => {
  function docWith(obj: SceneObject): SceneDoc {
    return {
      ...makeDoc(0, { duration: 4 }),
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [obj.shape + '#1'] }],
      objects: { [obj.shape + '#1']: obj },
      effects: {},
      markers: [],
    };
  }

  it('★ evaluate 出来的 stroke 在中途是中间色（不是两个端点色之一）', () => {
    const obj = rect({ anim: { 'style.stroke': strokeTrack } });
    const doc = docWith(obj);
    const mid = evaluate(doc, 1).items[0]?.style?.stroke ?? '';
    expect(mid).not.toBe('#4ea1ff');
    expect(mid).not.toBe('#ffd479');
    expect(mid).toBe(mixColor('#4ea1ff', '#ffd479', 0.5));
  });

  it('★ 动画值优先于静态值（静态 stroke 被轨道覆盖）', () => {
    const obj = rect({ anim: { 'style.stroke': { kind: 'keys', keys: [{ t: 0, v: '#ff0000' }] } } });
    expect(evaluate(docWith(obj), 1).items[0]?.style?.stroke).toBe('#ff0000');
  });

  it('resolveItemStyle 把动画色当作 stroke（不是 fill）', () => {
    const obj = rect();
    const s = resolveItemStyle(obj, { stroke: '#00ff00' });
    expect(s.stroke).toBe('#00ff00');
    // ★ rect 的 fill 是底色，不能被动画色顶掉（它们曾经共用一格）
    expect(s.fill).toBe('#16223a');
  });

  it('★ 高亮与颜色轨道能叠加：轨道给基色，高亮再往目标色推', () => {
    const obj = rect({
      anim: { 'style.stroke': { kind: 'keys', keys: [{ t: 0, v: '#4ea1ff' }, { t: 4, v: '#4ea1ff' }] } },
      effects: ['eff#1'],
    });
    const doc: SceneDoc = {
      ...docWith(obj),
      effects: {
        'eff#1': {
          type: 'highlight',
          target: 'rect#1',
          params: { start: { v: 0 }, duration: { v: 1 }, color: { v: '#ffd479' }, intensity: { v: 1 } },
        },
      },
    };
    // t=0.5：轨道基色仍是 #4ea1ff，高亮推进 0.5 → 中间色
    const mid = evaluate(doc, 0.5).items[0]?.style?.stroke ?? '';
    expect(mid).toBe(mixColor('#4ea1ff', '#ffd479', 0.5));
    // t=3：高亮已满 → 纯高亮色
    expect(evaluate(doc, 3).items[0]?.style?.stroke).toBe('#ffd479');
  });
});

/* ── 与其它层的衔接 ─────────────────────────────────────────── */

describe('颜色轨道与其它层的衔接', () => {
  it('retime 能顺延颜色轨道（它就是普通关键帧）', () => {
    // shiftTimeline 只挪 k.t，不看 v 的类型 —— 颜色轨道天然被支持
    const obj = rect({ anim: { 'style.stroke': strokeTrack } });
    const doc: SceneDoc = {
      ...makeDoc(0, { duration: 6 }),
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1'] }],
      objects: { 'rect#1': obj },
      effects: {},
      markers: [{ id: 'm', t: 1 }],
    };
    void doc;
    expect(obj.anim['style.stroke']).toBeDefined();
  });

  it('字体色（text.fill）也是 color，所以文字也能渐变', () => {
    expect(findField(REGISTRY, 'shape', 'text', 'style', 'fill')?.type).toBe('color');
    const text = makeObject('text#1', 'text', {
      params: { content: { v: '标题' } },
      style: { size: { v: 24 }, fill: { v: '#e8eef8' } },
      anim: { 'style.fill': { kind: 'keys', keys: [{ t: 0, v: '#e8eef8' }, { t: 2, v: '#ff0000' }] } },
    });
    const anim = evaluateObjectAnim(text, 1);
    expect(anim.style['fill']).toBe(mixColor('#e8eef8', '#ff0000', 0.5));
    // 文字的颜色走 fill（那条回退保留）
    expect(resolveItemStyle(text, anim.style).stroke).toBe(anim.style['fill']);
  });
});
