/**
 * 导出管线（P8）。
 *
 * 帧循环：整数帧 N → t = N / fps → preview.html?mode=export&frame=N
 *        → 等 document.fonts.ready → 等 window.__READY__ → screenshot → PNG
 *
 * ★ 时间只由整数帧推导，全程不读 performance.now() / Date.now()。
 *   一旦允许"当前时间"进入渲染，同一帧两次渲染就不可能字节相同。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SceneDoc } from '@sva/engine-core';
import { startStaticServer, type StaticServer } from './server';
import { launchChrome, type ChromeSession } from './chrome';
import { buildPreviewBundle } from './bundle';

/**
 * ★ 纯编码部分（帧时序 / ffmpeg / ffprobe）已移到 encode.ts，并从包根再导出。
 *   分开的原因：本文件还带"逐帧拉 Chrome 截图"那条腿，它的 page.evaluate
 *   回调需要 DOM 类型；宿主（面板导出按钮、CLI）只想用 ffmpeg 时不该被连坐。
 *   这里保留再导出，是让既有 import 路径继续可用。
 */
export {
  allFrames,
  encodeMp4,
  ffmpegFileArgs,
  ffmpegPipeArgs,
  frameCount,
  frameTime,
  probeVideo,
  type EncodeResult,
} from './encode';

/* ══════════════ 浏览器侧逐帧渲染 ══════════════ */

/**
 * 帧计划里的一帧。
 *
 * ★ 刻意收成 {frame, t, sceneId} 而不是裸帧号：只有引擎知道"这一帧属于哪一镜"，
 *   让页面自己去推，就等于把同一个判定实现两遍 —— 而两处一旦分叉，
 *   症状是"预览看起来对、成片少了一段"。
 */
export interface PlannedFrame {
  readonly frame: number;
  readonly t: number;
  readonly sceneId: string | null;
}

export interface ChromeRenderOptions {
  readonly doc: SceneDoc;
  readonly docHash: string;
  readonly frames: readonly PlannedFrame[];
  readonly rootDir: string;
  readonly docFileName: string;
  readonly userDataDir: string;
  readonly chromePath?: string;
  /** 默认 true：每次导出前重新打包浏览器端，杜绝"用旧引擎导出"这类静默错误。 */
  readonly rebuildBundle?: boolean;
}

export interface FontStatus {
  readonly inter400: boolean;
  readonly inter700: boolean;
  readonly notoCJK: boolean;
  readonly facesLoaded: number;
}

export interface ChromeRenderResult {
  readonly pngs: ReadonlyMap<number, Buffer>;
  readonly sha256: ReadonlyMap<number, string>;
  readonly chromeVersion: string;
  /** 自托管字体的实际加载状态。为 null 说明页面根本没跑到那一步。 */
  readonly fontStatus: FontStatus | null;
}

export async function renderFramesWithChrome(
  opts: ChromeRenderOptions,
): Promise<{ result: ChromeRenderResult; server: StaticServer; session: ChromeSession }> {
  const [vw, vh] = opts.doc.meta.viewport;
  writeFileSync(join(opts.rootDir, opts.docFileName), JSON.stringify(opts.doc));

  if (opts.rebuildBundle !== false) {
    await buildPreviewBundle(
      join(opts.rootDir, 'packages', 'engine-render', 'preview', 'entry.ts'),
      join(opts.rootDir, 'out', 'preview-bundle.js'),
    );
  }

  const server = await startStaticServer(opts.rootDir);
  const session = await launchChrome({
    userDataDir: opts.userDataDir,
    ...(opts.chromePath === undefined ? {} : { executablePath: opts.chromePath }),
  });

  const page = await session.browser.newPage();
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });

  // 页面里的任何异常都必须能被带出来 —— 否则只会看到一句"等超时了"
  const consoleLines: string[] = [];
  page.on('console', (m: { type: () => string; text: () => string }) => {
    consoleLines.push('[' + m.type() + '] ' + m.text());
  });
  page.on('pageerror', (e: unknown) => {
    consoleLines.push('[pageerror] ' + (e instanceof Error ? e.message : String(e)));
  });
  page.on('requestfailed', (r: { url: () => string; failure: () => { errorText: string } | null }) => {
    consoleLines.push('[requestfailed] ' + r.url() + ' ' + (r.failure()?.errorText ?? ''));
  });
  page.on('response', (r: { status: () => number; url: () => string }) => {
    if (r.status() >= 400) consoleLines.push('[http ' + r.status() + '] ' + r.url());
  });

  const pngs = new Map<number, Buffer>();
  const hashes = new Map<number, string>();
  let fontStatus: FontStatus | null = null;

  for (const planned of opts.frames) {
    const frame = planned.frame;
    /**
     * ★ scene= 一定要显式带上（包括空档帧的 scene=）。
     *   不带的话页面会自己按帧号查镜头 —— 那是第二套判定，一旦与这里的计划
     *   不一致就会出现"导出的帧和计划说的不是同一镜"。
     *   空档帧传空串 = "这一帧没有内容"，页面只画背景。
     */
    const url =
      server.origin +
      '/packages/engine-render/preview/preview.html?mode=export&frame=' + frame +
      '&scene=' + (planned.sceneId ?? '') +
      '&doc=/' + opts.docFileName +
      '&docHash=' + opts.docHash;

    consoleLines.length = 0;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    try {
      // ★ 等"就绪【或】出错"，而不是只等就绪 ——
      //   只等就绪的话，页面抛异常时只会看到一句超时，真正的原因被吞掉。
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __READY__?: boolean; __EXPORT_ERROR__?: string | null };
          return w.__READY__ === true || w.__EXPORT_ERROR__ != null;
        },
        { timeout: 30_000 },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        '等待 __READY__ 超时（frame ' + frame + '）：' + reason + '\n页面日志:\n' + consoleLines.join('\n'),
        { cause: err },
      );
    }

    const failure = await page.evaluate(
      () => (window as unknown as { __EXPORT_ERROR__?: string | null }).__EXPORT_ERROR__ ?? null,
    );
    if (failure !== null) {
      throw new Error('页面渲染失败 (frame ' + frame + '): ' + failure + '\n页面日志:\n' + consoleLines.join('\n'));
    }

    if (fontStatus === null) {
      fontStatus = await page.evaluate(
        () =>
          (window as unknown as { __FONT_STATUS__?: FontStatus | null }).__FONT_STATUS__ ?? null,
      );
    }

    const shot = await page.screenshot({ type: 'png' });
    const buf = Buffer.from(shot);
    pngs.set(frame, buf);
    hashes.set(frame, createHash('sha256').update(buf).digest('hex'));
  }

  return {
    result: { pngs, sha256: hashes, chromeVersion: session.version, fontStatus },
    server,
    session,
  };
}
