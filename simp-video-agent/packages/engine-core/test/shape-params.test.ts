/**
 * 形状 / 文字的【参数编辑命令】（§7 第 0.5 条）。
 *
 * ★ 这一条欠了很久：registry 里早就登记了 rect 的宽高、line 的两个端点、text 的内容，
 *   面板也早就把控件画出来了 —— 但**没有任何命令能改**，
 *   于是"拖了没反应、只说一句改不动"（§0.14 的同一个病，只是换了地方）。
 *
 * 三条纪律：
 *   1. **检查形状**：对 rect 发 set_line 必须当场被拒（三种形状参数集不同）；
 *   2. **可撤销**：set_line 的 from/to 是 vec2，补偿值是数组 ——
 *      invert 里拿 asNumber 去接会得到 undefined，撤销就**静默不动**（有断言钉着）；
 *   3. **真的改了画面**：结构字段对了不等于几何变了，末尾用 evaluate 的包围盒兜一下。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/command/apply';
import { createJournal } from '../src/journal/store';
import { evaluate } from '../src/evaluate';
import { validate } from '../src/validate/index';
import type { Command } from '../src/command/commands';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

function box(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 3 }, height: { v: 1.5 }, radius: { v: 0.1 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' }, fillOpacity: { v: 1 }, glow: { v: 0.2 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function arrow(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'line',
    owner: { kind: 'global' },
    params: { from: { v: [-2, 0] }, to: { v: [2, 0] }, head: { v: 'arrow' } },
    style: { stroke: { v: '#7fb2ff' }, width: { v: 2 }, headSize: { v: 16 }, glow: { v: 0 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function label(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'text',
    owner: { kind: 'global' },
    params: { content: { v: '标题' } },
    style: { size: { v: 32 }, fill: { v: '#e8eef8' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function docWith(objects: Record<string, SceneObject>): SceneDoc {
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: Object.keys(objects) }],
    objects,
    effects: {},
    markers: [],
  };
}

function setup(doc: SceneDoc) {
  let clock = 1_700_000_000_000;
  return createJournal(doc, { now: () => (clock += 1000) });
}

/* ── 三条命令各自的写入 ─────────────────────────────────────── */

describe('形状参数改得动', () => {
  it('set_rect：宽 / 高 / 圆角三条 patch 都落在 params 上', () => {
    const r = applyCommand(docWith({ 'rect#1': box() }), { op: 'set_rect', target: 'rect#1', width: 5, height: 2, radius: 0.3 }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.patches.map((p) => p.path).sort()).toEqual([
      'rect#1.params.height',
      'rect#1.params.radius',
      'rect#1.params.width',
    ]);
    expect(r.doc.objects['rect#1']?.params['width']).toEqual({ v: 5 });
  });

  it('set_line：端点（vec2）与端点样式', () => {
    const r = applyCommand(docWith({ 'line#1': arrow() }), { op: 'set_line', target: 'line#1', from: [-1, 1], to: [3, -1], head: 'none' }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.doc.objects['line#1']?.params['from']).toEqual({ v: [-1, 1] });
    expect(r.doc.objects['line#1']?.params['to']).toEqual({ v: [3, -1] });
    expect(r.doc.objects['line#1']?.params['head']).toEqual({ v: 'none' });
  });

  it('set_text：内容', () => {
    const r = applyCommand(docWith({ 'text#1': label() }), { op: 'set_text', target: 'text#1', content: '新的标题' }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.doc.objects['text#1']?.params['content']).toEqual({ v: '新的标题' });
  });

  it('★ set_style 补的四个字段也写进去了（面板上它们此前一直是死的）', () => {
    const r = applyCommand(
      docWith({ 'rect#1': box() }),
      { op: 'set_style', target: 'rect#1', fill: '#ff0000', fillOpacity: 0.4, headSize: 20, size: 40 },
      {},
    );
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.doc.objects['rect#1']?.style['fill']).toEqual({ v: '#ff0000' });
    expect(r.doc.objects['rect#1']?.style['fillOpacity']).toEqual({ v: 0.4 });
    // headSize / size 不属于 rect，但 set_style 是"按名字写"的：写进去不报错，
    // 由 registry 的字段集与校验器负责说明（见下面那条断言）。
    expect(r.doc.objects['rect#1']?.style['headSize']).toEqual({ v: 20 });
    expect(r.doc.objects['rect#1']?.style['size']).toEqual({ v: 40 });
  });
});

/* ── 形状检查 ───────────────────────────────────────────────── */

describe('★ 形状不对就当场拒（不是"写进去就算了"）', () => {
  it('对 rect 发 set_line / set_text → invalid_argument', () => {
    const doc = docWith({ 'rect#1': box() });
    const a = applyCommand(doc, { op: 'set_line', target: 'rect#1', head: 'none' }, {});
    const b = applyCommand(doc, { op: 'set_text', target: 'rect#1', content: 'x' }, {});
    expect(a.kind).toBe('failed');
    expect(b.kind).toBe('failed');
    if (a.kind === 'failed') expect(a.error.code).toBe('invalid_argument');
    if (b.kind === 'failed') expect(b.error.code).toBe('invalid_argument');
  });

  it('对 line 发 set_rect 同样被拒', () => {
    const r = applyCommand(docWith({ 'line#1': arrow() }), { op: 'set_rect', target: 'line#1', width: 3 }, {});
    expect(r.kind).toBe('failed');
  });

  it('对象不存在 → unknown_target', () => {
    const r = applyCommand(docWith({ 'rect#1': box() }), { op: 'set_rect', target: 'rect#9', width: 3 }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('unknown_target');
  });
});

/* ── 撤销（vec2 那一支最容易静默失败）───────────────────────── */

describe('★ 撤销：包括 vec2', () => {
  it('set_rect 撤销后宽高圆角全回来', () => {
    const j = setup(docWith({ 'rect#1': box() }));
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_rect', target: 'rect#1', width: 5, height: 2, radius: 0.3 } });
    j.settle('t1');
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    const params = j.currentDoc().objects['rect#1']?.params;
    expect(params?.['width']).toEqual({ v: 3 });
    expect(params?.['height']).toEqual({ v: 1.5 });
    expect(params?.['radius']).toEqual({ v: 0.1 });
  });

  it('★ set_line 撤销：from / to 必须真的回到原值（asNumber 接数组会静默不动）', () => {
    const j = setup(docWith({ 'line#1': arrow() }));
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_line', target: 'line#1', from: [-1, 1], to: [3, -1] } });
    j.settle('t1');
    expect(j.currentDoc().objects['line#1']?.params['from']).toEqual({ v: [-1, 1] });
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    const params = j.currentDoc().objects['line#1']?.params;
    expect(params?.['from']).toEqual({ v: [-2, 0] });
    expect(params?.['to']).toEqual({ v: [2, 0] });
  });

  it('set_style 的新字段也能撤销（fill / size）', () => {
    const j = setup(docWith({ 'rect#1': box() }));
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_style', target: 'rect#1', fill: '#ff0000', size: 40 } });
    j.settle('t1');
    expect(j.currentDoc().objects['rect#1']?.style['fill']).toEqual({ v: '#ff0000' });
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    expect(j.currentDoc().objects['rect#1']?.style['fill']).toEqual({ v: '#16223a' });
  });
});

/* ── 画面真的变了（不只是字段对了）─────────────────────────── */

describe('★ 结构对了还要画面真的变', () => {
  function boxOf(doc: SceneDoc, id: string): { w: number; h: number } {
    const item = evaluate(doc, 1).items.find((i) => i.id === id);
    return { w: item?.box.w ?? 0, h: item?.box.h ?? 0 };
  }

  it('rect 宽度 3 → 5，屏幕包围盒真的变宽（按同样的世界→像素比例）', () => {
    const before = docWith({ 'rect#1': box() });
    const r = applyCommand(before, { op: 'set_rect', target: 'rect#1', width: 5 }, {});
    if (r.kind !== 'applied') throw new Error('没应用');
    const a = boxOf(before, 'rect#1');
    const b = boxOf(r.doc, 'rect#1');
    expect(b.w).toBeGreaterThan(a.w);
    expect(b.w / a.w).toBeCloseTo(5 / 3, 1);
  });

  it('text 内容改掉之后，画面上的文字跟着换', () => {
    const before = docWith({ 'text#1': label() });
    const r = applyCommand(before, { op: 'set_text', target: 'text#1', content: '换了一行更长的标题' }, {});
    if (r.kind !== 'applied') throw new Error('没应用');
    const text = evaluate(r.doc, 1).items.find((i) => i.id === 'text#1')?.text?.content;
    expect(text).toBe('换了一行更长的标题');
  });

  it('line 端点改掉之后，路径的包围盒跟着变', () => {
    const before = docWith({ 'line#1': arrow() });
    const r = applyCommand(before, { op: 'set_line', target: 'line#1', to: [5, 0] }, {});
    if (r.kind !== 'applied') throw new Error('没应用');
    const w = (d: SceneDoc): number => evaluate(d, 1).items.find((i) => i.id === 'line#1')?.box.w ?? 0;
    expect(w(r.doc)).toBeGreaterThan(w(before));
  });
});

/* ── 与 set_motion 的关系 ───────────────────────────────────── */

describe('几何字段不可被动画驱动（与既有口径一致）', () => {
  it('★ params.* 仍然不可动画：给 rect.params.width 加轨道，校验器报 anim_track_unsupported', () => {
    // 这一条把新加的几何编辑命令钉回规范 §5 的分界上：几何要改就发 set_rect（一次重算），
    // 不能逐帧驱动 —— 逐帧改几何意味着逐帧重采样，与铁律 6 冲突。
    const doc = docWith({
      'rect#1': box({ anim: { 'params.width': { kind: 'keys', keys: [{ t: 0, v: 3 }, { t: 2, v: 6 }] } } }),
    });
    const codes = validate(doc).map((i) => i.code);
    expect(codes).toContain('anim_track_unsupported');
    // 而且几何确实没被轨道改掉：包围盒还是 width=3 那个
    const item = evaluate(doc, 1).items.find((i) => i.id === 'rect#1');
    const three = evaluate(docWith({ 'rect#1': box() }), 1).items.find((i) => i.id === 'rect#1');
    expect(item?.box.w).toBeCloseTo(three?.box.w ?? 0, 6);
  });
});

/* ── 命令类型层 ─────────────────────────────────────────────── */

describe('命令类型（编译期就挡住的那些）', () => {
  it('三条命令都在 Command 联合里（构造得出来就说明在）', () => {
    const cmds: Command[] = [
      { op: 'set_rect', target: 'rect#1', width: 4 },
      { op: 'set_line', target: 'line#1', from: [0, 0] },
      { op: 'set_text', target: 'text#1', content: 'x' },
    ];
    expect(cmds.map((c) => c.op)).toEqual(['set_rect', 'set_line', 'set_text']);
  });
});
