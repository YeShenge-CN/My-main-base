/**
 * 时间顺延（P11 第 3、5 条 / P12 第 1、2 条）。
 *
 * ★ owner 权限在这里落地：
 *     scene  只有【本镜】的对象被顺延
 *     shared 只挪 usageWindows，本体（tf / anim / params）纹丝不动
 *     global 完全不动
 *
 * ★★ 镜头表也要顺延（P12 接上 scenes 之后的补充）。这一步不是可选的：
 *    对象跟着 fromMarker 往后走、而镜头边界不动，就会出现"对象属于 s#2，
 *    但它的内容已经不在 s#2 的时间段里"这种【同时成立】的矛盾状态 ——
 *    画面上还看不出异常，只会在写权限与镜头过滤开始生效之后才爆发。
 *
 * ★ 镜头边界的顺延口径（已定，由 test/retime-scenes.test.ts 守住）：
 *    **只有导演视角挪边界**，场景 Agent 一个都不挪（理由见下面第 1 步的注释）。
 *    导演视角下 bornAt ≥ from 的镜头起点整体 +delta，于是——
 *      · 被插入的那一镜【变长】（它的结束 = 下一镜起点，被推后了）
 *      · 后续镜头整体后移，窗口长度不变
 *    这是 A1 的必然推论："某镜结束 = 下一镜起点"意味着插入时间就是
 *    "把后面的东西整体推后"。想要"后面的内容不动、当前镜被压缩"是另一种语义，
 *    那需要显式给镜头存 end（= 被否掉的 A2），不要在这里偷偷换口径。
 *
 * 不传 scope = 导演视角 = 全量顺延（做整体调时间轴时用）。
 * 传了 scope = 场景 Agent 视角 = 按 owner 分流。
 */
import type { AnimTrack, Scene, SceneDoc } from './types';
import { sceneEnd } from './types';
import type { Scope } from './permissions';

export interface ShiftCollision {
  readonly objectId: string;
  readonly sceneId: string;
  /** 被顺延的那个时刻【原本】在哪（供调用方算"最多能顺延多少"）。 */
  readonly from: number;
  /** 顺延后最靠后的那个关键帧时刻。 */
  readonly at: number;
  /** 该镜【顺延后】的结束时刻。 */
  readonly sceneEnd: number;
}

export interface ShiftResult {
  readonly doc: SceneDoc;
  readonly shifted: number;
  /** 被顺延的 usageWindow 数（shared 对象只挪窗口） */
  readonly shiftedWindows: number;
  /** 因为 owner 权限被跳过的对象 */
  readonly skippedOwners: readonly string[];
  /** 被顺延的镜头数 */
  readonly shiftedScenes: number;
  /**
   * 顺延后仍会落在本镜窗口之外的对象。
   *
   * ★ 只有场景 Agent 视角才会产生它：导演把镜头表一起顺延就不会有越界。
   *   它必须让命令失败而不是静默通过 —— 见 apply.ts 的 retime 分支。
   */
  readonly collisions: readonly ShiftCollision[];
}

const EMPTY: ShiftResult = {
  doc: {} as SceneDoc,
  shifted: 0,
  shiftedWindows: 0,
  skippedOwners: [],
  shiftedScenes: 0,
  collisions: [],
};

/**
 * 顺延后的镜头表。bornAt ≥ from 的镜头起点 +delta。
 *
 * ★ 缺失的 scenes（存量文档 / 手写测试字面量）当空表处理 —— 与 types.ts 的
 *   scenesOf() 同一口径。这里直接 `doc.scenes.map` 会在存量文档上抛异常，
 *   而顺延是最常被调用的路径之一。
 */
function shiftScenes(scenes: readonly Scene[] | undefined, from: number, delta: number): readonly Scene[] {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((s) => (s.bornAt < from ? s : { ...s, bornAt: s.bornAt + delta }));
}

export function shiftTimeline(
  doc: SceneDoc,
  from: number,
  delta: number,
  scope?: Scope,
): ShiftResult {
  if (delta === 0) return { ...EMPTY, doc };

  let shifted = 0;
  let shiftedWindows = 0;
  const skippedOwners: string[] = [];
  const strict = scope !== undefined && scope.kind === 'scene';
  const activeSceneId = strict && scope.kind === 'scene' ? scope.sceneId : undefined;

  // ── 1. 镜头表 ──────────────────────────────────────────────────
  /**
   * ★ 只有【导演视角】才顺延镜头边界，场景 Agent 一个都不挪。
   *
   *   这一条是推了两遍才收敛的：场景 Agent 的 scope 是"本镜 [start,end]"，
   *   而 A1 下本镜的结束时刻 = 下一镜的起点 —— 于是"挪本镜边界"必然要么改到
   *   别人那一镜（越权），要么改到前一镜的结束时刻（也是越权）。
   *   所以场景 Agent 的合法空间是【本镜窗口的内部】：它挪内容，
   *   挪过头就把命令拦下来（见下面的越界预检），而不是去改谁的地界。
   *
   *   顺带一个好处：`shiftTimeline` 在 strict 下不再碰标量时间轴，
   *   与"strict 时 markers/effects/camera/audio 都不动"的口径完全一致。
   */
  const scenes = activeSceneId === undefined ? shiftScenes(doc.scenes, from, delta) : doc.scenes;
  const shiftedScenes = activeSceneId === undefined ? scenes.filter((s, i) => s !== doc.scenes[i]).length : 0;

  // ── 2. 越界预检：对象被推出本镜窗口就报出来，由调用方拦下这条命令 ──
  //    ★ strict 下镜头表没动，所以窗口就是原文档的窗口 —— 不必绕 shiftedDoc。
  //    ★ 只在场景 Agent 视角检查：导演视角下镜头表跟着内容一起走，不可能越界。
  const collisions: ShiftCollision[] = [];
  if (activeSceneId !== undefined) {
    const end = sceneEnd(doc, activeSceneId);
    for (const [id, obj] of Object.entries(doc.objects)) {
      if (obj.owner.kind !== 'scene' || obj.owner.sceneId !== activeSceneId) continue;
      let last: number | undefined;
      for (const node of Object.values(obj.anim)) {
        if (node.kind !== 'keys') continue;
        for (const k of node.keys) {
          if (k.t < from) continue;
          if (last === undefined || k.t > last) last = k.t;
        }
      }
      if (last !== undefined && last + delta > end) {
        collisions.push({ objectId: id, sceneId: activeSceneId, from: last, at: last + delta, sceneEnd: end });
      }
    }
  }

  // ── 3. 对象本体 ────────────────────────────────────────────────
  const objects: Record<string, SceneDoc['objects'][string]> = {};
  for (const [id, obj] of Object.entries(doc.objects)) {
    if (obj.owner.kind === 'global') {
      if (strict) skippedOwners.push(id);
      objects[id] = obj;
      continue;
    }

    if (obj.owner.kind === 'shared') {
      // 只挪窗口，本体不动
      const owner = obj.owner;
      const windows = owner.usageWindows.map((w) => {
        if (w[1] < from) return w;
        shiftedWindows += 1;
        return [w[0] + delta, w[1] + delta] as const;
      });
      objects[id] = { ...obj, owner: { ...owner, usageWindows: windows } };
      if (strict) skippedOwners.push(id);
      continue;
    }

    // scene
    if (activeSceneId !== undefined && obj.owner.sceneId !== activeSceneId) {
      skippedOwners.push(id);
      objects[id] = obj;
      continue;
    }

    const anim: Record<string, AnimTrack> = {};
    let touched = false;
    for (const [track, node] of Object.entries(obj.anim)) {
      if (node.kind !== 'keys') {
        anim[track] = node;
        continue;
      }
      let n = 0;
      const keys = node.keys.map((k) => {
        if (k.t < from) return k;
        n += 1;
        return { ...k, t: k.t + delta };
      });
      anim[track] = { kind: 'keys', keys };
      if (n > 0) touched = true;
    }
    objects[id] = touched ? { ...obj, anim } : obj;
    if (touched) shifted += 1;
  }

  // ── 4. 其余时间实体：strict 模式下属于镜头编排，场景 Agent 不碰 ──
  const shiftTimeEntities = !strict;

  const audioTracks = shiftTimeEntities
    ? doc.audioTracks.map((a) => (a.startAt < from ? a : ((shifted += 1), { ...a, startAt: a.startAt + delta })))
    : doc.audioTracks;

  const captionTracks = shiftTimeEntities
    ? doc.captionTracks.map((c) => {
        let touched = false;
        const cues = c.cues.map((cue) => (cue.t < from ? cue : ((touched = true), { ...cue, t: cue.t + delta })));
        if (touched) shifted += 1;
        return touched ? { ...c, cues } : c;
      })
    : doc.captionTracks;

  const markers = shiftTimeEntities
    ? doc.markers.map((m) => (m.t < from ? m : ((shifted += 1), { ...m, t: m.t + delta })))
    : doc.markers;

  const effects = shiftTimeEntities
    ? Object.fromEntries(
        Object.entries(doc.effects).map(([id, eff]) => {
          const raw = eff.params['start'];
          const value =
            typeof raw === 'object' && raw !== null && 'v' in raw
              ? Number((raw as { v: unknown }).v)
              : Number(raw ?? 0);
          if (!Number.isFinite(value) || value < from) return [id, eff];
          shifted += 1;
          return [id, { ...eff, params: { ...eff.params, start: { ...(raw as object), v: value + delta } } }];
        }),
      )
    : doc.effects;

  const cameraKeys = shiftTimeEntities
    ? doc.camera.keys.map((k) => (k.t < from ? k : ((shifted += 1), { ...k, t: k.t + delta })))
    : doc.camera.keys;

  /**
   * 5. 片长：整体 +delta，再确保不短于最后一镜的起点（B1 的单向规则）。
   *    顺序很重要 —— 单靠 duration+delta 会在"镜头起点本来就超出片长"的
   *    文档上留下不一致（那种文档已经坏了，但顺延不该让它更坏）。
   */
  let duration = Math.max(0.1, doc.meta.duration + delta);
  let lastBornAt = 0;
  for (const s of scenes) if (s.bornAt > lastBornAt) lastBornAt = s.bornAt;
  if (lastBornAt > duration) duration = lastBornAt;

  return {
    doc: {
      ...doc,
      meta: { ...doc.meta, duration },
      objects,
      scenes,
      audioTracks,
      captionTracks,
      markers,
      effects,
      camera: { keys: cameraKeys },
    },
    shifted,
    shiftedWindows,
    skippedOwners,
    shiftedScenes,
    collisions,
  };
}

export function nearestMarker(doc: SceneDoc, t: number): number | undefined {
  let best: number | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (const m of doc.markers) {
    const d = Math.abs(m.t - t);
    if (d < bestD) {
      bestD = d;
      best = m.t;
    }
  }
  return best;
}
