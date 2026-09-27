/**
 * get_scene_summary() —— Agent 的默认入口。
 *
 * 设计要点（规范 §13 P3 + 用户 P3 清单）：
 *  1. objects[] 里【没有参数值】。要改就先 get_object()。
 *     这强制形成"读 → 改 → 再读"的节奏，是抑制状态漂移最有效的手段。
 *  2. 硬预算。默认见 DEFAULT_SUMMARY_TOKEN_BUDGET。超预算时按【尾部截断】，
 *     并把截断了多少如实写进 truncated 字段 —— 静默丢数据比超预算更糟。
 *  3. cursor / focus 不属于引擎状态，绝不放进这里。
 *     "Agent 当前关注对象"归 Agent Working State，"UI 选中对象"归 UI State。
 *
 * 关于预算的实现：截断要分两步，因为 truncated 本身也占 token。
 *   第一步：贪心填充，保证"还没有 truncated 字段时"不超预算；
 *   第二步：补上 truncated 披露字段后如果又超了，从尾部继续丢，直到真的不超。
 *   少了第二步就会出现"以为没超、加上说明就超了"的经典 bug。
 */
import type { EffectId, LayerId, SceneDoc } from '../doc/types';
import { objectTimeWindow, sceneEnd, sceneOrder } from '../doc/types';
import { unwrapField } from './objects';
import { tokensOfJson } from './tokens';

export interface SceneSummaryObjectEntry {
  readonly id: string;
  readonly type: string;
  /** 对象只落在一个图层上时才有值 */
  readonly layer?: LayerId;
  /** 时间窗。等于 [0, duration] 时省略（最常见的情形，省下的 token 很可观） */
  readonly t?: readonly [number, number];
}

export interface SceneSummaryEffectEntry {
  readonly id: EffectId;
  readonly type: string;
  readonly target: string;
  readonly range: readonly [number, number];
}

/**
 * 一个镜头在摘要里的样子。
 *
 * ★ 它存在的理由：镜头表决定"这一帧该看哪些对象"，而在此之前模型
 *   **完全看不到它** —— `get_scene_summary` 连"文档里有几镜"都不说。
 *   实测代价（压力测试轨迹）：模型为了搞清状况自己去 render 画面。
 *   现在把边界直接给它。
 */
export interface SceneSummarySceneEntry {
  readonly id: string;
  readonly name: string;
  /** [起点, 结束点)。结束点是派生的（= 下一镜起点 / 片长），但模型需要它。 */
  readonly range: readonly [number, number];
  /** 属于这一镜的对象数（不含 shared / global）。 */
  readonly objects: number;
}

export interface SummaryTruncation {
  readonly objectsOmitted: number;
  readonly effectsOmitted: number;
  readonly markersOmitted: number;
  readonly locksOmitted: number;
  readonly scenesOmitted: number;
  /** 被省掉的对象按 shape 归类，让模型知道"少了些什么" */
  readonly omittedByType: Readonly<Record<string, number>>;
}

export interface SceneSummary {
  readonly v: number;
  readonly duration: number;
  readonly fps: number;
  readonly layers: readonly LayerId[];
  readonly objects: readonly SceneSummaryObjectEntry[];
  readonly effects: readonly SceneSummaryEffectEntry[];
  readonly cameraShots: number;
  /**
   * 镜头表。
   *
   * ★ 空数组 = 没有镜头表 = 单镜头（旧行为），此时全片一镜、不需要按镜过滤。
   *   与 `scenes` 字段缺失是同一口径（见 doc/types.ts 的 scenesOf）。
   */
  readonly scenes: readonly SceneSummarySceneEntry[];
  /** 形如 "intro@0" */
  readonly markers: readonly string[];
  readonly locks: readonly string[];
  readonly issues: number;
  /** 只有真的截断了才出现 */
  readonly truncated?: SummaryTruncation;
}

/**
 * 摘要的默认硬预算。
 *
 * ★★ 第二十九轮按【用户拍板】从 1000 抬到 4000。
 *   实测症状（§0.28 三 ③）：约 50–60 个对象就顶到 1000，尾部被截断；
 *   整片第 2 镜的 Agent 因此连着调了 10 次 get_object 去把被截掉的信息补回来 ——
 *   一次 get_object 的回执比"多给 summary 3000 token"还贵，而且更慢。
 *   上限只管住"一次回执最多多大"，真正的省法是不让它退化成 N 次单查。
 */
export const DEFAULT_SUMMARY_TOKEN_BUDGET = 4000;

export interface SummaryOptions {
  /** 硬预算，默认见 DEFAULT_SUMMARY_TOKEN_BUDGET */
  readonly tokenBudget?: number;
  /** 校验器产出的问题数。P7 接上 validate() 之前恒为 0。 */
  readonly issues?: number;
}

/**
 * 镜头表那一节。
 *
 * ★ 顺序用 sceneOrder 归一化（表的数组顺序不是真源），结束点用 sceneEnd 派生。
 * ★ 只数【本镜】的对象：shared / global 不属于任何单镜，混进来会让"这一镜有几个东西"
 *   变成一个会误导人的数。
 */
function sceneEntries(doc: SceneDoc): SceneSummarySceneEntry[] {
  const out: SceneSummarySceneEntry[] = [];
  for (const s of sceneOrder(doc)) {
    let n = 0;
    for (const [, obj] of Object.entries(doc.objects)) {
      if (obj.owner.kind === 'scene' && obj.owner.sceneId === s.id) n += 1;
    }
    out.push({ id: s.id, name: s.name, range: [s.bornAt, sceneEnd(doc, s.id)], objects: n });
  }
  return out;
}

/**
 * 单条对象条目。两条"冗余即省略"的规则（都是纯省 token，不损失信息）：
 *   1. 时间窗等于 [0, duration] 时省略 t —— 这是绝大多数情形的默认值；
 *   2. 文档只有一个图层时省略 layer —— 每个对象都是同一个值。
 * 被省略的东西在 list_objects() 里永远能拿到，所以不存在"看不见"。
 */
function objectEntry(
  doc: SceneDoc,
  id: string,
  layer: LayerId | undefined,
  singleLayer: boolean,
): SceneSummaryObjectEntry {
  const obj = doc.objects[id];
  const shape = obj === undefined ? 'unknown' : obj.shape;
  const timeWindow =
    obj === undefined ? ([0, doc.meta.duration] as const) : objectTimeWindow(doc, obj);
  const spansWhole = timeWindow[0] === 0 && timeWindow[1] === doc.meta.duration;
  const showLayer = !singleLayer && layer !== undefined;
  const base = showLayer ? { id, type: shape, layer } : { id, type: shape };
  return spansWhole ? base : { ...base, t: [timeWindow[0], timeWindow[1]] as const };
}

function effectRange(doc: SceneDoc, effectId: EffectId): readonly [number, number] {
  const eff = doc.effects[effectId];
  if (eff === undefined) return [0, 0];
  const start = Number(unwrapField(eff.params['start']) ?? 0);
  const dur = Number(unwrapField(eff.params['duration']) ?? 0);
  const s = Number.isFinite(start) ? start : 0;
  const d = Number.isFinite(dur) ? dur : 0;
  return [s, s + d];
}

interface Truncation {
  objectsOmitted: number;
  effectsOmitted: number;
  markersOmitted: number;
  locksOmitted: number;
  scenesOmitted: number;
  omittedByType: Record<string, number>;
}

function anyTruncated(t: Truncation): boolean {
  return (
    t.objectsOmitted > 0 ||
    t.effectsOmitted > 0 ||
    t.markersOmitted > 0 ||
    t.locksOmitted > 0 ||
    t.scenesOmitted > 0
  );
}

export function getSceneSummary(doc: SceneDoc, opts: SummaryOptions = {}): SceneSummary {
  const budget = opts.tokenBudget ?? DEFAULT_SUMMARY_TOKEN_BUDGET;

  const layerOf = new Map<string, LayerId>();
  for (const layer of doc.layers) {
    for (const oid of layer.objects) {
      if (!layerOf.has(oid)) layerOf.set(oid, layer.id);
    }
  }

  const trunc: Truncation = {
    objectsOmitted: 0,
    effectsOmitted: 0,
    markersOmitted: 0,
    locksOmitted: 0,
    scenesOmitted: 0,
    omittedByType: {},
  };

  let current: SceneSummary = {
    v: doc.docVersion,
    duration: doc.meta.duration,
    fps: doc.meta.fps,
    layers: doc.layers.map((l) => l.id),
    objects: [],
    effects: [],
    cameraShots: doc.camera.keys.length,
    scenes: sceneEntries(doc),
    markers: [],
    locks: [],
    issues: opts.issues ?? 0,
  };

  const singleLayer = doc.layers.length <= 1;

  /**
   * ★★ 填充顺序 = 【从最不可牺牲到最可牺牲】。
   *
   *   这一版之前是"objects 放不下就 break"，于是预算一紧，后面的
   *   effects / markers / locks / scenes 全被静默跳过 —— 模型在最需要信息的时候，
   *   恰好丢掉的是【锁】（不看就会白提提案，而提案花的是用户的时间）与
   *   【镜头结构】（不看就不知道自己在哪一镜）。
   *
   *   现在按优先级填充，并且【先给 truncated 披露字段留出额度】：
   *   披露字段不是可选的（静默丢数据比超预算更糟），必须算进预算。
   *   留多了就在收缩阶段还回去（见下面 shrink 循环）。
   *
   *     1 locks    最不可牺牲：撞锁的代价是用户的时间
   *     2 objects  内容清单：模型靠它决定改哪个
   *     3 scenes   结构：有镜头表时才知道边界与归属
   *     4 effects  细节，能由 get_object 补
   *     5 markers  细节
   */
  const disclosureReserve = Math.max(24, Math.round(budget * 0.15));
  const fillBudget = Math.max(1, budget - disclosureReserve);
  const within = (s: SceneSummary): boolean => tokensOfJson(s) <= fillBudget;

  const shell: SceneSummary = {
    ...current,
    objects: [],
    effects: [],
    markers: [],
    locks: [],
  };
  current = shell;

  // ── 1. locks ─────────────────────────────────────────────────────
  const allLocks = Object.keys(doc.locks);
  const locks: string[] = [];
  for (let i = 0; i < allLocks.length; i++) {
    const path = allLocks[i];
    if (path === undefined) continue;
    if (!within({ ...current, locks: [...locks, path] })) {
      trunc.locksOmitted += allLocks.length - i;
      break;
    }
    locks.push(path);
  }
  current = { ...current, locks };

  // ── 2. objects ───────────────────────────────────────────────────
  const allIds = Object.keys(doc.objects);
  const objects: SceneSummaryObjectEntry[] = [];
  for (let i = 0; i < allIds.length; i++) {
    const id = allIds[i];
    if (id === undefined) continue;
    const entry = objectEntry(doc, id, layerOf.get(id), singleLayer);
    if (!within({ ...current, objects: [...objects, entry] })) {
      for (let j = i; j < allIds.length; j++) {
        const rest = allIds[j];
        if (rest === undefined) continue;
        trunc.objectsOmitted++;
        const shape = doc.objects[rest]?.shape ?? 'unknown';
        trunc.omittedByType[shape] = (trunc.omittedByType[shape] ?? 0) + 1;
      }
      break;
    }
    objects.push(entry);
  }
  current = { ...current, objects };

  // ── 3. scenes（注意 shell 里已经带了 scenes，这里只处理装不下的情形）──
  const scenes: SceneSummarySceneEntry[] = [];
  const allScenes = current.scenes;
  for (let i = 0; i < allScenes.length; i++) {
    const s = allScenes[i];
    if (s === undefined) continue;
    if (!within({ ...current, scenes: [...scenes, s] })) {
      trunc.scenesOmitted += allScenes.length - i;
      break;
    }
    scenes.push(s);
  }
  current = { ...current, scenes };

  // ── 4. effects ───────────────────────────────────────────────────
  const allEffects = Object.keys(doc.effects);
  const effects: SceneSummaryEffectEntry[] = [];
  for (let i = 0; i < allEffects.length; i++) {
    const eid = allEffects[i];
    if (eid === undefined) continue;
    const eff = doc.effects[eid];
    if (eff === undefined) continue;
    const entry: SceneSummaryEffectEntry = { id: eid, type: eff.type, target: eff.target, range: effectRange(doc, eid) };
    if (!within({ ...current, effects: [...effects, entry] })) {
      trunc.effectsOmitted += allEffects.length - i;
      break;
    }
    effects.push(entry);
  }
  current = { ...current, effects };

  // ── 5. markers ───────────────────────────────────────────────────
  const markers: string[] = [];
  for (let i = 0; i < doc.markers.length; i++) {
    const m = doc.markers[i];
    if (m === undefined) continue;
    const label = m.id + '@' + m.t;
    if (!within({ ...current, markers: [...markers, label] })) {
      trunc.markersOmitted += doc.markers.length - i;
      break;
    }
    markers.push(label);
  }
  current = { ...current, markers };

  // ── 6. 补上披露字段，然后【再收缩一遍】─────────────────────────────
  // 披露字段占了额度，收缩阶段把它还回去；披露字段本身也占 token，
  // 所以不能只做一次贪心填充。
  const build = (): SceneSummary => {
    if (!anyTruncated(trunc)) return current;
    return { ...current, truncated: { ...trunc, omittedByType: { ...trunc.omittedByType } } };
  };

  let out = build();
  /**
   * 上界保护：每次循环至少丢一个元素，entries 总数是有限的。
   *
   * ★ 丢弃顺序是填充顺序的【逆序】：先丢最可牺牲的。
   *   骨架本身（v/duration/fps/layers/issues）超预算时只能 break。
   */
  for (let guard = 0; tokensOfJson(out) > budget && guard < 100000; guard++) {
    if (current.effects.length > 0) {
      current = { ...current, effects: current.effects.slice(0, -1) };
      trunc.effectsOmitted++;
    } else if (current.markers.length > 0) {
      current = { ...current, markers: current.markers.slice(0, -1) };
      trunc.markersOmitted++;
    } else if (current.scenes.length > 0) {
      current = { ...current, scenes: current.scenes.slice(0, -1) };
      trunc.scenesOmitted++;
    } else if (current.objects.length > 0) {
      const dropped = current.objects[current.objects.length - 1];
      current = { ...current, objects: current.objects.slice(0, -1) };
      trunc.objectsOmitted++;
      const shape = dropped === undefined ? 'unknown' : dropped.type;
      trunc.omittedByType[shape] = (trunc.omittedByType[shape] ?? 0) + 1;
    } else if (current.locks.length > 0) {
      current = { ...current, locks: current.locks.slice(0, -1) };
      trunc.locksOmitted++;
    } else {
      break; // 骨架本身就超预算，没有可丢的了
    }
    out = build();
  }

  return out;
}
