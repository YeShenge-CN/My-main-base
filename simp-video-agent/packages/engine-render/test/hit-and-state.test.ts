import { describe, expect, it } from 'vitest';
import { hitTest, hitTestAll } from '@sva/engine-render';
import { evaluate, type RenderState, type SceneDoc } from '@sva/engine-core';
import { resolveFieldState, resolveFieldStates } from '@sva/engine-core';
import { makeDoc, makeObject } from '../../engine-core/test/fixtures';

function doc(over: Partial<SceneDoc> = {}): SceneDoc {
  const base = makeDoc(0);
  const plot = makeObject('plot#1', 'plot2d', {
    params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 400 } },
  });
  return {
    ...base,
    meta: { ...base.meta, viewport: [320, 180] },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] }],
    objects: { 'plot#1': plot },
    effects: {},
    ...over,
  };
}

function stateOf(d: SceneDoc): RenderState {
  return evaluate(d, 0);
}

describe('命中测试（P9 第 6 条）', () => {
  it('曲线中段能被点中，宽容度内也能', () => {
    const s = stateOf(doc());
    const item = s.items[0];
    if (item === undefined || item.path === undefined) throw new Error('夹具没有 path');
    const mid = item.path[Math.floor(item.path.length / 2)];
    if (mid === undefined) throw new Error('没有中点');
    expect(hitTest(s, mid.x, mid.y)?.id).toBe('plot#1');
  });

  it('离曲线很远的地方点不中（4px 宽容度之外）', () => {
    const s = stateOf(doc());
    for (const d of [10, 40, 90]) {
      expect(hitTest(s, 160, 90 - 60 - d)?.id).toBeUndefined();
    }
  });

  it('宽容度可调，默认是 4px', () => {
    const s = stateOf(doc());
    const item = s.items[0];
    if (item === undefined || item.path === undefined) throw new Error('夹具没有 path');
    // 找一个明确在曲线上的点，然后沿法向偏移 6px
    const mid = item.path[Math.floor(item.path.length / 2)];
    if (mid === undefined) throw new Error('没有中点');
    const off = { x: mid.x, y: mid.y - 6 };
    expect(hitTest(s, off.x, off.y)).toBeNull();
    expect(hitTest(s, off.x, off.y, { tolerancePx: 8 })?.id).toBe('plot#1');
  });

  it('按绘制逆序命中：上层先中', () => {
    const d = doc();
    const t1 = makeObject('text#1', 'text', {
      params: { content: { v: '覆盖在曲线上' } },
      style: { size: { v: 20 }, fill: { v: '#fff' } },
    });
    const withText: SceneDoc = {
      ...d,
      layers: [
        { id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] },
        { id: 'annot', depth: 0.5, order: 2, parallax: 1, objects: ['text#1'] },
      ],
      objects: { ...d.objects, 'text#1': t1 },
    };
    const s = stateOf(withText);
    const textItem = s.items.find((i) => i.id === 'text#1');
    if (textItem === undefined) throw new Error('没有文字项');
    const cx = textItem.box.x + textItem.box.w / 2;
    const cy = textItem.box.y + textItem.box.h / 2;

    const stack = hitTestAll(s, cx, cy);
    // 文字在 annot 层（order 2），绘制在后 → 应当排在最前
    expect(stack[0]?.id).toBe('text#1');
  });

  it('隐藏项（visibleFraction=0）不参与命中', () => {
    const d = doc();
    // drawOn 还没开始 → 曲线不可见
    const hidden: SceneDoc = {
      ...d,
      effects: {
        'eff#1': {
          type: 'drawOn',
          target: 'plot#1',
          params: { start: { v: 5 }, duration: { v: 1 }, mode: { v: 'arc' } },
        },
      },
    };
    const s = stateOf(hidden);
    expect(s.items[0]?.visibleFraction).toBe(0);
    expect(hitTestAll(s, 160, 90)).toEqual([]);
  });
});

describe('三态可视（P9 第 3 条）', () => {
  const base = doc();

  it('没有动画也没有锁 → 静态值', () => {
    const st = resolveFieldState(base, 'plot#1.style.width');
    expect(st.state).toBe('static');
    expect(st.animationDriven).toBe(false);
    expect(st.locked).toBe(false);
  });

  it('有动画轨道 → 动画驱动', () => {
    const p1 = base.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺 plot#1');
    const animated: SceneDoc = {
      ...base,
      objects: {
        ...base.objects,
        'plot#1': { ...p1, anim: { 'style.width': { kind: 'expr', expr: 't' } } },
      },
    };
    const st = resolveFieldState(animated, 'plot#1.style.width');
    expect(st.state).toBe('animated');
    expect(st.animationDriven).toBe(true);
    expect(st.locked).toBe(false);
  });

  it('hard 锁（用户改过）与 soft 锁（AI 拥有）用不同状态区分', () => {
    const locked: SceneDoc = {
      ...base,
      locks: {
        'plot#1.style.width': { by: 'user', at: 1 },
        'plot#1.style.glow': { by: 'ai', at: 2 },
      },
    };
    const hard = resolveFieldState(locked, 'plot#1.style.width');
    expect(hard.state).toBe('locked-hard');
    expect(hard.lockClass).toBe('hard');
    expect(hard.lockedBy).toBe('user');

    const soft = resolveFieldState(locked, 'plot#1.style.glow');
    expect(soft.state).toBe('locked-soft');
    expect(soft.lockClass).toBe('soft');
    expect(soft.lockedBy).toBe('ai');
  });

  it('同时被动画驱动和锁定时，两个信息都保留（面板要画"蓝点 + 锁"）', () => {
    const p1 = base.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺 plot#1');
    const both: SceneDoc = {
      ...base,
      objects: {
        ...base.objects,
        'plot#1': { ...p1, anim: { 'style.width': { kind: 'expr', expr: 't' } } },
      },
      locks: { 'plot#1.style.width': { by: 'ai', at: 1 } },
    };
    const st = resolveFieldState(both, 'plot#1.style.width');
    expect(st.state).toBe('locked-soft'); // 主指示器锁定优先
    expect(st.animationDriven).toBe(true); // 但蓝点也要画
  });

  it('批量解析返回同一份结果', () => {
    const m = resolveFieldStates(base, ['plot#1.style.width', 'plot#1.tf.opacity']);
    expect(m.size).toBe(2);
    expect(m.get('plot#1.tf.opacity')?.state).toBe('static');
  });
});