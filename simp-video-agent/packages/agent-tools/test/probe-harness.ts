/**
 * 实机探针的公共外壳：Chrome 启动 + 断言收集 + 结果打印。
 *
 * ★ 为什么要有它：verify-timeline / verify-film-ui / verify-project-ui / verify-reasoning-ui
 *   原先各自抄了一份样板（起 Chrome + 记断言 + 打印，约 30 行 × 4），差别只有
 *   【profile 目录名】和【探针正文】。样板抄四份的直接后果是：其中一条漏了 catch，
 *   探针一炸就一行结论都看不到 —— 正是坑表里那条「探针失败时要能自证失败在哪一步」。
 *   现在只有一份，四条脚本一起修好。
 *
 * ★ 与 verify-panel.ts 的分工：那一条走 engine-node 的 screenshotUrl（一次性探针 + 截图），
 *   形态不同，所以它保留自己的实现；这里服务的是【需要持续操作同一个页面】的探针
 *   （拖鼠标、连发多轮请求、刷新页面）。
 *
 * ★ 需要 danger-full-access：Chrome 在 Windows 上靠命名管道做 Mojo IPC（docs/environment.md）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { findChrome } from '@sva/engine-node/chrome';

/** 从产物位置逐级向上找仓库根（与 cli.ts / serve-panel.ts 同一套口径）。 */
export function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

export const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 取面板地址。
 *
 * ★ 这几条脚本以前都带一个「写完那一刻的服务端口」当默认值（如 6938）。
 *   服务每次重启都换端口，那个默认值只会让人怀疑自己是不是传错了 ——
 *   现在没给就打印用法并退出（与 verify-panel.ts 同一口径）。
 */
export function panelUrlOrExit(usage: string): string {
  const url = process.argv[2];
  if (url === undefined || url === '') {
    console.error('用法: ' + usage);
    process.exit(2);
  }
  return url;
}

/** 面板在页面里暴露的调试接口。★ 探针读的是【面板自己的数】，不是我们另算一遍。 */
export interface PanelApi {
  reasoning(): string;
  projectJson(): string;
  doc(): {
    objects: Record<string, unknown>;
    layers: unknown[];
    scenes: { id: string; name: string; bornAt: number }[];
    meta: { duration: number; fps: number };
  };
  renderer(): {
    seek(t: number): void;
    time(): number;
    frame(): number;
    totalFrames(): number;
    frameHash(): string;
  };
  journal(): {
    currentVersion(): number;
    compounds(): { settled: boolean }[];
  };
}

declare global {
  interface Window {
    __PANEL__?: PanelApi;
    __PANEL_ERROR__?: string;
  }
}

export interface ProbeReport {
  check(name: string, pass: unknown, detail?: unknown): void;
  finish(): void;
}

export function createReport(): ProbeReport {
  const rows: { name: string; pass: boolean; detail: string }[] = [];
  return {
    check(name, pass, detail) {
      rows.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
    },
    finish() {
      let bad = 0;
      for (const r of rows) {
        if (!r.pass) bad += 1;
        console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + '   → ' + r.detail);
      }
      console.log('---');
      console.log(rows.length + ' 项断言，' + (rows.length - bad) + ' 通过，' + bad + ' 失败');
      process.exit(bad === 0 ? 0 : 1);
    },
  };
}

export interface ProbeContext {
  readonly page: Page;
  readonly report: ProbeReport;
  /** 页面里的 JS 报错（pageerror）。 */
  readonly errors: string[];
}

export interface ProbeOptions {
  /** profile 目录名（每条脚本一个，互不干扰）。 */
  readonly profile: string;
  readonly url: string;
  /** 除了 __PANEL__ 之外还要等的选择器。 */
  readonly extraReady?: string;
  /** 等布局与首次 rAF 落地的时间。 */
  readonly settleMs?: number;
  readonly body: (ctx: ProbeContext) => Promise<void>;
}

/**
 * 起一个 headless Chrome、打开面板、跑探针正文，最后统一收尾。
 *
 * ★ 探针正文抛异常也要【把已有结论打出来】—— 否则一次失败等于白跑一次，
 *   而「看起来什么都没发生」正是这类脚本最该避免的失败形态。
 */
export async function runProbe(opts: ProbeOptions): Promise<void> {
  const report = createReport();
  const { browser, child } = await launchProbeBrowser(opts.profile);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(opts.url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction('window.__PANEL__ !== undefined', { timeout: 30_000 });
    if (opts.extraReady !== undefined) {
      await page.waitForFunction(
        (sel: string) => document.querySelector(sel) !== null,
        { timeout: 30_000 },
        opts.extraReady,
      );
    }
    await wait(opts.settleMs ?? 600);
    await opts.body({ page, report, errors });
  } catch (err) {
    report.check('探针没有中途抛异常', false, String(err).slice(0, 300));
  } finally {
    try { await browser.disconnect(); } catch { /* 已经断了 */ }
    try { child.kill(); } catch { /* 已经退了 */ }
  }
  report.finish();
}

export interface ProbeBrowser {
  readonly browser: Browser;
  readonly child: ChildProcess;
}

/**
 * 自建 detached 进程 + CDP connect。
 *
 * ★ 不用 puppeteer.launch()：它要求管道 stdio，受限沙箱下直接 EPERM。
 *   Chrome 的路径也不写死 —— 统一问 engine-node 的 findChrome()。
 */
export async function launchProbeBrowser(profileName: string): Promise<ProbeBrowser> {
  const profile = join(ROOT, 'out', profileName);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 删不掉就用旧的 */ }
  const child = spawn(findChrome(), [
    '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-gpu', '--font-render-hinting=none',
    '--hide-scrollbars', '--disable-lcd-text', '--force-color-profile=srgb',
    '--lang=zh-CN', '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  const portFile = profile + '\\DevToolsActivePort';
  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile) && Date.now() < deadline) await wait(150);
  if (!existsSync(portFile)) {
    throw new Error('Chrome 没写出 DevToolsActivePort（命名管道被沙箱拒绝？需要 danger-full-access）');
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? '';
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null });
  return { browser, child };
}