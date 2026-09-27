/**
 * DeepSeek 客户端（Responses / chat-completions 里选了 chat-completions 格式）。
 * strict: true + base_url https://api.deepseek.com/beta（P6 清单第 3 条）。
 *
 * 客户端本身不做重试与降级：失败就如实抛给 Runtime，让 Runtime 决定是重试还是回执给模型。
 * 静默重试会让"预算耗尽时报错"这类行为变得不可观测。
 */
export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
  readonly tool_calls?: readonly ToolCall[];
  readonly tool_call_id?: string;
  /**
   * 思考链（只有开了思考模式才有）。
   *
   * ★ 它必须**原样留在 assistant 的历史消息里**：下一轮把它一起发回去，思考才会延续。
   *   实测：不回传**不报错**，但那一轮思考被静默压成 0（官方文档写的是会 400，
   *   2026-09 的实际行为是降级）—— 于是「带工具的多轮里模型像失忆」，最难查的那种。
   */
  readonly reasoning_content?: string;
}

export interface ToolSchema {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly strict: true;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  readonly apiKey: string;
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly toolChoice?: 'auto' | 'required' | 'none';
  readonly baseUrl?: string;
  readonly temperature?: number;
  /** 思考强度。省略 = 一个字段都不发（与加这个开关之前逐字一致）。 */
  readonly reasoningEffort?: ReasoningEffort;
  /** 输出上限。省略 = DEFAULT_MAX_TOKENS（**永远显式发出去**，见那个常量的注释）。 */
  readonly maxTokens?: number;
}

/**
 * 一次请求的 token 拆账。
 *
 * ★★ 第二十九轮之前这里只有 promptTokens / completionTokens 两个数，
 *   而回执里本来还有三样东西，全都【没有记下来】：
 *     · prompt_cache_hit_tokens / prompt_cache_miss_tokens（两者单价差很多，
 *       合并计价会明显偏高 —— 作业 3 的「费用计算」需要它们分开）；
 *     · completion_tokens_details.reasoning_tokens（**已含在** completionTokens 里，
 *       单独报只是为了让账看得懂：开思考约 3.7× 输出）；
 *     · 这次请求里带了几帧画面（图片已含在 promptTokens 里，单独计数是为了
 *       回答"钱到底花在哪" —— 实测一帧固定 323 token，见 §0.28）。
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** 输入里【缓存命中】的那部分（单价更低）。 */
  readonly cachedTokens: number;
  /** 输入里【缓存未命中】的那部分。cached + uncached === promptTokens。 */
  readonly uncachedTokens: number;
  /** 思考 token。★ 已含在 completionTokens 里，不要重复相加。 */
  readonly reasoningTokens: number;
  /** 这次请求带了几帧画面。图片的 token 已含在 promptTokens 里，不要重复相加。 */
  readonly imageFrames: number;
}

export function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    uncachedTokens: 0,
    reasoningTokens: 0,
    imageFrames: 0,
  };
}

/** 逐次累加。★ 只在这里做加法 —— 散落的 a += b 迟早会漏掉新字段。 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    uncachedTokens: a.uncachedTokens + b.uncachedTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    imageFrames: a.imageFrames + b.imageFrames,
  };
}

export interface ChatReply {
  readonly message: ChatMessage;
  readonly finishReason: string;
  readonly usage: TokenUsage;
}

export const DEEPSEEK_BETA_URL = 'https://api.deepseek.com/beta/chat/completions';
export const DEFAULT_MODEL = 'deepseek-chat';

/**
 * 输出上限（max_tokens）。
 *
 * ★★ 第二十九轮之前我们**从来没传过这个字段**（§0.28 三 ⑥），于是用的是网关默认值，
 *   而「思考 token 与工具调用共享这一个额度」—— 长批次（一次提交 15 条命令）会被
 *   截断成非法 JSON，runtime 按 {} 处理，看起来就像"模型乱调工具"。
 *   实测过一次的形态：一句话硬跑整片，29.8 万输入、115 秒，然后被截断。
 *
 * ★ 为什么是 8192：它是 deepseek-chat 这一档的输出上限量级；写死在【一处】，
 *   要调就调这里（或通过 ChatRequest.maxTokens 单次覆盖）。
 *   ★ 宁可视死这个数也不要"不传" —— 不传时行为取决于网关默认值，
 *     而那正是我们看不见、也无法在回执里断言的东西。
 */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * 思考强度（档位序 off < low < high < max）。
 *
 * ★ 为什么要有这个开关：**不传任何参数时 `deepseek-chat` 默认【不开思考】**。
 *   实测（2026-09，`/beta`）：不传 → 回执里没有 `reasoning_content`、usage 也不报
 *   `reasoning_tokens`；传 `reasoning_effort` → 两者都有。所以面板里的 Agent
 *   在加这个开关之前是「张嘴就答」，与「等级被调到最低」无关 —— 是**根本没开**。
 *
 * ★ 三条实测结论（都钉在 `test/reasoning.test.ts` 里）：
 *   1. 带 `tools` 时照样能思考（第一轮就先想再决定调哪个工具）；
 *   2. 历史轮次的 `reasoning_content` 要回传 —— 不回传不报错，但那一轮思考被压成 0；
 *   3. 思考模式下 `temperature` 被忽略（传了不报错）；`off` 用 `thinking:{type:'disabled'}`
 *      表达，而且它能**压过** `reasoning_effort`。
 */
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';

/** 合法档位（CLI 的白名单与这里共用一份，别各写一份）。 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'high', 'max'];

/**
 * 默认档位 = `high`。
 *
 * ★ 为什么默认开：面板里的 Agent 是给人用的「一句话改片」入口，
 *   而实测过「不开思考」的它经常会挑错字段（§0.23 的对照：同一句任务、同一份文档，
 *   开思考写进去 1 条，不开则停在提案上）。代价是约 3.7× 输出 token，
 *   所以这个值【只在一处定义】（面板服务的入口），要改就改这里或页面上那个下拉框。
 */
export const DEFAULT_REASONING: ReasoningEffort = 'high';

/** 字符串是不是合法档位（给 CLI 与 /api/chat 的参数校验用）。 */
export function isReasoningEffort(v: string): v is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(v);
}

export async function chatCompletions(req: ChatRequest): Promise<ChatReply> {
  const body: Record<string, unknown> = {
    model: req.model ?? DEFAULT_MODEL,
    messages: req.messages,
    temperature: req.temperature ?? 0,
    // ★ 显式发出去（见 DEFAULT_MAX_TOKENS）。以前这里没有这一行。
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (req.tools !== undefined) {
    body['tools'] = req.tools;
    body['tool_choice'] = req.toolChoice ?? 'auto';
  }
  // ★ off 要【显式】说出来：thinking 是独立于 reasoning_effort 的开关，
  //   服务端默认一变，不发声的 off 就会静默变成「开」。
  if (req.reasoningEffort === 'off') body['thinking'] = { type: 'disabled' };
  else if (req.reasoningEffort !== undefined) body['reasoning_effort'] = req.reasoningEffort;

  const res = await fetch(req.baseUrl ?? DEEPSEEK_BETA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + req.apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error('DeepSeek HTTP ' + res.status + ': ' + text.slice(0, 600));
  }

  const parsed = JSON.parse(text) as {
    choices?: { message?: ChatMessage; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const choice = parsed.choices?.[0];
  if (choice?.message === undefined) {
    throw new Error('DeepSeek 回执缺少 message: ' + text.slice(0, 400));
  }
  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const cachedTokens = parsed.usage?.prompt_cache_hit_tokens ?? 0;
  /**
   * ★ 缺字段时【自己算】而不是写 0：老回执 / 网关变体可能不报 miss，
   *   而 cached + uncached === promptTokens 是一条我们依赖的恒等式
   *   （否则界面上的"缓存命中占比"会变成一个说不通的数）。
   */
  const uncachedTokens =
    parsed.usage?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cachedTokens);
  return {
    message: choice.message,
    finishReason: choice.finish_reason ?? 'stop',
    usage: {
      promptTokens,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      cachedTokens,
      uncachedTokens,
      reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      // 图片张数由 runtime 数（它才知道自己往消息里塞了几帧），这里恒为 0。
      imageFrames: 0,
    },
  };
}
