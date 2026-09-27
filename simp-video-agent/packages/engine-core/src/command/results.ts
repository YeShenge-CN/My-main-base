/**
 * 命令执行的四态结果与批量事务的回执（规范 §7）。
 *
 * 四态：ok / proposals / blocked / errored。
 * 关键语义：
 *   - ok       已提交，文档版本前进
 *   - proposals 因为命中锁而【没有】提交，等待审批
 *   - blocked  因为上游是 proposal 或 error 而没被执行（传递闭包，规范 §7.3）
 *   - errored  引擎判定这条命令不合法（不是模型说合法就合法）
 */
import type { Command } from './commands';
import type { Proposal } from './proposal';

/** 校验分组（规范 §6）。 */
export type ValidatorGroup = 'environment' | 'semantic' | 'motion' | 'layout' | 'export';

/** 批量事务超过这个条数就提示模型切分（规范 §7.6）。 */
export const MAX_BATCH_SIZE = 15;

export type CommandErrorCode =
  | 'schema_invalid'
  | 'index_mismatch'
  | 'unknown_target'
  | 'unknown_local_id'
  | 'duplicate_local_id'
  | 'local_id_reused'
  | 'expression_compile_failed'
  | 'type_mismatch'
  | 'out_of_range'
  | 'field_not_in_shape'
  | 'invalid_motion_node'
  | 'unsupported_shape'
  | 'unsupported_op'
  | 'invalid_argument'
  /**
   * 改动会越过【镜头边界】。
   *
   * 与 invalid_argument 分开，是因为模型的修复动作完全不同：
   * invalid_argument 是"参数写错了，改格式"，而这个是"delta 太大，
   * 改小到不超过本镜结束时刻"。都归到 invalid_argument 会让模型反复重写参数形状。
   */
  | 'scene_bounds_exceeded'
  | 'batch_too_large';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
  /** 出错的字段路径（如果定位得到）。 */
  readonly path?: string;
}

/** 已提交。 */
export interface OkOutcome {
  readonly kind: 'ok';
  readonly index: number;
  /** create_* / add_effect 才有：分配给它的真实 id。 */
  readonly assignedId?: string;
  readonly affectedPaths: readonly string[];
  readonly versionBefore: number;
  readonly versionAfter: number;
  /** Operation Journal 里的操作 id（P5）。 */
  readonly operationId: string;
}

/** 命中锁，转成待批准提案，文档未改动。 */
export interface ProposalOutcome {
  readonly kind: 'proposal';
  readonly index: number;
  readonly proposal: Proposal;
}

export type BlockedReason =
  /** 上游命令产生了待批准提案 */
  | 'proposal_pending'
  /** 上游命令报错 */
  | 'error_upstream'
  /** 目标被 hard 锁挡住，且这是自动执行路径 */
  | 'lock_conflict'
  /** atomic:true 且批次内出现失败，整批回滚 */
  | 'atomic_abort';

export interface BlockedOutcome {
  readonly kind: 'blocked';
  /** 导致它被 blocked 的那条命令的下标（精确到产生者，不是前一条）。 */
  readonly blockedBy: number;
  readonly reason: BlockedReason;
  readonly index: number;
  readonly detail?: string;
}

export interface ErroredOutcome {
  readonly kind: 'errored';
  readonly index: number;
  readonly error: CommandError;
}

export type CommandOutcome = OkOutcome | ProposalOutcome | BlockedOutcome | ErroredOutcome;

/** 引擎自动修的东西必须留痕（规范 §9：只有 fixClass==='auto' 才允许走这条路）。 */
export interface AutofixRecord {
  readonly path: string;
  readonly code: string;
  readonly from: unknown;
  readonly to: unknown;
  /** 触发它的命令下标。 */
  readonly index?: number;
}

export interface IssueCounts {
  readonly total: number;
  readonly byGroup: Readonly<Partial<Record<ValidatorGroup, number>>>;
}

/** 图像预算剩余量（规范 §10 的 L2 累计层）。 */
export interface BudgetState {
  readonly imagesUsed: number;
  readonly imagesLeft: number;
  readonly renderCallsLeft: number;
}

export interface ApplyCommandsRequest {
  /** 乐观并发控制：批次基于哪个文档版本。 */
  readonly baseVersion: number;
  /** true 则全或无；默认 false（失败部分不回滚）。 */
  readonly atomic?: boolean;
  /** 允许引擎自动修的分组。绝不包含 fixClass 为 agent/human 的问题。 */
  readonly autoFix?: readonly ValidatorGroup[];
  readonly commands: readonly Command[];
}

/** 回执里的非错误提示，例如"批次太大，请切分"。 */
export interface Notice {
  readonly code: string;
  readonly message: string;
}

export interface ApplyCommandsResponse {
  /** 提交后的文档版本。什么都没提交时等于 baseVersion。 */
  readonly version: number;
  readonly ok: readonly OkOutcome[];
  readonly proposals: readonly ProposalOutcome[];
  readonly blocked: readonly BlockedOutcome[];
  readonly errored: readonly ErroredOutcome[];
  readonly autofixed: readonly AutofixRecord[];
  /** 被改动的路径（去重、排序）。 */
  readonly changed: readonly string[];
  readonly issues: IssueCounts;
  readonly budget: BudgetState;
  /** 只有需要提示时才出现。 */
  readonly notices?: readonly Notice[];
}
