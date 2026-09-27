/**
 * 多镜头串行运行器（P12 的最后一块）。
 *
 * ★★ 规范 §13 把 P13（多 Agent）放在最后，并要求"仅在压力测试证明必要时"才做。
 *    压力测试的结论是**能力够用**（三臂 20/20），所以这一版刻意做得【小】：
 *    它不是一个 Agent 编排框架，而是"按 sceneOrder 逐镜跑同一个单镜头循环"。
 *
 * ── 三件它必须做对的事 ────────────────────────────────────────
 *
 * 1. **串行，不并发。** 规范 §14 明确"不做并发多 Agent 写同一文档"。
 *    逐镜跑还有一个好处：后一镜的 Agent 看到的是前一镜已经改完的文档，
 *    于是"接着上一镜的视觉语言"这类连贯性不需要额外机制。
 *
 * 2. **每镜一个身份（scope）。** 场景 Agent 的新建对象默认落在本镜
 *    （引擎按 `owner.sceneId: null` → 当前 scope 推导），它改不了别人的镜，
 *    `retime` 越界会被引擎拦下来。身份由编排层给，不由模型声明。
 *
 * 3. **每镜一个预算账本 + 每镜一个 turnId。**
 *    L2 层（每镜 imageCount ≤ 6、renderCallCount ≤ 3）本来就按 sceneId 记账 ——
 *    共用一个账本会让第二镜一开始就"没额度了"。
 *    而 turnId 决定 compound 粒度："撤销这一轮"必须是【一镜】，
 *    否则用户点一下会把整片撤掉。
 *
 * ── 它刻意不做的事 ───────────────────────────────────────────
 *   - 不并发、不排队、不重试（与 run.ts 同一口径）
 *   - 不替模型决定分镜（任务从哪来是调用方的事，见 sceneTasks）
 *   - 不做镜头间的"风格统一"（那是提示词与任务的职责）
 */
import {
  createJournal,
  evaluate,
  sceneEnd,
  sceneOrder,
  summarizeIssues,
  unwrapField,
  validate,
  type Journal,
  type SceneDoc,
  type ValidatorGroup,
} from '@sva/engine-core';
import { addUsage, emptyUsage, type TokenUsage } from './deepseek';
import { critiqueFrame } from './critique';
import { BudgetTracker, type BudgetLimits } from './budget';
import { runShot, sceneScopedTask, type RunResult, type ToolEvent } from './runtime';
import type { ToolContext } from './tools';
import type { ShotRenderer } from './run';

/** 一镜的任务。 */
export interface ShotTask {
  readonly sceneId: string;
  /** 这一镜要做什么。省略时用调用方的 fallback（同一个任务跑每一镜）。 */
  readonly task?: string;
}

/**
 * 前面几镜最多带几条交接摘要。
 *
 * ★ 上限刻意小：它是【风格一致性】的锚，不是完整历史。带太多反而会让这一镜的
 *   Agent 去改前面镜头的东西（而它改不了，只会浪费轮数）。
 */
export const HANDOFF_MAX_ENTRIES = 4;

/**
 * 一镜跑完之后留给【下一镜】的交接摘要。
 *
 * ★★ 为什么需要它：在此之前每镜的 Agent **完全没有历史**（§0.28 三 ⑤）——
 *   它只能从文档本身反推前面的视觉语言，于是每镜各自发挥，风格一致无从谈起。
 *   用户对这一条的拍板是「要，带上前面各镜的一段紧凑摘要」。
 *
 * ★ 为什么事实部分【从文档里推导】而不是让模型自己写：模型写的交接摘要会漂
 *   （它描述的是自己想做而不是做了什么），而这里的数字是文档的真值。
 *   两者都要：先给事实，再附上它自己的结论（截断）。
 *
 * ★ 纯函数：给一份文档 + 一个镜头 id，输出一行 —— 因此能被毫秒级断言。
 */
export function handoffSummary(doc: SceneDoc, sceneId: string, run: RunResult): string {
  const owned = Object.keys(doc.objects).filter((id) => {
    const o = doc.objects[id];
    return o !== undefined && o.owner.kind === 'scene' && o.owner.sceneId === sceneId;
  });
  const parts: string[] = [];
  const listed = owned.slice(0, 8).map((id) => id + '（' + (doc.objects[id]?.shape ?? '?') + '）');
  parts.push(
    '这一镜有 ' + owned.length + ' 个对象' +
      (owned.length > listed.length ? '（只列前 ' + listed.length + ' 个）' : '') +
      '：' + (listed.length === 0 ? '（无）' : listed.join('、')),
  );

  const colors = new Set<string>();
  const sizes = new Set<number>();
  for (const id of owned) {
    const o = doc.objects[id];
    if (o === undefined) continue;
    for (const key of ['stroke', 'fill']) {
      const v = unwrapField(o.style[key]);
      if (typeof v === 'string' && v.startsWith('#')) colors.add(v);
    }
    const size = Number(unwrapField(o.style['size']));
    if (Number.isFinite(size) && size > 0) sizes.add(size);
  }
  // ★ 颜色与字号是「视觉语言」里最容易被下一镜沿用、也最容易被忘掉的两样
  if (colors.size > 0) parts.push('用到的主色 ' + [...colors].slice(0, 3).join('、'));
  if (sizes.size > 0) parts.push('字号 ' + [...sizes].sort((a, b) => a - b).join('/') + 'px');

  const said = run.finalMessage.trim();
  if (said !== '') parts.push('它自己的结论：' + said.slice(0, 160));
  return parts.join('；');
}

export interface RunMultiShotOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** 起始文档。必须已经有镜头表 —— 没有镜头表时它退化成「跑一次全片」。传了 `journal` 时应当是那份 Journal 的当前文档。 */
  readonly doc: SceneDoc;
  readonly render: ShotRenderer;
  /**
   * 复用调用方的 Journal（省略 = 自己建一个）。
   *
   * ★ 「整片」流程要用它：清空 + 建分镜那一步也是这个文档上的写入，
   *   如果这里另建一个 Journal，那一批操作就落在另一条历史里 ——
   *   面板拿到的 entries 会缺一段，版本号与快照也对不上。
   */
   readonly journal?: Journal;
  /** 逐镜任务。省略 = 每一镜都用 `fallbackTask`。 */
  readonly tasks?: readonly ShotTask[];
  /** 没有逐镜任务时用它。 */
  readonly fallbackTask?: string;
  readonly maxTurns?: number;
  readonly limits?: BudgetLimits;
  /** 接口地址覆盖（作业 3）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
  readonly approvalPolicy?: ToolContext['approvalPolicy'];
  readonly policy?: ToolContext['policy'];
  readonly now?: () => number;
  /** 每镜开始前回调（CLI 打日志用）。 */
  readonly onShotStart?: (info: { readonly sceneId: string; readonly index: number; readonly total: number; readonly task: string }) => void;
  /**
   * 是否把前面几镜的交接摘要带给下一镜（默认【开】，见 handoffSummary）。
   *
   * ★ 开着它每镜多花几百 token，换的是「跨镜风格一致」这件事有据可依。
   *   关掉只该用于对比实验。
   */
  readonly carryHandoff?: boolean;
  readonly onTool?: (event: ToolEvent, sceneId: string) => void;
  readonly onTurn?: (turn: number, sceneId: string) => void;
}

export interface ShotOutcome {
  readonly sceneId: string;
  readonly task: string;
  readonly run: RunResult;
  /** 这一镜新增/修改的操作数（actor === 'agent'）。 */
  readonly agentOperations: number;
  /** 这一镜自己的问题数（结束时）。 */
  readonly issueCount: number;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** 这一镜提交过的操作 id —— 面板/CLI 用它做"只撤这一镜"。 */
  readonly operationIds: readonly string[];
}

export interface RunMultiShotResult {
  readonly doc: SceneDoc;
  /** 整个多镜头运行共用一个 Journal（文档只有一条写路径）。 */
  readonly journal: Journal;
  readonly shots: readonly ShotOutcome[];
  readonly fromVersion: number;
  readonly toVersion: number;
  /** 全部镜头的问题清单（结束时）与分组计数。 */
  readonly issues: ReturnType<typeof validate>;
  readonly issueCounts: ReturnType<typeof summarizeIssues>;
  /** 总 token（各镜相加，含输入/输出/缓存/思考/图片的拆账）。 */
  readonly usage: TokenUsage;
}

/**
 * 逐镜任务：`tasks` 里给了就用，没给就用 fallback。
 *
 * ★ 单独抽出来是为了让调用方能只写"每一镜都做这件事"，
 *   不必先把镜头表读一遍再拼一个数组。
 */
export function resolveShotTasks(
  doc: SceneDoc,
  tasks: readonly ShotTask[] | undefined,
  fallbackTask: string | undefined,
): readonly { readonly sceneId: string; readonly start: number; readonly end: number; readonly task: string }[] {
  const byId = new Map((tasks ?? []).map((t) => [t.sceneId, t.task]));
  const out: { sceneId: string; start: number; end: number; task: string }[] = [];
  for (const scene of sceneOrder(doc)) {
    const task = byId.get(scene.id) ?? fallbackTask;
    if (task === undefined) continue;
    out.push({ sceneId: scene.id, start: scene.bornAt, end: sceneEnd(doc, scene.id), task });
  }
  return out;
}

export async function runMultiShot(opts: RunMultiShotOptions): Promise<RunMultiShotResult> {
  let clock = opts.now?.() ?? Date.now();
  const now = opts.now ?? ((): number => clock++);
  const journal = opts.journal ?? createJournal(opts.doc, { now });
  const fromVersion = journal.currentVersion();

  const planned = resolveShotTasks(opts.doc, opts.tasks, opts.fallbackTask);
  const shots: ShotOutcome[] = [];
  /** 前面各镜的交接摘要（只保留最近 HANDOFF_MAX_ENTRIES 条）。 */
  const handoffs: string[] = [];
  let usage = emptyUsage();
  /** 当前这一镜的评审用量（每镜开始时清零，见下面的 addUsage）。 */
  let critiqueUsage: TokenUsage = emptyUsage();

  /**
   * ★ 没有镜头表时退化成"跑一次全片"。
   *   这不是特例代码，而是空表 = 单镜头旧行为这一口径的必然结果：
   *   那时没有身份可给，导演视角就是唯一合理的视角。
   */
  if (planned.length === 0) {
    const task = opts.fallbackTask ?? '';
    const result = await runOneAsDirector(opts, journal, task, now);
    shots.push(result.outcome);
    usage = addUsage(usage, result.run.usage);
  } else {
    for (let i = 0; i < planned.length; i++) {
      const shot = planned[i];
      if (shot === undefined) continue;
      const sceneId = shot.sceneId;
      opts.onShotStart?.({ sceneId, index: i + 1, total: planned.length, task: shot.task });

      const budget = new BudgetTracker(sceneId, opts.limits);
      const turnId = turnIdForScene(sceneId);
      const ctx: ToolContext = {
        doc: () => journal.currentDoc(),
        journal,
        budget,
        baseVersion: () => journal.currentVersion(),
        turnId,
        // ★ 身份：这一镜。引擎据此把 owner.sceneId: null 落成本镜。
        scope: { kind: 'scene', sceneId, start: shot.start, end: shot.end },
        render: (d, ts) => opts.render(d, ts),
        // ★ 每镜都能请独立评审看一眼自己这一帧（用量并进本镜的总账）
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

      const before = journal.currentVersion();
      const run = await runShot({
        apiKey: opts.apiKey,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
        // ★ 把"你在哪一镜"写进任务文本：模型看不到 scope，但它必须知道边界
        task: sceneScopedTask(shot.task, sceneId, shot.start, shot.end),
        ctx,
        turnId,
        ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
        ...(opts.onTool === undefined ? {} : { onTool: (e) => opts.onTool?.(e, sceneId) }),
        ...(opts.onTurn === undefined ? {} : { onTurn: (t) => opts.onTurn?.(t, sceneId) }),
        // ★ 跨镜交接：带上前几镜【从文档里推导出来的】事实（不是让模型自己回忆）
        ...(handoffs.length === 0 || opts.carryHandoff === false
          ? {}
          : { history: handoffs.slice(-HANDOFF_MAX_ENTRIES), historyLabel: '前面几镜的交接摘要（背景，用于保持风格一致）' }),
      });
      // ★ 评审的用量也要进本镜的总账（critiqueUsage 是这一镜自己的）
      usage = addUsage(usage, addUsage(run.usage, critiqueUsage));
      critiqueUsage = emptyUsage();
      // 给【下一镜】留一段交接摘要：事实来自文档，结论来自它自己（见 handoffSummary）
      handoffs.push(
        '第 ' + (i + 1) + ' 镜 ' + sceneId + '（' + shot.task.slice(0, 60) + '）：' +
          handoffSummary(journal.currentDoc(), sceneId, run),
      );

      const opIds = journal
        .operations()
        .filter((o) => o.resultVersion > before && o.actor === 'agent')
        .map((o) => o.opId);
      shots.push({
        sceneId,
        task: shot.task,
        run,
        agentOperations: opIds.length,
        issueCount: validate(journal.currentDoc()).length,
        fromVersion: before,
        toVersion: journal.currentVersion(),
        operationIds: opIds,
      });
    }
  }

  const doc = journal.currentDoc();
  const issues = validate(doc);
  return {
    doc,
    journal,
    shots,
    fromVersion,
    toVersion: journal.currentVersion(),
    issues,
    issueCounts: summarizeIssues(issues),
    usage,
  };
}

/** 没有镜头表时的退化路径：以导演身份跑一次。 */
async function runOneAsDirector(
  opts: RunMultiShotOptions,
  journal: Journal,
  task: string,
  now: () => number,
): Promise<{ outcome: ShotOutcome; run: RunResult }> {
  const budget = new BudgetTracker('director', opts.limits);
  const ctx: ToolContext = {
    doc: () => journal.currentDoc(),
    journal,
    budget,
    baseVersion: () => journal.currentVersion(),
    turnId: 'director',
    render: (d, ts) => opts.render(d, ts),
    now,
    ...(opts.approvalPolicy === undefined ? {} : { approvalPolicy: opts.approvalPolicy }),
    ...(opts.policy === undefined ? {} : { policy: opts.policy }),
  };
  const before = journal.currentVersion();
  const run = await runShot({
    apiKey: opts.apiKey,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    task,
    ctx,
    ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
  });
  const opIds = journal
    .operations()
    .filter((o) => o.resultVersion > before && o.actor === 'agent')
    .map((o) => o.opId);
  return {
    run,
    outcome: {
      sceneId: '(全片)',
      task,
      run,
      agentOperations: opIds.length,
      issueCount: validate(journal.currentDoc()).length,
      fromVersion: before,
      toVersion: journal.currentVersion(),
      operationIds: opIds,
    },
  };
}

/** 这一镜的 turnId（写进 compound，决定"撤销这一镜"的粒度）。 */
export function turnIdForScene(sceneId: string): string {
  return 'shot:' + sceneId;
}

/**
 * 这一镜对应的 compound id —— 供宿主做"只撤这一镜"。
 *
 * ★ 格式必须与 journal 的默认约定一致：`'c:' + actor + ':' + turnId`
 *   （见 journal/store.ts 的 append）。这里刻意【不】让调用方自己拼：
 *   拼错了不会报错，只会让"撤销这一镜"找不到 compound —— 静默失效。
 *   journal 那边有对应的断言（revertCompound 找不到就报 compound_not_found）。
 */
export function compoundIdForScene(sceneId: string): string {
  return 'c:agent:' + turnIdForScene(sceneId);
}

/**
 * 每镜的关键帧时间 —— 给"每镜渲染一张复查图"用。
 *
 * ★ 取镜头中点而不是起点：起点常常是淡入的透明帧（t=0 往往什么都没有），
 *   拿它复查等于看一张黑图。这是实测踩过的（CLI 的 --all-scenes 第一版就是这么坑的）。
 */
export function shotProbeTime(doc: SceneDoc, sceneId: string): number {
  const scene = sceneOrder(doc).find((s) => s.id === sceneId);
  if (scene === undefined) return 0;
  const end = sceneEnd(doc, sceneId);
  return Math.min(end, scene.bornAt + (end - scene.bornAt) / 2);
}

/** 一镜的可见对象数（诊断用：某镜什么都没画出来时会露馅）。 */
export function visibleItemCount(doc: SceneDoc, sceneId: string): number {
  const t = shotProbeTime(doc, sceneId);
  const state = evaluate(doc, t);
  const ownerScene = (id: string): string | undefined => {
    const o = doc.objects[id];
    return o !== undefined && o.owner.kind === 'scene' ? o.owner.sceneId : undefined;
  };
  return state.items.filter((it) => {
    const owner = ownerScene(it.id);
    return owner === undefined || owner === sceneId;
  }).length;
}

export type { ValidatorGroup };
