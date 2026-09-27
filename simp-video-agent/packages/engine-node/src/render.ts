/**
 * headless 渲染：Scene Doc + 时间戳 → PNG。
 *
 * 用 @napi-rs/canvas（用户 P0 清单第 8 条允许的 stopgap）。
 * Chrome/Puppeteer 在本环境的受限沙箱里起不来（见 docs/environment.md），
 * P8 再评估是否切回浏览器。
 *
 * 关键：这里调用的是 engine-core 的 evaluate + engine-render 的 paintScene，
 * 与浏览器预览是同一份代码、同一份 RenderState。
 *
 * ★ 字体：本模块【必须】先用 registerHeadlessFonts 注册自托管字体，
 *   否则 @napi-rs/canvas 会回退到系统字体（详见下面的注释）。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  evaluate,
  filterRenderStateByScene,
  resolveItemStyle,
  type ResolvedItemStyle,
  type SceneDoc,
  type SceneId,
} from '@sva/engine-core';
import { paintScene, SVA_FONT_STACK } from '@sva/engine-render';

/**
 * 注册自托管字体。
 *
 * ★ 这是一处实测发现的确定性地基缺口：
 *   paintScene 用的字体族是 'SvaInter, SvaNotoCJK, sans-serif'，浏览器那条路
 *   （preview.html）有 @font-face + document.fonts.load 把它们加载起来 ——
 *   而 headless 这条路【从来没注册过】。于是 canvas 一路回退到系统字体：
 *   48px 字号下"正弦"的测量宽度从应有的 96px 掉到 48px（每字 24px），
 *   而项目铁律写着"落到系统 sans-serif 就等于把确定性交给了机器"。
 *   两条导出后端的文字像素差异峰值 244 就来自这里。
 *
 * 族名必须与 paint.ts 的 SVA_FONT_STACK 一致，否则注册了也不会被用上。
 */
const FONT_FILES: readonly (readonly [string, string])[] = [
  ['inter-latin-400.woff2', 'SvaInter'],
  ['inter-latin-700.woff2', 'SvaInter'],
  ['noto-sans-sc-400.woff2', 'SvaNotoCJK'],
  // 粗体：同一族的 700 字重。★ 没有它的话，"粗体"只能靠栅格化器合成 ——
  //   而合成结果在 canvas 与 Chrome 上不保证一致，那正是"预览 ≠ 成片"。
  ['noto-sans-sc-700.woff2', 'SvaNotoCJK'],
  // 希腊字母与数学符号（π / θ / ∑ / ∫ …）。没有它，"用 π 讲正弦"会画成豆腐块。
  ['noto-sans-math-400.woff2', 'SvaMath'],
];

let fontsRegistered = false;

export interface FontRegisterResult {
  readonly dir: string;
  readonly registered: readonly string[];
  readonly missing: readonly string[];
}

/**
 * 让 headless 渲染用上自托管字体。幂等。
 * 找不到字体文件时把它列进 missing 而不是抛 —— 由调用方决定这算不算致命
 * （见 assertFontsRegistered）。
 */
export function registerHeadlessFonts(fontsDir: string = defaultFontsDir()): FontRegisterResult {
  const registered: string[] = [];
  const missing: string[] = [];
  for (const [file, family] of FONT_FILES) {
    const path = join(fontsDir, file);
    if (!existsSync(path)) {
      missing.push(path);
      continue;
    }
    try {
      GlobalFonts.registerFromPath(path, family);
      if (!registered.includes(family)) registered.push(family);
    } catch (err) {
      missing.push(path + '（注册失败：' + (err instanceof Error ? err.message : String(err)) + '）');
    }
  }
  fontsRegistered = registered.length > 0;
  return { dir: fontsDir, registered, missing };
}

/**
 * 强制要求字体已注册。
 *
 * 与 preview 侧暴露 __FONT_STATUS__ 是同一件事的两个方向：那边把状态报出来，
 * 这边在没有字体时直接报错。理由一样 —— 字体缺失时渲染照样"成功"，
 * 只是确定性悄悄丢了，那种失败最难发现。
 */
export function assertFontsRegistered(): void {
  if (!fontsRegistered) {
    throw new Error(
      'headless 渲染没有注册自托管字体，会回退到系统字体（确定性丢失）。' +
        '请先调 registerHeadlessFonts()，字体缺了就该让导出失败，而不是悄悄换字体。',
    );
  }
}

/** 字体目录：从本模块位置向上找 packages/engine-render/assets/fonts（源码与 dist 两种情形都成立）。 */
export function defaultFontsDir(): string {
  const start = typeof import.meta.dirname === 'string' ? import.meta.dirname : process.cwd();
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'packages', 'engine-render', 'assets', 'fonts');
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'packages', 'engine-render', 'assets', 'fonts');
}

/** 当前实际用的完整字体栈（含兜底），供校验脚本比对。 */
export const HEADLESS_FONT_STACK = SVA_FONT_STACK;

export interface RenderedFrame {
  readonly t: number;
  readonly png: Buffer;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  /** 这一帧属于哪个镜头（null = 镜头之间的空档帧，画面上只有背景）。 */
  readonly sceneId: SceneId | null;
}

/**
 * 退回用的样式解析。
 *
 * ★ 正常情况下用不到：evaluate 已经把【动画叠加后】的样式放进 RenderItem.style，
 *   画笔优先消费它。这里只在拿不到 RenderItem.style 时兜底 ——
 *   如果这里的结果与 evaluate 的结果不一致，说明有人把样式解析实现了两遍。
 */
function styleResolver(doc: SceneDoc) {
  return (item: { id: string }): ResolvedItemStyle => {
    const obj = doc.objects[item.id];
    if (obj === undefined) return {};
    return resolveItemStyle(obj);
  };
}

export interface RenderFramesOptions {
  /**
   * 只渲染这一镜（null = 渲染"空档帧"，即只有背景）。
   *
   * ★ 不传 = 渲染全部对象 = **单镜头旧行为**（也用于"看整片铺开"的诊断）。
   *   这是刻意的：多镜头是能力，不是对原有调用的强制改造，
   *   否则每一处旧调用都会被连坐。
   */
  readonly sceneId?: SceneId | null;
}

/**
 * 渲染若干帧。canvas.width/height 就是导出像素，不使用 devicePixelRatio。
 *
 * ★ 第一次调用会自动注册自托管字体（幂等），并在字体缺失时【直接报错】。
 *   理由见 registerHeadlessFonts 的注释：没有字体的渲染会"成功"，
 *   只是悄悄换成了系统字体 —— 那正是这个项目最不能接受的那类失败。
 *
 * ★ 镜头过滤作用在求值【之后】：evaluate 保持纯函数（不变量 1），
 *   过滤只重建 items 数组，不动相机与矩阵。
 */
export function renderFrames(
  doc: SceneDoc,
  timestamps: readonly number[],
  opts: RenderFramesOptions = {},
): readonly RenderedFrame[] {
  if (!fontsRegistered) {
    const r = registerHeadlessFonts();
    if (r.registered.length === 0) {
      throw new Error('headless 渲染找不到自托管字体：' + r.missing.join('；'));
    }
  }
  const width = doc.meta.viewport[0];
  const height = doc.meta.viewport[1];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const styleOf = styleResolver(doc);
  const sceneId = opts.sceneId ?? null;
  const filterByScene = opts.sceneId !== undefined;

  const out: RenderedFrame[] = [];
  for (const t of timestamps) {
    const state = evaluate(doc, t);
    const visible = filterByScene ? filterRenderStateByScene(state, doc, sceneId) : state;
    paintScene(ctx as unknown as Parameters<typeof paintScene>[0], visible, { theme: doc.theme, styleOf });
    const png = canvas.toBuffer('image/png');
    out.push({
      t,
      png,
      sha256: createHash('sha256').update(png).digest('hex'),
      width,
      height,
      sceneId: filterByScene ? sceneId : null,
    });
  }
  return out;
}
