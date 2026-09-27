import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { allocateId } from '../src/command/apply';
import { REGISTRY } from '../src/registry/fields';
import { fieldValues } from '../src/doc/fields';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * create_object —— 通用建对象。
 *
 * 存在的理由：create_plot 是此前唯一能建对象的命令，于是"一行文本标题"
 * 在文档里根本无法从零产生（只能靠夹具预置）。压力测试里所有带标题的任务
 * 都指望着预置的 text 对象，而夹具一旦没有，用户就会看到"Agent 建不了文字"。
 */

function emptyDoc(): SceneDoc {
  const base = makeDoc(0);
  return { ...base, layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [] }], objects: {}, effects: {} };
}

const BUDGET = () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 });

function clock(): () => number {
  let c = 1_700_000_000_000;
  return () => (c += 1000);
}

function run(commands: readonly Command[]): { doc: SceneDoc; assigned: readonly (string | undefined)[] } {
  const journal = createJournal(emptyDoc(), { now: clock() });
  const res = applyCommands({ baseVersion: 0, commands }, {
    journal,
    budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
    actor: 'user',
    now: clock(),
  });
  expect(res.errored).toEqual([]);
  return { doc: journal.currentDoc(), assigned: res.ok.map((o) => o.assignedId) };
}

const createText: Command = {
  op: 'create_object',
  localId: '$t1',
  shape: 'text',
  params: { content: '正弦曲线' },
  style: { size: 32, fill: '#e8eef8' },
  owner: { kind: 'global' },
};

describe('create_object：从零建一个非 plot 对象', () => {
  it('建出 text 对象，字段按 params/style 分开落地', () => {
    const { doc, assigned } = run([createText]);
    expect(assigned).toEqual(['text#1']);
    const obj = doc.objects['text#1'];
    expect(obj?.shape).toBe('text');
    expect(fieldValues(obj?.params ?? {})['content']).toBe('正弦曲线');
    expect(fieldValues(obj?.style ?? {})['size']).toBe(32);
    // 没给的字段不凭空出现
    expect(Object.keys(obj?.params ?? {})).toEqual(['content']);
  });

  it('自动挂进第一个图层（否则对象永远不会被绘制）', () => {
    const { doc } = run([createText]);
    expect(doc.layers[0]?.objects).toEqual(['text#1']);
  });

  it('id 前缀由 shape 推导，且剔掉会把点分路径搞坏的字符', () => {
    /**
     * ★ 这条测试原来用的是 `shape: 'my.shape'` —— 一个**没有登记**的 shape。
     *   它当时能通过，恰恰暴露了"引擎会照单全收任何 shape"这个洞。
     *   现在未登记的 shape 会被 unsupported_shape 拒掉（见 field-in-shape.test.ts），
     *   所以要验证前缀清洗，得把那个带点的 shape **真的登记进 registry**
     *   （用一个只属于本测试的 registry，不污染全局登记表）。
     */
    const registry = {
      groups: [
        ...REGISTRY.groups,
        {
          id: 'shape.my.shape.params',
          kind: 'shape' as const,
          owner: 'my.shape',
          section: 'params' as const,
          label: '测试用 shape',
          pathTemplate: 'objects.*.params',
          fields: { content: { type: 'string' as const, label: '文字', default: '' } },
        },
        {
          // style 分组也要登记：createText 夹具带着 style，
          // 而字段名校验是按分组查的（少了它就会报 field_not_in_shape）
          id: 'shape.my.shape.style',
          kind: 'shape' as const,
          owner: 'my.shape',
          section: 'style' as const,
          label: '测试用样式',
          pathTemplate: 'objects.*.style',
          fields: {
            size: { type: 'number' as const, label: '字号', default: 20, bounds: { kind: 'unbounded' as const } },
            fill: { type: 'color' as const, label: '颜色', default: '#ffffff' },
          },
        },
      ],
    };
    const journal = createJournal(emptyDoc(), { now: clock() });
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [{ ...createText, shape: 'my.shape', localId: '$x1' }],
      },
      { journal, budget: BUDGET, actor: 'user', now: clock(), registry } as never,
    );
    expect(res.errored).toEqual([]);
    expect(res.ok.map((o) => o.assignedId)).toEqual(['myshape#1']);
    // 契约：id 里不允许出现 '.'（按 '.' 切路径是安全的）
    for (const id of Object.keys(journal.currentDoc().objects)) expect(id).not.toContain('.');
  });

  it('与 create_plot 共用同一个 id 分配器（不重号）', () => {
    const { doc, assigned } = run([
      { op: 'create_plot', localId: '$p1', expr: 'sin(x)', domain: [-7, 7], owner: { kind: 'global' } },
      { ...createText, localId: '$t1' },
      { ...createText, localId: '$t2' },
    ]);
    expect(assigned).toEqual(['plot#1', 'text#1', 'text#2']);
    expect(Object.keys(doc.objects).sort()).toEqual(['plot#1', 'text#1', 'text#2']);
  });

  it('可以内联效果（和 create_plot 一样），效果指向新对象', () => {
    const { doc, assigned } = run([
      { ...createText, effect: { type: 'drawOn', params: { start: 0, duration: 2, mode: 'arc', tip: false } } },
    ]);
    expect(assigned?.[0]).toBe('text#1');
    const eff = doc.effects['eff#1'];
    expect(eff?.target).toBe('text#1');
    expect(fieldValues(eff?.params ?? {})['duration']).toBe(2);
    expect(doc.objects['text#1']?.effects).toEqual(['eff#1']);
  });

  it('null 值的字段会被跳过（strict schema 用 null 表达"这一项不改"）', () => {
    // 注意：这里传的是【已登记】字段 content = null。
    // 未登记的键现在会被 field_not_in_shape 拒掉（见 field-in-shape.test.ts），
    // 所以"跳过 null"这件事只能用合法字段来验。
    const { doc } = run([{ ...createText, params: { content: null } }]);
    expect(Object.keys(doc.objects['text#1']?.params ?? {})).toEqual([]);
  });

  it('删除它可以撤销这一次创建（create_object 是可逆的）', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    applyCommands({ baseVersion: 0, commands: [createText] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const compoundId = journal.compounds()[0]?.compoundId;
    if (compoundId === undefined) throw new Error('缺 compound');
    journal.settleCompound(compoundId);
    const r = journal.revertCompound(compoundId);
    expect(r.kind).toBe('reverted');
    expect(Object.keys(journal.currentDoc().objects)).toEqual([]);
    expect(journal.currentDoc().layers[0]?.objects).toEqual([]);
  });
});

describe('allocateId', () => {
  it('取同前缀最大序号 +1，与文档现状一致（禁随机、禁时间戳）', () => {
    expect(allocateId([], 'plot')).toBe('plot#1');
    expect(allocateId(['plot#1', 'plot#2'], 'plot')).toBe('plot#3');
    expect(allocateId(['plot#2', 'plot#9', 'text#4'], 'plot')).toBe('plot#10');
    // 别的前缀不干扰
    expect(allocateId(['eff#7'], 'plot')).toBe('plot#1');
  });
});
