/**
 * 分组（`parent`）：一次移动 / 旋转一组东西。
 *
 * ★ 它不是"一个叫 group 的 shape"，而是对象上的父子关系 —— 只影响一件事：
 *   **变换链**。所以这里要验的也就是那一件事：
 *     父级移动 → 子级跟着动；父级旋转 → 子级绕父级转；父级缩放 → 子级跟着缩。
 *   以及三条边界：自引用、成环被【写入时】拒掉、坏文档（悬空/环）不会让求值挂掉。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { applyCommand } from '../src/command/apply';
import { createJournal } from '../src/journal/store';
import { validateEnvironment } from '../src/validate/validators';
import { REGISTRY } from '../src/registry/fields';
import type { RenderItem } from '../src/render-state';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject } from './fixtures';

/** 一个方框，方便用世界坐标算它的屏幕位置。 */
function rectObject(id: string, x: number, y: number, parent?: string): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x, y, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...(parent === undefined ? {} : { parent }),
  };
}

function groupDoc(objects: Record<string, SceneObject>): SceneDoc {
  return {
    ...makeDoc(0, { duration: 4 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: Object.keys(objects) }],
    objects,
    effects: {},
    markers: [],
  };
}

function itemOf(doc: SceneDoc, id: string, t = 0): RenderItem {
  const item = evaluate(doc, t).items.find((i) => i.id === id);
  if (item === undefined) throw new Error(id + ' 没被画出来');
  return item;
}

/** 一个对象的屏幕中心（包围盒中心）。 */
function centerOf(item: RenderItem): { readonly x: number; readonly y: number } {
  return { x: item.box.x + item.box.w / 2, y: item.box.y + item.box.h / 2 };
}

describe('分组：父级移动，子级跟着动', () => {
  it('★ 子级的屏幕位置 = 父级位移 + 自己的位移（世界单位，1 单位 = base 像素）', () => {
    // viewport 1920×1080 / world 16×9 → base = 120
    const alone = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0) });
    const grouped = groupDoc({
      'rect#1': rectObject('rect#1', 1, 0, 'rect#0'),
      'rect#0': rectObject('rect#0', 3, 2),
    });

    const solo = centerOf(itemOf(alone, 'rect#1'));
    const child = centerOf(itemOf(grouped, 'rect#1'));
    expect(child.x - solo.x).toBeCloseTo(3 * 120, 6);
    // y 轴向上：世界 +2 → 屏幕向上（y 变小）
    expect(child.y - solo.y).toBeCloseTo(-2 * 120, 6);
  });

  it('★ 父级旋转时，子级绕【父级原点】转（不是绕自己）', () => {
    const doc = groupDoc({
      'rect#1': rectObject('rect#1', 2, 0, 'rect#0'),
      'rect#0': {
        ...rectObject('rect#0', 0, 0),
        // 绕原点转 90°（y 轴向上 → 逆时针）
        tf: { x: 0, y: 0, rotate: Math.PI / 2, sx: 1, sy: 1, opacity: 1 },
      },
    });
    const c = centerOf(itemOf(doc, 'rect#1'));
    // 子级原本在世界 (2,0) → 转 90° 后应到 (0,2)
    // 屏幕：视口中心 (960,540)，base 120 → x=960, y=540-240=300
    expect(c.x).toBeCloseTo(960, 4);
    expect(c.y).toBeCloseTo(300, 4);
  });

  it('★ 父级缩放时子级跟着缩（且子级自己的尺寸也变）', () => {
    const plain = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0) });
    const scaled = groupDoc({
      'rect#1': rectObject('rect#1', 1, 0, 'rect#0'),
      'rect#0': {
        ...rectObject('rect#0', 0, 0),
        tf: { x: 0, y: 0, rotate: 0, sx: 2, sy: 2, opacity: 1 },
      },
    });
    const a = itemOf(plain, 'rect#1');
    const b = itemOf(scaled, 'rect#1');
    expect(b.box.w).toBeCloseTo(a.box.w * 2, 4);
    expect(b.box.h).toBeCloseTo(a.box.h * 2, 4);
    // 中心也从 1 单位外挪到 2 单位外
    expect(centerOf(b).x - 960).toBeCloseTo(2 * 120, 4);
  });

  it('孙子也跟着（链式继承，不是只继承一层）', () => {
    const doc = groupDoc({
      'rect#1': rectObject('rect#1', 0, 0, 'rect#2'),
      'rect#2': rectObject('rect#2', 1, 0, 'rect#3'),
      'rect#3': rectObject('rect#3', 1, 0),
    });
    const c = centerOf(itemOf(doc, 'rect#1'));
    // 1 + 1 + 0 = 2 世界单位
    expect(c.x - 960).toBeCloseTo(2 * 120, 4);
  });

  it('文字锚点同样继承（分组里的标题会跟着组走）', () => {
    const text = makeObject('text#1', 'text', {
      params: { content: { v: '组里的标题' } },
      style: { size: { v: 20 }, fill: { v: '#fff' } },
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      parent: 'rect#0',
    });
    const doc = groupDoc({ 'text#1': text, 'rect#0': rectObject('rect#0', 2, 1) });
    const anchor = itemOf(doc, 'text#1').text?.anchor;
    expect(anchor?.x).toBeCloseTo(960 + 2 * 120, 4);
    expect(anchor?.y).toBeCloseTo(540 - 1 * 120, 4);
  });

  it('父级自己的形状照样画（分组对象同时是普通对象）', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0, 'rect#0'), 'rect#0': rectObject('rect#0', 0, 0) });
    expect(evaluate(doc, 0).items.map((i) => i.id).sort()).toEqual(['rect#0', 'rect#1']);
  });
});

describe('分组的边界：坏文档不许把求值搞挂', () => {
  it('★ 悬空父级：当成顶层对象，不抛异常', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0, 'nope#9') });
    const c = centerOf(itemOf(doc, 'rect#1'));
    expect(c.x - 960).toBeCloseTo(1 * 120, 4);
  });

  it('★ 环（a→b→a）：求值必须终止，不许死循环', () => {
    const doc = groupDoc({
      'rect#1': rectObject('rect#1', 1, 0, 'rect#2'),
      'rect#2': rectObject('rect#2', 1, 0, 'rect#1'),
    });
    // 只要能在合理时间内返回就说明有截断
    const items = evaluate(doc, 0).items;
    expect(items.length).toBe(2);
  });

  it('★ 自引用也不挂', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0, 'rect#1') });
    expect(evaluate(doc, 0).items).toHaveLength(1);
  });
});

describe('set_parent 命令与校验器', () => {
  function setup(doc: SceneDoc) {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  it('设置父子关系并产出 patch（逆操作靠它还原）', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0), 'rect#0': rectObject('rect#0', 0, 0) });
    const r = applyCommand(doc, { op: 'set_parent', target: 'rect#1', parent: 'rect#0' }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.doc.objects['rect#1']?.parent).toBe('rect#0');
    const p = r.patches.find((x) => x.path === 'rect#1.parent');
    expect(p?.after).toBe('rect#0');
    expect(p?.before).toBeUndefined();
  });

  it('parent: null 脱离分组', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0, 'rect#0'), 'rect#0': rectObject('rect#0', 0, 0) });
    const r = applyCommand(doc, { op: 'set_parent', target: 'rect#1', parent: null }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.doc.objects['rect#1']?.parent).toBeUndefined();
  });

  it('★ 自引用在【写入时】就被拒（不是留给校验器）', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0) });
    const r = applyCommand(doc, { op: 'set_parent', target: 'rect#1', parent: 'rect#1' }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('invalid_argument');
  });

  it('★ 成环在写入时被拒（否则撤销历史里会留下坏中间态）', () => {
    const doc = groupDoc({
      'rect#1': rectObject('rect#1', 1, 0, 'rect#2'),
      'rect#2': rectObject('rect#2', 1, 0),
    });
    const r = applyCommand(doc, { op: 'set_parent', target: 'rect#2', parent: 'rect#1' }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.message).toContain('成环');
  });

  it('父对象不存在时报 unknown_target', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0) });
    const r = applyCommand(doc, { op: 'set_parent', target: 'rect#1', parent: 'nope' }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('unknown_target');
  });

  it('校验器：悬空父级报 parent_missing（auto，可直接摘掉引用）', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0, 'nope#9') });
    const issues = validateEnvironment(doc).filter((i) => i.code === 'parent_missing');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fixClass).toBe('auto');
    expect(issues[0]?.suggestedFix?.[0]?.op).toBe('set_parent');
  });

  it('校验器：成环报 parent_cycle（human —— 解开它涉及意图）', () => {
    const doc = groupDoc({
      'rect#1': rectObject('rect#1', 1, 0, 'rect#2'),
      'rect#2': rectObject('rect#2', 1, 0, 'rect#1'),
    });
    const issues = validateEnvironment(doc).filter((i) => i.code === 'parent_cycle');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.fixClass).toBe('human');
  });

  it('registry 登记了 object.parent（面板才画得出这个控件）', () => {
    const g = REGISTRY.groups.find((x) => x.id === 'object.parent');
    expect(g).toBeDefined();
    expect(Object.keys(g?.fields ?? {})).toEqual(['parent']);
  });

  it('撤销 set_parent 能还原（逆操作已接上）', () => {
    const doc = groupDoc({ 'rect#1': rectObject('rect#1', 1, 0), 'rect#0': rectObject('rect#0', 0, 0) });
    const j = setup(doc);
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_parent', target: 'rect#1', parent: 'rect#0' } });
    expect(j.currentDoc().objects['rect#1']?.parent).toBe('rect#0');
    j.settle('t1');
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(c.compoundId);
    expect(r.kind).toBe('reverted');
    expect(j.currentDoc().objects['rect#1']?.parent).toBeUndefined();
  });
});
