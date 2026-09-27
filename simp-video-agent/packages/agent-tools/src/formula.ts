/**
 * 公式 → 几何（方案 B：几何由【工具】物化进文档，求值层不认识 LaTeX）。
 *
 * ★ 为什么是 MathJax 而不是 KaTeX：
 *   KaTeX 产出的是 HTML + CSS（靠浏览器的排版引擎算位置），**在 Node 里拿不到坐标**；
 *   MathJax 的 SVG 输出把每个字形变成 <path d="...">，配合 liteAdaptor 完全不需要浏览器。
 *   我们要的正是"几何"，所以这条路是唯一一条既不用浏览器、又能保住确定性的。
 *
 * ★ 为什么在【工具】里做，而不是在求值层：
 *   求值层是纯函数（铁律 1），不能依赖 LaTeX 引擎；而且"几何"一旦物化进文档，
 *   两条渲染后端画的就是同一份点列 —— 预览 = 成片因此是结构性成立的，
 *   不是靠两边实现得一样。
 *
 * 输出坐标约定（与文档里的其它几何一致、刻意做得可读）：
 *   · 单位 **em**（1 em = 当前字号），与字号无关地存下来 —— 于是字号可以动画、几何不用重算；
 *   · y **向下**，原点在【基线与左边缘】的交点（SVG 的约定，MathJax 出来的就是它）；
 *   · width / ascent / depth 也是 em：包围盒 = [0,width] × [-ascent, depth]。
 */
import { encodeFormulaGeometry, type FormulaSubpaths, type Vec2 } from '@sva/engine-core';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

/** MathJax 的内部单位：每 em 1000 个单位（它的字体数据就是这么定的）。 */
const UNITS_PER_EM = 1000;
/** 一个 em 里有多少 ex —— MathJax 排版时用的基准（16px 字号配 8px x-height）。 */
const EX_PER_EM = 2;

export type Point = readonly [number, number];
/** 展平过程中的临时表示（元组比对象轻；最终会转成 engine-core 的 Vec2 点列）。 */
type FlatSubpath = readonly Point[];

export interface FormulaGeometry {
  readonly source: string;
  /** 全部子路径（字形轮廓 + 分数线这类规则图形）。它们要作为【一条】路径填充。 */
  readonly subpaths: FormulaSubpaths;
  /** 宽度（em）。 */
  readonly width: number;
  /** 基线以上的高度（em）。 */
  readonly ascent: number;
  /** 基线以下的深度（em）。 */
  readonly depth: number;
}

/* ── 仿射矩阵（只支持 translate / scale，遇到别的就报错）───────── */

interface Mat {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function apply(m: Mat, p: Point): Point {
  return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];
}

/**
 * 解析 transform 属性，**只认 translate / scale**。
 *
 * ★ 遇到不认识的（rotate / skew / matrix）直接抛：宁可当场红，
 *   也不要悄悄少乘一个变换 —— 那会让公式歪一点点，而"歪一点点"没人看得出原因。
 */
function parseTransform(value: string | undefined): Mat {
  if (value === undefined || value.trim() === '') return IDENTITY;
  let out = IDENTITY;
  const re = /(translate|scale)\s*\(([^)]*)\)/g;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    matched += m[0];
    const nums = (m[2] ?? '').split(',').map((s) => Number(s.trim()));
    if (m[1] === 'translate') {
      out = multiply(out, { a: 1, b: 0, c: 0, d: 1, e: nums[0] ?? 0, f: nums[1] ?? 0 });
    } else {
      const sx = nums[0] ?? 1;
      const sy = nums[1] ?? sx;
      out = multiply(out, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    }
  }
  const stripped = value.replace(/\s+/g, '');
  if (stripped.replace(/translate\([^)]*\)|scale\([^)]*\)/g, '') !== '') {
    throw new Error('公式几何：不支持的 transform：' + value);
  }
  void matched;
  return out;
}

/* ── 路径 data 的展平（曲线按控制多边形长度自适应细分）────────── */

interface FlatPath {
  readonly points: Point[];
  readonly closed: boolean;
}

/** 把 MathJax 的 path data 展平成折线（坐标仍是原始单位，变换稍后统一乘）。 */
export function flattenPathData(d: string): readonly FlatPath[] {
  const tokens = d.match(/[MmLlHhVvCcQqSsTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const out: FlatPath[] = [];
  let current: Point[] = [];
  let closed = false;
  let cursor: Point = [0, 0];
  let start: Point = [0, 0];
  let i = 0;
  /** 上一段的控制点（S/T 要靠它做"平滑"反射）。MathJax 的字体轮廓大量用它。 */
  let lastCubicControl: Point | null = null;
  let lastQuadControl: Point | null = null;

  const num = (): number => Number(tokens[i++] ?? '0');
  const push = (p: Point): void => {
    current.push(p);
    cursor = p;
  };
  const finish = (): void => {
    if (closed && current.length > 0) {
      const first = current[0];
      if (first !== undefined && (cursor[0] !== first[0] || cursor[1] !== first[1])) current.push(first);
    }
    if (current.length >= 2) out.push({ points: current, closed });
    current = [];
    closed = false;
  };
  /** 曲线细分：段数与控制多边形长度成正比（都有明确上界，结果确定）。 */
  const subdivide = (p0: Point, controls: readonly Point[], p1: Point): void => {
    let len = 0;
    let prev = p0;
    for (const c of [...controls, p1]) {
      len += Math.hypot(c[0] - prev[0], c[1] - prev[1]);
      prev = c;
    }
    const n = Math.max(2, Math.min(16, Math.ceil(len / 40)));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (controls.length === 2) {
        const [c1, c2] = controls as readonly [Point, Point];
        const u = 1 - t;
        push([
          u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
          u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
        ]);
      } else {
        const [c] = controls as readonly [Point];
        const u = 1 - t;
        push([
          u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
          u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
        ]);
      }
    }
  };

  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === undefined) break;
    const relative = cmd === cmd.toLowerCase();
    const rel = (p: Point): Point => (relative ? [cursor[0] + p[0], cursor[1] + p[1]] : p);
    switch (cmd.toUpperCase()) {
      case 'M': {
        finish();
        const p = rel([num(), num()]);
        start = p;
        push(p);
        break;
      }
      case 'L': {
        push(rel([num(), num()]));
        break;
      }
      case 'H': {
        const x = num();
        push([relative ? cursor[0] + x : x, cursor[1]]);
        break;
      }
      case 'V': {
        const y = num();
        push([cursor[0], relative ? cursor[1] + y : y]);
        break;
      }
      case 'C': {
        const p0 = cursor;
        const c1 = rel([num(), num()]);
        const c2 = rel([num(), num()]);
        const p1 = rel([num(), num()]);
        subdivide(p0, [c1, c2], p1);
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'S': {
        // 平滑三次：第一控制点是上一段第二控制点关于当前点的【反射】
        const p0 = cursor;
        const c1: Point =
          lastCubicControl === null ? p0 : [2 * p0[0] - lastCubicControl[0], 2 * p0[1] - lastCubicControl[1]];
        const c2 = rel([num(), num()]);
        const p1 = rel([num(), num()]);
        subdivide(p0, [c1, c2], p1);
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }
      case 'Q': {
        const p0 = cursor;
        const c = rel([num(), num()]);
        const p1 = rel([num(), num()]);
        subdivide(p0, [c], p1);
        lastQuadControl = c;
        lastCubicControl = null;
        break;
      }
      case 'T': {
        // 平滑二次：控制点是上一段控制点关于当前点的反射
        const p0 = cursor;
        const c: Point =
          lastQuadControl === null ? p0 : [2 * p0[0] - lastQuadControl[0], 2 * p0[1] - lastQuadControl[1]];
        const p1 = rel([num(), num()]);
        subdivide(p0, [c], p1);
        lastQuadControl = c;
        lastCubicControl = null;
        break;
      }
      case 'Z': {
        closed = true;
        finish();
        cursor = start;
        break;
      }
      default:
        throw new Error('公式几何：不支持的路径命令 ' + cmd);
    }
  }
  finish();
  return out;
}

/* ── MathJax 环境（进程内建一次）────────────────────────────── */

let cached: { convert: (src: string, opts: { display: boolean }) => unknown } | null = null;

interface LiteElement {
  readonly kind?: string;
  readonly children?: readonly LiteElement[];
  readonly attributes?: Readonly<Record<string, string>>;
}

function mathjaxDoc(): { convert: (src: string, opts: { display: boolean }) => LiteElement } {
  if (cached !== null) return cached as { convert: (src: string, opts: { display: boolean }) => LiteElement };
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: AllPackages });
  const svg = new SVG({ fontCache: 'none' });
  const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });
  cached = {
    convert: (src: string, opts: { display: boolean }): LiteElement =>
      doc.convert(src, {
        display: opts.display,
        em: 16,
        ex: 16 / EX_PER_EM,
        containerWidth: 80 * 16,
      }) as unknown as LiteElement,
  };
  return cached as { convert: (src: string, opts: { display: boolean }) => LiteElement };
}

function tagOf(el: LiteElement): string {
  return String((el as { kind?: string }).kind ?? '');
}

interface WalkState {
  readonly mat: Mat;
  readonly paths: { subpaths: FlatSubpath[] }[];
}

/** 深度优先：累积变换，收集 path / rect / line。 */
function walk(el: LiteElement, state: WalkState): void {
  const tag = tagOf(el);
  if (tag === 'svg') {
    // viewBox 由调用方在根节点上读，这里只继续往下走
  }
  const own = parseTransform(el.attributes?.['transform']);
  const mat = multiply(state.mat, own);

  if (tag === 'path') {
    const d = el.attributes?.['d'];
    if (d !== undefined) {
      const flat = flattenPathData(d);
      const subpaths: FlatSubpath[] = flat.map((fp) => fp.points.map((p) => apply(mat, p)));
      state.paths.push({ subpaths });
    }
  } else if (tag === 'rect') {
    const x = Number(el.attributes?.['x'] ?? '0');
    const y = Number(el.attributes?.['y'] ?? '0');
    const w = Number(el.attributes?.['width'] ?? '0');
    const h = Number(el.attributes?.['height'] ?? '0');
    // rect 的 y 是【上边】，且这棵子树可能带 scale(1,-1)（MathJax 会把 rect 放在翻转过的组里）
    const corners: Point[] = [
      apply(mat, [x, y]),
      apply(mat, [x + w, y]),
      apply(mat, [x + w, y + h]),
      apply(mat, [x, y + h]),
      apply(mat, [x, y]),
    ];
    state.paths.push({ subpaths: [corners] });
  } else if (tag === 'line') {
    const x1 = Number(el.attributes?.['x1'] ?? '0');
    const y1 = Number(el.attributes?.['y1'] ?? '0');
    const x2 = Number(el.attributes?.['x2'] ?? '0');
    const y2 = Number(el.attributes?.['y2'] ?? '0');
    state.paths.push({ subpaths: [[apply(mat, [x1, y1]), apply(mat, [x2, y2])]] });
  }
  for (const child of el.children ?? []) walk(child, { mat, paths: state.paths });
}

/**
 * 渲染一个公式，返回【物化后的几何】。
 *
 * 失败（LaTeX 语法错、遇到不支持的 SVG 构造）返回带 message 的对象，不抛 ——
 * 调用方（工具）要把它变成一条给模型看的回执，而不是让整轮炸掉。
 */
export function renderFormula(
  source: string,
  opts: { readonly display?: boolean } = {},
): { ok: true; geometry: FormulaGeometry } | { ok: false; error: string } {
  const trimmed = source.trim();
  if (trimmed === '') return { ok: false, error: 'empty_source' };
  try {
    const node = mathjaxDoc().convert(trimmed, { display: opts.display ?? true });
    // ★ 语法错时 MathJax 不抛异常，它画一个【红色方框】（data-mml-node="merror"）。
    //   不认这个标记的话，模型写错的公式会"成功地"画成一个空框 —— 最坏的那种失败。
    const err = findMerror(node);
    if (err !== null) return { ok: false, error: 'latex_error: ' + err };
    const svgEl = findSvg(node);
    if (svgEl === undefined) return { ok: false, error: 'no_svg' };
    const viewBox = (svgEl.attributes?.['viewBox'] ?? '').split(/\s+/).map(Number);
    if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) {
      return { ok: false, error: 'bad_viewbox' };
    }
    const [minX, minY, vbW, vbH] = viewBox as [number, number, number, number];
    const state: WalkState = { mat: IDENTITY, paths: [] };
    walk(svgEl, state);

    const subpaths: Vec2[][] = [];
    for (const p of state.paths) {
      for (const sp of p.subpaths) {
        // 丢掉退化子路径（一个点 / 零长度），它们只会让填充规则变怪
        if (sp.length < 2) continue;
        subpaths.push(
          sp.map(([x, y]) => ({ x: round3((x - minX) / UNITS_PER_EM), y: round3(y / UNITS_PER_EM) })),
        );
      }
    }
    if (subpaths.length === 0) return { ok: false, error: 'no_paths' };

    return {
      ok: true,
      geometry: {
        source: trimmed,
        subpaths,
        width: round3(vbW / UNITS_PER_EM),
        ascent: round3(-minY / UNITS_PER_EM),
        depth: round3((minY + vbH) / UNITS_PER_EM),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 找到 MathJax 的错误节点（语法错时它会画一个红框），并把它里面的文字带出来。 */
function findMerror(el: LiteElement): string | null {
  if (el.attributes?.['data-mml-node'] === 'merror') {
    const text = textOf(el).trim();
    return text === '' ? '（MathJax 报了错但没给文字）' : text;
  }
  for (const child of el.children ?? []) {
    const hit = findMerror(child);
    if (hit !== null) return hit;
  }
  return null;
}

function textOf(el: LiteElement): string {
  let out = '';
  for (const child of el.children ?? []) {
    if (tagOf(child) === '#text') out += String((child as { text?: string }).text ?? '');
    else out += textOf(child);
  }
  return out;
}

function findSvg(el: LiteElement): LiteElement | undefined {
  if (tagOf(el) === 'svg') return el;
  for (const child of el.children ?? []) {
    const hit = findSvg(child);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/* ── 文档里的存法 ─────────────────────────────────────────────
 *
 * 格式由 engine-core 的 `render/formula-geometry.ts` 定义并实现（encode + decode）——
 * 那是【工具写、求值层读】的契约，只有一处实现。
 * 这里转出编码器，调用方少 import 一个名字。
 */
export { encodeFormulaGeometry };
