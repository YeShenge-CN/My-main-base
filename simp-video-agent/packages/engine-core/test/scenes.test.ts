/**
 * scenes 表的派生规则（P12 第一步的验收）。
 *
 * 这一份测试锁的不是"某个函数怎么写的"，而是【A1 + B1 的语义决定】：
 *
 *   A1  镜头结束时刻 = 下一镜的起点，不单独存。
 *   B1  meta.duration 与镜头表的关系是【单向】的：不许短于最后一镜的起点，
 *       但永不自动缩短（缩短只能由显式的 set_meta / 删镜头来做）。
 *   ★   bornAt 的真源是镜头表，owner.bornAt 只是缓存 —— 所以时间窗只认一处。
 *   ★   空表 = 单镜头（旧行为）：时间窗右端退回 meta.duration，duration 不被动。
 *
 * 这几条一旦漂移，多镜头串行渲染、retime、写权限会各自按不同的"镜头范围"行事，
 * 而那种不一致在画面上几乎看不出来 —— 所以必须钉成断言。
 */
import { describe, expect, it } from 'vitest';
import { findScene, lastScene, objectTimeWindow, reconcileDuration, sceneEnd, sceneOrder, sceneWindow } from '../src/doc/types';
import { validateEnvironment } from '../src/validate/validators';
import { createJournal, type Journal } from '../src/journal/store';
import type { Scene, SceneDoc } from '../src/doc/types';
import { makeDoc, makeMeta, makeObject, withScenes } from './fixtures';

/** 三镜文档：s1 [0,4) · s2 [4,8) · s3 [8,12)，片长 12。 */
function threeSceneDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  return {
    ...withScenes(base, ['s1', 's2', 's3']),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'c#1', 'd#1'] }],
    objects: {
      'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's1', bornAt: 0 } }),
      'b#1': makeObject('b#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's2', bornAt: 4 } }),
      'c#1': makeObject('c#1', 'plot2d', {
        owner: { kind: 'shared', sharedId: 'asset.sin', usageWindows: [[1, 3], [9, 11]] },
      }),
      'd#1': makeObject('d#1', 'plot2d', { owner: { kind: 'global' } }),
    },
    effects: {},
    markers: [],
  };
}

function ownerSceneIdOf(doc: SceneDoc, id: string): string | undefined {
  const owner = doc.objects[id]?.owner;
  return owner?.kind === 'scene' ? owner.sceneId : undefined;
}

describe('A1：scene 类对象的右端 = 下一镜的起点', () => {
  it('三镜文档：每镜各自切自己的那一段，最后一镜到片长', () => {
    const doc = threeSceneDoc();
    expect(objectTimeWindow(doc, doc.objects['a#1']!)).toEqual([0, 4]);
    expect(objectTimeWindow(doc, doc.objects['b#1']!)).toEqual([4, 8]);
    // 最后一镜没有下一镜 → 右端就是 meta.duration
    expect(sceneEnd(doc, 's3')).toBe(12);
  });

  it('最后一镜的右端跟着 meta.duration 走，不是写死的', () => {
    const doc = threeSceneDoc();
    const longer: SceneDoc = { ...doc, meta: { ...doc.meta, duration: 20 } };
    expect(sceneWindow(longer, 's3')).toEqual([8, 20]);
    expect(objectTimeWindow(longer, longer.objects['b#1']!)).toEqual([4, 8]); // 中间镜不受影响
  });

  it('sceneWindow 的左端是【表里的】bornAt，不是 owner.bornAt', () => {
    const doc = threeSceneDoc();
    // 故意把 owner 缓存写歪：时间窗必须仍然听表的
    const skewed: SceneDoc = {
      ...doc,
      objects: {
        ...doc.objects,
        'b#1': makeObject('b#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's2', bornAt: 999 } }),
      },
    };
    expect(objectTimeWindow(skewed, skewed.objects['b#1']!)).toEqual([4, 8]);
  });
});

describe('★ 派生量不落进文档：切镜头不产生第二份真源', () => {
  it('场景信息只在 scenes 表与 owner 两处，时间窗是算出来的', () => {
    const doc = threeSceneDoc();
    // 对象上没有任何 end / timeWindow 字段
    expect(Object.keys(doc.objects['a#1']!).filter((k) => /end|window|time/i.test(k))).toEqual([]);
    // 镜头对象上也没有 end（A1 的核心：结束时刻不存在于文档里）
    for (const scene of doc.scenes) {
      expect(Object.keys(scene).sort()).toEqual(['bornAt', 'id', 'name']);
    }
  });

  it('切镜不改 meta.duration（duration 不是镜头时长的自动求和）', () => {
    const doc = threeSceneDoc();
    expect(doc.meta.duration).toBe(12);
    // 删掉中间一镜：s1 的右端立刻改吃 s3 的起点，而片长一个字没动
    const merged: SceneDoc = { ...doc, scenes: doc.scenes.filter((s) => s.id !== 's2') };
    expect(objectTimeWindow(merged, merged.objects['a#1']!)).toEqual([0, 8]);
    expect(merged.meta.duration).toBe(12);
  });
});

describe('shared 与 global 的右端不被镜头裁剪', () => {
  it('shared 的时间窗是各 usageWindows 的并集，跨镜也不裁', () => {
    const doc = threeSceneDoc();
    // [1,3] ∪ [9,11] = [1,11]：横跨三镜，一个窗口都不许被镜头边界切掉
    expect(objectTimeWindow(doc, doc.objects['c#1']!)).toEqual([1, 11]);
  });

  it('global 永远是整片 [0, duration]', () => {
    const doc = threeSceneDoc();
    expect(objectTimeWindow(doc, doc.objects['d#1']!)).toEqual([0, 12]);
  });
});

describe('镜头表的顺序不是真源', () => {
  it('表里写乱顺序也不影响派生结果', () => {
    const doc = threeSceneDoc();
    const shuffled: SceneDoc = { ...doc, scenes: [doc.scenes[2]!, doc.scenes[0]!, doc.scenes[1]!] };
    expect(sceneOrder(shuffled).map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(objectTimeWindow(shuffled, shuffled.objects['a#1']!)).toEqual([0, 4]);
    expect(lastScene(shuffled)?.id).toBe('s3');
  });

  it('bornAt 相同时按 id 定序（顺序必须是确定的，不能依赖数组顺序）', () => {
    const doc = threeSceneDoc();
    const tie: Scene[] = [
      { id: 'sb', name: 'B', bornAt: 2 },
      { id: 'sa', name: 'A', bornAt: 2 },
    ];
    expect(sceneOrder({ ...doc, scenes: tie }).map((s) => s.id)).toEqual(['sa', 'sb']);
  });

  it('悬空 sceneId 退化到整片，而不是抛异常', () => {
    const doc = threeSceneDoc();
    const stray: SceneDoc = {
      ...doc,
      objects: {
        ...doc.objects,
        'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's9', bornAt: 0 } }),
      },
    };
    expect(sceneWindow(stray, 's9')).toEqual([0, 12]);
    expect(objectTimeWindow(stray, stray.objects['a#1']!)).toEqual([0, 12]);
    expect(findScene(stray, 's9')).toBeUndefined();
  });
});

describe('B1：duration 与镜头表是单向对齐（只伸不缩）', () => {
  it('镜头起点超出片长时把片长撑到它（否则镜头落在片外，非法）', () => {
    const doc: SceneDoc = {
      ...makeDoc(0),
      meta: makeMeta({ duration: 6 }),
      scenes: [{ id: 's1', name: '一', bornAt: 0 }, { id: 's2', name: '二', bornAt: 10 }],
    };
    expect(reconcileDuration(doc).meta.duration).toBe(10);
  });

  it('★ 永不自动缩短：加一镜不许把片尾内容截掉', () => {
    const doc: SceneDoc = {
      ...makeDoc(0),
      meta: makeMeta({ duration: 30 }),
      scenes: [{ id: 's1', name: '一', bornAt: 0 }],
    };
    expect(reconcileDuration(doc).meta.duration).toBe(30);
    // 同一个引用：没有可改的地方就别造新文档
    expect(reconcileDuration(doc)).toBe(doc);
  });

  it('空表什么都不动（空表 = 单镜头，不是"片长为 0"）', () => {
    const doc = makeDoc(0);
    expect(doc.scenes).toEqual([]);
    expect(reconcileDuration(doc)).toBe(doc);
    expect(lastScene(doc)).toBeUndefined();
  });
});

describe('空 scenes 表 = 旧的单镜头语义', () => {
  it('scene 类右端退回 meta.duration，左端仍是 owner.bornAt', () => {
    const doc = makeDoc(0, { duration: 12 });
    const obj = makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's1', bornAt: 2 } });
    expect(doc.scenes).toEqual([]);
    expect(objectTimeWindow(doc, obj)).toEqual([2, 12]);
  });

  it('存量 JSON 里完全没有 scenes 字段时也不炸（等价于空表）', () => {
    const doc = makeDoc(0);
    // 模拟 out/*.json 这类加字段之前落盘的文档
    const legacy = { ...doc } as Record<string, unknown>;
    delete legacy['scenes'];
    const obj = makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's1', bornAt: 2 } });
    expect(objectTimeWindow(legacy as unknown as SceneDoc, obj)).toEqual([2, 12]);
    expect(sceneOrder(legacy as unknown as SceneDoc)).toEqual([]);
  });
});

describe('bornAt 由镜头表推导（模型与命令都不声明它）', () => {
  function setup(doc: SceneDoc): Journal {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  it('create_plot 落在 s2 时，bornAt 取表里的 4 而不是 ctx 的 0', () => {
    const doc = threeSceneDoc();
    const j = setup(doc);
    const outcome = j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'scene', sceneId: 's2' },
      },
      // 调用方给的 bornAt 必须【输给】镜头表
      applyCtx: { bornAt: 0 },
    });
    expect(outcome.kind).toBe('committed');
    expect(ownerSceneIdOf(j.currentDoc(), 'plot#1')).toBe('s2');
    const owner = j.currentDoc().objects['plot#1']!.owner;
    expect(owner.kind === 'scene' ? owner.bornAt : undefined).toBe(4);
  });

  it('没有镜头表的单镜头调用方仍然靠 ctx.bornAt（旧行为不许坏）', () => {
    const j = setup(makeDoc(0));
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'scene', sceneId: 's1' },
      },
      applyCtx: { bornAt: 2 },
    });
    const owner = j.currentDoc().objects['plot#1']?.owner;
    expect(owner?.kind === 'scene' ? owner.bornAt : undefined).toBe(2);
  });

  it('create_object 走同一条推导', () => {
    const j = setup(threeSceneDoc());
    const outcome = j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_object',
        localId: '$c1',
        shape: 'plot2d',
        params: { expr: 'sin(x)', domain: [-7, 7], samples: 2400 },
        owner: { kind: 'scene', sceneId: 's3' },
      },
      applyCtx: { bornAt: 0 },
    });
    expect(outcome.kind).toBe('committed');
    // 注意 id 前缀是 shape 名（plot2d#1）—— 只有 create_plot 才产出 plot#N
    const owner = j.currentDoc().objects['plot2d#1']?.owner;
    expect(owner?.kind === 'scene' ? owner.bornAt : undefined).toBe(8);
  });
});

/**
 * ★★ 多 Agent 的关键一步：`owner.sceneId: null` = "放进我当前这一镜"。
 *
 * 场景 Agent 不该、也不必知道自己的镜头 id —— 那是编排层给它的身份
 * （ApplyContext.scope）。让模型自己填 id 会引入两类错误：
 * 填错（写进别人的镜）与不填（游离对象）。
 */
describe('★ sceneId: null 落成"我当前这一镜"（多 Agent 的归属兜底）', () => {
  function setupWithScope(doc: SceneDoc): Journal {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  it('★ 有 scope 时自动落到那一镜（模型不用知道 id）', () => {
    const doc = threeSceneDoc();
    const j = setupWithScope(doc);
    const outcome = j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'scene', sceneId: null },
      },
      applyCtx: { scope: { kind: 'scene', sceneId: 's2', start: 4, end: 8 } },
    });
    expect(outcome.kind).toBe('committed');
    const owner = j.currentDoc().objects['plot#1']?.owner;
    expect(owner).toEqual({ kind: 'scene', sceneId: 's2', bornAt: 4 });
  });

  it('★ 显式给了 sceneId 时以它为准（导演可以跨镜指派）', () => {
    const j = setupWithScope(threeSceneDoc());
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'scene', sceneId: 's3' },
      },
      applyCtx: { scope: { kind: 'scene', sceneId: 's2', start: 4, end: 8 } },
    });
    expect(j.currentDoc().objects['plot#1']?.owner).toMatchObject({ sceneId: 's3', bornAt: 8 });
  });

  it('★ 没有 scope（导演视角）时 null 保持原样 —— 单镜头文档的既有行为不变', () => {
    const j = setupWithScope(makeDoc(0));
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'scene', sceneId: null },
      },
    });
    // 空表：不过滤，所以 sceneId 是空串没有可观测后果（Round 1 的口径）
    expect(j.currentDoc().objects['plot#1']?.owner).toMatchObject({ kind: 'scene', sceneId: '' });
  });

  it('global / shared 不受 scope 影响（模型显式要全局就是全局）', () => {
    const j = setupWithScope(threeSceneDoc());
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'create_plot',
        localId: '$c1',
        expr: 'cos(x)',
        domain: [-7, 7],
        owner: { kind: 'global' },
      },
      applyCtx: { scope: { kind: 'scene', sceneId: 's2', start: 4, end: 8 } },
    });
    expect(j.currentDoc().objects['plot#1']?.owner).toEqual({ kind: 'global' });
  });
});

describe('校验器：悬空 sceneId 报 environment（只报告，绝不自动改）', () => {
  it('镜头表里没有这一镜时报 scene_ref_missing', () => {
    const doc = threeSceneDoc();
    const stray: SceneDoc = {
      ...doc,
      objects: {
        ...doc.objects,
        'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's9', bornAt: 0 } }),
      },
    };
    const issues = validateEnvironment(stray).filter((i) => i.code === 'scene_ref_missing');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('objects.a#1.owner.sceneId');
    // 删镜头还是给对象改归属，是用户的意图 → 不许自动改
    expect(issues[0]?.fixClass).toBe('human');
    expect(issues[0]?.suggestedFix).toBeUndefined();
  });

  it('没有镜头表时【不】报（空表 = 单镜头，sceneId 只是占位名，没人解析它）', () => {
    // 存在镜头表时才谈得上"悬空"：这是刻意的边界，否则存量文档与全部夹具
    // 都会被这条 error 淹掉，而它描述的东西并不影响任何计算。
    expect(validateEnvironment(makeDoc(2)).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('归属正常的文档一条都不报', () => {
    expect(validateEnvironment(threeSceneDoc()).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('★ 存量文档（没有 scenes 字段）跑校验器不抛异常', () => {
    // 校验器是最不该抛异常的地方，而这个字段是后加的：out/*.json 里
    // 加字段之前落盘的文档一律没有它。这条守住"缺失 = 空表"这个归一化。
    const legacy = { ...makeDoc(2) } as Record<string, unknown>;
    delete legacy['scenes'];
    const doc = legacy as unknown as SceneDoc;
    expect(() => validateEnvironment(doc)).not.toThrow();
    expect(validateEnvironment(doc).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });
});
