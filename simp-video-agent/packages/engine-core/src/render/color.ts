/**
 * 颜色工具：只做一件求值层需要的事 —— 在两个颜色之间插值。
 *
 * ★ 为什么必须有它：`style.stroke` 是【字符串】，而动画轨道只驱动数值与字符串的
 *   直接替换。也就是说"颜色渐变"这件事没法靠关键帧表达 ——
 *   只能靠效果层算出一个中间色再交给画笔。
 *
 * ★ 支持的写法刻意收得很窄：`#rgb` / `#rrggbb` / `#rrggbbaa`，以及
 *   `transparent` / `none`（当成全透明黑）。不认的写法**原样返回起点色** ——
 *   宁可"高亮没生效"，也不要为了一个拼错的颜色把整帧求值搞崩。
 */
import type { FieldAtom } from '../doc/types';

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** 解析颜色；解析不了返回 null（调用方据此决定回退行为）。 */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return TRANSPARENT;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return Number.isNaN(r + g + b) ? null : { r, g, b, a: 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
      return Number.isNaN(r + g + b + a) ? null : { r, g, b, a };
    }
  }
  return null;
}

/** 通道值夹到 0..255 并取整。 */
function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

function toHex(n: number): string {
  return clamp255(n).toString(16).padStart(2, '0');
}

export function formatColor(c: Rgba): string {
  const base = '#' + toHex(c.r) + toHex(c.g) + toHex(c.b);
  return c.a >= 255 ? base : base + toHex(c.a);
}

/**
 * 在 from 与 to 之间按 `k` 插值（0 = 全 from，1 = 全 to）。
 *
 * ★ 刻意在 **sRGB 直通道**里插值，不做线性光转换：
 *   画面本来就是按 sRGB 画的，"看起来一半"比"物理上正确的一半"更符合意图，
 *   而且这条路径必须是确定的、可跨语言复算的（不要引 gamma 曲线进来）。
 *
 * ★ 起点解析不出来时**原样返回起点字符串**（而不是悄悄换成目标色）：
 *   高亮不生效是可接受的降级，把颜色换成别的值不是。
 */
export function mixColor(from: string, to: string, k: number): string {
  const t = clamp01(k);
  if (t <= 0) return from;
  const a = parseColor(from);
  const b = parseColor(to);
  if (a === null || b === null) return from;
  return formatColor({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  });
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export type { FieldAtom };
