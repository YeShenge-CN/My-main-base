import { describe, expect, it } from 'vitest';
import { DEFAULT_SUMMARY_TOKEN_BUDGET, getSceneSummary } from '../src/projection/summary';
import { estimateTokens, tokensOfJson } from '../src/projection/tokens';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

/**
 * P3 验收 1：100 个对象的 summary 不超过 1000 token（显式给这个预算时）。
 *
 * token 估算方式（见 src/projection/tokens.ts 的说明）：ASCII 按 3 字符/token、
 * CJK 按 1.5 token/字，刻意高估；并以【紧凑 JSON】为计量对象 ——
 * 那是模型可能看到的最省形态。
 */

describe('token 估算器', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('纯 ASCII 不低估真实下限：>= ceil(len/4)', () => {
    const samples = [
      'The quick brown fox jumps over the lazy dog.',
      '{"id":"plot#1","type":"plot2d","layer":"main"}',
      'a',
      'x'.repeat(1000),
    ];
    for (const s of samples) {
      expect(estimateTokens(s)).toBeGreaterThanOrEqual(Math.ceil(s.length / 4));
    }
  });

  it('单调：前缀的估算不超过整体', () => {
    const s = JSON.stringify(makeDoc(20));
    for (let i = 0; i < s.length; i += 37) {
      expect(estimateTokens(s.slice(0, i))).toBeLessThanOrEqual(estimateTokens(s));
    }
  });

  it('同样字符数下 CJK 比 ASCII 贵', () => {
    expect(estimateTokens('曲线生长绘制效果')).toBeGreaterThan(estimateTokens('abcdefgh'));
  });
});

describe('P3 验收 1：get_scene_summary 的硬预算', () => {
  it('显式给 1000 的预算时，100 个对象不超过 1000 token', () => {
    // ★ 第二十九轮把【默认】预算从 1000 抬到了 4000（见 DEFAULT_SUMMARY_TOKEN_BUDGET）。
    //   P3 这条验收判的是「投影层能装多紧」，所以这里显式传 1000 ——
    //   判据不该跟着默认值漂移（否则改默认值就等于悄悄放松了一条验收）。
    const doc = makeDoc(100);
    const summary = getSceneSummary(doc, { tokenBudget: 1000 });
    const tokens = tokensOfJson(summary);
    console.log(
      '[预算实测] 单图层 100 对象 → ' +
        tokens +
        ' token，展示了 ' +
        summary.objects.length +
        ' 个，省略 ' +
        (summary.truncated?.objectsOmitted ?? 0) +
        ' 个',
    );
    expect(tokens).toBeLessThanOrEqual(1000);
  });

  it('100 个对象（三图层）+ 每对象一个效果，显式 1000 预算下仍不超过', () => {
    const doc = makeDoc(100, { layerCount: 3, effectsPerObject: 1 });
    const summary = getSceneSummary(doc, { tokenBudget: 1000 });
    expect(tokensOfJson(summary)).toBeLessThanOrEqual(1000);
  });

  /**
   * ★★ 第二十九轮：默认预算 1000 → 4000。
   *
   *   实测症状（§0.28 三 ③）：约 50–60 个对象就顶到 1000 被尾部截断，
   *   整片第 2 镜的 Agent 因此连着调了 10 次 get_object 去把信息补回来 ——
   *   一次 get_object 的回执比"多给 summary 3000 token"还贵。
   *   这条断言判的是"默认值确实放开了，而且它确实换来了完整的一份清单"。
   */
  it('★ 默认预算下 100 个对象能【完整】给出，不再被截断', () => {
    const doc = makeDoc(100);
    const summary = getSceneSummary(doc);
    expect(DEFAULT_SUMMARY_TOKEN_BUDGET).toBeGreaterThan(1000);
    expect(tokensOfJson(summary)).toBeLessThanOrEqual(DEFAULT_SUMMARY_TOKEN_BUDGET);
    expect(summary.objects.length).toBe(100);
    expect(summary.truncated).toBeUndefined();
  });

  it('预算可调：放大预算后能装下更多对象', () => {
    const doc = makeDoc(100);
    const tight = getSceneSummary(doc, { tokenBudget: 400 });
    const loose = getSceneSummary(doc, { tokenBudget: 5000 });
    expect(loose.objects.length).toBeGreaterThan(tight.objects.length);
    expect(loose.truncated).toBeUndefined();
    expect(loose.objects.length).toBe(100);
  });

  it('永不静默丢数据：展示数 + 省略数 === 总数', () => {
    const doc = makeDoc(100, { effectsPerObject: 1 });
    const s = getSceneSummary(doc);
    expect(s.objects.length + (s.truncated?.objectsOmitted ?? 0)).toBe(100);
    expect(s.effects.length + (s.truncated?.effectsOmitted ?? 0)).toBe(100);
    expect(s.markers.length + (s.truncated?.markersOmitted ?? 0)).toBe(doc.markers.length);
    // 被省掉的对象按 shape 归类，模型能知道"少的是什么"
    const omittedByType = s.truncated?.omittedByType ?? {};
    const counted = Object.values(omittedByType).reduce((a, b) => a + b, 0);
    expect(counted).toBe(s.truncated?.objectsOmitted ?? 0);
  });

  it('空文档也能给出合法摘要', () => {
    const s = getSceneSummary(makeDoc(0));
    expect(s.objects).toEqual([]);
    expect(s.truncated).toBeUndefined();
    expect(s.v).toBe(0);
  });
});

describe('P3：summary 的形状契约', () => {
  it('objects[] 里没有任何参数值 —— 要改必须先 get_object()', () => {
    const doc = makeDoc(3);
    const s = getSceneSummary(doc);
    const text = JSON.stringify(s);
    expect(text).not.toContain('sin(x)');
    expect(text).not.toContain('#4ea1ff');
    expect(text).not.toContain('2400');
    // 单图层文档里 layer 是冗余的，会被省略
    for (const o of s.objects) {
      expect(Object.keys(o).sort()).toEqual(['id', 'type']);
    }
  });

  it('多图层文档保留 layer', () => {
    const s = getSceneSummary(makeDoc(3, { layerCount: 3 }));
    for (const o of s.objects) {
      expect(Object.keys(o).sort()).toEqual(['id', 'layer', 'type']);
    }
  });

  it('时间窗等于整段时长时省略 t（最常见情形，省 token）', () => {
    const s = getSceneSummary(makeDoc(2));
    expect(s.objects[0]?.t).toBeUndefined();
  });

  it('时间窗不是整段时给出 t', () => {
    const doc = makeDoc(1);
    const plot = doc.objects['plot#1'];
    if (plot === undefined) throw new Error('fixture 缺失');
    const patched = {
      ...doc,
      objects: { 'plot#1': { ...plot, owner: { kind: 'scene', sceneId: 's1', bornAt: 2 } as const } },
    };
    const s = getSceneSummary(patched);
    expect(s.objects[0]?.t).toEqual([2, 12]);
  });

  it('markers 用 "id@t" 形式，locks 直接给路径', () => {
    const doc = makeDoc(1);
    const patched = {
      ...doc,
      markers: [
        { id: 'intro', t: 0 },
        { id: 'peak', t: 3 },
      ],
      locks: { 'plot#1.style.width': { by: 'user' as const, at: 1730000000000 } },
    };
    const s = getSceneSummary(patched);
    expect(s.markers).toEqual(['intro@0', 'peak@3']);
    expect(s.locks).toEqual(['plot#1.style.width']);
  });

  it('cameraShots 是相机关键帧数', () => {
    const doc = makeDoc(1);
    const patched = {
      ...doc,
      camera: {
        keys: [
          { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] as const },
          { t: 5, tx: 1, ty: 0, scale: 2, rotate: 0, pivot: [0, 0] as const },
        ],
      },
    };
    expect(getSceneSummary(patched).cameraShots).toBe(2);
  });

  it('cursor / focus 不属于引擎状态，绝不出现', () => {
    const s = getSceneSummary(makeDoc(2));
    const keys = Object.keys(s);
    expect(keys).not.toContain('cursor');
    expect(keys).not.toContain('focus');
    expect(keys).not.toContain('selection');
    expect(keys).not.toContain('selected');
  });

  it('issues 默认 0，可由调用方注入真实值', () => {
    expect(getSceneSummary(makeDoc(1)).issues).toBe(0);
    expect(getSceneSummary(makeDoc(1), { issues: 3 }).issues).toBe(3);
  });

  it('effects 带 range=[start, start+duration]', () => {
    const doc = makeDoc(1, { effectsPerObject: 1 });
    const s = getSceneSummary(doc);
    expect(s.effects[0]?.range).toEqual([0.8, 3]);
    expect(s.effects[0]?.type).toBe('drawOn');
    expect(s.effects[0]?.target).toBe('plot#1');
  });
});

/**
 * ★ 镜头表进摘要（第七轮补的）。
 *
 * 在此之前模型【完全看不到镜头】—— 摘要连"文档里有几镜"都不说，
 * 于是它为了搞清状况自己去 render 画面。把边界直接给它。
 */
describe('scenes：模型必须看得到镜头结构', () => {
  /** 三镜 + 三个各归自己一镜的对象 + 一个 global。 */
  function sceneDoc(): SceneDoc {
    const base = makeDoc(0, { duration: 12 });
    const own = (id: string, sceneId: string, bornAt: number): SceneObject =>
      makeObject(id, 'plot2d', { owner: { kind: 'scene', sceneId, bornAt } });
    return {
      ...withScenes(base, [
        { id: 's#1', name: '开场', bornAt: 0 },
        { id: 's#2', name: '主体', bornAt: 4 },
        { id: 's#3', name: '收尾', bornAt: 8 },
      ]),
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'c#1', 'g#1'] }],
      objects: {
        'a#1': own('a#1', 's#1', 0),
        'b#1': own('b#1', 's#2', 4),
        'c#1': own('c#1', 's#3', 8),
        'g#1': makeObject('g#1', 'plot2d', { owner: { kind: 'global' } }),
      },
      effects: {},
      markers: [],
    };
  }

  it('★ 给出每一镜的 id / name / 时间范围 / 本镜对象数', () => {
    const s = getSceneSummary(sceneDoc());
    expect(s.scenes).toEqual([
      { id: 's#1', name: '开场', range: [0, 4], objects: 1 },
      { id: 's#2', name: '主体', range: [4, 8], objects: 1 },
      { id: 's#3', name: '收尾', range: [8, 12], objects: 1 },
    ]);
  });

  it('★ 范围用 sceneOrder 归一化：表里写乱顺序也报得对', () => {
    const base = sceneDoc();
    const shuffled: SceneDoc = { ...base, scenes: [base.scenes[2]!, base.scenes[0]!, base.scenes[1]!] };
    expect(getSceneSummary(shuffled).scenes.map((x) => x.id)).toEqual(['s#1', 's#2', 's#3']);
  });

  it('★ objects 计数不含 shared / global（它们不属于任何单镜，混进来会误导）', () => {
    const s = getSceneSummary(sceneDoc());
    // 文档里 4 个对象，但每一镜只数自己那一个
    expect(s.scenes.reduce((a, x) => a + x.objects, 0)).toBe(3);
    expect(s.objects).toHaveLength(4);
  });

  it('空镜头表 → scenes: []（单镜头旧行为，全片一镜）', () => {
    expect(getSceneSummary(makeDoc(2)).scenes).toEqual([]);
  });

  it('存量文档（没有 scenes 字段）不炸', () => {
    const legacy = { ...makeDoc(2) } as Record<string, unknown>;
    delete legacy['scenes'];
    expect(getSceneSummary(legacy as unknown as SceneDoc).scenes).toEqual([]);
  });

  it('镜头表占额度，但仍守着 token 预算', () => {
    const s = getSceneSummary(sceneDoc(), { tokenBudget: 1000 });
    expect(tokensOfJson(s)).toBeLessThanOrEqual(1000);
  });
});

/**
 * ★★ 截断优先级：这一版之前是"objects 放不下就 break"，
 *    于是预算一紧，locks / scenes 会被【静默跳过】——
 *    模型在最需要信息的时候，恰好丢掉的是"哪些字段被锁"与"自己在哪一镜"。
 */
describe('★ 预算不足时的截断优先级', () => {
  it('★ 锁必须先活下来（不看锁就会白提提案，而提案要花用户时间）', () => {
    // 大量对象 + 一条锁 + 一个镜头，预算只够装一部分
    const base = makeDoc(60, { duration: 8 });
    const doc: SceneDoc = {
      ...withScenes(base, [{ id: 's#1', name: '唯一一镜', bornAt: 0 }]),
      locks: { 'plot#1.style.width': { by: 'user', at: 1 } },
    };
    const s = getSceneSummary(doc, { tokenBudget: 300 });
    expect(s.locks, '锁被截断了 —— 模型会撞锁还不知道').toContain('plot#1.style.width');
    expect(s.scenes, '镜头结构被截断了 —— 模型会不知道自己在哪一镜').toHaveLength(1);
  });

  it('truncated 如实披露被省掉的镜头数', () => {
    const many = makeDoc(80, { duration: 60 });
    const scenes = Array.from({ length: 40 }, (_, i) => ({ id: 's#' + (i + 1), name: '镜头 ' + (i + 1), bornAt: i }));
    const doc: SceneDoc = { ...many, scenes };
    const s = getSceneSummary(doc, { tokenBudget: 200 });
    expect(tokensOfJson(s)).toBeLessThanOrEqual(200);
    // 装不下的部分必须说出来，而不是静默消失
    if (s.scenes.length < 40) expect((s.truncated?.scenesOmitted ?? 0) > 0).toBe(true);
  });

  it('预算充足时什么都不丢', () => {
    const s = getSceneSummary(makeDoc(2), { tokenBudget: 100000 });
    expect(s.truncated).toBeUndefined();
  });
});
