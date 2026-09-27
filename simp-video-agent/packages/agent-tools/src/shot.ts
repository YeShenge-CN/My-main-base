/**
 * 一个空镜头长什么样 —— 唯一一份定义。
 *
 * ★ 这份 15 行的 JSON 之前在 p6-acceptance.test.ts 与 stress.test.ts 里各写了一遍，
 *   而两处已经漂了：压力的 completion 夹具是「空文档 + 空图层」，
 *   验收的夹具是「空文档 + 一个空图层 + 960×540」。差异本身不是问题，
 *   问题是"哪个才是新镜头的默认样子"没有唯一答案 —— 第三个调用方（CLI）出现时
 *   它只能再抄一遍，然后三份继续漂。
 *
 *   现在：测试、CLI、将来的面板都从这里取。要改默认视口/时长只改这里。
 */
import type { Layer, SceneDoc, SceneObject } from '@sva/engine-core';

export interface ShotPreset {
  readonly id: string;
  readonly label: string;
  /** 给人看的一句说明：这个预设适合什么任务。 */
  readonly description: string;
  readonly doc: SceneDoc;
}

function metaOf(viewport: readonly [number, number], duration: number, fps: number): SceneDoc['meta'] {
  return { fps, viewport, worldWidth: 16, worldHeight: 9, duration, seed: 1234 };
}

const THEME: SceneDoc['theme'] = { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 };

/** 一个 2D 曲线对象。参数与 style 都按 FieldRegistry 登记过的字段来。 */
export function makePlot(
  id: string,
  opts: {
    readonly expr?: string;
    readonly domain?: readonly [number, number];
    readonly samples?: number;
    readonly stroke?: string;
    readonly width?: number;
    readonly glow?: number;
    readonly owner?: SceneObject['owner'];
  } = {},
): SceneObject {
  return {
    shape: 'plot2d',
    owner: opts.owner ?? { kind: 'global' },
    params: {
      expr: { v: opts.expr ?? 'sin(x)' },
      domain: { v: opts.domain ?? [-7, 7] },
      samples: { v: opts.samples ?? 2400 },
    },
    style: {
      stroke: { v: opts.stroke ?? '#4ea1ff' },
      width: { v: opts.width ?? 3 },
      glow: { v: opts.glow ?? 0.6 },
    },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

function layerOf(id: string, order: number, objects: readonly string[]): Layer {
  return { id, depth: 1 / order, order, parallax: 1, objects };
}

function docOf(
  viewport: readonly [number, number],
  duration: number,
  fps: number,
  objects: Readonly<Record<string, SceneObject>>,
  effects: SceneDoc['effects'],
  locks: SceneDoc['locks'],
): SceneDoc {
  const ids = Object.keys(objects);
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: metaOf(viewport, duration, fps),
    theme: THEME,
    layers: [layerOf('main', 1, ids)],
    objects,
    effects,
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [{ id: 'intro', t: 0 }],
    // 空表 = 单镜头。这几个预设都是单镜头任务（P12 的多镜头串行还没接进来）。
    scenes: [],
    locks,
    audioTracks: [],
    captionTracks: [],
  };
}

/** 空镜头：什么对象都没有。completion 类任务（"画一条…"）从这里开始。 */
export function emptyShot(opts: { readonly viewport?: readonly [number, number]; readonly duration?: number; readonly fps?: number } = {}): SceneDoc {
  return docOf(opts.viewport ?? [960, 540], opts.duration ?? 12, opts.fps ?? 60, {}, {}, {});
}

/**
 * 带一条已有曲线的镜头，可选硬锁。
 * collab 类任务（"把这条线加粗"）从这里开始 —— 注意这类任务【必须】有已有对象，
 * 否则"这条曲线"没有指代对象（压力测试 #19/#20 曾因此被记成 Agent 失败）。
 */
export function shotWithPlot(opts: {
  readonly locks?: readonly string[];
  readonly expr?: string;
  readonly style?: { readonly width?: number; readonly glow?: number; readonly stroke?: string };
  readonly duration?: number;
  readonly viewport?: readonly [number, number];
} = {}): SceneDoc {
  const plot = makePlot('plot#1', {
    expr: opts.expr ?? 'sin(x)',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    ...(opts.style ?? {}),
  });
  let locks: SceneDoc['locks'] = {};
  for (const path of opts.locks ?? []) locks = { ...locks, [path]: { by: 'user', at: 1 } };
  return docOf(opts.viewport ?? [960, 540], opts.duration ?? 12, 60, { 'plot#1': plot }, {}, locks);
}

/**
 * 一张结构图：两个方块 + 一条箭头。
 *
 * ★ 它存在的理由有两个，都是实用的：
 *   1. 实机复查：在形状系统落地之前，引擎画不出任何"图" ——
 *      这个预设让"框图到底长什么样"可以一眼看到，而不用去造文档。
 *   2. 给 Agent 一个"结构图长什么样"的起点：它能看到方块与箭头的**具体坐标**
 *      （`--preset diagram`），比从零想世界坐标靠谱得多。
 */
export function shotWithDiagram(opts: { readonly viewport?: readonly [number, number]; readonly duration?: number } = {}): SceneDoc {
  const box = (id: string, x: number, fill: string, stroke: string): SceneObject => ({
    shape: 'rect',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { width: { v: 3.4 }, height: { v: 1.6 }, radius: { v: 0.18 } },
    style: {
      stroke: { v: stroke },
      width: { v: 2, min: 0.5, max: 200, step: 0.5 },
      fill: { v: fill },
      fillOpacity: { v: 1, min: 0, max: 1, step: 0.05 },
      glow: { v: 0.35, min: 0, max: 1, step: 0.05 },
    },
    tf: { x, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  });
  const arrow: SceneObject = {
    shape: 'line',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { from: { v: [-1.65, 0] }, to: { v: [1.65, 0] }, head: { v: 'arrow' } },
    style: {
      stroke: { v: '#7fb2ff' },
      width: { v: 2.5, min: 0.5, max: 200, step: 0.5 },
      headSize: { v: 16, min: 4, max: 400, step: 1 },
      glow: { v: 0.4, min: 0, max: 1, step: 0.05 },
    },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
  const base = docOf(
    opts.viewport ?? [960, 540],
    opts.duration ?? 8,
    60,
    {
      'rect#1': box('rect#1', -3.8, '#16223a', '#4ea1ff'),
      'rect#2': box('rect#2', 3.8, '#2a1d16', '#ffb454'),
      'line#1': arrow,
    },
    // ★ 给右边那个方块挂一条高亮：t=3s 起渐入 0.8 秒，之后【保持】高亮。
    //   这样 `--at 2,4` 两帧就能看出高亮到底有没有生效（P2 的手动复查入口）。
    {
      'eff#1': {
        type: 'highlight',
        target: 'rect#2',
        params: { start: { v: 3 }, duration: { v: 0.8 }, color: { v: '#ffd479' }, intensity: { v: 1 } },
      },
    },
    {},
  );
  return { ...base, objects: { ...base.objects, 'rect#2': { ...base.objects['rect#2']!, effects: ['eff#1'] } } };
}

/**
 * 分组的实机演示：同一张结构图，但两个方块挂在一个【分组对象】下面。
 *
 * ★ 画面与 `diagram` 应当**逐像素相同** —— 父级在原点、scale=1 时继承不该改变任何东西。
 *   这本身就是一条有用的检查（"分组有没有悄悄挪东西"）。
 *   真正看出分组的地方是改父级的 tf：`--preset grouped` 的父级带一点旋转与缩放，
 *   两个方块会一起倾斜、一起放大，而它们的 `tf` 一个都没改。
 */
export function shotWithGrouped(opts: { readonly viewport?: readonly [number, number] } = {}): SceneDoc {
  const base = shotWithDiagram(opts);
  const group: SceneObject = {
    // 分组对象本身是个很小的方框：它同时也被绘制（这是刻意的设计 ——
    // 分组不是一种"不可见的容器"，而是一个普通对象加上父子关系）。
    shape: 'rect',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { width: { v: 0.01 }, height: { v: 0.01 }, radius: { v: 0 } },
    style: { stroke: { v: '#00000000' }, width: { v: 0 }, fill: { v: '#00000000' }, fillOpacity: { v: 0 }, glow: { v: 0 } },
    // ★ 整组倾斜 8°、放大约 1.06 倍 —— 只改这一个对象的 tf
    tf: { x: 0, y: 0, rotate: 0.14, sx: 1.06, sy: 1.06, opacity: 1 },
    anim: {},
    effects: [],
  };
  return {
    ...base,
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['group#1', 'rect#1', 'rect#2', 'line#1'] }],
    objects: {
      'group#1': group,
      'rect#1': { ...base.objects['rect#1']!, parent: 'group#1' },
      'rect#2': { ...base.objects['rect#2']!, parent: 'group#1' },
      'line#1': { ...base.objects['line#1']!, parent: 'group#1' },
    },
  };
}

/**
 * 数据流走的实机演示：结构图 + 一个沿箭头移动的小方块。
 *
 * ★ 与 `diagram` / `grouped` 同一个理由：让"这个效果画出来到底长什么样"能一眼看到。
 *   `--at 0.5,2.5,5` 三帧就能看出小方块确实在箭头上推进（P2 moveAlong 的复查入口）。
 *
 * ★ 它同时是 prompt 里那句"先画好箭头，再让东西沿它走"的可执行例子：
 *   路径是【引用】line#1，所以把 line#1 挪一下，方块走的路也跟着挪。
 */
export function shotWithFlow(opts: { readonly viewport?: readonly [number, number] } = {}): SceneDoc {
  const base = shotWithDiagram(opts);
  const packet: SceneObject = {
    shape: 'rect',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { width: { v: 0.7 }, height: { v: 0.7 }, radius: { v: 0.12 } },
    style: {
      stroke: { v: '#3ad07a' },
      width: { v: 2, min: 0.5, max: 200, step: 0.5 },
      fill: { v: '#3ad07a' },
      fillOpacity: { v: 1, min: 0, max: 1, step: 0.05 },
      glow: { v: 0.5, min: 0, max: 1, step: 0.05 },
    },
    // 位置由 moveAlong 接管，这里的 tf 只是"没挂效果时的样子"
    tf: { x: -1.65, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: ['eff#2'],
  };
  return {
    ...base,
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1', 'rect#2', 'line#1', 'packet#1'] }],
    objects: { ...base.objects, 'packet#1': packet },
    effects: {
      ...base.effects,
      'eff#2': {
        type: 'moveAlong',
        target: 'packet#1',
        params: { source: { v: 'line#1' }, start: { v: 1 }, duration: { v: 2.4 } },
      },
    },
  };
}

/**
 * 显隐的实机演示：结构图 + 左边那个方块按时间进出场。
 *
 * ★ 与 flow 同一个理由：让"这个效果画出来到底长什么样"能一眼看到。
 *   `--at 1,3,7` 三帧就能看出它 t=2 才出现、t=6 就没了（P2 appear / disappear 的复查入口）。
 *
 * ★ 右边那个方块（rect#2）身上还有 diagram 自带的高亮 —— 两者互不干扰，
 *   顺带证明"多个效果共存"在这条路径上也是真的。
 */
export function shotWithVisibility(opts: { readonly viewport?: readonly [number, number] } = {}): SceneDoc {
  const base = shotWithDiagram(opts);
  return {
    ...base,
    effects: {
      ...base.effects,
      'eff#2': { type: 'appear', target: 'rect#1', params: { at: { v: 2 } } },
      'eff#3': { type: 'disappear', target: 'rect#1', params: { at: { v: 6 } } },
    },
    objects: {
      ...base.objects,
      'rect#1': { ...base.objects['rect#1']!, effects: ['eff#2', 'eff#3'] },
    },
  };
}

/** 预设表：CLI 的 `--preset` 与将来的面板共用同一份。 */
export const SHOT_PRESETS: readonly ShotPreset[] = [
  {
    id: 'empty',
    label: '空镜头',
    description: '没有任何对象。适合"画一条 y=…"这类从零生成的任务。',
    doc: emptyShot(),
  },
  {
    id: 'plot',
    label: '一条曲线',
    description: '已有一条 y=sin(x) 的曲线。适合"把它加粗/发光调高"这类改现有对象的任务。',
    doc: shotWithPlot(),
  },
  {
    id: 'diagram',
    label: '结构图（两方块 + 箭头）',
    description:
      'CPU → 内存 那样的框图。用来验证形状系统：矩形、圆角、填充、箭头各占一样。',
    doc: shotWithDiagram(),
  },
  {
    id: 'grouped',
    label: '结构图（挂在一个分组下）',
    description:
      '与 diagram 同一张图，但三个对象都挂在 group#1 下面。改 group#1 的 tf 能整组倾斜/缩放，' +
      '而三个子对象的 tf 一个都没改 —— 这就是分组的全部意义。',
    doc: shotWithGrouped(),
  },
  {
    id: 'flow',
    label: '数据流（箭头 + 沿它移动的方块）',
    description:
      '结构图上多了一个沿箭头移动的小方块（moveAlong）。用 --at 0.5,2.4,4 看它推进到哪 ——' +
      '路径引用的是 line#1，把 line#1 挪走，走的路也跟着挪。',
    doc: shotWithFlow(),
  },
  {
    id: 'visibility',
    label: '显隐（到点才出现 / 到点就消失）',
    description:
      '结构图上左边那个方块 t=2 才出现、t=6 就消失（appear / disappear）。' +
      '用 --at 1,3,7 看三帧：没有 / 有 / 又没有。它是"真显隐"，不是淡入淡出。',
    doc: shotWithVisibility(),
  },
  {
    id: 'locked',
    label: '一条曲线 + 三条硬锁',
    description:
      'width / glow / stroke 被用户锁住。适合验证协作路径：Agent 的改动会降级成提案，必须有人批准。',
    doc: shotWithPlot({ locks: ['plot#1.style.width', 'plot#1.style.glow', 'plot#1.style.stroke'] }),
  },
];

export function presetById(id: string): ShotPreset | undefined {
  return SHOT_PRESETS.find((p) => p.id === id);
}
