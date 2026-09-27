/**
 * 多镜头串行渲染的编排层（P12 第 6 条）。
 *
 * 这一份锁的是【图层选择的正确性】与【不变量 1 没被破坏】：
 *
 *   1. evaluate 不许知道镜头 —— 它只吃 (doc, t)。镜头是它外面的一层 select。
 *   2. 帧计划是帧数 / 时刻 / 归属的【唯一】真源（导出与预览共用）。
 *   3. 过滤规则：scene 只在自己那一镜；shared / global 每镜都在；
 *      悬空归属宁可多画也不静默丢内容；空表 = 单镜头旧行为（一律显示）。
 *   4. 空档帧只有背景 —— 不需要任何特判。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import {
  filterRenderStateByScene,
  frameSceneId,
  hasSceneTable,
  planShotFrames,
  sceneItemFilter,
  shotAt,
  shotSpans,
} from '../src/shot';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

/**
 * 三镜文档：
 *   s#1 [0,4)   a#1（scene 类）
 *   s#2 [4,8)   b#1（scene 类）
 *   s#3 [8,12)  c#1（scene 类）
 * 外加 g#1（global）与 sh#1（shared，窗口 [2,10]）。
 * 片长 12、fps 4（每帧 0.25s，帧数少便于读断言）。
 */
function sceneDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  const obj = (id: string, owner: SceneObject['owner']): SceneObject => makeObject(id, 'plot2d', { owner });
  return {
    ...withScenes(base, [
      { id: 's#1', name: '一', bornAt: 0 },
      { id: 's#2', name: '二', bornAt: 4 },
      { id: 's#3', name: '三', bornAt: 8 },
    ]),
    meta: { ...base.meta, fps: 4, duration: 12 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'c#1', 'g#1', 'sh#1'] }],
    objects: {
      'a#1': obj('a#1', { kind: 'scene', sceneId: 's#1', bornAt: 0 }),
      'b#1': obj('b#1', { kind: 'scene', sceneId: 's#2', bornAt: 4 }),
      'c#1': obj('c#1', { kind: 'scene', sceneId: 's#3', bornAt: 8 }),
      'g#1': obj('g#1', { kind: 'global' }),
      'sh#1': obj('sh#1', { kind: 'shared', sharedId: 'asset.sin', usageWindows: [[2, 10]] }),
    },
    effects: {},
    markers: [],
  };
}

function itemIds(state: { items: readonly { id: string }[] }): string[] {
  return state.items.map((i) => i.id).sort();
}

/* ══════════════════ 帧计划 ══════════════════ */

describe('帧计划：帧数 / 时刻 / 归属的唯一真源', () => {
  it('帧数与 encode.ts 的口径一致（round(duration × fps)）', () => {
    const plan = planShotFrames(sceneDoc());
    expect(plan.fps).toBe(4);
    expect(plan.duration).toBe(12);
    expect(plan.frameCount).toBe(48);
    expect(plan.frames).toHaveLength(48);
    expect(plan.frames[0]).toEqual({ frame: 0, t: 0, sceneId: 's#1' });
    expect(plan.frames[47]?.t).toBeCloseTo(11.75, 10);
  });

  it('每帧的 t 严格等于 frame / fps（不读时钟、不累加）', () => {
    const plan = planShotFrames(sceneDoc());
    for (const f of plan.frames) expect(f.t).toBe(f.frame / plan.fps);
  });

  it('镜头占用区间：end = 下一镜起点，最后一镜到片长', () => {
    const spans = shotSpans(sceneDoc());
    expect(spans).toEqual([
      { sceneId: 's#1', name: '一', start: 0, end: 4 },
      { sceneId: 's#2', name: '二', start: 4, end: 8 },
      { sceneId: 's#3', name: '三', start: 8, end: 12 },
    ]);
  });

  it('区间是半开的：t=4 属于 s#2 而不是 s#1（边界帧不会同时属于两镜）', () => {
    const spans = shotSpans(sceneDoc());
    expect(shotAt(spans, 3.999)).toBe('s#1');
    expect(shotAt(spans, 4)).toBe('s#2');
    expect(shotAt(spans, 8)).toBe('s#3');
    expect(shotAt(spans, 12)).toBeNull(); // 片尾之外
  });

  it('★ 最后一帧归给最后一镜（否则最后一镜的尾帧会掉进空档、成片以黑屏收尾）', () => {
    // duration=12、fps=4 → 最后一帧 t=11.75。把最后一镜推到 11.8 起，它就够不着了。
    const base = sceneDoc();
    const doc: SceneDoc = {
      ...base,
      scenes: [
        { id: 's#1', name: '一', bornAt: 0 },
        { id: 's#2', name: '二', bornAt: 11.8 },
      ],
    };
    const plan = planShotFrames(doc);
    const last = plan.frames[plan.frameCount - 1]!;
    // t=11.75 < 11.8，按半开区间本该是空档 —— 特判把它归给最后一镜
    expect(last.t).toBeCloseTo(11.75, 10);
    expect(last.sceneId).toBe('s#2');
  });

  it('★ 片头空档：第一镜不从 0 开始时，前面那些帧是空档帧（sceneId=null）', () => {
    const base = sceneDoc();
    // 只有一镜且起点在 2 —— A1 下"缝"只可能出现在片头（镜与镜首尾相接）
    const doc: SceneDoc = {
      ...base,
      scenes: [{ id: 's#1', name: '一', bornAt: 2 }],
      meta: { ...base.meta, duration: 4 },
    };
    const plan = planShotFrames(doc);
    expect(plan.gaps).toEqual([[0, 2]]);
    expect(plan.shots).toEqual([{ sceneId: 's#1', name: '一', start: 2, end: 4 }]);
    // fps=4：帧 0..7 对应 0,0.25,...,1.75（空档）与 2.0 之后（s#1）
    expect(frameSceneId(plan, 0)).toBeNull();
    expect(frameSceneId(plan, 7)).toBeNull();
    expect(frameSceneId(plan, 8)).toBe('s#1');
    // 空档帧过滤后什么都没有
    expect(itemIds(filterRenderStateByScene(evaluate(doc, 1), doc, frameSceneId(plan, 4)))).toEqual([]);
  });

  it('没有镜头表：全片都算"没有镜头"，但 shots 为空、gaps 也为空', () => {
    const plan = planShotFrames(makeDoc(1, { duration: 2 }));
    expect(plan.shots).toEqual([]);
    expect(plan.gaps).toEqual([]);
    expect(plan.frames.every((f) => f.sceneId === null)).toBe(true);
    expect(hasSceneTable(makeDoc(1))).toBe(false);
  });

  it('存量文档（没有 scenes 字段）不炸', () => {
    const legacy = { ...makeDoc(1, { duration: 2 }) } as Record<string, unknown>;
    delete legacy['scenes'];
    const plan = planShotFrames(legacy as unknown as SceneDoc);
    expect(plan.shots).toEqual([]);
    expect(plan.frameCount).toBeGreaterThan(0);
  });
});

/* ══════════════════ 过滤规则 ══════════════════ */

describe('过滤规则：每个镜头该看哪些对象', () => {
  it('★ scene 类只在自己那一镜出现', () => {
    const doc = sceneDoc();
    expect(itemIds(filterRenderStateByScene(evaluate(doc, 1), doc, 's#1'))).toEqual(['a#1', 'g#1', 'sh#1']);
    expect(itemIds(filterRenderStateByScene(evaluate(doc, 5), doc, 's#2'))).toEqual(['b#1', 'g#1', 'sh#1']);
    expect(itemIds(filterRenderStateByScene(evaluate(doc, 9), doc, 's#3'))).toEqual(['c#1', 'g#1', 'sh#1']);
  });

  it('★ global 与 shared 每一镜都在（global 全片共用、shared 的意义就是跨镜复用）', () => {
    const doc = sceneDoc();
    for (const sceneId of ['s#1', 's#2', 's#3']) {
      const ids = itemIds(filterRenderStateByScene(evaluate(doc, 1), doc, sceneId));
      expect(ids).toContain('g#1');
      expect(ids).toContain('sh#1');
    }
  });

  it('★ 空档帧（sceneId=null）什么都不显示 —— 只有背景', () => {
    const doc = sceneDoc();
    expect(itemIds(filterRenderStateByScene(evaluate(doc, 1), doc, null))).toEqual([]);
  });

  it('★ 没有镜头表时一律显示（单镜头旧行为，过滤没有依据）', () => {
    const doc = makeDoc(3, { duration: 4 });
    const state = evaluate(doc, 1);
    expect(state.items).toHaveLength(3);
    // 即使显式传 null 也不过滤 —— 否则只有一个镜头的旧文档会整片变黑
    expect(filterRenderStateByScene(state, doc, null).items).toHaveLength(3);
    expect(filterRenderStateByScene(state, doc, 's#1').items).toHaveLength(3);
  });

  it('★ 悬空归属宁可多画，不静默丢内容（那是校验器的事）', () => {
    const base = sceneDoc();
    const doc: SceneDoc = {
      ...base,
      objects: {
        ...base.objects,
        'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#9', bornAt: 0 } }),
      },
    };
    const keep = sceneItemFilter(doc, 's#2');
    const item = { id: 'a#1' } as Parameters<typeof keep>[0];
    expect(keep(item)).toBe(true);
  });

  it('过滤不动 t / camera / matrix（相机是全片的，不该因镜头而变）', () => {
    const doc = sceneDoc();
    const state = evaluate(doc, 5);
    const filtered = filterRenderStateByScene(state, doc, 's#2');
    expect(filtered.t).toBe(state.t);
    expect(filtered.camera).toEqual(state.camera);
    expect(filtered.matrix).toEqual(state.matrix);
    expect(filtered.viewport).toEqual(state.viewport);
    // 空档帧只把 items 清空，其余一概不动
    const blank = filterRenderStateByScene(state, doc, null);
    expect(blank.items).toEqual([]);
    expect(blank.camera).toEqual(state.camera);
    expect(blank.matrix).toEqual(state.matrix);
  });
});

/* ══════════════════ 不变量 1 ══════════════════ */

describe('★ 不变量 1：evaluate 不知道镜头的存在', () => {
  it('同一 (doc, t) 求值结果与镜头无关，过滤只作用于 items', () => {
    const doc = sceneDoc();
    const raw = evaluate(doc, 5);
    // 求值本身把三个 scene 对象都算了出来 —— 它只认时间，不认镜头
    expect(itemIds(raw)).toEqual(['a#1', 'b#1', 'c#1', 'g#1', 'sh#1']);
    // 过滤是外面套的一层
    expect(itemIds(filterRenderStateByScene(raw, doc, 's#2'))).toEqual(['b#1', 'g#1', 'sh#1']);
  });

  it('逐镜过滤【不改变】任何一项的几何与样式（只是选择，不是重算）', () => {
    const doc = sceneDoc();
    for (const t of [1, 5, 9]) {
      const raw = evaluate(doc, t);
      const filtered = filterRenderStateByScene(raw, doc, t < 4 ? 's#1' : t < 8 ? 's#2' : 's#3');
      for (const item of filtered.items) {
        const original = raw.items.find((i) => i.id === item.id);
        expect(original).toBe(item); // 同一个对象引用：没有重建、没有重算
      }
    }
  });

  it('★ 整片渲染 = 逐镜渲染的并集拼接（同一份求值，只是选择不同）', () => {
    const doc = sceneDoc();
    // 对每个时刻：逐镜拼出来的可见集合，等于"每个对象在自己那一镜被看到"
    for (const f of planShotFrames(doc).frames) {
      const raw = evaluate(doc, f.t);
      const shown = filterRenderStateByScene(raw, doc, f.sceneId);
      // 每个被显示的对象，都必须真的属于这一镜（或本来就是全镜可见的）
      for (const item of shown.items) {
        const obj = doc.objects[item.id];
        if (obj?.owner.kind === 'scene') expect(obj.owner.sceneId).toBe(f.sceneId);
      }
    }
  });
});
