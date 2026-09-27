/**
 * 公式几何的【文档格式】（方案 B：几何由工具物化，求值层只读点列）。
 *
 * ★ 为什么是这种字符串而不是 JSON：
 *   一个公式的轮廓动辄几百到上千个点，JSON 的括号/键名会把文档撑大好几倍；
 *   而这个格式是**两条后端读同一串**的东西，越简单越不容易分叉。
 *
 * 格式：`x,y x,y x,y;x,y x,y`
 *   · 子路径之间用 `;` 分隔；
 *   · 每个点是 `x,y`（em 单位，y 向下，原点在【基线与左边缘】的交点）；
 *   · 数字由写入方四舍五入到 3 位小数（em 的千分之一，够用且短）。
 *
 * ★ 解码【永不抛异常】：它跑在求值路径里，而求值路径对任何输入都必须能终止
 *   （与其它求值容错口径一致：坏几何不画，问题交给校验器报出来）。
 */
import type { Vec2 } from '../math/vec2';

export type FormulaSubpath = readonly Vec2[];
export type FormulaSubpaths = readonly FormulaSubpath[];

/** 点列 → 紧凑串（写入方用）。 */
export function encodeFormulaGeometry(subpaths: FormulaSubpaths): string {
  return subpaths.map((sp) => sp.map((p) => p.x + ',' + p.y).join(' ')).join(';');
}

/**
 * 紧凑串 → 点列（求值方用）。
 *
 * 容错口径：坏掉的点直接跳过；少于 3 个点的子路径丢掉（填充一个三角形以下没有意义）；
 * 整串解析不出东西就返回空数组。
 */
export function decodeFormulaGeometry(text: string): FormulaSubpaths {
  if (text === '') return [];
  const out: Vec2[][] = [];
  for (const chunk of text.split(';')) {
    const points: Vec2[] = [];
    for (const pair of chunk.split(' ')) {
      if (pair === '') continue;
      const comma = pair.indexOf(',');
      if (comma <= 0) continue;
      const x = Number(pair.slice(0, comma));
      const y = Number(pair.slice(comma + 1));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push({ x, y });
    }
    if (points.length >= 3) out.push(points);
  }
  return out;
}

/** 这个 shape 的几何是不是公式几何（求值层用它分流）。 */
export const FORMULA_SHAPE = 'formula';
