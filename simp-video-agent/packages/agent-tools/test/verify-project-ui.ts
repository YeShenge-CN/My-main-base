/**
 * 面板「工程：保存 / 打开 / 恢复上次」的实机校验（25 项断言）。
 *
 * 用法（先起面板服务，再把地址传进来）：
 *   node packages/agent-tools/dist/serve-panel.mjs --no-open
 *   node packages/agent-tools/dist/verify-project-ui.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"
 *
 * ★ 全程本地：不调模型、不真的下载文件（保存那条路只断言「点下去没报错 + 文件名对」）。
 * ★ 断言是按【演示文档】写的（4 个对象 / 2 镜 / 片长 8）。仓库里 out/ 不进版本库，
 *   新克隆下来先跑一次 node packages/agent-tools/make-panel-demo.mjs 生成 out/panel-demo.json
 *   —— 否则服务端只会自动造一份「最小」文档（1 镜 / 12 秒），时间轴的镜头断言会直接失败。
 * ★ 需要 danger-full-access（Chrome 在 Windows 上用命名管道做 Mojo IPC）。
 */
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { panelUrlOrExit, ROOT, runProbe, wait } from './probe-harness';

/** 用真文件对象喂给隐藏的 file input（等价于用户选文件）。 */
async function feedFile(page: Page, json: string, name = 'p.json'): Promise<void> {
  await page.evaluate(
    (text: string, fileName: string) => {
      const input = document.getElementById('projfile') as HTMLInputElement | null;
      if (input === null) throw new Error('找不到 #projfile');
      const dt = new DataTransfer();
      dt.items.add(new File([text], fileName, { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    json,
    name,
  );
  await wait(700);
}

const url = panelUrlOrExit('node packages/agent-tools/dist/verify-project-ui.mjs <面板地址>');

await runProbe({
  profile: 'chrome-profile-project-ui',
  url,
  settleMs: 700,
  body: async ({ page, report, errors }) => {
    // ── 1) 三个按钮在位 ────────────────────────────────────────────
    const bar = await page.evaluate(() => ({
      save: document.getElementById('saveprojbtn')?.textContent ?? '',
      open: document.getElementById('openprojbtn')?.textContent ?? '',
      restore: document.getElementById('restorebtn')?.textContent ?? '',
      file: document.getElementById('projfile') !== null,
      fileHidden: (document.getElementById('projfile')?.getBoundingClientRect().height ?? 1) === 0,
    }));
    report.check('顶栏有「保存工程」', bar.save === '保存工程', bar.save);
    report.check('顶栏有「打开工程」', bar.open === '打开工程', bar.open);
    report.check('顶栏有「恢复上次」', bar.restore === '恢复上次', bar.restore);
    report.check('文件选择框存在且不可见（按钮是它唯一的入口）', bar.file && bar.fileHidden, JSON.stringify(bar));

    // ── 2) 工程 JSON 的内容：文档 + 上下文 ─────────────────────────
    const proj = await page.evaluate(() => {
      const panel = window.__PANEL__;
      if (panel === undefined) throw new Error('__PANEL__ 没有就绪');
      const p = JSON.parse(panel.projectJson()) as {
        format: string;
        formatVersion: number;
        doc: { objects: Record<string, unknown>; scenes: unknown[] };
        context: { reasoning: string; filmMode: boolean; chat: unknown[]; chatHistory: unknown[] };
      };
      return {
        format: p.format,
        version: p.formatVersion,
        objects: Object.keys(p.doc.objects).length,
        scenes: p.doc.scenes.length,
        reasoning: p.context.reasoning,
        filmMode: p.context.filmMode,
        chatLines: p.context.chat.length,
        hasHistory: Array.isArray(p.context.chatHistory),
      };
    });
    report.check('★ 工程带 format / 版本号', proj.format === 'sva-project' && proj.version === 1, JSON.stringify(proj));
    report.check('★ 工程里有完整文档', proj.objects > 0 && proj.scenes > 0, 'objects=' + proj.objects + ' scenes=' + proj.scenes);
    report.check(
      '★ 工程里有上下文（推理档位 / 整片模式 / 聊天行 / 历史）',
      proj.reasoning === 'high' && proj.filmMode === false && proj.chatLines > 0 && proj.hasHistory,
      JSON.stringify(proj),
    );

    // ── 3) 点「保存工程」：不报错 + 聊天里报出文件名 ─────────────────
    await page.evaluate(() => document.getElementById('saveprojbtn')?.click());
    await wait(500);
    const saved = await page.evaluate(() => document.getElementById('chat')?.textContent ?? '');
    report.check('★ 点保存后报出文件名（sva-*.json）', /已保存工程：sva-.+\.json/.test(saved), saved.slice(-160));

    // ── 4) 打开一份工程：文档、上下文、模式一起换掉 ─────────────────
    const imported = await page.evaluate(() => {
      const panel = window.__PANEL__;
      if (panel === undefined) throw new Error('__PANEL__ 没有就绪');
      const p = JSON.parse(panel.projectJson()) as {
        savedAt: string;
        doc: {
          objects: Record<string, unknown>;
          layers: unknown[];
          scenes: { id: string; name: string; bornAt: number }[];
          meta: { duration: number };
        };
        context: { reasoning: string; filmMode: boolean; chatHistory: string[]; chat: unknown[] };
      };
      p.savedAt = '2026-09-25T10:00:00.000Z';
      p.doc.objects = {};
      p.doc.layers = [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }];
      p.doc.scenes = [{ id: 's#9', name: '导入的镜', bornAt: 0 }];
      p.doc.meta.duration = 7;
      p.context.reasoning = 'off';
      p.context.filmMode = true;
      p.context.chatHistory = ['导入前发生过什么：用户做过一道难题。'];
      p.context.chat = [
        { role: 'user', text: '【导入标记】这句话来自工程文件' },
        { role: 'note', text: '【导入标记】第二条' },
      ];
      return JSON.stringify(p, null, 2);
    });
    await feedFile(page, imported);
    const after = await page.evaluate(() => {
      const d = window.__PANEL__?.doc();
      return {
        objects: Object.keys(d?.objects ?? {}).length,
        scenes: (d?.scenes ?? []).map((s) => s.name),
        duration: d?.meta.duration ?? 0,
        reasoning: window.__PANEL__?.reasoning() ?? '',
        select: (document.getElementById('reasonselect') as HTMLSelectElement | null)?.value ?? '',
        film: (document.getElementById('filmmode') as HTMLInputElement | null)?.checked ?? false,
        send: document.getElementById('chatsend')?.textContent ?? '',
        chat: document.getElementById('chat')?.textContent ?? '',
      };
    });
    report.check(
      '★ 文档真的换成了工程里的那份',
      after.objects === 0 && after.scenes.join() === '导入的镜' && after.duration === 7,
      JSON.stringify({ objects: after.objects, scenes: after.scenes, duration: after.duration }),
    );
    report.check(
      '★ 上下文一起回来了（推理档位 = off）',
      after.reasoning === 'off' && after.select === 'off',
      'reasoning=' + after.reasoning,
    );
    report.check(
      '★ 整片模式也回来了（按钮跟着变）',
      after.film === true && after.send === '生成整片',
      JSON.stringify({ film: after.film, send: after.send }),
    );
    report.check(
      '★ 聊天记录换成工程里的那些行',
      after.chat.includes('【导入标记】这句话来自工程文件') && after.chat.includes('【导入标记】第二条'),
      '',
    );
    report.check('明说撤销栈已重置（不许让人以为还能撤销）', after.chat.includes('撤销栈已重置'), '');
    report.check('报出工程里的规模', after.chat.includes('已打开工程：0 个对象 · 1 镜'), '');

    // ── 5) 打开一份坏文件：说清哪一步不对，且不动文档 ────────────────
    const beforeBad = await page.evaluate(
      () => Object.keys(window.__PANEL__?.doc().objects ?? {}).length + '|' + (window.__PANEL__?.reasoning() ?? ''),
    );
    await feedFile(page, JSON.stringify({ hello: 'world' }), 'wrong.json');
    const bad = await page.evaluate(() => ({
      chat: document.getElementById('chat')?.textContent ?? '',
      state: Object.keys(window.__PANEL__?.doc().objects ?? {}).length + '|' + (window.__PANEL__?.reasoning() ?? ''),
    }));
    report.check('★ 坏文件被拒，并说清是「缺少 format 标记」', bad.chat.includes('打开工程失败') && bad.chat.includes('format'), bad.chat.slice(-120));
    report.check('★ 坏文件不动文档（也不会悄悄换掉上下文）', bad.state === beforeBad, bad.state + ' vs ' + beforeBad);

    await feedFile(page, 'not json at all', 'broken.json');
    const notJson = await page.evaluate(() => document.getElementById('chat')?.textContent ?? '');
    report.check('★ 不是 JSON 时也说得清', notJson.includes('不是一份 JSON 文件'), '');

    // ── 6) 自动存档：真的写进了 localStorage ────────────────────────
    await wait(1400);
    const auto = await page.evaluate(() => {
      const raw = localStorage.getItem('sva-project-autosave');
      if (raw === null) return { has: false, format: '', reasoning: '', objects: -1 };
      const p = JSON.parse(raw) as {
        format: string;
        context: { reasoning: string };
        doc: { objects: Record<string, unknown> };
      };
      return {
        has: true,
        format: p.format,
        reasoning: p.context.reasoning,
        objects: Object.keys(p.doc.objects).length,
      };
    });
    report.check('★ 自动存档写进了 localStorage（刷新不丢工作）', auto.has && auto.format === 'sva-project', JSON.stringify(auto));
    report.check('自动存档里是当前状态（刚导入的那份）', auto.reasoning === 'off' && auto.objects === 0, JSON.stringify(auto));

    // ── 7) 刷新页面 → 「恢复上次」点亮 → 点它 → 回到那份工程 ──────────
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('window.__PANEL__ !== undefined', { timeout: 30_000 });
    await wait(800);
    const boot = await page.evaluate(() => {
      const btn = document.getElementById('restorebtn');
      return {
        disabled: btn?.hasAttribute('disabled') ?? true,
        title: btn?.getAttribute('title') ?? '',
        chat: document.getElementById('chat')?.textContent ?? '',
        objects: Object.keys(window.__PANEL__?.doc().objects ?? {}).length,
      };
    });
    report.check('★ 刷新后「恢复上次」可点（有存档才亮）', boot.disabled === false, JSON.stringify({ disabled: boot.disabled, title: boot.title }));
    report.check('刷新后提示里有存档时间与规模', boot.chat.includes('自动存档'), boot.chat.slice(-140));
    report.check('刷新后文档回到 URL 里那份（不自动覆盖）', boot.objects > 0, 'objects=' + boot.objects);

    await page.evaluate(() => document.getElementById('restorebtn')?.click());
    await wait(900);
    const restored = await page.evaluate(() => ({
      objects: Object.keys(window.__PANEL__?.doc().objects ?? {}).length,
      reasoning: window.__PANEL__?.reasoning() ?? '',
      chat: document.getElementById('chat')?.textContent ?? '',
    }));
    report.check(
      '★ 点「恢复上次」→ 回到自动存档里的那份工程',
      restored.objects === 0 && restored.reasoning === 'off',
      JSON.stringify({ objects: restored.objects, reasoning: restored.reasoning }),
    );
    report.check('恢复后聊天里说明这是「恢复上次」', restored.chat.includes('已恢复上次工程'), '');
    await page.screenshot({ path: join(ROOT, 'out', 'verify-project-1.png') });
    report.check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));
  },
});