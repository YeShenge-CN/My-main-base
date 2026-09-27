/**
 * P2 动画原语：moveAlong（"把它送过去"）。
 *
 * ★ 它替代的是"读两个对象的坐标、自己算插值、写两条 tf 关键帧"这条手工路线 ——
 *   实测里那是模型出错最多的一环（世界单位与像素混用、算错端点）。
 *   现在模型只需要说"沿那条线走"，坐标算术留在引擎里。
 *
 * 这一份要钉住五件事：
 *   1. 位置取自【源线段的世界两端点】，而源被移动/旋转时路径跟着走（不复制几何）；
 *   2. start 之前停在【起点】（不是留在自己原来的 tf 位置）；
 *   3. 走完【停在终点】，不会自己走回来；
 *   4. 位置被钉在世界空间 —— 父级的平移不再影响它，但父级的缩放仍然影响它的大小；
 *   5. 子级跟着它走（位置覆盖进的是世界矩阵，不是画笔那一层）。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { pixelToWorld } from '../src/camera';
import { applyCommand } from '../src/command/apply';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { REGISTRY } from '../src/registry/fields';
import { generateObjectSchema } from '../src/registry/schema';
import { validateEnvironment } from '../src/validate/validators';
import type { Command } from '../src/command/commands';
import type { Effect, SceneDoc, SceneObject } from '../src/doc/types';
import type { Vec2 } from '../src/math/vec2';
import type { RenderItem } from '../src/render-state';
import { makeDoc, makeObject } from './fixtures';

/** 图像预算：批处理要它，测试里给一个宽松的固定值。 */
const BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

/* ── 夹具 ───────────────────────────────────────────────────── */

const TF0 = { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 } as const;

function line(id: string, from: readonly [number, number], to: readonly [number, number], over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'line',
    owner: { kind: 'global' },
    params: { from: { v: from }, to: { v: to }, head: { v: 'none' } },
    style: { stroke: { v: '#7fb2ff' }, width: { v: 2 }, glow: { v: 0.2 } },
    tf: { ...TF0 },
    anim: {},
    effects: [],
    ...over,
  };
}

function text(id: string, content: string, over: Partial<SceneObject> = {}): SceneObject {
  return makeObject(id, 'text', {
    params: { content: { v: content } },
    style: { size: { v: 20 }, fill: { v: '#e8eef8' } },
    ...over,
  });
}

function moveAlong(target: string, source: string, start = 1, duration = 2): Effect {
  return {
    type: 'moveAlong',
    target,
    params: { source: { v: source }, start: { v: start }, duration: { v: duration } },
  };
}

function docWith(objects: Record<string, SceneObject>, effects: Record<string, Effect> = {}): SceneDoc {
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: Object.keys(objects) }],
    objects,
    effects,
    markers: [],
  };
}

/** 取某个对象在这一帧的【世界坐标原点】（把屏幕包围盒中心反算回世界）。 */
function worldOf(doc: SceneDoc, id: string, t: number): Vec2 {
  const st = evaluate(doc, t);
  const item = st.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(id + ' 没被画出来');
  if (st.fit === undefined) throw new Error('RenderState 没有 fit');
  const w = pixelToWorld({ x: item.box.x + item.box.w / 2, y: item.box.y + item.box.h / 2 }, st.fit, st.matrix);
  if (w === null) throw new Error('相机不可逆');
  return w;
}

function itemOf(doc: SceneDoc, id: string, t: number): RenderItem {
  const item = evaluate(doc, t).items.find((i) => i.id === id);
  if (item === undefined) throw new Error(id + ' 没被画出来');
  return item;
}

function near(actual: Vec2, expected: readonly [number, number], digits = 6): void {
  expect(actual.x).toBeCloseTo(expected[0], digits);
  expect(actual.y).toBeCloseTo(expected[1], digits);
}

/* ── 基本时间曲线 ─────────────────────────────────────────────── */

describe('moveAlong：沿源线段的起点→终点走', () => {
  const doc = docWith(
    {
      'line#1': line('line#1', [-4, 2], [4, 2]),
      'ball#1': text('ball#1', '●', { tf: { ...TF0, x: 99, y: -99 }, effects: ['eff#1'] }),
    },
    { 'eff#1': moveAlong('ball#1', 'line#1', 1, 2) },
  );

  it('★ start 之前停在【起点】（不是留在自己原来的 tf 位置）', () => {
    // 自己的 tf 是 (99,-99)：它完全被路径接管，所以这里必须是路径起点
    near(worldOf(doc, 'ball#1', 0.2), [-4, 2]);
    near(worldOf(doc, 'ball#1', 1), [-4, 2]);
  });

  it('★ 走到一半时在路径中点（线性插值，与 ease 无关）', () => {
    near(worldOf(doc, 'ball#1', 2), [0, 2]);
  });

  it('★ 走完停在终点，不会自己走回来', () => {
    near(worldOf(doc, 'ball#1', 3), [4, 2]);
    near(worldOf(doc, 'ball#1', 7.5), [4, 2]);
  });

  it('duration=0 是阶跃（start 那一刻直接到终点）', () => {
    const step = docWith(
      { 'line#1': line('line#1', [-4, 2], [4, 2]), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'line#1', 2, 0) },
    );
    near(worldOf(step, 'ball#1', 1.9), [-4, 2]);
    near(worldOf(step, 'ball#1', 2.1), [4, 2]);
  });

  it('ease 会改变路上的节奏（但不是端点）', () => {
    const eased = docWith(
      { 'line#1': line('line#1', [-4, 2], [4, 2]), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': { ...moveAlong('ball#1', 'line#1', 1, 2), ease: 'easeOutCubic' } },
    );
    const half = worldOf(eased, 'ball#1', 2);
    expect(half.x).toBeGreaterThan(0); // easeOut 在时间过半时已经走过一半路程
    near(worldOf(eased, 'ball#1', 0.5), [-4, 2]);
    near(worldOf(eased, 'ball#1', 5), [4, 2]);
  });
});

/* ── 路径来自源对象的坐标系 ───────────────────────────────────── */

describe('★ 路径是【引用】而不是复制：源怎么摆，路就怎么走', () => {
  it('源被平移 → 路径跟着平移', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [-4, 2], [4, 2], { tf: { ...TF0, x: 2 } }),
        'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 2) },
    );
    near(worldOf(doc, 'ball#1', 0), [-2, 2]);
    near(worldOf(doc, 'ball#1', 1), [2, 2]);
    near(worldOf(doc, 'ball#1', 2), [6, 2]);
  });

  it('源被旋转 → 路径跟着转（90° 把水平线变成竖线）', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [-4, 2], [4, 2], { tf: { ...TF0, rotate: Math.PI / 2 } }),
        'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 2) },
    );
    // (x,y) → (−y, x)：起点 (−4,2) → (−2,−4)，终点 (4,2) → (−2,4)
    near(worldOf(doc, 'ball#1', 0), [-2, -4], 5);
    near(worldOf(doc, 'ball#1', 1), [-2, 0], 5);
    near(worldOf(doc, 'ball#1', 2), [-2, 4], 5);
  });

  it('源自己也可以动（anim 驱动它）—— 路径按【当前这一帧】的源算', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [-4, 2], [4, 2], {
          anim: { 'tf.y': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 4, v: 5 }] } },
        }),
        'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 4) },
    );
    near(worldOf(doc, 'ball#1', 0), [-4, 2]);
    // t=4：源升到 y=5，终点也在 y=7
    near(worldOf(doc, 'ball#1', 4), [4, 7], 5);
  });
});

/* ── 与自身变换、父级的关系 ───────────────────────────────────── */

describe('位置被接管，但它自己的其它变换照旧', () => {
  it('★ 自身的 rotate 不会把它推离路径（位置只跟平移有关）', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [-4, 0], [4, 0]),
        'rect#1': {
          shape: 'rect',
          owner: { kind: 'global' },
          params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
          style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, glow: { v: 0.2 } },
          tf: { ...TF0, rotate: 0.7 },
          anim: {},
          effects: ['eff#1'],
        },
      },
      { 'eff#1': moveAlong('rect#1', 'line#1', 0, 2) },
    );
    // 矩形关于原点对称，所以包围盒中心 = 原点 = 路径上的点
    near(worldOf(doc, 'rect#1', 1), [0, 0]);
  });

  it('自身的 sx 仍然作用在大小上（只是位置被接管）', () => {
    const obj = (sx: number): SceneObject => ({
      shape: 'rect',
      owner: { kind: 'global' },
      params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
      style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, glow: { v: 0.2 } },
      tf: { ...TF0, sx },
      anim: {},
      effects: ['eff#1'],
    });
    const make = (sx: number): SceneDoc =>
      docWith({ 'line#1': line('line#1', [-4, 0], [4, 0]), 'rect#1': obj(sx) }, {
        'eff#1': moveAlong('rect#1', 'line#1', 0, 2),
      });
    const one = itemOf(make(1), 'rect#1', 1).box;
    const two = itemOf(make(2), 'rect#1', 1).box;
    expect(two.w).toBeCloseTo(one.w * 2, 4);
  });

  it('★ 位置钉在【世界空间】：父级平移不再影响它（但父级缩放仍然作用在大小上）', () => {
    const withParent = (px: number): SceneDoc =>
      docWith(
        {
          'line#1': line('line#1', [-4, 0], [4, 0]),
          'group#1': {
            shape: 'rect',
            owner: { kind: 'global' },
            params: { width: { v: 0.2 }, height: { v: 0.2 }, radius: { v: 0 } },
            style: {},
            tf: { ...TF0, x: px },
            anim: {},
            effects: [],
          },
          'ball#1': text('ball#1', '●', { parent: 'group#1', effects: ['eff#1'] }),
        },
        { 'eff#1': moveAlong('ball#1', 'line#1', 0, 2) },
      );
    // 父级挪到哪里都一样：它就是要在路径中点上
    near(worldOf(withParent(0), 'ball#1', 1), [0, 0]);
    near(worldOf(withParent(3), 'ball#1', 1), [0, 0]);
  });

  it('★ 子级跟着它走（位置进的是世界矩阵，不是画笔层）', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [-4, 0], [4, 0]),
        'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
        'child#1': text('child#1', 'x', { parent: 'ball#1', tf: { ...TF0, y: 1 } }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 2) },
    );
    near(worldOf(doc, 'ball#1', 1), [0, 0]);
    // 子级在自己的局部 (0,1)：父级走到路径中点时它应当在 (0,1)
    near(worldOf(doc, 'child#1', 1), [0, 1]);
    near(worldOf(doc, 'child#1', 2), [4, 1]);
  });
});

/* ── 纯函数与退化输入 ─────────────────────────────────────────── */

describe('求值仍然是纯函数，且在任何输入上终止', () => {
  const doc = docWith(
    {
      'line#1': line('line#1', [-4, 2], [4, 2]),
      'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
    },
    { 'eff#1': moveAlong('ball#1', 'line#1', 1, 2) },
  );

  it('同一时刻反复求值结果一致（缓存不改变可观测结果）', () => {
    const a = evaluate(doc, 1.5);
    const b = evaluate(doc, 3);
    const c = evaluate(doc, 1.5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(worldOf(doc, 'ball#1', 1.5)).toEqual(worldOf(doc, 'ball#1', 1.5));
    expect(b.items.length).toBe(a.items.length);
  });

  it('source 为空串 → 不动（退回自己的 tf），不抛异常', () => {
    const empty = docWith(
      { 'ball#1': text('ball#1', '●', { tf: { ...TF0, x: 1.5 }, effects: ['eff#1'] }) },
      { 'eff#1': { type: 'moveAlong', target: 'ball#1', params: { source: { v: '' }, start: { v: 0 }, duration: { v: 1 } } } },
    );
    near(worldOf(empty, 'ball#1', 3), [1.5, 0]);
  });

  it('source 指向不存在的对象 → 不动', () => {
    const gone = docWith(
      { 'ball#1': text('ball#1', '●', { tf: { ...TF0, x: 1.5 }, effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'line#404', 0, 1) },
    );
    near(worldOf(gone, 'ball#1', 3), [1.5, 0]);
  });

  it('source 不是 line（没有起点终点）→ 不动', () => {
    const notLine = docWith(
      {
        'plot#1': makeObject('plot#1', 'plot2d'),
        'ball#1': text('ball#1', '●', { tf: { ...TF0, x: 1.5 }, effects: ['eff#1'] }),
      },
      { 'eff#1': moveAlong('ball#1', 'plot#1', 0, 1) },
    );
    near(worldOf(notLine, 'ball#1', 3), [1.5, 0]);
  });

  it('★ 路径源在自己的子树里也不递归（求值必须终止）', () => {
    const cyclic = docWith(
      {
        'ball#1': text('ball#1', '●', { effects: ['eff#1'] }),
        'line#1': line('line#1', [-4, 0], [4, 0], { parent: 'ball#1' }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 1) },
    );
    // 不挂死就是通过；具体落点无所谓（这一遍刻意不认覆盖，见 planMoveAlong 的注释）
    expect(evaluate(cyclic, 0.5).items.length).toBe(2);
  });

  it('target 悬空 → 照旧被校验器报出来，求值不抛', () => {
    const dangling = docWith({ 'line#1': line('line#1', [-4, 0], [4, 0]) }, {
      'eff#1': moveAlong('ball#404', 'line#1', 0, 1),
    });
    expect(evaluate(dangling, 0.5).items.length).toBe(1);
  });
});

/* ── 校验器 ───────────────────────────────────────────────────── */

describe('校验器：路径引用的问题必须被说出来（引擎判定，模型不能自称例外）', () => {
  it('source 缺失 → move_along_source_missing（auto，可删掉这条效果）', () => {
    const doc = docWith({ 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) }, {
      'eff#1': moveAlong('ball#1', '', 0, 1),
    });
    const issue = validateEnvironment(doc).find((i) => i.code === 'move_along_source_missing');
    expect(issue).toBeDefined();
    expect(issue?.fixClass).toBe('auto');
    expect(issue?.suggestedFix?.[0]?.op).toBe('delete_effect');
  });

  it('source 指向不存在的对象 → move_along_source_missing', () => {
    const doc = docWith({ 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) }, {
      'eff#1': moveAlong('ball#1', 'line#404', 0, 1),
    });
    expect(validateEnvironment(doc).some((i) => i.code === 'move_along_source_missing')).toBe(true);
  });

  it('source 不是 line → move_along_source_not_line（agent 修）', () => {
    const doc = docWith(
      { 'plot#1': makeObject('plot#1', 'plot2d'), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'plot#1', 0, 1) },
    );
    const issue = validateEnvironment(doc).find((i) => i.code === 'move_along_source_not_line');
    expect(issue).toBeDefined();
    expect(issue?.fixClass).toBe('agent');
  });

  it('source 是自己 → move_along_source_self', () => {
    const doc = docWith({ 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) }, {
      'eff#1': moveAlong('ball#1', 'ball#1', 0, 1),
    });
    expect(validateEnvironment(doc).some((i) => i.code === 'move_along_source_self')).toBe(true);
  });
});

/* ── registry 与命令 ─────────────────────────────────────────── */

describe('registry 登记与 set_move_along 命令', () => {
  it('effect.moveAlong.params 已登记，字段名正确', () => {
    const g = REGISTRY.groups.find((x) => x.id === 'effect.moveAlong.params');
    expect(g).toBeDefined();
    expect(Object.keys(g?.fields ?? {}).sort()).toEqual(['duration', 'source', 'start']);
  });

  it('工具 schema 能从 registry 生成（start/duration 带上范围）', () => {
    const g = REGISTRY.groups.find((x) => x.id === 'effect.moveAlong.params');
    if (g === undefined) throw new Error('缺分组');
    const schema = generateObjectSchema(g, { mode: 'all-nullable' });
    const props = (schema['properties'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['duration', 'source', 'start']);
    const duration = (props['duration'] as Record<string, unknown>)['anyOf'] as Record<string, unknown>[];
    expect(duration[0]?.['minimum']).toBe(0.1);
  });

  it('set_move_along 能改字段并产出 patch', () => {
    const doc = docWith(
      { 'line#1': line('line#1', [-4, 0], [4, 0]), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'line#1', 1, 2) },
    );
    const r = applyCommand(doc, { op: 'set_move_along', target: 'eff#1', duration: 3, source: 'line#2' }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.patches.map((p) => p.path).sort()).toEqual(['eff#1.params.duration', 'eff#1.params.source']);
  });

  it('★ 对非 moveAlong 效果用 set_move_along 会被拒（参数集不同）', () => {
    const doc = docWith(
      { 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': { type: 'highlight', target: 'ball#1', params: { start: { v: 0 }, duration: { v: 1 } } } },
    );
    const r = applyCommand(doc, { op: 'set_move_along', target: 'eff#1', duration: 2 }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('invalid_argument');
  });

  it('撤销 set_move_along 能还原', () => {
    let clock = 1_700_000_000_000;
    const doc = docWith(
      { 'line#1': line('line#1', [-4, 0], [4, 0]), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'line#1', 1, 2) },
    );
    const j = createJournal(doc, { now: () => (clock += 1000) });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_move_along', target: 'eff#1', duration: 5 } });
    j.settle('t1');
    const c = j.compounds().find((x) => x.turnId === 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    expect(j.currentDoc().effects['eff#1']?.params['duration']).toEqual({ v: 2 });
  });

  it('add_effect 加一条 moveAlong 能落地并真的移动', () => {
    let clock = 1_700_000_000_000;
    const doc = docWith({
      'line#1': line('line#1', [-4, 0], [4, 0]),
      'ball#1': text('ball#1', '●'),
    });
    const j = createJournal(doc, { now: () => (clock += 1000) });
    const r = j.commit({
      actor: 'agent',
      turnId: 't1',
      command: {
        op: 'add_effect',
        target: 'ball#1',
        effect: { type: 'moveAlong', params: { source: 'line#1', start: 0, duration: 2 } },
      },
    });
    expect(r.kind).toBe('committed');
    const ids = Object.keys(j.currentDoc().effects);
    expect(ids).toHaveLength(1);
    expect(j.currentDoc().effects[ids[0]!]?.type).toBe('moveAlong');
    near(worldOf(j.currentDoc(), 'ball#1', 1), [0, 0]);
  });

  /**
   * ★ 走【批处理】这条路，而不是 journal.commit / applyCommand 直连。
   *
   * 理由是这一层有一处【类型系统管不到】的手写表：`batch.ts` 的 `writeSetOf`
   * （命令 → 它写了哪些点分路径）。漏一个 case 的后果不是编译错误，
   * 而是"撤销时算不出补偿、undo 看起来成功了却什么都没变" —— 这个坑踩过一次
   * （当时是 `scenes.<id>.<字段>` 不在 `resolvePath` 里）。
   */
  function setup(doc: SceneDoc) {
    let clock = 1_700_000_000_000;
    return createJournal(doc, { now: () => (clock += 1000) });
  }

  function runBatch(j: ReturnType<typeof setup>, commands: readonly Command[]) {
    return applyCommands({ baseVersion: j.currentVersion(), commands }, {
      journal: j,
      budget: () => BUDGET,
      actor: 'agent',
      now: () => 1_700_000_001_000,
    });
  }

  it('★ 批处理路径：add_effect(moveAlong) + set_move_along 都进得了回执与操作日志', () => {
    const doc = docWith({ 'line#1': line('line#1', [-4, 0], [4, 0]), 'ball#1': text('ball#1', '●') });
    const j = setup(doc);
    const res = runBatch(j, [
      {
        op: 'add_effect',
        target: 'ball#1',
        effect: { type: 'moveAlong', params: { source: 'line#1', start: 0, duration: 2 } },
      },
    ]);
    expect(res.errored).toEqual([]);
    expect(res.ok).toHaveLength(1);
    const effId = Object.keys(j.currentDoc().effects)[0];
    if (effId === undefined) throw new Error('效果没落地');
    // 效果真的挂到了对象上（不是只写进了 effects 表）
    expect(j.currentDoc().objects['ball#1']?.effects).toEqual([effId]);
    // 再走一条 set_move_along：写集要能报出它改了哪几处（撤销全靠它）
    const res2 = runBatch(j, [{ op: 'set_move_along', target: effId, duration: 3, source: 'line#1' }]);
    expect(res2.errored).toEqual([]);
    const op = j.query({ from: 0 }).find((o) => o.command.op === 'set_move_along');
    expect([...(op?.affectedPaths ?? [])].sort()).toEqual([effId + '.params.duration', effId + '.params.source']);
    // 撤销这一步能真的回到 2 秒
    const compound = j.compounds().find((c) => c.opIds.includes(op?.opId ?? ''));
    if (compound === undefined) throw new Error('缺 compound');
    // 未 settle 的 compound 不许撤销（规范 §12：Runtime 在一轮结束时置位）；
    // 这里的批处理没带 turnId，所以直接 settleCompound 走同一条路
    expect(j.settleCompound(compound.compoundId)).toBe(true);
    j.revertCompound(compound.compoundId);
    expect(j.currentDoc().effects[effId]?.params['duration']).toEqual({ v: 2 });
  });

  it('★ 硬锁下的效果参数会降级成提案（人机同一条 CommandBus，锁对两边一样）', () => {
    const doc = docWith(
      { 'line#1': line('line#1', [-4, 0], [4, 0]), 'ball#1': text('ball#1', '●', { effects: ['eff#1'] }) },
      { 'eff#1': moveAlong('ball#1', 'line#1', 1, 2) },
    );
    const locked: SceneDoc = { ...doc, locks: { 'eff#1.params.duration': { by: 'user', at: 1 } } };
    const j = setup(locked);
    const res = runBatch(j, [{ op: 'set_move_along', target: 'eff#1', duration: 5 }]);
    // hard 锁 → 【提案】而不是直接改（也不是 failed）：文档不动，等用户批
    expect(res.ok).toEqual([]);
    expect(res.errored).toEqual([]);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]?.proposal.affectedPaths).toEqual(['eff#1.params.duration']);
    expect(j.currentDoc().effects['eff#1']?.params['duration']).toEqual({ v: 2 });
  });

  /**
   * ★ `tf` 不再是"它在哪"的答案之后，所有把 tf 当坐标读的地方都要改。
   *
   * 已知的这一处是 `camera_preset` 的注视点：它原来直接读 `obj.tf.x/y`，
   * 于是给一个沿路径走的对象推镜头，镜头会对准它**已经不在**的地方。
   * 现在它问 `worldOriginOf(doc, id, t)` —— 与画面同一个答案。
   */
  it('★ camera_preset 的注视点取【真实位置】，不是 obj.tf（tf 已经不作数了）', () => {
    const doc = docWith(
      {
        'line#1': line('line#1', [3, -2], [3, 2]),
        // 自己的 tf 离路径很远：如果镜头对准它，说明还在读 tf
        'ball#1': text('ball#1', '●', { tf: { ...TF0, x: -6, y: 3 }, effects: ['eff#1'] }),
      },
      { 'eff#1': moveAlong('ball#1', 'line#1', 0, 4) },
    );
    const r = applyCommand(doc, { op: 'camera_preset', preset: 'pushIn', subject: 'ball#1' }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    const keys = (r.doc.camera?.keys ?? []) as readonly { pivot: readonly [number, number] }[];
    const pivot = keys[0]?.pivot;
    // t=0 时它在这条竖线的起点 (3,−2)
    expect(pivot?.[0]).toBeCloseTo(3, 6);
    expect(pivot?.[1]).toBeCloseTo(-2, 6);
  });
});
