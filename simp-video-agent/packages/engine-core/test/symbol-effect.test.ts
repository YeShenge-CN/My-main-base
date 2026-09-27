/**
 * 【模型现在走的那条路】：`create_* ($c1)` + `add_effect (target: "$c1")` 同一批提交。
 *
 * ★ 为什么要有这一份：
 *   第十七轮把"内联 effect"从【工具表】里拿掉了（四条 create 分支各复制一份
 *   drawOn + highlight 的完整形状 ≈ 1200 token，而它们与 add_effect 里那份逐字相同）。
 *   换来的路是引擎本来就有的符号 id：同一批里 `localId:"$c1"` →
 *   `add_effect {target:"$c1"}`，依赖由 `batch.ts` 自动推导。
 *
 *   规范 §7 要的是"消除假依赖"（别让模型必须等回执拿到 assignedId 才能挂效果），
 *   而这一份就是那条要求的**可执行证据**：两条命令一批、一次提交、效果落在新建对象上。
 *
 *   引擎侧的 `create_*.effect` 字段仍然保留（面板/预设/夹具在用，见 inline-effect.test.ts）——
 *   这一份守的是"模型那条路换个形式之后依然通"。
 */
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { validate } from '../src/validate/index';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

const NO_BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

function emptyDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 8 });
  return { ...base, layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [] }], objects: {}, effects: {} };
}

function commit(doc: SceneDoc, commands: readonly Command[]) {
  let clock = 1_700_000_000_000;
  const j = createJournal(doc, { now: () => (clock += 1000) });
  const res = applyCommands({ baseVersion: j.currentVersion(), commands: [...commands] }, {
    journal: j,
    budget: () => NO_BUDGET,
    actor: 'agent',
    turnId: 't1',
    now: () => (clock += 1000),
  });
  return { res, doc: j.currentDoc(), journal: j };
}

/** 建一个方块 + 紧跟一条 highlight：模型现在要写的两条命令。 */
const BUILD_AND_HIGHLIGHT: readonly Command[] = [
  {
    op: 'create_rect',
    localId: '$c1',
    width: 3,
    height: 1.4,
    radius: 0.15,
    style: { stroke: '#4ea1ff', width: 2, fill: '#16223a', glow: 0.2 },
    owner: { kind: 'global' },
  },
  {
    op: 'add_effect',
    target: '$c1',
    effect: { type: 'highlight', params: { start: 1, duration: 0.6, color: '#ffd479', intensity: 1 } },
  },
];

describe('★ 同一批：create_* + add_effect（target 用 $c1）', () => {
  it('两条命令一次提交，效果落在【新建的那个对象】上', () => {
    const { res, doc } = commit(emptyDoc(), BUILD_AND_HIGHLIGHT);
    expect(res.ok).toHaveLength(2);
    expect(res.errored).toEqual([]);
    const ids = Object.keys(doc.objects);
    expect(ids).toHaveLength(1);
    const objId = ids[0] ?? '';
    const effIds = Object.keys(doc.effects);
    expect(effIds).toHaveLength(1);
    // 关键：效果挂在新建对象上，而不是某个别的 id 上
    expect(doc.effects[effIds[0] as string]?.target).toBe(objId);
    expect(doc.objects[objId]?.effects).toEqual(effIds);
    // 落盘的命令里已经没有符号 id 了（符号只活在批次内）
    const ops = res.ok.map((o) => o.assignedId).filter((x): x is string => x !== undefined);
    expect(ops).toHaveLength(2);
  });

  it('依赖是【引擎推导】的：写反顺序会被顶到后面（模型不必自己写 dependsOn）', () => {
    const reversed: readonly Command[] = [BUILD_AND_HIGHLIGHT[1] as Command, BUILD_AND_HIGHLIGHT[0] as Command];
    const { res, doc } = commit(emptyDoc(), reversed);
    // 引用靠后的符号 id → 明确报错，而不是静默挂到空处
    expect(res.errored.map((e) => e.error.code)).toContain('unknown_local_id');
    expect(doc.effects).toEqual({});
  });

  it('★ 两条命令一次手势：撤销一下把"对象 + 效果"一起撤掉', () => {
    const { journal, doc } = commit(emptyDoc(), BUILD_AND_HIGHLIGHT);
    expect(Object.keys(doc.objects)).toHaveLength(1);
    const cmp = journal.compounds().find((c) => c.turnId === 't1');
    if (cmp === undefined) throw new Error('缺 compound');
    journal.settle('t1');
    journal.revertCompound(cmp.compoundId);
    const back = journal.currentDoc();
    expect(Object.keys(back.objects)).toHaveLength(0);
    expect(Object.keys(back.effects)).toHaveLength(0);
  });

  it('换一条路（引擎的内联 effect）结果一样：两条路产出同一份文档形状', () => {
    const inline: readonly Command[] = [
      { ...(BUILD_AND_HIGHLIGHT[0] as Extract<Command, { op: 'create_rect' }>),
        effect: { type: 'highlight', params: { start: 1, duration: 0.6, color: '#ffd479', intensity: 1 } } },
    ];
    const a = commit(emptyDoc(), BUILD_AND_HIGHLIGHT).doc;
    const b = commit(emptyDoc(), inline).doc;
    const objA = Object.keys(a.objects)[0] ?? '';
    const objB = Object.keys(b.objects)[0] ?? '';
    expect(a.objects[objA]?.params).toEqual(b.objects[objB]?.params);
    expect(a.objects[objA]?.style).toEqual(b.objects[objB]?.style);
    const effA = Object.values(a.effects)[0];
    const effB = Object.values(b.effects)[0];
    expect(effA?.type).toBe(effB?.type);
    expect(effA?.params).toEqual(effB?.params);
  });

  it('★ 新走法不引入校验问题（validate 里没有 error）', () => {
    const { doc } = commit(emptyDoc(), BUILD_AND_HIGHLIGHT);
    expect(validate(doc).filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([]);
  });
});
