import { describe, expect, it } from 'vitest';
import {
  SECTION_SEMANTICS,
  type EnumFieldSpec,
  type FieldRegistry,
  type FieldSpec,
  type FieldValueOf,
  type GroupValues,
} from '../src/registry/types';

/**
 * 这个文件同时干三件事：
 *  1. 用一小份【真实形状的样例 registry】证明类型定义可用（后面 item 2 会把
 *     shape/effect/camera/motion 的字段全量登记进去）；
 *  2. 用 @ts-expect-error 把"params/style 分界""有界/无界必须显式"这些约束
 *     钉成编译期断言 —— 写错了 tsc 直接红，而不是靠 code review；
 *  3. 断言 SECTION_SEMANTICS 这张表本身。
 */

/** 样例：plot2d 的几何参数。 */
const plot2dParams = {
  id: 'shape.plot2d.params',
  kind: 'shape',
  owner: 'plot2d',
  section: 'params',
  label: '曲线',
  pathTemplate: 'objects.*.params',
  fields: {
    expr: {
      type: 'expr',
      label: '函数表达式',
      description: '以 x 为自变量的表达式，例如 sin(x)',
      default: 'sin(x)',
      variables: ['x'],
      animatable: false,
    },
    domain: {
      type: 'range',
      label: '定义域',
      default: [-7, 7],
      item: { kind: 'bounded', min: -1000, max: 1000, unit: 'world' },
    },
    samples: {
      type: 'integer',
      label: '采样数',
      description: '全定义域上的采样点数，永远是全量采样',
      default: 2400,
      bounds: { kind: 'bounded', min: 16, max: 20000, step: 1, unit: 'count' },
      animatable: false,
    },
  },
} as const satisfies FieldRegistry['groups'][number];

/** 样例：plot2d 的绘制样式。 */
const plot2dStyle = {
  id: 'shape.plot2d.style',
  kind: 'shape',
  owner: 'plot2d',
  section: 'style',
  label: '曲线样式',
  pathTemplate: 'objects.*.style',
  fields: {
    stroke: { type: 'color', label: '线条颜色', default: '#4ea1ff' },
    width: {
      type: 'number',
      label: '线宽',
      default: 3,
      bounds: { kind: 'bounded', min: 0.5, max: 10, step: 0.5, unit: 'world' },
      animatable: true,
    },
    glow: {
      type: 'number',
      label: '发光强度',
      default: 0.6,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' },
      animatable: true,
    },
  },
} as const satisfies FieldRegistry['groups'][number];

/** 样例：drawOn 效果的参数。 */
const drawOnParams = {
  id: 'effect.drawOn.params',
  kind: 'effect',
  owner: 'drawOn',
  section: 'params',
  label: '生长绘制',
  pathTemplate: 'effects.*.params',
  fields: {
    start: {
      type: 'number',
      label: '开始时刻',
      default: 0.8,
      bounds: { kind: 'bounded', min: 0, max: 600, step: 0.05, unit: 's' },
    },
    duration: {
      type: 'number',
      label: '持续时长',
      default: 2.2,
      bounds: { kind: 'bounded', min: 0.2, max: 10, step: 0.1, unit: 's' },
    },
    mode: {
      type: 'enum',
      label: '生长方式',
      default: 'arc',
      values: ['domain', 'arc'],
      optionLabels: { domain: '按定义域', arc: '按弧长' },
    },
    tip: { type: 'boolean', label: '显示笔尖', default: true },
  },
} as const satisfies FieldRegistry['groups'][number];

/** 相机平移：真正无界的字段，显式声明为 unbounded。 */
const cameraPosition = {
  id: 'camera.position',
  kind: 'camera',
  section: 'camera',
  label: '相机位置',
  pathTemplate: 'camera.keys.*',
  fields: {
    tx: { type: 'number', label: '水平平移', default: 0, bounds: { kind: 'unbounded', unit: 'world' } },
    ty: { type: 'number', label: '垂直平移', default: 0, bounds: { kind: 'unbounded', unit: 'world' } },
  },
} as const satisfies FieldRegistry['groups'][number];

const sampleRegistry = {
  version: '0.0.0',
  groups: [plot2dParams, plot2dStyle, drawOnParams, cameraPosition],
} as const satisfies FieldRegistry;

describe('SECTION_SEMANTICS：params / style 分界被写死成表', () => {
  it('params 是几何类，改它必须让采样失效', () => {
    expect(SECTION_SEMANTICS.params).toEqual({
      changeClass: 'geometry',
      invalidatesSampling: true,
    });
  });

  it('style 是绘制类，改它不得触发重采样', () => {
    expect(SECTION_SEMANTICS.style).toEqual({
      changeClass: 'draw',
      invalidatesSampling: false,
    });
  });

  it('每一个 FieldSection 都有确定的语义，没有漏网', () => {
    // ★ 这份名单必须与 FieldSection 联合一一对应：加一个分区时这里会红，
    //   逼着你去回答"改这个字段要重算到哪一步"。parent（分组）就是这么被逼出来的 ——
    //   它属于 control（只影响编排），不是 draw。
    const sections = ['params', 'style', 'tf', 'parent', 'anim', 'camera', 'meta'] as const;
    for (const s of sections) {
      expect(SECTION_SEMANTICS[s]).toBeDefined();
      expect(['geometry', 'draw', 'control']).toContain(SECTION_SEMANTICS[s].changeClass);
    }
    expect(Object.keys(SECTION_SEMANTICS).sort()).toEqual([...sections].sort());
  });

  it('★ parent 是 control 而不是 draw：改父级不重采样，也不只是重绘', () => {
    expect(SECTION_SEMANTICS.parent).toEqual({ changeClass: 'control', invalidatesSampling: false });
  });
});

describe('样例 registry 可用（同时是 item 2 的写法示例）', () => {
  it('组 id 唯一', () => {
    const ids = sampleRegistry.groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('数值字段的边界可被判别式收窄后读取', () => {
    const width = plot2dStyle.fields.width;
    expect(width.bounds.kind).toBe('bounded');
    if (width.bounds.kind === 'bounded') {
      // 这三个数就是三份产物唯一的来源
      expect(width.bounds.min).toBe(0.5);
      expect(width.bounds.max).toBe(10);
      expect(width.bounds.step).toBe(0.5);
    }
  });

  it('无界字段不会伪造出一对 min/max', () => {
    const tx = cameraPosition.fields.tx;
    expect(tx.bounds.kind).toBe('unbounded');
    expect('min' in tx.bounds).toBe(false);
    expect('max' in tx.bounds).toBe(false);
  });

  it('枚举字段带着自己的允许值', () => {
    const mode = drawOnParams.fields.mode;
    expect(mode.values).toEqual(['domain', 'arc']);
    expect(mode.optionLabels.arc).toBe('按弧长');
  });

  it('expr 字段声明了允许的自由变量', () => {
    expect(plot2dParams.fields.expr.variables).toEqual(['x']);
  });
});

describe('类型层断言（靠 tsc 守，不是靠 review）', () => {
  it('FieldValueOf 能把规格映射成取值类型', () => {
    const exprValue: FieldValueOf<typeof plot2dParams.fields.expr> = 'cos(x)';
    const samplesValue: FieldValueOf<typeof plot2dParams.fields.samples> = 2400;
    const modeValue: FieldValueOf<typeof drawOnParams.fields.mode> = 'arc';
    const domainValue: FieldValueOf<typeof plot2dParams.fields.domain> = [-7, 7];
    expect([exprValue, samplesValue, modeValue, domainValue]).toBeDefined();
  });

  it('GroupValues 能推出整组的对象类型', () => {
    const style: GroupValues<typeof plot2dStyle> = {
      stroke: '#4ea1ff',
      width: 3,
      glow: 0.6,
    };
    expect(style.width).toBe(3);
  });

  it('数值字段必须显式给出 bounds（有界或无界），不允许省略', () => {
    // @ts-expect-error 缺 bounds
    const bad: FieldSpec = { type: 'number', label: '线宽', default: 3 };
    expect(bad).toBeDefined();
  });

  it('bounded 必须同时给出 min 与 max', () => {
    // @ts-expect-error 缺 max
    const bad: FieldSpec = { type: 'number', label: '线宽', default: 3, bounds: { kind: 'bounded', min: 0.5 } };
    expect(bad).toBeDefined();
  });

  it('enum 字段的默认值必须落在允许值里', () => {
    type Mode = 'domain' | 'arc';
    // @ts-expect-error 'spiral' 不在允许值里
    const bad: EnumFieldSpec<Mode> = { type: 'enum', label: '生长方式', default: 'spiral', values: ['domain', 'arc'] };
    expect(bad).toBeDefined();
  });

  it('boolean 字段不接受数值边界', () => {
    // @ts-expect-error boolean 没有 bounds
    const bad: FieldSpec = { type: 'boolean', label: '显示笔尖', default: true, bounds: { kind: 'bounded', min: 0, max: 1 } };
    expect(bad).toBeDefined();
  });

  it('字符串长度约束只能进 validation，不能伪装成 JSON Schema 约束', () => {
    const s: FieldSpec = {
      type: 'string',
      label: '标题',
      default: '',
      validation: { maxChars: 80 },
    };
    expect(s.type).toBe('string');
    // @ts-expect-error 顶层不允许直接写 maxLength
    const bad: FieldSpec = { type: 'string', label: '标题', default: '', maxLength: 80 };
    expect(bad).toBeDefined();
  });
});
