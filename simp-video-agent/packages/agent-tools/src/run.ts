/**
 * 单镜头运行器（把一次 Agent 运行变成可调用、可复现的【库函数】）。
 *
 * ★ 为什么需要它：在此之前，"把 Agent 跑起来"这件事只存在于测试里 ——
 *   p6-acceptance.test.ts 与 stress.test.ts 各自把任务、夹具、判据、API key
 *   焊死在测试文件里。于是：
 *     - 想换个任务试一下，得改测试文件；
 *     - 想看它产出的画面，得在测试里临时加写文件；
 *     - 测试的通过/失败与"东西到底做出来没有"混在一起。
 *   这个模块把"跑一个镜头"从测试里提出来，测试与 CLI 都调它。
 *
 * 刻意【不做】的事（都是并发/多镜头的范畴，现在不碰）：
 *   - 不跑多个镜头，不做镜头间编排
 *   - 不并发、不排队、不重试
 *   - 不持有状态：输入文档 + 任务 → 输出文档 + 日志，一次调用一次结果
 */
import {
  createJournal,
  validate,
  summarizeIssues,
  type Actor,
  type Journal,
  type SceneDoc,
} from '@sva/engine-core';
import { addUsage, emptyUsage, type ReasoningEffort, type TokenUsage } from './deepseek';
import { critiqueFrame } from './critique';
import { BudgetTracker, type BudgetLimits } from './budget';
import { runShot, type RunResult, type ToolEvent, type ToolTrace } from './runtime';
import { dispatchTool, type ToolContext } from './tools';

/**
 * 渲染器由【宿主注入】，initiative 不 import @sva/engine-node。
 *
 * ★ 为什么：engine-node 的导出/截图路径里有 page.evaluate 回调，签名需要 DOM 类型；
 *   而 agent-tools 的 src 刻意只开 ES2022 + node（无 DOM）。
 *   从 src 里 import engine-node 会把 window/document 拖进类型检查，
 *   于是唯一的"修法"就变成了给 src 打开 DOM —— 那正好把"哪一层能碰 DOM"的
 *   边界抹掉。宿主（CLI / 面板 / 测试）本来就该决定用哪个渲染后端：
 *   命令行与测试用 @napi-rs/canvas，浏览器端用 canvas 元素。
 */
export type ShotRenderer = (
  doc: SceneDoc,
  timestamps: readonly number[],
) => readonly { readonly t: number; readonly pngBase64: string; readonly sha256: string }[];

export interface RunOneShotOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** 思考强度（见 runtime 的 RunOptions.reasoningEffort）。省略 = 不开思考。 */
  readonly reasoningEffort?: ReasoningEffort;
  readonly task: string;
  /** 起始文档。用 shot.ts 的 emptyShot() / shotWithPlot() / preset 生成。 */
  readonly doc: SceneDoc;
  /** 渲染器（必填）。engine-node 的 renderFrames 包一层即可，见 cli.ts。 */
  readonly render: ShotRenderer;
  /** 轮数上限，默认 runtime 的 DEFAULT_MAX_TURNS。 */
  readonly maxTurns?: number;
  /** 图像预算（默认 L1/L2 的标准额度）。 */
  readonly limits?: BudgetLimits;
  /** 逐工具回调：CLI 用它打日志，测试用它收集断言。 */
  readonly onTool?: (event: ToolEvent) => void;
  /** 每轮结束时回调。 */
  readonly onTurn?: (turn: number, trace: readonly ToolTrace[]) => void;
  /**
   * 审批策略。省略 = 没有人审批（命中硬锁的改动会停在提案上，文档不变）。
   *
   * ★ 默认"没人审批"是刻意的：一个不会自己批准自己的系统，
   *   跑起来才不会假装协作路径已经通了。要模拟用户批准请显式传。
   */
  readonly approvalPolicy?: ToolContext['approvalPolicy'];
  readonly policy?: ToolContext['policy'];
  readonly now?: () => number;
  /** 上一轮背景（见 runtime 的 RunOptions.history）。 */
  readonly history?: readonly string[];
  /** 接口地址覆盖（作业 3）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
}

export interface RunOneShotResult {
  /** 运行结束时的文档（包含 Agent 的全部写入）。 */
  readonly doc: SceneDoc;
  readonly journal: Journal;
  readonly run: RunResult;
  /** 结束时的问题清单与分组计数。 */
  readonly issues: ReturnType<typeof validate>;
  readonly issueCounts: ReturnType<typeof summarizeIssues>;
  /** 文档版本从多少走到多少。 */
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Agent 成功提交的操作数（不含审批补偿）。 */
  readonly agentOperations: number;
}

export async function runOneShot(opts: RunOneShotOptions): Promise<RunOneShotResult> {
  let clock = opts.now?.() ?? Date.now();
  const now = opts.now ?? ((): number => clock++);
  const journal = createJournal(opts.doc, { now });
  const budget = new BudgetTracker('shot-1', opts.limits);
  const fromVersion = journal.currentVersion();

  /**
   * ★ 评审的用量单独累计，最后并进这一轮的 usage。
   *
   *   不并的话，界面上那句"输入 N / 输出 M"就少了一次真实调用 ——
   *   而作业 3 的全部意义就是让这笔账看得见。
   */
  let critiqueUsage: TokenUsage = emptyUsage();

  const ctx: ToolContext = {
    doc: () => journal.currentDoc(),
    journal,
    budget,
    baseVersion: () => journal.currentVersion(),
    turnId: 'shot-1',
    render: (doc, ts) => opts.render(doc, ts),
    // ★ 独立评审：换一条系统提示、换一个身份、只看这一帧（见 critique.ts）
    critique: async (req) => {
      const result = await critiqueFrame({
        apiKey: opts.apiKey,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
        pngBase64: req.pngBase64,
        ...(req.intent === undefined ? {} : { intent: req.intent }),
        ...(req.checklist === undefined ? {} : { checklist: req.checklist }),
      });
      critiqueUsage = addUsage(critiqueUsage, result.usage);
      return result;
    },
    now,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.approvalPolicy === undefined ? {} : { approvalPolicy: opts.approvalPolicy }),
    ...(opts.policy === undefined ? {} : { policy: opts.policy }),
  };

  const run = await runShot({
    apiKey: opts.apiKey,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    task: opts.task,
    ctx,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
    ...(opts.onTool === undefined ? {} : { onTool: opts.onTool }),
    ...(opts.onTurn === undefined ? {} : { onTurn: opts.onTurn }),
    ...(opts.history === undefined ? {} : { history: opts.history }),
  });

  const doc = journal.currentDoc();
  const issues = validate(doc);
  const actor: Actor = 'agent';
  return {
    doc,
    journal,
    // ★ 把评审那几次调用的用量并进本轮的总账（见上面 critique 的注释）
    run: { ...run, usage: addUsage(run.usage, critiqueUsage) },
    issues,
    issueCounts: summarizeIssues(issues),
    fromVersion,
    toVersion: journal.currentVersion(),
    agentOperations: journal.operations().filter((o) => o.actor === actor).length,
  };
}

/** 让调用方不必自己 import dispatchTool —— 单条工具的执行（调试/测试用）。 */
export { dispatchTool };
