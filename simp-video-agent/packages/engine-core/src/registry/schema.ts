/**
 * FieldRegistry → strict tool JSON Schema（规范 §6 的【第 1 份产物】）。
 *
 * ★ 在这个文件之前，三份产物里只有 UI 控件元数据是生成的，
 *   tool schema 里的 min/max/enum 全是手写的（tools.ts 里一个个 nullable(num)）。
 *   这直接违反规范 §6："这三处任何一处手写 min/max，视为缺陷"。
 *   后果不是洁癖问题：手写的范围与 registry 会漂移，
 *   而 registry 是校验器唯一认的那个 —— 于是"模型看见的范围"和"引擎接受的范围"不一致。
 *
 * ── strict 形态的四条硬约束（DeepSeek strict 模式）──────────────
 *   1. object 的【所有】属性都必须进 required —— 所以"可选"不是从 required 里拿掉，
 *      而是把类型写成 anyOf:[T, {type:"null"}]，模型传 null 表示"这一项不改"。
 *   2. additionalProperties: false。
 *   3. 不接受 minLength / maxLength / minItems / maxItems。
 *   4. 数值约束只认 minimum / maximum / multipleOf / enum。
 *
 * 生成器【不】产出业务规则：依赖关系、引用完整性、采样够不够密都不在这里。
 * 它只把 registry 已经写下的字段级约束翻译成另一种编码。
 */
import type {
  FieldGroup,
  FieldSection,
  FieldSpec,
  NumericBounds,
  Unit,
} from './types';

/** JSON Schema 片段。刻意用宽松类型 —— 它就是要序列化给模型看的普通 JSON。 */
export type JsonSchema = Record<string, unknown>;

/** registry 的三份产物共用同一个版本号，便于排查"schema 与引擎不同版"。 */
export const SCHEMA_PRODUCT_VERSION = '0.1.0';

/**
 * 画布像素尺寸的上下界。
 *
 * ★ 为什么它是一个【命名常量】而不是散落的字面量：
 *   这条边界不属于任何单个 FieldSpec（viewport 是 meta 上的一个二元组，
 *   不是 registry 里的字段），但它仍然必须只有一个定义处 ——
 *   命令层（set_meta 的参数校验）与工具 schema 都要用它。
 *   随手写 16 / 8192 就会像之前那样被"不许手写范围"的断言抓住。
 */
export const VIEWPORT_MIN_PX = 16;
export const VIEWPORT_MAX_PX = 8192;

/** 单位后缀，写进 description。与 UI 的 UNIT_SUFFIX 是同一套语义。 */
const UNIT_TEXT: Readonly<Record<Unit, string>> = {
  none: '',
  s: '秒',
  ms: '毫秒',
  world: '世界单位',
  px: '像素',
  deg: '度',
  rad: '弧度',
  ratio: '比例 0..1',
  count: '个数',
  perSecond: '每秒',
};

function boundsOf(spec: FieldSpec): NumericBounds | undefined {
  if (spec.type === 'number' || spec.type === 'integer') return spec.bounds;
  return undefined;
}

/** 把 registry 的 description + 单位合成一句能给模型看的话。 */
export function describeField(spec: FieldSpec): string {
  const parts: string[] = [];
  if (spec.label !== '') parts.push(spec.label);
  if (spec.description !== undefined && spec.description !== '') parts.push(spec.description);
  const bounds = boundsOf(spec);
  if (bounds !== undefined && bounds.kind === 'bounded') {
    const unit = bounds.unit === undefined || bounds.unit === 'none' ? '' : UNIT_TEXT[bounds.unit];
    parts.push('范围 ' + bounds.min + '~' + bounds.max + (unit === '' ? '' : ' ' + unit));
  } else if (bounds !== undefined && bounds.unit !== undefined && bounds.unit !== 'none') {
    parts.push('单位：' + UNIT_TEXT[bounds.unit]);
  }
  return parts.join('。');
}

/** 把 optional 的字段变成 "T | null"。 */
function asNullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * 一个字段 → 类型片段（不含 required / nullable 处理）。
 *
 * 返回 null 表示这个字段【按当前策略不该出现】（由 include 决定，不会走到这里）；
 * 生成器遇到不认识的 FieldSpec 会抛错，而不是安静地少生成一个字段 ——
 * "schema 里少了一个字段"会让模型永远无法设置它，而且没人会发现。
 */
export function schemaForField(spec: FieldSpec): JsonSchema {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      const out: JsonSchema = { type: spec.type === 'integer' ? 'integer' : 'number' };
      if (spec.bounds.kind === 'bounded') {
        out['minimum'] = spec.bounds.min;
        out['maximum'] = spec.bounds.max;
      }
      if (spec.bounds.step !== undefined) out['multipleOf'] = spec.bounds.step;
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'color':
      return { type: 'string', description: spec.alpha === true ? '#rrggbb 或 #rrggbbaa' : '#rrggbb' };
    case 'enum':
      return { type: 'string', enum: [...spec.values] };
    case 'string':
      return { type: 'string' };
    case 'expr':
      return {
        type: 'string',
        description: '可用变量：' + spec.variables.join('、') + '。函数白名单由编译器强制。',
      };
    case 'vec2':
    case 'int2':
    case 'range': {
      const out: JsonSchema = {
        type: 'array',
        items: spec.item === undefined ? { type: 'number' } : numberItems(spec.item),
      };
      // 定长两元组：DeepSeek strict 接受 minItems/maxItems 吗？
      // 规范说【不接受】minLength/maxLength/minItems/maxItems，所以这里不写长度约束，
      // 长度由 FieldRegistry 的字段级校验（第 3 份产物）在执行期判定。
      return out;
    }
    case 'id':
      return { type: 'string', description: '指向一个 ' + spec.refKind + ' 的 id' };
    case 'idList':
      return { type: 'array', items: { type: 'string' } };
    default:
      throw new Error('schemaForField: 未登记的字段类型 ' + JSON.stringify(spec));
  }
}

function numberItems(bounds: NumericBounds): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  if (bounds.kind === 'bounded') {
    out['minimum'] = bounds.min;
    out['maximum'] = bounds.max;
  }
  if (bounds.step !== undefined) out['multipleOf'] = bounds.step;
  return out;
}

export interface GenerateOptions {
  /** 只生成这些字段（按 key 判断）。省略则全部。 */
  readonly include?: readonly string[];
  /** 一定要出现的字段（哪怕不在 registry 里）。用于 tf 这类由文档结构决定的字段。 */
  readonly extra?: Readonly<Record<string, JsonSchema>>;
  /**
   * 'all'（默认）：所有字段都进 required —— create 类命令用。
   * 'all-nullable'：所有字段都变成 nullable 但【仍然在 required 里】—— 编辑类命令用。
   * 'by-spec'：按 registry 的 optional 标记决定，其余进 required。
   */
  readonly mode?: 'all' | 'all-nullable' | 'by-spec';
}

/**
 * 一组字段 → strict object schema。
 *
 * ★ 无论哪种 mode，属性都留在 required 里 —— 这是 strict 模式的硬要求。
 *   "可以不传"这件事由 anyOf:[T,null] 表达。
 */
export function generateObjectSchema(group: FieldGroup, opts: GenerateOptions = {}): JsonSchema {
  const mode = opts.mode ?? 'all';
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const key of Object.keys(group.fields)) {
    const spec = group.fields[key];
    if (spec === undefined) continue;
    if (opts.include !== undefined && !opts.include.includes(key)) continue;

    const schema = schemaForField(spec);
    const nullable = mode === 'all-nullable' || (mode === 'by-spec' && spec.optional === true);
    properties[key] = nullable ? asNullable(schema) : schema;
    required.push(key);
  }

  for (const key of Object.keys(opts.extra ?? {})) {
    if (opts.include !== undefined && !opts.include.includes(key)) continue;
    const extra = opts.extra?.[key];
    if (extra === undefined) continue;
    properties[key] = mode === 'all-nullable' ? asNullable(extra) : extra;
    if (!required.includes(key)) required.push(key);
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * registry 里登记的字段名查询（规范 §6 的第 3 份产物：字段级校验规则）。
 *
 * ★ 用途：写入路径需要知道"这个 shape 的 params/style 允许哪些键"。
 *   没有它，`create_object` 就会照单全收任何键名 ——
 *   而 commands.ts 的注释一直写着"未登记的名字报 errored(field_not_in_shape)"，
 *   这句承诺此前【没有任何代码兑现】，也没有测试（见 test/field-in-shape.test.ts）。
 *
 * group 不存在时返回 undefined，表示"这个 shape 引擎根本不认识" ——
 * 那种情况要报 unsupported_shape，而不是"字段全都不合法"。
 */
export function registeredFields(
  registry: { readonly groups: readonly FieldGroup[] },
  kind: FieldGroup['kind'],
  owner: string,
  section: FieldSection,
): readonly string[] | undefined {
  const group = registry.groups.find((g) => g.kind === kind && g.owner === owner && g.section === section);
  return group === undefined ? undefined : Object.keys(group.fields);
}

/** 找出一组键里【没有登记】的那些，按出现顺序。group 不存在时返回全部（调用方据此报 unsupported_shape）。 */
export function unknownFields(
  registry: { readonly groups: readonly FieldGroup[] },
  kind: FieldGroup['kind'],
  owner: string,
  section: FieldSection,
  keys: readonly string[],
): readonly string[] {
  const known = registeredFields(registry, kind, owner, section);
  if (known === undefined) return keys;
  return keys.filter((k) => !known.includes(k));
}

/**
 * 一组键里【登记过】的那些。
 *
 * 用于命令载荷：命令对象上常常混着命令层的字段（如 inline effect 的 `type`），
 * 它们不是 shape 的字段，写文档时必须丢掉 —— 但丢掉要有据可依，
 * 所以这里显式过滤，而不是"把整个对象塞进去"。
 */
export function knownFields(
  registry: { readonly groups: readonly FieldGroup[] },
  kind: FieldGroup['kind'],
  owner: string,
  section: FieldSection,
  keys: readonly string[],
): readonly string[] {
  const known = registeredFields(registry, kind, owner, section);
  if (known === undefined) return [];
  return keys.filter((k) => known.includes(k));
}

/**
 * 查一个字段的规格（注册表的唯一查询入口）。
 *
 * ★ 存在的理由：判定"这个字段是不是颜色"必须问 registry，而不是靠字段名或值猜。
 *   字段类型只有一处真源（规范 §6）—— 加一个字符串字段时它会自动落到普通语义，
 *   不需要改任何判定代码。
 */
export function findField(
  registry: { readonly groups: readonly FieldGroup[] },
  kind: FieldGroup['kind'],
  owner: string,
  section: FieldSection,
  key: string,
): FieldSpec | undefined {
  const group = registry.groups.find((g) => g.kind === kind && g.owner === owner && g.section === section);
  return group?.fields[key];
}

/** 从 registry 里找一组。找不到直接抛 —— 静默返回 undefined 会让 schema 少一整块。 */
export function requireGroup(
  registry: { readonly groups: readonly FieldGroup[] },
  kind: FieldGroup['kind'],
  owner: string | undefined,
  section: FieldGroup['section'],
): FieldGroup {
  const hit = registry.groups.find(
    (g) => g.kind === kind && g.owner === owner && g.section === section,
  );
  if (hit === undefined) {
    throw new Error(
      'registry 缺少分组: kind=' + kind + ' owner=' + String(owner) + ' section=' + section,
    );
  }
  return hit;
}

/**
 * 字段的取值范围，给【校验器】用（规范 §6 的第 3 份产物）。
 *
 * 校验器自己不该再手写 400 / 2400 这类阈值 —— 它从这里取。
 * 返回 undefined 表示这个字段没有数值边界。
 */
export function numericRangeOf(
  registry: { readonly groups: readonly FieldGroup[] },
  groupId: string,
  field: string,
): { readonly min?: number; readonly max?: number; readonly step?: number } | undefined {
  const group = registry.groups.find((g) => g.id === groupId);
  const spec = group?.fields[field];
  if (spec === undefined) return undefined;
  const bounds = boundsOf(spec);
  if (bounds === undefined) return undefined;
  if (bounds.kind === 'bounded') {
    return bounds.step === undefined
      ? { min: bounds.min, max: bounds.max }
      : { min: bounds.min, max: bounds.max, step: bounds.step };
  }
  return bounds.step === undefined ? {} : { step: bounds.step };
}
