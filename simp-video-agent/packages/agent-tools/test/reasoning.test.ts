/**
 * 思考模式（`--reasoning`）：把「模型到底想不想」这条契约写成可执行断言。
 *
 * ★ 为什么值得单独一份测试：这个开关的默认值是【不开】，而「不开」与「开了但没生效」
 *   在界面上长得一模一样 —— 都看不出模型有没有想过。所以三件事必须被钉住：
 *   1. 不传 → 请求体里【一个字段都没有】（默认行为逐字不变）；
 *   2. off → 显式 `thinking:{type:'disabled'}`（它能压过 reasoning_effort，实测过）；
 *   3. 带 tools 的多轮里，assistant 的 `reasoning_content` 要**原样回传** ——
 *      不回传不报错，只是那一轮思考被静默压成 0。
 *
 * ★ 全程 stub 掉 fetch：这一份【不打网络】（真调模型的验收在 p6 / stress / multi-shot 里，
 *   由 SVA_ACCEPTANCE=1 打开）。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJournal, type SceneDoc } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node';
import { BudgetTracker, DEFAULT_LIMITS, enforceContextBudget } from '../src/budget';
import {
  chatCompletions,
  isReasoningEffort,
  REASONING_EFFORTS,
} from '../src/deepseek';
import { resolveRequestedReasoning, startPanelServer } from '../src/panel-server';
import { runShot } from '../src/runtime';
import type { ToolContext } from '../src/tools';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Recorded {
  readonly bodies: Record<string, unknown>[];
}

/** 把 fetch 换成「记下请求体、按顺序回放回执」。 */
function stubFetch(replies: readonly unknown[]): Recorded {
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

function answer(content: string, reasoning?: string): unknown {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content,
        ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const ONE_TURN = { messages: [{ role: 'user' as const, content: '你好' }] };

describe('请求体：思考强度怎么发（这条决定了「默认没变」）', () => {
  it('★ 不传 reasoningEffort → 请求体里既没有 reasoning_effort 也没有 thinking', async () => {
    const rec = stubFetch([answer('好')]);
    await chatCompletions({ apiKey: 'k', ...ONE_TURN });
    const body = rec.bodies[0];
    expect(body).toBeDefined();
    expect(Object.keys(body ?? {})).not.toContain('reasoning_effort');
    expect(Object.keys(body ?? {})).not.toContain('thinking');
    // 这一条是「默认行为逐字不变」的证据：连 temperature 都还是老样子
    expect(body?.['temperature']).toBe(0);
  });

  it('★ off → 显式 thinking.disabled（而不是「什么都不发」）', async () => {
    const rec = stubFetch([answer('好')]);
    await chatCompletions({ apiKey: 'k', reasoningEffort: 'off', ...ONE_TURN });
    expect(rec.bodies[0]?.['thinking']).toEqual({ type: 'disabled' });
    expect(rec.bodies[0]?.['reasoning_effort']).toBeUndefined();
  });

  it.each(['low', 'high', 'max'] as const)('%s → reasoning_effort 原样透传', async (effort) => {
    const rec = stubFetch([answer('好')]);
    await chatCompletions({ apiKey: 'k', reasoningEffort: effort, ...ONE_TURN });
    expect(rec.bodies[0]?.['reasoning_effort']).toBe(effort);
    expect(rec.bodies[0]?.['thinking']).toBeUndefined();
  });

  it('档位白名单只有这四个，别的字符串一律不认', () => {
    expect([...REASONING_EFFORTS]).toEqual(['off', 'low', 'high', 'max']);
    expect(isReasoningEffort('xhigh')).toBe(false);
    expect(isReasoningEffort('HIGH')).toBe(false);
  });
});

describe('回执：思考链要活着穿过来', () => {
  it('★ reasoning_content 必须留在 assistant 消息里（下一轮要回传它）', async () => {
    stubFetch([answer('正弦定理是……', '先想一下：用户要的是定义。')]);
    const reply = await chatCompletions({ apiKey: 'k', ...ONE_TURN });
    expect(reply.message.reasoning_content).toBe('先想一下：用户要的是定义。');
  });

  it('★ 图片预算折叠（唯一会重建消息的地方）不许把 reasoning_content 弄丢', () => {
    const messages = [
      { role: 'assistant' as const, content: '看', reasoning_content: '我要看一眼', tool_calls: [] },
      {
        role: 'user' as const,
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
        ],
      },
    ];
    const out = enforceContextBudget(messages, 1);
    expect(out.summarized).toBe(1);
    expect(out.messages[0]?.['reasoning_content']).toBe('我要看一眼');
  });
});

/* ── 端到端（仍然不打网络）：多轮工具调用里，思考有没有延续 ──── */

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

function makeCtx(): ToolContext {
  const journal = createJournal(emptyShot(), { now: () => 1_700_000_000_000 });
  return {
    doc: () => journal.currentDoc(),
    journal,
    budget: new BudgetTracker('shot-1', DEFAULT_LIMITS),
    baseVersion: () => journal.currentVersion(),
    turnId: 'turn-1',
    render: (d, ts) =>
      renderFrames(d, ts).map((f) => ({ t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 })),
    now: () => 1_700_000_000_000,
  };
}

/** 第一轮：带思考地决定调工具。第二轮：收尾。 */
function twoTurns(): unknown[] {
  return [
    {
      choices: [{
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: '先看看场景里有什么。',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_scene_summary', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    },
    answer('场景是空的。'),
  ];
}

function assistantHistoryOf(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const messages = body?.['messages'];
  if (!Array.isArray(messages)) return undefined;
  return (messages as Record<string, unknown>[]).find(
    (m) => m['role'] === 'assistant' && m['reasoning_content'] !== undefined,
  );
}

describe('多轮工具调用：思考链要回传（不然第二轮就「失忆」）', () => {
  it('★ 第二轮的请求里，助手那条消息带着第一轮的 reasoning_content', async () => {
    const rec = stubFetch(twoTurns());
    await runShot({ apiKey: 'k', task: '看看场景', ctx: makeCtx(), reasoningEffort: 'high' });
    expect(rec.bodies).toHaveLength(2);
    const carried = assistantHistoryOf(rec.bodies[1]);
    expect(carried?.['reasoning_content']).toBe('先看看场景里有什么。');
    // 而且 tool_calls 与 reasoning_content 在【同一条】消息里（回传是成对的）
    expect(Array.isArray(carried?.['tool_calls'])).toBe(true);
  });

  it('★ 每一轮都带 reasoning_effort；不传时每一轮都不带', async () => {
    const on = stubFetch(twoTurns());
    await runShot({ apiKey: 'k', task: '看看场景', ctx: makeCtx(), reasoningEffort: 'max' });
    expect(on.bodies.map((b) => b['reasoning_effort'])).toEqual(['max', 'max']);

    const off = stubFetch(twoTurns());
    await runShot({ apiKey: 'k', task: '看看场景', ctx: makeCtx() });
    expect(off.bodies.map((b) => b['reasoning_effort'])).toEqual([undefined, undefined]);
    expect(off.bodies.map((b) => b['thinking'])).toEqual([undefined, undefined]);
  });
});

/* ── 服务端：/api/chat 的 reasoning 字段（页面上那个下拉框发过来的） ── */

describe('服务端解析请求里的档位（不信浏览器）', () => {
  it('没传 → 用服务端配的档位（页面初值就是它）', () => {
    expect(resolveRequestedReasoning(undefined, 'high')).toBe('high');
    expect(resolveRequestedReasoning(null, 'off')).toBe('off');
  });

  it('传了合法值 → 以页面为准', () => {
    expect(resolveRequestedReasoning('max', 'off')).toBe('max');
    expect(resolveRequestedReasoning('off', 'high')).toBe('off');
  });

  it('★ 传了非法值 → null（调用方回 400，不静默回退）', () => {
    expect(resolveRequestedReasoning('xhigh', 'high')).toBeNull();
    expect(resolveRequestedReasoning('HIGH', 'high')).toBeNull();
    expect(resolveRequestedReasoning(42, 'high')).toBeNull();
    expect(resolveRequestedReasoning({ type: 'enabled' }, 'high')).toBeNull();
  });
});

describe('★ 真的起一台服务：health 报档位表，/api/chat 按白名单校验', () => {
  it('health 给出 reasoning + reasoningOptions；非法档位当场 400', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const server = await startPanelServer({
      root,
      docPath: join(root, 'out', 'reasoning-test-doc.json'),
      apiKey: '',
      reasoningEffort: 'low',
    });
    try {
      const health = (await (await fetch(server.origin + '/api/health')).json()) as {
        reasoning?: string;
        reasoningOptions?: string[];
      };
      expect(health.reasoning).toBe('low');
      expect(health.reasoningOptions).toEqual([...REASONING_EFFORTS]);

      const bad = await fetch(server.origin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'x', doc: {}, reasoning: 'turbo' }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error?: string };
      expect(String(badBody.error)).toContain('reasoning');

      // 合法档位要【过得了这一关】：它会被后面的 doc 校验拦下，而不是被档位校验拦下
      const ok = await fetch(server.origin + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'x', doc: {}, reasoning: 'max' }),
      });
      expect(ok.status).toBe(400);
      const okBody = (await ok.json()) as { error?: string };
      expect(String(okBody.error)).toContain('doc');
    } finally {
      await server.close();
    }
  });
});

