/**
 * 「整片」流程：一句话 → 导演分镜 → 逐镜跑 → 一份成片。
 *
 * ★★ 为什么要有它（实测数据，见 docs/progress.md §0.25）：
 *   面板的聊天窗口是【一轮做一件事】。用户说「生成一条关于 agent 的科普视频」，
 *   8 轮拉了 29.8 万输入 token、115 秒，最后还被轮数上限截断 ——
 *   因为整片的上下文（所有对象 + 所有历史）都挤在同一个 Agent 的窗口里。
 *   正确的形状是：导演拆镜 → 每镜一个场景 Agent（各自更小的上下文）→ 串行跑。
 *   `multi-shot.ts` 早就有串行跑那一半，缺的是「任务从哪来」。
 *
 * ── 与既有模块的分工 ──────────────────────────────────────────
 *   `film.ts`（这里）：导演规划 + 清空 + 建分镜 + 把两者接起来
 *   `multi-shot.ts`：逐镜串行（每镜一个身份 / 一个预算账本 / 一个 turnId）
 *   `runtime.ts`：单镜循环
 *
 * ★ 导演用一个【独立的小 schema】（`PLAN_TOOL`），不进主工具表 ——
 *   于是这个功能对普通聊天的固定开销是**零**（工具表还是 6099，提示词还是 2940）。
 *   这与 `render_formula`（几何由工具算）是同一套取舍：只在需要它的那条路上付出代价。
 */
import {
  applyCommands,
  createJournal,
  sceneOrder,
  validate,
  type Command,
  type Journal,
  type SceneDoc,
} from '@sva/engine-core';
import {
  addUsage,
  chatCompletions,
  emptyUsage,
  type ReasoningEffort,
  type TokenUsage,
  type ToolSchema,
} from './deepseek';
import { BudgetTracker, DEFAULT_LIMITS, type BudgetLimits } from './budget';
import { runMultiShot, type ShotOutcome } from './multi-shot';
import type { ShotRenderer } from './run';
import type { ToolContext } from './tools';

/**
 * 整片模式下【每一镜】的轮数上限。
 *
 * ★★ 第二十九轮按【用户拍板】从 6 抬到 16（聊天那一侧是 DEFAULT_MAX_TURNS = 30）。
 *   实测（§0.28 三 ②）：两次整片验收都是被这个数砍掉的 —— 一次整片只跑了 8 轮、
 *   一次每镜只剩 4 轮，两次都留下半成品。整片本来就更贵，但"跑不完"比"跑得贵"糟得多：
 *   跑不完的产物是【看起来完成了一半的片子】，用户还得自己判断哪里缺。
 */
export const DEFAULT_MAX_TURNS_PER_SHOT = 16;

/* ── 规划的形状 ───────────────────────────────────────────────── */

export interface PlannedShot {
  /** 镜头名（进时间轴，2~12 字最好看）。 */
  readonly name: string;
  /** 这一镜多少秒。 */
  readonly seconds: number;
  /** 这一镜要做什么（会成为那个场景 Agent 的任务）。 */
  readonly task: string;
}

export interface FilmPlan {
  readonly title: string;
  readonly shots: readonly PlannedShot[];
}

/** 一镜最短 1.5 秒（再短看不清），最长 20 秒（再长这一个 Agent 也画不完）。 */
export const MIN_SHOT_SECONDS = 1.5;
export const MAX_SHOT_SECONDS = 20;
/** 分镜上限：一次最多 6 镜。再多就不是一条视频，而是一集了（也要考虑 token）。 */
export const MAX_SHOTS = 6;
export const DEFAULT_SHOT_SECONDS = 5;

/**
 * 导演的工具：一个调用给出整份分镜。
 *
 * ★ 只用一次调用、`tool_choice: 'required'`：导演不该在这个阶段去读文档、
 *   更不该顺手改内容 —— 它的任务只有一个（拆镜头）。
 * ★ `task` 是【给另一个 Agent 的指令】，描述里必须说清这一点：
 *   实测最容易出的错，是导演把 task 写成给人看的旁白 ——
 *   而场景 Agent 需要的是「画什么」（可执行的动作）。
 */
export const PLAN_TOOL: ToolSchema = {
  type: 'function',
  function: {
    name: 'plan_shots',
    description: '给出这条视频的分镜：每一镜的名字、时长、以及【这一镜的 Agent 要做什么】。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '整片的标题（用于片头文字）。' },
        shots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '镜头名，2~12 字，会显示在时间轴上。' },
              seconds: { type: 'number', description: '这一镜多少秒（1.5~20）。' },
              task: {
                type: 'string',
                description:
                  '给这一镜的 Agent 的指令：画什么、用什么手法、什么时候出现。写成可执行的动作，不要写给人听的旁白。',
              },
            },
            required: ['name', 'seconds', 'task'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'shots'],
      additionalProperties: false,
    },
  },
};

/**
 * 导演的系统提示。
 *
 * ★ 三条硬约束都来自这套引擎的实测：
 *   1. **一镜一件事**：场景 Agent 的上下文只有本镜，任务里塞三件事它就只做一件；
 *   2. **说「画什么」而不是「讲什么」**：对象只能通过命令产生；
 *   3. **总时长**：科普短视频的注意力在 20~40 秒这个量级。
 */
export const DIRECTOR_PROMPT = [
  '你是一条科普视频的导演。你的唯一输出是一次 plan_shots 调用。',
  '把用户的一句话需求拆成 2~5 个镜头，每镜 3~8 秒，总长 15~35 秒。',
  '★ 一镜只做一件事。把「讲清楚一个概念」拆成「先给定义 / 再给一个比喻 / 最后给一个对比」这种颗粒度。',
  '★ 每镜的 task 是给【另一个只会画图的 Agent】的指令：说清画什么形状、什么文字、什么动画；',
  '  不要写旁白、不要写讲解词 —— 它没有耳朵，只有画笔。',
  '★ 后面的镜头可以接着前面的画面讲（画面是累加的，对象不会自动消失）。',
  '★ 文字要短（标题 4~10 字）。中文排版按 16:9 世界、可见范围 x∈[-8,8]、y∈[-4.5,4.5]。',
].join('\n');

/* ── 规划结果的解析（纯函数，可单测）───────────────────────────── */

export type PlanParse =
  | { readonly ok: true; readonly plan: FilmPlan; readonly dropped: number }
  | { readonly ok: false; readonly error: string };

function clampSeconds(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_SHOT_SECONDS;
  const clamped = Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, n));
  return Math.round(clamped * 10) / 10;
}

/**
 * 把导演的回执解析成一份可用的分镜。
 *
 * ★ 为什么这么宽进：模型给的东西永远可能缺字段、超长、给 7 镜。
 *   与其整份拒掉（用户等了几十秒只等到一句「导演没给好」），不如**能救就救**：
 *   夹时长、截镜数、名字缺了补「第 N 镜」、task 空的那一镜直接丢掉。
 *   但只要**一条能用的都没有**，就如实失败 —— 那时继续跑只会烧 token。
 */
export function parsePlan(raw: unknown, maxShots: number = MAX_SHOTS): PlanParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '导演没有返回分镜对象' };
  const obj = raw as Record<string, unknown>;
  const rawShots = Array.isArray(obj['shots']) ? obj['shots'] : [];
  if (rawShots.length === 0) return { ok: false, error: '导演给的分镜是空的（shots 数组为空）' };

  const title =
    typeof obj['title'] === 'string' && obj['title'].trim() !== '' ? obj['title'].trim() : '未命名';
  const shots: PlannedShot[] = [];
  let dropped = 0;
  for (const item of rawShots.slice(0, maxShots)) {
    if (typeof item !== 'object' || item === null) {
      dropped += 1;
      continue;
    }
    const s = item as Record<string, unknown>;
    const task = typeof s['task'] === 'string' ? s['task'].trim() : '';
    if (task === '') {
      dropped += 1;
      continue;
    }
    const name =
      typeof s['name'] === 'string' && s['name'].trim() !== ''
        ? s['name'].trim()
        : '第 ' + (shots.length + 1) + ' 镜';
    shots.push({ name: name.slice(0, 24), seconds: clampSeconds(s['seconds']), task });
  }
  if (shots.length === 0) return { ok: false, error: '导演给的每一镜都没有可执行的 task' };
  dropped += Math.max(0, rawShots.length - maxShots);
  return { ok: true, plan: { title, shots }, dropped };
}

/* ── 分镜 → 命令（纯函数，可单测）─────────────────────────────── */

/**
 * 把「当前文档 + 分镜」变成一串命令：清空内容、重排镜头表、定片长。
 *
 * ★ 清空为什么是【删对象】而不是删镜头：引擎的 remove_scene 明确拒绝删最后一镜，
 *   它的报错原文就是「如果要清空整片内容，请删对象而不是删镜头」——
 *   这条规则在这里被遵守，镜头表则【复用】：有的镜头改名字与起点，多的删掉，少的补上。
 * ★ 顺序：先 delete_effect 再 delete_object。反过来的话，对象没了、效果还在，
 *   会留下 effect_target_missing（校验器真的会报）。
 */
export function planToCommands(doc: SceneDoc, plan: FilmPlan): readonly Command[] {
  const commands: Command[] = [];
  for (const effId of Object.keys(doc.effects)) commands.push({ op: 'delete_effect', target: effId });
  for (const objId of Object.keys(doc.objects)) commands.push({ op: 'delete_object', target: objId });

  const ordered = sceneOrder(doc);
  let bornAt = 0;
  for (let i = 0; i < plan.shots.length; i++) {
    const shot = plan.shots[i];
    if (shot === undefined) continue;
    const reuse = ordered[i];
    if (reuse !== undefined) {
      commands.push({ op: 'set_scene', target: reuse.id, name: shot.name, bornAt });
    } else {
      commands.push({ op: 'add_scene', name: shot.name, bornAt });
    }
    bornAt += shot.seconds;
  }
  for (const extra of ordered.slice(plan.shots.length)) commands.push({ op: 'remove_scene', target: extra.id });
  // ★ 片长最后定：add_scene 自己也会顺延片长，两处都写会让结果取决于顺序
  commands.push({ op: 'set_meta', duration: Math.round(bornAt * 100) / 100 });
  return commands;
}

/** 整片总时长（秒，保留两位）。 */
export function planDuration(plan: FilmPlan): number {
  return Math.round(plan.shots.reduce((sum, s) => sum + s.seconds, 0) * 100) / 100;
}

/* ── 作业表：面板要轮询进度，所以状态得留在服务端 ──────────────── */

export type FilmState = 'planning' | 'running' | 'done' | 'failed';

/** 进度事件最多留这么多条：整片可能几百条，面板只贴最近的一屏。 */
export const FILM_EVENT_CAP = 400;

export interface FilmJob {
  readonly id: string;
  readonly brief: string;
  readonly state: FilmState;
  readonly title?: string;
  readonly plan?: FilmPlan;
  readonly shotsDone: number;
  readonly shotsTotal: number;
  readonly events: readonly FilmEvent[];
  readonly usage: TokenUsage;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
  /** 完成时才有：最终文档 + 要搬进浏览器 Journal 的操作。 */
  readonly doc?: SceneDoc;
  readonly entries?: readonly FilmEntry[];
  readonly fromVersion?: number;
  readonly toVersion?: number;
  readonly issueCodes?: readonly string[];
}

/**
 * 整片作业登记表（内存里，进程重启即清空）。
 *
 * ★ 为什么不做成一次阻塞的 HTTP 请求：整片是几十秒到几分钟的事，
 *   一个挂着不动的 POST 既看不到进度、也容易被超时掐断。
 *   导出那条路（ExportRegistry）早就是「起作业 + 轮询」，这里照抄同一个形状。
 */
export class FilmRegistry {
  private readonly jobs = new Map<string, FilmJob>();
  private seq = 0;

  create(brief: string, opts: { shotsTotal?: number } = {}): FilmJob {
    const id = 'film' + Date.now().toString(36) + '-' + (this.seq += 1);
    const job: FilmJob = {
      id,
      brief,
      state: 'planning',
      shotsDone: 0,
      shotsTotal: opts.shotsTotal ?? 0,
      events: [],
      usage: emptyUsage(),
      startedAt: Date.now(),
    };
    this.jobs.set(id, job);
    return job;
  }

  update(id: string, patch: Partial<FilmJob>): void {
    const cur = this.jobs.get(id);
    if (cur === undefined) return;
    this.jobs.set(id, { ...cur, ...patch });
  }

  /** 追加一条进度（超过上限就丢最旧的，但保留最后一条 —— 那通常是结论）。 */
  pushEvent(id: string, event: FilmEvent): void {
    const cur = this.jobs.get(id);
    if (cur === undefined) return;
    const next = [...cur.events, event];
    this.jobs.set(id, { ...cur, events: next.length <= FILM_EVENT_CAP ? next : next.slice(next.length - FILM_EVENT_CAP) });
  }

  get(id: string): FilmJob | undefined {
    return this.jobs.get(id);
  }

  list(): readonly FilmJob[] {
    return [...this.jobs.values()];
  }
}

/* ── 导演：一次模型调用 ───────────────────────────────────────── */

export interface PlanFilmOptions {
  readonly apiKey: string;
  readonly brief: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxShots?: number;
  /** 接口地址覆盖（作业 3）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
}

export interface PlanFilmResult {
  readonly plan: FilmPlan;
  readonly dropped: number;
  readonly usage: TokenUsage;
}

/**
 * 让导演把一句话拆成分镜。
 *
 * ★★ 两次尝试，是因为一条**只有实测才知道的 API 约束**：
 *   `tool_choice: 'required'` 与思考模式**不能同时用** ——
 *   服务端直接 400：`Thinking mode does not support this tool_choice`。
 *   （官方文档没写这一条；第一次真调模型就撞上了，见 docs/progress.md §0.26。）
 *
 *   所以我们先按「思考 + auto」问一次（分镜这件事确实吃推理），
 *   它没调工具时再退到「不思考 + required」——后者是唯一能强制产出分镜的组合。
 *   两次都拿不到就抛异常：这次调用之后紧接着就是几十秒的逐镜跑，
 *   拿一份空计划往下跑只会烧 token。
 */
export async function planFilm(opts: PlanFilmOptions): Promise<PlanFilmResult> {
  let usage = emptyUsage();
  const messages = [
    { role: 'system' as const, content: DIRECTOR_PROMPT },
    { role: 'user' as const, content: opts.brief },
  ];

  /** 问一次并尝试解析；拿不到分镜就返回 null（由调用方决定要不要再试）。 */
  const attempt = async (
    toolChoice: 'auto' | 'required',
    reasoningEffort: ReasoningEffort | undefined,
  ): Promise<PlanFilmResult | null> => {
    const reply = await chatCompletions({
      apiKey: opts.apiKey,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages,
      tools: [PLAN_TOOL],
      toolChoice,
    });
    usage = addUsage(usage, reply.usage);
    const call = (reply.message.tool_calls ?? [])[0];
    if (call === undefined) return null;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments === '' ? '{}' : call.function.arguments);
    } catch {
      throw new Error('导演的 plan_shots 参数不是合法 JSON');
    }
    const parsed = parsePlan(args, opts.maxShots ?? MAX_SHOTS);
    if (!parsed.ok) throw new Error('导演分镜不可用：' + parsed.error);
    return { plan: parsed.plan, dropped: parsed.dropped, usage };
  };

  const first = await attempt('auto', opts.reasoningEffort);
  if (first !== null) return first;
  /** 第一次没调工具 → 关掉思考再强制一次（这是唯一合法的组合）。 */
  const second = await attempt('required', 'off');
  if (second !== null) return second;
  throw new Error('导演两次都没有调用 plan_shots');
}

/* ── 整片：规划 + 清空 + 逐镜 ─────────────────────────────────── */

/** 一条进度事件（面板把它逐条贴进聊天窗口）。 */
export interface FilmEvent {
  readonly at: number;
  readonly kind: 'plan' | 'shot' | 'tool' | 'note' | 'error';
  readonly text: string;
  readonly sceneId?: string;
  readonly name?: string;
  readonly turn?: number;
}

export interface RunFilmOptions {
  readonly apiKey: string;
  readonly brief: string;
  readonly doc: SceneDoc;
  readonly render: ShotRenderer;
  /** 分镜出来时回调一次（服务端用它把作业从 planning 推进到 running）。 */
  readonly onPlan?: (plan: FilmPlan) => void;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxShots?: number;
  /** 每一镜的轮数上限（整片的成本主要在这里，默认见 DEFAULT_MAX_TURNS_PER_SHOT）。 */
  readonly maxTurnsPerShot?: number;
  readonly limits?: BudgetLimits;
  /** 接口地址覆盖（作业 3）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
  readonly now?: () => number;
  readonly approvalPolicy?: ToolContext['approvalPolicy'];
  readonly policy?: ToolContext['policy'];
  /** 每产生一条进度就回调一次（服务端用它写作业状态，面板用它轮询）。 */
  readonly onEvent?: (event: FilmEvent) => void;
}

export interface FilmEntry {
  readonly patches: readonly unknown[];
  readonly affectedPaths: readonly string[];
  readonly assignedId?: string;
  readonly intent?: string;
}

export interface RunFilmResult {
  readonly title: string;
  readonly plan: FilmPlan;
  readonly doc: SceneDoc;
  readonly journal: Journal;
  readonly shots: readonly ShotOutcome[];
  readonly events: readonly FilmEvent[];
  readonly usage: TokenUsage;
  /** 要搬进浏览器 Journal 的操作（形状与 /api/chat 的 entries 一致）。 */
  readonly entries: readonly FilmEntry[];
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly issues: ReturnType<typeof validate>;
}

/**
 * 跑一整片：导演分镜 → 清空并建分镜 → 逐镜串行 → 汇总。
 *
 * ★ 全程只有【一个 Journal】：清空与分镜也是这个文档上的一次写入，
 *   所以面板那边拿到的 entries 是一段完整历史（含清空那一步），
 *   撤销也因此整体一致 —— 两个 Journal 会让版本号与快照对不上。
 * ★ 逐镜的 turnId 由 multi-shot 负责（每镜一个），于是「撤销这一镜」在面板里真的可用。
 */
export async function runFilm(opts: RunFilmOptions): Promise<RunFilmResult> {
  let clock = opts.now?.() ?? Date.now();
  const now = opts.now ?? ((): number => (clock += 1000));
  const events: FilmEvent[] = [];
  const emit = (e: Omit<FilmEvent, 'at'>): void => {
    const full: FilmEvent = { ...e, at: now() };
    events.push(full);
    opts.onEvent?.(full);
  };

  const journal = createJournal(opts.doc, { now });
  const fromVersion = journal.currentVersion();
  let usage = emptyUsage();

  emit({ kind: 'note', text: '导演正在分镜…' });
  const planned = await planFilm({
    apiKey: opts.apiKey,
    brief: opts.brief,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
    ...(opts.maxShots === undefined ? {} : { maxShots: opts.maxShots }),
  });
  usage = addUsage(usage, planned.usage);
  const plan = planned.plan;
  emit({
    kind: 'plan',
    text:
      '分镜《' + plan.title + '》：' +
      plan.shots.map((s, i) => i + 1 + '. ' + s.name + '（' + s.seconds + 's）').join(' · ') +
      ' → 共 ' + planDuration(plan) + 's',
  });
  if (planned.dropped > 0) {
    emit({ kind: 'note', text: '⚠ 导演给的分镜里有 ' + planned.dropped + ' 条不可用或超出上限，已丢弃' });
  }
  opts.onPlan?.(plan);

  // ── 清空 + 建分镜：也走唯一写路径（actor=agent，一个 compound）────
  const setupBudget = new BudgetTracker('film-setup', opts.limits ?? DEFAULT_LIMITS);
  const setup = applyCommands(
    { baseVersion: journal.currentVersion(), commands: [...planToCommands(opts.doc, plan)] },
    {
      journal,
      budget: () => setupBudget.remaining(),
      actor: 'agent',
      turnId: 'film-setup',
      now,
    },
  );
  emit({
    kind: 'note',
    text:
      '清空并建分镜：成功 ' + setup.ok.length + ' 条' +
      (setup.errored.length === 0
        ? ''
        : ' · 失败 ' + setup.errored.length + ' 条（' + setup.errored.map((e) => e.error.code).join(', ') + '）'),
  });

  // ── 逐镜跑 ────────────────────────────────────────────────────
  const afterSetup = journal.currentDoc();
  const ordered = sceneOrder(afterSetup);
  const tasks = plan.shots
    .map((s, i) => ({ sceneId: ordered[i]?.id, task: s.task }))
    .filter((t): t is { sceneId: string; task: string } => t.sceneId !== undefined);
  const nameOf = new Map(plan.shots.map((s, i) => [ordered[i]?.id ?? '', s.name]));

  const multi = await runMultiShot({
    apiKey: opts.apiKey,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    doc: afterSetup,
    // ★ 复用同一个 Journal：清空那一步与逐镜写入在【同一条历史】里
    journal,
    tasks,
    ...(opts.maxTurnsPerShot === undefined ? {} : { maxTurns: opts.maxTurnsPerShot }),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    render: opts.render,
    now,
    ...(opts.approvalPolicy === undefined ? {} : { approvalPolicy: opts.approvalPolicy }),
    ...(opts.policy === undefined ? {} : { policy: opts.policy }),
    onShotStart: (info) => {
      emit({
        kind: 'shot',
        sceneId: info.sceneId,
        text: '第 ' + info.index + '/' + info.total + ' 镜 · ' + (nameOf.get(info.sceneId) ?? info.sceneId) + '：开始',
      });
    },
    onTool: (e, sceneId) => {
      emit({ kind: 'tool', sceneId, name: e.name, turn: e.turn, text: e.name });
    },
  });
  usage = addUsage(usage, multi.usage);

  for (const shot of multi.shots) {
    emit({
      kind: 'shot',
      sceneId: shot.sceneId,
      text:
        '第 ' + (ordered.findIndex((s) => s.id === shot.sceneId) + 1) + ' 镜 · ' +
        (nameOf.get(shot.sceneId) ?? shot.sceneId) + '：写入 ' + shot.agentOperations +
        ' 条 · 版本 ' + shot.fromVersion + '→' + shot.toVersion + ' · ' + shot.run.turns + ' 轮',
    });
  }

  const doc = journal.currentDoc();
  const entries: FilmEntry[] = journal
    .operations()
    .filter((o) => o.actor === 'agent')
    .map((o) => ({
      patches: o.patches,
      affectedPaths: o.affectedPaths,
      ...(o.assignedId === undefined ? {} : { assignedId: o.assignedId }),
      ...(o.intent === undefined ? {} : { intent: o.intent }),
    }));

  return {
    title: plan.title,
    plan,
    doc,
    journal,
    shots: multi.shots,
    events,
    usage,
    entries,
    fromVersion,
    toVersion: journal.currentVersion(),
    issues: validate(doc),
  };
}
