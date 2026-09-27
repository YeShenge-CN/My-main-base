import { describe, expect, it } from 'vitest';
import { createProposalStore, DEFAULT_PROPOSAL_TTL_MS } from '../src/command/proposal-store';
import { evaluateProposal } from '../src/command/proposal-eval';
import type { Proposal } from '../src/command/proposal';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { fieldValues } from '../src/doc/fields';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    proposalId: 'p_1',
    baseVersion: 0,
    target: 'plot#1.style.width',
    before: 3,
    after: 5,
    preconditions: [{ path: 'plot#1.style.width', expected: 3, kind: 'value' }],
    reason: '命中 hard 锁',
    reasonDetail: {
      currentValue: 3,
      targetValue: 5,
      visualChange: 'plot#1.style.width：3 → 5',
      rationale: '把曲线加粗，投影仪上看得清',
    },
    state: 'pending',
    by: 'ai',
    at: 1_700_000_000_000,
    command: { op: 'set_style', target: 'plot#1', width: 5 },
    affectedPaths: ['plot#1.style.width'],
    ...over,
  };
}

/** 用真实文档与真实三分支判定来建 store —— 不做假评估器。 */
function storeFor(doc: SceneDoc) {
  const c = clock();
  const store = createProposalStore({
    now: c.now,
    evaluate: (p) => evaluateProposal(p, { doc, currentVersion: p.baseVersion, writtenSince: [] }),
  });
  return { store, clock: c };
}

describe('P10 第 8 条：同一 path 上同时只允许一个未决提案', () => {
  it('同一路径的第二条提案会把第一条顶掉，并留下作废记录', () => {
    const { store } = storeFor(makeDoc(1));
    expect(store.submit(proposal({ proposalId: 'p_a' })).kind).toBe('accepted');
    const second = store.submit(proposal({ proposalId: 'p_b', after: 8 }));
    expect(second.kind).toBe('superseded_previous');
    if (second.kind !== 'superseded_previous') return;
    expect(second.supersededId).toBe('p_a');
    expect(store.pending().map((p) => p.proposalId)).toEqual(['p_b']);
    expect(store.count()).toBe(1);
    expect(store.feedback().some((d) => d.proposalId === 'p_a' && d.kind === 'superseded')).toBe(true);
  });

  it('不同路径上的提案并存', () => {
    const { store } = storeFor(makeDoc(1));
    store.submit(proposal({ proposalId: 'p_a' }));
    store.submit(proposal({ proposalId: 'p_c', target: 'plot#1.style.glow', before: 0.6, after: 0.9 }));
    expect(store.count()).toBe(2);
    expect(store.pendingForPath('plot#1.style.glow')?.proposalId).toBe('p_c');
  });
});

describe('P10 第 4、5 条：审批跑 precondition，三分支', () => {
  it('前提成立且版本相同 → approve', () => {
    const { store } = storeFor(makeDoc(1));
    store.submit(proposal());
    const r = store.decide('p_1', 'approve');
    expect(r?.decision?.kind).toBe('approve');
    expect(r?.record.kind).toBe('approve');
    expect(store.count()).toBe(0);
  });

  it('前提值被别人改过 → 判 stale，作废，并逐条说明变成了多少', () => {
    const doc = makeDoc(1);
    const p1 = doc.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺 plot#1');
    const changed: SceneDoc = {
      ...doc,
      objects: { ...doc.objects, 'plot#1': { ...p1, style: { ...p1.style, width: { v: 7 } } } },
    };
    const { store } = storeFor(changed);
    store.submit(proposal());

    const r = store.decide('p_1', 'approve');
    expect(r?.decision?.kind).toBe('stale');
    if (r?.decision?.kind !== 'stale') return;
    // 逐条说明：哪个前提、期望多少、实际多少
    expect(r.decision.failures).toEqual([
      { path: 'plot#1.style.width', expected: 3, actual: 7, reason: 'value_changed' },
    ]);
    // 回执文本里也能读到这两个数，模型不需要自己解析结构
    expect(r.record.note).toContain('plot#1.style.width');
    expect(r.record.note).toContain('3');
    expect(r.record.note).toContain('7');
    expect(r.record.staleFailures?.length).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('版本前进了但没人碰过这条路径 → fast-forward', () => {
    const c = clock();
    const doc = makeDoc(1);
    const store = createProposalStore({
      now: c.now,
      evaluate: (p) => evaluateProposal(p, { doc, currentVersion: p.baseVersion + 4, writtenSince: ['plot#2.tf.x'] }),
    });
    store.submit(proposal());
    const r = store.decide('p_1', 'approve');
    expect(r?.decision?.kind).toBe('fast-forward');
    expect(r?.record.note).toContain('快进');
  });
});

describe('P10 第 6、7 条：拒绝与"改为手动设定"都要回灌模型', () => {
  it('拒绝留下可读理由，模型据此不再重复提', () => {
    const { store } = storeFor(makeDoc(1));
    store.submit(proposal());
    const r = store.decide('p_1', 'reject', { value: '曲线太粗了。' });
    expect(r?.record.kind).toBe('reject');
    expect(r?.record.note).toContain('曲线太粗了');
    expect(r?.record.note).toContain('不要再提同样的改动');
    expect(store.feedback().some((d) => d.kind === 'reject')).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('"改为手动设定"是第三种决策：方向认可、值用用户手调的', () => {
    const { store } = storeFor(makeDoc(1));
    store.submit(proposal());
    const r = store.decide('p_1', 'override', { value: 4 });
    expect(r?.record.kind).toBe('override');
    expect(r?.record.overrideValue).toBe(4);
    // 回执里同时给出用户的值与 AI 原本的目标值，避免模型以为"没生效"
    expect(r?.record.note).toContain('4');
    expect(r?.record.note).toContain('5');
    expect(r?.record.note).toContain('不要改回去');
    expect(store.count()).toBe(0);
  });
});

describe('P10 第 9 条：超时默认 10 分钟，AI 视为拒绝', () => {
  it('默认 TTL 是 10 分钟', () => {
    expect(DEFAULT_PROPOSAL_TTL_MS).toBe(600_000);
  });

  it('到点前不作废，到点后 sweep 把它判为 expired', () => {
    const { store, clock: c } = storeFor(makeDoc(1));
    store.submit(proposal({ at: c.now() }));

    c.advance(DEFAULT_PROPOSAL_TTL_MS - 1000);
    expect(store.sweep()).toEqual([]);
    expect(store.count()).toBe(1);

    c.advance(2000);
    const swept = store.sweep();
    expect(swept.length).toBe(1);
    expect(swept[0]?.kind).toBe('expired');
    expect(swept[0]?.note).toContain('视为拒绝');
    expect(store.count()).toBe(0);
  });
});

describe('P10 第 1 条：hard / soft 锁的分流（端到端）', () => {
  it('hard 锁 → 降级为提案，文档不动；soft 锁 → 直接改 + 提示会覆盖动画', () => {
    const base = makeDoc(1);
    const p1 = base.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺 plot#1');

    const doc: SceneDoc = {
      ...base,
      objects: {
        ...base.objects,
        'plot#1': { ...p1, anim: { 'style.glow': { kind: 'expr', expr: 't' } } },
      },
      locks: {
        'plot#1.style.width': { by: 'user', at: 1 },
        'plot#1.style.glow': { by: 'ai', at: 2 },
      },
    };
    const c = clock();
    const journal = createJournal(doc, { now: c.now });
    const deps = { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'agent' as const, now: c.now };

    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, op: 'set_style', target: 'plot#1', width: 9 },
          { index: 1, op: 'set_style', target: 'plot#1', glow: 0.1 },
        ],
      },
      deps,
    );

    // hard：转提案，未提交
    expect(res.proposals.map((p) => p.index)).toEqual([0]);
    const prop = res.proposals[0]?.proposal;
    expect(prop?.reasonDetail.rationale).toBeTruthy();
    expect(prop?.reasonDetail.currentValue).toBe(3);
    expect(prop?.reasonDetail.targetValue).toBe(9);
    expect(prop?.reasonDetail.visualChange).toContain('plot#1.style.width');

    // soft：放行，但明确提示会覆盖动画
    expect(res.ok.map((o) => o.index)).toEqual([1]);
    expect(res.notices?.some((n) => n.code === 'soft_lock_overwritten')).toBe(true);

    const after = journal.currentDoc();
    expect(fieldValues(after.objects['plot#1']?.style ?? {})['width']).toBe(3);
    expect(fieldValues(after.objects['plot#1']?.style ?? {})['glow']).toBe(0.1);
  });
});
