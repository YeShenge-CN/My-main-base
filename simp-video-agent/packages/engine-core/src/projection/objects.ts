/**
 * get_object() / list_objects()。
 *
 * 硬约束：get_object(id) 【只能】返回该对象自身、它的动画轨道、以及 target 指向它的效果。
 * 任何其它对象的数据都不允许出现 —— 否则模型会读到它没打算读的状态，
 * 而"读 → 改 → 再读"的节奏就没意义了。这条由 test/projection-object.test.ts 守着。
 */
import type { AnimTracks, Effect, EffectId, FieldAtom, ObjectId, OwnerInfo, SceneDoc, SceneObject } from '../doc/types';
import { layerOfObject, objectTimeWindow } from '../doc/types';
import { fieldValues } from '../doc/fields';

export type ObjectDetail = 'brief' | 'full';

/**
 * 字段读写实现已上移到 doc/fields.ts —— 命令层与日志层都要用它。
 * 这里保留再导出，是为了不让 P3 的调用方被迫改 import。
 */
export { fieldValues, unwrapField } from '../doc/fields';

export interface EffectView {
  readonly id: EffectId;
  readonly type: string;
  readonly target: ObjectId;
  readonly params: Readonly<Record<string, FieldAtom>>;
  readonly ease?: string;
}

export interface ObjectView {
  readonly id: ObjectId;
  readonly shape: string;
  readonly layerId?: string;
  readonly timeWindow: readonly [number, number];
  readonly owner: OwnerInfo;
  readonly tf: SceneObject['tf'];
  readonly params: Readonly<Record<string, FieldAtom>>;
  readonly style: Readonly<Record<string, FieldAtom>>;
  readonly effects: readonly EffectId[];
  /** detail === 'full' 时才有 */
  readonly anim?: AnimTracks;
  /** detail === 'full' 时才有：目标的完整效果参数 */
  readonly effectDetails?: readonly EffectView[];
  /** detail === 'full' 时才有：落在这个对象路径下的锁 */
  readonly locks?: readonly string[];
}

/**
 * 对象相对路径前缀。
 *
 * 约定（与规范 §5 的 locks 示例一致）：
 *   锁键与动画轨道路径都写成【对象相对】形式 —— "plot#1.style.width"、"tf.opacity"，
 *   而不是 "objects.plot#1.style.width"。两者用同一套约定，避免同一件事有两种写法。
 */
export function objectPathPrefix(id: ObjectId): string {
  return id + '.';
}

function effectView(eid: EffectId, eff: Effect): EffectView {
  const base = {
    id: eid,
    type: eff.type,
    target: eff.target,
    params: fieldValues(eff.params),
  };
  return eff.ease === undefined ? base : { ...base, ease: eff.ease };
}

/** 返回 target 指向该对象的效果，按 id 稳定排序。 */
export function effectsTargeting(doc: SceneDoc, id: ObjectId): readonly EffectId[] {
  return Object.keys(doc.effects)
    .filter((eid) => doc.effects[eid]?.target === id)
    .sort();
}

export function getObject(doc: SceneDoc, id: ObjectId, detail: ObjectDetail = 'brief'): ObjectView | null {
  const obj = doc.objects[id];
  if (obj === undefined) return null;

  const layerId = layerOfObject(doc, id);
  const base = {
    id,
    shape: obj.shape,
    timeWindow: objectTimeWindow(doc, obj),
    owner: obj.owner,
    tf: obj.tf,
    params: fieldValues(obj.params),
    style: fieldValues(obj.style),
    effects: effectsTargeting(doc, id),
  };
  const withLayer = layerId === undefined ? base : { ...base, layerId };

  if (detail === 'brief') return withLayer;

  const prefix = objectPathPrefix(id);
  const locks = Object.keys(doc.locks)
    .filter((p) => p.startsWith(prefix))
    .sort();
  const effectDetails = base.effects
    .map((eid) => {
      const eff = doc.effects[eid];
      return eff === undefined ? null : effectView(eid, eff);
    })
    .filter((v): v is EffectView => v !== null);

  return { ...withLayer, anim: obj.anim, effectDetails, locks };
}

export interface ListObjectsFilter {
  readonly layerId?: string;
  readonly type?: string;
}

export interface ObjectListEntry {
  readonly id: ObjectId;
  readonly type: string;
  readonly layerId?: string;
  readonly t: readonly [number, number];
}

/**
 * 列表只给"定位信息"，不给参数值 —— 参数值一律走 get_object()。
 */
export function listObjects(doc: SceneDoc, filter: ListObjectsFilter = {}): readonly ObjectListEntry[] {
  const layerOf = new Map<string, string>();
  for (const layer of doc.layers) {
    for (const oid of layer.objects) {
      if (!layerOf.has(oid)) layerOf.set(oid, layer.id);
    }
  }

  const out: ObjectListEntry[] = [];
  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    if (obj === undefined) continue;
    const layerId = layerOf.get(id);
    if (filter.layerId !== undefined && layerId !== filter.layerId) continue;
    if (filter.type !== undefined && obj.shape !== filter.type) continue;
    const base = { id, type: obj.shape, t: objectTimeWindow(doc, obj) };
    out.push(layerId === undefined ? base : { ...base, layerId });
  }
  return out;
}
