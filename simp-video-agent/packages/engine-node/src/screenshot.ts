/**
 * 通用页面截图。给面板做视觉验证用 ——
 * "我说它能跑"和"我真的看到了"是两回事。
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchChrome } from './chrome';

export interface ScreenshotOptions {
  readonly url: string;
  readonly outPath: string;
  readonly width: number;
  readonly height: number;
  readonly userDataDir: string;
  /** 页面里用来表示"可以截了"的全局变量名 */
  readonly readyFlag?: string;
  readonly chromePath?: string;
  /**
   * 在页面里求值的表达式（字符串），结果会被带回来。
   * 这样"视觉验证"同时也是一份结构断言，而不是只看截图好不好看。
   */
  readonly probe?: string;
  /** 截屏【之前】在页面里跑的一段脚本，用来把界面推进到要验证的状态。 */
  readonly prepare?: string;
}

export interface ScreenshotResult {
  readonly sha256: string;
  readonly chromeVersion: string;
  readonly consoleLines: readonly string[];
  /** probe 表达式的求值结果。没给 probe 时为 null。 */
  readonly probeResult: unknown;
}

export async function screenshotUrl(opts: ScreenshotOptions): Promise<ScreenshotResult> {
  const session = await launchChrome({
    userDataDir: opts.userDataDir,
    ...(opts.chromePath === undefined ? {} : { executablePath: opts.chromePath }),
  });
  const consoleLines: string[] = [];
  try {
    const page = await session.browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
    page.on('console', (m: { type: () => string; text: () => string }) => {
      consoleLines.push('[' + m.type() + '] ' + m.text());
    });
    page.on('pageerror', (e: unknown) => {
      consoleLines.push('[pageerror] ' + (e instanceof Error ? e.message : String(e)));
    });

    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    const flag = opts.readyFlag ?? '__PANEL_READY__';
    try {
      // ★ 必须判【真值】，不是判"已定义"。
      //   判已定义的话，页面把 __READY__ 置成 false 时也会通过 ——
      //   于是一个启动失败的半成品页面被静默截图，看起来"跑通了"。
      await page.waitForFunction(
        (name: string) => Boolean((window as unknown as Record<string, unknown>)[name]),
        { timeout: 30_000 },
        flag,
      );
    } catch (err) {
      const pageError = await page.evaluate(
        () => (window as unknown as { __PANEL_ERROR__?: string }).__PANEL_ERROR__ ?? '(无)',
      );
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        '等待 ' + flag + ' 超时：' + reason + '\n页面报告的错误: ' + pageError + '\n页面日志:\n' + consoleLines.join('\n'),
        { cause: err },
      );
    }
    // 让布局与首次 rAF 落地
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    if (opts.prepare !== undefined) {
      await page.evaluate(opts.prepare);
      await new Promise((r) => setTimeout(r, 300));
    }

    let probeResult: unknown = null;
    if (opts.probe !== undefined) {
      probeResult = await page.evaluate(opts.probe);
    }

    const shot = await page.screenshot({ type: 'png' });
    const buf = Buffer.from(shot);
    writeFileSync(opts.outPath, buf);
    return {
      sha256: createHash('sha256').update(buf).digest('hex'),
      chromeVersion: session.version,
      consoleLines,
      probeResult,
    };
  } finally {
    await session.close();
  }
}
