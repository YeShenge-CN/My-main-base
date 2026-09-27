/**
 * 独立视觉评审（§0.28 作业 1b）。
 *
 * ★ 这一份测的都是【纯逻辑】：解析、词表白名单、抗过度修正的措辞、
 *   以及"连续两轮无改善就停"这条终止条件。真调模型的评审在别处（opt-in）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRITIC_SYSTEM_PROMPT, CRITIQUE_CODES, critiqueFrame, parseCritique } from '../src/critique';
import { critiqueStalled, judgeTurn, verdictMessage, type ToolTrace } from '../src/runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCritique：不假设模型乖乖只回 JSON', () => {
  it('干净的 JSON', () => {
    const r = parseCritique('{"verdict":"needs_work","findings":[{"code":"text_overlap","severity":"warn","detail":"两行叠在一起","fixHint":"下移"}]}');
    expect(r?.verdict).toBe('needs_work');
    expect(r?.findings).toHaveLength(1);
    expect(r?.findings[0]?.code).toBe('text_overlap');
    expect(r?.findings[0]?.fixHint).toBe('下移');
  });

  it('★ 包在 markdown 代码块里也能抠出来（实测常见）', () => {
    const r = parseCritique('这是我的评审：\n\n```json\n{"verdict":"pass","findings":[]}\n```\n以上。');
    expect(r?.verdict).toBe('pass');
    expect(r?.findings).toEqual([]);
  });

  it('词表外的 code 归到 other（评审意见必须可统计）', () => {
    const r = parseCritique('{"findings":[{"code":"我觉得不行","detail":"说不上来"}]}');
    expect(r?.findings[0]?.code).toBe('other');
  });

  it('没有 detail 的条目直接丢掉（空话不算意见）', () => {
    const r = parseCritique('{"findings":[{"code":"other"},{"code":"other","detail":"有内容"}]}');
    expect(r?.findings).toHaveLength(1);
  });

  it('★ 模型说 pass 却列了 warn —— 按 needs_work 处理（以证据为准，不以自评为准）', () => {
    const r = parseCritique('{"verdict":"pass","findings":[{"code":"low_contrast","severity":"warn","detail":"灰字压深底"}]}');
    expect(r?.verdict).toBe('needs_work');
  });

  it('只有 info 级意见时仍算 pass（别把"可以更好"变成"必须改"）', () => {
    const r = parseCritique('{"findings":[{"code":"layout_unbalanced","severity":"info","detail":"右边略空"}]}');
    expect(r?.verdict).toBe('pass');
  });

  it('抠不出 JSON 时返回 null（调用方要如实报 unparsed，不能当"没问题"）', () => {
    expect(parseCritique('画面挺好的')).toBeNull();
    expect(parseCritique('{坏 JSON')).toBeNull();
  });

  it('★ 词表本身是封闭的：每条判据都要在提示词里出现过', () => {
    for (const code of CRITIQUE_CODES) {
      expect(CRITIC_SYSTEM_PROMPT, code).toContain(code);
    }
  });

  it('★ 抗过度修正：提示词必须明说"没问题就回 pass 且 findings 为空"', () => {
    expect(CRITIC_SYSTEM_PROMPT).toContain('findings 为空');
    expect(CRITIC_SYSTEM_PROMPT).toContain('不要为了显得有用而硬找问题');
  });
});

describe('critiqueFrame：看的就是那一帧，且用量记账', () => {
  it('把帧当图片发出去，并把评审用量与图片帧数报回来', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '{"verdict":"needs_work","findings":[{"code":"text_clipped","severity":"error","detail":"标题右半出画"}]}' } }],
            usage: { prompt_tokens: 500, completion_tokens: 40, prompt_cache_hit_tokens: 100 },
          }),
      } as unknown as Response;
    });
    const result = await critiqueFrame({ apiKey: 'k', pngBase64: 'AAA', intent: '一屏只讲正弦' });
    expect(result.verdict).toBe('needs_work');
    expect(result.findings).toHaveLength(1);
    expect(result.unparsed).toBe(false);
    // ★ 图片帧数单独记（评审确实看了 1 帧）
    expect(result.usage.imageFrames).toBe(1);
    expect(result.usage.promptTokens).toBe(500);
    // 评审【不开思考】：它是看一眼就下结论的活
    expect(bodies[0]?.['thinking']).toEqual({ type: 'disabled' });
    // 意图要真的送到评审眼前（它看不见我们的对话）
    expect(JSON.stringify(bodies[0]?.['messages'])).toContain('一屏只讲正弦');
    expect(JSON.stringify(bodies[0]?.['messages'])).toContain('data:image/png;base64,AAA');
  });

  it('★ 回执读不懂时如实报 unparsed，并把原话带回来', async () => {
    vi.stubGlobal('fetch', async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: '我觉得还行吧' } }], usage: {} }),
      }) as unknown as Response);
    const result = await critiqueFrame({ apiKey: 'k', pngBase64: 'AAA' });
    expect(result.unparsed).toBe(true);
    expect(result.raw).toContain('还行');
  });
});

/* ── 终止条件：连续两轮无改善就停 ───────────────────────────── */

function critiqueTrace(counts: readonly number[]): ToolTrace[] {
  return counts.map((n, i) => ({
    turn: i + 1,
    name: 'critique_frame',
    args: { t: 0 },
    result: JSON.stringify({ findings: Array.from({ length: n }, () => ({ code: 'other', detail: 'x' })) }),
    imageCount: 1,
  }));
}

describe('critiqueStalled：连续两轮无改善就停', () => {
  it('少于三次评审不判定（样本不够）', () => {
    expect(critiqueStalled(critiqueTrace([2, 2]))).toBeNull();
  });

  it('★ 三次评审、问题数不降 → 停，并报出还剩几项', () => {
    expect(critiqueStalled(critiqueTrace([3, 3, 3]))).toBe(3);
    expect(critiqueStalled(critiqueTrace([3, 4, 5]))).toBe(5);
  });

  it('有改善就不停（哪怕只有一项）', () => {
    expect(critiqueStalled(critiqueTrace([3, 3, 2]))).toBeNull();
  });

  it('已经干净了不归这条管（那是"做完了"，不是"卡住了"）', () => {
    expect(critiqueStalled(critiqueTrace([0, 0, 0]))).toBeNull();
  });

  it('judgeTurn 把它变成一次带数字的收尾', () => {
    const trace = critiqueTrace([2, 2, 2]);
    const verdict = judgeTurn({
      trace,
      turn: 3,
      issueCount: 2,
      prev: { wrotePrevTurn: true, cleanTurns: 0 },
      stopRequested: false,
      noToolCalls: false,
      // 评审本来就要渲染一帧，所以「看过画面」这件事在它这条路上天然成立
      sawFrame: true,
      canStillRender: true,
    });
    expect(verdict.kind).toBe('finish');
    if (verdict.kind !== 'finish') return;
    expect(verdict.reason).toBe('critique_stalled');
    expect(verdict.unresolved).toBe(2);
    // ★ 收尾话术必须如实说出"还有 N 项没达标"
    expect(verdictMessage(verdict.reason, true, verdict.unresolved)).toContain('还有 2 项没达标');
  });
});
