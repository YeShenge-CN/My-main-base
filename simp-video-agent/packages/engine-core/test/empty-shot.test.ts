import { describe, expect, it } from 'vitest';
import { autoFix, validate } from '../src/validate/index';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * 空镜头的完整闭环。
 *
 * completion 臂实测：空文档带 issues=0 通过全部校验器，于是"做完了"和
 * "什么都没做/做不了"在引擎侧不可区分（#19/#20 就是被记成"一次写入都没成功"）。
 * 补上 export/empty_shot 之后，还要保证它【会自己消失】——
 * 一条永远报着的问题和没有这条规则一样有害。
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

const createPlot: Command = {
  op: 'create_plot',
  localId: '$c1',
  expr: 'sin(x)',
  domain: [-6, 6],
  samples: 800,
  owner: { kind: 'scene', sceneId: 's1' },
};

function clock(): () => number {
  let c = 1_700_000_000_000;
  return () => (c += 1000);
}

describe('空镜头：报得出来，也会自己消失', () => {
  it('空文档：get_scene_summary 报的 issues=1，且就是 empty_shot', () => {
    const doc = emptyDoc();
    const issues = validate(doc);
    expect(issues.length).toBe(1);
    expect(issues[0]?.code).toBe('empty_shot');
    expect(issues[0]?.fixClass).toBe('agent');
  });

  it('建出对象之后 empty_shot 自行消失（不是靠忽略）', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    applyCommands({ baseVersion: 0, commands: [createPlot] }, {
      journal,
      budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
      actor: 'agent',
      now: clock(),
    });
    expect(validate(journal.currentDoc())).toEqual([]);
  });

  it('autoFix 不会为了消掉 empty_shot 而自己造内容', () => {
    const journal = createJournal(emptyDoc(), { now: clock() });
    const result = autoFix({ journal, now: clock() });
    expect(result.fixed).toEqual([]);
    expect(Object.keys(journal.currentDoc().objects)).toEqual([]);
    // 这条问题仍然在（它是 agent 类，只能由人/模型决定怎么办）
    expect(validate(journal.currentDoc()).map((i) => i.code)).toEqual(['empty_shot']);
  });
});
