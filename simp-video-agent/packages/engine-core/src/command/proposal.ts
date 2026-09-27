/**
 * Proposal 与 precondition（规范 §8）。
 *
 * 核心思想：AI 的改动不是"要么成功要么失败"，而是三态——
 * 直接生效 / 转成待批准提案 / 因为前提已变而作废。
 * 而"前提"不是模型声明的，是引擎在 simulate 阶段自动推导出来的：
 *
 *     preconditions = writeSet ∪ (readSet ∩ 同一 object 子树)
 *
 * 注意这里刻意【不用】全文档 readSet：否则用户在文档任何地方动一下，
 * 所有提案都会变成 stale，提案机制会退化成噪声。
 */
import type { Command } from './commands';
import type { LockClass } from '../doc/types';

export type PreconditionKind = 'value' | 'exists' | 'absent';

export interface Precondition {
  /** 点分路径（对象相对形式，如 'plot#7.style.width'）。 */
  readonly path: string;
  /** 提案生成时刻该路径的值（'value' 类）或存在性期望（'exists'/'absent' 类）。 */
  readonly expected: unknown;
  readonly kind: PreconditionKind;
}

export type PreconditionFailureReason = 'value_changed' | 'missing' | 'unexpected';

/** 逐条说明"哪个前提变了、从多少变成多少"—— 这是回执给模型的关键信息。 */
export interface PreconditionFailure {
  readonly path: string;
  readonly expected: unknown;
  /** 校验时刻的实际值。missing 时为 undefined。 */
  readonly actual: unknown;
  readonly reason: PreconditionFailureReason;
}

export type ProposalState = 'pending' | 'approved' | 'rejected' | 'stale' | 'superseded';

/**
 * 提案必须说清楚的四件事（P10 第 3 条）。
 * 前两项由引擎从 patches 推出来，后两项分别由引擎生成、由模型用 intent 提供。
 */
export interface ProposalReason {
  /** 当前值 */
  readonly currentValue: unknown;
  /** 目标值 */
  readonly targetValue: unknown;
  /** 画面变化 —— 一句话说明改完会看到什么不同 */
  readonly visualChange: string;
  /** 理由 —— 模型自己写的那句"为什么改这个" */
  readonly rationale: string;
}

export interface Proposal {
  readonly proposalId: string;
  /** 生成提案时的文档版本。审批时用它判断是否发生了 fast-forward。 */
  readonly baseVersion: number;
  /** 被改的目标路径，如 'plot#7.style.width'。 */
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly preconditions: readonly Precondition[];
  /** 面向人的一句说明（兼容保留）。 */
  readonly reason: string;
  /** 结构化的四项说明。面板的审批卡直接渲染它。 */
  readonly reasonDetail: ProposalReason;
  readonly state: ProposalState;
  readonly by: 'ai' | 'user';
  /**
   * 墙上时钟毫秒。engine-core 禁止读时间（不变量 1），
   * 所以这个值由宿主通过 CommandBusDeps.now 注入。
   */
  readonly at: number;
  /** 原始命令，批准时照着它执行。 */
  readonly command: Command;
  readonly affectedPaths: readonly string[];
}

/** 命中锁的记录。hard 必须走 request_patch，soft 可直接改但要提示会覆盖动画。 */
export interface LockConflict {
  readonly path: string;
  readonly lockClass: LockClass;
  readonly by: 'user' | 'ai';
  readonly at: number;
}

/**
 * 审批结果三分支（规范 §8）：
 *   approve       版本相同且所有 precondition 成立
 *   fast-forward  版本更大，但本提案要写的那条路径没被别人写过，且 precondition 成立
 *   stale         任一 precondition 不成立 —— 不执行，并把每一条的 expected/actual 回报给模型
 */
export type ProposalDecision =
  | { readonly kind: 'approve' }
  | { readonly kind: 'fast-forward'; readonly skippedPaths: readonly string[] }
  | { readonly kind: 'stale'; readonly failures: readonly PreconditionFailure[] };
