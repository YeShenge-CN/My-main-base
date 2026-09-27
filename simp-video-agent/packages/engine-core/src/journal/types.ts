/**
 * Operation Journal（规范 §12）。
 *
 * 三条性质：
 *   1. append-only，不可编辑历史。"改历史"是【追加补偿操作】。
 *   2. 记录的是【操作】，不是"文档变成了什么样"。因此它天然能回答
 *      "AI 刚刚做了什么"，而不只是"现在是什么"。
 *   3. CompoundOperation 是"一次工作单元"。撤销 AI 上一轮 = revert 一个 compound。
 *
 * ⚠️ 对规范 §12 的一处扩展：Operation 增加了 patches。
 *   规范给的字段里没有 before/after 值，而 revert 必须知道"改之前是什么"。
 *   不记 patches 的话，每次 revert 都得从头 replay 整条日志才能推出逆操作。
 *   记下来的额外好处：precondition 推导、get_operations_affecting、
 *   面板展示三处用的是同一份数据。
 */
import type { SceneDoc } from '../doc/types';
import type { Command } from '../command/commands';
import type { OperationPatch } from '../command/apply';

export type Actor = 'user' | 'agent' | 'engine-autofix';

export interface Operation {
  readonly opId: string;
  readonly compoundId: string;
  readonly actor: Actor;
  readonly command: Command;
  readonly baseVersion: number;
  readonly resultVersion: number;
  readonly affectedPaths: readonly string[];
  /** 墙上时钟毫秒。engine-core 禁止读时钟（不变量 1），所以由宿主注入。 */
  readonly at: number;
  /** Agent Runtime 提供。同一 turnId 内同 actor 的操作归入同一个 compound。 */
  readonly turnId?: string;
  /** 模型自己写的一句"我为什么改这个"。 */
  readonly intent?: string;
  /** 引擎推导的 before/after（§12 之外的扩展，见文件头说明）。 */
  readonly patches: readonly OperationPatch[];
  /** 该操作分配出的新 id（create_* / add_effect）。 */
  readonly assignedId?: string;
}

export interface CompoundOperation {
  readonly compoundId: string;
  readonly actor: Actor;
  readonly turnId?: string;
  /** 按发生顺序。 */
  readonly opIds: readonly string[];
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly summary: string;
  /** 由 Agent Runtime 在 turn 结束时置位（规范 §12）。未置位的不允许 revert。 */
  readonly settled: boolean;
  /** 若这个 compound 是某次 revert 产生的补偿操作，这里是被撤的 compoundId。 */
  readonly revertOf?: string;
}

/** get_journal 的查询条件。from/to 是【文档版本】，闭区间。 */
export interface JournalQuery {
  readonly from?: number;
  readonly to?: number;
  readonly actor?: Actor;
  readonly compoundId?: string;
}

export type SkipReason =
  | 'precondition_failed'
  | 'not_invertible'
  | 'nothing_to_undo'
  | 'target_missing';

/** 逐条说明"哪一条没撤掉、为什么"。与 P4 的 stale 回执同构。 */
export interface SkippedRevert {
  readonly opId: string;
  readonly path: string;
  readonly reason: SkipReason;
  readonly expected: unknown;
  readonly actual: unknown;
}

export type RevertRejection = 'compound_not_found' | 'compound_not_settled' | 'already_reverted';

/**
 * 折叠记录：某条路径在本轮之后被【别的 actor】写过，
 * 因此补偿值不是"本轮改之前的值"，而是"把本轮摘掉之后重算出来的值"。
 *
 * 例：width 3 →(AI:5) →(用户:7) →(AI:9)。撤 AI 这一轮的正确结果不是 3 而是 7。
 * 面板需要把这件事显式说出来，否则用户会以为撤销"没生效"。
 */
export interface RevertFold {
  readonly path: string;
  /** 本轮改之前的值 */
  readonly originalBefore: unknown;
  /** 实际写回去的值（折叠了后来者的改动） */
  readonly appliedValue: unknown;
  /** 中间写过这条路径的、不属于本轮的操作用 id */
  readonly supersededBy: readonly string[];
}

export interface RevertResult {
  readonly kind: 'reverted' | 'rejected';
  readonly compoundId: string;
  readonly reason?: RevertRejection;
  /** 新追加的补偿操作（append-only：撤销是新增，不是删除）。 */
  readonly reverted: readonly Operation[];
  readonly skipped: readonly SkippedRevert[];
  /** 因为后来者改过同一路径而发生折叠的路径。 */
  readonly folded: readonly RevertFold[];
  readonly doc: SceneDoc;
  readonly version: number;
  readonly revertCompoundId?: string;
}

export interface ReplayResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly operations: readonly Operation[];
  /** 缺少起始快照时为 null —— 宁可说"重放不了"，也不给一份猜出来的文档。 */
  readonly doc: SceneDoc | null;
}

/** 追加一条操作。baseVersion / resultVersion 由日志自己推进。 */
export interface AppendInput {
  readonly actor: Actor;
  /**
   * 触发这条操作的命令。
   *
   * ★ 可选：**嵌入**别的进程产出的操作时没有命令。
   *   场景：Agent 跑在服务端，界面要把它的操作搬进本地 Journal 才能"撤销这一轮"。
   *   这时候操作本身（patches / affectedPaths / assignedId）是完整的，
   *   缺的只是那条原始命令 —— 而命令正是"重放会得到不同结果"的原因，所以缺了反而更诚实。
   *   这种情况必须提供 patches 与 nextDoc（见 appendEmbedded）。
   */
  readonly command?: Command;
  readonly patches: readonly OperationPatch[];
  readonly affectedPaths: readonly string[];
  readonly assignedId?: string;
  readonly intent?: string;
  /** Agent Runtime 的轮次 id。 */
  readonly turnId?: string;
  /** 用户侧的一次手势 key（pointerdown..pointerup），语义与 turnId 相同。 */
  readonly gestureId?: string;
  /** 引擎自动修时的说明。 */
  readonly summary?: string;
  /** 嵌入外部操作时，强制指定它属于哪个 compound（用于把一轮整体归组）。 */
  readonly compoundId?: string;
}

export interface JournalDeps {
  /** 墙上时钟毫秒。engine-core 禁止读时钟（不变量 1），所以必须注入。 */
  readonly now: () => number;
}
