/**
 * get_timeline() / get_effect() / get_camera() / get_markers()。
 *
 * 时间轴是【投影】，不是索引：每次调用都从 doc 现算，不维护任何缓存状态。
 * 这样它永远不会和 doc 失配（不变量 1 的直接推论）。
 */
import type { CameraKey, EffectId, SceneDoc } from '../doc/types';
import { objectTimeWindow } from '../doc/types';
import { effectsTargeting, fieldValues, objectPathPrefix, type EffectView } from './objects';
import { sampleCamera, type CameraState } from '../camera';

export type TimelineKind = 'object' | 'effect' | 'marker' | 'camera' | 'anim';

export interface TimelineEvent {
  readonly kind: TimelineKind;
  readonly t: number;
  /** 有持续时间的事件才有 end */
  readonly end?: number;
  /** 主体 id（对象 id / 效果 id / marker id） */
  readonly ref: string;
  /** 人类与模型都能读的一行说明 */
  readonly detail: string;
}

export interface TimelineOptions {
  readonly from?: number;
  readonly to?: number;
  readonly kinds?: readonly TimelineKind[];
  readonly maxEvents?: number;
}

const ALL_KINDS: readonly TimelineKind[] = ['object', 'effect', 'marker', 'camera', 'anim'];

function overlaps(t: number, end: number | undefined, from: number, to: number): boolean {
  const e = end ?? t;
  return e >= from && t <= to;
}

function effectRange(params: ReturnType<typeof fieldValues>): readonly [number, number] {
  const start = Number(params['start'] ?? 0);
  const dur = Number(params['duration'] ?? 0);
  const s = Number.isFinite(start) ? start : 0;
  const d = Number.isFinite(dur) ? dur : 0;
  return [s, s + d];
}

export function getTimeline(doc: SceneDoc, opts: TimelineOptions = {}): readonly TimelineEvent[] {
  const from = opts.from ?? 0;
  const to = opts.to ?? doc.meta.duration;
  const kinds = new Set(opts.kinds ?? ALL_KINDS);
  const events: TimelineEvent[] = [];

  if (kinds.has('object')) {
    for (const id of Object.keys(doc.objects)) {
      const obj = doc.objects[id];
      if (obj === undefined) continue;
      const w = objectTimeWindow(doc, obj);
      if (!overlaps(w[0], w[1], from, to)) continue;
      events.push({ kind: 'object', t: w[0], end: w[1], ref: id, detail: obj.shape });
    }
  }

  if (kinds.has('effect')) {
    for (const eid of Object.keys(doc.effects)) {
      const eff = doc.effects[eid];
      if (eff === undefined) continue;
      const r = effectRange(fieldValues(eff.params));
      if (!overlaps(r[0], r[1], from, to)) continue;
      events.push({
        kind: 'effect',
        t: r[0],
        end: r[1],
        ref: eid,
        detail: eff.type + ' -> ' + eff.target,
      });
    }
  }

  if (kinds.has('marker')) {
    for (const m of doc.markers) {
      if (!overlaps(m.t, undefined, from, to)) continue;
      events.push({ kind: 'marker', t: m.t, ref: m.id, detail: 'marker' });
    }
  }

  if (kinds.has('camera')) {
    doc.camera.keys.forEach((k, i) => {
      if (!overlaps(k.t, undefined, from, to)) return;
      events.push({
        kind: 'camera',
        t: k.t,
        ref: 'camera#' + i,
        detail: 'scale=' + k.scale + ' tx=' + k.tx + ' ty=' + k.ty,
      });
    });
  }

  if (kinds.has('anim')) {
    for (const id of Object.keys(doc.objects)) {
      const obj = doc.objects[id];
      if (obj === undefined) continue;
      for (const track of Object.keys(obj.anim)) {
        const tr = obj.anim[track];
        if (tr === undefined || tr.kind !== 'keys') continue;
        for (const key of tr.keys) {
          if (!overlaps(key.t, undefined, from, to)) continue;
          events.push({
            kind: 'anim',
            t: key.t,
            ref: objectPathPrefix(id) + track,
            detail: 'key=' + String(key.v),
          });
        }
      }
    }
  }

  events.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });

  const max = opts.maxEvents;
  if (max !== undefined && events.length > max) return events.slice(0, max);
  return events;
}

export interface EffectDetail extends EffectView {
  readonly range: readonly [number, number];
  /** 目标对象是否真的存在（引用完整性） */
  readonly targetExists: boolean;
  /** 是否有别的效果也打在同一目标上（重叠发光之类的常见坑） */
  readonly sharesTargetWith: readonly EffectId[];
}

export function getEffect(doc: SceneDoc, id: EffectId): EffectDetail | null {
  const eff = doc.effects[id];
  if (eff === undefined) return null;
  const params = fieldValues(eff.params);
  const others = effectsTargeting(doc, eff.target).filter((e) => e !== id);
  const base = {
    id,
    type: eff.type,
    target: eff.target,
    params,
    range: effectRange(params),
    targetExists: doc.objects[eff.target] !== undefined,
    sharesTargetWith: others,
  };
  return eff.ease === undefined ? base : { ...base, ease: eff.ease };
}

export interface CameraKeyView {
  readonly t: number;
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly rotate: number;
  readonly pivot: readonly [number, number];
  readonly ease?: string;
}

export interface CameraView {
  readonly shots: number;
  readonly keys: readonly CameraKeyView[];
  /** 分辨率无关的相机运动概览，用来一眼判断"这段镜头是不是死的" */
  readonly scaleMin: number;
  readonly scaleMax: number;
  readonly moves: boolean;
  readonly sampled?: CameraState;
}

export interface CameraQuery {
  readonly from?: number;
  readonly to?: number;
  /** 给定时刻，附带返回该时刻采样出来的相机状态 */
  readonly at?: number;
}

function keyView(k: CameraKey): CameraKeyView {
  const base = { t: k.t, tx: k.tx, ty: k.ty, scale: k.scale, rotate: k.rotate, pivot: k.pivot };
  return k.ease === undefined ? base : { ...base, ease: k.ease };
}

export function getCamera(doc: SceneDoc, q: CameraQuery = {}): CameraView {
  const from = q.from ?? Number.NEGATIVE_INFINITY;
  const to = q.to ?? Number.POSITIVE_INFINITY;
  const keys = doc.camera.keys.filter((k) => k.t >= from && k.t <= to).map(keyView);
  const scales = doc.camera.keys.map((k) => k.scale);
  const scaleMin = scales.length === 0 ? 1 : Math.min(...scales);
  const scaleMax = scales.length === 0 ? 1 : Math.max(...scales);
  const moves =
    doc.camera.keys.length > 1 ||
    scaleMin !== scaleMax ||
    doc.camera.keys.some((k) => k.tx !== 0 || k.ty !== 0 || k.rotate !== 0);

  const base = {
    shots: doc.camera.keys.length,
    keys,
    scaleMin,
    scaleMax,
    moves,
  };
  return q.at === undefined ? base : { ...base, sampled: sampleCamera(doc.camera, q.at) };
}

export interface MarkerView {
  readonly id: string;
  readonly t: number;
  /** 该时刻相机是否正好也在动（做转场点时的常用判据） */
  readonly atCameraKey: boolean;
}

export function getMarkers(doc: SceneDoc): readonly MarkerView[] {
  const cameraTimes = new Set(doc.camera.keys.map((k) => k.t));
  return doc.markers.map((m) => ({ id: m.id, t: m.t, atCameraKey: cameraTimes.has(m.t) }));
}
