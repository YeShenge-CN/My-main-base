/**
 * 多镜头串行运行器（P12 最后一块）。
 *
 * `runMultiShot` 本身要真调模型，所以这里只测它**不依赖模型**的两件事：
 *   1. 逐镜任务怎么排（顺序、fallback、边界从哪来）
 *   2. 身份与撤销粒度：每镜一个 scope + 每镜一个 turnId
 *      —— 第二条是"撤销这一轮"能不能只撤一镜的【唯一】依据，
 *      而它一旦错了，用户点一下会把整片撤掉。
 */
import { describe, expect, it } from 'vitest';
import { createJournal, type SceneDoc, type SceneObject } from '@sva/engine-core';
import { sceneScopedTask } from '../src/runtime';
import { compoundIdForScene, resolveShotTasks, shotProbeTime, turnIdForScene, visibleItemCount } from '../src/multi-shot';
import { applyCommands } from '@sva/engine-core';
import { makeDoc, makeObject, withScenes } from '../../engine-core/test/fixtures';

/** 三镜文档，各镜一个对象。 */
function threeShotDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  const own = (id: string, sceneId: string, bornAt: number): SceneObject =>
    makeObject(id, 'plot2d', { owner: { kind: 'scene', sceneId, bornAt } });
  return {
    ...withScenes(base, [
      { id: 's#1', name: '开场', bornAt: 0 },
      { id: 's#2', name: '主体', bornAt: 4 },
      { id: 's#3', name: '收尾', bornAt: 8 },
    ]),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'c#1'] }],
    objects: {
      'a#1': own('a#1', 's#1', 0),
      'b#1': own('b#1', 's#2', 4),
      'c#1': own('c#1', 's#3', 8),
    },
    effects: {},
    markers: [],
  };
}

describe('resolveShotTasks：逐镜任务怎么排', () => {
  it('按 sceneOrder 排（表的数组顺序不是真源），边界来自 sceneEnd', () => {
    const doc = threeShotDoc();
    const shuffled: SceneDoc = { ...doc, scenes: [doc.scenes[2]!, doc.scenes[0]!, doc.scenes[1]!] };
    const out = resolveShotTasks(shuffled, undefined, '画点什么');
    expect(out.map((x) => x.sceneId)).toEqual(['s#1', 's#2', 's#3']);
    expect(out.map((x) => [x.start, x.end])).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
    ]);
  });

  it('给逐镜任务时按 id 对上；没给的镜用 fallback', () => {
    const out = resolveShotTasks(threeShotDoc(), [{ sceneId: 's#2', task: '画一条波包' }], '兜底任务');
    expect(out.map((x) => x.task)).toEqual(['兜底任务', '画一条波包', '兜底任务']);
  });

  it('既没逐镜任务也没 fallback → 空数组（调用方自己决定要不要跑）', () => {
    expect(resolveShotTasks(threeShotDoc(), undefined, undefined)).toEqual([]);
  });

  it('空镜头表 → 空数组（runMultiShot 会退化成"跑一次全片"）', () => {
    expect(resolveShotTasks(makeDoc(1), undefined, '随便')).toEqual([]);
  });
});

describe('sceneScopedTask：模型必须知道自己的边界', () => {
  it('★ 写明镜头 id 与时间范围，并说清"不用也不要指定 sceneId"', () => {
    const t = sceneScopedTask('画一条正弦曲线', 's#2', 4, 8);
    expect(t).toContain('s#2');
    expect(t).toContain('4');
    expect(t).toContain('8');
    expect(t).toContain('不用也不要指定 sceneId');
    // 原始任务必须原样在里面，不能被改写
    expect(t).toContain('画一条正弦曲线');
    // 说清它改不了什么（否则模型会去试片长/镜头表）
    expect(t).toContain('改不了其它镜头');
  });
});

describe('★ 身份与撤销粒度：每镜一个 turnId', () => {
  function setup(doc: SceneDoc) {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  /** 模拟"第 index 镜的 Agent 建了一个对象"。 */
  function runSceneAgent(journal: ReturnType<typeof setup>, sceneId: string, start: number, end: number, expr: string): void {
    const turnId = turnIdForScene(sceneId);
    const before = journal.currentVersion();
    const res = applyCommands(
      {
        baseVersion: before,
        commands: [
          {
            op: 'create_plot',
            localId: '$c1',
            expr,
            domain: [-7, 7],
            // ★ 模型不指定 sceneId（写 null）—— 由 scope 推导
            owner: { kind: 'scene', sceneId: null },
          } as never,
        ],
      },
      {
        journal,
        budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
        actor: 'agent',
        turnId,
        scope: { kind: 'scene', sceneId, start, end },
        now: () => 1_700_000_001_000,
      },
    );
    expect(res.errored).toEqual([]);
    journal.settle(turnId);
  }

  it('★ 两个镜的 Agent 各建一个对象，各自落在自己那一镜', () => {
    const journal = setup(threeShotDoc());
    runSceneAgent(journal, 's#1', 0, 4, 'sin(x)');
    runSceneAgent(journal, 's#2', 4, 8, 'cos(x)');

    const doc = journal.currentDoc();
    const owners = Object.entries(doc.objects)
      .filter(([id]) => id.startsWith('plot#'))
      .map(([, o]) => (o.owner.kind === 'scene' ? o.owner.sceneId : '?'));
    expect(owners.sort()).toEqual(['s#1', 's#2']);
  });

  it('★★ "撤销这一镜"只撤那一镜 —— compound 按镜头分开', () => {
    const journal = setup(threeShotDoc());
    runSceneAgent(journal, 's#1', 0, 4, 'sin(x)');
    runSceneAgent(journal, 's#2', 4, 8, 'cos(x)');
    expect(Object.keys(journal.currentDoc().objects).filter((id) => id.startsWith('plot#'))).toHaveLength(2);

    // 撤销第一镜那一轮
    const c = journal.compounds().find((x) => x.compoundId === compoundIdForScene('s#1'));
    expect(c, '第一镜必须有自己的 compound').toBeDefined();
    const r = journal.revertCompound(compoundIdForScene('s#1'));
    expect(r.kind).toBe('reverted');

    const left = Object.keys(journal.currentDoc().objects).filter((id) => id.startsWith('plot#'));
    // 第二镜的对象必须还在 —— 撤一镜不该动到别人
    expect(left).toHaveLength(1);
    expect(journal.currentDoc().objects[left[0]!]?.owner).toMatchObject({ sceneId: 's#2' });
  });

  it('用同一个 turnId 时两镜会并进同一个 compound（说明 turnId 就是那个开关）', () => {
    const journal = setup(threeShotDoc());
    for (const [sceneId, start, end, expr] of [
      ['s#1', 0, 4, 'sin(x)'],
      ['s#2', 4, 8, 'cos(x)'],
    ] as const) {
      applyCommands(
        {
          baseVersion: journal.currentVersion(),
          commands: [
            { op: 'create_plot', localId: '$c1', expr, domain: [-7, 7], owner: { kind: 'scene', sceneId: null } } as never,
          ],
        },
        {
          journal,
          budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
          actor: 'agent',
          turnId: 'same-turn',
          scope: { kind: 'scene', sceneId, start, end },
          now: () => 1_700_000_001_000,
        },
      );
      journal.settle('same-turn');
    }
    const withOps = journal.compounds().filter((x) => x.opIds.length > 0);
    expect(withOps).toHaveLength(1);
    expect(withOps[0]?.opIds.length).toBe(2);
  });
});

describe('复查辅助：探针时刻与可见项数', () => {
  it('★ 探针取镜头【中点】而不是起点（起点常常是透明帧）', () => {
    const doc = threeShotDoc();
    expect(shotProbeTime(doc, 's#2')).toBe(6); // [4,8) 的中点
    expect(shotProbeTime(doc, 's#3')).toBe(10); // [8,12) 的中点
    expect(shotProbeTime(doc, 'nope')).toBe(0);
  });

  it('可见项数按镜头算（某镜什么都没画出来时会露馅）', () => {
    const doc = threeShotDoc();
    // 每镜一个对象 + 没有 global → 各镜都是 1
    expect(visibleItemCount(doc, 's#2')).toBe(1);
  });
});
