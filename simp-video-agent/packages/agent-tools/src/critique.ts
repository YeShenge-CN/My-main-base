/**
 * 独立视觉评审（第二十九轮，§0.28 作业 1b）。
 *
 * ★★ 为什么要【独立一次调用】，而不是让主 Agent 自己评价自己：
 *   画家与评审若是同一次对话，它会自洽地放过自己的问题 ——
 *   这不是猜测，是这个项目里反复出现的一类失败（"结构断言全绿，画面里 2π 却是豆腐块"）。
 *   所以这里换一条系统提示、换一个身份、只看这一帧，回一份**结构化**的清单。
 *
 * ★ 三件事它【不做】：
 *   1. 不改文档 —— 它只产出意见，写入仍然只有 applyCommand 一条路（铁律 2）；
 *   2. 不猜意图 —— 意图由调用方（工具参数里的 intent）显式给出；
 *   3. 不硬找问题 —— 提示词里明确要求"没问题就回 pass 且 findings 为空"。
 *      防过度修正是 §0.28 作业 1 的验收第 2 条：已经合格时不许瞎改。
 */
import { addUsage, chatCompletions, emptyUsage, type TokenUsage } from './deepseek';

/** 评审可以用的判据词表。★ 固定词表 = 让"评审意见"变成可统计、可断言的东西。 */
export const CRITIQUE_CODES = [
  'text_overlap',
  'text_too_small',
  'text_clipped',
  'text_off_center',
  'low_contrast',
  'too_crowded',
  'unclear_focus',
  'color_mismatch',
  'layout_unbalanced',
  'other',
] as const;

export type CritiqueCode = (typeof CRITIQUE_CODES)[number];

export interface CritiqueFinding {
  readonly code: CritiqueCode;
  readonly severity: 'error' | 'warn' | 'info';
  readonly detail: string;
  readonly fixHint?: string;
}

export interface CritiqueResult {
  readonly findings: readonly CritiqueFinding[];
  /** pass = 评审认为这一帧可以交付。 */
  readonly verdict: 'pass' | 'needs_work';
  /** 评审的原话（诊断用）。★ 解析失败时它是唯一的线索，不要丢。 */
  readonly raw: string;
  /** 回执不是合法 JSON 时为 true —— 如实报出来，不要假装评审成功了。 */
  readonly unparsed: boolean;
  readonly usage: TokenUsage;
}

export const CRITIC_SYSTEM_PROMPT = [
  '你是一个动画画面的【独立评审】。你没有参与创作，只对这一帧负责。',
  '你会看到：一帧渲染画面，以及作者声称的意图。',
  '',
  '你的任务是找出【观众一眼就会觉得不对】的地方。只报你真的在这张图上看到的。',
  '',
  '可用判据（code 只能从这里选）：',
  '  text_overlap      两块文字/公式压在一起，读不清',
  '  text_too_small    字号小到读不出来',
  '  text_clipped      文字/公式被画面边缘裁掉',
  '  text_off_center   主体明显偏离视觉中心或该在的位置',
  '  low_contrast      文字与背景对比度不够，看不清',
  '  too_crowded       同一屏东西太多，没有重点',
  '  unclear_focus     看不出这一屏想让人看什么',
  '  color_mismatch    配色与意图不符（例如"强调"用了和背景一样的颜色）',
  '  layout_unbalanced 构图明显失衡（全部挤在一边、大片空白）',
  '  other             以上都不是，但在 detail 里说清楚',
  '',
  '★ 三条硬要求：',
  '1. **没看到问题就回 pass 且 findings 为空。** 不要为了显得有用而硬找问题 ——',
  '   作者会照着你的意见去改，改坏一份本来合格的画面比漏报一条更糟。',
  '2. 只报【看得见】的：不要推测代码、不要评论你没法从这一帧判断的事。',
  '3. 每条 detail 要具体到"哪里、什么样"（例如"右下角的注释与坐标轴标签叠在一起"），',
  '   并且 fixHint 要是可执行的（"把标注下移到 y=-3.9"而不是"调整一下布局"）。',
  '',
  '只输出 JSON，不要任何解释文字、不要 markdown 代码块：',
  '{"verdict":"pass|needs_work","findings":[{"code":"…","severity":"error|warn|info","detail":"…","fixHint":"…"}]}',
].join('\n');

export interface CritiqueRequest {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** 已渲染好的那一帧（PNG base64）。工具层渲染一次，评审与主 Agent 看同一张图。 */
  readonly pngBase64: string;
  /** 作者声称的意图。评审必须知道"本来想做成什么样"才能判断"做得对不对"。 */
  readonly intent?: string;
  /** 调用方额外想让它检查的项。 */
  readonly checklist?: readonly string[];
}

function asSeverity(v: unknown): CritiqueFinding['severity'] {
  return v === 'error' || v === 'warn' ? v : 'info';
}

function asCode(v: unknown): CritiqueCode {
  const s = typeof v === 'string' ? v : '';
  return (CRITIQUE_CODES as readonly string[]).includes(s) ? (s as CritiqueCode) : 'other';
}

/**
 * 从模型的自由文本里抠出那份 JSON。
 *
 * ★ 不假设它乖乖只回 JSON：实测里模型常常包一层 markdown 代码块，
 *   或者在 JSON 前后写一句"这是我的评审"。抠不出来就如实报 unparsed ——
 *   **最坏的失败是"看起来评审过了"**（坑表里 MathJax 那条的同一族）。
 */
export function parseCritique(
  text: string,
): { verdict: 'pass' | 'needs_work'; findings: CritiqueFinding[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { verdict?: unknown; findings?: unknown };
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: CritiqueFinding[] = [];
  for (const f of rawFindings) {
    if (f === null || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const detail = typeof o['detail'] === 'string' ? o['detail'].trim() : '';
    if (detail === '') continue;
    const hint = typeof o['fixHint'] === 'string' ? o['fixHint'].trim() : '';
    findings.push({
      code: asCode(o['code']),
      severity: asSeverity(o['severity']),
      detail,
      ...(hint === '' ? {} : { fixHint: hint }),
    });
  }
  // verdict 以 findings 为准：模型说 pass 却列了 warn/error，那按 needs_work 处理。
  const derived: 'pass' | 'needs_work' =
    obj.verdict === 'needs_work' || findings.some((f) => f.severity !== 'info')
      ? 'needs_work'
      : 'pass';
  return { verdict: derived, findings };
}

export async function critiqueFrame(req: CritiqueRequest): Promise<CritiqueResult> {
  const intentLines: string[] = [];
  if (req.intent !== undefined && req.intent.trim() !== '') {
    intentLines.push('作者声称的意图：' + req.intent.trim());
  }
  if (req.checklist !== undefined && req.checklist.length > 0) {
    intentLines.push('作者希望你特别检查：' + req.checklist.join('；'));
  }
  const reply = await chatCompletions({
    apiKey: req.apiKey,
    ...(req.model === undefined ? {} : { model: req.model }),
    ...(req.baseUrl === undefined ? {} : { baseUrl: req.baseUrl }),
    // ★ 评审【不开思考】：它是看一眼就下结论的活，开思考只会让每一帧都贵 3.7 倍。
    reasoningEffort: 'off',
    messages: [
      { role: 'system', content: CRITIC_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              (intentLines.length === 0
                ? '作者没有给出意图，只按"观众看不看得懂"来评。'
                : intentLines.join('\n')) + '\n\n下面这一帧：',
          },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + req.pngBase64 } },
        ],
      },
    ],
  });

  const raw = typeof reply.message.content === 'string' ? reply.message.content : '';
  const usage = addUsage(emptyUsage(), { ...reply.usage, imageFrames: 1 });
  const parsed = parseCritique(raw);
  if (parsed === null) {
    return { findings: [], verdict: 'needs_work', raw, unparsed: true, usage };
  }
  return { findings: parsed.findings, verdict: parsed.verdict, raw, unparsed: false, usage };
}
