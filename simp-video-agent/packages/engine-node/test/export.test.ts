import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { evaluate, type SceneDoc } from '@sva/engine-core';
import {
  allFrames,
  encodeMp4,
  frameCount,
  frameTime,
  probeVideo,
  renderFramesWithChrome,
  type PlannedFrame,
} from '../src/export';

/**
 * P8 验收：
 *   - MP4 时长与帧数精确
 *   - Level A（同容器内同 docHash + frame → PNG sha256 相同）稳定通过，
 *     或者明确报告不稳定原因
 *
 * 默认跳过（要拉浏览器 + ffmpeg）：
 *   SVA_EXPORT=1 pnpm test
 *
 * ⚠️ 本环境下 Chrome 需要 danger-full-access（命名管道），见 docs/environment.md。
 */
const ENABLED = process.env['SVA_EXPORT'] === '1';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = join(ROOT, 'out');
const FFMPEG = join(ROOT, 'out', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffmpeg.exe');
const FFPROBE = join(ROOT, 'out', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin', 'ffprobe.exe');

/**
 * 一个小镜头：320x180、0.5 秒、60fps → 恰好 30 帧。
 *
 * ★ 刻意带上【中文 + 拉丁】两种文字。
 *   不带文字的夹具会让 document.fonts.ready 那条路径空转，
 *   Level A 于是只验证了"没有文字时是稳定的"—— 那是自欺。
 */
function shot(duration = 0.5): SceneDoc {
  const p1 = {
    shape: 'plot2d',
    owner: { kind: 'global' as const },
    params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 800 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: 0.4 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: ['eff#1'],
  };
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [
      { id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] },
      { id: 'annot', depth: 0.5, order: 2, parallax: 1, objects: ['text#1', 'text#2'] },
    ],
    objects: {
      'plot#1': p1,
      'text#1': {
        shape: 'text',
        owner: { kind: 'global' as const },
        params: { content: { v: '正弦曲线 sin(x)' } },
        style: { size: { v: 20 }, fill: { v: '#e8eef8' } },
        tf: { x: 0, y: 3.1, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
      'text#2': {
        shape: 'text',
        owner: { kind: 'global' as const },
        params: { content: { v: 'Simp Video Agent' } },
        style: { size: { v: 13 }, fill: { v: '#4ea1ff' } },
        tf: { x: 0, y: -3.4, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
    },
    effects: {
      'eff#1': {
        type: 'drawOn',
        target: 'plot#1',
        params: { start: { v: 0 }, duration: { v: 0.4 }, mode: { v: 'arc' }, tip: { v: true } },
      },
    },
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

async function sha256OfDoc(doc: SceneDoc): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

/**
 * 把裸帧号包成 PlannedFrame。
 *
 * `renderFramesWithChrome` 现在收的是帧计划里的一帧（frame + t + sceneId），
 * 因为只有引擎知道"这一帧属于哪一镜"——让页面自己推就等于把同一个判定实现两遍。
 * 这些用例都是单镜头文档（scenes: []），所以 sceneId 一律 null：
 * 而"没有镜头表时不过滤"正是引擎的口径，于是像素与加多镜头之前一致。
 */
function planOf(frameIndexes: readonly number[], doc: SceneDoc): readonly PlannedFrame[] {
  return frameIndexes.map((frame) => ({ frame, t: frame / doc.meta.fps, sceneId: null }));
}

/** 灰度化 + SSIM。Level B 的结构相似度就用它。 */
async function ssim(pathA: string, pathB: string): Promise<number> {
  const [ia, ib] = await Promise.all([loadImage(pathA), loadImage(pathB)]);
  const w = Math.min(ia.width, ib.width);
  const h = Math.min(ia.height, ib.height);
  const ca = createCanvas(w, h);
  const cb = createCanvas(w, h);
  const xa = ca.getContext('2d');
  const xb = cb.getContext('2d');
  xa.drawImage(ia, 0, 0);
  xb.drawImage(ib, 0, 0);
  const da = xa.getImageData(0, 0, w, h).data;
  const db = xb.getImageData(0, 0, w, h).data;

  const gray = (d: Uint8ClampedArray, i: number): number =>
    0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);

  const n = w * h;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += gray(da, i * 4);
    mb += gray(db, i * 4);
  }
  ma /= n;
  mb /= n;
  let va = 0;
  let vb = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const a = gray(da, i * 4) - ma;
    const b = gray(db, i * 4) - mb;
    va += a * a;
    vb += b * b;
    cov += a * b;
  }
  va /= n;
  vb /= n;
  cov /= n;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

describe('帧与时间的推导（纯函数，不需浏览器）', () => {
  it('t 只由整数帧推导', () => {
    expect(frameTime(0, 60)).toBe(0);
    expect(frameTime(30, 60)).toBe(0.5);
    expect(frameTime(1, 30)).toBeCloseTo(1 / 30, 12);
  });

  it('总帧数四舍五入成整数', () => {
    expect(frameCount(0.5, 60)).toBe(30);
    expect(frameCount(12, 60)).toBe(720);
    expect(frameCount(12.008, 60)).toBe(720);
    expect(frameCount(0, 60)).toBe(1);
  });

  it('allFrames 给出 0..N-1', () => {
    expect(allFrames(0.05, 60)).toEqual([0, 1, 2]);
  });
});

describe('字体路径不是空转（纯函数，不需浏览器）', () => {
  const doc = shot(0.5);

  it('夹具里确实有文字项', () => {
    const state = evaluate(doc, 0.2);
    const texts = state.items.filter((i) => i.kind === 'text');
    expect(texts.length).toBe(2);
    expect(texts[0]?.text?.content).toBe('正弦曲线 sin(x)');
    expect(texts[1]?.text?.content).toBe('Simp Video Agent');
  });

  it('字号【不随】相机 scale 变化（规范 §4：字体大小永不放进 scale）', () => {
    const pushed: SceneDoc = {
      ...doc,
      camera: {
        keys: [
          { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] },
          { t: 0.5, tx: 0, ty: 0, scale: 3, rotate: 0, pivot: [0, 0] },
        ],
      },
    };
    const a = evaluate(doc, 0.25).items.find((i) => i.kind === 'text');
    const b = evaluate(pushed, 0.25).items.find((i) => i.kind === 'text');
    expect(a?.text?.cameraScale).toBe(1);
    // 相机轨在 0.25s 处插值出 scale=2（起点 1、终点 3，线性）
    expect(b?.text?.cameraScale).toBeCloseTo(2, 9);
    // ★ 关键：相机缩放变了，字号必须纹丝不动
    expect(b?.text?.fontSize).toBe(a?.text?.fontSize);
    // 位置确实跟随相机：相机绕 (0,0) 缩放，所以偏离注视点的 text#1 在 y 上被推开。
    // （x 不动是对的 —— text#1 的 x 恰好落在注视点上，缩放不改变注视点自身的位置。）
    expect(b?.text?.anchor.y).not.toBe(a?.text?.anchor.y);
  });
});

describe.skipIf(!ENABLED)('P8 验收', () => {
  const doc = shot(0.5);
  const frames = allFrames(doc.meta.duration, doc.meta.fps);

  it(
    'MP4 的帧数与时长精确',
    async () => {
      const hash = await sha256OfDoc(doc);
      const { result, server, session } = await renderFramesWithChrome({
        doc,
        docHash: hash,
        frames: planOf(frames, doc),
        rootDir: ROOT,
        docFileName: 'out/doc-p8.json',
        userDataDir: join(OUT, 'chrome-profile-p8'),
      });

      expect(result.pngs.size).toBe(30);
      const ordered = frames.map((f) => result.pngs.get(f));
      for (const b of ordered) expect(b).toBeDefined();
      const buffers = ordered.filter((b): b is Buffer => b !== undefined);

      const outPath = join(OUT, 'p8.mp4');
      const enc = await encodeMp4({
        frames: buffers,
        fps: doc.meta.fps,
        outPath,
        ffmpegPath: FFMPEG,
        workDir: join(OUT, 'p8-work'),
      });
      console.log('[P8] 编码模式=' + enc.mode + ' 帧数=' + buffers.length + ' Chrome=' + result.chromeVersion);
      console.log('[P8] 自托管字体状态=' + JSON.stringify(result.fontStatus));

      // ★ 字体必须真的加载了。若这里为 false，说明页面在用系统字体，
      //   Level A 的"稳定"只是同机同版本的假象。
      expect(result.fontStatus).not.toBeNull();
      expect(result.fontStatus?.inter400).toBe(true);
      expect(result.fontStatus?.notoCJK).toBe(true);

      const info = await probeVideo(FFPROBE, outPath);
      console.log('[P8] ffprobe: ' + JSON.stringify(info));

      expect(info.nbFrames).toBe(30);
      expect(info.duration).toBeCloseTo(0.5, 3);
      expect(info.fps).toBeCloseTo(60, 3);
      expect(info.width).toBe(320);
      expect(info.height).toBe(180);

      await server.close();
      await session.close();
    },
    600_000,
  );

  it(
    'Level A：同容器内同 docHash + frame → PNG sha256 相同',
    async () => {
      const hash = await sha256OfDoc(doc);
      const probeFrames = [0, 10, 29];

      // 第一次：全新浏览器
      const first = await renderFramesWithChrome({
        doc,
        docHash: hash,
        frames: planOf(probeFrames, doc),
        rootDir: ROOT,
        docFileName: 'out/doc-p8a.json',
        userDataDir: join(OUT, 'chrome-profile-a1'),
      });
      // 第二次：另一个全新浏览器实例，同一个 docHash
      const second = await renderFramesWithChrome({
        doc,
        docHash: hash,
        frames: planOf(probeFrames, doc),
        rootDir: ROOT,
        docFileName: 'out/doc-p8b.json',
        userDataDir: join(OUT, 'chrome-profile-a2'),
      });

      const report: string[] = [];
      let unstable = 0;
      for (const f of probeFrames) {
        const a = first.result.sha256.get(f);
        const b = second.result.sha256.get(f);
        const same = a === b;
        if (!same) unstable += 1;
        report.push('frame ' + f + ': ' + (same ? 'IDENTICAL' : 'DIFFERS') + ' ' + String(a).slice(0, 12) + ' vs ' + String(b).slice(0, 12));
      }
      // 实际观察到的稳定性必须打出来，不能只看断言
      console.log('[P8][Level A] chrome=' + first.result.chromeVersion + ' / ' + second.result.chromeVersion);
      for (const line of report) console.log('[P8][Level A] ' + line);

      await first.server.close();
      await first.session.close();
      await second.server.close();
      await second.session.close();

      expect(unstable, 'Level A 不稳定，逐帧结果见上面的日志').toBe(0);
    },
    600_000,
  );

  it(
    'Level B：与基线做 SSIM 比较（只报警，不算失败）',
    async () => {
      const baseDir = join(OUT, 'baseline');
      mkdirSync(baseDir, { recursive: true });
      const hash = await sha256OfDoc(doc);
      const { result, server, session } = await renderFramesWithChrome({
        doc,
        docHash: hash,
        frames: planOf([10], doc),
        rootDir: ROOT,
        docFileName: 'out/doc-p8b.json',
        userDataDir: join(OUT, 'chrome-profile-b'),
      });
      const fresh = result.pngs.get(10);
      if (fresh === undefined) throw new Error('没有渲染出 frame 10');
      const freshPath = join(baseDir, 'frame-10.latest.png');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(freshPath, fresh);

      const basePath = join(baseDir, 'frame-10.png');
      if (!existsSync(basePath)) {
        copyFileSync(freshPath, basePath);
        console.log('[P8][Level B] 首次运行，已写入基线：' + basePath);
      } else {
        const score = await ssim(basePath, freshPath);
        const verdict = score >= 0.999 ? 'PASS' : score >= 0.99 ? 'WARN' : 'ALERT';
        console.log('[P8][Level B] SSIM=' + score.toFixed(6) + ' → ' + verdict + '（chrome=' + result.chromeVersion + '）');
      }

      await server.close();
      await session.close();
      // 故意不设失败阈值：跨 Chrome 版本的变化由人判断（规范 P8 清单第 4 条）
      expect(true).toBe(true);
    },
    600_000,
  );
});

describe.skipIf(ENABLED)('P8 验收（未启用）', () => {
  it('默认跳过，需要 SVA_EXPORT=1', () => {
    expect(ENABLED).toBe(false);
  });
});
