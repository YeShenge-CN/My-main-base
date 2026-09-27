/**
 * Agent Runtime —— Read → Command → Validate → Render Feedback（不变量 2）。
 *
 * 它做四件事：
 *   1. 维护消息历史与 L3 上下文预算（图片 ≤ 3 张，更早的折成文字摘要）
 *   2. 把工具回执喂回模型（含 budget 剩余量，这是让模型"记得住预算"的唯一可靠手段）
 *   3. 每个 turn 结束时把本轮产生的 CompoundOperation 置 settled
 *   4. 到达轮数上限就停 —— 不静默续命
 */
import {
  addUsage,
  chatCompletions,
  emptyUsage,
  type ChatMessage,
  type ReasoningEffort,
  type TokenUsage,
  type ToolSchema,
} from './deepseek';
import { SYSTEM_PROMPT } from './prompt';
import { dispatchTool, TOOLS, type ToolContext } from './tools';
import { L3_MAX_IMAGES_IN_CONTEXT, enforceContextBudget } from './budget';
import { validate } from '@sva/engine-core';
import type { BudgetState } from '@sva/engine-core';

const TOOL_SCHEMAS: readonly ToolSchema[] = TOOLS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    strict: true,
    parameters: t.parameters,
  },
}));

export interface ToolTrace {
  readonly turn: number;
  readonly name: string;
  readonly args: unknown;
  readonly result: string;
  readonly imageCount: number;
}

/* ══════════════════ 收尾判定（纯函数，可单测）══════════════════
 * ★ 为什么把它从循环里抽出来：
 *   这段逻辑曾经内联在 for 里，而它唯一能测的方式是"真调一次模型"
 *   （要花钱、要联网、结果不确定）—— 于是它带着一个真 bug 活了下来：
 *   `cleanTurns >= 3` 那条漏了 `anyWrite` 护栏，一个"本来就零 issue"的文档
 *   会让连读三轮、一次没写的 Agent 被判成"做完了"。
 *   抽成纯函数之后，这类判据可以在毫秒级、无网络、确定性的条件下测。
 */
export interface VerdictState {
  /** 上一轮是否写过。 */
  readonly wrotePrevTurn: boolean;
  /** issues 连续为 0 的轮数。 */
  readonly cleanTurns: number;
}

export interface TurnVerdictInput {
  readonly trace: readonly ToolTrace[];
  readonly turn: number;
  /** 当前文档的 issues 总数（validate 的长度）。 */
  readonly issueCount: number;
  readonly prev: VerdictState;
  /** 工具自己要求结束（finish_shot）。 */
  readonly stopRequested: boolean;
  /** 模型这一轮一个工具都没调（它用文字收尾了）。 */
  readonly noToolCalls: boolean;
  /**
   * 这一镜有没有【真的渲染过】一帧（第二十九轮）。
   *
   * ★★ 为什么兜底收尾也要看它：实测（真调模型）里模型连着三轮把 issues 清成 0，
   *   Runtime 按 clean_three_turns 收尾 —— 而它**一次画面都没看过**。
   *   收尾关卡管得到 finish_shot，管不到 Runtime 自己的兜底规则，
   *   于是「强制看画面」被从后门绕了过去。**两条判据打架时，后门那条必须补上同样的前提。**
   */
  readonly sawFrame: boolean;
  /**
   * 现在还渲染得起一帧吗。
   *
   * ★ 它是逃生口的判据：额度已经不足以渲染任何一帧时（实测配置 maxImages=0），
   *   继续要求「看过」只会把模型困死在轮数上限里 —— 那时兜底收尾照常工作，
   *   而「从未渲染过一帧」由 runShot 末尾统一报出来。
   */
  readonly canStillRender: boolean;
}

export type TurnVerdict =
  | { readonly kind: 'continue'; readonly state: VerdictState }
  | {
      readonly kind: 'finish';
      readonly reason: string;
      readonly state: VerdictState;
      /** 收尾时还剩几项没达标（critique_stalled 会带）。 */
      readonly unresolved?: number;
    };

/**
 * 这条 apply_commands 回执里**真的写成了几条**。
 *
 * ★★ 这里以前只看「调用过 apply_commands」，不看结果 —— 于是实测的这一轮：
 *   模型一次提交 `[remove_object, delete_object, delete, remove, clear]`，
 *   4 条 unsupported_op、1 条碰巧生效，runtime 就把它记成「写过」，
 *   接着按「issues 连续三轮为 0」收尾，聊天里留下的是**像成功**的收尾语。
 *   「调用过」与「写成了」是两件事；判据必须用后者。
 *
 * ★ 解析失败按 0 算：宁可保守（继续跑），也不要凭一个没读懂的回执宣称做完了。
 */
function okCountOf(result: string): number {
  try {
    const parsed = JSON.parse(result) as { ok?: unknown };
    return Array.isArray(parsed.ok) ? parsed.ok.length : 0;
  } catch {
    return 0;
  }
}

/** 这一轮产生的 trace 里有没有【成功】的写入。 */
function anyWriteIn(trace: readonly ToolTrace[]): boolean {
  return trace.some((t) => t.name === 'apply_commands' && okCountOf(t.result) > 0);
}

/**
 * 视觉评审报回来的问题数序列（按调用顺序）。
 *
 * ★ 解析失败的不计入：宁可多跑一轮，也不要凭一份没读懂的回执宣称"没有改善"。
 */
function critiqueCounts(trace: readonly ToolTrace[]): number[] {
  const out: number[] = [];
  for (const t of trace) {
    if (t.name !== 'critique_frame') continue;
    try {
      const parsed = JSON.parse(t.result) as { findings?: unknown };
      if (Array.isArray(parsed.findings)) out.push(parsed.findings.length);
    } catch {
      // 忽略
    }
  }
  return out;
}

/**
 * 「连续两轮无改善就停」——§0.28 作业 1 要求的终止条件之一。
 *
 * ★ 为什么必须有它：独立评审会**永远**找出可以更好的地方（这是它的职责），
 *   于是"再评一次 → 再改一点"可以无限循环到撞满轮数，而每一轮都是真金白银。
 *   判据刻意只用【评审自己报的问题数】：它可数、可断言，不依赖"模型说它改好了"。
 *
 * ★ 两个前提缺一不可：① 窗口起点还有问题（否则本来就该收尾）；
 *   ② 三个数单调不降（连续两次没有改善）。
 *
 * @returns 仍有问题时的数量；没有停滞（或已干净）时返回 null。
 */
export function critiqueStalled(trace: readonly ToolTrace[]): number | null {
  const counts = critiqueCounts(trace);
  if (counts.length < 3) return null;
  const a = counts[counts.length - 3] ?? 0;
  const b = counts[counts.length - 2] ?? 0;
  const c = counts[counts.length - 1] ?? 0;
  if (a <= 0) return null;
  return c >= b && b >= a ? c : null;
}

export function judgeTurn(input: TurnVerdictInput): TurnVerdict {
  const { trace, turn, issueCount, prev, stopRequested, noToolCalls } = input;
  const wroteThisTurn = trace.some((t) => t.turn === turn && t.name === 'apply_commands' && okCountOf(t.result) > 0);
  const state: VerdictState = {
    wrotePrevTurn: wroteThisTurn,
    cleanTurns: issueCount === 0 ? prev.cleanTurns + 1 : 0,
  };

  if (stopRequested) return { kind: 'finish', reason: 'tool_requested', state };
  if (noToolCalls) return { kind: 'finish', reason: 'model_stopped', state };

  /**
   * ★ 终止条件：评审连续两轮没有改善 → 停，并如实说还有几项。
   *   它【不需要】anyWrite 护栏：模型可能一直在写，只是没写对 ——
   *   而"一直在写却没改善"正是这条要治的情形。
   */
  const stalled = critiqueStalled(trace);
  if (stalled !== null) return { kind: 'finish', reason: 'critique_stalled', state, unresolved: stalled };

  /**
   * ★★ `anyWrite` 是这两条兜底收尾的【共同】前提。
   *
   *   没有它：一个本来就零 issue 的文档，会让"连读若干轮、一次没写"的 Agent
   *   被判成"做完了"—— 用户的要求一个字都没落地，却记成成功。
   *   实测症状：面板里只留下一句"（Runtime 收尾：issues 已连续三轮为 0）"。
   *
   *   issues 为 0 只在【已经写过东西】之后才说明做完了；没写过只说明还没开始。
   */
  const anyWrite = anyWriteIn(trace);
  /**
   * ★★ 兜底收尾还有第二个前提：**这一镜真的看过画面**（或者已经渲染不起了）。
   *   没有它，「模型没看过画面」这件事会被 Runtime 自己的兜底规则合法地放过 ——
   *   实测就是这么发生的：5 轮里 render_frames 一次都没有，却干净地收尾了。
   */
  const mayFinish = input.sawFrame || !input.canStillRender;

  // 兜底一：连续两轮无写入且 issues 归零 —— "做完了但不说"
  if (anyWrite && mayFinish && !wroteThisTurn && !prev.wrotePrevTurn && issueCount === 0) {
    return { kind: 'finish', reason: 'quiet_two_turns', state };
  }
  // 兜底二：issues 连续三轮为 0 —— 治"反复微调到撞满轮数"
  if (anyWrite && mayFinish && state.cleanTurns >= 3) {
    return { kind: 'finish', reason: 'clean_three_turns', state };
  }
  return { kind: 'continue', state };
}

/**
 * 收尾原因 → 给人看的一句话。
 *
 * ★ 措辞是【规格的一部分】：兜底收尾只说明「模型停手了 + 文档自洽」，
 *   它**不是**「你要的东西做出来了」的证明。以前它写的是「issues 已连续三轮为 0」，
 *   读起来完全像成功 —— 而实测那一轮用户要的整片一个字都没生成。
 *   `wroteAny = false` 时更要直说：一次写入都没落地。
 */
export function verdictMessage(reason: string, wroteAny = true, unresolved?: number): string {
  const tail = wroteAny ? '' : '，而且这一轮**一次写入都没有落地**';
  switch (reason) {
    case 'critique_stalled':
      return (
        '（Runtime 收尾：视觉评审连续两轮没有改善，还有 ' + String(unresolved ?? 0) +
        ' 项没达标 —— 停在这里并如实报告，不要再空转' + tail + '）'
      );
    case 'quiet_two_turns':
      return '（Runtime 主动收尾：连续两轮无写入且 issues 归零' + tail + '。这是兜底规则，不代表任务做完了）';
    case 'clean_three_turns':
      return '（Runtime 收尾：issues 已连续三轮为 0' + tail + '。这是兜底规则，不代表任务做完了）';
    default:
      return '';
  }
}

/**
 * finish_shot 的回执是 JSON（机器可读），而【给人看的那句话】由 finishReport 产出。
 *
 * ★★ 为什么必须有这一步：runShot 原来把 finish_shot 的**原始 JSON** 当成 finalMessage，
 *   于是面板最后给用户看的是 {"status":"finished","summary":"…","issues":0} ——
 *   读起来像成功，而「还有 3 项 layout 缺陷没解决」这件事在那一行里根本看不见。
 *   §0.28 作业 1 的验收第 3 条说的就是这件事：**不许看起来像成功**。
 *
 * ★ 纯函数：解析、措辞、以及"未决问题数"的判定都能在毫秒级被断言，
 *   不必真调一次模型才知道收尾话术对不对。
 */
/**
 * 收尾时「从未渲染过一帧」的警告。
 *
 * ★★ 为什么它必须由 runShot【统一】追加，而不是写在 finish_shot 的回执里：
 *   实测（maxImages=0 那一轮）里模型压根没走到 finish_shot ——
 *   它是被 Runtime 的兜底规则（连续两轮无写入）收的尾。
 *   只写在 finish_shot 里的话，**这条警告会在其它收尾路径上凭空消失**，
 *   于是「没看过画面就交」又一次变得看不出来。
 *   一条判据只要有几个出口，就必须挂在所有出口的【共同下游】上。
 */
export const BLIND_FINISH_WARNING =
  ' ⚠ 这一镜【从未渲染过一帧】—— 收尾是在没看过画面的情况下做出的。';

export function finishReport(resultText: string): string {
  let parsed: { summary?: unknown; unresolved?: unknown; unresolvedCodes?: unknown; lookedFrame?: unknown };
  try {
    parsed = JSON.parse(resultText) as typeof parsed;
  } catch {
    // 回执不是 JSON 就原样带出去 —— 宁可难看，也不要吞掉信息
    return resultText;
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const unresolved = typeof parsed.unresolved === 'number' ? parsed.unresolved : 0;
  const codes = Array.isArray(parsed.unresolvedCodes)
    ? parsed.unresolvedCodes.filter((c): c is string => typeof c === 'string')
    : [];
  const head = '（镜头收尾）' + (summary === '' ? '' : summary);
  if (unresolved <= 0) return head + '（validate 已无未决问题）';
  return (
    head + ' ⚠ 还有 ' + unresolved + ' 项没达标（' +
    (codes.length === 0 ? '未列出' : codes.join('、')) +
    '）—— 这些引擎不会自动修，这份镜头【不算完成】。'
  );
}

/**
 * ★ 任务文本前面补一句"你在哪一镜"。
 *
 *   多 Agent 下这是必须的：模型看不到自己的身份（那是编排层给的 scope），
 *   而它需要知道自己在做哪一段 —— 否则会写出"整片"口径的改动
 *   （比如把对象设成 global、或者试图改片长）。
 *
 *   刻意只补【边界与归属】，不补制作意图：意图由上层的任务给出。
 */
export function sceneScopedTask(task: string, sceneId: string, start: number, end: number): string {
  return (
    '【你负责的镜头】' + sceneId + '，时间 [ ' + start + 's , ' + end + 's )（整片时间轴上的这一段）。\n' +
    '你新建的对象会自动属于这一镜，不用也不要指定 sceneId（写 null 即可）。\n' +
    '你改不了其它镜头、也改不了片长与镜头表 —— 这些由导演负责。\n' +
    '任务：' + task
  );
}

export interface RunOptions {
  readonly apiKey: string;
  readonly model?: string;
  /**
   * 思考强度。省略 = 不开思考（= 加这个开关之前的行为）。
   *
   * ★ 它只影响「模型想不想」，不影响工具表与提示词 —— 所以它与 token 预算那套
   *   （§7 的固定开销）是两笔账：开了之后多花的是**输出**侧的 reasoning token。
   */
  readonly reasoningEffort?: ReasoningEffort;
  readonly task: string;
  readonly ctx: ToolContext;
  /** 接口地址覆盖（作业 3 起可由页面设置）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
  /**
   * 本轮次 id（写进 compound，决定"撤销这一轮"的粒度）。
   *
   * ★ 多 Agent 下必须是【每镜一个】。否则所有镜头归到同一个 compound，
   *   面板上点"撤销这一轮"会把整片一起撤掉 —— 而用户想要的显然是
   *   "把刚才那一镜重做一遍"。省略时用 ctx.turnId。
   */
  readonly turnId?: string;
  readonly maxTurns?: number;
  readonly maxImagesInContext?: number;
  readonly onTurn?: (turn: number, trace: readonly ToolTrace[]) => void;
  /**
   * 每执行完一个工具调用就回调一次。
   *
   * ★ Runtime 本身不打印任何东西 —— 输出格式是宿主的事（CLI 打给人看，
   *   面板打给界面，测试收集成断言）。这个回调就是那条边界：
   *   没有它，想让"看着 Agent 干活"成为可能，就得往 Runtime 里塞 console.log。
   */
  readonly onTool?: (event: ToolEvent) => void;
  /**
   * 上一轮的背景（给"再亮一点"这类指代用）。
   *
   * ★ 为什么不把上一轮的消息历史原样塞回来：
   *   DeepSeek 的协议要求 assistant 的 tool_calls 与随后的 tool 回执【成对】，
   *   而界面侧只能看到文字（图片与原始回执在服务端）。拼不完整的配对会让请求直接失败；
   *   就算能拼，每轮都把完整回执再送一遍，token 会成倍涨。
   *   所以只注入一段【紧凑的文字背景】：上一轮要它做什么、结果如何（含对象 id 与关键值）。
   */
  readonly history?: readonly string[];
  /**
   * history 那一段的标题。
   *
   * ★ 为什么可配：同一份 history 有两种来源 ——「同一镜的上一轮」与
   *   「前面几镜的交接摘要」。标题说错会比不说更糟（模型会以为这是它自己的历史）。
   */
  readonly historyLabel?: string;
}

/** 把历史背景拼成一条系统消息；没有历史时返回 null。 */
export function historyMessage(
  history: readonly string[],
  label = '这个镜头的上一轮（背景，供理解指代）',
): ChatMessage | null {
  if (history.length === 0) return null;
  return {
    role: 'system',
    content:
      '## ' + label + '\n' +
      history.map((h, i) => i + 1 + '. ' + h).join('\n') +
      '\n\n上面这些是【背景】：用户接下来这句话可能是在说它们（"它/那条曲线/再亮一点"），' +
      '也可能是在说别的。先用 get_scene_summary 或 get_object 确认当前状态，再动手 —— ' +
      '不要凭这段背景直接改。',
  };
}

/** 一次工具执行的摘要，供宿主实时展示。 */
export interface ToolEvent {
  readonly turn: number;
  readonly name: string;
  readonly args: unknown;
  readonly result: string;
  readonly imageCount: number;
  readonly finished: boolean;
}

export interface RunResult {
  readonly turns: number;
  /**
   * 累计 token。主指标 token_per_success 的来源。
   *
   * ★ 第二十九轮起它是【拆开的】：输入 / 输出 / 缓存命中 / 思考 / 图片帧数。
   *   以前只有一个总数，于是「钱花在哪」在界面上根本答不出来（§0.28 作业 3）。
   */
  readonly usage: TokenUsage;
  /** 被拒绝/过期的提案数（人工介入的引擎侧信号） */
  readonly proposalDecisions: readonly string[];
  /** 模型主动收尾（没有更多工具调用）为 true；撞到轮数上限为 false */
  readonly finished: boolean;
  /**
   * 是否被轮数上限【截断】。
   *
   * ★ 以前只有 finished=false 这一个信号，而它把两件事混在一起：
   *   "模型卡住了"和"模型干得挺好但没来得及收尾"。
   *   压力测试实测 #10 就是后者：8 轮里写了 4 次、自愈了两次错命令，
   *   最后停在 issues=1 上被记成"未收尾"。截断必须能被单独看见 ——
   *   否则下一次只会把轮数调大，而不知道调大是不是真的解决了问题。
   */
  readonly truncated: boolean;
  readonly finalMessage: string;
  readonly trace: readonly ToolTrace[];
  readonly budget: BudgetState;
  readonly messages: readonly ChatMessage[];
}

/**
 * 默认轮数上限。
 *
 * 规范/压力测试原来用 8。实测不够：一条"画曲线 + 加淡入动画 + 核对画面"的任务
 * 会花掉 8 轮，而其中至少两轮用在读回执与纠正自己的错命令上（那是【健康】行为，
 * 不是浪费）。12 轮留出纠错预算；真正的收尾由 finish_shot 与 Runtime 的兜底规则保证，
 * 不靠轮数硬卡。
 *
 * ★★ 第二十九轮按【用户拍板】从 12 抬到 30：12 是实测过两次的截断源
 *   （§0.28 三：整片验收一次 8 轮、一次每镜 4 轮被它砍掉）。
 *   用户的原话是「比起节省 token，我更想要画面效果」，而轮数换来的正是
 *   纠错与自检的余地。注意它【不是免费】的：每一轮都要重发固定开销（约 9039），
 *   所以上限抬高只是"不早停"，不制造额外的轮次 —— 收尾仍由 finish_shot
 *   与 judgeTurn 的兜底规则决定。
 */
export const DEFAULT_MAX_TURNS = 30;

export async function runShot(opts: RunOptions): Promise<RunResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxImages = opts.maxImagesInContext ?? L3_MAX_IMAGES_IN_CONTEXT;
  /**
   * 本轮次 id。多 Agent 下每镜一个 —— turnId 决定 compound 的粒度，
   * 而 compound 就是"撤销这一轮"的单位（见 RunOptions.turnId 的注释）。
   */
  const turnId = opts.turnId ?? opts.ctx.turnId;

  let messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(historyMessage(opts.history ?? [], opts.historyLabel) === null
      ? []
      : [historyMessage(opts.history ?? [], opts.historyLabel) as ChatMessage]),
    { role: 'user', content: opts.task },
  ];
  const trace: ToolTrace[] = [];
  let finished = false;
  let finalMessage = '';
  let turns = 0;
  let usage = emptyUsage();
  let wrotePrevTurn = false;
  let cleanTurns = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turns = turn;

    // L3：进模型之前先压图片预算
    const trimmed = enforceContextBudget(messages, maxImages);
    messages = [...trimmed.messages];

    const reply = await chatCompletions({
      apiKey: opts.apiKey,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort }),
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      messages,
      tools: TOOL_SCHEMAS,
      toolChoice: 'auto',
    });

    usage = addUsage(usage, reply.usage);

    const msg = reply.message;
    // ★ 整条回执原样进历史（含 `reasoning_content`）——这是【有意的】：
    //   下一轮把它发回去，思考才会延续（不回传不报错，但那一轮思考被压成 0）。
    //   所以这里【不要】改成「只挑几个字段重建」的写法：那样思考就断在这里了。
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      finished = true;
      finalMessage = typeof msg.content === 'string' ? msg.content : '';
      break;
    }

    let stop = false;
    for (const call of calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(
          call.function.arguments === '' ? '{}' : call.function.arguments,
        ) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const outcome = await dispatchTool(call.function.name, args, opts.ctx);
      if (outcome.finished === true) {
        finished = true;
        // ★ 不要直接把原始 JSON 当收尾话术（见 finishReport 的注释）
        finalMessage = finishReport(outcome.text);
        stop = true;
      }
      trace.push({
        turn,
        name: call.function.name,
        args,
        result: outcome.text,
        imageCount: outcome.images?.length ?? 0,
      });
      opts.onTool?.({
        turn,
        name: call.function.name,
        args,
        result: outcome.text,
        imageCount: outcome.images?.length ?? 0,
        finished: outcome.finished === true,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text });

      if (outcome.images !== undefined && outcome.images.length > 0) {
        // ★ 图片帧数单独记账：它的 token 已经含在 promptTokens 里（实测 323/帧），
        //   单独数只是为了让「钱花在哪」在界面上答得出来 —— 不要重复相加。
        usage = addUsage(usage, { ...emptyUsage(), imageFrames: outcome.images.length });
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '以下是刚才渲染的 ' + outcome.images.length + ' 帧画面：' },
            ...outcome.images.map((img) => ({
              type: 'image_url',
              image_url: { url: img.dataUrl },
            })),
          ],
        });
      }
    }

    // ★ 本轮结束：把本轮产生的 compound 置 settled（规范 §12）
    opts.ctx.journal.settle(turnId);
    opts.onTurn?.(turn, trace);
    if (stop) break;

    // ★ 收尾判定走纯函数（见 judgeTurn 的注释：它抽出来的理由就是为了能单测）。
    const verdict = judgeTurn({
      trace,
      turn,
      issueCount: validate(opts.ctx.doc()).length,
      prev: { wrotePrevTurn, cleanTurns },
      stopRequested: stop,
      noToolCalls: false,
      sawFrame: opts.ctx.budget.hasRenderedFrame(),
      canStillRender: opts.ctx.budget.checkRender([0]).ok,
    });
    wrotePrevTurn = verdict.state.wrotePrevTurn;
    cleanTurns = verdict.state.cleanTurns;
    if (verdict.kind === 'finish') {
      finished = true;
      finalMessage = verdictMessage(verdict.reason, anyWriteIn(trace), verdict.unresolved);
      break;
    }
  }

  opts.ctx.journal.settle(turnId);
  /**
   * ★ 唯一的收口处：无论走哪条路收尾（finish_shot / 模型自己停 / Runtime 兜底 /
   *   撞满轮数），"这一镜从没渲染过一帧"都必须出现在最终那句话里。
   */
  if (!opts.ctx.budget.hasRenderedFrame()) {
    finalMessage =
      finalMessage === '' ? BLIND_FINISH_WARNING.trim() : finalMessage + BLIND_FINISH_WARNING;
  }
  return {
    turns,
    finished,
    // 循环自然结束（没有 break）就是被轮数截断：此时 finished 仍是 false
    truncated: !finished,
    finalMessage,
    trace,
    usage,
    proposalDecisions: opts.ctx.takeProposalDecisions?.() ?? [],
    budget: opts.ctx.budget.remaining(),
    messages,
  };
}