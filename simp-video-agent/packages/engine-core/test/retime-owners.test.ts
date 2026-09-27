import { describe, expect, it } from 'vitest';
import { shiftTimeline } from '../src/doc/shift';
import { canWrite, type WriteVerdict } from '../src/doc/permissions';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject } from './fixtures';

function clock(): () => number {
  let t = 1_700_000_000_000;
  return () => (t += 1000);
}

/** 三种 owner 各一个对象，都带一条 t=2 的动画关键帧，便于观察"本体有没有动"。 */
function mixedDoc(): SceneDoc {
  const base = makeDoc(0);
  const anim = { 'tf.opacity': { kind: 'keys' as const, keys: [{ t: 0, v: 1 }, { t: 2, v: 0.5 }] } };
  const mk = (id: string, owner: SceneObject['owner']): SceneObject =>
    makeObject(id, 'plot2d', { owner, anim });

  return {
    ...base,
    meta: { ...base.meta, duration: 12 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['a#1', 'b#1', 'c#1'] }],
    objects: {
      'a#1': mk('a#1', { kind: 'scene', sceneId: 's1', bornAt: 0 }),
      'b#1': mk('b#1', { kind: 'shared', sharedId: 'asset.sin', usageWindows: [[0, 2]] }),
      'c#1': mk('c#1', { kind: 'global' }),
    },
    effects: {},
    markers: [{ id: 'peak', t: 1 }],
  };
}

function keyTime(doc: SceneDoc, id: string): number | undefined {
  const node = doc.objects[id]?.anim['tf.opacity'];
  return node !== undefined && node.kind === 'keys' ? node.keys[1]?.t : undefined;
}

const SCOPE = { kind: 'scene', sceneId: 's1', start: 1, end: 12 } as const;

describe('P12 验收 ①：scene-owned 对象被正确顺延', () => {
  it('本镜对象的关键帧跟着走', () => {
    const r = shiftTimeline(mixedDoc(), 1, 3, SCOPE);
    expect(keyTime(r.doc, 'a#1')).toBe(5);
    expect(r.doc.markers[0]?.t).toBe(1);
  });

  it('导演视角（不传 scope）下全量顺延，标记也走', () => {
    const r = shiftTimeline(mixedDoc(), 1, 3);
    expect(keyTime(r.doc, 'a#1')).toBe(5);
    expect(r.doc.markers[0]?.t).toBe(4);
  });
});

describe('P12 验收 ②：shared 对象只顺延 usageWindows，本体不动', () => {
  it('usageWindow 往后挪，关键帧纹丝不动', () => {
    const r = shiftTimeline(mixedDoc(), 1, 3, SCOPE);
    const owner = r.doc.objects['b#1']?.owner;
    expect(owner?.kind).toBe('shared');
    if (owner?.kind !== 'shared') return;
    expect(owner.usageWindows).toEqual([[3, 5]]);
    // ★ 本体不动
    expect(keyTime(r.doc, 'b#1')).toBe(2);
    expect(r.shiftedWindows).toBe(1);
  });

  it('窗口完全在 from 之前时不动', () => {
    const doc = mixedDoc();
    const r = shiftTimeline(doc, 5, 3, SCOPE);
    const owner = r.doc.objects['b#1']?.owner;
    if (owner?.kind !== 'shared') throw new Error('owner 变了');
    expect(owner.usageWindows).toEqual([[0, 2]]);
    expect(r.shiftedWindows).toBe(0);
  });
});

describe('P12 验收 ③：global 对象完全不动', () => {
  it('关键帧不动，且被如实记进 skippedOwners', () => {
    const r = shiftTimeline(mixedDoc(), 1, 3, SCOPE);
    expect(keyTime(r.doc, 'c#1')).toBe(2);
    expect(r.skippedOwners).toContain('c#1');
  });

  it('strict 模式下别镜的 scene 对象也不动', () => {
    const doc = mixedDoc();
    const other = makeObject('d#1', 'plot2d', {
      owner: { kind: 'scene', sceneId: 's2', bornAt: 0 },
      anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 2, v: 1 }] } },
    });
    const two: SceneDoc = { ...doc, objects: { ...doc.objects, 'd#1': other } };
    const r = shiftTimeline(two, 1, 3, SCOPE);
    const node = r.doc.objects['d#1']?.anim['tf.opacity'];
    expect(node?.kind === 'keys' ? node.keys[0]?.t : undefined).toBe(2);
    expect(r.skippedOwners).toContain('d#1');
  });
});

describe('P12 第 2 条：写权限', () => {
  it('场景 Agent 只能写自己镜内的 scene 对象', () => {
    const doc = mixedDoc();
    expect(canWrite(doc, SCOPE, 'a#1').allowed).toBe(true);
    const why = (v: WriteVerdict): string | undefined => (v.allowed ? undefined : v.reason);
    expect(why(canWrite(doc, SCOPE, 'b#1'))).toBe('shared_body');
    expect(why(canWrite(doc, SCOPE, 'c#1'))).toBe('global_owned');
    expect(why(canWrite(doc, SCOPE, 'a#1', 99))).toBe('outside_scene_window');
    expect(canWrite(doc, { kind: 'director' }, 'c#1').allowed).toBe(true);
  });
});

describe('P12 第 5 条：retime 是一条命令、一个 compound', () => {
  it('一次 retime 只产生一个 CompoundOperation', () => {
    const journal = createJournal(mixedDoc(), { now: clock() });
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [{ index: 0, op: 'retime', fromMarker: 'peak', delta: 3, activeSceneId: 's1' }],
      },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'agent', turnId: 't1', now: clock() },
    );
    expect(res.ok.length).toBe(1);
    expect(journal.operations().length).toBe(1);
    expect(journal.compounds().length).toBe(1);
    // 顺延前后 three-owner 的差异被记进 patches
    const op = journal.operations()[0];
    expect(op?.affectedPaths).toContain('meta.duration');
  });
});

describe('P12 第 3、4 条：promote_object 需人工确认；link_shared 场景 Agent 可调', () => {
  it('Agent 发起 promote_object → 降级为提案，归属不变', () => {
    const journal = createJournal(mixedDoc(), { now: clock() });
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [{ index: 0, op: 'promote_object', target: 'a#1', to: { kind: 'global' } }],
      },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'agent', now: clock() },
    );
    expect(res.proposals.length).toBe(1);
    expect(res.ok).toEqual([]);
    expect(journal.currentDoc().objects['a#1']?.owner.kind).toBe('scene');
  });

  it('用户发起 promote_object → 直接生效', () => {
    const journal = createJournal(mixedDoc(), { now: clock() });
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [{ index: 0, op: 'promote_object', target: 'a#1', to: { kind: 'global' } }],
      },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'user', now: clock() },
    );
    expect(res.ok.length).toBe(1);
    expect(journal.currentDoc().objects['a#1']?.owner.kind).toBe('global');
  });

  it('link_shared 只加窗口，本体不动', () => {
    const journal = createJournal(mixedDoc(), { now: clock() });
    const res = applyCommands(
      {
        baseVersion: 0,
        commands: [{ index: 0, op: 'link_shared', sharedId: 'b#1', sceneId: 's1', usageWindow: [4, 6] }],
      },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'agent', now: clock() },
    );
    expect(res.ok.length).toBe(1);
    const owner = journal.currentDoc().objects['b#1']?.owner;
    if (owner?.kind !== 'shared') throw new Error('owner 变了');
    expect(owner.usageWindows).toEqual([[0, 2], [4, 6]]);
    expect(keyTime(journal.currentDoc(), 'b#1')).toBe(2);
  });
});
