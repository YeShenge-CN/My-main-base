/**
 * 命令里的 id 与符号引用。
 *
 * 两套 id：
 *   ResolvedId  文档里真实存在的 id，如 'plot#7'、'eff#3'
 *   LocalId     批次内的符号 id，形如 '$c1'，只在一次 apply_commands 内有效
 *
 * ★ 规范 §7.5：符号 id 的解析【必须发生在 simulate 阶段】，不能在提交阶段补。
 *   理由：如果把解析留到提交阶段，"这条命令到底会改哪个对象"在预检时就是未知的，
 *   于是依赖推导、锁命中判定、precondition 推导会全部建立在猜测之上 ——
 *   而这三件事正是整个信任边界（不变量 4）的全部内容。
 *
 * 为什么不给 LocalId / ResolvedId 上类型品牌（branded type）：
 *   命令在线上就是普通 JSON，模型发过来的就是字符串，品牌位在序列化边界上必然丢失。
 *   与其造一个"编译期看起来安全、运行时其实没有"的假象，不如把校验放在
 *   simulate 阶段统一做（解析不到 → errored(unknown_local_id)）。
 */
export type LocalId = string;
export type ResolvedId = string;
/** 可以指向任何实体的引用。是本地符号还是已解析 id，靠 '$' 前缀在运行时区分。 */
export type IdRef = string;

export const LOCAL_ID_PREFIX = '$';

export function isLocalId(ref: string): boolean {
  return ref.startsWith(LOCAL_ID_PREFIX);
}

/**
 * 可编辑字段的取值。
 *
 * null 与 undefined 一律表示"这一项不改"。对应 strict JSON Schema 里的写法：
 * 字段仍然在 required 里，类型写成 anyOf:[T, {type:"null"}]，模型传 null 表示不改。
 * 所以命令里【没有】"把某字段设成 null"这种语义 —— 想表达空值要用具体的领域命令。
 */
export type Editable<T> = T | null | undefined;

/** 所有命令共有的信封字段。 */
export interface CommandEnvelope {
  /**
   * 该命令在批次中的下标。单条 execute 时为 0。
   * strict schema 要求所有属性都进 required，所以模型必须写；
   * 引擎会校验它与数组下标一致，不一致直接 errored。
   */
  readonly index?: number;
  /** 模型自己写的一句"我为什么改这个"，进 Operation Journal（规范 §12）。 */
  readonly intent?: string;
  /**
   * 显式追加的依赖（命令下标）。
   * 引擎【总是】自动推导依赖；这里只能追加，不能用来取消推导出来的依赖。
   */
  readonly dependsOn?: readonly number[];
}
