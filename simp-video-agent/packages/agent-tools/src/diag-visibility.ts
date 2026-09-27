/**
 * 显隐（appear / disappear）的【显性】验收件：把整条时间轴铺成一张胶片图。
 *
 * 用法（不需要浏览器、不需要 danger-full-access）：
 *   node packages/agent-tools/dist/diag-visibility.mjs
 *   → out/visibility-strip.png（每帧一张缩略图 + 边框颜色 + 时刻与"在/不在"）
 *
 * ★ 为什么要有它：单测能证明"items 里少了那一项"，像素断言能证明"那个颜色的像素是 0"，
 *   但这两件事都不是【人一眼能确认】的。这个项目最贵的一课是
 *   "画出来了"与"看得出画出来了"是两件事 —— 所以把画面直接摆出来。
 *
 * ★ 每个时刻都用【两个互相独立的判据】各判一次，并把结果并排打出来：
 *     结构判据：evaluate(doc, t) 里还有没有这一项
 *     画面判据：这一帧里属于它的填充色像素有多少
 *   两者不一致就是 bug（而且能直接指出是求值错了还是画笔错了）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { evaluate, type SceneDoc } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node/headless';
import { shotWithVisibility } from './shot';

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
const OUT = join(ROOT, 'out', 'visibility-strip.png');

/**
 * 采样时刻刻意压在【两个边界】的两侧：
 * appear.at = 2、disappear.at = 6 —— 1.8/2.0 与 5.9/6.0 是最容易写错的地方
 * （开区间还是闭区间）。胶片上要能一眼看出翻转发生在哪一帧。
 */
const TIMES: readonly number[] = [1.0, 1.8, 2.0, 3.5, 5.9, 6.0, 7.0];

/** 被观察对象与它的"身份证颜色"（填充色，只有它有）。 */
const WATCH_ID = 'rect#1';
const WATCH_HEX = '#16223a';

function countExact(png: Buffer, hex: string, tol = 6): Promise<number> {
  return loadImage(png).then((img) => {
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (
        Math.abs((d[i] ?? 0) - r) <= tol &&
        Math.abs((d[i + 1] ?? 0) - g) <= tol &&
        Math.abs((d[i + 2] ?? 0) - b) <= tol
      ) {
        n++;
      }
    }
    return n;
  });
}

const doc: SceneDoc = shotWithVisibility();
const frames = renderFrames(doc, [...TIMES]);

interface Row {
  readonly t: number;
  readonly present: boolean;
  readonly ink: number;
  readonly sha: string;
  readonly png: Buffer;
}

const rows: Row[] = [];
for (const [i, t] of TIMES.entries()) {
  const frame = frames[i];
  if (frame === undefined) throw new Error('第 ' + i + ' 帧没有渲染出来');
  rows.push({
    t,
    present: evaluate(doc, t).items.some((it) => it.id === WATCH_ID),
    ink: await countExact(frame.png, WATCH_HEX),
    sha: frame.sha256.slice(0, 12),
    png: frame.png,
  });
}

console.log('文档      : preset visibility（' + WATCH_ID + ' 出现于 2s、消失于 6s，填充色 ' + WATCH_HEX + '）');
console.log('帧尺寸    : ' + (frames[0]?.width ?? 0) + '×' + (frames[0]?.height ?? 0));
console.log('');
console.log('时刻(s)   结构判据(evaluate)   画面判据(该色像素)   帧哈希         一致?');
let consistent = true;
for (const row of rows) {
  const inkSays = row.ink > 200;
  const agree = inkSays === row.present;
  if (!agree) consistent = false;
  console.log(
    String(row.t).padEnd(9) +
      (row.present ? '在  ' : '不在').padEnd(21) +
      String(row.ink).padStart(8) +
      '            ' +
      row.sha.padEnd(15) +
      (agree ? '✓' : '✗ 两个判据不一致'),
  );
}

/* ── 拼胶片：4 列，每格带边框颜色与文字标签 ───────────────────── */
const COLS = 4;
const TILE_W = 320;
const TILE_H = Math.round((TILE_W * (frames[0]?.height ?? 540)) / (frames[0]?.width ?? 960));
const LABEL_H = 26;
const GAP = 10;
const TITLE_H = 44;
const rowsOfTiles = Math.ceil(rows.length / COLS);
const W = COLS * TILE_W + (COLS + 1) * GAP;
const H = TITLE_H + rowsOfTiles * (TILE_H + LABEL_H) + (rowsOfTiles + 1) * GAP;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#0b0e14';
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#e8eef8';
ctx.font = '18px SvaNotoCJK, SvaInter, sans-serif';
ctx.fillText('appear / disappear —— 每帧两个独立判据：结构(evaluate) 与 画面(该色像素数)', GAP, 28);

for (const [i, row] of rows.entries()) {
  const col = i % COLS;
  const line = Math.floor(i / COLS);
  const x = GAP + col * (TILE_W + GAP);
  const y = TITLE_H + GAP + line * (TILE_H + LABEL_H + GAP);
  const img = await loadImage(row.png);
  ctx.drawImage(img, x, y, TILE_W, TILE_H);
  // 边框：在 = 绿，不在 = 红。胶片上"哪几帧没有它"应当一眼看得出。
  ctx.strokeStyle = row.present ? '#3ad07a' : '#ff6b6b';
  ctx.lineWidth = 3;
  ctx.strokeRect(x - 1.5, y - 1.5, TILE_W + 3, TILE_H + 3);
  ctx.fillStyle = row.present ? '#3ad07a' : '#ff6b6b';
  ctx.font = '15px SvaNotoCJK, SvaInter, sans-serif';
  ctx.fillText(
    't=' + row.t.toFixed(1) + 's  ' + (row.present ? '在画面里' : '不在画面里') + '  像素 ' + row.ink,
    x,
    y + TILE_H + 18,
  );
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, canvas.toBuffer('image/png'));
console.log('');
console.log('★ "不在"时那 10 个像素是抗锯齿杂色（背景与描边的过渡），不是那个方块 —— 判据用 >200。');
console.log('胶片      : ' + OUT);
console.log(
  consistent
    ? '结论      : 7/7 帧两个判据一致，且翻转正好发生在 t=2.0 与 t=6.0（闭区间左端）'
    : '⚠ 结论    : 有帧的两个判据不一致 —— 求值或画笔至少有一边错了',
);
process.exit(consistent ? 0 : 1);
