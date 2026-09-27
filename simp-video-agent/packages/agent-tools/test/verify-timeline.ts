/**
 * 时间轴手势的实机校验：拖红线 / 拖接缝 / 拖片尾 / 撤销（24 项断言）。
 *
 * 用法（先起面板服务，再把地址传进来）：
 *   node packages/agent-tools/dist/serve-panel.mjs --no-open
 *   node packages/agent-tools/dist/verify-timeline.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"
 *
 * ★ 它做的是【真人做的动作】：CDP 发真正的鼠标事件，指针落在真实的手柄上，
 *   断言读的是面板自己暴露的 __PANEL__ —— 不是我们另算一遍的数。
 * ★ 断言是按【演示文档】写的（4 个对象 / 2 镜 / 片长 8）。仓库里 out/ 不进版本库，
 *   新克隆下来先跑一次 node packages/agent-tools/make-panel-demo.mjs 生成 out/panel-demo.json
 *   —— 否则服务端只会自动造一份「最小」文档（1 镜 / 12 秒），时间轴的镜头断言会直接失败。
 * ★ 需要 danger-full-access（Chrome 在 Windows 上用命名管道做 Mojo IPC）。
 *   截图落在 out/verify-trim-*.png。
 */
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { panelUrlOrExit, ROOT, runProbe, wait } from './probe-harness';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface HandleBox {
  readonly x: number;
  readonly y: number;
  readonly left: number;
}

interface DragStep {
  readonly bornAt: number;
  readonly hash: string;
  readonly scene: string;
  readonly left: string;
}

async function boxOf(page: Page, sel: string): Promise<Box | null> {
  return page.evaluate((s: string) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, sel);
}

/** 所有 .tl-trim 手柄的中点心，按左边缘排序。拖接缝取第一个，拖片尾取最后一个。 */
async function trimHandles(page: Page): Promise<HandleBox[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('#timeline .tl-trim')]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x };
      })
      .sort((a, b) => a.left - b.left),
  );
}

const url = panelUrlOrExit('node packages/agent-tools/dist/verify-timeline.mjs <面板地址>');

await runProbe({
  profile: 'chrome-profile-trim-probe',
  url,
  extraReady: '#timeline .tl-shot',
  settleMs: 900,
  body: async ({ page, report, errors }) => {
    const shotCount = await page.$$eval('#timeline .tl-shot', (els) => els.length);
    const trimCount = await page.$$eval('#timeline .tl-trim', (els) => els.length);
    report.check('镜头泳道画出来了（2 镜）', shotCount === 2, 'shot blocks=' + shotCount);
    report.check('接缝手柄画出来了（左接缝 + 片尾）', trimCount >= 2, 'trim handles=' + trimCount);

    const lane = await boxOf(page, '#timeline .tl-shots');
    const canvas = await boxOf(page, '#timeline canvas');
    if (lane === null || canvas === null) throw new Error('时间轴泳道或画布没找到');
    const duration = await page.evaluate(() => window.__PANEL__?.doc().meta.duration ?? 0);
    const xOf = (t: number): number => canvas.x + (t / duration) * canvas.w;
    const laneXOf = (t: number): number => lane.x + (t / duration) * lane.w;
    const midY = canvas.y + canvas.h / 2;

    // ── 1) 拖红线：按下 → 拖到 t=5 → 不松手就读状态 ──────────────
    await page.mouse.move(xOf(1), midY);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(xOf(1 + (4 * i) / 12), midY);
    await wait(250);
    const mid = await page.evaluate(() => ({
      t: window.__PANEL__?.renderer().time() ?? 0,
      hash: window.__PANEL__?.renderer().frameHash() ?? '',
      transport: document.getElementById('transport')?.textContent ?? '',
      cur: [...document.querySelectorAll('#timeline .tl-shot.cur')].map((e) => e.textContent ?? ''),
    }));
    /** 在时间轴画布上找红线（红色像素列的平均 x）—— 证明【画出来的】也跟上了。 */
    const headLine = await page.evaluate(() => {
      const c = document.querySelector('#timeline canvas') as HTMLCanvasElement | null;
      if (c === null) return -1;
      const ctx = c.getContext('2d');
      if (ctx === null) return -1;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      let n = 0;
      for (let x = 0; x < c.width; x++) {
        for (let y = 0; y < c.height; y++) {
          const i = (y * c.width + x) * 4;
          if ((d[i] ?? 0) > 200 && (d[i + 1] ?? 0) < 130 && (d[i + 2] ?? 0) < 140) {
            sum += x;
            n += 1;
            break;
          }
        }
      }
      return n === 0 ? -1 : sum / n;
    });
    await page.mouse.up();
    await wait(200);
    report.check('红线拖到 t=5.00s（读的是面板自己的时刻）', Math.abs(mid.t - 5) < 0.02, 't=' + mid.t.toFixed(3) + 's');
    report.check('传输条同步报出 t=5.00s', /t=5\.00s/.test(mid.transport), mid.transport);
    report.check('镜头高亮跟着走（高亮第二镜）', mid.cur.length === 1 && (mid.cur[0] ?? '').includes('第二'), JSON.stringify(mid.cur));
    report.check(
      '红线像素确实落在 5/8 处',
      headLine > 0 && Math.abs(headLine / canvas.w - 5 / 8) < 0.06,
      'playhead x=' + headLine.toFixed(1) + ' / 画布 ' + canvas.w.toFixed(0),
    );
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-1-before.png') });
    const beforeHash = mid.hash;

    // ── 2) 拖接缝：把 s#2 的起点从 4s 拖到 6s，红线停在 5s ─────────
    const handles = await trimHandles(page);
    const seam = handles[0] ?? null;
    report.check('找得到 s#2 的左接缝手柄', seam !== null, JSON.stringify(seam));
    if (seam === null) throw new Error('没有接缝手柄，后面的拖动测试无从谈起');
    await page.mouse.move(seam.x, seam.y);
    await page.mouse.down();
    const steps: DragStep[] = [];
    for (let i = 1; i <= 16; i++) {
      await page.mouse.move(laneXOf(4 + (2 * i) / 16), seam.y);
      steps.push(
        await page.evaluate(() => ({
          bornAt: window.__PANEL__?.doc().scenes.find((s) => s.id === 's#2')?.bornAt ?? -1,
          hash: window.__PANEL__?.renderer().frameHash() ?? '',
          scene: document.querySelector('#timeline .tl-shot.cur')?.textContent ?? '',
          left:
            (document.querySelectorAll('#timeline .tl-shot')[1] as HTMLElement | undefined)?.style.left ?? '',
        })),
      );
    }
    await wait(250);
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-2-during.png') });
    const during = steps[steps.length - 1] ?? { bornAt: -1, hash: '', scene: '', left: '' };
    report.check('拖动中【画面】实时变了（帧指纹变了）', during.hash !== beforeHash, beforeHash + ' → ' + during.hash);
    report.check(
      '拖动中【镜头块】实时跟着伸缩',
      during.left !== '' && Math.abs(parseFloat(during.left) - 50) > 0.5,
      's#2 左边缘 = ' + during.left,
    );
    report.check(
      '拖动中【文档一个字节都没动】（预览 ≠ 提交）',
      steps.every((s) => Math.abs(s.bornAt - 4) < 1e-9),
      'bornAt 全程 = ' + during.bornAt,
    );
    report.check('拖动中画面已翻到第一镜（红线 5s 落在新边界左侧）', during.scene.includes('第一'), during.scene);

    await page.mouse.up();
    await wait(700);
    const after = await page.evaluate(() => {
      const panel = window.__PANEL__;
      const compounds = panel?.journal().compounds() ?? [];
      return {
        bornAt: panel?.doc().scenes.find((s) => s.id === 's#2')?.bornAt ?? -1,
        duration: panel?.doc().meta.duration ?? 0,
        compounds: compounds.length,
        settled: compounds.every((c) => c.settled),
        blocks: [...document.querySelectorAll('#timeline .tl-shot')].map(
          (e) => (e as HTMLElement).style.left + ' w=' + (e as HTMLElement).style.width,
        ),
      };
    });
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-3-after.png') });
    report.check('松手后 s#2 起点真的变成 6.00s', Math.abs(after.bornAt - 6) < 0.02, 'bornAt=' + after.bornAt);
    report.check('片长没被牵连（拖接缝只挪边界）', Math.abs(after.duration - 8) < 1e-9, 'duration=' + after.duration);
    report.check(
      '★ 整段拖动 = 1 个 compound 且 settled（撤销按钮点得动）',
      after.compounds === 1 && after.settled,
      'compounds=' + after.compounds + ' settled=' + after.settled,
    );
    report.check(
      '时间轴按新边界重排（s#2 左边缘 75%）',
      Math.abs(parseFloat(after.blocks[1] ?? '') - 75) < 0.01,
      JSON.stringify(after.blocks),
    );

    // ── 3) 拖片尾：先缩短到 6.5s，再拉长（拉长要拖到时间轴右边界之外）──
    const endHandles1 = await trimHandles(page);
    const h1 = endHandles1[endHandles1.length - 1];
    if (h1 === undefined) throw new Error('找不到片尾手柄');
    await page.mouse.move(h1.x, h1.y);
    await page.mouse.down();
    await page.mouse.move(laneXOf(6.5), h1.y, { steps: 10 });
    await page.mouse.up();
    await wait(700);
    const shrunk = await page.evaluate(() => ({
      duration: window.__PANEL__?.doc().meta.duration ?? 0,
      frames: window.__PANEL__?.renderer().totalFrames() ?? 0,
      label: document.getElementById('framelabel')?.textContent ?? '',
    }));
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-4-end-short.png') });
    report.check('拖片尾向左 → 片长缩到 6.50s', Math.abs(shrunk.duration - 6.5) < 0.05, 'duration=' + shrunk.duration);
    report.check(
      '总帧数跟着重算',
      Math.abs(shrunk.frames - Math.round(shrunk.duration * 60)) <= 1,
      'frames=' + shrunk.frames + ' · ' + shrunk.label,
    );

    const endHandles2 = await trimHandles(page);
    const h2 = endHandles2[endHandles2.length - 1];
    if (h2 === undefined) throw new Error('找不到片尾手柄（拉长那一步）');
    const vw = await page.evaluate(() => window.innerWidth);
    const targetX = Math.min(vw - 4, lane.x + lane.w * 1.35);
    await page.mouse.move(h2.x, h2.y);
    await page.mouse.down();
    await page.mouse.move(targetX, h2.y, { steps: 14 });
    const stretchedPreview = await page.evaluate(() => ({
      docDuration: window.__PANEL__?.doc().meta.duration ?? 0,
      frames: window.__PANEL__?.renderer().totalFrames() ?? 0,
      whole: (document.querySelector('#timeline .tl-shot') as HTMLElement | null)?.style.width ?? '',
    }));
    await page.mouse.up();
    await wait(700);
    const stretched = await page.evaluate(() => ({
      duration: window.__PANEL__?.doc().meta.duration ?? 0,
      fps: window.__PANEL__?.doc().meta.fps ?? 0,
      frames: window.__PANEL__?.renderer().totalFrames() ?? 0,
      label: document.getElementById('framelabel')?.textContent ?? '',
    }));
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-5-end-long.png') });
    report.check(
      '★ 拖片尾向右 → 片长真的变长（拉长）',
      stretched.duration > 6.55,
      'duration=' + stretched.duration.toFixed(2) + 's（拖动中预览 frames=' + stretchedPreview.frames + '）',
    );
    report.check(
      '预览时刻的总帧数当场就跟着变（画面/帧计划实时）',
      stretchedPreview.frames !== shrunk.frames,
      shrunk.frames + ' → ' + stretchedPreview.frames,
    );
    report.check(
      '提交后帧号标签与片长一致',
      Math.abs(stretched.frames - Math.round(stretched.duration * stretched.fps)) <= 1,
      'frames=' + stretched.frames + ' · ' + stretched.label,
    );

    // ── 4) 撤销：一次点掉整段拖动 ────────────────────────────────
    const undo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#journal button')];
      const b = btns.find((el) => (el.textContent ?? '').includes('撤销'));
      if (b === undefined) return { found: false, disabled: true };
      const disabled = b.hasAttribute('disabled');
      (b as HTMLButtonElement).click();
      return { found: true, disabled };
    });
    await wait(800);
    const afterUndo = await page.evaluate(() => window.__PANEL__?.doc().meta.duration ?? 0);
    await page.screenshot({ path: join(ROOT, 'out', 'verify-trim-6-undo.png') });
    report.check('Journal 里有可点的撤销按钮', undo.found && !undo.disabled, JSON.stringify(undo));
    report.check('撤销一次 → 片长退回上一版（6.50s）', Math.abs(afterUndo - 6.5) < 0.05, 'duration=' + afterUndo);

    report.check('页面没有 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '));
    const panelError = await page.evaluate(() => window.__PANEL_ERROR__ ?? null);
    report.check('面板自身无 __PANEL_ERROR__', panelError === null, 'ok');
  },
});