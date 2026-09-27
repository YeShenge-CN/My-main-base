/**
 * 面板「整片模式」的实机校验（15 项断言）。
 *
 * 用法（先起面板服务，再把地址传进来）：
 *   node packages/agent-tools/dist/serve-panel.mjs --no-open
 *   node packages/agent-tools/dist/verify-film-ui.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"
 *
 * ★ 它【不打模型】：劫持 window.fetch，把 /api/film 的整条「起作业 → 轮询 → done」
 *   脚本化回放，于是界面这一侧可以完整验一遍，而一分钱不花。
 * ★ 断言是按【演示文档】写的（4 个对象 / 2 镜 / 片长 8）。仓库里 out/ 不进版本库，
 *   新克隆下来先跑一次 node packages/agent-tools/make-panel-demo.mjs 生成 out/panel-demo.json
 *   —— 否则服务端只会自动造一份「最小」文档（1 镜 / 12 秒），时间轴的镜头断言会直接失败。
 * ★ 需要 danger-full-access（Chrome 在 Windows 上用命名管道做 Mojo IPC）。
 */
import { join } from 'node:path';
import { panelUrlOrExit, ROOT, runProbe, wait } from './probe-harness';

interface FilmPosted {
  readonly brief?: unknown;
  readonly doc?: unknown;
  readonly reasoning?: unknown;
}

interface FilmProbeState {
  posted: FilmPosted | null;
  polls: number;
  chatCalls: number;
  docs: unknown;
}

declare global {
  interface Window {
    __FILM__?: FilmProbeState;
  }
}

const url = panelUrlOrExit('node packages/agent-tools/dist/verify-film-ui.mjs <面板地址>');

await runProbe({
  profile: 'chrome-profile-film-ui',
  url,
  extraReady: '#filmmode',
  body: async ({ page, report, errors }) => {
    // ── 1) 开关本身：默认【关】，按钮写着「发送」 ────────────────────
    const ui = await page.evaluate(() => {
      const box = document.getElementById('filmmode') as HTMLInputElement | null;
      return {
        exists: box !== null,
        checked: box === null ? null : box.checked,
        label: document.querySelector('.film-label')?.textContent ?? '',
        send: document.getElementById('chatsend')?.textContent ?? '',
        visible: box !== null && box.getBoundingClientRect().height > 0,
      };
    });
    report.check('聊天区出现了「整片」开关', ui.exists && ui.visible, JSON.stringify(ui));
    report.check('★ 默认是关的（整片比单镜贵几十倍，必须显式选）', ui.checked === false, 'checked=' + String(ui.checked));
    report.check('按钮默认写「发送」', ui.send === '发送', ui.send);
    report.check('开关旁边写清了它会做什么', ui.label.includes('导演分镜'), ui.label);

    // ── 2) 打勾 → 按钮变成「生成整片」 ──────────────────────────────
    const after = await page.evaluate(() => {
      const box = document.getElementById('filmmode') as HTMLInputElement | null;
      if (box !== null) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { send: document.getElementById('chatsend')?.textContent ?? '' };
    });
    report.check('★ 打勾后按钮变成「生成整片」', after.send === '生成整片', after.send);

    // ── 3) 劫持 fetch：脚本化的作业进度 ─────────────────────────────
    await page.evaluate(() => {
      const state: FilmProbeState = { posted: null, polls: 0, chatCalls: 0, docs: null };
      window.__FILM__ = state;
      const realFetch = window.fetch;
      const plan = {
        title: '什么是 Agent',
        shots: [
          { name: '定义', seconds: 5, task: '在中间放一行标题' },
          { name: '循环', seconds: 6, task: '画一个闭环箭头' },
        ],
      };
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = String(input);
        if (u.includes('/api/chat')) {
          state.chatCalls += 1;
          return realFetch(input, init);
        }
        if (u.endsWith('/api/film') && init?.method === 'POST') {
          const posted = JSON.parse(String(init.body ?? '{}')) as FilmPosted;
          state.posted = posted;
          state.docs = posted.doc;
          return new Response(JSON.stringify({ ok: true, filmId: 'film-test-1' }), { status: 200 });
        }
        if (u.includes('/api/film/film-test-1')) {
          state.polls += 1;
          const n = state.polls;
          const base = {
            id: 'film-test-1',
            shotsDone: 0,
            shotsTotal: 2,
            usage: { promptTokens: 100, completionTokens: 20 },
          };
          const first = { kind: 'note', text: '导演正在分镜…' };
          const planned = { kind: 'plan', text: '分镜《什么是 Agent》：1. 定义（5s） · 2. 循环（6s） → 共 11s' };
          const shot = { kind: 'shot', text: '第 1/2 镜 · 定义：开始' };
          const done = { kind: 'shot', text: '第 1 镜 · 定义：写入 3 条 · 版本 9→12 · 2 轮' };
          if (n === 1) {
            return new Response(JSON.stringify({ ok: true, film: { ...base, state: 'planning', events: [first] } }), { status: 200 });
          }
          if (n === 2) {
            return new Response(
              JSON.stringify({ ok: true, film: { ...base, state: 'running', title: '什么是 Agent', plan, events: [first, planned, shot] } }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              ok: true,
              film: {
                ...base,
                state: 'done',
                title: '什么是 Agent',
                plan,
                shotsDone: 2,
                events: [first, planned, shot, done],
                doc: state.docs,
                entries: [],
                endVersion: 9,
              },
            }),
            { status: 200 },
          );
        }
        return realFetch(input, init);
      };
    });

    await page.evaluate(() => {
      const input = document.getElementById('chatinput') as HTMLInputElement | null;
      if (input !== null) input.value = '做一条讲清楚 agent 是什么的科普片';
      document.getElementById('chatsend')?.click();
    });
    for (let i = 0; i < 80; i++) {
      const st = await page.evaluate(() => ({
        text: document.getElementById('chat')?.textContent ?? '',
      }));
      if (st.text.includes('整片完成')) break;
      await wait(250);
    }

    const post = await page.evaluate(() => window.__FILM__?.posted ?? null);
    report.check(
      '★ 面板发给 /api/film 的是 brief + doc + reasoning',
      post !== null && typeof post.brief === 'string' && post.doc !== undefined && post.reasoning === 'high',
      JSON.stringify({ brief: post?.brief, hasDoc: post?.doc !== undefined, reasoning: post?.reasoning }),
    );
    const chatCalls = await page.evaluate(() => window.__FILM__?.chatCalls ?? 0);
    report.check('★ 整片模式下【没有】去调 /api/chat（两条路不串）', chatCalls === 0, 'chatCalls=' + String(chatCalls));
    const polls = await page.evaluate(() => window.__FILM__?.polls ?? 0);
    report.check('轮询真的发生了（≥3 次）', polls >= 3, 'polls=' + String(polls));

    const chat = await page.evaluate(() => document.getElementById('chat')?.textContent ?? '');
    report.check('聊天里贴出了需求本身', chat.includes('整片：做一条讲清楚 agent'), '');
    report.check('★ 进度一条条贴出来：分镜', chat.includes('分镜《什么是 Agent》'), '');
    report.check(
      '★ 进度一条条贴出来：逐镜',
      chat.includes('第 1/2 镜 · 定义：开始') && chat.includes('第 1 镜 · 定义：写入 3 条'),
      '',
    );
    report.check('跑完有结论行', chat.includes('整片完成：《什么是 Agent》2 镜'), '');
    report.check('★ 零写入时如实报警（不许看起来像成功）', chat.includes('一条写入都没有落地'), '');
    const sendDisabled = await page.evaluate(
      () => (document.getElementById('chatsend') as HTMLButtonElement | null)?.disabled ?? true,
    );
    report.check('跑完按钮回到「生成整片」且可再点', sendDisabled === false, '');
    await page.screenshot({ path: join(ROOT, 'out', 'verify-film-1.png') });
    report.check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
  },
});