/**
 * 公式工具（方案 B：几何由【工具】物化）。
 *
 * ★ 这里守的是那条分工：**模型只写 LaTeX，几何由引擎算**。
 *   于是"排版"这件事只发生在一个地方（MathJax in Node），
 *   两条渲染后端拿到的是同一份点列 —— 求值层与画笔都不认识 LaTeX。
 */
import { describe, expect, it } from 'vitest';
import {
  createJournal,
  decodeFormulaGeometry,
  encodeFormulaGeometry,
  unwrapField,
  type SceneDoc,
} from '@sva/engine-core';
import { renderFormula } from '../src/formula';
import { dispatchTool, type ToolContext } from '../src/tools';
import { BudgetTracker, DEFAULT_LIMITS } from '../src/budget';

function emptyShot(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 8, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }],
    objects: {},
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function makeCtx(): ToolContext {
  const journal = createJournal(emptyShot(), { now: () => 1_700_000_000_000 });
  let clock = 1_700_000_000_000;
  return {
    doc: () => journal.currentDoc(),
    journal,
    budget: new BudgetTracker('shot-1', DEFAULT_LIMITS),
    baseVersion: () => journal.currentVersion(),
    turnId: 'turn-1',
    render: () => [],
    now: () => (clock += 1000),
  };
}

/* ── 几何 ───────────────────────────────────────────────────── */

describe('LaTeX → 几何（MathJax in Node，不需要浏览器）', () => {
  it('分式：宽度不到 1em，基线以上超过 1em（分子压在分数线上方）', () => {
    const r = renderFormula('\\frac{a}{b}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.geometry;
    expect(g.width).toBeGreaterThan(0.5);
    expect(g.width).toBeLessThan(1.5);
    expect(g.ascent).toBeGreaterThan(1);
    expect(g.depth).toBeGreaterThan(0.3);
    expect(g.subpaths.length).toBeGreaterThanOrEqual(3); // a、分数线、b
  });

  it('★ 确定性：同一个公式两次渲染逐字节一致', () => {
    const a = renderFormula('x^2 + y^2 = r^2');
    const b = renderFormula('x^2 + y^2 = r^2');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(encodeFormulaGeometry(a.geometry.subpaths)).toBe(encodeFormulaGeometry(b.geometry.subpaths));
  });

  it('几种常见构造都能排（上下标 / 根号 / 求和 / 积分）', () => {
    for (const src of ['x^2', '\\sqrt{x+1}', '\\sum_{i=1}^{n} i', '\\int_0^1 f(x) dx', '\\theta = \\frac{\\pi}{4}']) {
      const r = renderFormula(src);
      expect(r.ok, src + ' 渲染失败：' + (r.ok ? '' : r.error)).toBe(true);
      if (r.ok) expect(r.geometry.subpaths.length).toBeGreaterThan(0);
    }
  });

  it('★ 语法错要如实报（MathJax 会画一个红框而不是抛异常）', () => {
    const r = renderFormula('\\frac{a}{');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('latex_error');
  });

  it('空源码直接拒', () => {
    expect(renderFormula('   ').ok).toBe(false);
  });

  it('几何能装进文档再读回来（工具写、求值层读的同一条契约）', () => {
    const r = renderFormula('E = mc^2');
    if (!r.ok) throw new Error('渲染失败');
    const text = encodeFormulaGeometry(r.geometry.subpaths);
    const back = decodeFormulaGeometry(text);
    expect(back).toHaveLength(r.geometry.subpaths.length);
    expect(back[0]?.[0]).toEqual(r.geometry.subpaths[0]?.[0]);
  });
});

/* ── 工具 ───────────────────────────────────────────────────── */

describe('★ render_formula 工具：模型只写公式，几何由工具落地', () => {
  it('调一次就得到文档里的公式对象（几何 + 源码 + 位置）', async () => {
    const ctx = makeCtx();
    const out = await dispatchTool('render_formula', { source: '\\frac{a}{b}', x: 1.5, y: 2, size: 36 }, ctx);
    const receipt = JSON.parse(out.text) as {
      ok: boolean;
      id: string | null;
      emBox: { width: number; ascent: number; depth: number };
      pixelSize: { width: number; height: number };
    };
    expect(receipt.ok).toBe(true);
    expect(receipt.id).toBe('formula#1');
    // ★ 回执里给像素尺寸：模型的下一步常常是"放到标题下面"，而它需要知道这东西多大
    expect(receipt.pixelSize.width).toBe(Math.round(receipt.emBox.width * 36));

    const obj = ctx.doc().objects['formula#1'];
    expect(obj?.shape).toBe('formula');
    expect(obj?.style['size']).toEqual({ v: 36 });
    expect(obj?.tf.x).toBe(1.5);
    expect(obj?.tf.y).toBe(2);
    expect(String(unwrapField(obj?.params['source']))).toBe('\\frac{a}{b}');
    // 几何真的在里面（而且能解出子路径）
    const paths = String(unwrapField(obj?.params['paths']) ?? '');
    expect(decodeFormulaGeometry(paths).length).toBeGreaterThanOrEqual(3);
  });

  it('语法错 → 回执里是 latex_error（模型据此改公式，而不是画出一个空框）', async () => {
    const ctx = makeCtx();
    const out = await dispatchTool('render_formula', { source: '\\frac{a}{' }, ctx);
    const receipt = JSON.parse(out.text) as { error: string };
    expect(receipt.error).toBe('latex_error');
    expect(Object.keys(ctx.doc().objects)).toHaveLength(0);
  });

  it('★ 归属由引擎按身份推导：导演视角是 global（不会变成悬空引用）', async () => {
    const ctx = makeCtx();
    await dispatchTool('render_formula', { source: 'x^2', x: 0, y: 0 }, ctx);
    expect(ctx.doc().objects['formula#1']?.owner.kind).toBe('global');
  });

  it('★ 场景 Agent（有 scope）落在当前这一镜', async () => {
    const ctx: ToolContext = {
      ...makeCtx(),
      scope: { kind: 'scene', sceneId: 's#1', start: 0, end: 4 },
    };
    // 有 scope 时引擎会把 sceneId: null 落成"我这一镜"（这里用不带镜头表的文档，
    // 归属仍按 scope 落 sceneId）
    const doc = { ...ctx.doc(), scenes: [{ id: 's#1', name: '一', bornAt: 0 }] };
    const journal = createJournal(doc, { now: () => 1 });
    const withScope: ToolContext = { ...ctx, journal, doc: () => journal.currentDoc() };
    await dispatchTool('render_formula', { source: 'x^2', x: 0, y: 0 }, withScope);
    expect(journal.currentDoc().objects['formula#1']?.owner).toMatchObject({ kind: 'scene', sceneId: 's#1' });
  });

  it('公式是屏幕空间对象：字号不随相机缩放（与文字同口径）', async () => {
    const ctx = makeCtx();
    await dispatchTool('render_formula', { source: 'x', x: 0, y: 0, size: 30 }, ctx);
    const obj = ctx.doc().objects['formula#1'];
    // 字号进 style.size（屏幕像素），不是 tf 的缩放
    expect(obj?.style['size']).toEqual({ v: 30 });
    expect(obj?.tf.sx).toBe(1);
  });
});
