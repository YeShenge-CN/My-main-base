/**
 * 测试假设：文字差异里是否存在【半像素级位置偏移】。
 *
 * 用法（需要 danger-full-access）：
 *   node packages/agent-tools/dist/diag-text-offset.mjs
 *
 * ★ 背景：实测两条后端的文字**度量完全一致**（差 0.00px），但像素差异峰值到 244~255。
 *   同字形、同度量的情况下，边缘抗锯齿通常只造成"中等"差异；
 *   而 0↔255 的翻转更像是字形**落在不同的像素格点**上（半个像素的偏移）。
 *
 * 做法：同一份文档、同一时刻，两条后端各渲一帧文字图；
 *   然后把 canvas 那张图按 (dx,dy) ∈ {-0.5,0,+0.5} 的 9 个组合重新采样，
 *   看哪一个组合的平均差异最小。
 *   如果 (0.5,0) 或 (0,0.5) 明显好于 (0,0)，就说明确实存在半像素偏移。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SceneDoc } from '@sva/engine-core';
import { registerHeadlessFonts, renderFrames } from '@sva/engine-node/headless';
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
const OUT = join(ROOT, 'out', 'text-offset');
mkdirSync(OUT, { recursive: true });

registerHeadlessFonts();

/** 只有一行文字、放在正中：位置最容易观察。 */
function textDoc(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 0.2, seed: 1 },
    theme: { bg: '#000000', fg: '#ffffff', accent: '#ffffff', glow: 0 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['text#1'] }],
    objects: {
      'text#1': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: '正弦 sin(x)' } },
        style: { size: { v: 48 }, fill: { v: '#ffffff' } },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
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

const doc = textDoc();
const canvasPng = renderFrames(doc, [0])[0];
if (canvasPng === undefined) throw new Error('canvas 渲染失败');
writeFileSync(join(OUT, 'canvas.png'), canvasPng.png);

const handle = await renderFramesWithChrome({
  doc,
  docHash: createHash('sha256').update(JSON.stringify(doc)).digest('hex'),
  // 无镜头表 → sceneId 为 null，与"不过滤"等价（引擎的口径）
  frames: [{ frame: 0, t: 0, sceneId: null }],
  rootDir: ROOT,
  docFileName: 'out/text-offset-doc.json',
  userDataDir: join(OUT, 'chrome-profile'),
});
let chromePng: Buffer;
try {
  const png = handle.result.pngs.get(0);
  if (png === undefined) throw new Error('chrome 没回帧');
  chromePng = png;
  writeFileSync(join(OUT, 'chrome.png'), png);
} finally {
  await handle.session.close();
  await handle.server.close();
}

const imgA = await loadImage(canvasPng.png);
const imgB = await loadImage(chromePng);
const W = imgA.width;
const H = imgA.height;

/** 把 A 平移 (dx,dy) 后与 B 比：差异最小者就是真正的相对偏移。 */
function meanAbsDiffAt(dx: number, dy: number): number {
  const ca = createCanvas(W, H);
  const ctxA = ca.getContext('2d');
  ctxA.fillStyle = '#000000';
  ctxA.fillRect(0, 0, W, H);
  ctxA.drawImage(imgA, dx, dy);
  const cb = createCanvas(W, H);
  const ctxB = cb.getContext('2d');
  ctxB.fillStyle = '#000000';
  ctxB.fillRect(0, 0, W, H);
  ctxB.drawImage(imgB, 0, 0);
  const da = ctxA.getImageData(0, 0, W, H).data;
  const db = ctxB.getImageData(0, 0, W, H).data;
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    // 只比亮度：文字是黑底白字，通道冗余
    sum += Math.abs((da[i] ?? 0) - (db[i] ?? 0));
  }
  return sum / (W * H);
}

const offsets = [-1, -0.5, 0, 0.5, 1];
console.log('把 canvas 图平移 (dx,dy) 后与 chrome 图比较，平均 |Δ|（越小越像）：');
console.log('        ' + offsets.map((d) => ('dx=' + d).padStart(9)).join(''));
let best = { dx: 0, dy: 0, v: Number.POSITIVE_INFINITY };
for (const dy of offsets) {
  const row: string[] = [];
  for (const dx of offsets) {
    const v = meanAbsDiffAt(dx, dy);
    if (v < best.v) best = { dx, dy, v };
    row.push(v.toFixed(3).padStart(9));
  }
  console.log('dy=' + String(dy).padEnd(5) + row.join(''));
}
const base = meanAbsDiffAt(0, 0);
console.log('');
console.log('无偏移时 平均|Δ| = ' + base.toFixed(3));
console.log('最佳偏移 = (' + best.dx + ', ' + best.dy + ')  平均|Δ| = ' + best.v.toFixed(3));
console.log(
  best.dx === 0 && best.dy === 0
    ? '结论：不存在位置偏移 —— 差异纯粹是字形栅格化（边缘抗锯齿取值不同）。'
    : '结论：存在 ' + Math.abs(best.dx) + '/' + Math.abs(best.dy) + ' 像素的位置偏移（差异从 ' +
      base.toFixed(3) + ' 降到 ' + best.v.toFixed(3) + '）—— 这是可修的，不该当成栅格化差异。',
);
console.log('对照图: ' + OUT);
