import { describe, expect, it } from 'vitest';
import { controlModelFor, deriveControl, groupFor } from '../src/registry/ui';
import { REGISTRY } from '../src/registry/fields';
import type { FieldSpec } from '../src/registry/types';

describe('deriveControl：控件类型由 (type, bounds) 推导，不手写', () => {
  it('有界数值 → 滑块；无界数值 → 纯数字框', () => {
    expect(
      deriveControl({ type: 'number', label: 'x', default: 0, bounds: { kind: 'bounded', min: 0, max: 10 } }),
    ).toBe('slider');
    expect(
      deriveControl({ type: 'number', label: 'x', default: 0, bounds: { kind: 'unbounded' } }),
    ).toBe('number');
  });

  it('0..1 比例 → 百分比控件；弧度 → 角度控件', () => {
    expect(
      deriveControl({ type: 'number', label: 'x', default: 0, bounds: { kind: 'bounded', min: 0, max: 1, unit: 'ratio' } }),
    ).toBe('percent');
    expect(
      deriveControl({ type: 'number', label: 'x', default: 0, bounds: { kind: 'bounded', min: -3, max: 3, unit: 'rad' } }),
    ).toBe('angle');
  });

  it('其余类型一对一映射', () => {
    const cases: [FieldSpec, string][] = [
      [{ type: 'color', label: 'c', default: '#fff' }, 'color'],
      [{ type: 'boolean', label: 'b', default: true }, 'toggle'],
      [{ type: 'expr', label: 'e', default: 'x', variables: ['x'] }, 'expr'],
      [{ type: 'range', label: 'r', default: [0, 1] }, 'range'],
      [{ type: 'vec2', label: 'v', default: [0, 1] }, 'vec2'],
      [{ type: 'enum', label: 'm', default: 'a', values: ['a', 'b'] }, 'select'],
      [{ type: 'string', label: 's', default: '' }, 'text'],
    ];
    for (const [spec, kind] of cases) expect(deriveControl(spec)).toBe(kind);
  });
});

describe('controlModelFor：面板拿到的就是可以直接画的模型', () => {
  const plotStyle = groupFor(REGISTRY, 'shape', 'plot2d', 'style');
  if (plotStyle === undefined) throw new Error('registry 缺少 plot2d.style');

  it('把 FieldRegistry 的约束原样带出来（面板不重写任何 min/max）', () => {
    const models = controlModelFor(plotStyle, { stroke: '#f00', width: 5, glow: 0.3 }, 'plot#1.style');
    const width = models.find((m) => m.key === 'width');
    expect(width?.kind).toBe('slider');
    expect(width?.min).toBe(0.5);
    expect(width?.max).toBe(10);
    expect(width?.step).toBe(0.5);
    expect(width?.unit).toBe('world');
    expect(width?.path).toBe('plot#1.style.width');
    expect(width?.changeClass).toBe('draw');
    expect(width?.animatable).toBe(true);
    expect(width?.value).toBe(5);
  });

  it('取色器 / 下拉 / 开关都从类型自动选出来', () => {
    const stroke = controlModelFor(plotStyle, {}, '').find((m) => m.key === 'stroke');
    expect(stroke?.kind).toBe('color');
    expect(stroke?.value).toBe('#4ea1ff'); // 没给值就用 registry 的默认值

    const drawOn = groupFor(REGISTRY, 'effect', 'drawOn', 'params');
    if (drawOn === undefined) throw new Error('registry 缺少 drawOn');
    const mode = controlModelFor(drawOn, { mode: 'arc' }, 'eff#1.params').find((m) => m.key === 'mode');
    expect(mode?.kind).toBe('select');
    expect(mode?.options).toEqual([
      { value: 'domain', label: '按定义域' },
      { value: 'arc', label: '按弧长' },
    ]);

    const tip = controlModelFor(drawOn, {}, '').find((m) => m.key === 'tip');
    expect(tip?.kind).toBe('toggle');
  });

  it('geometry 与 draw 的分界随字段一起带出来', () => {
    const params = groupFor(REGISTRY, 'shape', 'plot2d', 'params');
    if (params === undefined) throw new Error('registry 缺少 plot2d.params');
    const expr = controlModelFor(params, {}, 'plot#1.params').find((m) => m.key === 'expr');
    expect(expr?.kind).toBe('expr');
    expect(expr?.changeClass).toBe('geometry');
  });

  it('无界字段不会被伪造出一对 min/max', () => {
    const tf = groupFor(REGISTRY, 'object', undefined, 'tf');
    const byId = REGISTRY.groups.filter((g) => g.id === 'object.tf');
    const group = tf ?? byId[0];
    if (group === undefined) throw new Error('registry 缺少 object.tf');
    const x = controlModelFor(group, { x: 3 }, 'plot#1.tf').find((m) => m.key === 'x');
    expect(x?.kind).toBe('number');
    expect(x?.bounded).toBe(false);
    expect(x?.min).toBeUndefined();
    expect(x?.max).toBeUndefined();
  });

  it('engineOnly 字段会被标出来（面板要把它画成只读）', () => {
    const meta = REGISTRY.groups.find((g) => g.id === 'scene.meta');
    if (meta === undefined) throw new Error('registry 缺少 scene.meta');
    const fps = controlModelFor(meta, {}, '').find((m) => m.key === 'fps');
    expect(fps?.engineOnly).toBe(true);
  });

  it('组 id 唯一，且每条字段都有中文标签', () => {
    const ids = REGISTRY.groups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of REGISTRY.groups) {
      for (const key of Object.keys(g.fields)) {
        const spec = g.fields[key];
        expect(spec?.label, g.id + '.' + key + ' 缺少中文标签').toBeTruthy();
      }
    }
  });
});
