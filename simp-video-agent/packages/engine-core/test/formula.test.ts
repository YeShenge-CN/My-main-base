/**
 * 公式对象（方案 B：几何由工具物化，求值层只读点列）。
 *
 * ★ 这一份守的是"求值层不认识 LaTeX"那句话：给它一串点，它按字号缩放、按锚点平移，
 *   别的什么都不做。于是两条渲染后端画的是同一份点列 —— 预览 = 成片是结构性成立的。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { validate } from '../src/validate/index';
import { decodeFormulaGeometry, encodeFormulaGeometry } from '../src/render/formula-geometry';
import { REGISTRY } from '../src/registry/fields';
import { applyCommand } from '../src/command/apply';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

/** 一个 2×3 的方框（em）：宽 1、基线以上 2、以下 1 —— 数字好算，断言能直接读到映射。 */
const SQUARE = encodeFormulaGeometry([
  [
    { x: 0, y: -2 },
    { x: 1, y: -2 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
]);

function formulaObject(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'formula',
    owner: { kind: 'global' },
    params: {
      source: { v: 'x^2' },
      paths: { v: SQUARE },
      width: { v: 1 },
      ascent: { v: 2 },
      depth: { v: 1 },
    },
    style: { size: { v: 100 }, fill: { v: '#ffffff' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function docWith(object: SceneObject): SceneDoc {
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['formula#1'] }],
    objects: { 'formula#1': object },
    effects: {},
    markers: [],
  };
}

function itemOf(doc: SceneDoc) {
  const item = evaluate(doc, 1).items.find((i) => i.id === 'formula#1');
  if (item === undefined) throw new Error('没有这一项');
  return item;
}

describe('几何格式（工具写、求值层读的契约）', () => {
  it('编码 → 解码往返：点数与坐标都对得上', () => {
    const decoded = decodeFormulaGeometry(SQUARE);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toHaveLength(4);
    expect(decoded[0]?.[0]).toEqual({ x: 0, y: -2 });
  });

  it('★ 坏输入不抛异常（求值路径对任何输入都必须能终止）', () => {
    expect(decodeFormulaGeometry('')).toEqual([]);
    expect(decodeFormulaGeometry('garbage')).toEqual([]);
    expect(decodeFormulaGeometry('1,2 3,4')).toEqual([]); // 少于 3 个点：填充没有意义
    expect(decodeFormulaGeometry('1,2 3,4 5,6')).toHaveLength(1);
  });
});

describe('★ 求值：em 几何 × 字号 → 屏幕像素', () => {
  it('字号 100：1em = 100px，包围盒与点列都按它缩放', () => {
    const doc = docWith(formulaObject());
    const item = itemOf(doc);
    expect(item.kind).toBe('formula');
    expect(item.box.w).toBeCloseTo(100, 6);
    expect(item.box.h).toBeCloseTo(300, 6); // (ascent 2 + depth 1) × 100
    const sp = item.subpaths?.[0];
    expect(sp).toHaveLength(4);
    // ★ 锚点从文档推导（第一次我把视口当成 960×540 手算，三条断言全错）：
    //   世界原点经 fit/matrix 映射到视口中心
    const cx = (doc.meta.viewport[0] ?? 0) / 2;
    const cy = (doc.meta.viewport[1] ?? 0) / 2;
    // 几何的 (0,-2) = 基线上方 2em、左边缘 → 屏幕 (cx, cy-200)
    expect(sp?.[0]?.x).toBeCloseTo(cx, 6);
    expect(sp?.[0]?.y).toBeCloseTo(cy - 200, 6);
    // 右下角 (1,1) → (cx+100, cy+100)
    expect(sp?.[2]?.x).toBeCloseTo(cx + 100, 6);
    expect(sp?.[2]?.y).toBeCloseTo(cy + 100, 6);
  });

  it('字号变了，几何跟着变（几何存的是 em，所以不用重算）', () => {
    const big = itemOf(docWith(formulaObject({ style: { size: { v: 200 }, fill: { v: '#fff' } } })));
    expect(big.box.w).toBeCloseTo(200, 6);
  });

  it('对齐与文字同口径：left → 锚点在左边缘；right → 锚点在右边缘', () => {
    const doc = docWith(formulaObject({ style: { size: { v: 100 }, align: { v: 'left' } } }));
    const cx = (doc.meta.viewport[0] ?? 0) / 2;
    const left = itemOf(doc);
    const center = itemOf(docWith(formulaObject({ style: { size: { v: 100 } } })));
    const right = itemOf(docWith(formulaObject({ style: { size: { v: 100 }, align: { v: 'right' } } })));
    expect(left.box.x).toBeCloseTo(cx, 6);
    expect(center.box.x).toBeCloseTo(cx - 50, 6);
    expect(right.box.x).toBeCloseTo(cx - 100, 6);
  });

  it('竖向永远以基线为准：box 上边 = 锚点 y − ascent×字号', () => {
    const doc = docWith(formulaObject());
    const cy = (doc.meta.viewport[1] ?? 0) / 2;
    expect(itemOf(doc).box.y).toBeCloseTo(cy - 200, 6);
  });

  it('★ 坏几何：不画（而不是画一个错的东西），且校验器报出来', () => {
    const broken = docWith(formulaObject({ params: { source: { v: 'x' }, paths: { v: 'garbage' } } }));
    expect(evaluate(broken, 1).items).toHaveLength(0);
    const codes = validate(broken).map((i) => i.code);
    expect(codes).toContain('formula_geometry_missing');
  });

  it('没留源码 → 报 warn（几何还在，但没人知道它画的是什么）', () => {
    const noSource = docWith(formulaObject({ params: { paths: { v: SQUARE } } }));
    expect(validate(noSource).map((i) => i.code)).toContain('formula_source_missing');
  });

  it('字号可以被动画驱动（几何不动，只是缩放）', () => {
    const animated = docWith(
      formulaObject({
        anim: { 'style.size': { kind: 'keys', keys: [{ t: 0, v: 50 }, { t: 2, v: 150 }] } },
      }),
    );
    const at0 = evaluate(animated, 0).items[0];
    const at2 = evaluate(animated, 2).items[0];
    expect(at0?.box.w).toBeCloseTo(50, 6);
    expect(at2?.box.w).toBeCloseTo(150, 6);
  });

  it('不透明度照常作用（与其它对象同一条路）', () => {
    const item = itemOf(docWith(formulaObject({ tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 0.4 } })));
    expect(item.opacity).toBeCloseTo(0.4, 6);
  });
});

describe('registry 契约：公式的几何字段是 engineOnly', () => {
  it('★ 五个几何字段全部 engineOnly（面板因此不会给它们造可编辑控件）', () => {
    // 依赖这条的是一处很小的面板改动：inspector 只渲染非 engineOnly 的字段。
    // 理由：几何是【机器写的】—— 给人一个可编辑的框，等于邀请一次"改了但没人重算"的不一致
    // （source 与 paths 会变成两个真源）。样式字段（size/fill/align）则应当可编辑。
    const group = REGISTRY.groups.find((g) => g.id === 'shape.formula.params');
    if (group === undefined) throw new Error('registry 缺少 shape.formula.params');
    for (const [key, spec] of Object.entries(group.fields)) {
      expect(spec.engineOnly, key + ' 应当 engineOnly').toBe(true);
    }
    const style = REGISTRY.groups.find((g) => g.id === 'shape.formula.style');
    if (style === undefined) throw new Error('registry 缺少 shape.formula.style');
    expect(style.fields['size']?.engineOnly ?? false).toBe(false);
  });
});

describe('create_object 建公式：字段必须在该 shape 的 registry 分组里', () => {
  it('登记的字段能落地', () => {
    const r = applyCommand(docWith(formulaObject()), {
      op: 'create_object',
      localId: '$f',
      shape: 'formula',
      params: { source: 'a+b', paths: SQUARE, width: 1, ascent: 2, depth: 1 },
      style: { size: 40, fill: '#fff' },
      owner: { kind: 'global' },
    }, {});
    expect(r.kind).toBe('applied');
  });

  it('★ 没登记的字段被拒（不变量 4：形状靠 strict schema + 引擎兜底）', () => {
    const r = applyCommand(docWith(formulaObject()), {
      op: 'create_object',
      localId: '$f',
      shape: 'formula',
      params: { source: 'a+b', paths: SQUARE, nonsense: 1 },
      owner: { kind: 'global' },
    }, {});
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.error.code).toBe('field_not_in_shape');
  });
});
