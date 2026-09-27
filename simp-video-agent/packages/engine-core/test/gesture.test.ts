/**
 * 【一次手势 = 一个可撤销单元】。
 *
 * ★ 这一份补的是一个只在面板里看得见的缺口：
 *   journal 的 compound 分组键是 `turnId ?? gestureId ?? 'solo-N'`，
 *   而 `applyCommands` 以前只转发 `turnId`（那是 Agent 的轮次 id），
 *   `gestureId` 从来没被传下去过。后果有两层：
 *     1. 一次用户手势里的多条命令被拆成多个 compound（"加一镜"= add_scene + set_meta，
 *        点一次撤销只撤掉后半截，留下一个零长度的镜头）；
 *     2. 用户手势的 compound 从来没人 settle —— 面板的"撤销这一轮"按钮**永远是灰的**。
 *   （journal 的注释写着"用户手势由调用方显式 settle"，而实际上没有任何调用方做。）
 *
 * 所以这一份要钉住三件事：分组、置位、以及"不传时就该是旧行为"。
 */
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import type { Command } from '../src/command/commands';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

const NO_BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

function rect(): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

function docWithRect(): SceneDoc {
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1'] }],
    objects: { 'rect#1': rect() },
    markers: [],
  };
}

/** 两条互不相关的命令：一次手势里最典型的形状。 */
const TWO: readonly Command[] = [
  { op: 'set_style', target: 'rect#1', width: 5 },
  { op: 'set_transform', target: 'rect#1', y: 1.5 },
];

function setup() {
  let clock = 1_700_000_000_000;
  const j = createJournal(docWithRect(), { now: () => (clock += 1000) });
  return { j, now: () => (clock += 1000) };
}

describe('gestureId：一次手势一个 compound，且提交完就置为可撤销', () => {
  it('两条命令落进【同一个】compound，且已 settled', () => {
    const { j, now } = setup();
    const res = applyCommands({ baseVersion: j.currentVersion(), commands: [...TWO] }, {
      journal: j, budget: () => NO_BUDGET, actor: 'user', gestureId: 'g1', now,
    });
    expect(res.ok).toHaveLength(2);
    const cs = j.compounds();
    expect(cs).toHaveLength(1);
    expect(cs[0]?.opIds).toHaveLength(2);
    expect(cs[0]?.settled).toBe(true);
    // 一次撤销把那两条一起撤回来
    const id = cs[0]?.compoundId ?? '';
    j.revertCompound(id);
    expect(j.currentDoc().objects['rect#1']?.style['width']).toEqual({ v: 2 });
    expect(j.currentDoc().objects['rect#1']?.tf.y).toBe(0);
  });

  it('同一个 gestureId 的第二批追加进同一个 compound（手势可以分几批提交）', () => {
    const { j, now } = setup();
    const deps = { journal: j, budget: () => NO_BUDGET, actor: 'user' as const, gestureId: 'g1', now };
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_style', target: 'rect#1', width: 5 }] }, deps);
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_transform', target: 'rect#1', y: 2 }] }, deps);
    expect(j.compounds()).toHaveLength(1);
    expect(j.compounds()[0]?.opIds).toHaveLength(2);
  });

  it('★ 不传 gestureId = 旧行为：每条命令各自一个 compound，且都不是 settled', () => {
    const { j, now } = setup();
    applyCommands({ baseVersion: j.currentVersion(), commands: [...TWO] }, {
      journal: j, budget: () => NO_BUDGET, actor: 'user', now,
    });
    const cs = j.compounds();
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.opIds.length)).toEqual([1, 1]);
    expect(cs.every((c) => !c.settled)).toBe(true);
  });

  it('★ Agent 的轮次路径不受影响：turnId 仍然要等 Runtime 显式 settle', () => {
    const { j, now } = setup();
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_style', target: 'rect#1', width: 5 }] }, {
      journal: j, budget: () => NO_BUDGET, actor: 'agent', turnId: 't1', now,
    });
    const c = j.compounds()[0];
    // 一轮还没结束 → 不许撤（这正是"撤销到一半的 Agent"防护）
    expect(c?.settled).toBe(false);
    j.settle('t1');
    expect(j.compounds()[0]?.settled).toBe(true);
  });

  it('★ 两个都给时按 turnId 分组（分组的真源是轮次，gesture 只是它的替代品）', () => {
    const { j, now } = setup();
    const deps = {
      journal: j, budget: () => NO_BUDGET, actor: 'agent' as const, turnId: 't1', gestureId: 'g1', now,
    };
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_style', target: 'rect#1', width: 5 }] }, deps);
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_transform', target: 'rect#1', y: 2 }] }, deps);
    expect(j.compounds()).toHaveLength(1);
    expect(j.compounds()[0]?.turnId).toBe('t1');
    // 给了 turnId 时【不】由 gesture 顺手置位：轮次的生命周期归 Runtime
    expect(j.compounds()[0]?.settled).toBe(false);
  });

  it('一条命令都没提交成功时不会凭空造出 compound', () => {
    const { j, now } = setup();
    applyCommands({ baseVersion: j.currentVersion(), commands: [{ op: 'set_style', target: 'nope#9', width: 5 }] }, {
      journal: j, budget: () => NO_BUDGET, actor: 'user', gestureId: 'g1', now,
    });
    expect(j.compounds()).toHaveLength(0);
  });
});
