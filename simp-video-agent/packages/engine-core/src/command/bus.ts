/**
 * CommandBus —— 唯一的写入路径（不变量 2、3）。
 *
 * 人和 AI 走同一条路：面板拖滑块产生的是一条 set_style 命令，
 * AI 调工具产生的也是一条 set_style 命令，两者在数据结构上完全不可区分
 * （只差 actor 和 intent 这两个标记）。由此 undo/redo、操作日志、
 * 锁定判定、precondition 失效判定都只需要实现一遍。
 *
 * 这里只定义接口。实现（P4 的下一步）不在这份文件里。
 */
import type { SceneDoc } from '../doc/types';
import type { Command, CommandEffects, CreatedId } from './commands';
import type { DocDiff, DiffEntry } from '../projection/diff';
import type {
  ApplyCommandsRequest,
  ApplyCommandsResponse,
  BudgetState,
  CommandOutcome,
  ProposalOutcome,
} from './results';
import type { Proposal, ProposalDecision } from './proposal';

/**
 * 预检产物。
 *
 * ★ 必须廉价（用户 P4 清单第 4 条）：candidate 是【不可变文档 + 结构共享】，
 *   未改动的子树与输入共享同一份内存，绝不对整份 doc 做 structuredClone。
 *   因此 Simulation 拿到的 candidate 与 doc 在未改动部分是指针相等的，
 *   这一点有断言守着。
 */
export interface Simulation {
  /** 每条命令的预检分类（此时还没有提交任何东西）。 */
  readonly outcomes: readonly CommandOutcome[];
  /** 预检后的候选文档。未改动的子树与输入共享。 */
  readonly candidate: SceneDoc;
  /** candidate 相对原文档的差异。 */
  readonly diff: DocDiff;
  /** 符号 id 解析表：'$c1' → 'plot#7'。★ 解析发生在这一步，不留到提交阶段。 */
  readonly resolvedIds: readonly CreatedId[];
  /** 每条命令的读写集，是 precondition 与依赖推导的唯一输入。 */
  readonly effects: readonly CommandEffects[];
  /** 预检阶段发现的问题（不阻断，只回报）。 */
  readonly entries: readonly DiffEntry[];
}

/**
 * 宿主必须注入的依赖。
 *
 * engine-core 禁止读时钟、读随机数（不变量 1），所以时间与 id 分配
 * 一律由外部注入。id 分配器必须【由文档现状推出】（如取当前最大序号 + 1），
 * 不允许随机 —— 否则同一个 doc + 同一批命令会产出不同结果。
 */
export interface CommandBusDeps {
  /** 墙上时钟毫秒。只用于 Proposal.at / LockEntry.at 这类展示字段。 */
  readonly now: () => number;
  /** 下一批图像预算剩余量（规范 §10）。 */
  readonly budget: () => BudgetState;
}

export interface CommandBus {
  /** 当前文档的只读视图。 */
  currentDoc(): SceneDoc;
  /** 当前文档版本（单调递增整数，禁用 hash 与时间戳）。 */
  currentVersion(): number;

  /**
   * 尝试直接提交一条命令。
   *
   * 与 propose 的区别：
   *   execute  命中 hard 锁时【自动降级】为提案（不写文档），
   *            命中 soft 锁时直接改，但回执里说明"覆盖了动画"。
   *   propose  只产出提案，绝不动文档。用于 AI 主动申请，或 UI 预览改动。
   */
  execute(cmd: Command): CommandOutcome;

  /** 只产出提案，不写文档。 */
  propose(cmd: Command): ProposalOutcome;

  /** 批量事务：四态返回（规范 §7）。 */
  applyBatch(req: ApplyCommandsRequest): ApplyCommandsResponse;

  /** 在文档副本上顺序执行，得到 diff、符号 id 解析表与依赖推导结果。 */
  simulate(commands: readonly Command[]): Simulation;

  /** 审批一个待批准提案，返回三分支判定（规范 §8）。 */
  approveProposal(proposalId: string): ProposalDecision;

  /** 当前待批准的提案。 */
  pendingProposals(): readonly Proposal[];
}
