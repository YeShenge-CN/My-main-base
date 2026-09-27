/**
 * 工具表的 **API 金丝雀**：把真实的工具表发给 DeepSeek，只确认"它收得下"。
 *
 * ★ 为什么需要它（这是第十五轮花掉一次实机校验才换来的教训）：
 *   DeepSeek 的 strict 校验会【拒收嵌套 anyOf】——
 *     `nullable({ anyOf: [A, B] })` → 400
 *     Invalid tool parameters schema : field `anyOf`: field `anyOf`: missing field `type`
 *   而它是**整个请求一起失败**：模型一次都调不到。
 *   这个形状从 P2 highlight 起就藏在四条 create 分支里，活了整整三轮，
 *   因为所有真调模型的测试都是 opt-in（SVA_ACCEPTANCE / SVA_STRESS）——
 *   而"没人跑"与"跑过了"在 CI 报告里长得一模一样。
 *
 *   结构断言（schema-from-registry.test.ts 里那条）能挡住【已知】的形状错误，
 *   但接口的规则不止一条：这条金丝雀拿真接口验一遍，代价是几十个 token，
 *   而且用 `tool_choice: 'required'` + 一个字的任务，不会真的展开一次 Agent 循环。
 *
 * 默认跳过（普通 pnpm test 不该打网络）：
 *   SVA_ACCEPTANCE=1 pnpm test
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools';
import { DEFAULT_MAX_TOKENS } from '../src/deepseek';

const ENABLED = process.env['SVA_ACCEPTANCE'] === '1';

function apiKey(): string {
  const raw = readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  if (line === undefined) throw new Error('缺少 DEEPSEEK_API_KEY');
  return line.slice('DEEPSEEK_API_KEY='.length).trim();
}

describe.skipIf(!ENABLED)('工具表能被接口收下', () => {
  it('★ 整张工具表发给 DeepSeek 不报 400（嵌套 anyOf 会在这里现形）', async () => {
    const tools = TOOLS.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, strict: true, parameters: t.parameters },
    }));
    const res = await fetch('https://api.deepseek.com/beta/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: '调用工具。' }],
        temperature: 0,
        tools,
        tool_choice: 'required',
      }),
    });
    const text = await res.text();
    // ★ 断言里带上原文：被拒时要能一眼看到是哪个字段
    expect(res.status, '接口拒收了工具表：' + text.slice(0, 600)).toBe(200);
    expect(text).not.toContain('Invalid tool parameters schema');
  }, 60_000);

  /**
   * ★★ 第二十九轮新增：**显式发出去的 max_tokens 必须被接受**。
   *
   *   在这一轮之前我们从来没传过这个字段，所以"传了会不会被拒"从来没被验过 ——
   *   而它一旦超了模型的输出上限，接口会直接 400，整条 Agent 循环当场不可用。
   *   这条金丝雀的代价是几个 token，挡住的是"上线才发现所有请求都 400"。
   */
  it('★ 显式 max_tokens（含思考模式 + 工具）也收得下', async () => {
    const res = await fetch('https://api.deepseek.com/beta/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey() },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        // ★ 与真实路径一致的组合：工具表 + 思考 + 输出上限
        tools: [
          {
            type: 'function',
            function: { name: 'noop', description: '什么都不做', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
          },
        ],
        tool_choice: 'auto',
        reasoning_effort: 'high',
        max_tokens: DEFAULT_MAX_TOKENS,
      }),
    });
    const text = await res.text();
    expect(res.status, '接口拒收了 max_tokens=' + DEFAULT_MAX_TOKENS + '：' + text.slice(0, 600)).toBe(200);
    expect(text).not.toContain('max_tokens');
  }, 60_000);
});
