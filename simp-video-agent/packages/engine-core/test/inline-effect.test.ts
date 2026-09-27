import { describe, expect, it } from 'vitest';
import { autoFix, validate } from '../src/validate/index';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { fieldValues } from '../src/doc/fields';
import { evaluate } from '../src/evaluate';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * 一条【内联 effect】的 create_plot 落盘后，drawOn 的时长必须原样保留。
 *
 * 这条测试来自压力测试的一条真实 trace：模型两次内联 `duration: 2.5`，
 * 回执两次报 `autofixed: [{code:"drawon_duration_nonpositive"}]` 并把时长夹到 0.2，
 * 于是模型每次都要在多花一轮把它改回 2.5 —— 一直在跟引擎打架。
 * drawon_duration_nonpositive 只应在 duration ≤ 0 时出现。
 */

function emptyDoc(): SceneDoc {
  const base = makeDoc(0);
  return {
    ...base,
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [] }],
    objects: {},
    effects: {},
  };
}

const createWithEffect: Command = {
  op: 'create_plot',
  localId: 'sinc',
  expr: 'sin(x)/x',
  domain: [-15, 15],
  samples: 1500,
  style: { stroke: '#4fc3f7', width: 2.5, glow: 0.35 },
  effect: { type: 'drawOn', params: { start: 0.2, duration: 2.5, mode: 'domain', tip: true } },
  owner: { kind: 'scene', sceneId: 's1' },
};

function clock(): () => number {
  let c = 1_700_000_000_000;
  return () => (c += 1000);
}

describe('create_plot 的内联 drawOn 时长不该被引擎改掉', () => {
  it('duration=2.5 落盘后就是 2.5，且不报 drawOn 相关的问题', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    const res = applyCommands({ baseVersion: 0, commands: [createWithEffect] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    expect(res.ok.length).toBe(1);
    expect(res.errored).toEqual([]);

    const doc = journal.currentDoc();
    const eff = doc.effects['eff#1'];
    expect(eff).toBeDefined();
    expect(fieldValues(eff?.params ?? {})['duration']).toBe(2.5);
    expect(fieldValues(eff?.params ?? {})['start']).toBe(0.2);
    expect(fieldValues(eff?.params ?? {})['mode']).toBe('domain');

    // 这一批的 autoFix 不该动 drawOn
    expect(res.autofixed).toEqual([]);

    // 只允许"表达式在 x=0 处取不到有限值"这一类语义提示：
    // sin(x)/x 在原点确实是 0/0 —— 那是可去奇点，不是表达式写错。
    // 它不该被判成 error，更不该触发任何自动修。
    const issues = validate(doc);
    expect(issues.filter((i) => i.group === 'motion')).toEqual([]);
    expect(issues.filter((i) => i.fixClass === 'auto')).toEqual([]);
  });

  it('诊断：autoFix 到底修了什么、把什么改成了什么', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    applyCommands({ baseVersion: 0, commands: [createWithEffect] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const doc = journal.currentDoc();
    const issues = validate(doc);
    console.log('DIAG issues=' + JSON.stringify(issues.map((i) => ({ code: i.code, path: i.path, fixClass: i.fixClass, fix: i.suggestedFix }))));
    console.log('DIAG docDuration=' + JSON.stringify(fieldValues(doc.effects['eff#1']?.params ?? {})));
    const result = autoFix({ journal, now: clock() });
    console.log('DIAG fixed=' + JSON.stringify(result.fixed));
    console.log('DIAG after=' + JSON.stringify(fieldValues(journal.currentDoc().effects['eff#1']?.params ?? {})));
  });

  it('autoFix 跑一轮也不该把 2.5 夹成 0.2', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    applyCommands({ baseVersion: 0, commands: [createWithEffect] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const result = autoFix({ journal, now: clock() });
    expect(result.fixed).toEqual([]);
    expect(fieldValues(journal.currentDoc().effects['eff#1']?.params ?? {})['duration']).toBe(2.5);
  });

  it('生长动画真的能看见：2.5 秒内可见比例在推进（而不是一直 0 或一上来就 1）', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    applyCommands({ baseVersion: 0, commands: [createWithEffect] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const doc = journal.currentDoc();
    const at = (t: number): number => evaluate(doc, t).items[0]?.visibleFraction ?? -1;
    expect(at(0.2)).toBe(0); // drawOn 还没开始
    expect(at(1.45)).toBeGreaterThan(0);
    expect(at(1.45)).toBeLessThan(1);
    expect(at(2.7)).toBe(1);
  });

  it('duration 真的非法（0）时，才应该报 drawon_duration_nonpositive 并夹到下限', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    const bad: Command = {
      ...createWithEffect,
      effect: { type: 'drawOn', params: { start: 0, duration: 0, mode: 'arc', tip: false } },
    };
    applyCommands({ baseVersion: 0, commands: [bad] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const codes = validate(journal.currentDoc()).map((i) => i.code);
    expect(codes).toContain('drawon_duration_nonpositive');

    autoFix({ journal, now: clock() });
    const fixedDuration = fieldValues(journal.currentDoc().effects['eff#1']?.params ?? {})['duration'];
    expect(fixedDuration).toBe(0.2);
  });

  /**
   * ★ 这一条来自三次真实运行的稳定复现：模型把效果参数写在 effect 的【顶层】
   *   （少了 params 一层），于是 params 落地成 {}，duration 变成"缺失"。
   *   旧的回执说"时长是 0，曲线永远画不出来"，模型完全看不出层级写错了。
   */
  it('有效果但没写 duration：报 missing（而不是 nonpositive），并补一个看得见的时长', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    const noParams: Command = {
      ...createWithEffect,
      effect: { type: 'drawOn' },
    };
    applyCommands({ baseVersion: 0, commands: [noParams] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    const issues = validate(journal.currentDoc());
    const hit = issues.find((i) => i.path === 'eff#1.params.duration');
    expect(hit?.code).toBe('drawon_duration_missing');
    expect(hit?.message).toContain('params');
    // 不能和"值非法"共用一个 code —— 那是模型唯一能据以纠错的信息
    expect(issues.some((i) => i.code === 'drawon_duration_nonpositive')).toBe(false);

    const result = autoFix({ journal, now: clock() });
    expect(result.fixed.length).toBe(1);
    // 补的是"看得见在生长"的 2 秒，而不是技术下限 0.2
    expect(fieldValues(journal.currentDoc().effects['eff#1']?.params ?? {})['duration']).toBe(2);
  });
});
