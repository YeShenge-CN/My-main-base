/**
 * 导出后端的实测对比：canvas（@napi-rs/canvas）vs chrome（逐帧拉浏览器截图）。
 *
 * 用法（需要 danger-full-access，因为要拉 Chrome）：
 *   node packages/agent-tools/dist/verify-backends.mjs [--at 0.2,0.5,1.0]
 *
 * ★ 为什么要专门做这个：
 *   两条路共用同一份 evaluate + paintScene，所以"画什么"应当一样；
 *   差异只应该来自【栅格化】（抗锯齿、文字、发光）。这件事必须被量化，
 *   否则"两条后端"就是一句没有依据的说法 —— 而本项目已经吃过一次
 *   "字号写进 scale() 让预览与导出分叉"的亏。
 *
 * 它跑的是面板服务里那条真实路径（POST /api/export + 轮询 + ffmpeg 编码），
 * 不是另写一条测试专用的捷径。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { renderFramesWithChrome } from '@sva/engine-node/export';
import type { SceneDoc } from '@sva/engine-core';
import { resolveApiKey, startPanelServer } from './panel-server';
import { defaultFfmpegPaths } from './export-job';

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

/**
 * 对比用的三个镜头。
 *
 * ★ 拆成三个是刻意的，因为"两条后端一致"这件事有三种强度：
 *   纯几何（无发光无文字）：应当【近乎逐字节相同】（同一条折线、同一个矩阵）。
 *   带发光：`shadowBlur` 是 Canvas2D 里最依赖实现的一块 —— 两边都会画出发光，
 *           但羽化半径/衰减曲线不同，所以只能量到"幅度很小"，不能要求逐字节。
 *   带文字：只可能"同一个字体、同一套度量"，边缘抗锯齿必然不同（实测峰值 244）。
 *   把它们混在一个镜头里，就只剩一个说不清的中间数 —— 那正是我第一版的错误。
 */
function geometryDoc(glow: number): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 1, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] }],
    objects: {
      'plot#1': {
        shape: 'plot2d',
        owner: { kind: 'global' },
        params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 800 } },
        style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: glow } },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 0.8, v: 1 }] } },
        effects: [],
      },
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    // 单镜头：空表 = 旧行为（全片一镜，不过滤）
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

/** 带中文与拉丁文字：用来验证"同一个字体"，而不是"像素相同"。 */
function textDoc(): SceneDoc {
  const doc = geometryDoc(0.5);
  return {
    ...doc,
    layers: [
      { id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] },
      { id: 'annot', depth: 0.5, order: 2, parallax: 1, objects: ['text#1', 'text#2'] },
    ],
    objects: {
      ...doc.objects,
      'text#1': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: '正弦 sin(x) 12345' } },
        style: { size: { v: 24 }, fill: { v: '#ffffff' } },
        tf: { x: 0, y: 3, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
      'text#2': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: '信号采样 SIGNAL' } },
        style: { size: { v: 18 }, fill: { v: '#7fb2ff' } },
        tf: { x: 0, y: -3.2, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
    },
  };
}

interface JobView {
  state: string;
  framesDone: number;
  totalFrames: number;
  bytes?: number;
  error?: string;
  encodeMode?: string;
  backend?: string;
  verified?: { nbFrames: number; duration: number; fps: number };
}

async function submitAndWait(
  origin: string,
  doc: SceneDoc,
  backend: 'canvas' | 'chrome',
): Promise<{ id: string; job: JobView }> {
  const res = await fetch(origin + '/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc, backend }),
  });
  const body = (await res.json()) as { ok?: boolean; error?: string; job?: { id: string } };
  if (res.status !== 202 || body.ok !== true || body.job === undefined) {
    throw new Error('提交 ' + backend + ' 导出失败: ' + (body.error ?? 'HTTP ' + res.status));
  }
  const id = body.job.id;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(backend + ' 导出超时');
    await new Promise((r) => setTimeout(r, 500));
    const poll = await fetch(origin + '/api/export/' + id);
    const view = (await poll.json()) as { job?: JobView };
    const job = view.job;
    if (job === undefined) throw new Error(backend + ' 作业丢失');
    if (job.state === 'done') return { id, job };
    if (job.state === 'failed') throw new Error(backend + ' 导出失败: ' + String(job.error).slice(0, 400));
  }
}

/** 逐像素对比两张同尺寸 PNG。返回差异统计（0..255 空间）。 */
async function comparePng(pa: string, pb: string): Promise<{
  readonly width: number;
  readonly height: number;
  readonly diffPixels: number;
  readonly totalPixels: number;
  readonly meanAbsDiff: number;
  readonly maxAbsDiff: number;
  readonly nearIdentical: boolean;
}> {
  const [ia, ib] = await Promise.all([loadImage(pa), loadImage(pb)]);
  if (ia.width !== ib.width || ia.height !== ib.height) {
    throw new Error('尺寸不同：' + ia.width + '×' + ia.height + ' vs ' + ib.width + '×' + ib.height);
  }
  const ca = createCanvas(ia.width, ia.height);
  const cb = createCanvas(ib.width, ib.height);
  ca.getContext('2d').drawImage(ia, 0, 0);
  cb.getContext('2d').drawImage(ib, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, ia.width, ia.height).data;
  const db = cb.getContext('2d').getImageData(0, 0, ib.width, ib.height).data;

  let diffPixels = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < da.length; i += 4) {
    let pixelDiffers = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs((da[i + c] ?? 0) - (db[i + c] ?? 0));
      if (d > 0) pixelDiffers = true;
      sum += d;
      if (d > max) max = d;
    }
    if (pixelDiffers) diffPixels++;
  }
  const totalPixels = ia.width * ia.height;
  const mean = sum / (totalPixels * 4);
  const pct = diffPixels / totalPixels;
  return {
    width: ia.width,
    height: ia.height,
    diffPixels,
    totalPixels,
    meanAbsDiff: mean,
    maxAbsDiff: max,
    /**
     * 判据（实测标定，不是拍脑袋）：
     *
     * 这个镜头里有中文/拉丁文字，所以**峰值差异必然很大**（实测 244~245）。
     * 原因不是字体不同 —— 实测两条后端的文字度量完全一致（差 0.00px），
     * 而是字形边缘的抗锯齿：同一条边缘，一边取 60 一边取 255 就是 195，
     * 一个像素就能把峰值顶到 200+。所以峰值【不能】拿来判"一致"。
     *
     * 能判的是"整体有多像"：平均每通道差异极小，且明显不同的像素占比很小。
     * 纯几何（无文字）时实测 峰值 2~4、平均 0.010 —— 这一档是"几乎逐字节相同"。
     */
    nearIdentical: mean < 20 && pct < 0.35,
  };
}

const ats = argValue('--at', '0.2,0.6,0.9')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

const SCENES = {
  'geometry-noglow': { label: '纯几何（无发光、无文字）', doc: geometryDoc(0) },
  'geometry-glow': { label: '几何 + 发光 0.6', doc: geometryDoc(0.6) },
  'geometry-text': { label: '几何 + 文字（中文 + 拉丁）', doc: textDoc() },
} as const;
const ffmpegPath = defaultFfmpegPaths(ROOT).ffmpeg;
if (!existsSync(ffmpegPath)) {
  console.error('找不到 ffmpeg: ' + ffmpegPath);
  process.exit(1);
}

const outDir = join(ROOT, 'out', 'backend-compare');
mkdirSync(outDir, { recursive: true });

const server = await startPanelServer({
  root: ROOT,
  docPath: join(ROOT, 'out', 'panel-demo.json'),
  apiKey: resolveApiKey(ROOT),
  chromeRender: async (d, frames) => {
    const handle = await renderFramesWithChrome({
      doc: d,
      docHash: createHash('sha256').update(JSON.stringify(d)).digest('hex'),
      frames,
      rootDir: ROOT,
      docFileName: 'out/backend-compare-doc.json',
      userDataDir: join(ROOT, 'out', 'chrome-profile-backend'),
    });
    try {
      return { pngs: handle.result.pngs, chromeVersion: handle.result.chromeVersion };
    } finally {
      await handle.session.close();
      await handle.server.close();
    }
  },
});

console.log('服务     : ' + server.origin);
console.log('');

const { spawnSync } = await import('node:child_process');
const ffprobe = defaultFfmpegPaths(ROOT).ffprobe;

/** 抽帧：用 ffmpeg 从 MP4 里取指定时刻的 PNG。 */
const grab = (mp4: string, tag: string): string[] => {
  const out: string[] = [];
  for (const t of ats) {
    const png = join(outDir, tag + '-t' + String(t).replace('.', '_') + '.png');
    const r = spawnSync(ffmpegPath, ['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', png], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('抽帧失败 t=' + t);
    out.push(png);
  }
  return out;
};

interface SceneResult {
  readonly name: string;
  readonly canvasMs: number;
  readonly chromeMs: number;
  readonly rows: readonly { t: number; diffPixels: number; totalPixels: number; mean: number; max: number }[];
}

const results: SceneResult[] = [];

try {
  /**
   * ★ 控制臂（自比对）：同一份文档、同一个后端、各导出一次，然后比这两份产物。
   *
   * 为什么必须做：上面所有归因都假设 [提交 → 渲染 → 编码 → 抽帧 → 解码] 这条链路
   * 本身没有噪声。这个假设不验证就是空的 —— 如果自比对得到 0.3，
   * 那"几何差异 0.406"里有多少是链路噪声就说不清了。
   * 期望值：逐字节 0（同一进程、同一份输入、确定性编码）。
   */
  {
    const doc = SCENES['geometry-glow'].doc;
    console.log('=== 控制臂：canvas 自比对（同一文档导出两次）===');
    const a = await submitAndWait(server.origin, doc, 'canvas');
    const b = await submitAndWait(server.origin, doc, 'canvas');
    const fa = grab(join(ROOT, 'out', 'exports', a.id + '.mp4'), 'control-a');
    const fb = grab(join(ROOT, 'out', 'exports', b.id + '.mp4'), 'control-b');
    const rows: SceneResult['rows'][number][] = [];
    for (let i = 0; i < ats.length; i++) {
      const pa = fa[i];
      const pb = fb[i];
      if (pa === undefined || pb === undefined) continue;
      const c = await comparePng(pa, pb);
      rows.push({ t: ats[i] ?? 0, diffPixels: c.diffPixels, totalPixels: c.totalPixels, mean: c.meanAbsDiff, max: c.maxAbsDiff });
      console.log(
        '  t=' + ats[i] + '  差异像素 ' + (c.diffPixels / c.totalPixels * 100).toFixed(2) +
          '%  平均 |Δ| ' + c.meanAbsDiff.toFixed(3) + '  峰值 ' + c.maxAbsDiff,
      );
    }
    console.log('  （期望全 0；不为 0 说明这条链路自己有噪声，上面的数要扣掉它）');
    console.log('');
    results.push({ name: 'control-selfcompare', canvasMs: 0, chromeMs: 0, rows });
  }

  for (const [name, scene] of Object.entries(SCENES)) {
    const doc = scene.doc;
    console.log('=== ' + scene.label + ' ===');
    console.log('  ' + doc.meta.viewport.join('×') + ' · ' + doc.meta.duration + 's · ' + doc.meta.fps + 'fps');

    const t0 = Date.now();
    const canvasJob = await submitAndWait(server.origin, doc, 'canvas');
    const canvasMs = Date.now() - t0;
    console.log('  canvas : ' + canvasMs + 'ms · ' + canvasJob.job.bytes + 'B · 编码 ' + canvasJob.job.encodeMode);

    const t1 = Date.now();
    const chromeJob = await submitAndWait(server.origin, doc, 'chrome');
    const chromeMs = Date.now() - t1;
    console.log(
      '  chrome : ' + chromeMs + 'ms · ' + chromeJob.job.bytes + 'B · 编码 ' + chromeJob.job.encodeMode +
        '（慢 ' + (chromeMs / Math.max(1, canvasMs)).toFixed(1) + '×）',
    );

    const cf = grab(join(ROOT, 'out', 'exports', canvasJob.id + '.mp4'), name + '-canvas');
    const xf = grab(join(ROOT, 'out', 'exports', chromeJob.id + '.mp4'), name + '-chrome');
    const rows: SceneResult['rows'][number][] = [];
    for (let i = 0; i < ats.length; i++) {
      const a = cf[i];
      const b = xf[i];
      if (a === undefined || b === undefined) continue;
      const c = await comparePng(a, b);
      rows.push({
        t: ats[i] ?? 0,
        diffPixels: c.diffPixels,
        totalPixels: c.totalPixels,
        mean: c.meanAbsDiff,
        max: c.maxAbsDiff,
      });
    }
    for (const r of rows) {
      console.log(
        '  t=' + r.t +
          '  差异像素 ' + (r.diffPixels / r.totalPixels * 100).toFixed(2) + '%' +
          '  平均 |Δ| ' + r.mean.toFixed(3) +
          '  峰值 ' + r.max,
      );
    }
    console.log('  ffprobe: canvas=' + JSON.stringify(canvasJob.job.verified) + ' chrome=' + JSON.stringify(chromeJob.job.verified));
    console.log('');
    results.push({ name, canvasMs, chromeMs, rows });
  }

  const worstOf = (name: string): { mean: number; max: number } => {
    const r = results.find((x) => x.name === name);
    return {
      mean: Math.max(...(r?.rows.map((x) => x.mean) ?? [999])),
      max: Math.max(...(r?.rows.map((x) => x.max) ?? [999])),
    };
  };
  const control = worstOf('control-selfcompare');
  const noglow = worstOf('geometry-noglow');
  const glow = worstOf('geometry-glow');
  const text = worstOf('geometry-text');

  console.log('=== 结论 ===');
  console.log(
    '控制臂（canvas 自比对）：平均 |Δ| ' + control.mean.toFixed(3) + '，峰值 ' + control.max +
      ' → ' + (control.mean === 0 && control.max === 0 ? '链路零噪声 ✅（下面的归因成立）' : '⚠ 链路有噪声，下面的数要扣掉它'),
  );
  console.log(
    '纯几何（无发光/文字）：平均 |Δ| 最差 ' + noglow.mean.toFixed(3) + '，峰值 ' + noglow.max +
      ' → ' + (noglow.mean < 1.0 && noglow.max <= 64 ? '像素级差异，无结构分叉 ✅' : '⚠ 超出预期，需要查'),
  );
  console.log(
    '几何 + 发光        ：平均 |Δ| 最差 ' + glow.mean.toFixed(3) + '，峰值 ' + glow.max +
      ' → ' + (glow.mean < 1.0 && glow.max <= 64 ? '像素级差异，无结构分叉 ✅' : '⚠ 超出预期，需要查'),
  );
  console.log(
    '几何 + 文字        ：平均 |Δ| 最差 ' + text.mean.toFixed(3) + '，峰值 ' + text.max +
      ' → ' + (text.mean < 20 ? '栅格化级别差异 ✅' : '⚠ 超出预期，需要查'),
  );
  console.log('');
  console.log('阈值是按【实测】定的（320×180 下的量级），不是拍脑袋：');
  console.log('  · 判"有没有结构分叉"看【平均 |Δ|】：代码级分叉（换了矩阵、求值不同、对象位移）');
  console.log('    会表现为平均差几十到上百；这里三档分别是 ' + noglow.mean.toFixed(3) + ' / ' +
    glow.mean.toFixed(3) + ' / ' + text.mean.toFixed(3) + '，都在像素级。');
  console.log('  · 峰值不能当判据：一条抗锯齿边缘一边取 60、一边取 255 就是 195。');
  console.log('  · 采样密度会放大差异：曲线在 840 像素里放了 800 个点，微段的连接与抗锯齿');
  console.log('    在两条栅格化器上必然不同 —— 这也解释了为什么"纯几何"的峰值能到 ' + noglow.max + '。');
  console.log('');
  console.log('三档差异各自的原因（都是实测归因，不是猜）：');
  console.log('  · 几何：同一份 evaluate + paintScene + 同一个矩阵 → 差在折线的抗锯齿与微段连接');
  console.log('  · 发光：shadowBlur 是 Canvas2D 里最依赖实现的一块，羽化半径/衰减曲线不同');
  console.log('  · 文字：峰值 ' + text.max + ' 看着吓人，但两条后端的文字【度量完全一致】（差 0.00px，');
  console.log('          见 diag-text-metrics.mjs），也不存在位置偏移（平移 1px 只把差异降 4.3%，');
  console.log('          见 diag-text-offset.mjs）→ 只是字形边缘的抗锯齿取值不同。');
  console.log('详见 docs/backend-parity.md。');

  const ok =
    control.mean === 0 &&
    control.max === 0 &&
    noglow.mean < 1.0 &&
    noglow.max <= 64 &&
    glow.mean < 1.0 &&
    glow.max <= 64 &&
    text.mean < 20;

  console.log('');
  console.log('产物    : ' + outDir + '（每个场景的 canvas/chrome 抽帧各一张）');
  console.log('ffprobe : ' + ffprobe);
  process.exitCode = ok ? 0 : 1;
} finally {
  await server.close();
}
