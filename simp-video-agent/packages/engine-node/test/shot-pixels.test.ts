/**
 * 多镜头串行渲染的【像素级】验证。
 *
 * 为什么单测不够：engine-core 的 shot.test.ts 能证明"过滤后的 items 集合对了"，
 * 但证明不了"画出来的像素真的跟着变"。本项目出过一次这类事故 ——
 * 结构对了而画面没变（浏览器 bundle 是旧的），单测全绿、成片是错的。
 *
 * 所以这里直接比 PNG 的 sha256。默认跳过（要拉 @napi-rs/canvas），需要时：
 *   SVA_PIXELS=1 pnpm test
 */
import { describe, expect, it } from 'vitest';
import { planShotFrames, type Effect, type SceneDoc, type SceneObject } from '@sva/engine-core';
import { renderFrames } from '../src/render';

const ENABLED = process.env['SVA_PIXELS'] === '1';

/**
 * 结构图的两个基元画出来到底长什么样。
 *
 * ★ 这一组是"P1 形状系统"唯一能证明它真的work的证据：
 *   结构断言只能说明 RenderItem 的字段对了，说明不了画笔把填充、闭合、箭头画对了。
 *   本项目出过一次"结构对了而画面没变"（旧的浏览器 bundle），所以这里比像素。
 */
function shapeDoc(objects: Record<string, SceneObject>, layerIds: readonly string[], effects: Record<string, Effect> = {}): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 4, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 2, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [...layerIds] }],
    objects,
    effects,
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function box(id: string, x: number, y: number, fill: string, radius = 0.15): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 3.4 }, height: { v: 1.5 }, radius: { v: radius } },
    style: {
      stroke: { v: '#4ea1ff' },
      width: { v: 2 },
      fill: { v: fill },
      fillOpacity: { v: 1 },
      glow: { v: 0 },
    },
    tf: { x, y, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

function arrow(id: string, from: readonly [number, number], to: readonly [number, number], head: string): SceneObject {
  return {
    shape: 'line',
    owner: { kind: 'global' },
    params: { from: { v: [from[0], from[1]] }, to: { v: [to[0], to[1]] }, head: { v: head } },
    // ★ 尺寸取真实框图会用的量级：线宽 0.12 世界单位（base=20 时约 2.4px），
    //   箭头 0.8（约 16px）。第一版用了 0.05 / 0.45 —— 线只有 1px 宽、
    //   箭头三角形才十几像素，测试在跟抗锯齿较劲而不是在验功能。
    style: { stroke: { v: '#7fb2ff' }, width: { v: 2.5 }, headSize: { v: 16 }, glow: { v: 0 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

/**
 * 非背景像素的坐标集合。
 *
 * ★ 用"非背景"而不是"等于某个颜色"：线只有两三个像素宽，抗锯齿会把
 *   描边色摊薄成背景与描边之间的任意中间值 —— 按精确色值数像素，
 *   测的是栅格化器的行为，不是"这个图形画出来了没有"。
 */
async function inkPixels(doc: SceneDoc): Promise<readonly (readonly [number, number])[]> {
  const png = renderFrames(doc, [1])[0]?.png;
  if (png === undefined) throw new Error('没有渲染出帧');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const out: [number, number][] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      // 背景是 #0b0e14；任何明显亮于它的都算"画上去的东西"
      if ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) > 11 + 14 + 20 + 24) out.push([x, y]);
    }
  }
  return out;
}

/** 落在某个方框里的像素数。 */
function inBox(pixels: readonly (readonly [number, number])[], x0: number, y0: number, x1: number, y1: number): number {
  return pixels.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).length;
}

function hash(doc: SceneDoc, t = 1): string {
  return renderFrames(doc, [t])[0]?.sha256 ?? '';
}

/**
 * 一帧里某个颜色的像素数。
 *
 * ★ 用"精确匹配 + 小容差"而不是"非背景"：这一组要回答的是
 *   "画面上有没有出现那个中间色"，而不是"有没有画东西"。
 */
async function countExact(doc: SceneDoc, t: number, hex: string, tol = 6): Promise<number> {
  const png = renderFrames(doc, [t])[0]?.png;
  if (png === undefined) throw new Error('没有渲染出帧');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs((data[i] ?? 0) - r) <= tol &&
      Math.abs((data[i + 1] ?? 0) - g) <= tol &&
      Math.abs((data[i + 2] ?? 0) - b) <= tol
    ) {
      n++;
    }
  }
  return n;
}

/** 数一个颜色的像素（允许 ±8 的通道误差，用来容忍抗锯齿）。 */
async function countColor(doc: SceneDoc, hex: string): Promise<number> {
  const png = renderFrames(doc, [1])[0]?.png;
  if (png === undefined) throw new Error('没有渲染出帧');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs((data[i] ?? 0) - r) <= 8 && Math.abs((data[i + 1] ?? 0) - g) <= 8 && Math.abs((data[i + 2] ?? 0) - b) <= 8) n++;
  }
  return n;
}

describe.skipIf(!ENABLED)('★ P1 形状：矩形与箭头真的画出来了', () => {
  it('一个方框：填充色真的出现在画面里（不是只描了个边）', async () => {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#3ad07a') }, ['rect#1']);
    const filled = await countColor(doc, '#3ad07a');
    // 3.4×1.5 世界单位 @ base=20 → 68×30 像素 ≈ 2000 像素
    expect(filled, '填充色像素太少，说明 fill 没画').toBeGreaterThan(1200);
  });
  it('★ fillOpacity=0 时填充消失（填充 alpha 与对象 alpha 是两件事）', () => {
    const solid = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#3ad07a') }, ['rect#1']);
    const hollow = shapeDoc(
      {
        'rect#1': {
          ...box('rect#1', 0, 0, '#3ad07a'),
          style: { ...box('rect#1', 0, 0, '#3ad07a').style, fillOpacity: { v: 0 } },
        },
      },
      ['rect#1'],
    );
    expect(hash(hollow)).not.toBe(hash(solid));
  });

  it('★ 箭头真的画在【终点】（不是共用门之后的偶然差异）', async () => {
    const withHead = shapeDoc({ 'line#1': arrow('line#1', [-3, 0], [3, 0], 'arrow') }, ['line#1']);
    const noHead = shapeDoc({ 'line#1': arrow('line#1', [-3, 0], [3, 0], 'none') }, ['line#1']);

    const a = await inkPixels(withHead);
    const b = await inkPixels(noHead);
    // 两张图都得有东西（线本身要画出来）
    expect(b.length, '线本身没画出来').toBeGreaterThan(100);

    /**
     * 终点在世界 x=+3 → 像素 160 + 3×20 = 220，y=90。
     * 箭头大小 0.8 世界单位 = 16px，所以终点左侧 20px 见方的区域里
     * "有箭头"必须明显比"没箭头"多墨。
     */
    const nearTip = (px: readonly (readonly [number, number])[]): number => inBox(px, 198, 78, 220, 102);
    expect(nearTip(a), '箭头没画在终点').toBeGreaterThan(nearTip(b) + 40);
  });

  it('★ 圆角与直角画出来不同（radius 真的生效）', () => {
    const sharp = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#3ad07a', 0) }, ['rect#1']);
    const round = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#3ad07a', 0.6) }, ['rect#1']);
    expect(hash(sharp)).not.toBe(hash(round));
  });

  it('★ 结构图：两个方块 + 一条箭头，三者都在画面上（这才是那个缺口）', async () => {
    const doc = shapeDoc(
      {
        'rect#1': box('rect#1', -3.6, 0, '#16223a'),
        'rect#2': box('rect#2', 3.6, 0, '#2a1d16'),
        'line#1': arrow('line#1', [-1.6, 0], [1.6, 0], 'arrow'),
      },
      ['rect#1', 'rect#2', 'line#1'],
    );
    const ink = await inkPixels(doc);
    // 320×180 的视口里，两个方框各约 68×30 像素；三者相加远多于任何一个
    expect(ink.length, '画面几乎是空的').toBeGreaterThan(2500);

    // 左方块区域（中心 x=160-72=88，y=90）
    expect(inBox(ink, 50, 70, 126, 110), 'CPU 方块没画出来').toBeGreaterThan(500);
    // 右方块区域（中心 x=160+72=232）
    expect(inBox(ink, 194, 70, 270, 110), '内存方块没画出来').toBeGreaterThan(500);
    // 中间连线区域
    expect(inBox(ink, 128, 84, 192, 96), '总线/箭头没画出来').toBeGreaterThan(60);
  });

  it('确定性：同一帧渲染两次逐字节相同', () => {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#3ad07a') }, ['rect#1']);
    expect(hash(doc)).toBe(hash(doc));
  });
});

/**
 * P2：高亮真的改变画面。
 *
 * ★ 结构断言只能证明"样式对象上的颜色字段变了"，证明不了画笔把它画对了。
 *   这一组比像素 —— 与形状系统那组同一个理由。
 */
describe.skipIf(!ENABLED)('★ P2 高亮：颜色与发光真的变了', () => {
  function highlighted(start: number, duration: number): SceneDoc {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#16223a') }, ['rect#1']);
    return {
      ...doc,
      effects: {
        'eff#1': {
          type: 'highlight',
          target: 'rect#1',
          params: { start: { v: start }, duration: { v: duration }, color: { v: '#ffd479' }, intensity: { v: 1 } },
        },
      },
      objects: { 'rect#1': { ...doc.objects['rect#1']!, effects: ['eff#1'] } },
    };
  }

  it('★ 高亮前后的两帧必须不同（颜色 + 发光 + 线宽都变了）', () => {
    const doc = highlighted(1, 0.5);
    expect(hash(doc, 0.2)).not.toBe(hash(doc, 3));
  });

  it('★ 高亮后的帧里真的能数到高亮色的像素', async () => {
    const doc = highlighted(0, 0.1);
    const png = renderFrames(doc, [3])[0]?.png;
    if (png === undefined) throw new Error('没有渲染出帧');
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      // #ffd479 = 255,212,121
      if (
        Math.abs((d[i] ?? 0) - 255) <= 10 &&
        Math.abs((d[i + 1] ?? 0) - 212) <= 10 &&
        Math.abs((d[i + 2] ?? 0) - 121) <= 10
      ) {
        n++;
      }
    }
    expect(n, '画面里没有高亮色的像素 —— 高亮没画出来').toBeGreaterThan(100);
  });

  it('★ drawOn 与 highlight 共存：几何在长，颜色同时是高亮的', () => {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#16223a') }, ['rect#1']);
    const both: SceneDoc = {
      ...doc,
      effects: {
        'eff#draw': {
          type: 'drawOn',
          target: 'rect#1',
          params: { start: { v: 0 }, duration: { v: 4 }, mode: { v: 'arc' }, tip: { v: true } },
        },
        'eff#hl': {
          type: 'highlight',
          target: 'rect#1',
          params: { start: { v: 0 }, duration: { v: 0.2 }, color: { v: '#ffd479' }, intensity: { v: 1 } },
        },
      },
      objects: { 'rect#1': { ...doc.objects['rect#1']!, effects: ['eff#draw', 'eff#hl'] } },
    };
    // 三个时刻：刚起步 / 长到一半 / 快长完 —— 几何与颜色都在变，两两必须不同
    expect(hash(both, 0.1)).not.toBe(hash(both, 2));
    expect(hash(both, 2)).not.toBe(hash(both, 3.9));
  });
});

/**
 * P2 第四条：appear / disappear 的像素级证据。
 *
 * ★ 这一条要证明的不是"结构里那一项没了"（engine-core 的 visibility.test.ts 已经证过），
 *   而是**画面上真的没有它** —— 两者的差别正是本项目最贵的一课
 *   （"画出来了"和"看得出画出来了"是两件事，而区分它们只能靠数像素）。
 *   判据用"一个高饱和填充色的像素数"：它在 = 一大片；它不在 = 0。
 */
describe.skipIf(!ENABLED)('★ P2 显隐：到点才出现 / 到点就消失', () => {
  function visibleWindow(appearAt: number, disappearAt: number): SceneDoc {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#ff00ff') }, ['rect#1']);
    return {
      ...doc,
      effects: {
        'eff#a': { type: 'appear', target: 'rect#1', params: { at: { v: appearAt } } },
        'eff#d': { type: 'disappear', target: 'rect#1', params: { at: { v: disappearAt } } },
      },
      objects: { 'rect#1': { ...doc.objects['rect#1']!, effects: ['eff#a', 'eff#d'] } },
    };
  }

  it('出现之前画面上一个该颜色的像素都没有', async () => {
    const doc = visibleWindow(1, 1.9);
    expect(await countExact(doc, 0.5, '#ff00ff')).toBe(0);
  });

  it('窗口内它确实被画出来了（不是"少画了一层"这种假通过）', async () => {
    const doc = visibleWindow(1, 1.9);
    expect(await countExact(doc, 1, '#ff00ff')).toBeGreaterThan(500);
  });

  it('消失之后又归零', async () => {
    const doc = visibleWindow(1, 1.5);
    expect(await countExact(doc, 2, '#ff00ff')).toBe(0);
  });

  it('★ 与"透明度 0"不是一回事：透明度 0 的对象【不】产生像素，但它仍然在 RenderState 里', async () => {
    // 这一条把"真显隐"的判据钉在【画面】上：两者在像素上等价（命中测试也一样跳过），
    // 差别在 RenderState —— 隐藏的对象根本不在那一帧，透明那个会被报成 visible=0。
    // 那一半由 engine-core 的 visibility.test.ts 守。
    const faded = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#ff00ff') }, ['rect#1']);
    const doc: SceneDoc = {
      ...faded,
      objects: { 'rect#1': { ...faded.objects['rect#1']!, tf: { ...faded.objects['rect#1']!.tf, opacity: 0 } } },
    };
    expect(await countExact(doc, 1, '#ff00ff')).toBe(0);
  });
});

/**
 * P3 第一块：文字对齐 + 自动换行（"一行标题" → "能排版的一段话"）。
 *
 * ★ 结构断言能证明 lines 拆对了、包围盒算对了，但证明不了**第二行真的画出来了** ——
 *   而"画出来了"与"看得出画出来了"是两件事（本项目的旧账）。
 *   判据取两条，都对布局敏感：
 *     1. 折行之后墨迹**变窄**（一行放不下的字被挪到了第二行）；
 *     2. 在【单行版本的墨迹下边界之下】仍然有墨 —— 那就是第二行。
 */
describe.skipIf(!ENABLED)('★ P3 文字换行：第二行真的画出来了', () => {
  function textDoc(maxWidth: number): SceneDoc {
    const base = shapeDoc({}, []);
    return {
      ...base,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['text#1'] }],
      objects: {
        'text#1': {
          shape: 'text',
          owner: { kind: 'global' },
          params: { content: { v: '一二三四五六' } },
          style: { size: { v: 40 }, fill: { v: '#e8eef8' }, maxWidth: { v: maxWidth } },
          tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
          anim: {},
          effects: [],
        },
      },
    };
  }

  function inkSpan(pixels: readonly (readonly [number, number])[]): { w: number; yMax: number; yMin: number } {
    const xs = pixels.map(([x]) => x);
    const ys = pixels.map(([, y]) => y);
    return { w: Math.max(...xs) - Math.min(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
  }

  it('换行宽度一设，墨迹变窄，而且第一行下面出现了第二行', async () => {
    const single = await inkPixels(textDoc(0));
    const wrapped = await inkPixels(textDoc(160));
    const a = inkSpan(single);
    const b = inkSpan(wrapped);
    expect(b.w, '折行之后应该变窄').toBeLessThan(a.w);
    expect(b.yMax - b.yMin).toBeGreaterThan(a.yMax - a.yMin);
    // ★ 关键：单行版的墨迹下边界之下还有墨 —— 那就是第二行
    const below = wrapped.filter(([, y]) => y > a.yMax + 2);
    expect(below.length, '第一行下面没有墨：第二行没画出来').toBeGreaterThan(50);
  });

  it('★ 粗体真的更重（同样的字，墨多出来）', async () => {
    const doc = textDoc(0);
    const withBold = (bold: boolean): SceneDoc => ({
      ...doc,
      objects: {
        'text#1': {
          ...(doc.objects['text#1'] as SceneObject),
          style: { size: { v: 40 }, fill: { v: '#e8eef8' }, bold: { v: bold } },
        },
      },
    });
    const plainInk = (await inkPixels(withBold(false))).length;
    const boldInk = (await inkPixels(withBold(true))).length;
    // 真实 700 字面的笔画更粗 —— 墨迹至少多一成（阈值刻意宽松，避免与抗锯齿较劲）
    expect(boldInk, '粗体没有更重：可能退回了常规字面').toBeGreaterThan(plainInk * 1.1);
  });

  it('★ 对齐会真的挪动文字（left 的墨迹在锚点右侧、right 在左侧）', async () => {
    const doc = textDoc(0);
    const withAlign = (align: string): SceneDoc => ({
      ...doc,
      objects: {
        'text#1': {
          ...(doc.objects['text#1'] as SceneObject),
          style: { size: { v: 24 }, fill: { v: '#e8eef8' }, align: { v: align } },
        },
      },
    });
    const centroidX = async (d: SceneDoc): Promise<number> => {
      const px = await inkPixels(d);
      return px.reduce((sum, [x]) => sum + x, 0) / px.length;
    };
    const left = await centroidX(withAlign('left'));
    const right = await centroidX(withAlign('right'));
    // 锚点在屏幕中心（视口 320×180 → x=160）：左对齐 → 文字在锚点右侧
    expect(left).toBeGreaterThan(160);
    expect(right).toBeLessThan(160);
    expect(left - right).toBeGreaterThan(40);
  });
});

/**
 * P3 后半：公式（方案 B —— 几何由工具物化，画笔只填点列）。
 *
 * ★ 这一组要证明的**不是"公式画出来了"**（结构断言已经证明 items 里有它），
 *   而是两件只有像素能回答的事：
 *     1. **洞还在**：字形轮廓里的洞靠子路径的绕向表达（nonzero 环绕规则）。
 *        如果实现成"逐个子路径单独 fill"，那个洞会被填实 —— 而结构断言全绿。
 *     2. **墨真的落在该在的地方**：包围盒与墨迹的范围要对得上。
 */
describe.skipIf(!ENABLED)('★ P3 公式：几何真的画出来了（含洞）', () => {
  /** 外面一个方块 + 里面一个反向方块 = 一个"环形"，洞必须留空。 */
  const RING = '0,-1 1,-1 1,0 0,0;0.3,-0.7 0.3,-0.3 0.7,-0.3 0.7,-0.7';

  function formulaDoc(paths: string): SceneDoc {
    const base = shapeDoc({}, []);
    return {
      ...base,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['formula#1'] }],
      objects: {
        'formula#1': {
          shape: 'formula',
          owner: { kind: 'global' },
          params: {
            source: { v: 'ring' },
            paths: { v: paths },
            width: { v: 1 },
            ascent: { v: 1 },
            depth: { v: 0 },
          },
          style: { size: { v: 80 }, fill: { v: '#ff00ff' } },
          tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
          anim: {},
          effects: [],
        },
      },
    };
  }

  it('★ 反向子路径的洞【留空】（逐个子路径单独填充会把它填实）', async () => {
    const pixels = await inkPixels(formulaDoc(RING));
    expect(pixels.length, '一点墨都没有：公式没画出来').toBeGreaterThan(500);
    // 视口 320×180、世界 16×9 → base = 20px/单位；对象在原点 = 屏幕中心 (160,90)
    // 几何 1em = 80px：外框 = [160,240] × [10,90]，洞 = [184,216] × [34,66]
    const outer = inBox(pixels, 162, 12, 238, 88);
    const hole = inBox(pixels, 186, 36, 214, 64);
    expect(outer, '外框没有墨').toBeGreaterThan(300);
    expect(hole, '洞被填实了：子路径没有按 nonzero 环绕规则一起填充').toBeLessThan(20);
  });

  it('坏几何：一个像素都不画（而不是画一个错的东西）', async () => {
    expect((await inkPixels(formulaDoc('garbage'))).length).toBe(0);
  });

  it('墨迹落在外框之内（包围盒与画出来的东西对得上）', async () => {
    const pixels = await inkPixels(formulaDoc(RING));
    const xs = pixels.map(([x]) => x);
    const ys = pixels.map(([, y]) => y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(158);
    expect(Math.max(...xs)).toBeLessThanOrEqual(242);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...ys)).toBeLessThanOrEqual(92);
  });
});

/**
 * P2 第二条：颜色轨道（style.stroke 的关键帧）。
 *
 * ★ 要证明的不是"两帧不同"（那太弱：线宽/发光变化也会让两帧不同），
 *   而是**画面上真的出现了那个中间色** —— 即"插值发生了"。
 */
describe.skipIf(!ENABLED)('★ P2 颜色轨道：画面上真的有中间色', () => {
  function withStrokeTrack(): SceneDoc {
    const doc = shapeDoc({ 'rect#1': box('rect#1', 0, 0, '#16223a') }, ['rect#1']);
    return {
      ...doc,
      objects: {
        'rect#1': {
          ...doc.objects['rect#1']!,
          style: { ...doc.objects['rect#1']!.style, width: { v: 4 }, glow: { v: 0 } },
          anim: {
            'style.stroke': {
              kind: 'keys',
              keys: [
                { t: 0, v: '#0000ff' },
                { t: 2, v: '#ffff00' },
              ],
            },
          },
        },
      },
    };
  }

  it('两端的描边色真的画出来了（蓝 / 黄）', async () => {
    const doc = withStrokeTrack();
    expect(await countExact(doc, 0, '#0000ff'), '起点没有蓝色').toBeGreaterThan(50);
    expect(await countExact(doc, 2, '#ffff00'), '终点没有黄色').toBeGreaterThan(50);
  });

  it('★ 中途出现的是【中间色】#808080，而两端色都不在', async () => {
    const doc = withStrokeTrack();
    // 线性：k=0.5 → 蓝 (0,0,255) 与黄 (255,255,0) 的中点 = (128,128,128)
    const mid = await countExact(doc, 1, '#808080', 10);
    expect(mid, '画面里没有中间色 —— 说明颜色没有插值（只是到点跳变）').toBeGreaterThan(50);
    expect(await countExact(doc, 1, '#0000ff'), '中途不该还是纯蓝').toBe(0);
    expect(await countExact(doc, 1, '#ffff00'), '中途不该已经是纯黄').toBe(0);
  });

  it('★ 颜色随时刻连续变化：每一刻都精确落在插值算出的那个色上', async () => {
    const doc = withStrokeTrack();
    /**
     * 关键帧是 0s 纯蓝 → 2s 纯黄，线性。所以：
     *   t=0.5 → 25%  → rgb(64,64,191)  = #4040bf
     *   t=1   → 50%  → rgb(128,128,128) = #808080
     *   t=1.5 → 75%  → rgb(191,191,64)  = #bfbf40
     *
     * ★ 用【精确匹配】而不是"找一个宽色带"：抗锯齿会把边缘像素混成任意中间值，
     *   宽色带等于把"插值对了"和"抗锯齿碰巧混出这个色"混为一谈。
     *   宽 4px 的描边中心一定有几百个纯色像素，所以精确匹配是可靠判据
     *   （实测每帧 748 个纯色像素）。
     */
    const at = (t: number, hex: string): Promise<number> => countExact(doc, t, hex, 4);
    expect(await at(0.5, '#4040bf'), 't=0.5 不是 25% 处的颜色').toBeGreaterThan(300);
    expect(await at(1, '#808080'), 't=1 不是 50% 处的颜色').toBeGreaterThan(300);
    expect(await at(1.5, '#bfbf40'), 't=1.5 不是 75% 处的颜色').toBeGreaterThan(300);
  });
});

/**
 * ★ P2 moveAlong：对象真的沿着那条线走。
 *
 * 结构断言能证明"算出来的位置对了"，证明不了画笔把它画在了那里 ——
 * 本项目出过一次"结构对了而画面没变"，所以这一组比像素。
 * 判据是【某个颜色的墨迹重心】：它比"某个窗口里有多少像素"稳得多，
 * 因为它对描边宽度、抗锯齿、图形大小的变化都不敏感。
 */
describe.skipIf(!ENABLED)('★ P2 moveAlong：对象真的沿着那条线走（像素级）', () => {
  /** 一个小方块（点），颜色与线不同，便于只数它的像素。 */
  function dot(id: string, fill: string): SceneObject {
    return {
      shape: 'rect',
      owner: { kind: 'global' },
      params: { width: { v: 0.6 }, height: { v: 0.6 }, radius: { v: 0.1 } },
      style: { stroke: { v: fill }, width: { v: 2 }, fill: { v: fill }, fillOpacity: { v: 1 }, glow: { v: 0 } },
      tf: { x: 99, y: 99, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {},
      effects: ['eff#1'],
    };
  }

  /** 一帧里某个颜色的墨迹重心 x（没有该颜色时返回 null）。 */
  async function centroidX(doc: SceneDoc, t: number, hex: string, tol = 8): Promise<number | null> {
    const png = renderFrames(doc, [t])[0]?.png;
    if (png === undefined) throw new Error('没有渲染出帧');
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(png);
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let sum = 0;
    let n = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (
          Math.abs((data[i] ?? 0) - r) <= tol &&
          Math.abs((data[i + 1] ?? 0) - g) <= tol &&
          Math.abs((data[i + 2] ?? 0) - b) <= tol
        ) {
          sum += x;
          n++;
        }
      }
    }
    return n === 0 ? null : sum / n;
  }

  /**
   * 线从世界 (−3,0) 到 (3,0)，方块沿它走。
   * 视口 320×180、世界 16×9 → base = 20，所以世界 x 映射到像素 160 + 20x：
   *   −3 → 100，0 → 160，+3 → 220。
   */
  function moveDoc(): SceneDoc {
    return shapeDoc(
      {
        'line#1': arrow('line#1', [-3, 0], [3, 0], 'arrow'),
        'dot#1': dot('dot#1', '#3ad07a'),
      },
      ['line#1', 'dot#1'],
      {
        'eff#1': {
          type: 'moveAlong',
          target: 'dot#1',
          params: { source: { v: 'line#1' }, start: { v: 0 }, duration: { v: 2 } },
        },
      },
    );
  }

  it('★ 起点 / 中点 / 终点各自落在该在的像素位置上', async () => {
    const doc = moveDoc();
    const at0 = await centroidX(doc, 0, '#3ad07a');
    const at1 = await centroidX(doc, 1, '#3ad07a');
    const at2 = await centroidX(doc, 2, '#3ad07a');
    expect(at0, 't=0 时看不到方块（可能压根没画出来）').not.toBeNull();
    expect(at0 ?? 0).toBeCloseTo(100, -1); // 起点：世界 x=−3
    expect(at1 ?? 0).toBeCloseTo(160, -1); // 中点：世界 x=0
    expect(at2 ?? 0).toBeCloseTo(220, -1); // 终点：世界 x=+3
  });

  it('★ 它是【连续】走的，不是起点跳到终点（中间那一帧必须真的在中间）', async () => {
    const doc = moveDoc();
    const xs: number[] = [];
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      const c = await centroidX(doc, t, '#3ad07a');
      if (c === null) throw new Error('t=' + t + ' 时方块不见了');
      xs.push(c);
    }
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] ?? 0, '第 ' + i + ' 段没有前进：' + xs.join(' → ')).toBeGreaterThan((xs[i - 1] ?? 0) + 8);
    }
    // 走完停在终点：再往后一帧不能继续跑（也不能弹回去）
    const after = await centroidX(doc, 3, '#3ad07a');
    expect(after ?? 0).toBeCloseTo(xs[xs.length - 1] ?? 0, 0);
  });

  it('★ 路径跟着源对象动：把线挪走，方块也跟着挪（引用而不是复制）', async () => {
    const doc = moveDoc();
    const moved = shapeDoc(
      {
        'line#1': { ...arrow('line#1', [-3, 0], [3, 0], 'arrow'), tf: { x: 2, y: -1, rotate: 0, sx: 1, sy: 1, opacity: 1 } },
        'dot#1': dot('dot#1', '#3ad07a'),
      },
      ['line#1', 'dot#1'],
      {
        'eff#1': {
          type: 'moveAlong',
          target: 'dot#1',
          params: { source: { v: 'line#1' }, start: { v: 0 }, duration: { v: 2 } },
        },
      },
    );
    // 起点世界 (−1,−1) → 像素 (140, 110)：x 右移 40px、y 下移 20px
    const base0 = await centroidX(doc, 0, '#3ad07a');
    const moved0 = await centroidX(moved, 0, '#3ad07a');
    expect(moved0 ?? 0).toBeCloseTo((base0 ?? 0) + 40, -1);
  });
});

/**
 * 两镜文档，两个对象的几何【明显不同】（一条正弦、一条余弦、且位移相反），
 * 这样"哪一镜画了哪个"在像素上分得开。
 */
function twoShotDoc(): SceneDoc {
  const obj = (id: string, expr: string, x: number, owner: SceneObject['owner']): SceneObject => ({
    shape: 'plot2d',
    owner,
    params: { expr: { v: expr }, domain: { v: [-7, 7] }, samples: { v: 600 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: 0 } },
    tf: { x, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  });

  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 4, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 4, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1', 'plot#2', 'g#1'] }],
    objects: {
      'plot#1': obj('plot#1', 'sin(x)', 0, { kind: 'scene', sceneId: 's#1', bornAt: 0 }),
      'plot#2': obj('plot#2', 'cos(x)*3', 0, { kind: 'scene', sceneId: 's#2', bornAt: 2 }),
      // global：两镜都该看到它，所以它【不能】用来区分镜头
      'g#1': obj('g#1', '0', 0, { kind: 'global' }),
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [
      { id: 's#1', name: '一', bornAt: 0 },
      { id: 's#2', name: '二', bornAt: 2 },
    ],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function firstHash(doc: SceneDoc, t: number, sceneId?: string | null): string {
  const opts = sceneId === undefined ? {} : { sceneId };
  return renderFrames(doc, [t], opts)[0]?.sha256 ?? '';
}

describe.skipIf(!ENABLED)('多镜头：切换镜头真的改变像素', () => {
  const doc = twoShotDoc();

  it('列表里 planShotFrames 说这一帧属于 s#1 / s#2', () => {
    const plan = planShotFrames(doc);
    expect(plan.frameCount).toBe(16);
    expect(plan.frames[0]?.sceneId).toBe('s#1');
    expect(plan.frames[8]?.sceneId).toBe('s#2');
  });

  it('★ 同一时刻、不同镜头 → 像素不同（过滤真的作用到了画面上）', () => {
    // t=1 时两个对象都"存在"，但按镜头只该画一个
    expect(firstHash(doc, 1, 's#1')).not.toBe(firstHash(doc, 1, 's#2'));
  });

  it('★ 单镜头渲染 == 计划里那一帧的渲染（导出用的就是这条路径）', () => {
    const plan = planShotFrames(doc);
    for (const f of plan.frames) {
      expect(firstHash(doc, f.t, f.sceneId), 'frame ' + f.frame).toBe(
        renderFrames(doc, [f.t], { sceneId: f.sceneId })[0]?.sha256,
      );
    }
  });

  it('★ 不过滤（旧行为）与过滤后不同 —— 证明过滤不是空操作', () => {
    const unfiltered = firstHash(doc, 1);
    const shot1 = firstHash(doc, 1, 's#1');
    const shot2 = firstHash(doc, 1, 's#2');
    expect(unfiltered).not.toBe(shot1);
    expect(unfiltered).not.toBe(shot2);
  });

  it('★ global 对象在两镜里都在：去掉它之后两镜仍然不同，说明差异来自 scene 对象', () => {
    const onlyGlobal: SceneDoc = {
      ...doc,
      objects: { 'g#1': doc.objects['g#1']! },
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['g#1'] }],
    };
    // 只剩 global 时两镜画面必须相同
    expect(firstHash(onlyGlobal, 1, 's#1')).toBe(firstHash(onlyGlobal, 1, 's#2'));
    // 而完整文档两镜不同 → 差异确实来自 scene 对象
    expect(firstHash(doc, 1, 's#1')).not.toBe(firstHash(doc, 1, 's#2'));
  });

  it('★ 空档帧只画背景：与"空文档"逐字节相同', () => {
    const empty: SceneDoc = { ...doc, objects: {}, layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }] };
    expect(firstHash(doc, 1, null)).toBe(firstHash(empty, 1));
  });

  it('★ 没有镜头表的文档：不下传 sceneId 时像素与以前完全一致', () => {
    const noScenes: SceneDoc = { ...doc, scenes: [] };
    // 不过滤
    const raw = firstHash(noScenes, 1);
    // 显式过滤（传 null）也不该改变画面 —— 空表 = 单镜头旧行为
    expect(firstHash(noScenes, 1, null)).toBe(raw);
    expect(firstHash(noScenes, 1, 's#1')).toBe(raw);
  });

  it('确定性：同一帧渲染两次逐字节相同', () => {
    expect(firstHash(doc, 1, 's#1')).toBe(firstHash(doc, 1, 's#1'));
  });
});
