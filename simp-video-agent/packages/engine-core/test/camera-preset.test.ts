import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { sampleCamera } from '../src/camera';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * 相机预设的语义。
 *
 * ★ 语义是"**替换**整条相机轨"，不是追加。这条原来是追加的，而且没有任何测试守着，
 *   所以它一直有两个问题：
 *     1. 点两次"推近"会得到两段推近（第一段还没结束第二段就接上），
 *        而用户看到的是一个按钮，期待的是"让镜头推近"这一个状态；
 *     2. 没法复位。
 *   现在 pushIn / pullOut / reset 都替换，并且 pullOut 与 reset 是新增的。
 */

function shot(): SceneDoc {
  return makeDoc(1);
}

function run(doc: SceneDoc, commands: readonly Command[]) {
  const journal = createJournal(doc, { now: () => 1_700_000_000_000 });
  const res = applyCommands({ baseVersion: 0, commands }, {
    journal,
    budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
    actor: 'user',
    now: () => 1_700_000_001_000,
  });
  expect(res.errored).toEqual([]);
  return { journal, doc: journal.currentDoc() };
}

const pushIn = (over: Partial<Command> = {}): Command =>
  ({ op: 'camera_preset', preset: 'pushIn', subject: 'plot#1', duration: 3, intensity: 0.5, ...over }) as Command;

describe('相机预设：替换而不是追加', () => {
  it('pushIn 生成两个关键帧，并把主体放到视口中心', () => {
    const { doc } = run(shot(), [pushIn()]);
    expect(doc.camera.keys.length).toBe(2);
    const [a, b] = doc.camera.keys;
    expect(a?.t).toBe(0);
    expect(a?.scale).toBe(1);
    expect(b?.t).toBe(3);
    expect(b?.scale).toBeCloseTo(1 + 0.5 * 1.5, 9);
    // pivot = 主体位置（世界坐标）
    expect(a?.pivot).toEqual([0, 0]);
    // 注视点落在视口中心：这是坐标契约的直接后果
    const cam = sampleCamera(doc.camera, 1.5);
    expect(cam.scale).toBeGreaterThan(1);
  });

  it('连点两次不会叠出四段关键帧（这就是"替换"的意义）', () => {
    const first = run(shot(), [pushIn()]);
    const second = run(first.doc, [{ op: 'camera_preset', preset: 'pushIn', subject: 'plot#1', duration: 2, intensity: 0.5 }]);
    expect(second.doc.camera.keys.length).toBe(2);
    expect(second.doc.camera.keys[1]?.t).toBe(2);
  });

  it('pullOut 从近处拉开（起点是放大的）', () => {
    const { doc } = run(shot(), [pushIn({ preset: 'pullOut', duration: 2, intensity: 0.4 })]);
    const [a, b] = doc.camera.keys;
    expect(a?.scale).toBeCloseTo(1 + 0.4 * 1.5, 9);
    expect(b?.scale).toBe(1);
    expect(a?.ease).toBe('easeInOutCubic');
  });

  it('reset 回到一个静止的恒等关键帧', () => {
    const zoomed = run(shot(), [pushIn()]);
    expect(zoomed.doc.camera.keys.length).toBe(2);
    const reset = run(zoomed.doc, [{ op: 'camera_preset', preset: 'reset' }]);
    expect(reset.doc.camera.keys).toEqual([
      { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] },
    ]);
  });

  it('duration 非法时报 errored，而不是生成一段零长度的运动', () => {
    const journal = createJournal(shot(), { now: () => 0 });
    const res = applyCommands(
      { baseVersion: 0, commands: [pushIn({ duration: 0 })] },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'user', now: () => 1 },
    );
    expect(res.errored[0]?.error.code).toBe('invalid_argument');
    expect(journal.currentDoc().camera.keys.length).toBe(1);
  });

  it('主体不存在时报 unknown_target', () => {
    const journal = createJournal(shot(), { now: () => 0 });
    const res = applyCommands(
      { baseVersion: 0, commands: [pushIn({ subject: 'ghost#9' })] },
      { journal, budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }), actor: 'user', now: () => 1 },
    );
    expect(res.errored[0]?.error.code).toBe('unknown_target');
  });
});

describe('相机预设可撤销', () => {
  it('撤销一次推近 → 相机回到原来的一帧（逆操作是 set_camera，不是另一个预设）', () => {
    const { journal } = run(shot(), [pushIn()]);
    const compoundId = journal.compounds()[0]?.compoundId;
    if (compoundId === undefined) throw new Error('缺 compound');
    journal.settleCompound(compoundId);
    const r = journal.revertCompound(compoundId);
    expect(r.kind).toBe('reverted');
    const keys = journal.currentDoc().camera.keys;
    expect(keys.length).toBe(1);
    expect(keys[0]?.scale).toBe(1);
  });
});
