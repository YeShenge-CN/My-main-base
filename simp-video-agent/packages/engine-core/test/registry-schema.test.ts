import { describe, expect, it } from 'vitest';
import {
  SCHEMA_PRODUCT_VERSION,
  describeField,
  generateObjectSchema,
  numericRangeOf,
  requireGroup,
  schemaForField,
  type JsonSchema,
} from '../src/registry/schema';
import { REGISTRY } from '../src/registry/fields';
import { controlModelFor } from '../src/registry/ui';
import type { FieldGroup, FieldSpec } from '../src/registry/types';

/**
 * 规范 §6：FieldRegistry 是字段级约束的【唯一真源】，构建期产出三份产物
 *   1. strict tool JSON Schema   ← 本文件验证
 *   2. UI 控件元数据             ← registry/types.test 与 panel-models 已覆盖
 *   3. 字段级校验规则            ← numericRangeOf
 * "这三处任何一处手写 min/max，视为缺陷。"
 *
 * 所以这里的断言不只是"生成器能跑"，而是【三份产物必须互相一致】。
 */

const SAMPLES = 'shape.plot2d.params';
const PLOT_STYLE = 'shape.plot2d.style';

function group(id: string): FieldGroup {
  const g = REGISTRY.groups.find((x) => x.id === id);
  if (g === undefined) throw new Error('registry 缺少 ' + id);
  return g;
}

/** 收集 schema 里所有 minimum/maximum/multipleOf，用来与 registry 对账。 */
function constraintsIn(schema: JsonSchema): Record<string, Record<string, number>> {
  const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
  const out: Record<string, Record<string, number>> = {};
  for (const [key, sub] of Object.entries(props)) {
    const inner = (sub['anyOf'] as JsonSchema[] | undefined)?.[0] ?? sub;
    const picked: Record<string, number> = {};
    for (const c of ['minimum', 'maximum', 'multipleOf']) {
      const v = inner[c];
      if (typeof v === 'number') picked[c] = v;
    }
    if (Object.keys(picked).length > 0) out[key] = picked;
  }
  return out;
}

describe('生成器：strict 形态的四条硬约束', () => {
  it('所有属性都进 required，且 additionalProperties:false', () => {
    for (const g of REGISTRY.groups) {
      const schema = generateObjectSchema(g);
      const props = Object.keys((schema['properties'] ?? {}) as Record<string, unknown>);
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect(schema['required']).toEqual(props); // 一个都不能漏
      expect(props).toEqual(Object.keys(g.fields));
    }
  });

  it('不产出 strict 模式不接受的关键字（minLength / minItems / maxItems …）', () => {
    const banned = ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', '$ref', 'oneOf'];
    for (const g of REGISTRY.groups) {
      const text = JSON.stringify(generateObjectSchema(g));
      for (const key of banned) expect(text).not.toContain('"' + key + '"');
    }
  });

  it("all-nullable：字段仍在 required 里，类型变成 anyOf:[T,null]", () => {
    const schema = generateObjectSchema(group(PLOT_STYLE), { mode: 'all-nullable' });
    const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    expect(props['width']).toEqual({ anyOf: [{ type: 'number', minimum: 0.5, maximum: 10, multipleOf: 0.5 }, { type: 'null' }] });
    expect(schema['required']).toEqual(Object.keys(props));
  });

  it('by-spec：optional 的字段变 nullable，非 optional 的保持必填', () => {
    const g: FieldGroup = {
      id: 'test.optional',
      kind: 'effect',
      owner: 'test',
      section: 'params',
      label: '测试',
      pathTemplate: 'effects.*.params',
      fields: {
        req: { type: 'number', label: '必填', default: 1, bounds: { kind: 'unbounded' } },
        opt: { type: 'number', label: '可选', default: 1, bounds: { kind: 'unbounded' }, optional: true },
      },
    };
    const props = (generateObjectSchema(g, { mode: 'by-spec' })['properties'] ?? {}) as Record<string, JsonSchema>;
    expect(props['req']).toEqual({ type: 'number' });
    expect(props['opt']).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
  });

  it('include 过滤不会漏字段（未登记的 key 直接抛，不静默少生成）', () => {
    const schema = generateObjectSchema(group(PLOT_STYLE), { include: ['width'] });
    expect(Object.keys((schema['properties'] ?? {}) as Record<string, unknown>)).toEqual(['width']);
    const wild: FieldSpec = { type: 'unknown' as FieldSpec['type'], label: 'x', default: 0 } as FieldSpec;
    expect(() => schemaForField(wild)).toThrow(/未登记的字段类型/);
  });

  it('extra 字段会进 properties 与 required', () => {
    const schema = generateObjectSchema(group(PLOT_STYLE), {
      include: ['width', 'tip'],
      extra: { tip: { type: 'boolean' } },
    });
    const props = (schema['properties'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['width', 'tip']);
    expect(schema['required']).toEqual(['width', 'tip']);
  });
});

describe('三份产物必须互相一致（规范 §6 的核心断言）', () => {
  it('每个有界数值字段：schema 的 min/max/step === registry 的 bounds', () => {
    for (const g of REGISTRY.groups) {
      const constraints = constraintsIn(generateObjectSchema(g));
      for (const [key, spec] of Object.entries(g.fields)) {
        if (spec.type !== 'number' && spec.type !== 'integer') continue;
        const expected: Record<string, number> = {};
        if (spec.bounds.kind === 'bounded') {
          expected['minimum'] = spec.bounds.min;
          expected['maximum'] = spec.bounds.max;
        }
        if (spec.bounds.step !== undefined) expected['multipleOf'] = spec.bounds.step;
        expect(constraints[key] ?? {}).toEqual(expected);
      }
    }
  });

  it('samples 的范围来自 registry（模型终于能看见下限）', () => {
    const samples = group(SAMPLES).fields['samples'];
    if (samples === undefined || samples.type !== 'integer' || samples.bounds.kind !== 'bounded') {
      throw new Error('registry 的 samples 定义变了');
    }
    const schema = generateObjectSchema(group(SAMPLES));
    const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    expect(props['samples']).toEqual({
      type: 'integer',
      minimum: samples.bounds.min, // 16
      maximum: samples.bounds.max, // 20000
      multipleOf: samples.bounds.step, // 1
    });
    // 校验器要用的第 3 份产物与 schema 是同一个数
    expect(numericRangeOf(REGISTRY, SAMPLES, 'samples')).toEqual({
      min: samples.bounds.min,
      max: samples.bounds.max,
      step: samples.bounds.step,
    });
  });

  it('UI 控件元数据与 schema 说的是同一件事（范围、枚举、默认值）', () => {
    const styleGroup = group(PLOT_STYLE);
    const models = controlModelFor(styleGroup, {});
    const schema = generateObjectSchema(styleGroup);
    const props = (schema['properties'] ?? {}) as Record<string, JsonSchema>;
    for (const model of models) {
      const sub = props[model.key];
      expect(sub).toBeDefined();
      if (model.bounded) {
        expect(sub?.['minimum']).toBe(model.min);
        expect(sub?.['maximum']).toBe(model.max);
        expect(sub?.['multipleOf']).toBe(model.step);
      }
    }
  });

  it('枚举值来自 registry，顺序一致', () => {
    const drawOn = group('effect.drawOn.params');
    const mode = drawOn.fields['mode'];
    if (mode === undefined || mode.type !== 'enum') throw new Error('registry 的 mode 定义变了');
    const props = (generateObjectSchema(drawOn)['properties'] ?? {}) as Record<string, JsonSchema>;
    expect(props['mode']).toEqual({ type: 'string', enum: [...mode.values] });
    // UI 下拉的选项也是同一份
    const options = controlModelFor(drawOn, {}).find((m) => m.key === 'mode')?.options ?? [];
    expect(options.map((o) => o.value)).toEqual([...mode.values]);
  });

  it('表达式字段声明了变量（模型不用猜 x 还是 t）', () => {
    const props = (generateObjectSchema(group(SAMPLES))['properties'] ?? {}) as Record<string, JsonSchema>;
    expect(props['expr']?.['type']).toBe('string');
    expect(String(props['expr']?.['description'])).toContain('x');
  });

  it('每个字段的 description 非空（模型只能靠它理解字段）', () => {
    for (const g of REGISTRY.groups) {
      for (const spec of Object.values(g.fields)) {
        expect(describeField(spec).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('requireGroup 与版本', () => {
  it('找不到分组就抛，不返回 undefined', () => {
    expect(() => requireGroup(REGISTRY, 'shape', 'nope', 'params')).toThrow(/registry 缺少分组/);
    expect(requireGroup(REGISTRY, 'shape', 'plot2d', 'params').id).toBe(SAMPLES);
  });

  it('产物版本号导出（便于排查 schema 与引擎不同版）', () => {
    expect(SCHEMA_PRODUCT_VERSION).toBe(REGISTRY.version);
  });

  it('numericRangeOf 对无界字段返回空约束而不是 undefined', () => {
    expect(numericRangeOf(REGISTRY, 'object.tf', 'x')).toEqual({});
    expect(numericRangeOf(REGISTRY, 'object.tf', 'nope')).toBeUndefined();
    expect(numericRangeOf(REGISTRY, 'no.such.group', 'x')).toBeUndefined();
  });
});
