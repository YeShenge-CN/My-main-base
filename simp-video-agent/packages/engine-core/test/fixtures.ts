/**
 * 测试夹具：造 Scene Doc。
 * 刻意放在 test/ 而不是 src/ —— 它不参与引擎逻辑，只服务测试。
 */
import type { Camera, DocMeta, Effect, Layer, Scene, SceneDoc, SceneObject } from '../src/doc/types';

export function makeMeta(over: Partial<DocMeta> = {}): DocMeta {
  return {
    fps: 60,
    viewport: [1920, 1080],
    worldWidth: 16,
    worldHeight: 9,
    duration: 12,
    seed: 1234,
    ...over,
  };
}

export const DEFAULT_CAMERA: Camera = {
  keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }],
};

export function makeObject(id: string, shape = 'plot2d', over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape,
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
    style: {
      stroke: { v: '#4ea1ff' },
      width: { v: 3, min: 0.5, max: 10, step: 0.5 },
      glow: { v: 0.6 },
    },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

export function makeEffect(id: string, target: string, over: Partial<Effect> = {}): Effect {
  return {
    type: 'drawOn',
    target,
    params: {
      start: { v: 0.8 },
      duration: { v: 2.2 },
      mode: { v: 'arc', enum: ['domain', 'arc'] },
      tip: { v: true },
    },
    ...over,
  };
}

export interface MakeDocOptions {
  readonly layerCount?: number;
  readonly shape?: string;
  readonly duration?: number;
  readonly effectsPerObject?: number;
  readonly idPrefix?: string;
}

export function makeDoc(objectCount: number, opts: MakeDocOptions = {}): SceneDoc {
  const layerCount = Math.max(1, opts.layerCount ?? 1);
  const shape = opts.shape ?? 'plot2d';
  const duration = opts.duration ?? 12;
  const prefix = opts.idPrefix ?? 'plot';
  const effectsPerObject = opts.effectsPerObject ?? 0;

  const layerIds: string[] = [];
  for (let i = 0; i < layerCount; i++) {
    layerIds.push(i === 0 ? 'main' : i === 1 ? 'bg' : 'l' + i);
  }

  const objects: Record<string, SceneObject> = {};
  const effects: Record<string, Effect> = {};
  const buckets: string[][] = layerIds.map(() => []);

  for (let i = 1; i <= objectCount; i++) {
    const id = prefix + '#' + i;
    const effIds: string[] = [];
    for (let e = 0; e < effectsPerObject; e++) {
      const eid = 'eff#' + i + (e === 0 ? '' : '_' + e);
      effects[eid] = makeEffect(eid, id);
      effIds.push(eid);
    }
    objects[id] = makeObject(id, shape, { effects: effIds });
    const bucket = buckets[(i - 1) % layerCount];
    if (bucket !== undefined) bucket.push(id);
  }

  const layers: Layer[] = layerIds.map((id, i) => ({
    id,
    depth: 1 - i * 0.1,
    order: i + 1,
    parallax: i === 0 ? 0.5 : 1,
    objects: buckets[i] ?? [],
  }));

  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: makeMeta({ duration }),
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers,
    objects,
    effects,
    camera: DEFAULT_CAMERA,
    markers: [{ id: 'intro', t: 0 }],
    // 空表 = 单镜头（旧行为）。要造多镜头文档用 withScenes()。
    scenes: [],
    locks: {},
    audioTracks: [], // __AUDIO__
    captionTracks: [],
  };
}

/**
 * 给一份文档装镜头表。
 *
 * 字符串形式按"每镜 4 秒"自动排 bornAt：让测试只关心"几镜"，
 * 不关心手算出生时刻。要精确控制就传显式 bornAt。
 */
export function withScenes(
  doc: SceneDoc,
  specs: readonly (string | { readonly id: string; readonly name?: string; readonly bornAt: number })[],
): SceneDoc {
  const scenes: Scene[] = specs.map((spec, i) =>
    typeof spec === 'string'
      ? { id: spec, name: '镜头 ' + spec, bornAt: i * 4 }
      : { id: spec.id, name: spec.name ?? '镜头 ' + spec.id, bornAt: spec.bornAt },
  );
  return { ...doc, scenes };
}