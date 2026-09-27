/**
 * P2 动画原语的第四条：appear / disappear（"到点才出现 / 到点就消失"）。
 *
 * ★ 它与"透明度淡入"不是同一件事，这一份测试要钉住的正是这条分界：
 *   透明度到 0 的对象【仍然在 RenderState 里】（可被点中、会被 get_render_state
 *   报出来、仍然参与包围盒）；appear / disappear 之前之后的对象【根本不在那一帧】。
 *
 * 判定口径（都有断言）：
 *   · 阶跃：`t < appear.at` 不在，`t >= appear.at` 在；`t >= disappear.at` 不在。
 *   · 两个类型各管一端，可以同时挂（可见窗口 = [appear.at, disappear.at)）。
 *   · 同类型多条仍然是【后定义的生效】（与 drawOn / highlight / moveAlong 同一口径）。
 *   · 与 tf.opacity 是【两件事】：一个说"这一帧有没有它"，一个说"它有多透明"。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { applyCommand } from '../src/command/apply';
import { createJournal } from '../src/journal/store';
import { validate } from '../src/validate/index';
import type { Effect, SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

function rect(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function appear(at: number): Effect {
  return { type: 'appear', target: 'rect#1', params: { at: { v: at } } };
}

function disappear(at: number): Effect {
  return { type: 'disappear', target: 'rect#1', params: { at: { v: at } } };
}

function docWith(effects: Effect[], over: Partial<SceneObject> = {}): SceneDoc {
  const ids = Object.keys(effects);
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1'] }],
    objects: { 'rect#1': rect({ effects: ids, ...over }) },
    effects: Object.fromEntries(effects.map((e, i) => ['eff#' + (i + 1), e])),
    markers: [],
  };
}

function present(doc: SceneDoc, t: number): boolean {
  return evaluate(doc, t).items.some((i) => i.id === 'rect#1');
}

/* ── 阶跃语义与边界 ─────────────────────────────────────────── */

describe('appear：这一时刻【起】才在', () => {
  const doc = docWith([appear(1.5)]);

  it('出现之前不在画面里（不是"透明度 0"，是根本没有这一项）', () => {
    expect(present(doc, 0)).toBe(false);
    expect(present(doc, 1.499)).toBe(false);
  });

  it('边界取闭区间左端：t = at 时已经在', () => {
    expect(present(doc, 1.5)).toBe(true);
  });

  it('之后一直在（不会自己走回去）', () => {
    expect(present(doc, 3)).toBe(true);
    expect(present(doc, 99)).toBe(true);
  });

  it('★ 不在时连 RenderState 里都没有它 —— 命中测试与包围盒不会指到它', () => {
    const items = evaluate(doc, 0.5).items;
    expect(items.map((i) => i.id)).not.toContain('rect#1');
  });
});

describe('disappear：这一时刻【起】不在了', () => {
  const doc = docWith([disappear(2)]);

  it('之前一直在', () => {
    expect(present(doc, 0)).toBe(true);
    expect(present(doc, 1.999)).toBe(true);
  });

  it('边界取闭区间左端：t = at 时已经不在', () => {
    expect(present(doc, 2)).toBe(false);
    expect(present(doc, 5)).toBe(false);
  });
});

describe('两个一起挂：可见窗口 = [appear.at, disappear.at)', () => {
  const doc = docWith([appear(1), disappear(3)]);

  it('窗口内才在', () => {
    expect(present(doc, 0.5)).toBe(false);
    expect(present(doc, 1)).toBe(true);
    expect(present(doc, 2.9)).toBe(true);
    expect(present(doc, 3)).toBe(false);
  });

  it('只影响自己：别的对象照常在', () => {
    const withOther: SceneDoc = {
      ...doc,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1', 'rect#2'] }],
      objects: {
        'rect#1': doc.objects['rect#1'] as SceneObject,
        'rect#2': rect(),
      },
    };
    const ids = evaluate(withOther, 0.5).items.map((i) => i.id);
    expect(ids).toContain('rect#2');
    expect(ids).not.toContain('rect#1');
  });
});

/* ── 与别的东西的关系 ───────────────────────────────────────── */

describe('与 tf.opacity / drawOn 的关系', () => {
  it('★ 与 tf.opacity 不互相覆盖（"第 1 秒出现 + 从 0 淡入"能叠）', () => {
    const doc = docWith([appear(1)], {
      anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 1, v: 0 }, { t: 2, v: 1 }] } },
    });
    // 出现之前：不在，与透明度无关
    expect(present(doc, 0.5)).toBe(false);
    // 出现之后：透明度由轨道决定（t=1 时是 0，但它在——"在但透明"与"不在"是两件事）
    const at1 = evaluate(doc, 1).items.find((i) => i.id === 'rect#1');
    expect(at1?.opacity).toBe(0);
    const at2 = evaluate(doc, 2).items.find((i) => i.id === 'rect#1');
    expect(at2?.opacity).toBe(1);
  });

  it('drawOn 与 appear 共存：出现的那一刻才开始长', () => {
    const doc = docWith([
      { type: 'drawOn', target: 'rect#1', params: { start: { v: 2 }, duration: { v: 2 }, mode: { v: 'arc' } } },
      appear(2),
    ]);
    expect(present(doc, 1)).toBe(false);
    const at2 = evaluate(doc, 2).items.find((i) => i.id === 'rect#1');
    const at4 = evaluate(doc, 4).items.find((i) => i.id === 'rect#1');
    expect(at2?.visibleFraction ?? 0).toBeLessThan(0.001);
    expect(at4?.visibleFraction).toBe(1);
  });

  it('文字对象同样走显隐（它在 RenderState 里的形态与图形不同，判定必须共享）', () => {
    const base = docWith([appear(1)]);
    const doc: SceneDoc = {
      ...base,
      objects: {
        'rect#1': rect({
          shape: 'text',
          params: { content: { v: '标题' } },
          style: { size: { v: 20 }, fill: { v: '#fff' } },
          effects: ['eff#1'],
        }),
      },
    };
    expect(present(doc, 0.5)).toBe(false);
    expect(present(doc, 1)).toBe(true);
  });
});

describe('同类型多条：后定义的生效（与其它效果同一口径）', () => {
  it('两条 appear，晚写的那条说了算', () => {
    const doc = docWith([appear(1), appear(3)]);
    expect(present(doc, 2)).toBe(false);
    expect(present(doc, 3)).toBe(true);
  });

  it('一条 appear + 两条 disappear，晚写的 disappear 说了算', () => {
    const doc = docWith([appear(0), disappear(2), disappear(5)]);
    expect(present(doc, 4)).toBe(true);
    expect(present(doc, 5)).toBe(false);
  });
});

/* ── 命令层 ─────────────────────────────────────────────────── */

describe('set_visibility（appear / disappear 共用一条 op）', () => {
  function setup(doc: SceneDoc) {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  it('改 at 产出 patch 与补偿值', () => {
    const doc = docWith([appear(1)]);
    const r = applyCommand(doc, { op: 'set_visibility', target: 'eff#1', at: 2.5 }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.patches.map((p) => p.path)).toEqual(['eff#1.params.at']);
  });

  it('★ 对非显隐效果发这条命令会被拒（类型检查，不是"写进去就算了"）', () => {
    const doc = docWith([
      { type: 'highlight', target: 'rect#1', params: { start: { v: 0 }, duration: { v: 1 }, color: { v: '#fff' }, intensity: { v: 1 } } },
    ]);
    const r = applyCommand(doc, { op: 'set_visibility', target: 'eff#1', at: 2 }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('invalid_argument');
  });

  it('目标不存在 → unknown_target', () => {
    const r = applyCommand(docWith([appear(1)]), { op: 'set_visibility', target: 'eff#9', at: 2 }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('unknown_target');
  });

  it('撤销能还原（走 Journal）', () => {
    const j = setup(docWith([appear(1)]));
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_visibility', target: 'eff#1', at: 4 } });
    j.settle('t1');
    expect(j.currentDoc().effects['eff#1']?.params['at']).toEqual({ v: 4 });
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    expect(j.currentDoc().effects['eff#1']?.params['at']).toEqual({ v: 1 });
  });

  it('add_effect 能挂上 appear（params 落地）', () => {
    const j = setup(docWith([]));
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: { op: 'add_effect', target: 'rect#1', effect: { type: 'appear', params: { at: 1.5 } } },
    });
    const ids = Object.keys(j.currentDoc().effects);
    expect(ids).toHaveLength(1);
    expect(j.currentDoc().effects[ids[0] as string]?.params['at']).toEqual({ v: 1.5 });
  });
});

/* ── 校验器 ─────────────────────────────────────────────────── */

describe('visibility_window_empty：出现得比消失还晚', () => {
  function codes(doc: SceneDoc): string[] {
    return validate(doc).map((i) => i.code);
  }

  it('appear.at >= disappear.at → 报出来（否则整片空白，而空白最难反推原因）', () => {
    expect(codes(docWith([appear(3), disappear(3)]))).toContain('visibility_window_empty');
    expect(codes(docWith([appear(4), disappear(2)]))).toContain('visibility_window_empty');
  });

  it('窗口非空时不报', () => {
    expect(codes(docWith([appear(1), disappear(2)]))).not.toContain('visibility_window_empty');
    // 只挂一个也不报（各管一端）
    expect(codes(docWith([appear(5)]))).not.toContain('visibility_window_empty');
    expect(codes(docWith([disappear(0)]))).not.toContain('visibility_window_empty');
  });

  it('问题指到那条 disappear 上，并说清怎么改', () => {
    const issue = validate(docWith([appear(4), disappear(2)])).find(
      (i) => i.code === 'visibility_window_empty',
    );
    expect(issue?.path).toBe('effects.eff#2.params.at');
    expect(issue?.message).toContain('把出现时刻改早');
  });
});
