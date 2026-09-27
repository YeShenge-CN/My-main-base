/**
 * P1 形状系统：矩形与线段（结构图的两个基元）。
 *
 * ★ 这一份存在的理由：在这之前引擎只能画函数曲线与文字，
 *   于是"CPU 是一个方块、内存是另一个方块、总线连起来"这件事根本表达不了。
 *   所以这里既要断言【结构】（点列、闭合、箭头、registry 登记），
 *   也要断言【它真的改变画面】（像素级，见 shot 那一组的口径）。
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate';
import { sampleLine, sampleRect } from '../src/sampling/shapes';
import { resolveItemStyle } from '../src/anim/track';
import { REGISTRY } from '../src/registry/fields';
import { generateObjectSchema } from '../src/registry/schema';
import { filterRenderStateByScene } from '../src/shot';
import type { RenderItem } from '../src/render-state';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

/* ── 采样器 ─────────────────────────────────────────────────── */

describe('sampleRect：矩形是精确几何，不是采样', () => {
  it('直角矩形：四个角、闭合', () => {
    const r = sampleRect(4, 2, 0);
    expect(r.points).toEqual([
      { x: -2, y: -1 },
      { x: 2, y: -1 },
      { x: 2, y: 1 },
      { x: -2, y: 1 },
    ]);
    expect(r.breaks).toEqual([0]);
  });

  it('圆角：半径被【夹到半边长】，所以给大了不会画成怪形状', () => {
    // 半边长是 (2, 1)，radius 给 99 应当夹到 1
    const r = sampleRect(4, 2, 99);
    const xs = r.points.map((p) => p.x);
    const ys = r.points.map((p) => p.y);
    expect(Math.max(...xs)).toBeCloseTo(2, 10);
    expect(Math.min(...xs)).toBeCloseTo(-2, 10);
    expect(Math.max(...ys)).toBeCloseTo(1, 10);
    expect(Math.min(...ys)).toBeCloseTo(-1, 10);
    // 圆角点数 = 4 角 × (每角段数+1)
    expect(r.points.length).toBe(4 * 7);
  });

  it('宽高为 0 或负数时退化成一条退化线而不是崩（宽度取绝对值）', () => {
    const zero = sampleRect(0, 0, 0);
    expect(zero.points.length).toBe(4);
    const neg = sampleRect(-2, -1, 0);
    expect(neg.points[0]).toEqual({ x: -1, y: -0.5 });
  });
});

describe('sampleLine：两个点，端点非法时退回 0', () => {
  it('正常两点', () => {
    expect(sampleLine([-1, 2], [3, -4]).points).toEqual([
      { x: -1, y: 2 },
      { x: 3, y: -4 },
    ]);
  });

  it('NaN 被当成 0 而不是把整条线带坏', () => {
    expect(sampleLine([Number.NaN, 1], [2, Number.NaN]).points).toEqual([
      { x: 0, y: 1 },
      { x: 2, y: 0 },
    ]);
  });
});

/* ── registry 登记（三份产物的唯一真源）────────────────────────── */

describe('registry 里登记了两个新 shape', () => {
  function group(id: string) {
    const g = REGISTRY.groups.find((x) => x.id === id);
    if (g === undefined) throw new Error('缺少分组 ' + id);
    return g;
  }

  it('params / style 分组都在，字段名正确', () => {
    expect(Object.keys(group('shape.rect.params').fields).sort()).toEqual(['height', 'radius', 'width']);
    expect(Object.keys(group('shape.rect.style').fields).sort()).toEqual([
      'fill',
      'fillOpacity',
      'glow',
      'stroke',
      'width',
    ]);
    expect(Object.keys(group('shape.line.params').fields).sort()).toEqual(['from', 'head', 'to']);
    expect(Object.keys(group('shape.line.style').fields).sort()).toEqual(['glow', 'headSize', 'stroke', 'width']);
  });

  it('★ 矩形没有 samples —— 它是精确几何，不该有一个"调了没用"的旋钮', () => {
    expect(Object.keys(group('shape.rect.params').fields)).not.toContain('samples');
    expect(Object.keys(group('shape.line.params').fields)).not.toContain('samples');
  });

  it('head 是枚举（none / arrow），写错会被 schema 挡住', () => {
    const schema = generateObjectSchema(group('shape.line.params'), { mode: 'all-nullable' });
    const head = (schema['properties'] as Record<string, { anyOf?: unknown[]; enum?: string[] }>)['head'];
    const inner = (head?.anyOf?.[0] ?? head) as { enum?: string[] };
    expect(inner.enum).toEqual(['none', 'arrow']);
  });
});

/* ── evaluate：形状 → RenderItem ─────────────────────────────── */

function docWith(obj: SceneObject): SceneDoc {
  return {
    ...makeDoc(0, { duration: 4 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [obj.shape + '#1'] }],
    objects: { [obj.shape + '#1']: obj },
    effects: {},
    markers: [],
  };
}

function rectObj(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 4 }, height: { v: 2 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' }, fillOpacity: { v: 1 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function lineObj(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'line',
    owner: { kind: 'global' },
    params: { from: { v: [-2, 0] }, to: { v: [2, 0] }, head: { v: 'arrow' } },
    style: { stroke: { v: '#7fb2ff' }, width: { v: 2 }, headSize: { v: 16 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function itemOf(doc: SceneDoc, t = 0): RenderItem {
  const item = evaluate(doc, t).items[0];
  if (item === undefined) throw new Error('这一帧没有画出来任何东西');
  return item;
}

describe('evaluate 认出 rect 与 line', () => {
  it('★ 矩形：closed 为真、填充色在 style 里、AABB 等于它的屏幕尺寸', () => {
    const doc = docWith(rectObj());
    const item = itemOf(doc);
    expect(item.kind).toBe('path');
    expect(item.closed).toBe(true);
    expect(item.style?.fill).toBe('#16223a');
    expect(item.style?.stroke).toBe('#4ea1ff');
    // viewport 1920×1080 / world 16×9 → base 120；4×2 世界单位 = 480×240 像素
    expect(item.box.w).toBeCloseTo(480, 6);
    expect(item.box.h).toBeCloseTo(240, 6);
  });

  it('★ 线段：不闭合、带箭头的【门】（画多大是样式，见下一组）', () => {
    const item = itemOf(docWith(lineObj()));
    expect(item.closed).toBeUndefined();
    expect(item.arrow).toBe(true);
    expect(item.style?.headSize).toBe(16);
    expect(item.path).toHaveLength(2);
  });

  it('head=none 时不画箭头（arrow 门为假）', () => {
    const doc = docWith(lineObj({ params: { from: { v: [-2, 0] }, to: { v: [2, 0] }, head: { v: 'none' } } }));
    expect(itemOf(doc).arrow).toBeUndefined();
    // ★ 大小仍然在样式里 —— 这正是"要不要画"与"画多大"必须分开的原因
    expect(itemOf(doc).style?.headSize).toBe(16);
  });

  it('★ 箭头大小取自样式覆盖（动画/样式只有一处解析）', () => {
    const doc = docWith(lineObj({ style: { stroke: { v: '#fff' }, headSize: { v: 24 } } }));
    expect(itemOf(doc).style?.headSize).toBe(24);
  });

  it('tf 能整体搬运与旋转（端点用相对坐标，所以这是免费的）', () => {
    const moved = itemOf(docWith(lineObj({ tf: { x: 2, y: 1, rotate: 0, sx: 1, sy: 1, opacity: 1 } })));
    const at0 = itemOf(docWith(lineObj()));
    expect(moved.box.x - at0.box.x).toBeCloseTo(2 * 120, 6);
    // y 轴向上：世界 +1 → 屏幕向上（box.y 变小）
    expect(moved.box.y - at0.box.y).toBeCloseTo(-1 * 120, 6);
  });

  it('drawOn 对矩形按弧长裁剪（框图生长动画）', () => {
    const doc = docWith(
      rectObj({
        effects: ['eff#1'],
      }),
    );
    const grown: SceneDoc = {
      ...doc,
      effects: {
        'eff#1': {
          type: 'drawOn',
          target: 'rect#1',
          params: { start: { v: 0 }, duration: { v: 1 }, mode: { v: 'arc' }, tip: { v: true } },
        },
      },
    };
    const half = itemOf(grown, 0.5);
    const full = itemOf(grown, 2);
    expect(half.path!.length).toBeLessThan(full.path!.length);
    expect(full.visibleFraction).toBeCloseTo(1, 6);
  });
});

/* ── 样式解析：fill 与 stroke 是两格 ───────────────────────────── */

describe('★ fill 与 stroke 分开（它们一度共用一格）', () => {
  it('矩形的 stroke 不会被 fill 顶掉', () => {
    const s = resolveItemStyle(rectObj());
    expect(s.stroke).toBe('#4ea1ff');
    expect(s.fill).toBe('#16223a');
    expect(s.fillOpacity).toBe(1);
  });

  it('文字的 fill 仍然当"颜色"用（那条回退保留）', () => {
    const text = makeObject('text#1', 'text', {
      params: { content: { v: '标题' } },
      style: { size: { v: 32 }, fill: { v: '#ff0000' } },
    });
    // text 的 registry 里没有 stroke，只有 fill
    expect(resolveItemStyle(text).stroke).toBe('#ff0000');
  });
});

/* ── 与镜头的关系（别把新 shape 忘在过滤之外）────────────────── */

describe('新 shape 同样受镜头过滤', () => {
  it('scene 类的矩形只在自己那一镜出现', () => {
    const base = makeDoc(0, { duration: 12 });
    const doc: SceneDoc = {
      ...withScenes(base, [
        { id: 's#1', name: '一', bornAt: 0 },
        { id: 's#2', name: '二', bornAt: 6 },
      ]),
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1', 'rect#2'] }],
      objects: {
        'rect#1': rectObj({ owner: { kind: 'scene', sceneId: 's#1', bornAt: 0 } }),
        'rect#2': rectObj({ owner: { kind: 'scene', sceneId: 's#2', bornAt: 6 } }),
      },
      effects: {},
      markers: [],
    };
    const at3 = filterRenderStateByScene(evaluate(doc, 3), doc, 's#1');
    expect(at3.items.map((i) => i.id)).toEqual(['rect#1']);
  });
});
