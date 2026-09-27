import { describe, expect, it } from 'vitest';
import { createJournal, describeCommand, type Journal } from '../src/journal/store';
import { fieldValues } from '../src/doc/fields';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * Journal 的时钟由宿主注入（engine-core 禁止读时钟）。
 * 这里用一个单调计数器，保证测试本身也是确定性的。
 */
function setup(doc: SceneDoc = makeDoc(2)): Journal {
  let clock = 1_700_000_000_000;
  return createJournal(doc, { now: () => (clock += 1000) });
}

function field(doc: SceneDoc, id: string, zone: 'style' | 'params', key: string): unknown {
  const obj = doc.objects[id];
  if (obj === undefined) return undefined;
  return fieldValues(zone === 'style' ? obj.style : obj.params)[key];
}

function agentCompound(journal: Journal, turnId: string) {
  return journal.compounds().find((c) => c.turnId === turnId && c.actor === 'agent');
}

describe('Journal：append-only 与 intent', () => {
  it('每次提交追加一条操作，版本单调递增', () => {
    const j = setup();
    expect(j.currentVersion()).toBe(0);
    const a = j.commit({ actor: 'agent', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    const b = j.commit({
      actor: 'agent',
      command: { op: 'set_transform', target: 'plot#1', opacity: 0.5 },
    });
    expect(a.kind).toBe('committed');
    expect(b.kind).toBe('committed');
    expect(j.currentVersion()).toBe(2);
    expect(j.operations().map((o) => o.resultVersion)).toEqual([1, 2]);
    expect(j.operations().map((o) => o.baseVersion)).toEqual([0, 1]);
  });

  it('intent 原样存进 Operation，面板可以直接展示"AI 为什么改这个"', () => {
    const j = setup();
    j.commit({
      actor: 'agent',
      turnId: 't1',
      intent: '把曲线加粗，让投影仪上看得清',
      command: { op: 'set_style', target: 'plot#1', width: 5 },
    });
    expect(j.operations()[0]?.intent).toBe('把曲线加粗，让投影仪上看得清');
  });

  it('操作记录 before/after，因此不需要 replay 就能回答"改了什么"', () => {
    const j = setup();
    const r = j.commit({ actor: 'agent', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    if (r.kind !== 'committed') throw new Error('未提交');
    expect(r.operation.patches).toEqual([
      { path: 'plot#1.style.width', before: 3, after: 5 },
    ]);
    expect(r.operation.affectedPaths).toEqual(['plot#1.style.width']);
  });

  it('a 命令失败时不追加任何操作，版本不动', () => {
    const j = setup();
    const r = j.commit({ actor: 'agent', command: { op: 'set_style', target: 'ghost#1', width: 5 } });
    expect(r.kind).toBe('failed');
    expect(j.operations().length).toBe(0);
    expect(j.currentVersion()).toBe(0);
  });
});

describe('Journal：四个接口', () => {
  it('get_journal：按版本区间 / actor / compound 过滤', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'user', gestureId: 'g1', command: { op: 'set_style', target: 'plot#1', stroke: '#f00' } });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_transform', target: 'plot#1', opacity: 0.5 } });

    expect(j.query().length).toBe(3);
    expect(j.query({ actor: 'user' }).length).toBe(1);
    expect(j.query({ from: 2, to: 3 }).length).toBe(2);
    const c = agentCompound(j, 't1');
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(j.query({ compoundId: c.compoundId }).length).toBe(2);
  });

  it('get_operations_affecting：既按 affectedPaths 也按 patches 匹配，且支持前缀', () => {
    const j = setup();
    j.commit({ actor: 'agent', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'agent', command: { op: 'set_style', target: 'plot#1', glow: 0.9 } });
    j.commit({ actor: 'agent', command: { op: 'set_transform', target: 'plot#1', opacity: 0.2 } });

    expect(j.operationsAffecting('plot#1.style.width').length).toBe(1);
    expect(j.operationsAffecting('plot#1.style.glow').length).toBe(1);
    // 前缀匹配到整个 style 子树
    expect(j.operationsAffecting('plot#1.style').length).toBe(2);
    expect(j.operationsAffecting('plot#1').length).toBe(3);
    expect(j.operationsAffecting('plot#2').length).toBe(0);
  });

  it('replay：从某个版本的快照重放出目标文档', () => {
    const j = setup();
    j.commit({ actor: 'agent', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'user', command: { op: 'set_transform', target: 'plot#1', opacity: 0.25 } });

    const full = j.replay(0, j.currentVersion());
    expect(full.doc).not.toBeNull();
    expect(field(full.doc as SceneDoc, 'plot#1', 'style', 'width')).toBe(5);
    expect((full.doc as SceneDoc).objects['plot#1']?.tf.opacity).toBe(0.25);
    expect(full.operations.length).toBe(2);

    const midway = j.replay(0, 1);
    expect(field(midway.doc as SceneDoc, 'plot#1', 'style', 'width')).toBe(5);
    expect((midway.doc as SceneDoc).objects['plot#1']?.tf.opacity).toBe(1);
  });

  it('replay：缺起始快照时返回 null，而不是猜一份文档出来', () => {
    const j = setup();
    expect(j.replay(99, 100).doc).toBeNull();
  });

  it('describeCommand 给出一句话摘要', () => {
    expect(describeCommand({ op: 'set_style', target: 'plot#1', width: 5 })).toBe('set_style plot#1');
    expect(describeCommand({ op: 'camera_preset', preset: 'pushIn', duration: 3 })).toBe(
      'camera_preset pushIn',
    );
  });
});

describe('P5 验收 2：同一轮内用户和 AI 交替，compound 边界正确', () => {
  it('同 turnId 下 actor 不同 → 是两个 compound，各装各自的操作', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_style', target: 'plot#1', glow: 0.9 } });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 9 } });
    j.settle('t1');

    const cs = j.compounds();
    expect(cs.length).toBe(2);
    const ai = cs.find((c) => c.actor === 'agent');
    const user = cs.find((c) => c.actor === 'user');
    expect(ai).toBeDefined();
    expect(user).toBeDefined();
    if (ai === undefined || user === undefined) return;

    expect(ai.opIds.length).toBe(2);
    expect(user.opIds.length).toBe(1);
    // 用户那条绝不在 AI 的 compound 里 —— 这就是"边界正确"
    expect(ai.opIds).not.toContain(user.opIds[0]);
    expect(ai.turnId).toBe('t1');
    expect(ai.settled).toBe(true);
  });

  it('撤回 AI 的 compound，用户的改动原样保留', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_style', target: 'plot#1', glow: 0.9 } });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 9 } });
    j.settle('t1');

    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);

    expect(r.kind).toBe('reverted');
    expect(r.skipped).toEqual([]);
    expect(field(j.currentDoc(), 'plot#1', 'style', 'width')).toBe(3);
    expect(field(j.currentDoc(), 'plot#1', 'style', 'glow')).toBe(0.9);
  });
});

describe('P5 验收 1：整体回滚一轮 AI 操作，不伤用户在本轮之外的改动', () => {
  it('AI 一轮的两条改动都回退，用户轮外那条不受影响', () => {
    const j = setup();
    j.commit({
      actor: 'agent',
      turnId: 'turn-7',
      intent: '把曲线加粗并压暗',
      command: { op: 'set_style', target: 'plot#1', width: 5 },
    });
    j.commit({
      actor: 'agent',
      turnId: 'turn-7',
      command: { op: 'set_transform', target: 'plot#1', opacity: 0.4 },
    });
    j.settle('turn-7');

    // 用户在 AI 这一轮【之外】改了描边颜色
    j.commit({
      actor: 'user',
      gestureId: 'gesture-1',
      command: { op: 'set_style', target: 'plot#1', stroke: '#ff0000' },
    });

    const ai = agentCompound(j, 'turn-7');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);

    expect(r.kind).toBe('reverted');
    expect(r.reverted.length).toBe(2);
    expect(r.skipped).toEqual([]);

    const doc = j.currentDoc();
    expect(field(doc, 'plot#1', 'style', 'width')).toBe(3);
    expect(doc.objects['plot#1']?.tf.opacity).toBe(1);
    // 用户的改动必须还在
    expect(field(doc, 'plot#1', 'style', 'stroke')).toBe('#ff0000');
  });

  it('撤销是【追加补偿操作】，不是删历史：原操作仍在日志里，可被追问', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.settle('t1');
    const before = j.operations().length;
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');

    const r = j.revertCompound(ai.compoundId);
    expect(r.kind).toBe('reverted');
    // 历史只增不减
    expect(j.operations().length).toBeGreaterThan(before);
    expect(j.operations().some((o) => o.actor === 'agent')).toBe(true);
    // 补偿操作挂在 revert 自己的 compound 下，并标出"撤的是谁"
    expect(r.revertCompoundId).toBeDefined();
    const rc = r.revertCompoundId === undefined ? undefined : j.compound(r.revertCompoundId);
    expect(rc?.revertOf).toBe(ai.compoundId);
    expect(rc?.settled).toBe(true);
  });

  it('同一条路径被用户中途改过时，补偿值折叠成用户的值（而不是覆盖回旧值）', () => {
    const j = setup();
    // width: 3 ->(AI:5) ->(用户:7) ->(AI:9)
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.commit({ actor: 'user', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 7 } });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 9 } });
    j.settle('t1');

    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);

    // 正确答案是 7（把 AI 的两条摘掉后重算），不是 3
    expect(field(j.currentDoc(), 'plot#1', 'style', 'width')).toBe(7);
    const fold = r.folded.find((f) => f.path === 'plot#1.style.width');
    expect(fold).toBeDefined();
    expect(fold?.originalBefore).toBe(3);
    expect(fold?.appliedValue).toBe(7);
    expect(fold?.supersededBy.length).toBe(1);
  });
});

describe('revert_compound 的前置条件与拒绝理由', () => {
  it('未 settled 的 compound 不允许撤销', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);
    expect(r.kind).toBe('rejected');
    expect(r.reason).toBe('compound_not_settled');
    // 文档必须原封不动
    expect(field(j.currentDoc(), 'plot#1', 'style', 'width')).toBe(5);
    expect(r.reverted).toEqual([]);
  });

  it('settle 之后可以撤销', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    expect(j.settle('t1').length).toBe(1);
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    expect(j.revertCompound(ai.compoundId).kind).toBe('reverted');
  });

  it('同一个 compound 不能撤两次', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    j.settle('t1');
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    expect(j.revertCompound(ai.compoundId).kind).toBe('reverted');
    const second = j.revertCompound(ai.compoundId);
    expect(second.kind).toBe('rejected');
    expect(second.reason).toBe('already_reverted');
  });

  it('不存在的 compound 报 compound_not_found', () => {
    const j = setup();
    expect(j.revertCompound('c:nope').reason).toBe('compound_not_found');
  });

  it('删除操作目前不可逆，如实回报而不是偷偷跳过', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'delete_object', target: 'plot#1' } });
    j.settle('t1');
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);
    expect(r.kind).toBe('reverted');
    expect(r.reverted).toEqual([]);
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.reason).toBe('not_invertible');
    expect(j.currentDoc().objects['plot#1']).toBeUndefined();
  });

  it('create_plot 的逆操作是删除该对象', () => {
    const j = setup();
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'sin(x)',
        domain: [-7, 7],
        style: { width: 3.5 },
        owner: { kind: 'scene', sceneId: 's1' },
      },
    });
    expect(j.currentDoc().objects['plot#3']).toBeDefined();
    j.settle('t1');
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);
    expect(r.kind).toBe('reverted');
    expect(j.currentDoc().objects['plot#3']).toBeUndefined();
    // 图层里的引用也要一起清掉
    expect(j.currentDoc().layers[0]?.objects).not.toContain('plot#3');
  });

  it('什么都没改的 compound（全是 null）不会把文档搅乱', () => {
    const j = setup();
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_style', target: 'plot#1' } });
    j.settle('t1');
    const ai = agentCompound(j, 't1');
    if (ai === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(ai.compoundId);
    expect(r.skipped.some((s) => s.reason === 'nothing_to_undo')).toBe(true);
    expect(field(j.currentDoc(), 'plot#1', 'style', 'width')).toBe(3);
  });
});

describe('Journal 与细粒度 undo 是两件事', () => {
  it('Journal 只记历史，不提供"上一步/下一步" —— 那是面板 temporal 中间件的栈', () => {
    const j = setup();
    j.commit({ actor: 'user', command: { op: 'set_style', target: 'plot#1', width: 5 } });
    const api = j as unknown as Record<string, unknown>;
    expect(api['undo']).toBeUndefined();
    expect(api['redo']).toBeUndefined();
    // 它能回答的是"谁在什么时候改了哪条路径"
    expect(j.query({ actor: 'user' }).length).toBe(1);
  });
});
