/**
 * Chrome 驱动。
 *
 * ⚠️ 本环境的硬约束（docs/environment.md 有完整证据）：
 *   Chrome 在 Windows 上用【命名管道】做 Mojo IPC，受限沙箱禁止命名管道，
 *   因此浏览器只在 danger-full-access 下起得来。
 *   puppeteer.launch() 还额外要求管道 stdio，受限模式下直接 EPERM。
 *
 * 所以这里走"自己 detached 起进程 + CDP connect"的路子：
 * 受限模式下它能走完前半段（起进程、拿到 DevTools 端口），
 * 只是 Chrome 随后会自己 FATAL 退出 —— 报错明确，不会静默失败。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer-core';

export const DEFAULT_CHROME_PATHS: readonly string[] = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome(): string {
  for (const p of DEFAULT_CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome。请设置 CHROME_PATH。');
}

export interface ChromeSession {
  readonly browser: Browser;
  readonly version: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  readonly executablePath?: string;
  readonly userDataDir: string;
  readonly timeoutMs?: number;
}

export async function launchChrome(opts: LaunchOptions): Promise<ChromeSession> {
  const exe = opts.executablePath ?? findChrome();
  /**
   * profile 目录要先清空（否则上次的会话状态会渗进来，导出就不确定了）。
   *
   * ★ 但删除【可能失败】：上一轮的 Chrome 还没完全退出时会占住文件，
   *   Windows 上表现为 EPERM。实测代价：整个导出因为一次 rmSync 抛错而崩掉，
   *   而"旧 profile 没删干净"其实不是致命问题。
   *   所以这里退一步：删不掉就换一个新的目录名，让这次导出照常进行。
   */
  let profile = opts.userDataDir;
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    profile = opts.userDataDir + '-' + Date.now().toString(36);
  }

  const args = [
    '--headless',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    // 渲染确定性相关的开关（规范 P1 清单第 4 条）
    '--font-render-hinting=none',
    '--hide-scrollbars',
    '--disable-lcd-text',
    '--force-color-profile=srgb',
    '--lang=en-US',
    'about:blank',
  ];

  // stdio: 'ignore' —— 管道 stdio 在受限沙箱下会 EPERM
  const child: ChildProcess = spawn(exe, args, { stdio: 'ignore', detached: true });
  child.unref();
  if (child.pid === undefined) throw new Error('Chrome 未能启动（没有 pid）');

  const portFile = profile + '\\DevToolsActivePort';
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (!existsSync(portFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!existsSync(portFile)) {
    try { child.kill(); } catch { /* 已经死了 */ }
    throw new Error(
      'Chrome 没有写出 DevToolsActivePort。最常见的原因是命名管道被沙箱拒绝（需要 danger-full-access）。',
    );
  }

  const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim();
  if (port === undefined || port === '') throw new Error('DevToolsActivePort 内容非法');

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port });
  const version = await browser.version();
  return {
    browser,
    version,
    close: async () => {
      try { await browser.disconnect(); } catch { /* 忽略 */ }
      try { child.kill(); } catch { /* 忽略 */ }
    },
  };
}
