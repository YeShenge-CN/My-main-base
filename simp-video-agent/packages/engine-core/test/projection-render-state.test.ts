import { describe, expect, it } from 'vitest';
import { getRenderState, projectRenderState } from '../src/projection/render-state';
import { tokensOfJson } from '../src/projection/tokens';
import type { RenderItem, RenderState } from '../src/render-state';
import * as Mat from '../src/math/mat2d';
import * as Vec from '../src/math/vec2';
import { makeDoc } from './fixtures';

/**
 * ⚠️ RenderState 的生产者 evaluate(doc, t) 属于 P0 第 7 步，尚未实现。
 * 这里用手写的 RenderState 测【投影】本身：等 evaluate 落地，把 makeState 换成
 * 真实 evaluate 即可，投影层一行不用改。
 *
 * ★ meta 现在是 projectRenderState 的必填第二参：坐标契约那一节要报出
 *   "1 世界单位 = 多少像素"，而世界宽高【猜不出来】—— viewport 与世界宽高的
 *   比值决定换算，拍一个默认值会给出一个"看起来像真的"的错误答案。
 */
const META = makeDoc(0).meta;

function makeState(items: readonly RenderItem[]): RenderState {
  return {
    t: 1,
    viewport: { w: 1920, h: 1080 },
    camera: { tx: 0, ty: 0, scale: 1.5, rotate: 0, pivot: Vec.ZERO },
    matrix: Mat.identity(),
    items,
  };
}

const pathItem: RenderItem = {
  id: 'plot#1',
  kind: 'path',
  layerId: 'main',
  order: 1,
  box: { x: 10.1234, y: 20.5678, w: 300.4444, h: 120.9999 },
  opacity: 1,
  visibleFraction: 0.5,
  pointCount: 2400,
};

const textItem: RenderItem = {
  id: 'label#1',
  kind: 'text',
  layerId: 'annot',
  order: 2,
  box: { x: 2000, y: 0, w: 100, h: 20 },
  opacity: 0.8,
  visibleFraction: 1,
  text: {
    content: '一段很长的文本占位内容'.repeat(6),
    lines: ['一段很长的文本占位内容'.repeat(3), '一段很长的文本占位内容'.repeat(3)],
    anchor: Vec.vec2(100.25, 50.75),
    fontSize: 32,
    lineHeight: 40,
    bold: false,
    cameraScale: 1.5,
    align: 'center',
  },
};

describe('projectRenderState：文字版屏幕状态', () => {
  it('给出相机 scale、视口与逐项的屏幕 AABB', () => {
    const view = projectRenderState(makeState([pathItem, textItem]), META);
    expect(view.cameraScale).toBe(1.5);
    expect(view.viewport).toEqual([1920, 1080]);
    expect(view.items.length).toBe(2);
    expect(view.items[0]?.box).toEqual([10.1, 20.6, 300.4, 121]);
    expect(view.items[0]?.points).toBe(2400);
    expect(view.items[0]?.visible).toBe(0.5);
  });

  it('★ 交出坐标契约：1 世界单位 = 多少像素、世界可见范围（模型靠它才知道 tf 的单位）', () => {
    // makeDoc 默认：viewport 1920×1080、world 16×9 → base = min(120, 120) = 120
    const view = projectRenderState(makeState([pathItem]), META);
    expect(view.world.width).toBe(16);
    expect(view.world.height).toBe(9);
    expect(view.world.pixelsPerUnit).toBe(120);
    // 世界可视矩形恒以原点为中心 —— 这就是 tf.y 的可用范围（±4.5）
    expect(view.world.visible.x).toEqual([-8, 8]);
    expect(view.world.visible.y).toEqual([-4.5, 4.5]);
    expect(view.world.note).toContain('世界单位');
    expect(view.world.note).toContain('120');
  });

  it('★ 世界宽高比与 viewport 不一致时，base 取较小者（换算不能靠猜）', () => {
    const meta = { ...META, viewport: [480, 270] as const };
    // base = min(480/16, 270/9) = min(30, 30) = 30
    expect(projectRenderState(makeState([pathItem]), meta).world.pixelsPerUnit).toBe(30);
    // 世界比视口"更宽"时按宽适配：base = min(1920/32, 1080/9) = min(60, 120) = 60
    const wide = { ...META, worldWidth: 32 };
    expect(projectRenderState(makeState([pathItem]), wide).world.pixelsPerUnit).toBe(60);
  });

  it('按 order 稳定排序，不依赖输入顺序', () => {
    const a = projectRenderState(makeState([pathItem, textItem]), META);
    const b = projectRenderState(makeState([textItem, pathItem]), META);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.items[0]?.id).toBe('plot#1');
  });

  it('统计完全落在画布外的项数（构图越界的快速信号）', () => {
    expect(projectRenderState(makeState([pathItem, textItem]), META).offscreen).toBe(1);
    expect(projectRenderState(makeState([pathItem]), META).offscreen).toBe(0);
  });

  it('文本给的是占位信息：内容（超长截断）、锚点、字号、对齐', () => {
    const view = projectRenderState(makeState([textItem]), META);
    const t = view.items[0]?.text;
    expect(t?.anchor).toEqual([100.3, 50.8]);
    expect(t?.fontSize).toBe(32);
    expect(t?.align).toBe('center');
    expect(t?.content.endsWith('…')).toBe(true);
    expect(t?.content.length).toBe(41);
  });

  it('maxTextChars 可调', () => {
    const view = projectRenderState(makeState([textItem]), META, { maxTextChars: 5 });
    expect(view.items[0]?.text?.content).toBe('一段很长的…');
  });

  it('token 预算：超预算时截断并如实报 omitted', () => {
    const many: RenderItem[] = [];
    for (let i = 0; i < 200; i++) {
      many.push({ ...pathItem, id: 'plot#' + i, order: i });
    }
    const view = projectRenderState(makeState(many), META, { tokenBudget: 500 });
    expect(tokensOfJson(view)).toBeLessThanOrEqual(500);
    expect(view.items.length + (view.omitted ?? 0)).toBe(200);
    expect(view.omitted).toBeGreaterThan(0);
  });

  it('不超预算时不出现 omitted 字段', () => {
    expect(projectRenderState(makeState([pathItem]), META).omitted).toBeUndefined();
  });
});

describe('getRenderState：工具入口，produce 就是 evaluate', () => {
  it('把 produce 的产物投影成文字视图', () => {
    const doc = makeDoc(2);
    let seen = -1;
    const view = getRenderState(doc, 3, (_d, t) => {
      seen = t;
      return makeState([pathItem, textItem]);
    });
    expect(seen).toBe(3);
    expect(view.cameraScale).toBe(1.5);
    expect(view.items.map((i) => i.id)).toEqual(['plot#1', 'label#1']);
    expect(view.offscreen).toBe(1);
    // 工具入口必须把 doc 的 meta 带进坐标契约（否则模型拿不到换算）
    expect(view.world.pixelsPerUnit).toBe(120);
  });
});
