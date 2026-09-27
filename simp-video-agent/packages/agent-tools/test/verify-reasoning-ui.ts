/**
 * 面板「推理等级」下拉框的实机校验（12 项断言）。
 *
 * 用法（先起面板服务，再把地址传进来）：
 *   node packages/agent-tools/dist/serve-panel.mjs --no-open
 *   node packages/agent-tools/dist/verify-reasoning-ui.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"
 *
 * ★ 它【不打模型】：劫持 window.fetch，把 /api/chat 换成假回执，
 *   于是可以反复验证「页面到底发了什么」而一分钱不花、也不动文档。
 *   真调模型的验收在 p6 / stress / multi-shot（SVA_ACCEPTANCE=1）。
 * ★ 断言是按【演示文档】写的（4 个对象 / 2 镜 / 片长 8）。仓库里 out/ 不进版本库，
 *   新克隆下来先跑一次 node packages/agent-tools/make-panel-demo.mjs 生成 out/panel-demo.json
 *   —— 否则服务端只会自动造一份「最小」文档（1 镜 / 12 秒），时间轴的镜头断言会直接失败。
 * ★ 需要 danger-full-access（Chrome 在 Windows 上用命名管道做 Mojo IPC）。
 */
import { join } from 'node:path';
import { panelUrlOrExit, ROOT, runProbe, wait } from './probe-harness';

interface SentRequest {
  readonly reasoning: unknown;
  readonly keys: readonly string[];
}

declare global {
  interface Window {
    __SENT__?: SentRequest[];
  }
}

const url = panelUrlOrExit('node packages/agent-tools/dist/verify-reasoning-ui.mjs <面板地址>');

await runProbe({
  profile: 'chrome-profile-reason-ui',
  url,
  extraReady: '#reasonselect',
  body: async ({ page, report, errors }) => {
    // ── 1) 控件本身：选项表来自服务端、初值 = 服务端默认（high） ─────
    const ui = await page.evaluate(() => {
      const sel = document.getElementById('reasonselect') as HTMLSelectElement | null;
      const panel = window.__PANEL__;
      return {
        exists: sel !== null,
        options: sel === null ? [] : [...sel.options].map((o) => o.value),
        value: sel === null ? null : sel.value,
        disabled: sel === null ? null : sel.disabled,
        hint: document.getElementById('reasonhint')?.textContent ?? '',
        panelReasoning: panel === undefined ? null : panel.reasoning(),
        visible: sel !== null && sel.getBoundingClientRect().height > 0,
      };
    });
    report.check('聊天区出现了「推理等级」下拉框', ui.exists && ui.visible, JSON.stringify(ui));
    report.check(
      '选项表来自服务端（off/low/high/max）',
      JSON.stringify(ui.options) === JSON.stringify(['off', 'low', 'high', 'max']),
      JSON.stringify(ui.options),
    );
    report.check(
      '★ 默认选中 high',
      ui.value === 'high' && ui.panelReasoning === 'high',
      'select=' + String(ui.value) + ' panel=' + String(ui.panelReasoning),
    );
    report.check('旁边有一句人话解释当前档位', ui.hint.length > 0, ui.hint);

    // ── 2) 劫持 fetch：只拦 /api/chat，回一份假回执（不打模型） ──────
    await page.evaluate(() => {
      const sent: SentRequest[] = [];
      window.__SENT__ = sent;
      const orig = window.fetch;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (!u.includes('/api/chat') || init?.method !== 'POST') return orig(input, init);
        const body = JSON.parse(String(init.body ?? '{}')) as {
          task?: string;
          baseVersion?: number;
          doc?: unknown;
          reasoning?: unknown;
        };
        sent.push({ reasoning: body.reasoning, keys: Object.keys(body) });
        return new Response(
          JSON.stringify({
            ok: true,
            task: body.task,
            startVersion: body.baseVersion ?? 0,
            endVersion: body.baseVersion ?? 0,
            compoundId: 'c:probe',
            doc: body.doc,
            entries: [],
            chat: {
              events: [
                {
                  kind: 'tool',
                  turn: 1,
                  name: 'get_scene_summary',
                  text: '画布总览（探针假回执）',
                  wrote: false,
                },
              ],
              finalMessage: '（探针假回执，没有真的调模型）',
            },
            issues: [],
            usage: { promptTokens: 11, completionTokens: 22 },
            turns: 1,
            truncated: false,
            finished: true,
            budget: {},
            agentOperations: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };
    });

    // ── 3) 真的用界面发一条：默认档位要出现在请求里 ─────────────────
    /** 真的用界面发一条，然后轮询等请求被拦下来（不靠字符串表达式等，免得把自己等死）。 */
    const send = async (text: string): Promise<void> => {
      const before = await page.evaluate(() => window.__SENT__?.length ?? 0);
      await page.evaluate((t: string) => {
        const input = document.getElementById('chatinput') as HTMLInputElement | null;
        if (input !== null) input.value = t;
        document.getElementById('chatsend')?.click();
      }, text);
      for (let i = 0; i < 80; i++) {
        const now = await page.evaluate(() => window.__SENT__?.length ?? 0);
        if (now > before) {
          await wait(250);
          return;
        }
        await wait(150);
      }
      throw new Error('点了发送，但 /api/chat 请求始终没被拦到');
    };

    await send('把曲线加粗一点');
    const first = await page.evaluate(() => window.__SENT__?.[0] ?? null);
    report.check(
      '★ 默认档位随请求发出去了（reasoning=high）',
      first?.reasoning === 'high',
      JSON.stringify(first),
    );
    report.check(
      '请求体照旧带着 task / doc / history',
      ['task', 'doc', 'history'].every((k) => (first?.keys ?? []).includes(k)),
      JSON.stringify(first?.keys),
    );

    // ── 4) 在页面上换档位 → 下一轮请求跟着变 ────────────────────────
    const switched = await page.evaluate(() => {
      const sel = document.getElementById('reasonselect') as HTMLSelectElement | null;
      if (sel !== null) {
        sel.value = 'off';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return {
        value: sel === null ? null : sel.value,
        panel: window.__PANEL__?.reasoning() ?? null,
        hint: document.getElementById('reasonhint')?.textContent ?? '',
      };
    });
    report.check(
      '换档位后页面自己知道（off）',
      switched.value === 'off' && switched.panel === 'off',
      JSON.stringify(switched),
    );
    report.check('提示文字跟着换成 off 的解释', switched.hint.includes('不思考'), switched.hint);
    await page.screenshot({ path: join(ROOT, 'out', 'verify-reason-1-off.png') });

    await send('再试一次');
    const second = await page.evaluate(() => window.__SENT__?.[1] ?? null);
    report.check(
      '★ 换档之后那一轮带的是新档位（reasoning=off）',
      second?.reasoning === 'off',
      JSON.stringify(second),
    );

    // ── 5) 每一轮都带上：不是只在改的那一次带 ──────────────────────
    await page.evaluate(() => {
      const sel = document.getElementById('reasonselect') as HTMLSelectElement | null;
      if (sel !== null) {
        sel.value = 'max';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await send('第三轮');
    await send('第四轮');
    const all = await page.evaluate(() => (window.__SENT__ ?? []).map((s) => s.reasoning));
    report.check(
      '★ 每一轮都带当前档位（high/off/max/max）',
      JSON.stringify(all) === JSON.stringify(['high', 'off', 'max', 'max']),
      JSON.stringify(all),
    );

    // ── 6) 假回执真的被界面消化了（不是被丢掉） ────────────────────
    const chatText = await page.evaluate(() => document.getElementById('chat')?.textContent ?? '');
    report.check('假回执被渲染成聊天记录（说明这条路径真的走通了）', chatText.includes('探针假回执'), chatText.slice(-120));
    report.check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.screenshot({ path: join(ROOT, 'out', 'verify-reason-2-final.png') });
  },
});