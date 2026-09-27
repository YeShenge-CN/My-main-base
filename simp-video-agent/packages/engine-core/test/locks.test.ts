import { describe, expect, it } from 'vitest';
import { applyCommands, type BatchDeps } from '../src/command/batch';
import { createJournal, type Journal } from '../src/journal/store';
import { dropUserLocks, mergeLocksForActor } from '../src/doc/locks';
import { lockClassOf, type SceneDoc } from '../src/doc/types';
import { fieldValues } from '../src/doc/fields';
import { makeDoc } from './fixtures';

/**
 * 锁的写入路径（规范 §8 / §11）。
 *
 * 这一组测试存在的理由：在此之前 doc.locks 【没有任何写入路径】——
 * 全仓库只有读它的地方。于是"用户手动改过 → hard 锁 → AI 必须先问"
 * 这条规范里最核心的协作链路，在真实运行中从未发生过（压力测试里那些锁
 * 全是测试自己塞进夹具的）。下面的断言把这条链路钉在真实提交路径上。
 */

function setup(doc: SceneDoc = makeDoc(1)): { journal: Journal; deps: (actor: 'user' | 'agent') => BatchDeps } {
  let clock = 1_700_000_000_000;
  const journal = createJournal(doc, { now: () => (clock += 1000) });
  return {
    journal,
    deps: (actor) => ({
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor,
      now: () => (clock += 1000),
    }),
  };
}

const widthOf = (doc: SceneDoc, id: string): unknown =>
  fieldValues(doc.objects[id]?.style ?? {})['width'];

describe('纯函数：谁写、写什么、留下什么锁', () => {
  it('用户写入 → 被写的路径上出现 hard 锁', () => {
    const doc = makeDoc(1);
    const r = mergeLocksForActor(doc, 'user', ['plot#1.style.width'], 123);
    expect(r.added).toEqual(['plot#1.style.width']);
    const entry = r.doc.locks['plot#1.style.width'];
    expect(entry).toEqual({ by: 'user', at: 123 });
    expect(entry === undefined ? null : lockClassOf(entry)).toBe('hard');
  });

  it('Agent / 引擎写入【不】自动加锁（锁是权限状态，不能由被授权方产生）', () => {
    const doc = makeDoc(1);
    expect(mergeLocksForActor(doc, 'agent', ['plot#1.style.width'], 1)).toEqual({ doc, added: [] });
    expect(mergeLocksForActor(doc, 'engine-autofix', ['plot#1.style.width'], 1).added).toEqual([]);
  });

  it('已有的用户锁保留最初的 at（那是"用户何时开始拥有它"）', () => {
    const doc: SceneDoc = { ...makeDoc(1), locks: { 'plot#1.style.width': { by: 'user', at: 5 } } };
    const r = mergeLocksForActor(doc, 'user', ['plot#1.style.width'], 999);
    expect(r.added).toEqual([]);
    expect(r.doc.locks['plot#1.style.width']).toEqual({ by: 'user', at: 5 });
    expect(r.doc).toBe(doc); // 什么都没改就保持结构共享
  });

  it('会覆盖 AI 的 soft 锁：用户一动手，它就变成 hard', () => {
    const doc: SceneDoc = { ...makeDoc(1), locks: { 'plot#1.style.glow': { by: 'ai', at: 1 } } };
    const r = mergeLocksForActor(doc, 'user', ['plot#1.style.glow'], 42);
    expect(r.doc.locks['plot#1.style.glow']).toEqual({ by: 'user', at: 42 });
    expect(r.added).toEqual(['plot#1.style.glow']);
  });

  it('dropUserLocks 只摘用户的锁，不碰别的来源', () => {
    const doc: SceneDoc = {
      ...makeDoc(1),
      locks: {
        'plot#1.style.width': { by: 'user', at: 1 },
        'plot#1.style.glow': { by: 'ai', at: 1 },
      },
    };
    const out = dropUserLocks(doc, ['plot#1.style.width', 'plot#1.style.glow']);
    expect(out.locks['plot#1.style.width']).toBeUndefined();
    expect(out.locks['plot#1.style.glow']).toEqual({ by: 'ai', at: 1 });
  });
});

describe('端到端：用户改一下，AI 就必须先问', () => {
  it('用户提交 → 锁出现；Agent 再改同一字段 → 降级为提案，文档不动', () => {
    const { journal, deps } = setup();
    const user = deps('user');

    const first = applyCommands(
      { baseVersion: 0, commands: [{ op: 'set_style', target: 'plot#1', width: 8 }] },
      user,
    );
    expect(first.ok.length).toBe(1);
    expect(first.proposals).toEqual([]); // 用户改自己没锁的字段，直接生效
    expect(journal.currentDoc().locks['plot#1.style.width']).toEqual({ by: 'user', at: expect.any(Number) });
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(8);

    // ★ 这才是规范 §8 那条链路：AI 现在必须先问
    const agent = deps('agent');
    const second = applyCommands(
      { baseVersion: journal.currentVersion(), commands: [{ op: 'set_style', target: 'plot#1', width: 2 }] },
      agent,
    );
    expect(second.ok).toEqual([]);
    expect(second.proposals.map((p) => p.index)).toEqual([0]);
    expect(second.proposals[0]?.proposal.target).toBe('plot#1.style.width');
    expect(second.proposals[0]?.proposal.preconditions).toEqual([
      { path: 'plot#1.style.width', expected: 8, kind: 'value' },
    ]);
    // 文档没被动过
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(8);
  });

  it('用户自己再改一次被自己锁住的字段：放行，并留下 notice（不是自锁死）', () => {
    const { journal, deps } = setup();
    const user = deps('user');
    applyCommands({ baseVersion: 0, commands: [{ op: 'set_style', target: 'plot#1', width: 4 }] }, user);
    const again = applyCommands(
      { baseVersion: journal.currentVersion(), commands: [{ op: 'set_style', target: 'plot#1', width: 6 }] },
      user,
    );
    expect(again.ok.length).toBe(1);
    expect(again.notices?.some((n) => n.code === 'own_lock_overridden')).toBe(true);
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(6);
  });

  it('Agent 自己写入不产生锁（否则它会把自己的路堵死）', () => {
    const { journal, deps } = setup();
    const agent = deps('agent');
    applyCommands({ baseVersion: 0, commands: [{ op: 'set_style', target: 'plot#1', width: 5 }] }, agent);
    expect(Object.keys(journal.currentDoc().locks)).toEqual([]);
    const second = applyCommands(
      { baseVersion: journal.currentVersion(), commands: [{ op: 'set_style', target: 'plot#1', width: 6 }] },
      agent,
    );
    expect(second.ok.length).toBe(1); // 没有被自己锁住
  });

  it('撤销一次用户写入之后，锁跟着消失', () => {
    const { journal, deps } = setup();
    const user = deps('user');
    applyCommands({ baseVersion: 0, commands: [{ op: 'set_style', target: 'plot#1', width: 9 }] }, user);
    const compoundId = journal.compounds()[0]?.compoundId;
    if (compoundId === undefined) throw new Error('缺 compound');
    journal.settleCompound(compoundId);

    const r = journal.revertCompound(compoundId);
    expect(r.kind).toBe('reverted');
    expect(journal.currentDoc().locks['plot#1.style.width']).toBeUndefined();
    expect(widthOf(journal.currentDoc(), 'plot#1')).toBe(3); // 回到 fixture 的初值
  });

  it('多字段写入 → 每个受影响路径各留一把锁，粒度是字段级', () => {
    const { journal, deps } = setup();
    const user = deps('user');
    applyCommands(
      {
        baseVersion: 0,
        commands: [
          { op: 'set_style', target: 'plot#1', width: 5, glow: 0.9 },
          { op: 'set_transform', target: 'plot#1', opacity: 0.5 },
        ],
      },
      user,
    );
    expect(Object.keys(journal.currentDoc().locks).sort()).toEqual([
      'plot#1.style.glow',
      'plot#1.style.width',
      'plot#1.tf.opacity',
    ]);
  });
});
