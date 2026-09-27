/**
 * UI 控件元数据生成器（P2 的第 2 份产物，也是 P9 第 2 条的实现）。
 *
 * ★ 这里【不出现任何 min/max/step】。它们全部来自 FieldRegistry，
 *   面板只负责把 ControlModel 画成控件。想在面板里手写一个滑块范围，
 *   就得先绕过这一层 —— 那正是规范 §6 要防的事。
 */
import type { ControlKind, FieldGroup, FieldSection, FieldSpec, Unit } from './types';
import { SECTION_SEMANTICS } from './types';

export interface ControlOption {
  readonly value: string;
  readonly label: string;
}

export interface ControlModel {
  /** 文档内的点分路径，面板改它时用它做 Command 的 key */
  readonly path: string;
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly kind: ControlKind;
  readonly value: unknown;
  readonly unit?: Unit;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly ControlOption[];
  readonly optional: boolean;
  readonly engineOnly: boolean;
  readonly animatable: boolean;
  readonly section: FieldSection;
  readonly changeClass: 'geometry' | 'draw' | 'control';
  /** true 表示这个字段有界可滑；false 时面板应当退化成一个纯数字框 */
  readonly bounded: boolean;
}

/**
 * 按 (type, bounds) 推导控件类型。
 *
 * 推导函数本身也在 engine-core 里，所以"控件类型"仍然是单源的：
 * 要么在 FieldSpec.control 上显式写，要么由这里推出来，没有第三种可能。
 */
export function deriveControl(spec: FieldSpec): ControlKind {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (spec.bounds.kind === 'unbounded') return 'number';
      const { min, max, unit } = spec.bounds;
      if (unit === 'ratio' && min === 0 && max === 1) return 'percent';
      if (unit === 'rad') return 'angle';
      return 'slider';
    }
    case 'boolean':
      return 'toggle';
    case 'color':
      return 'color';
    case 'enum':
      return 'select';
    case 'string':
      return (spec.validation?.maxChars ?? 0) > 120 ? 'textarea' : 'text';
    case 'expr':
      return 'expr';
    case 'vec2':
    case 'int2':
      return 'vec2';
    case 'range':
      return 'range';
    case 'id':
      return 'id-picker';
    case 'idList':
      return 'id-list';
  }
}

function optionsOf(spec: FieldSpec): readonly ControlOption[] | undefined {
  if (spec.type !== 'enum') return undefined;
  const labels = spec.optionLabels;
  return spec.values.map((v) => ({
    value: v,
    label: labels === undefined ? v : (labels[v] ?? v),
  }));
}

/**
 * 一组字段 → 一组控件模型。
 *
 * pathPrefix 由调用方给（例如 'plot#1.style'），这样同一份 group 定义
 * 可以被任意对象实例复用 —— 登记的是"plot2d 的样式长什么样"，
 * 而不是"plot#1 的宽度是多少"。
 */
export function controlModelFor(
  group: FieldGroup,
  values: Readonly<Record<string, unknown>>,
  pathPrefix = '',
): readonly ControlModel[] {
  const semantics = SECTION_SEMANTICS[group.section];
  const out: ControlModel[] = [];

  for (const key of Object.keys(group.fields)) {
    const spec = group.fields[key];
    if (spec === undefined) continue;

    const raw = values[key];
    const value = raw === undefined ? spec.default : raw;

    const bounds = spec.type === 'number' || spec.type === 'integer' ? spec.bounds : undefined;
    const isBounded = bounds !== undefined && bounds.kind === 'bounded';
    const min = bounds !== undefined && bounds.kind === 'bounded' ? bounds.min : undefined;
    const max = bounds !== undefined && bounds.kind === 'bounded' ? bounds.max : undefined;
    const step = bounds?.step;
    const unit = bounds?.unit !== undefined && bounds.unit !== 'none' ? bounds.unit : undefined;
    const options = optionsOf(spec);

    out.push({
      path: pathPrefix === '' ? key : pathPrefix + '.' + key,
      key,
      label: spec.label,
      kind: spec.control ?? deriveControl(spec),
      value,
      optional: spec.optional === true,
      engineOnly: spec.engineOnly === true,
      animatable: spec.animatable === true,
      section: group.section,
      changeClass: semantics.changeClass,
      bounded: isBounded,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(unit === undefined ? {} : { unit }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(step === undefined ? {} : { step }),
      ...(options === undefined ? {} : { options }),
    });
  }
  return out;
}

/** 给面板用的索引：group id → group。 */
export function indexGroups(registry: { groups: readonly FieldGroup[] }): ReadonlyMap<string, FieldGroup> {
  const m = new Map<string, FieldGroup>();
  for (const g of registry.groups) m.set(g.id, g);
  return m;
}

/** 找出某个 shape 的某个分区的 group。 */
export function groupFor(
  registry: { groups: readonly FieldGroup[] },
  kind: string,
  owner: string | undefined,
  section: FieldSection,
): FieldGroup | undefined {
  return registry.groups.find((g) => g.kind === kind && g.owner === owner && g.section === section);
}
