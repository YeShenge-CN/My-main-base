import { describe, expect, it } from 'vitest';
import { applyCommands, mapLocalIds, producedLocalIds, referencedLocalIds, writeSetOf, type BatchDeps } from '../src/command/batch';
import { evaluateProposal } from '../src/command/proposal-eval';
import type { Command } from '../src/command/commands';
import type { BudgetState } from '../src/command/results';
import { createJournal, type Journal } from '../src/journal/store';
import { fieldValues } from '../src/doc/fields';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

const BUDGET: BudgetState = { imagesUsed: 1, imagesLeft: 5, renderCallsLeft: 2 };

function setup(doc: SceneDoc = makeDoc(2)): { journal: Journal; deps: BatchDeps } {
  let clock = 1_700_000_000_000;
  const journal = createJournal(doc, { now: () => (clock += 1000) });
  return {
    journal,
    deps: { journal, budget: () => BUDGET, actor: 'agent', turnId: 'turn-1', now: () => (clock += 1000) },
  };
}

function widthOf(doc: SceneDoc, id: string): unknown {
  const o = doc.objects[id];
  return o === undefined ? undefined : fieldValues(o.style)['width'];
}

const createPlot = (localId: string): Command => ({
  op: 'create_plot',
  localId,
  expr: 'sin(x)',
  domain: [-7, 7],
  owner: { kind: 'scene', sceneId: 's1' },
});

describe('依赖推导：精确到 localId 的产生者', () => {
  it('P4 验收：create(A) → set_style(B, 命中锁) → camera(subject:A)，第三条【不得】被 blocked', () => {
    const doc = makeDoc(2);
    const locked: SceneDoc = {
      ...doc,
      locks: { 'plot#2.style.width': { by: 'user', at: 1730000000000 } },
    };
    const { deps } = setup(locked);

    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, ...createPlot('$c1') } as Command,
          { index: 1, op: 'set_style', target: 'plot#2', width: 9 },
          { index: 2, op: 'camera_preset', preset: 'pushIn', subject: '$c1', duration: 3 },
        ],
      },
      deps,
    );

    // 第二条命中 hard 锁 → 变成提案
    expect(res.proposals.map((p) => p.index)).toEqual([1]);
    // 第三条依赖的是【第一条】（$c1 的产生者），不是紧邻的第二条
    expect(res.blocked).toEqual([]);
    expect(res.ok.map((o) => o.index)).toEqual([0, 2]);
    expect(res.errored).toEqual([]);
    expect(res.ok[0]?.assignedId).toBe('plot#3');
  });

  it('符号 id 在 simulate 阶段就被解析成真实 id，不留到提交阶段', () => {
    const { journal, deps } = setup();
    applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, ...createPlot('$c1') } as Command,
          { index: 1, op: 'camera_preset', preset: 'pushIn', subject: '$c1', duration: 3 },
        ],
      },
      deps,
    );
    // 落到 Journal 里的命令已经是解析过的：subject 不再是 $c1
    const op = journal.operations().find((o) => o.command.op === 'camera_preset');
    expect(op).toBeDefined();
    const cmd = op?.command;
    if (cmd === undefined || cmd.op !== 'camera_preset') throw new Error('缺命令');
    expect(cmd.subject).toBe('plot#3');
  });

  it('传递闭包：上游是提案或错误时，所有下游 blocked，且报的是【根因】下标', () => {
    const doc = makeDoc(2);
    const locked: SceneDoc = {
      ...doc,
      locks: { 'plot#1.style.width': { by: 'user', at: 1 } },
    };
    const { deps } = setup(locked);

    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, op: 'set_style', target: 'plot#1', width: 5 },
          { index: 1, op: 'set_transform', target: 'plot#1', opacity: 0.5, dependsOn: [0] },
          { index: 2, op: 'set_style', target: 'plot#1', glow: 0.1, dependsOn: [1] },
        ],
      },
      deps,
    );

    expect(res.proposals.map((p) => p.index)).toEqual([0]);
    expect(res.blocked.map((b) => b.index)).toEqual([1, 2]);
    expect(res.blocked.every((b) => b.reason === 'proposal_pending')).toBe(true);
    // 第三条通过第二条间接依赖第一条，根因应当报 0 而不是 1
    expect(res.blocked[1]?.blockedBy).toBe(0);
    expect(res.ok).toEqual([]);
  });

  it('引用了不存在的符号 id → errored(unknown_local_id)', () => {
    const { deps } = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'set_style', target: '$nope', width: 1 }] },
      deps,
    );
    expect(res.errored[0]?.error.code).toBe('unknown_local_id');
  });

  it('引用靠后的命令产生的符号 id → errored，并说清楚原因', () => {
    const { deps } = setup();
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, op: 'set_style', target: '$later', width: 1 },
          { index: 1, ...createPlot('$later') } as Command,
        ],
      },
      deps,
    );
    expect(res.errored[0]?.error.code).toBe('unknown_local_id');
    expect(res.errored[0]?.error.message).toContain('靠后');
  });

  it('显式 dependsOn 只能追加，不能取消自动推导出来的依赖', () => {
    const { deps } = setup();
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, op: 'set_style', target: 'ghost#1', width: 1 },
          // 建对象这条依赖了失败的第 0 条 → 它自己被 blocked，也就没有产出任何 id
          { index: 1, ...createPlot('$c1'), dependsOn: [0] } as Command,
          // 第三条的 dependsOn 是【空的】：它唯一的依赖来自"引用了 $c1"这条自动推导。
          // 如果引擎只认显式 dependsOn，这一条就会被放行，然后以 unknown_local_id 失败。
          { index: 2, op: 'set_style', target: '$c1', width: 5, dependsOn: [] },
        ],
      },
      deps,
    );
    expect(res.errored.map((e) => e.index)).toEqual([0]);
    expect(res.blocked.map((b) => b.index)).toEqual([1, 2]);
    // 根因继承：第 2 条间接依赖第 0 条，报的是 0 而不是 1
    expect(res.blocked[1]?.blockedBy).toBe(0);
    expect(res.blocked[1]?.reason).toBe('error_upstream');
  });
});

describe('静态分析辅助（依赖推导的输入）', () => {
  it('referencedLocalIds 会忽略 intent 里的 $ 号', () => {
    const cmd: Command = {
      op: 'set_style',
      target: 'plot#1',
      width: 5,
      intent: '$c1 看起来太细了',
    };
    expect(referencedLocalIds(cmd)).toEqual([]);
    expect(referencedLocalIds({ op: 'set_style', target: '$c1', width: 5 })).toEqual(['$c1']);
  });

  it('producedLocalIds 只认 create / add_effect', () => {
    expect(producedLocalIds(createPlot('$c1'))).toEqual(['$c1']);
    expect(producedLocalIds({ op: 'set_style', target: 'plot#1', width: 1 })).toEqual([]);
  });

  it('mapLocalIds 递归替换，且不动数字数组', () => {
    const map = new Map([['$c1', 'plot#9']]);
    const out = mapLocalIds({ a: '$c1', b: ['$c1', 3], c: { d: '$c1' } }, map);
    expect(out).toEqual({ a: 'plot#9', b: ['plot#9', 3], c: { d: 'plot#9' } });
  });

  it('writeSetOf 推出写路径（锁判定必须在应用之前做出来）', () => {
    expect(writeSetOf({ op: 'set_style', target: 'plot#1', width: 5, glow: null })).toEqual([
      'plot#1.style.width',
    ]);
    expect(writeSetOf({ op: 'set_transform', target: 'plot#1', opacity: 0.5 })).toEqual([
      'plot#1.tf.opacity',
    ]);
    expect(writeSetOf(createPlot('$c1'))).toEqual([]);
  });
});

describe('四态与提交语义', () => {
  it('失败时 ok 部分保留，errored 原因正确（默认不回滚）', () => {
    const { journal, deps } = setup();
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          { index: 0, op: 'set_style', target: 'plot#1', width: 5 },
          { index: 1, op: 'set_style', target: 'ghost#1', width: 1 },
          { index: 2, op: 'set_transform', target: 'plot#1', opacity: 0.25 },
        ],
      },
      deps,
    );

    expect(res.ok.map((o) => o.index)).toEqual([0, 2]);
    expect(res.errored.map((e) => e.index)).toEqual([1]);
    expect(res.errored[0]?.error.code).toBe('unknown_target');
    expect(res.version).toBe(2);
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(5);
    expect(journal.currentDoc().objects['plot#1']?.tf.opacity).toBe(0.25);
  });

  it('atomic:true 时全或无，ok 部分退成 blocked(atomic_abort)', () => {
    const { journal, deps } = setup();
    const res = applyCommands(
      {
        baseVersion: 0,
        atomic: true,
        commands: [
          { index: 0, op: 'set_style', target: 'plot#1', width: 5 },
          { index: 1, op: 'set_style', target: 'ghost#1', width: 1 },
        ],
      },
      deps,
    );

    expect(res.ok).toEqual([]);
    expect(res.version).toBe(0);
    expect(res.blocked.map((b) => b.index)).toEqual([0]);
    expect(res.blocked[0]?.reason).toBe('atomic_abort');
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(3);
    expect(journal.operations().length).toBe(0);
  });

  it('index 与实际位置不一致 → errored(index_mismatch)', () => {
    const { deps } = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 5, op: 'set_style', target: 'plot#1', width: 5 }] },
      deps,
    );
    expect(res.errored[0]?.error.code).toBe('index_mismatch');
  });

  it('超过 15 条给出切分提示，但仍然执行', () => {
    const { deps } = setup();
    const commands: Command[] = [];
    for (let i = 0; i < 16; i++) {
      commands.push({ index: i, op: 'set_transform', target: 'plot#1', x: i });
    }
    const res = applyCommands({ baseVersion: 0, commands }, deps);
    expect(res.notices?.[0]?.code).toBe('batch_too_large');
    expect(res.ok.length).toBe(16);
  });

  it('回执里带 budget 剩余量（让模型记得住预算）', () => {
    const { deps } = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'set_style', target: 'plot#1', width: 5 }] },
      deps,
    );
    expect(res.budget).toEqual(BUDGET);
  });

  it('soft 锁放行，但在 notices 里说明会覆盖动画', () => {
    const doc = makeDoc(1);
    const p1 = doc.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺 plot#1');
    const softLocked: SceneDoc = {
      ...doc,
      objects: { ...doc.objects, 'plot#1': { ...p1, anim: { 'style.width': { kind: 'expr', expr: 't' } } } },
      locks: { 'plot#1.style.width': { by: 'ai', at: 1 } },
    };
    const { deps } = setup(softLocked);
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'set_style', target: 'plot#1', width: 8 }] },
      deps,
    );
    expect(res.ok.length).toBe(1);
    expect(res.proposals).toEqual([]);
    expect(res.notices?.some((n) => n.code === 'soft_lock_overwritten')).toBe(true);
  });
});

describe('P4 验收：precondition 失效判 stale，且逐条说明变成了多少', () => {
  const base: SceneDoc = makeDoc(1);

  function proposalFrom(doc: SceneDoc) {
    const { deps } = setup(doc);
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [
          {
            index: 0,
            op: 'set_style',
            target: 'plot#1',
            width: 5,
            dependsOn: [],
          },
        ],
      },
      deps,
    );
    return res;
  }

  it('precondition 由引擎推导，等于命中锁的那些写路径', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const res = proposalFrom(locked);
    const p = res.proposals[0]?.proposal;
    expect(p).toBeDefined();
    expect(p?.preconditions).toEqual([
      { path: 'plot#1.style.width', expected: 3, kind: 'value' },
    ]);
    expect(p?.before).toBe(3);
    expect(p?.after).toBe(5);
    expect(p?.by).toBe('ai');
  });

  it('版本相同且前提成立 → approve', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const p = proposalFrom(locked).proposals[0]?.proposal;
    if (p === undefined) throw new Error('缺提案');
    const d = evaluateProposal(p, { doc: locked, currentVersion: 0, writtenSince: [] });
    expect(d.kind).toBe('approve');
  });

  it('版本前进了但没人碰过本提案要写的路径 → fast-forward', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const p = proposalFrom(locked).proposals[0]?.proposal;
    if (p === undefined) throw new Error('缺提案');
    const target = locked.objects['plot#1'];
    if (target === undefined) throw new Error('缺 plot#1');
    const moved: SceneDoc = {
      ...locked,
      objects: {
        ...locked.objects,
        'plot#1': { ...target, tf: { x: 1, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 } },
      },
    };
    const d = evaluateProposal(p, {
      doc: moved,
      currentVersion: 3,
      writtenSince: ['plot#1.tf.x'],
    });
    expect(d.kind).toBe('fast-forward');
    if (d.kind !== 'fast-forward') return;
    expect(d.skippedPaths).toEqual(['plot#1.tf.x']);
  });

  it('前提值变了 → stale，并逐条说明 expected / actual', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const p = proposalFrom(locked).proposals[0]?.proposal;
    if (p === undefined) throw new Error('缺提案');
    // 用户把 width 从 3 改成了 7
    const p1 = locked.objects['plot#1'];
    if (p1 === undefined) throw new Error('缺对象');
    const changed: SceneDoc = {
      ...locked,
      objects: {
        ...locked.objects,
        'plot#1': { ...p1, style: { ...p1.style, width: { v: 7 } } },
      },
    };
    const d = evaluateProposal(p, { doc: changed, currentVersion: 1, writtenSince: ['plot#1.style.width'] });
    expect(d.kind).toBe('stale');
    if (d.kind !== 'stale') return;
    expect(d.failures).toEqual([
      {
        path: 'plot#1.style.width',
        expected: 3,
        actual: 7,
        reason: 'value_changed',
      },
    ]);
  });

  it('本提案要写的路径被别人写过 → stale（不能快进盖掉别人的改动）', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const p = proposalFrom(locked).proposals[0]?.proposal;
    if (p === undefined) throw new Error('缺提案');
    const d = evaluateProposal(p, {
      doc: locked,
      currentVersion: 2,
      writtenSince: ['plot#1.style.width'],
    });
    expect(d.kind).toBe('stale');
  });

  it('路径不存在时 stale 的原因为 missing', () => {
    const locked: SceneDoc = { ...base, locks: { 'plot#1.style.width': { by: 'user', at: 1 } } };
    const p = proposalFrom(locked).proposals[0]?.proposal;
    if (p === undefined) throw new Error('缺提案');
    const gone: SceneDoc = {
      ...locked,
      objects: {},
    };
    const d = evaluateProposal(p, { doc: gone, currentVersion: 0, writtenSince: [] });
    expect(d.kind).toBe('stale');
    if (d.kind !== 'stale') return;
    expect(d.failures[0]?.reason).toBe('missing');
  });
});
