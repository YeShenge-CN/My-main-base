/**
 * 关键帧编辑（§7 第 4 条）。
 *
 * ★ 这一份守的是【编辑规则】而不是"能不能拖"：
 *   拖动最终落到一条 `set_motion`（**整条轨道替换**），所以一次算错
 *   就是把整条动画写坏。规则有三条，每条都有断言：
 *     1. 吸附帧网格、夹进 [0, duration]；
 *     2. 不许越过邻居（越过之后"第几个手柄"指谁就变了）；
 *     3. 插帧不改变动画形状（取值 = 那一刻求值出来的值）。
 *
 * 端到端那半（经 Journal 真的写进文档、且能撤销）也在这里 —— 面板没有 DOM 测试环境，
 * 所以"纯函数对了"必须再补一句"它产出的命令真的落盘了"。
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createJournal,
  evaluateObjectAnim,
  type AnimTrack,
  type Command,
  type SceneDoc,
  type SceneObject,
} from '@sva/engine-core';
import {
  animatedValueAt,
  insertKeyAt,
  keyframeRows,
  moveKey,
  removeKey,
  snapTime,
  sortedKeys,
  trackOf,
} from '../src/keyframes';

const NO_BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };
const BOUNDS = { duration: 8, fps: 60 } as const;

function obj(anim: Record<string, AnimTrack> = {}): SceneObject {
  return {
    shape: 'plot2d',
    owner: { kind: 'global' },
    params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 4 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim,
    effects: [],
  };
}

const fade: AnimTrack = {
  kind: 'keys',
  keys: [
    { t: 0, v: 0 },
    { t: 1.2, v: 1, ease: 'easeOutCubic' },
  ],
};

function docWith(object: SceneObject): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 8, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['plot#1'] }],
    objects: { 'plot#1': object },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

/* ── 行 ─────────────────────────────────────────────────────── */

describe('手柄行', () => {
  it('按键轨道出行、给出手柄；expr 轨道也出行（只读，说明它不是丢了）', () => {
    const rows = keyframeRows(obj({ 'tf.opacity': fade, 'style.width': { kind: 'expr', expr: '3+t' } }));
    expect(rows.map((r) => [r.track, r.kind])).toEqual([
      ['tf.opacity', 'keys'],
      ['style.width', 'expr'],
    ]);
    expect(rows[0]?.keys).toHaveLength(2);
    expect(rows[1]?.expr).toBe('3+t');
  });

  it('★ 文档里顺序乱了也按 t 升序显示（"第几个手柄"必须与看到的一致）', () => {
    const messy: AnimTrack = { kind: 'keys', keys: [{ t: 5, v: 1 }, { t: 0, v: 0 }, { t: 2, v: 0.5 }] };
    expect(sortedKeys(messy.keys).map((k) => k.t)).toEqual([0, 2, 5]);
    expect(keyframeRows(obj({ 'tf.opacity': messy }))[0]?.keys.map((k) => k.t)).toEqual([0, 2, 5]);
  });
});

/* ── 拖动 ───────────────────────────────────────────────────── */

describe('拖动手柄：吸附 / 夹住 / 不越邻居', () => {
  const keys = sortedKeys(fade.keys);

  it('吸附到帧网格（1/60 秒一格）', () => {
    expect(snapTime(0.507, 60, 8)).toBeCloseTo(30 / 60, 10);
    expect(snapTime(1.017, 60, 8)).toBeCloseTo(61 / 60, 10);
  });

  it('夹进 [0, duration]：拖出画布外也不会跑到镜头外面去', () => {
    expect(snapTime(-3, 60, 8)).toBe(0);
    expect(snapTime(99, 60, 8)).toBe(8);
    expect(moveKey(keys, 0, -5, BOUNDS)[0]?.t).toBe(0);
    expect(moveKey(keys, 1, 99, BOUNDS)[1]?.t).toBe(8);
  });

  it('★ 不许越过邻居：每个方向留一帧的间隙', () => {
    // 第一帧往后拖到 5s，但它右边站着 1.2s 的那帧 → 最多停在 1.2 - 1/60
    const moved = moveKey(keys, 0, 5, BOUNDS);
    expect(moved[0]?.t).toBeCloseTo(1.2 - 1 / 60, 10);
    // 反过来同理
    const back = moveKey(keys, 1, -5, BOUNDS);
    expect(back[1]?.t).toBeCloseTo(1 / 60, 10);
  });

  it('★ 夹住之后顺序不变（否则"第 index 个"会指到别人身上）', () => {
    const moved = moveKey(keys, 0, 99, BOUNDS);
    expect(moved.map((k) => k.t)).toEqual([...moved.map((k) => k.t)].sort((a, b) => a - b));
    expect(moved).toHaveLength(2);
  });

  it('只改时刻，取值与缓动原样保留（拖动不是重写轨道）', () => {
    const moved = moveKey(keys, 1, 2, BOUNDS);
    expect(moved[1]).toMatchObject({ v: 1, ease: 'easeOutCubic' });
  });

  it('index 越界时原样返回，不抛', () => {
    expect(moveKey(keys, 9, 1, BOUNDS)).toEqual(keys);
    expect(moveKey([], 0, 1, BOUNDS)).toEqual([]);
  });
});

/* ── 删 / 插 ────────────────────────────────────────────────── */

describe('删一个 / 插一个', () => {
  const keys = sortedKeys(fade.keys);

  it('删掉指定那一个', () => {
    expect(removeKey(keys, 0).map((k) => k.t)).toEqual([1.2]);
  });

  it('★ 删空返回 []（调用方据此删整条轨道 —— 空轨道是校验错误 anim_track_empty）', () => {
    expect(removeKey(removeKey(keys, 0), 0)).toEqual([]);
    expect(trackOf([])).toBeNull();
    expect(trackOf(keys)).toEqual({ kind: 'keys', keys: [...keys] });
  });

  it('插入的帧取值 = 该时刻求值出来的值（★ 插帧不改变动画形状）', () => {
    const o = obj({ 'tf.opacity': fade });
    const before = animatedValueAt(o, 'tf.opacity', 0.6);
    const next = insertKeyAt(o, 'tf.opacity', keys, 0.6, BOUNDS);
    expect(next).not.toBeNull();
    const inserted = (next ?? []).find((k) => Math.abs(k.t - 0.6) < 1 / 60);
    expect(inserted?.v).toBe(before);
    // 形状不变：插帧前后在若干时刻的求值完全一致
    for (const t of [0, 0.3, 0.6, 0.9, 1.2, 2]) {
      const a = animatedValueAt(o, 'tf.opacity', t);
      const b = animatedValueAt({ ...o, anim: { 'tf.opacity': { kind: 'keys', keys: next ?? [] } } }, 'tf.opacity', t);
      expect(b).toBeCloseTo(Number(a), 10);
    }
  });

  it('★ 插帧用的是引擎的求值（缓动生效）—— 而 ease 标在【左端】关键帧上才有效', () => {
    // ⚠️ 我第一版把 ease 标在了【右端】那一帧上，于是拿到的是线性 0.5，
    //    还以为是插值的 bug。引擎的口径是"区间按【左端关键帧】的 ease 插值"，
    //    也就是"这一段用它"（registry 里 motion.key.ease 的描述也是这么写的）。
    const eased: AnimTrack = {
      kind: 'keys',
      keys: [
        { t: 0, v: 0, ease: 'easeOutCubic' },
        { t: 1.2, v: 1 },
      ],
    };
    const o = obj({ 'tf.opacity': eased });
    // easeOutCubic(0.5) = 1 - 0.5^3 = 0.875
    expect(Number(animatedValueAt(o, 'tf.opacity', 0.6))).toBeCloseTo(0.875, 10);
    // 而 fade 那份的 ease 标在右端 → 对它无效，就是线性
    expect(Number(animatedValueAt(obj({ 'tf.opacity': fade }), 'tf.opacity', 0.6))).toBeCloseTo(0.5, 10);
  });

  it('同一帧里已经有关键帧 → 不插（返回 null）；隔了一帧就可以插', () => {
    const o = obj({ 'tf.opacity': fade });
    // 1.2s 与它附近不足半帧的时间都吸附到同一帧 → 不许插
    expect(insertKeyAt(o, 'tf.opacity', keys, 1.2, BOUNDS)).toBeNull();
    expect(insertKeyAt(o, 'tf.opacity', keys, 1.2 + 1 / 200, BOUNDS)).toBeNull();
    // 隔一帧就是另一个位置了 → 可以插（插出来落在帧网格上）
    const next = insertKeyAt(o, 'tf.opacity', keys, 1.2 + 1 / 60, BOUNDS);
    expect(next).not.toBeNull();
    expect((next ?? []).some((k) => Math.abs(k.t - (1.2 + 1 / 60)) < 1e-9)).toBe(true);
  });

  it('未登记的 zone（params.*）→ 拿不到值，不插', () => {
    const o = obj({ 'tf.opacity': fade });
    expect(animatedValueAt(o, 'params.samples', 1)).toBeNull();
    expect(insertKeyAt(o, 'params.samples', keys, 1, BOUNDS)).toBeNull();
  });
});

/* ── 端到端：经 Journal 真的写进文档，且一次手势一次撤销 ─────── */

describe('产出的命令经 Journal 落到文档上', () => {
  function commit(doc: SceneDoc, commands: readonly Command[]): SceneDoc {
    let clock = 1_700_000_000_000;
    const j = createJournal(doc, { now: () => (clock += 1000) });
    applyCommands({ baseVersion: j.currentVersion(), commands: [...commands] }, {
      journal: j,
      budget: () => NO_BUDGET,
      actor: 'user',
      gestureId: 'kf-1',
      now: () => (clock += 1000),
    });
    return j.currentDoc();
  }

  function setMotion(keys: readonly { t: number; v: unknown }[] | null): Command {
    return {
      op: 'set_motion',
      target: 'plot#1',
      field: 'tf.opacity',
      node: keys === null ? null : ({ kind: 'keys', keys } as AnimTrack),
    };
  }

  it('拖一个手柄 → 文档里那条轨道的时刻真的变了', () => {
    const doc = docWith(obj({ 'tf.opacity': fade }));
    const keys = sortedKeys(fade.keys);
    const moved = moveKey(keys, 1, 3, BOUNDS);
    const after = commit(doc, [setMotion(moved as { t: number; v: unknown }[])]);
    const track = after.objects['plot#1']?.anim['tf.opacity'];
    expect(track?.kind).toBe('keys');
    if (track?.kind !== 'keys') return;
    expect(track.keys.map((k) => k.t)).toEqual([0, 3]);
    expect(track.keys[1]?.v).toBe(1);
  });

  it('删掉最后一个关键帧 → 整条轨道被删掉（不留空轨道）', () => {
    const doc = docWith(obj({ 'tf.opacity': { kind: 'keys', keys: [{ t: 1, v: 1 }] } }));
    const after = commit(doc, [setMotion(null)]);
    expect(after.objects['plot#1']?.anim['tf.opacity']).toBeUndefined();
  });

  it('★ 一次手势一次撤销：拖歪了能整条撤回来', () => {
    let clock = 1_700_000_000_000;
    const doc = docWith(obj({ 'tf.opacity': fade }));
    const j = createJournal(doc, { now: () => (clock += 1000) });
    const moved = moveKey(sortedKeys(fade.keys), 1, 3, BOUNDS);
    applyCommands(
      { baseVersion: j.currentVersion(), commands: [setMotion(moved as { t: number; v: unknown }[])] },
      { journal: j, budget: () => NO_BUDGET, actor: 'user', gestureId: 'kf-1', now: () => (clock += 1000) },
    );
    const cmp = j.compounds()[0];
    expect(cmp?.settled).toBe(true);
    j.revertCompound(cmp?.compoundId ?? '');
    const track = j.currentDoc().objects['plot#1']?.anim['tf.opacity'];
    if (track?.kind !== 'keys') throw new Error('轨道没了');
    expect(track.keys.map((k) => k.t)).toEqual([0, 1.2]);
  });

  it('插帧之后求值不变（端到端再确认一次：文档里那两个时刻的画面是一样的）', () => {
    const o = obj({ 'tf.opacity': fade });
    const keys = sortedKeys(fade.keys);
    const next = insertKeyAt(o, 'tf.opacity', keys, 0.6, BOUNDS) ?? [];
    const doc = commit(docWith(o), [setMotion(next as { t: number; v: unknown }[])]);
    const after = doc.objects['plot#1'];
    if (after === undefined) throw new Error('对象没了');
    for (const t of [0.3, 0.6, 0.9]) {
      expect(evaluateObjectAnim(after, t).tf.opacity).toBeCloseTo(Number(animatedValueAt(o, 'tf.opacity', t)), 10);
    }
  });
});
