/**
 * §0.28 作业 1c：**不看画面就不许收尾**，以及收尾话术必须如实。
 *
 * ★ 为什么这两件事放在一份测试里：它们是同一条要求的两个面 ——
 *   「强制看」解决"没校对就交"，"如实说"解决"没做完却看起来像做完了"。
 *   两条都是**纯逻辑**，所以都能在毫秒级、无网络、确定性的条件下测，
 *   不必真调一次模型才知道对不对（这正是 §0.28 作业 1 反复强调的判据要求）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJournal, type SceneDoc } from '@sva/engine-core';
import { BudgetTracker } from '../src/budget';
import { finishReport, runShot } from '../src/runtime';
import { dispatchTool, type ToolContext } from '../src/tools';

afterEach(() => {
  vi.unstubAllGlobals();
});

function docWithPlot(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] }],
    objects: {
      'plot#1': {
        shape: 'plot2d',
        owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
        params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
        style: { stroke: { v: '#4ea1ff' }, width: { v: 3 } },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function makeCtx(): { ctx: ToolContext; budget: BudgetTracker } {
  const journal = createJournal(docWithPlot(), { now: () => 0 });
  const budget = new BudgetTracker('shot-1');
  const ctx: ToolContext = {
    doc: () => journal.currentDoc(),
    journal,
    budget,
    baseVersion: () => journal.currentVersion(),
    turnId: 'shot-1',
    render: (_d, ts) => ts.map((t) => ({ t, pngBase64: 'AAA', sha256: 'deadbeef' })),
    now: () => 0,
  };
  return { ctx, budget };
}

describe('finish_shot 的关卡：没看过画面就不许收尾', () => {
  it('★ 一次都没看过 → 被拒，而且【不算收尾】（finished 不为 true）', async () => {
    const { ctx } = makeCtx();
    const out = await dispatchTool('finish_shot', { summary: '做完了' }, ctx);
    expect(out.finished).not.toBe(true);
    const parsed = JSON.parse(out.text) as { error?: string; message?: string };
    expect(parsed.error).toBe('look_before_finish');
    // 话术必须可执行：告诉它下一步做什么，而不是只说"不行"
    expect(parsed.message).toContain('get_render_state');
  });

  /**
   * ★★★ 这一条是【真调模型】才发现的（见 budget.ts 文件头）：
   *   第一版把 get_render_state 也算"看过"，于是真机跑出来的工具序列里
   *   **render_frames 一次都没有、0 张图**，而它照样干净收尾了 ——
   *   只要有一条便宜的路能过关，模型一定走便宜的那条。
   *   而"闭着眼睛画"正是这一轮要治的病，所以关卡收紧成"必须真的渲染过一帧"。
   */
  it('★ 只调 get_render_state 【不放行】（它只是文字，不是画面）', async () => {
    const { ctx } = makeCtx();
    await dispatchTool('get_render_state', { t: 0 }, ctx);
    const out = await dispatchTool('finish_shot', { summary: '看过了' }, ctx);
    expect(out.finished).not.toBe(true);
    expect((JSON.parse(out.text) as { error?: string }).error).toBe('look_before_finish');
    // 但它确实被记下来了：收尾回执里两个数分开报
    expect(ctx.budget.lookRecord()).toEqual({ frames: 0, states: 1 });
  });

  it('★ 额度不足以渲染任何一帧时【放行】（否则会困死在轮数上限里），且如实报"从未渲染过"', async () => {
    const { ctx } = makeCtx();
    (ctx as { budget: unknown }).budget = new (Object.getPrototypeOf(ctx.budget).constructor)('shot-1', {
      maxFramesPerCall: 6,
      maxImages: 0,
      maxRenderCalls: 1,
    });
    const out = await dispatchTool('finish_shot', { summary: '渲染不了' }, ctx);
    expect(out.finished).toBe(true);
    expect((JSON.parse(out.text) as { lookedFrame?: boolean }).lookedFrame).toBe(false);
  });

  /**
   * ★★ 真机跑出来的：maxImages=0 那一轮模型压根没走到 finish_shot，
   *   它是被 Runtime 的兜底规则收的尾 —— 所以「没看过画面」的警告必须挂在
   *   【所有收尾路径的共同下游】（runShot 末尾），而不是只写在 finish_shot 的回执里。
   */
  it('★ 走【兜底收尾】时也要如实说没渲染过（警告挂在共同下游）', async () => {
    const { ctx } = makeCtx();
    vi.stubGlobal('fetch', async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '我想想' }, finish_reason: 'stop' }],
            usage: {},
          }),
      }) as unknown as Response);
    const result = await runShot({ apiKey: 'k', task: '看看', ctx });
    expect(result.finished).toBe(true);
    expect(result.finalMessage).toContain('从未渲染过一帧');
  });

  it('render_frames 之后放行', async () => {
    const { ctx } = makeCtx();
    await dispatchTool('render_frames', { timestamps: [0] }, ctx);
    const out = await dispatchTool('finish_shot', { summary: '看过了' }, ctx);
    expect(out.finished).toBe(true);
  });

  it('★ 被预算拒绝的 render_frames【不算】看过（拒绝就是拒绝）', async () => {
    const { ctx } = makeCtx();
    const tooMany = Array.from({ length: 99 }, (_, i) => i);
    const rejected = await dispatchTool('render_frames', { timestamps: tooMany }, ctx);
    expect(JSON.parse(rejected.text).error).toBeDefined();
    expect(ctx.budget.hasRenderedFrame()).toBe(false);
    const out = await dispatchTool('finish_shot', { summary: '想蒙过去' }, ctx);
    expect(out.finished).not.toBe(true);
  });

  it('收尾回执里带上"看过的方式"，便于诊断', async () => {
    const { ctx } = makeCtx();
    await dispatchTool('render_frames', { timestamps: [0] }, ctx);
    await dispatchTool('get_render_state', { t: 1 }, ctx);
    const out = await dispatchTool('finish_shot', { summary: 'ok' }, ctx);
    expect((JSON.parse(out.text) as { looked: unknown }).looked).toEqual({ frames: 1, states: 1 });
  });
});

describe('critique_frame 走同一套预算与"看过"记账', () => {
  it('宿主没注入评审时如实说不可用（不假装评审过了）', async () => {
    const { ctx } = makeCtx();
    const out = await dispatchTool('critique_frame', { t: 0 }, ctx);
    expect((JSON.parse(out.text) as { error?: string }).error).toBe('critique_unavailable');
    expect(ctx.budget.hasRenderedFrame()).toBe(false);
  });

  it('★ 注入评审后：渲染 1 帧、花 1 张额度、算看过、把 findings 带回来', async () => {
    const { ctx, budget } = makeCtx();
    const seen: { t: number; png: string; intent?: string }[] = [];
    (ctx as { critique?: unknown }).critique = async (req: {
      t: number;
      pngBase64: string;
      intent?: string;
    }) => {
      seen.push({ t: req.t, png: req.pngBase64, ...(req.intent === undefined ? {} : { intent: req.intent }) });
      return {
        findings: [{ code: 'text_overlap' as const, severity: 'warn' as const, detail: '压住了' }],
        verdict: 'needs_work' as const,
        raw: '{}',
        unparsed: false,
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          cachedTokens: 0,
          uncachedTokens: 1,
          reasoningTokens: 0,
          imageFrames: 1,
        },
      };
    };
    const out = await dispatchTool('critique_frame', { t: 2.5, intent: '讲正弦' }, ctx);
    const parsed = JSON.parse(out.text) as { verdict?: string; findings?: unknown[] };
    expect(parsed.verdict).toBe('needs_work');
    expect(parsed.findings).toHaveLength(1);
    expect(seen[0]?.t).toBe(2.5);
    expect(seen[0]?.intent).toBe('讲正弦');
    // 评审看的就是那一帧：主 Agent 也拿到同一张图
    expect(out.images).toHaveLength(1);
    expect(budget.remaining().imagesUsed).toBe(1);
    // 评审要的那一帧也是真的渲染 —— 所以它同样解锁收尾关卡
    expect(budget.hasRenderedFrame()).toBe(true);
  });
});

describe('收尾话术必须如实（不许看起来像成功）', () => {
  it('没有未决问题时，明说"已无未决问题"', () => {
    const text = finishReport(JSON.stringify({ status: 'finished', summary: '画好了', unresolved: 0 }));
    expect(text).toContain('画好了');
    expect(text).toContain('已无未决问题');
    expect(text).not.toContain('没达标');
  });

  it('★ 还有未决问题时，必须说出「还有 N 项没达标」并点名代码', () => {
    const text = finishReport(
      JSON.stringify({
        status: 'finished',
        summary: '尽力了',
        unresolved: 3,
        unresolvedCodes: ['text_overlap', 'text_too_small', 'object_offscreen'],
      }),
    );
    expect(text).toContain('还有 3 项没达标');
    expect(text).toContain('text_overlap');
    expect(text).toContain('不算完成');
  });

  it('回执缺字段时按"没有未决问题"处理（老回执不至于被读成失败）', () => {
    expect(finishReport(JSON.stringify({ status: 'finished', summary: 'x' }))).toContain('已无未决问题');
  });

  it('回执不是 JSON 时原样带出去（宁可难看，也不要吞信息）', () => {
    expect(finishReport('boom')).toBe('boom');
  });
});
