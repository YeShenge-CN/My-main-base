/**
 * retime 接上镜头表（P12 第 2 条）。
 *
 * 这一份锁的是【两个口径决定】，它们都是我这轮定的、都必须在代码里可见：
 *
 *   分叉 1（镜头边界怎么挪）：bornAt ≥ from 的镜头起点 +delta，于是
 *           · 被插入的那一镜【变长】（结束 = 下一镜起点，被推后了）
 *           · 后续镜头整体后移，窗口长度不变
 *           这是 A1 的必然推论。想"后面内容不动、当前镜被压缩"是另一种语义，
 *           那需要给镜头存 end（= 被否掉的 A2），不许在这里偷偷换口径。
 *
 *   分叉 2（场景 Agent 顶穿本镜边界）：报 scene_bounds_exceeded 让命令失败。
 *           它顺延不了镜头表（那会改到别人那一镜），硬做就会留下
 *           "对象属于本镜、内容却在本镜之外"的矛盾状态 ——
 *           画面上看不出来，只在镜头过滤生效后才爆发，而且查不到源头。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/command/apply';
import { applyCommands } from '../src/command/batch';
import { shiftTimeline } from '../src/doc/shift';
import { createJournal, type Journal } from '../src/journal/store';
import { objectTimeWindow, sceneEnd } from '../src/doc/types';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

const BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

/**
 * 三镜文档：s#1 [0,4) · s#2 [4,8) · s#3 [8,12)，片长 12。
 * 每镜一个对象、两个关键帧。
 *
 * ★ 标记放在 t=4（= s#2 的起点），也就是【镜头边界】上。
 *   放在窗口内部（比如 t=2 ∈ [0,4)）是合法但读不出结论的场景：
 *   插入点前后各有一半内容，前一镜的尾部会变得比窗口还长 ——
 *   那是"插入点在镜内"的正常后果，不是多镜头要解决的矛盾。
 *   多镜头要保证的是"整镜用紧"：从镜头起点插时间，内容与边界同步后移。
 *
 * ★ 关键帧刻意【不】落在 marker 上：`k.t >= from` 是包含边界的
 *   （恰好落在 from 上的关键帧会被顺延）。边界语义由单独一条测试钉住。
 */
function threeSceneDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  const anim = (a: number, b: number) => ({
    'tf.opacity': { kind: 'keys' as const, keys: [{ t: a, v: 0 }, { t: b, v: 1 }] },
  });
  return {
    ...withScenes(base, [{ id: 's#1', name: '一', bornAt: 0 }, { id: 's#2', name: '二', bornAt: 4 }, { id: 's#3', name: '三', bornAt: 8 }]),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'c#1'] }],
    objects: {
      'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#1', bornAt: 0 }, anim: anim(0, 3) }),
      'b#1': makeObject('b#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#2', bornAt: 4 }, anim: anim(3, 7) }),
      'c#1': makeObject('c#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#3', bornAt: 8 }, anim: anim(3, 11) }),
    },
    effects: {},
    markers: [{ id: 'shot', t: 4 }],
  };
}

function setup(doc: SceneDoc = threeSceneDoc()): Journal {
  let clock = 1_700_000_000_000;
  return createJournal(doc, { now: () => (clock += 1000) });
}

function keyTimes(doc: SceneDoc, id: string): number[] {
  const node = doc.objects[id]?.anim['tf.opacity'];
  if (node === undefined || node.kind !== 'keys') return [];
  return node.keys.map((k) => k.t);
}

function bornAtOf(doc: SceneDoc, id: string): number | undefined {
  return doc.scenes.find((s) => s.id === id)?.bornAt;
}

/* ══════════════════ 分叉 1：镜头边界跟着挪 ══════════════════ */

describe('★ 分叉 1：镜头边界随内容一起顺延', () => {
  it('导演视角（不传 scope）：对象与后两镜一起后移，前镜窗口被撑长', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 4, 3);

    // 对象：t≥4 的关键帧 +3（b#1 的 [3,7] → [3,10]；c#1 的 [3,11] → [3,14]）
    expect(keyTimes(r.doc, 'a#1')).toEqual([0, 3]);
    expect(keyTimes(r.doc, 'b#1')).toEqual([3, 10]);
    expect(keyTimes(r.doc, 'c#1')).toEqual([3, 14]);

    // 镜头：bornAt ≥ 4 的（s#2=4、s#3=8）一起 +3
    expect(bornAtOf(r.doc, 's#1')).toBe(0);
    expect(bornAtOf(r.doc, 's#2')).toBe(7);
    expect(bornAtOf(r.doc, 's#3')).toBe(11);
    expect(r.shiftedScenes).toBe(2);

    // ★ s#1 的窗口从 [0,4) 变成 [0,7)：插入的 3 秒被它吸收，它变长了
    expect(objectTimeWindow(r.doc, r.doc.objects['a#1']!)).toEqual([0, 7]);
    // ★ s#2 的窗口长度不变（[7,11)），只是整体后移
    expect(objectTimeWindow(r.doc, r.doc.objects['b#1']!)).toEqual([7, 11]);
    // 最后一镜到新的片长
    expect(sceneEnd(r.doc, 's#3')).toBe(15);
  });

  it('边界语义：恰好落在 from 上的关键帧【会被】顺延（k.t >= from）', () => {
    const base = threeSceneDoc();
    const doc: SceneDoc = {
      ...base,
      objects: {
        ...base.objects,
        'a#1': makeObject('a#1', 'plot2d', {
          owner: { kind: 'scene', sceneId: 's#1', bornAt: 0 },
          anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 2, v: 0 }] } },
        }),
      },
    };
    expect(keyTimes(shiftTimeline(doc, 2, 3).doc, 'a#1')).toEqual([5]);
    // 严格小于 from 的才不动
    expect(keyTimes(shiftTimeline(doc, 3, 3).doc, 'a#1')).toEqual([2]);
  });

  it('★ 顺延后没有对象被推出自己镜头的【结束】边界（这一步的全部意义）', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 4, 3);
    for (const id of ['a#1', 'b#1', 'c#1']) {
      const win = objectTimeWindow(r.doc, r.doc.objects[id]!);
      const keys = keyTimes(r.doc, id);
      expect(keys.length).toBeGreaterThan(0);
      const last = Math.max(...keys);
      expect(last, id + ' 的最后一个关键帧 ' + last + ' 超出了窗口 ' + JSON.stringify(win)).toBeLessThanOrEqual(win[1]);
    }
    expect(r.collisions).toEqual([]);
  });

  it('★ "整镜用紧"：标记落在镜头边界上时，顺延后内容与边界同步（不溢出右端）', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 4, 3);
    // s#2 的新窗口
    expect(objectTimeWindow(r.doc, r.doc.objects['b#1']!)).toEqual([7, 11]);
    // b#1 的内容 [3,7]：只有 7 被顺延 → [3,10]，右端落在新窗口内
    expect(keyTimes(r.doc, 'b#1')).toEqual([3, 10]);
    // ★ 左端 3 < 7 是【原文档本来就有的前导】：b#1 的淡入从 3s 起，而 s#2 原本
    //   从 4s 才开始 —— 它本来就有 1 秒前导，顺延把窗口推到 7 之后前导变成 4 秒。
    //   retime 只保证【不把内容推出右端】，不替人做"前导该多长"的美学判断。
  });

  it('片长 = duration + delta，且不短于最后一镜的起点', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 4, 3);
    expect(r.doc.meta.duration).toBe(15);

    // 负 delta：整体前移，片长缩短
    const back = shiftTimeline(doc, 4, -1);
    expect(back.doc.meta.duration).toBe(11);
    expect(bornAtOf(back.doc, 's#2')).toBe(3);
    expect(bornAtOf(back.doc, 's#3')).toBe(7);
  });

  it('from 之前没有镜头起点时，镜头表一个都不动', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 9, 5);
    // from=9 时所有 bornAt（0/4/8）都 < 9 → 没有镜头被顺延
    expect(r.shiftedScenes).toBe(0);
    expect(bornAtOf(r.doc, 's#1')).toBe(0);
    expect(bornAtOf(r.doc, 's#2')).toBe(4);
    expect(bornAtOf(r.doc, 's#3')).toBe(8);
    // ⚠️ 但片长照样 +delta：剪辑上这是"尾部留白"，比"顺手砍掉 5 秒"合理。
    //    要收短是显式动作（set_meta / 删镜头），不是 retime 的副作用。
    expect(r.doc.meta.duration).toBe(17);
  });

  it('delta 为 0 时原样返回（连文档引用都不换）', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 4, 0);
    expect(r.doc).toBe(doc);
    expect(r.shiftedScenes).toBe(0);
  });

  it('空镜头表的存量文档不炸（scenes 缺失也当空表处理）', () => {
    const legacy = { ...makeDoc(1) } as Record<string, unknown>;
    delete legacy['scenes'];
    const r = shiftTimeline(legacy as unknown as SceneDoc, 1, 2);
    expect(r.doc.meta.duration).toBe(14);
    expect(r.shiftedScenes).toBe(0);
  });
});

/* ══════════════════ 分叉 2：场景 Agent 顶穿边界要拦 ══════════════════ */

describe('★ 分叉 2：场景 Agent 顺延后越界 → 失败，不静默留下矛盾状态', () => {
  const SCOPE = { kind: 'scene', sceneId: 's#2', start: 4, end: 8 } as const;

  it('delta 会把本镜对象推出镜外 → collisions 非空', () => {
    const doc = threeSceneDoc();
    // b#1 的关键帧最后在 7，s#2 结束在 8；+3 之后到 10 > 8
    const r = shiftTimeline(doc, 2, 3, SCOPE);
    expect(r.collisions).toHaveLength(1);
    const c = r.collisions[0]!;
    expect(c.objectId).toBe('b#1');
    expect(c.sceneId).toBe('s#2');
    expect(c.from).toBe(7);
    expect(c.at).toBe(10);
    // 镜头表在 strict 下【没有】被顺延，所以结束时刻仍是 8
    expect(c.sceneEnd).toBe(8);
    expect(r.shiftedScenes).toBe(0);
  });

  it('delta 够小就正常通过（tightfit：正好贴住本镜结束时刻）', () => {
    const doc = threeSceneDoc();
    // b#1 最后一个关键帧在 7，本镜结束在 8 → 最多顺延 1s
    const r = shiftTimeline(doc, 2, 1, SCOPE);
    expect(r.collisions).toEqual([]);
    expect(keyTimes(r.doc, 'b#1')).toEqual([4, 8]);
    // 别镜的对象与镜头表都没动
    expect(keyTimes(r.doc, 'c#1')).toEqual([3, 11]);
    expect(bornAtOf(r.doc, 's#2')).toBe(4);
    expect(bornAtOf(r.doc, 's#3')).toBe(8);
  });

  it('★ 命令层：越界报 scene_bounds_exceeded，并说清最多能顺延多少', () => {
    const doc = threeSceneDoc();
    const res = applyCommand(
      doc,
      { op: 'retime', fromMarker: 'shot', delta: 3, activeSceneId: 's#2' },
      {},
    );
    expect(res.kind).toBe('failed');
    if (res.kind !== 'failed') return;
    expect(res.error.code).toBe('scene_bounds_exceeded');
    expect(res.error.path).toBe('b#1');
    // 7 → 8 之间只剩 1 秒可顺延
    expect(res.error.message).toContain('1.00s');
    expect(res.error.message).toContain('s#2');
  });

  it('批量回执里进 errored，文档一个字节都不动', () => {
    const j = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'retime', fromMarker: 'shot', delta: 3, activeSceneId: 's#2' }] },
      { journal: j, budget: () => BUDGET, actor: 'agent', now: () => 1_700_000_001_000 },
    );
    expect(res.ok).toEqual([]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['scene_bounds_exceeded']);
    expect(j.currentVersion()).toBe(0);
    expect(j.currentDoc().meta.duration).toBe(12);
  });

  it('导演顺延同样的 delta 却能过（它有权挪镜头表）', () => {
    const j = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'retime', fromMarker: 'shot', delta: 3 }] },
      { journal: j, budget: () => BUDGET, actor: 'agent', now: () => 1_700_000_001_000 },
    );
    expect(res.errored).toEqual([]);
    expect(res.ok).toHaveLength(1);
    const doc = j.currentDoc();
    expect(bornAtOf(doc, 's#2')).toBe(7);
    // 越界问题在导演视角下不存在：对象与镜头一起走
    expect(objectTimeWindow(doc, doc.objects['b#1']!)).toEqual([7, 11]);
  });

  it('★ 场景 Agent 挪不动任何镜头边界（含它自己那一镜）', () => {
    const doc = threeSceneDoc();
    const r = shiftTimeline(doc, 2, 1, SCOPE);
    expect(r.shiftedScenes).toBe(0);
    expect(bornAtOf(r.doc, 's#1')).toBe(0);
    expect(bornAtOf(r.doc, 's#2')).toBe(4);
    expect(bornAtOf(r.doc, 's#3')).toBe(8);
    // 一个直接的推论：本镜窗口保持原样，Agent 只能在【内部】腾挪
    expect(objectTimeWindow(r.doc, r.doc.objects['b#1']!)).toEqual([4, 8]);
  });
});

/* ══════════════════ 与 Journal / patch 的衔接 ══════════════════ */

describe('retime 的 patch 如实记下镜头表的变化', () => {
  it('导演顺延了镜头就有 scenes patch', () => {
    const doc = threeSceneDoc();
    const moved = applyCommand(doc, { op: 'retime', fromMarker: 'shot', delta: 3 }, {});
    if (moved.kind !== 'applied') throw new Error('应当成功');
    expect(moved.patches.map((p) => p.path)).toContain('scenes');
    expect(moved.affectedPaths).toContain('scenes');
  });

  it('from 之后没有镜头起点时不产出 scenes patch（少一条噪声操作记录）', () => {
    const base = threeSceneDoc();
    // 标记挪到 9（在三镜之后），从它往后没有任何镜头起点
    const doc: SceneDoc = { ...base, markers: [{ id: 'late', t: 9 }] };
    const still = applyCommand(doc, { op: 'retime', fromMarker: 'late', delta: 3 }, {});
    if (still.kind !== 'applied') throw new Error('应当成功');
    expect(still.patches.map((p) => p.path)).not.toContain('scenes');
    expect(still.doc.meta.duration).toBe(15);
  });

  it('场景 Agent 视角下永远没有 scenes patch（边界不归它管）', () => {
    const doc = threeSceneDoc();
    const scoped = applyCommand(doc, { op: 'retime', fromMarker: 'shot', delta: 1, activeSceneId: 's#2' }, {});
    if (scoped.kind !== 'applied') throw new Error('应当成功');
    expect(scoped.patches.map((p) => p.path)).not.toContain('scenes');
  });

  it('timeline.owners 里记下顺延了几个镜头', () => {
    const doc = threeSceneDoc();
    const r = applyCommand(doc, { op: 'retime', fromMarker: 'shot', delta: 3 }, {});
    if (r.kind !== 'applied') throw new Error('应当成功');
    const p = r.patches.find((x) => x.path === 'timeline.owners');
    expect((p?.after as { scenes: number }).scenes).toBe(2);
  });

  it('一条 retime 仍然只产生一个 Operation / 一个 compound（P12 第 5 条不变）', () => {
    const j = setup();
    const res = applyCommands(
      { baseVersion: 0, commands: [{ index: 0, op: 'retime', fromMarker: 'shot', delta: 3 }] },
      { journal: j, budget: () => BUDGET, actor: 'agent', turnId: 't1', now: () => 1_700_000_001_000 },
    );
    expect(res.ok).toHaveLength(1);
    expect(j.operations()).toHaveLength(1);
    expect(j.compounds()).toHaveLength(1);
  });
});
