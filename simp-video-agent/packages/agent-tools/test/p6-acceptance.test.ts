import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createJournal, type SceneDoc } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node';
import { BudgetTracker, DEFAULT_LIMITS, type BudgetLimits } from '../src/budget';
import { runShot } from '../src/runtime';
import { dispatchTool, type ToolContext } from '../src/tools';

/**
 * P6 验收：一个镜头端到端跑通，预算耗尽时报错而非静默继续。
 *
 * 这是真调用 DeepSeek 的验收，默认跳过（普通 pnpm test 不该打网络）：
 *   SVA_ACCEPTANCE=1 pnpm test
 */
const ENABLED = process.env['SVA_ACCEPTANCE'] === '1';

function apiKey(): string {
  const raw = readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  if (line === undefined) throw new Error('缺少 DEEPSEEK_API_KEY');
  return line.slice('DEEPSEEK_API_KEY='.length).trim();
}

function emptyShot(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [] }],
    objects: {},
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function makeCtx(limits: BudgetLimits = DEFAULT_LIMITS): ToolContext {
  const journal = createJournal(emptyShot(), { now: () => 1_700_000_000_000 });
  const budget = new BudgetTracker('shot-1', limits);
  let clock = 1_700_000_000_000;
  return {
    doc: () => journal.currentDoc(),
    journal,
    budget,
    baseVersion: () => journal.currentVersion(),
    turnId: 'turn-1',
    render: (d, ts) =>
      renderFrames(d, ts).map((f) => ({
        t: f.t,
        pngBase64: f.png.toString('base64'),
        sha256: f.sha256,
      })),
    now: () => (clock += 1000),
  };
}

const TASK = [
  '这个镜头（12 秒，16:9 世界，坐标原点在画面中心）要展示一条曲线。',
  '要求：',
  '1. 曲线是 y = sin(x)，x 从 -7 到 7；',
  '2. 用 drawOn 效果让它在第 1 秒开始、用 2 秒生长出来（按弧长 arc 方式）；',
  '3. 然后用 camera_preset 的 pushIn 推近这条曲线 3 秒。',
  '做完之后渲染一帧看看（建议 t=4），并告诉我这条曲线在画面上的大致位置。',
].join('\n');

describe.skipIf(!ENABLED)('P6 验收：一个镜头端到端', () => {
  it(
    'Read → Command → Validate → Render Feedback 全程跑通',
    async () => {
      const ctx = makeCtx();
      const result = await runShot({ apiKey: apiKey(), task: TASK, ctx, maxTurns: 10 });

      const names = result.trace.map((t) => t.name);
      console.log('[P6] 轮数=' + result.turns + ' 工具序列=' + JSON.stringify(names) + ' 预算=' + JSON.stringify(result.budget));

      expect(names).toContain('apply_commands');
      /**
       * ★★ 第二十九轮起这条不只是"期望"，而是【引擎强制的】：
       *   finish_shot 要求这一镜真的渲染过至少一帧（get_render_state 不算）。
       *   第一版没这条硬要求时，真机跑出来的序列里 render_frames 是 0 次 ——
       *   模型用便宜的那条路过了关，然后闭着眼睛交稿。
       */
      expect(names, '模型必须真的渲染过一帧：' + JSON.stringify(names)).toContain('render_frames');

      const doc = ctx.doc();
      const ids = Object.keys(doc.objects);
      expect(ids.length).toBeGreaterThan(0);
      expect(doc.effects !== undefined).toBe(true);
      expect(Object.keys(doc.effects).length).toBeGreaterThan(0);

      // 相机被推近过
      expect(doc.camera.keys.length).toBeGreaterThan(1);

      // 渲染过至少一帧，且预算被记账
      expect(result.budget.imagesUsed).toBeGreaterThan(0);
      expect(result.budget.imagesLeft).toBeLessThan(DEFAULT_LIMITS.maxImages);

      // 每个 turn 结束都置了 settled：没有遗留在 pending 的 compound
      const pending = ctx.journal.compounds().filter((c) => c.turnId === 'turn-1' && !c.settled);
      expect(pending).toEqual([]);
    },
    180_000,
  );

  it(
    '预算耗尽时报错而非静默继续',
    async () => {
      // 把本镜额度压到 0：第一次渲染就该被拒
      const limits: BudgetLimits = { ...DEFAULT_LIMITS, maxImages: 0, maxRenderCalls: 1 };
      const ctx = makeCtx(limits);

      const first = await dispatchTool('render_frames', { timestamps: [0] }, ctx);
      expect(first.text).toContain('L2_images_exhausted');
      expect(first.images).toBeUndefined();
      expect(ctx.budget.remaining().imagesUsed).toBe(0);

      // 端到端跑一遍：用与验收 1 相同的任务（实测必然走到 render_frames），
      // 但本镜图片额度为 0 —— 模型即便被拒，也必须拿到明确回执。
      const result = await runShot({
        apiKey: apiKey(),
        task: TASK,
        ctx,
        maxTurns: 8,
      });
      const renderAttempts = result.trace.filter((t) => t.name === 'render_frames');
      // ★ 每一次尝试都必须拿到明确回执（而不是静默降级）
      for (const attempt of renderAttempts) {
        expect(attempt.imageCount).toBe(0);
        expect(attempt.result).toContain('L2_images_exhausted');
      }
      // 预算【没有】被静默消耗
      expect(ctx.budget.remaining().imagesUsed).toBe(0);
      /**
       * ★★ 第二十九轮的新契约：额度连一帧都渲染不起时，收尾关卡会【放行】
       *   （否则模型会被困死在轮数上限里），但收尾话术必须如实说"从未渲染过一帧"。
       *   这一条同时守住了"不能不看就交"与"不能把模型困死"两件事。
       */
      if (result.finished) {
        expect(result.finalMessage).toContain('从未渲染过一帧');
      }
    },
    180_000,
  );
});

describe.skipIf(ENABLED)('P6 验收（未启用）', () => {
  it('默认跳过，需要 SVA_ACCEPTANCE=1 才会真调 DeepSeek', () => {
    expect(ENABLED).toBe(false);
  });
});
