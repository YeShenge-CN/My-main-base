/**
 * P2 动画原语：highlight（"现在看这一层"）。
 *
 * ★ 它解决的是科普视频最核心的手法。在此之前"强调某个元素"只能靠透明度闪一下 ——
 *   而透明度一变，元素会淡出，读起来是"它要消失了"，不是"它在被强调"。
 *
 * 这一份要钉住三件事：
 *   1. 高亮【烘进样式】—— 画笔不需要知道 highlight 的存在（一处解析）；
 *   2. 它能与 drawOn **共存**（一个方框可以先长出来、再被高亮）——
 *      这正是把"找到第一条效果就返回"重构成完整解析的原因；
 *   3. 文字的高亮走 `fill`（不是 stroke），否则"高亮一行标题"会毫无效果。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { mixColor, parseColor } from '../src/render/color';
import { applyCommand } from '../src/command/apply';
import { createJournal } from '../src/journal/store';
import { REGISTRY } from '../src/registry/fields';
import { generateObjectSchema } from '../src/registry/schema';
import type { Effect, SceneDoc, SceneObject } from '../src/doc/types';
import type { RenderItem } from '../src/render-state';
import { makeDoc, makeObject } from './fixtures';

/* ── 颜色工具 ───────────────────────────────────────────────── */

describe('mixColor：颜色插值（颜色渐变唯一的实现）', () => {
  it('k=0 原样返回起点（不做任何转换）', () => {
    expect(mixColor('#123456', '#ffffff', 0)).toBe('#123456');
  });

  it('k=1 得到终点色', () => {
    expect(mixColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('k=0.5 在中点', () => {
    expect(mixColor('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('支持 #rgb 简写与 #rrggbbaa', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
  });

  it('★ 起点解析不了时原样返回起点（不悄悄换成目标色）', () => {
    expect(mixColor('not-a-color', '#ffffff', 0.5)).toBe('not-a-color');
    expect(mixColor('#000000', 'garbage', 0.5)).toBe('#000000');
  });

  it('k 会被夹到 0..1', () => {
    expect(mixColor('#000000', '#ffffff', -3)).toBe('#000000');
    expect(mixColor('#000000', '#ffffff', 99)).toBe('#ffffff');
  });
});

/* ── 效果解析与样式烘焙 ───────────────────────────────────────── */

function rect(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' }, glow: { v: 0.2 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function highlightEffect(over: Partial<Effect> = {}): Effect {
  return {
    type: 'highlight',
    target: 'rect#1',
    params: { start: { v: 1 }, duration: { v: 1 }, color: { v: '#ffd479' }, intensity: { v: 1 } },
    ...over,
  };
}

function docWith(objects: Record<string, SceneObject>, effects: Record<string, Effect> = {}): SceneDoc {
  return {
    ...makeDoc(0, { duration: 6 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: Object.keys(objects) }],
    objects,
    effects,
    markers: [],
  };
}

function itemOf(doc: SceneDoc, id = 'rect#1', t = 0): RenderItem {
  const item = evaluate(doc, t).items.find((i) => i.id === id);
  if (item === undefined) throw new Error(id + ' 没被画出来');
  return item;
}

describe('highlight：渐入、保持、不自己退回', () => {
  const doc = docWith({ 'rect#1': rect({ effects: ['eff#1'] }) }, { 'eff#1': highlightEffect() });

  it('start 之前没有高亮（颜色是原色）', () => {
    expect(itemOf(doc, 'rect#1', 0.5).style?.stroke).toBe('#4ea1ff');
  });

  it('★ 时长中间是两个颜色的【中间色】（不是突变）', () => {
    const mid = itemOf(doc, 'rect#1', 1.5).style?.stroke ?? '';
    expect(mid).not.toBe('#4ea1ff');
    expect(mid).not.toBe('#ffd479');
    // 与手算的中间色一致（线性 ease 下 k=0.5）
    expect(mid).toBe(mixColor('#4ea1ff', '#ffd479', 0.5));
  });

  it('★ 结束之后【保持】高亮（不会自己退回）', () => {
    expect(itemOf(doc, 'rect#1', 5).style?.stroke).toBe('#ffd479');
  });

  it('★ 发光与线宽一起抬（只变色在暗背景上不够）', () => {
    const before = itemOf(doc, 'rect#1', 0.5).style;
    const after = itemOf(doc, 'rect#1', 5).style;
    expect(after?.glow ?? 0).toBeGreaterThan(before?.glow ?? 0);
    expect(after?.width ?? 0).toBeGreaterThan(before?.width ?? 0);
  });

  it('intensity=0 时等价于没有高亮', () => {
    const off = docWith(
      { 'rect#1': rect({ effects: ['eff#1'] }) },
      { 'eff#1': highlightEffect({ params: { start: { v: 1 }, duration: { v: 1 }, color: { v: '#ffd479' }, intensity: { v: 0 } } }) },
    );
    expect(itemOf(off, 'rect#1', 5).style?.stroke).toBe('#4ea1ff');
  });

  it('intensity>1 会过曝（继续朝高亮色推进）', () => {
    const strong = docWith(
      { 'rect#1': rect({ effects: ['eff#1'] }) },
      { 'eff#1': highlightEffect({ params: { start: { v: 1 }, duration: { v: 1 }, color: { v: '#ffd479' }, intensity: { v: 1.5 } } }) },
    );
    const mid = itemOf(strong, 'rect#1', 1.5).style?.stroke ?? '';
    // k = 0.5 × 1.5 = 0.75，比强度 1 时更接近高亮色
    expect(mid).toBe(mixColor('#4ea1ff', '#ffd479', 0.75));
  });

  it('durations 为 0 时是阶跃（不是"永远不生效"）', () => {
    const step = docWith(
      { 'rect#1': rect({ effects: ['eff#1'] }) },
      { 'eff#1': highlightEffect({ params: { start: { v: 2 }, duration: { v: 0 }, color: { v: '#ffd479' }, intensity: { v: 1 } } }) },
    );
    expect(itemOf(step, 'rect#1', 1.9).style?.stroke).toBe('#4ea1ff');
    expect(itemOf(step, 'rect#1', 2.1).style?.stroke).toBe('#ffd479');
  });
});

describe('★ highlight 与 drawOn 必须能共存', () => {
  it('同一对象上两种效果，各自生效（不是"第一条命中就返回"）', () => {
    const doc = docWith(
      { 'rect#1': rect({ effects: ['eff#draw', 'eff#hl'] }) },
      {
        'eff#draw': {
          type: 'drawOn',
          target: 'rect#1',
          params: { start: { v: 0 }, duration: { v: 4 }, mode: { v: 'arc' }, tip: { v: true } },
        },
        'eff#hl': highlightEffect({ params: { start: { v: 0 }, duration: { v: 1 }, color: { v: '#ffd479' }, intensity: { v: 1 } } }),
      },
    );
    const item = itemOf(doc, 'rect#1', 2);
    // drawOn 生效：几何只画了一部分
    expect(item.visibleFraction).toBeGreaterThan(0);
    expect(item.visibleFraction).toBeLessThan(1);
    // highlight 同时生效：颜色已经在高亮色上
    expect(item.style?.stroke).toBe('#ffd479');
  });
});

describe('文字的高亮走 fill（不是 stroke）', () => {
  const text = makeObject('text#1', 'text', {
    params: { content: { v: '标题' } },
    style: { size: { v: 28 }, fill: { v: '#e8eef8' } },
    effects: ['eff#1'],
  });
  const doc = docWith({ 'text#1': text }, {
    'eff#1': { ...highlightEffect(), target: 'text#1' },
  });

  it('★ 文字被高亮时 fill 变色（否则"高亮标题"毫无效果）', () => {
    expect(itemOf(doc, 'text#1', 0.2).style?.fill).toBe('#e8eef8');
    expect(itemOf(doc, 'text#1', 5).style?.fill).toBe('#ffd479');
  });

  it('文字项也带上了 style（以前它不设 style，高亮会丢）', () => {
    expect(itemOf(doc, 'text#1', 5).style).toBeDefined();
  });
});

/* ── registry 与命令 ─────────────────────────────────────────── */

describe('registry 登记与 set_highlight 命令', () => {
  it('effect.highlight.params 已登记，字段名正确', () => {
    const g = REGISTRY.groups.find((x) => x.id === 'effect.highlight.params');
    expect(g).toBeDefined();
    expect(Object.keys(g?.fields ?? {}).sort()).toEqual(['color', 'duration', 'intensity', 'start']);
  });

  it('工具 schema 能从 registry 生成（不缺字段）', () => {
    const g = REGISTRY.groups.find((x) => x.id === 'effect.highlight.params');
    if (g === undefined) throw new Error('缺分组');
    const schema = generateObjectSchema(g, { mode: 'all-nullable' });
    expect(Object.keys((schema['properties'] ?? {}) as Record<string, unknown>).sort()).toEqual([
      'color',
      'duration',
      'intensity',
      'start',
    ]);
  });

  function setup(doc: SceneDoc) {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  it('改颜色与强度并产出 patch', () => {
    const doc = docWith({ 'rect#1': rect({ effects: ['eff#1'] }) }, { 'eff#1': highlightEffect() });
    const r = applyCommand(doc, { op: 'set_highlight', target: 'eff#1', color: '#00ff88', intensity: 0.7 }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.patches.map((p) => p.path).sort()).toEqual(['eff#1.params.color', 'eff#1.params.intensity']);
  });

  it('★ 对 drawOn 效果用 set_highlight 会被拒（参数集不同）', () => {
    const doc = docWith({ 'rect#1': rect({ effects: ['eff#1'] }) }, {
      'eff#1': { type: 'drawOn', target: 'rect#1', params: { start: { v: 0 }, duration: { v: 1 } } },
    });
    const r = applyCommand(doc, { op: 'set_highlight', target: 'eff#1', color: '#fff' }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('invalid_argument');
  });

  it('撤销 set_highlight 能还原', () => {
    const doc = docWith({ 'rect#1': rect({ effects: ['eff#1'] }) }, { 'eff#1': highlightEffect() });
    const j = setup(doc);
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_highlight', target: 'eff#1', color: '#00ff88' } });
    j.settle('t1');
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    const params = j.currentDoc().effects['eff#1']?.params['color'];
    expect(params).toEqual({ v: '#ffd479' });
  });

  it('add_effect 加一条 highlight 能落地', () => {
    const doc = docWith({ 'rect#1': rect() });
    const j = setup(doc);
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'add_effect',
        target: 'rect#1',
        effect: { type: 'highlight', params: { start: 1, duration: 0.5, color: '#ffd479', intensity: 1 } },
      },
    });
    const ids = Object.keys(j.currentDoc().effects);
    expect(ids).toHaveLength(1);
    expect(j.currentDoc().effects[ids[0]!]?.type).toBe('highlight');
    expect(j.currentDoc().objects['rect#1']?.effects).toEqual(ids);
  });
});
