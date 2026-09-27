/**
 * 定位两条导出后端的像素差异来源（一次性诊断）。
 *
 * 用四个镜头把差异拆开：纯曲线 / 纯文字 / 曲线+文字 / 高发光。
 * 只跑两帧（同一时刻），所以便宜。
 *
 *   node packages/agent-tools/dist/diag-backends.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SceneDoc, SceneObject } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node/headless';
import { renderFramesWithChrome } from '@sva/engine-node/export';

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
const OUT = join(ROOT, 'out', 'backend-diag');
mkdirSync(OUT, { recursive: true });

function base(objs: Record<string, SceneObject>): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 0.2, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: Object.keys(objs) }],
    objects: objs,
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

const plot = (glow: number): SceneObject => ({
  shape: 'plot2d',
  owner: { kind: 'global' },
  params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 400 } },
  style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: glow } },
  tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
  anim: {},
  effects: [],
});

const text = (content: string, size: number): SceneObject => ({
  shape: 'text',
  owner: { kind: 'global' },
  params: { content: { v: content } },
  style: { size: { v: size }, fill: { v: '#ffffff' } },
  tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
  anim: {},
  effects: [],
});

async function diff(pa: string, pb: string): Promise<{ pct: number; mean: number; max: number }> {
  const [ia, ib] = await Promise.all([loadImage(pa), loadImage(pb)]);
  const ca = createCanvas(ia.width, ia.height);
  const cb = createCanvas(ib.width, ib.height);
  ca.getContext('2d').drawImage(ia, 0, 0);
  cb.getContext('2d').drawImage(ib, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, ia.width, ia.height).data;
  const db = cb.getContext('2d').getImageData(0, 0, ib.width, ib.height).data;
  let n = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < da.length; i += 4) {
    let d = false;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs((da[i + c] ?? 0) - (db[i + c] ?? 0));
      if (v > 0) d = true;
      sum += v;
      if (v > max) max = v;
    }
    if (d) n++;
  }
  const total = ia.width * ia.height;
  return { pct: (n / total) * 100, mean: sum / (total * 3), max };
}

const cases: readonly (readonly [string, SceneDoc])[] = [
  ['纯曲线 glow=0', base({ 'plot#1': plot(0) })],
  ['纯曲线 glow=0.6', base({ 'plot#1': plot(0.6) })],
  ['纯中文大字 text#1', base({ 'text#1': text('正弦', 48) })],
  ['纯拉丁大字 text#1', base({ 'text#1': text('sin ABC 123', 48) })],
  ['曲线+中文文字', base({ 'plot#1': plot(0.5), 'text#1': text('正弦 sin(x)', 18) })],
];

console.log('镜头'.padEnd(22) + '差异像素%   平均|Δ|  峰值  canvas字节  chrome字节');
for (const [name, doc] of cases) {
  const t = 0.1;
  const canvasFrame = renderFrames(doc, [t])[0];
  if (canvasFrame === undefined) throw new Error('canvas 渲染失败');
  const p1 = join(OUT, name.replace(/[^\w.]+/g, '_') + '-canvas.png');
  writeFileSync(p1, canvasFrame.png);

  const handle = await renderFramesWithChrome({
    doc,
    // 页面自己会校验 docHash（防止"文档与截图不是同一次"），所以必须是真 hash
    docHash: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
    // 无镜头表 → sceneId 为 null，与"不过滤"等价（引擎的口径）
    frames: [{ frame: 0, t: 0, sceneId: null }],
    rootDir: ROOT,
    docFileName: 'out/backend-diag-doc.json',
    userDataDir: join(ROOT, 'out', 'chrome-profile-diag'),
  });
  let p2: string;
  try {
    const png = handle.result.pngs.get(0);
    if (png === undefined) throw new Error('chrome 没回帧');
    p2 = join(OUT, name.replace(/[^\w.]+/g, '_') + '-chrome.png');
    writeFileSync(p2, png);
  } finally {
    await handle.session.close();
    await handle.server.close();
  }

  const c = await diff(p1, p2);
  const chromeBytes = (await loadImage(p2)) === undefined ? 0 : 0;
  void chromeBytes;
  console.log(
    name.padEnd(22) +
      c.pct.toFixed(2).padStart(8) +
      c.mean.toFixed(3).padStart(10) +
      String(c.max).padStart(6) +
      String(canvasFrame.png.length).padStart(11) +
      String(p2.length > 0 ? readFileSync(p2).length : 0).padStart(11),
  );
}
console.log('');
console.log('对照图在 ' + OUT);
