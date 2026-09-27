/**
 * token 拆账 + 输出上限（第二十九轮）。
 *
 * ★ 为什么值得单独一份测试：§0.28 三 ⑥ 说得很直白 —— **我们从来没传过 max_tokens**，
 *   于是"思考 token 与工具调用共享一个看不见的额度"，长批次被截断成非法 JSON 之后
 *   看起来就像"模型乱调工具"。这类缺陷的症状与根因离得极远，
 *   唯一划算的防线是把它写成毫秒级的结构断言。
 *
 * ★ 同样地，回执里本来就有缓存命中 / 思考 token 两个数，而它们【从来没被记下来】——
 *   作业 3 的「钱花在哪」需要它们，所以这里把解析与累加都钉住。
 *
 * 全程 stub 掉 fetch：这一份不打网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneDoc } from '@sva/engine-core';
import { addUsage, chatCompletions, DEFAULT_MAX_TOKENS, emptyUsage } from '../src/deepseek';
import { runOneShot } from '../src/run';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(replies: readonly unknown[]): { readonly bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) } as unknown as Response;
  });
  return { bodies };
}

const ONE_TURN = { messages: [{ role: 'user' as const, content: '你好' }] };

describe('输出上限 max_tokens 必须显式发出去', () => {
  it('★ 不传也要发 —— 默认值由我们决定，不由网关决定', async () => {
    const rec = stubFetch([{ choices: [{ message: { role: 'assistant', content: '好' } }], usage: {} }]);
    await chatCompletions({ apiKey: 'k', ...ONE_TURN });
    expect(rec.bodies[0]?.['max_tokens']).toBe(DEFAULT_MAX_TOKENS);
  });

  it('调用方可以单次覆盖（CLI / 面板将来要能调它）', async () => {
    const rec = stubFetch([{ choices: [{ message: { role: 'assistant', content: '好' } }], usage: {} }]);
    await chatCompletions({ apiKey: 'k', maxTokens: 512, ...ONE_TURN });
    expect(rec.bodies[0]?.['max_tokens']).toBe(512);
  });
});

describe('usage 解析：缓存与思考都要留下来', () => {
  it('★ 缓存命中 / 未命中 / 思考 token 三个数都解析出来', async () => {
    stubFetch([
      {
        choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 300,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 200,
          completion_tokens_details: { reasoning_tokens: 220 },
        },
      },
    ]);
    const reply = await chatCompletions({ apiKey: 'k', ...ONE_TURN });
    expect(reply.usage).toEqual({
      promptTokens: 1000,
      completionTokens: 300,
      cachedTokens: 800,
      uncachedTokens: 200,
      reasoningTokens: 220,
      imageFrames: 0,
    });
  });

  it('网关不报 miss 时自己算，保住 cached + uncached === promptTokens', async () => {
    stubFetch([
      {
        choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 10, prompt_cache_hit_tokens: 480 },
      },
    ]);
    const reply = await chatCompletions({ apiKey: 'k', ...ONE_TURN });
    expect(reply.usage.uncachedTokens).toBe(20);
    expect(reply.usage.cachedTokens + reply.usage.uncachedTokens).toBe(reply.usage.promptTokens);
  });

  it('addUsage 逐字段相加（散落的 a += b 会漏掉新字段）', () => {
    const a = { ...emptyUsage(), promptTokens: 1, completionTokens: 2, cachedTokens: 3, uncachedTokens: 4, reasoningTokens: 5, imageFrames: 6 };
    const b = { ...emptyUsage(), promptTokens: 10, completionTokens: 20, cachedTokens: 30, uncachedTokens: 40, reasoningTokens: 50, imageFrames: 60 };
    expect(addUsage(a, b)).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      cachedTokens: 33,
      uncachedTokens: 44,
      reasoningTokens: 55,
      imageFrames: 66,
    });
  });
});

/* ── 图片帧数：由 runtime 数（API 不知道我们塞了几张图）────── */

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

function toolCall(name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

describe('runtime 把图片帧数单独记下来', () => {
  it('★ render_frames 的帧数进 usage.imageFrames（它已含在 promptTokens 里，不重复相加）', async () => {
    stubFetch([toolCall('render_frames', { timestamps: [0, 4] }), { choices: [{ message: { role: 'assistant', content: '看过了' }, finish_reason: 'stop' }], usage: { prompt_tokens: 700, completion_tokens: 30 } }]);
    const result = await runOneShot({
      apiKey: 'k',
      task: '看一眼',
      doc: emptyShot(),
      render: (_d, ts) => ts.map((t) => ({ t, pngBase64: 'AAA', sha256: 'deadbeef' })),
    });
    expect(result.run.usage.imageFrames).toBe(2);
    // 两轮各自的输入相加，图片的 token 不在里面另算
    expect(result.run.usage.promptTokens).toBe(800);
  });
});
