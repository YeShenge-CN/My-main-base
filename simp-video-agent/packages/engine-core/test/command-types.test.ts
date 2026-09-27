import { describe, expect, it } from 'vitest';
import { isLocalId, LOCAL_ID_PREFIX, type IdRef } from '../src/command/ids';
import type { Command } from '../src/command/commands';
import { MAX_BATCH_SIZE } from '../src/command/results';
import { lockClassOf } from '../src/doc/types';

/**
 * 这个文件把"命令必须是领域化形态"钉成【编译期断言】。
 *
 * 最关键的一条在最后：set_param(path, value) 这种通用逃生舱
 * 在类型上根本不存在 —— 不是靠提示词约束模型，是编译器不允许。
 */

/** 规范 §7 的示例批次，逐字对照。 */
const specBatch = [
  {
    index: 0,
    op: 'create_plot',
    localId: '$c1',
    expr: 'sin(x)',
    domain: [-7, 7],
    style: { width: 3.5, glow: 0.6 },
    motion: {
      'tf.opacity': {
        kind: 'keys',
        keys: [
          { t: 0, v: 0 },
          { t: 0.6, v: 1, ease: 'easeOutCubic' },
        ],
      },
    },
    effect: { type: 'drawOn', params: { start: 0.8, duration: 2.2, mode: 'arc' } },
    owner: { kind: 'scene', sceneId: 's1' },
  },
  { index: 1, op: 'set_style', target: '$c1', width: 5.0 },
  { index: 2, op: 'camera_preset', preset: 'pushIn', subject: '$c1', duration: 3.0 },
] as const satisfies readonly Command[];

describe('命令的领域化形态（规范 §7 示例逐字可编译）', () => {
  it('规范给出的那三条命令原样就是合法命令', () => {
    expect(specBatch.map((c) => c.op)).toEqual(['create_plot', 'set_style', 'camera_preset']);
  });

  it('create_plot 内联 style / motion / effect 都被接受', () => {
    const create = specBatch[0];
    expect(create.style).toEqual({ width: 3.5, glow: 0.6 });
    expect(create.effect?.type).toBe('drawOn');
    expect(create.motion['tf.opacity'].kind).toBe('keys');
  });

  it('第三条第 subject 是符号 id，指向第一条产生的对象', () => {
    expect(specBatch[2].subject).toBe('$c1');
    expect(isLocalId(specBatch[2].subject)).toBe(true);
  });

  it('null 表示"这一项不改"：可以显式写 null，也可以整项省略', () => {
    const explicitNull: Command = { op: 'set_style', target: 'plot#1', width: null };
    const omitted: Command = { op: 'set_style', target: 'plot#1' };
    expect(explicitNull.op).toBe('set_style');
    expect(omitted.op).toBe('set_style');
  });
});

describe('领域化命令族的形状', () => {
  const samples = {
    style: { op: 'set_style', target: 'plot#1', width: 4, glow: 0.3, stroke: '#fff' },
    expression: { op: 'set_expression', target: 'plot#1', expr: 'cos(x)' },
    transform: { op: 'set_transform', target: 'plot#1', x: 1, y: 2, opacity: 0.5 },
    effect: { op: 'set_effect', target: 'eff#1', duration: 3, mode: 'domain', tip: false },
    motion: {
      op: 'set_motion',
      target: 'plot#1',
      field: 'tf.opacity',
      node: { kind: 'expr', expr: 'clamp(t/2.2,0,1)' },
    },
    camera: {
      op: 'set_camera',
      keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }],
    },
    addEffect: { op: 'add_effect', target: 'plot#1', effect: { type: 'fade' }, localId: '$e1' },
    deleteObject: { op: 'delete_object', target: 'plot#1' },
  } as const satisfies Record<string, Command>;

  it('每条命名的都是画一条曲线时真正会说的词，不是路径', () => {
    expect(samples.style.op).toBe('set_style');
    expect(samples.motion.field).toBe('tf.opacity');
    expect(Object.values(samples).length).toBe(8);
  });

  it('set_motion 的 node 传 null 表示删除该轨道', () => {
    const removeTrack: Command = { op: 'set_motion', target: 'plot#1', field: 'tf.opacity', node: null };
    expect(removeTrack.op).toBe('set_motion');
  });

  it('camera_preset 的 subject 可以是世界坐标点', () => {
    const onPoint: Command = { op: 'camera_preset', preset: 'pushIn', subject: [0, 0], duration: 2 };
    expect(onPoint.op).toBe('camera_preset');
  });
});

describe('类型层断言：通用逃生舱不存在', () => {
  it('没有 set_param(path, value) 这种命令', () => {
    // @ts-expect-error set_param 不是合法 op —— 这正是"领域化"的类型层保证
    const bad: Command = { op: 'set_param', target: 'plot#1', path: 'style.width', value: 5 };
    expect(bad).toBeDefined();
  });

  it('set_style 不接受几何字段（expr 属于 set_expression）', () => {
    // @ts-expect-error expr 不在 set_style 的字段里
    const bad: Command = { op: 'set_style', target: 'plot#1', expr: 'cos(x)' };
    expect(bad).toBeDefined();
  });

  it('set_transform 不接受样式字段', () => {
    // @ts-expect-error stroke 不在 set_transform 的字段里
    const bad: Command = { op: 'set_transform', target: 'plot#1', stroke: '#fff' };
    expect(bad).toBeDefined();
  });

  it('domain 必须是二元组', () => {
    // @ts-expect-error 三元组不是 [number, number]
    const bad: Command = { op: 'create_plot', localId: '$c1', expr: 'sin(x)', domain: [-7, 7, 0], owner: { kind: 'global' } };
    expect(bad).toBeDefined();
  });

  it('相机预设名是封闭集合', () => {
    // @ts-expect-error 'zoomOut' 不是已登记的预设
    const bad: Command = { op: 'camera_preset', preset: 'zoomOut', duration: 3 };
    expect(bad).toBeDefined();
  });

  it('set_motion 的 field 是字符串路径，node 必须是合法轨道', () => {
    // @ts-expect-error node 必须是 AnimTrack
    const bad: Command = { op: 'set_motion', target: 'plot#1', field: 'tf.opacity', node: 5 };
    expect(bad).toBeDefined();
  });
});

describe('约定常量', () => {
  it('符号 id 前缀是 $', () => {
    expect(LOCAL_ID_PREFIX).toBe('$');
    expect(isLocalId('$c1')).toBe(true);
    expect(isLocalId('plot#7')).toBe(false);
    expect(isLocalId('eff#3')).toBe(false);
    // 已解析 id 里出现 $ 不算符号 id（id 由引擎分配，不含 $）
    expect(isLocalId('plot#7.style.width')).toBe(false);
  });

  it('批次上限 15 条（规范 §7.6）', () => {
    expect(MAX_BATCH_SIZE).toBe(15);
  });

  it('锁分档：用户改过是 hard，AI 拥有是 soft', () => {
    expect(lockClassOf({ by: 'user', at: 1 })).toBe('hard');
    expect(lockClassOf({ by: 'ai', at: 2 })).toBe('soft');
  });

  it('IdRef 就是字符串（品牌位在序列化边界上会丢失，所以不假装有）', () => {
    const ref: IdRef = '$c1';
    const resolved: IdRef = 'plot#7';
    expect([ref, resolved].length).toBe(2);
  });
});
