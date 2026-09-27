/**
 * 把 RenderState 画到 Canvas2D 上。
 *
 * 宿主无关：只依赖一个最小的 Canvas2D 接口（浏览器与 @napi-rs/canvas 都满足）。
 * 因此浏览器预览与 headless 导出画的是同一份代码、同一份 RenderState ——
 * 这是"预览=成片"的落地方式（不变量 1）。
 *
 * 规范 §4 的硬约束在这里生效：
 *   - canvas.width/height 就是导出像素，永不使用 devicePixelRatio（由调用方保证）
 *   - 描边宽度、发光半径乘相机 scale 后再画
 *   - 文字"跟随位置、不跟随角度"：字体大小永不放进 scale()
 */
import type { RenderItem, RenderState, ResolvedItemStyle } from '@sva/engine-core';

/** 最小 Canvas2D 接口。只声明我们真正用到的东西。 */
export interface Ctx2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  shadowBlur: number;
  shadowColor: string;
  lineCap: string;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  /** 闭合当前子路径（矩形这类图形要用，见 paintPath 的 closed）。 */
  closePath(): void;
  stroke(): void;
  /** 填充当前路径（矩形底色）。与 fillRect 不是一回事：它走的是路径。 */
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

export interface PaintTheme {
  readonly bg: string;
  readonly fg: string;
  readonly accent: string;
  readonly glow: number;
}

/**
 * 绘制样式。
 *
 * ★ 它现在与 engine-core 的 ResolvedItemStyle 是同一个类型。
 *   原因：动画解析已经上移到求值层（RenderItem.style），画笔不该再自己读一遍静态
 *   style —— 那会让"动画面上的颜色/线宽"和"文档里的值"分叉。
 *   这里的 styleOf 只作为【退回路径】保留：拿不到 RenderItem.style 的调用方
 *   （例如只画局部项的第三方）仍然能给出样式。
 */
export type ItemStyle = ResolvedItemStyle;

export interface PaintOptions {
  readonly theme: PaintTheme;
  /** 对象 id → 该对象的绘制样式。线宽用【世界单位】表示。 */
  readonly styleOf?: (item: RenderItem) => ResolvedItemStyle;
  /**
   * 文字用的字体族。
   * ★ 必须显式指定自托管字体，落到系统 sans-serif 就等于把确定性交给了机器。
   */
  readonly fontFamily?: string;
}

/** 自托管字体族名。与 preview.html 的 @font-face 必须一致。 */
/**
 * 自托管字体栈。★ 两条渲染路径（canvas / Chrome）与面板【必须】用同一串。
 *
 * ★ 为什么有第三个族 SvaMath：实测发现 `2π` 的 π 会画成豆腐块 ——
 *   Inter 的 latin 子集与 Noto Sans SC 的中文子集【都不含希腊字母】，
 *   而"用 π 讲正弦"正是这个引擎的日常。Noto Sans Math 覆盖希腊字母与常用数学符号，
 *   且它同时是将来做公式（KaTeX / 数学排版）必须有的那块地基。
 *   浏览器与 skia 都会沿这个列表做**逐字回退**，所以缺字时会落到 SvaMath 上。
 */
export const SVA_FONT_STACK = 'SvaInter, SvaNotoCJK, SvaMath, sans-serif';

/**
 * 取一项的绘制样式：求值层解析好的优先，其次才问 styleOf。
 *
 * 判据用 hasOwnProperty 而不是 `!== undefined`：动画可以把 width 显式驱动成 0，
 * 那是一个有效取值，不该被当成"没有动画"退回静态值。
 */
/**
 * 取一项的绘制样式：求值层解析好的优先，其次才问 styleOf。
 *
 * ★★ 这个白名单【必须与 ResolvedItemStyle 的字段一一对应】。
 *   实测代价（P1 形状系统的像素测试当场抓到）：加了 fill / fillOpacity 之后
 *   忘了往这里加，于是"填充"在求值层是对的、到画笔时被静默丢掉 ——
 *   方框只剩描边，而结构断言全是绿的（它们只看 RenderItem）。
 *   以后往 ResolvedItemStyle 加字段，这里必须一起加；类型能帮上忙的话
 *   （比如改成遍历 key）就别维护第二份清单。
 */
function styleFor(item: RenderItem, fallback: ResolvedItemStyle): ResolvedItemStyle {
  const own = item.style;
  if (own === undefined) return fallback;
  const out: ResolvedItemStyle = {};
  const keys = ['stroke', 'width', 'glow', 'fontSize', 'fill', 'fillOpacity', 'headSize'] as const;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(own, key)) {
      const v = own[key];
      if (v !== undefined) (out as Record<string, unknown>)[key] = v;
      continue;
    }
    const f = fallback[key];
    if (f !== undefined) (out as Record<string, unknown>)[key] = f;
  }
  return out;
}

export function paintScene(ctx: Ctx2D, state: RenderState, opts: PaintOptions): void {
  const { w, h } = state.viewport;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.fillStyle = opts.theme.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const fontFamily = opts.fontFamily ?? SVA_FONT_STACK;
  for (const item of state.items) {
    if (item.visibleFraction <= 0 || item.opacity <= 0) continue;
    const style = styleFor(item, opts.styleOf?.(item) ?? {});
    paintItem(ctx, item, style, opts.theme, state.camera.scale, fontFamily);
  }
}

function paintItem(
  ctx: Ctx2D,
  item: RenderItem,
  style: ResolvedItemStyle,
  theme: PaintTheme,
  cameraScale: number,
  fontFamily: string,
): void {
  const stroke = style.stroke ?? theme.accent;
  const widthWorld = style.width ?? 3;
  const glow = style.glow ?? theme.glow;

  ctx.save();
  ctx.globalAlpha = item.opacity;
  ctx.strokeStyle = stroke;
  // ★ 描边宽度乘相机 scale 后再画
  ctx.lineWidth = Math.max(0.1, widthWorld * cameraScale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (glow > 0) {
    ctx.shadowColor = stroke;
    ctx.shadowBlur = glow * 16 * cameraScale;
  } else {
    ctx.shadowBlur = 0;
  }

  if (item.kind === 'path' && item.path !== undefined && item.path.length >= 2) {
    paintPath(ctx, item, style, cameraScale, theme);
  } else if (item.kind === 'text' && item.text !== undefined) {
    // 文字只把锚点定位到屏幕，字号不受相机 scale 影响（规范 §4）
    const t = item.text;
    ctx.shadowBlur = 0;
    ctx.fillStyle = stroke;
    // 粗体走【自托管的 700 字重】（sans-serif 合成粗体会让两条后端分叉）
    ctx.font = (t.bold ? '700 ' : '') + t.fontSize + 'px ' + fontFamily;
    ctx.textAlign = t.align === 'center' ? 'center' : t.align === 'right' ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    /**
     * ★ 逐行画，且【不在这里 measureText】：
     *   折行已经在 engine-core 的 render/text.ts 里算完了。
     *   画笔一旦自己量文本再决定怎么折，canvas 与 Chrome 就会折出不同的行 ——
     *   而折行是画面的一部分（这正是"预览 ≠ 成片"最隐蔽的一种来源）。
     *
     * 竖向：把整块文字围绕锚点【居中】铺开（与求值层算包围盒用的是同一套算术），
     * 所以 box 与画出来的行永远对得上。
     */
    const first = t.anchor.y - ((t.lines.length - 1) * t.lineHeight) / 2;
    for (const [i, line] of t.lines.entries()) {
      ctx.beginPath();
      ctx.fillText(line, t.anchor.x, first + i * t.lineHeight);
    }
  } else if (item.kind === 'formula' && item.subpaths !== undefined) {
    /**
     * 公式：所有子路径作为【一条路径】填充。
     *
     * ★ 必须是一条路径：字形里的洞（o 的中间、分数线两侧）靠子路径的绕向表达，
     *   逐个子路径单独 fill 会把洞填实 —— 那样"e"会变成一个实心块。
     *   几何已在求值层算好（屏幕像素），这里只负责画。
     */
    ctx.shadowBlur = 0;
    ctx.fillStyle = style.fill ?? stroke;
    ctx.beginPath();
    for (const sp of item.subpaths) {
      const first = sp[0];
      if (first === undefined) continue;
      ctx.moveTo(first.x, first.y);
      for (const p of sp.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
    }
    ctx.fill();
  } else if (item.kind === 'points' && item.path !== undefined) {
    for (const p of item.path) {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + 0.01, p.y);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * 画一条折线（曲线 / 矩形 / 线段都走这里）。
 *
 * ★ 三件事都必须乘相机 scale（规范 §4 的硬约束）：
 *   描边宽度、发光半径、**箭头大小**。少了最后一个，镜头一推近箭头就会
 *   看起来像一根针 —— 而"按比例缩放"正是预览与导出能一致的前提。
 *
 * ★ 填充与描边分开画：填充先、描边后，且填充有自己的 alpha。
 *   合成一个 alpha 就做不出"半透明底 + 实心边"，而那正是框图最常见的样子。
 */
function paintPath(
  ctx: Ctx2D,
  item: RenderItem,
  style: ResolvedItemStyle,
  cameraScale: number,
  theme: PaintTheme,
): void {
  const path = item.path;
  if (path === undefined) return;
  const first = path[0];
  if (first === undefined) return;

  const trace = (): void => {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i++) {
      const p = path[i];
      if (p === undefined) continue;
      ctx.lineTo(p.x, p.y);
    }
    if (item.closed === true) ctx.closePath();
  };

  // ── 填充（只有给了 fill 才画）────────────────────────────────
  const fill = style.fill;
  if (fill !== undefined && fill !== 'transparent' && fill !== 'none') {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * clamp01(style.fillOpacity ?? 1);
    // 填充不吃发光：光晕是描边的事，给填充加 shadow 会糊成一团
    ctx.shadowBlur = 0;
    ctx.fillStyle = fill;
    trace();
    ctx.fill();
    ctx.globalAlpha = alpha;
  }

  // ── 描边 ────────────────────────────────────────────────────
  trace();
  ctx.stroke();

  // ── 箭头（末端的实心三角）────────────────────────────────────
  // ★ 门是 item.arrow（几何决策），大小是 style.headSize（样式）。
  //   两者曾共用一个字段，于是 head=none 的线也被画上了箭头。
  const headSize = item.arrow === true ? style.headSize ?? 0.32 : 0;
  if (headSize > 0 && path.length >= 2) {
    const tip = path[path.length - 1];
    const prev = path[path.length - 2];
    if (tip !== undefined && prev !== undefined) {
      const dx = tip.x - prev.x;
      const dy = tip.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-6) {
        /**
         * ★★ 换成像素要乘的是 `cameraScale`（相机 zoom），**不是** `base`。
         *
         *   这一条我实测踩了两次，值得写清楚：
         *   · `headSize` 与 `style.width` 的单位都是【像素】（与曲线的 width 同口径），
         *     所以换算是 `像素值 × cameraScale`；
         *   · 而我一度把 headSize 按【世界单位】实现（默认 0.32），于是恒等相机下
         *     箭头只有 0.32 像素 —— **画出来了，但肉眼和像素测试都看不见**。
         *     症状是"末端 30 列全是线宽的 2px，一个三角形都没有"。
         *   · 要按世界单位也给得了，那就得乘 base（fit.base）；但线宽走的是像素口径，
         *     两套混在一起迟早出错，所以这里统一成像素。
         */
        const size = headSize * cameraScale;
        const ux = dx / len;
        const uy = dy / len;
        /**
         * 两翼 = 从箭尖出发、朝【与来向相反】的方向张开 ±30°：
         * 把 -u = (-ux, -uy) 分别旋转 ±30° 就得到两个翼方向。
         */
        const cos = Math.cos(Math.PI / 6);
        const sin = Math.sin(Math.PI / 6);
        const w1x = tip.x + size * (-ux * cos - uy * sin);
        const w1y = tip.y + size * (-uy * cos + ux * sin);
        const w2x = tip.x + size * (-ux * cos + uy * sin);
        const w2y = tip.y + size * (-uy * cos - ux * sin);
        /**
         * ★ 箭头必须用【描边色】填充，不能沿用当时生效的 fillStyle。
         *   实测踩到：上面画矩形底色时设过 fillStyle，到这里箭头就被涂成了
         *   背景色 —— 症状是"有箭头的图反而比没箭头的墨更少"，而结构断言全绿。
         *   箭头是【线条的端点】，它的颜色属于线，不属于任何填充。
         */
        ctx.fillStyle = style.stroke ?? theme.accent;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(w1x, w1y);
        ctx.lineTo(w2x, w2y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
