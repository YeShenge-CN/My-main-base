/**
 * 文字度量的跨后端对比（决定性实验）。
 *
 * 用法（需要 danger-full-access）：
 *   node packages/agent-tools/dist/diag-text-metrics.mjs
 *
 * ★ 目的：把"文字像素差异"这件事归因到底。
 *   两种可能：
 *     A) 两条路用了不同的字体 → 字形不同、度量不同 → 严重问题（确定性没了）
 *     B) 同一个字体、不同的栅格化 → 度量相同或极近，只是每像素略有差别 → 可接受
 *   像素差异本身分不出这两种，度量可以。
 *
 * 做法：在 canvas 侧用 measureText，在 Chrome 侧用 canvas 2D 的 measureText，
 * 同一族名（SvaInter / SvaNotoCJK）+ 同一字号，比同一串文字的宽度。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { defaultFontsDir, registerHeadlessFonts } from '@sva/engine-node/headless';
import { launchChrome } from '@sva/engine-node/chrome';
import { buildPreviewBundle } from '@sva/engine-node/internal';
import { startStaticServer } from '@sva/engine-node/internal';

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

/**
 * 样本：[文字, 【字体说明串】, 字号]。
 *
 * ★★ 这里必须是【整条 font-family 串】而不是单个族名 —— 实测踩过一次：
 *   混排样本（中文 + 希腊字母）在 canvas 侧只写了 `SvaMath`（CJK 缺字），
 *   而 Chrome 侧写的是 `SvaMath, sans-serif`（CJK 回退到系统字体），
 *   于是量出 19.93% 的差 —— 但那是【探针在比两件不同的事】，不是后端分叉。
 *   契约是"同一串字体栈在两个后端上一致"，所以两边必须用【一模一样】的那一串。
 */
/** 样本模板：字体串里的 {size} 会被替换成字号（两侧替换结果必须逐字相同）。 */
const STACK = 'SvaInter, SvaNotoCJK, SvaMath, sans-serif';
const RAW_SAMPLES: readonly (readonly [string, string, number])[] = [
  ['正弦曲线 sin(x)', '{size}px SvaNotoCJK', 48],
  ['sin ABC 123', '{size}px SvaInter', 48],
  ['信号采样', '{size}px SvaNotoCJK', 32],
  // 粗体：自托管的 700 字重（两条后端都必须选到同一份字面）。
  // ★ 样本必须【单语种】：给单一族的混排文本，Chrome 会对缺字静默回退到系统字体，
  //   而 canvas 不会 —— 量到的是回退行为，不是字重差异（实测踩过两次）。
  ['粗体中文', '700 {size}px SvaNotoCJK', 48],
  ['Bold Latin', '700 {size}px SvaInter', 48],
  // ★ 希腊字母与数学符号：这一条是实测补上的 —— `2π` 曾经画成豆腐块
  //   （Inter 的 latin 子集与 Noto Sans SC 的中文子集都不含希腊字母）。
  //   混排样本要走整条栈，才能同时验证"逐字回退"在两个后端上一致。
  ['周期 2π 与 sin θ', '{size}px ' + STACK, 48],
  ['∑ ∫ √ ≤ ≠', '{size}px ' + STACK, 48],
];

const SAMPLES: readonly (readonly [string, string, number])[] = RAW_SAMPLES.map(
  ([text, template, size]) => [text, template.replace('{size}', String(size)), size] as const,
);

registerHeadlessFonts();
console.log('canvas 字体目录: ' + defaultFontsDir());
console.log('canvas 已注册 : ' + JSON.stringify(GlobalFonts.families.filter((f) => f.family.startsWith('Sva')).map((f) => f.family)));

const canvasWidths: Record<string, number> = {};
{
  const ctx = createCanvas(600, 120).getContext('2d');
  for (const [text, fontSpec, size] of SAMPLES) {
    // fontSpec 是【完整的字体串】（可能带 700 字重），两侧逐字相同
    ctx.font = fontSpec;
    canvasWidths[text + '@' + size] = ctx.measureText(text).width;
  }
}

// ── Chrome 侧：起一个极小的探针页面（不改动仓库里的文件） ──────────────
const probeHtml = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/packages/engine-render/preview/preview.html">
<style>@font-face{font-family:'SvaInter';src:url('/packages/engine-render/assets/fonts/inter-latin-400.woff2') format('woff2');font-display:block}
@font-face{font-family:'SvaInter';font-weight:700;src:url('/packages/engine-render/assets/fonts/inter-latin-700.woff2') format('woff2');font-display:block}
@font-face{font-family:'SvaNotoCJK';src:url('/packages/engine-render/assets/fonts/noto-sans-sc-400.woff2') format('woff2');font-display:block}
@font-face{font-family:'SvaNotoCJK';font-weight:700;src:url('/packages/engine-render/assets/fonts/noto-sans-sc-700.woff2') format('woff2');font-display:block}
@font-face{font-family:'SvaMath';src:url('/packages/engine-render/assets/fonts/noto-sans-math-400.woff2') format('woff2');font-display:block}</style>
</head><body><script>
window.__READY__ = false;
// ★ 每个【实际会用到的字重】都要显式 load：只声明不 load 会静默用合成粗体，
//   于是量到的是"假粗体"的宽度（实测踩过）。
Promise.all([
  document.fonts.load('400 48px SvaInter'), document.fonts.load('700 48px SvaInter'),
  document.fonts.load('400 48px SvaNotoCJK'), document.fonts.load('700 48px SvaNotoCJK'),
  document.fonts.load('400 48px SvaMath'),
]).then(async () => {
  await document.fonts.ready;
  const c = document.createElement('canvas'); const ctx = c.getContext('2d');
  const out = {};
  for (const [text, fontSpec, size] of ${JSON.stringify(SAMPLES)}) {
    // ★ 与 canvas 侧逐字相同的那一串（多一个 ", sans-serif" 就变成比两件事）
    ctx.font = fontSpec;
    out[text + '@' + size] = ctx.measureText(text).width;
  }
  window.__METRICS__ = out;
  window.__FONTCHECK__ = {
    inter: document.fonts.check('400 48px SvaInter'),
    inter700: document.fonts.check('700 48px SvaInter'),
    cjk: document.fonts.check('400 48px SvaNotoCJK'),
    cjk700: document.fonts.check('700 48px SvaNotoCJK'),
    math: document.fonts.check('400 48px SvaMath'),
  };
  window.__READY__ = true;
}).catch(e => { window.__ERR__ = String(e); window.__READY__ = true; });
</script></body></html>`;

const outDir = join(ROOT, 'out', 'text-metrics');
mkdirSync(outDir, { recursive: true });
const { writeFileSync } = await import('node:fs');
writeFileSync(join(outDir, 'probe.html'), probeHtml);

await buildPreviewBundle(join(ROOT, 'packages', 'panel', 'src', 'boot.ts'), join(ROOT, 'out', 'panel-bundle.js'));

const server = await startStaticServer(ROOT);
const session = await launchChrome({ userDataDir: join(outDir, 'chrome-profile') });
try {
  const page = await session.browser.newPage();
  await page.setViewport({ width: 400, height: 200, deviceScaleFactor: 1 });
  await page.goto(server.origin + '/out/text-metrics/probe.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (globalThis as { __READY__?: boolean }).__READY__ === true, { timeout: 30000 });
  const metrics = (await page.evaluate(
    () => (globalThis as unknown as { __METRICS__?: Record<string, number> }).__METRICS__ ?? {},
  )) as Record<string, number>;
  const check = (await page.evaluate(
    () => (globalThis as unknown as { __FONTCHECK__?: { inter: boolean; cjk: boolean } }).__FONTCHECK__ ?? null,
  )) as { inter: boolean; cjk: boolean } | null;
  const err = (await page.evaluate(
    () => (globalThis as unknown as { __ERR__?: string }).__ERR__ ?? null,
  )) as string | null;

  console.log('chrome 字体检查: ' + JSON.stringify(check) + (err === null ? '' : ' ERR=' + err));
  console.log('');
  console.log('文字'.padEnd(22) + 'canvas宽度   chrome宽度   差(px)   差(%)');
  let worstPct = 0;
  for (const [text, , size] of SAMPLES) {
    const key = text + '@' + size;
    const a = canvasWidths[key] ?? Number.NaN;
    const b = metrics[key] ?? Number.NaN;
    const d = Math.abs(a - b);
    const pct = a === 0 ? 0 : (d / a) * 100;
    if (pct > worstPct) worstPct = pct;
    console.log(
      key.padEnd(22) + a.toFixed(2).padStart(9) + b.toFixed(2).padStart(12) + d.toFixed(2).padStart(9) + pct.toFixed(2).padStart(8),
    );
  }
  console.log('');
  console.log(
    worstPct < 2
      ? '结论：两条后端用的是【同一个字体】（度量差 ' + worstPct.toFixed(2) + '% < 2%）—— 像素差异只是栅格化。'
      : '⚠ 结论：度量差 ' + worstPct.toFixed(2) + '% —— 两条后端可能用了【不同字体】，需要继续查。',
  );
  void createHash;
} finally {
  await session.close();
  await server.close();
}
