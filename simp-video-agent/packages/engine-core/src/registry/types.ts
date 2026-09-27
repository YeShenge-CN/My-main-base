/**
 * FieldRegistry —— 字段级约束元数据的【唯一真源】（规范 §6）。
 *
 * 三条铁律：
 *  1. 一份 registry 同时喂三份产物：strict tool JSON Schema、UI 控件元数据、
 *     字段级校验规则。因此 min/max/step/enum 在整个仓库里只允许在这里出现一次。
 *     schema 生成器里手写 minimum、面板代码里手写滑块范围、校验器里手写上下界，
 *     三者任一都算缺陷。
 *  2. 它【只】装字段级约束：类型、范围、步长、枚举、单位、默认值、中文标签、
 *     控件类型。业务规则（引用完整性、循环引用、采样是否够密、AABB 越界…）
 *     一律不进这里 —— 那些是各自独立注册的 VALIDATORS（规范 §6）。
 *  3. params / style 的分界在类型层面固化：字段属于哪个 FieldSection 是必填的，
 *     且 FieldSection 与"改动后要重算到哪一步"的映射写死在 SECTION_SEMANTICS 里。
 *
 * 本文件是【纯类型 + 纯常量】，无副作用、无 I/O，符合 engine-core 的宿主无关约束。
 */

/* ══════════════════════════════════════════════════════════════
 * 1. 单位
 * ══════════════════════════════════════════════════════════════ */

/**
 * 字段单位。封闭集合 —— 不允许自由字符串，否则会在三份产物里各写各的。
 * unit 同时喂：工具 schema 的 description 后缀、面板的数值后缀、校验器的类型兼容判定。
 */
export type Unit =
  | 'none'
  /** 秒 */
  | 's'
  | 'ms'
  /** 数学世界单位（文档里不存在像素概念，规范 §4） */
  | 'world'
  /** 像素。仅用于 viewport 这类真正以像素为单位的字段 */
  | 'px'
  | 'deg'
  | 'rad'
  /** 0..1 的比例 */
  | 'ratio'
  /** 无量纲计数（采样数、帧数） */
  | 'count'
  | 'perSecond';

/* ══════════════════════════════════════════════════════════════
 * 2. 数值边界
 * ══════════════════════════════════════════════════════════════ */

interface NumericBoundsCommon {
  /** 步长。同一份值喂给 JSON Schema 的 multipleOf 与面板滑块的 step。 */
  readonly step?: number;
  readonly unit?: Unit;
}

/**
 * 数值边界。用判别式联合而不是"可选 min/max"，
 * 是为了让"忘记写 min"这种失误在类型层面无法通过 —— 你必须显式说清楚
 * 这个字段是有界的还是无界的。
 */
export type NumericBounds =
  | ({ readonly kind: 'bounded'; readonly min: number; readonly max: number } & NumericBoundsCommon)
  | ({ readonly kind: 'unbounded' } & NumericBoundsCommon);

/* ══════════════════════════════════════════════════════════════
 * 3. UI 控件类型
 * ══════════════════════════════════════════════════════════════ */

/**
 * 控件类型。可以省略 —— 省略时由 (type, bounds) 推导（生成器负责），
 * 但推导函数本身也在 engine-core 里，所以仍然是单源。
 */
export type ControlKind =
  | 'slider'
  | 'number'
  | 'angle'
  | 'percent'
  | 'color'
  | 'select'
  | 'toggle'
  | 'text'
  | 'textarea'
  | 'expr'
  | 'vec2'
  | 'range'
  | 'id-picker'
  | 'id-list';

/* ══════════════════════════════════════════════════════════════
 * 4. 分区与变更语义（params / style 分界）
 * ══════════════════════════════════════════════════════════════ */

/** 字段在 Scene Doc 中归属的分区。 */
export type FieldSection =
  /** 几何：改动触发重采样 / 重新求值几何 */
  | 'params'
  /** 绘制：改动只重绘，不重采样 */
  | 'style'
  /** 对象变换 */
  | 'tf'
  /**
   * 分组：继承谁的变换。
   *
   * ★ 单独一个分区而不是塞进 `tf`：它改的是"变换链上接在谁后面"，
   *   而不是变换本身的某个分量。语义上属于 control（只影响编排），
   *   与 tf 的 draw 不同 —— 混在一起会让"改父级要不要重采样"这种
   *   问题变得没法回答。
   */
  | 'parent'
  /** 动画轨道 */
  | 'anim'
  | 'camera'
  | 'meta';

/** 改动一个字段后，引擎至少要重算到哪一步。 */
export interface SectionSemantics {
  /** geometry = 要重采样；draw = 只重绘；control = 只影响编排 */
  readonly changeClass: 'geometry' | 'draw' | 'control';
  /** 是否必须让采样缓存失效 */
  readonly invalidatesSampling: boolean;
}

/**
 * 分区 → 变更语义。这张表是规范 §5 那句
 * "params 是 geometry 类，style 是 draw 类" 的机器可读形式。
 */
export const SECTION_SEMANTICS: Readonly<Record<FieldSection, SectionSemantics>> = {
  params: { changeClass: 'geometry', invalidatesSampling: true },
  style: { changeClass: 'draw', invalidatesSampling: false },
  tf: { changeClass: 'draw', invalidatesSampling: false },
  parent: { changeClass: 'control', invalidatesSampling: false },
  anim: { changeClass: 'control', invalidatesSampling: false },
  camera: { changeClass: 'control', invalidatesSampling: false },
  meta: { changeClass: 'control', invalidatesSampling: false },
};

/* ══════════════════════════════════════════════════════════════
 * 5. 字段规格
 * ══════════════════════════════════════════════════════════════ */

/** 字段的取值类型。 */
export type FieldType =
  | 'number'
  | 'integer'
  | 'boolean'
  /** '#rrggbb' 或 '#rrggbbaa' */
  | 'color'
  /** 字符串枚举 */
  | 'enum'
  | 'string'
  /** 白名单表达式源码（规范：自研编译器，禁止 eval） */
  | 'expr'
  /** [x, y] */
  | 'vec2'
  /** [x, y] 且必须为整数 */
  | 'int2'
  /** [lo, hi]，如 plot2d 的 domain */
  | 'range'
  /** 指向文档内某个对象 / 效果 / 标记的 id */
  | 'id'
  | 'idList';

interface FieldSpecBase<TValue> {
  /** 中文标签，面板与工具 schema description 都用它 */
  readonly label: string;
  /** 补充说明，进工具 schema 的 description */
  readonly description?: string;
  /** 默认值。模型不传、用户没改时引擎取值。 */
  readonly default: TValue;

  /**
   * 可选字段。
   *
   * 注意它与 strict JSON Schema 的转换关系（规范 §7 / P2 清单第 5 条）：
   * DeepSeek strict 要求 object 的所有属性都进 required，
   * 所以"可选"【不是】把字段从 required 里拿掉，而是把它的类型写成
   *   anyOf: [ { 原有类型 }, { type: "null" } ]
   * 并且仍然留在 required 里。模型传 null 表示"这一项不改"。
   */
  readonly optional?: boolean;

  /** 只读字段：模型不可写，只有引擎能改（如 owner.bornAt）。 */
  readonly engineOnly?: boolean;

  /** 能否被 anim 关键帧 / 表达式轨道驱动。 */
  readonly animatable?: boolean;

  /** 显式指定控件；省略则按 (type, bounds) 推导。 */
  readonly control?: ControlKind;
}

export interface NumberFieldSpec extends FieldSpecBase<number> {
  readonly type: 'number';
  readonly bounds: NumericBounds;
}

export interface IntegerFieldSpec extends FieldSpecBase<number> {
  readonly type: 'integer';
  readonly bounds: NumericBounds;
}

export interface BooleanFieldSpec extends FieldSpecBase<boolean> {
  readonly type: 'boolean';
}

export interface ColorFieldSpec extends FieldSpecBase<string> {
  readonly type: 'color';
  /** 是否允许 #rrggbbaa */
  readonly alpha?: boolean;
}

export interface EnumFieldSpec<V extends string = string> extends FieldSpecBase<V> {
  readonly type: 'enum';
  /** 允许值。用 readonly 元组以便推出字面量联合。 */
  readonly values: readonly V[];
  /** 值 → 中文展示名。省略则直接显示原值。 */
  readonly optionLabels?: Readonly<Record<V, string>>;
}

export interface StringFieldSpec extends FieldSpecBase<string> {
  readonly type: 'string';
  /**
   * 仅用于【校验产物】的字符串约束。
   * 刻意不叫 minLength/maxLength：JSON Schema 生成器读不到它们，
   * 因为 DeepSeek strict 不接受 minLength / maxLength。
   */
  readonly validation?: {
    readonly minChars?: number;
    readonly maxChars?: number;
    readonly pattern?: string;
  };
}

export interface ExprFieldSpec extends FieldSpecBase<string> {
  readonly type: 'expr';
  /**
   * 允许出现的自由变量名（如 'x'、't'）。
   * 函数白名单（sin/cos/…）是编译器的事，不在这里登记。
   */
  readonly variables: readonly string[];
}

interface Tuple2Base<TValue> extends FieldSpecBase<TValue> {
  /** 分量级约束。只允许一层嵌套，不做递归。 */
  readonly item?: NumericBounds;
}

export interface Vec2FieldSpec extends Tuple2Base<readonly [number, number]> {
  readonly type: 'vec2';
}

export interface Int2FieldSpec extends Tuple2Base<readonly [number, number]> {
  readonly type: 'int2';
}

export interface RangeFieldSpec extends Tuple2Base<readonly [number, number]> {
  readonly type: 'range';
}

export interface IdFieldSpec extends FieldSpecBase<string> {
  readonly type: 'id';
  /** 允许指向哪类实体。校验器用它做引用完整性检查。 */
  readonly refKind: 'object' | 'effect' | 'marker' | 'layer';
}

export interface IdListFieldSpec extends FieldSpecBase<readonly string[]> {
  readonly type: 'idList';
  readonly refKind: 'object' | 'effect' | 'marker' | 'layer';
}

/** 字段规格的判别式联合。 */
export type FieldSpec =
  | NumberFieldSpec
  | IntegerFieldSpec
  | BooleanFieldSpec
  | ColorFieldSpec
  | EnumFieldSpec
  | StringFieldSpec
  | ExprFieldSpec
  | Vec2FieldSpec
  | Int2FieldSpec
  | RangeFieldSpec
  | IdFieldSpec
  | IdListFieldSpec;

/** 从字段规格推出它的 TS 取值类型。文档层类型可以据此自动生成。 */
export type FieldValueOf<S extends FieldSpec> = S extends { readonly type: 'integer' }
  ? number
  : S extends { readonly type: 'number' }
    ? number
    : S extends { readonly type: 'boolean' }
      ? boolean
      : S extends { readonly type: 'color' }
        ? string
        : S extends { readonly type: 'string' }
          ? string
          : S extends { readonly type: 'expr' }
            ? string
            : S extends { readonly type: 'id' }
              ? string
              : S extends { readonly type: 'idList' }
                ? readonly string[]
                : S extends { readonly type: 'enum'; readonly values: readonly (infer V)[] }
                  ? V
                  : S extends { readonly type: 'vec2' | 'int2' | 'range' }
                    ? readonly [number, number]
                    : never;

/* ══════════════════════════════════════════════════════════════
 * 6. 字段组与注册表
 * ══════════════════════════════════════════════════════════════ */

export type FieldGroupKind =
  /** meta / theme */
  | 'scene'
  | 'theme'
  /** 按 shape 名分组的 params / style */
  | 'shape'
  /** 按 effect type 分组的 params */
  | 'effect'
  /** 所有对象共有的 tf */
  | 'object'
  | 'camera'
  /** anim 轨道自身的字段 */
  | 'motion';

export interface FieldGroup {
  /** 稳定 id，形如 'shape.plot2d.params'、'effect.drawOn.params' */
  readonly id: string;
  readonly kind: FieldGroupKind;
  /** shape 名 / effect type；scene、camera、motion 类为 undefined */
  readonly owner?: string;
  readonly section: FieldSection;
  readonly label: string;
  /**
   * 该组字段在 Scene Doc 里的路径模板（不含字段名本身），
   * 用于让校验器生成 Issue.path，例如 'objects.*.params'。
   */
  readonly pathTemplate: string;
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

export interface FieldRegistry {
  /** registry 自身的版本，会写进三份产物的头部 */
  readonly version: string;
  readonly groups: readonly FieldGroup[];
}

/** 从一组的字面量类型推出该组的取值对象类型。 */
export type GroupValues<G extends FieldGroup> = {
  readonly [K in keyof G['fields']]: FieldValueOf<G['fields'][K]>;
};

/* ══════════════════════════════════════════════════════════════
 * 7. Scene Doc 中字段的落盘形态
 * ══════════════════════════════════════════════════════════════ */

/**
 * 字段在 Scene Doc 里的序列化形态。
 *
 * ⚠️ 待确认（P2 开工前必须定）：文档示例里
 *     "width": { "v": 3.0, "min": 0.5, "max": 10, "step": 0.5 }
 * 带着 min/max/step。这些是【引擎按 registry 物化出来的冗余副本】，
 * 还是【该字段的实例级约束、可覆盖 registry】？
 * 前者意味着 doc 里的 min/max 由引擎重写、永远等于 registry；
 * 后者意味着面板与 AI 可以逐字段收窄范围。两种都自洽，但不能同时成立。
 *
 * 目前的类型同时容得下两种读法，等你定了再收紧（或干脆删掉这些内联字段）。
 */
export interface DocField<T> {
  readonly v: T;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly enum?: readonly string[];
}

/** 文档里一个字段要么是裸值，要么是带约束的包装。 */
export type DocValue<T> = T | DocField<T>;
