/**
 * 变更内核：把一条领域化命令作用到文档上，产出【新文档 + patches】。
 *
 * 两条硬约束：
 *  1. 不可变 + 结构共享：只重建被改动路径上的对象，未改动的子树与输入指针相等。
 *     绝不对整份 doc 做 structuredClone（用户 P4 清单第 4 条）。
 *  2. patches 是唯一的事实记录：受影响路径的 before/after 裸值。
 *     它是 precondition 推导、Operation Journal、revert_compound 三处的共同输入。
 */
import type { AnimTrack, CameraKey, Effect, ObjectId, OwnerInfo, Scene, SceneDoc, SceneObject } from '../doc/types';
import { REGISTRY } from '../registry/fields';
import { VIEWPORT_MIN_PX, registeredFields, unknownFields } from '../registry/schema';
import type { FieldGroup } from '../registry/types';
import type { FieldAtom, FieldRecord } from '../doc/types';
import { findScene, objectTimeWindow, reconcileDuration, sceneEnd, sceneOrder } from '../doc/types';
import { shiftTimeline } from '../doc/shift';
import type { Scope } from '../doc/permissions';
import { fieldValues, setFieldValue, unwrapField, wrapFields } from '../doc/fields';
/**
 * ★ 命令层 import 求值层，是为了"对象在哪"这个问题只有一个答案。
 *   `camera_preset` 的注视点以前直接读 `obj.tf.x/y` —— 在 `moveAlong` 之后
 *   那个读法是错的（位置可能被路径接管），所以它改成问 `worldOriginOf`。
 *   `evaluate` 是纯函数、不认识命令层，这个方向不会成环。
 */
import { worldOriginOf } from '../evaluate';
import type { Command, CommandEffects, CreateOwner } from './commands';

interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

export interface OperationPatch {
  /** 点分路径。对象相关的一律用对象相对形式（'plot#1.style.width'）。 */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ApplyContext {
  /**
   * 新建对象的 bornAt。
   * 多镜头（P12）落地前恒为 0 —— 那时它会是"当前生效镜头的起点"。
   */
  readonly bornAt?: number;
  /**
   * 字段级约束的真源。默认用内置 REGISTRY。
   *
   * ★ 为什么这里需要它：commands.ts 一直写着"未登记的名字报 errored(field_not_in_shape)"，
   *   但在此之前【没有任何代码兑现】—— `create_object` 会照单全收任何键名并落盘，
   *   未登记的 shape 也能建出来。于是"FieldRegistry 是字段级约束的唯一真源"
   *   在写入路径上是一句空话（缺口由 test/field-in-shape.test.ts 钉出来）。
   *   参数化 registry 是为了让测试能用手写的分组，不必污染全局登记表。
   */
  readonly registry?: { readonly groups: readonly FieldGroup[] };
  /**
   * 这次写入的**身份/权限范围**（P12：谁在写）。
   *
   * 导演视角 = 不传 = 全权。
   * 场景 Agent = `{ kind: 'scene', sceneId, start, end }`。
   *
   * ★ 它现在有两个作用，都必须是引擎推导而不是模型声明（信任边界）：
   *   1. `owner.sceneId === null` 落成"我当前这一镜"（见 resolveOwner）；
   *   2. `retime` 决定顺延范围、以及越界时把命令拦下来。
   *   注意 `retime` 的 activeSceneId 是另一条独立入口（命令字段）：
   *   它保留是为了让 CLI/测试能显式以某一镜的身份发起顺延，
   *   而这里的作用域是"本次 apply 的默认身份"。
   */
  readonly scope?: Scope;
}

export interface AppliedCommand {
  readonly doc: SceneDoc;
  readonly patches: readonly OperationPatch[];
  readonly affectedPaths: readonly string[];
  readonly effects: CommandEffects;
  readonly assignedId?: string;
}

export interface ApplyFailure {
  /**
   * 失败原因。
   *
   * ★ 这一组刻意与 `CommandErrorCode`（results.ts）对齐，且是封闭联合 ——
   *   新加一种失败原因时类型系统会逼着你去 batch.ts 里映射，
   *   不会出现"引擎报了某个 code，但回执层不认识它、悄悄归成 invalid_argument"
   *   这种情况（我加 field_not_in_shape 时就是这么被抓住的）。
   */
  readonly code:
    | 'unknown_target'
    | 'unsupported_op'
    | 'unsupported_shape'
    | 'field_not_in_shape'
    | 'invalid_argument'
    /** 改动会越过镜头边界。与 invalid_argument 分开见 results.ts 的注释。 */
    | 'scene_bounds_exceeded';
  readonly message: string;
  readonly path?: string;
}

export type ApplyResult =
  | ({ readonly kind: 'applied' } & AppliedCommand)
  | { readonly kind: 'failed'; readonly error: ApplyFailure };

function fail(code: ApplyFailure['code'], message: string, path?: string): ApplyResult {
  return path === undefined
    ? { kind: 'failed', error: { code, message } }
    : { kind: 'failed', error: { code, message, path } };
}

/**
 * 分配 id：取同前缀现有最大序号 + 1。
 * 必须由文档现状推出，不能用随机数或时间 —— 否则同一份 doc + 同一批命令
 * 会产出不同结果（不变量 1）。
 */
export function allocateId(existingIds: readonly string[], prefix: string): string {
  const re = new RegExp('^' + prefix + '#(\\d+)$');
  let max = 0;
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m === null) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + '#' + (max + 1);
}

/** 改某个对象的若干个 style/params 字段，返回新文档与 patches。 */
function patchFields(
  doc: SceneDoc,
  id: ObjectId,
  zone: 'style' | 'params',
  edits: readonly (readonly [string, FieldAtom])[],
  patches: OperationPatch[],
): SceneDoc {
  const obj = doc.objects[id];
  if (obj === undefined) return doc;
  let record: FieldRecord = zone === 'style' ? obj.style : obj.params;
  for (const [key, value] of edits) {
    patches.push({
      path: id + '.' + zone + '.' + key,
      before: unwrapField(record[key]),
      after: value,
    });
    record = setFieldValue(record, key, value);
  }
  const nextObj: SceneObject = zone === 'style' ? { ...obj, style: record } : { ...obj, params: record };
  return { ...doc, objects: { ...doc.objects, [id]: nextObj } };
}

function collectEdits(
  pairs: readonly (readonly [string, unknown])[],
): readonly (readonly [string, FieldAtom])[] {
  const out: (readonly [string, FieldAtom])[] = [];
  for (const [key, value] of pairs) {
    if (value === null || value === undefined) continue; // null = 这一项不改
    out.push([key, value as FieldAtom]);
  }
  return out;
}

/**
 * 新建对象的 bornAt。
 *
 * ★ 优先级：镜头表的 bornAt > 调用方给的 bornAt > 0。
 *   镜头表排在最前面，是因为 bornAt 是【引擎推导】的（规范 §4 信任边界）：
 *   有了 scenes 表，对象就该生在当前生效镜头的起点上，没有第二个答案。
 *   ctx.bornAt 保留给"还没有镜头表的单镜头调用方"（CLI / 面板 / 测试夹具）。
 */
function bornAtFor(doc: SceneDoc, owner: CreateOwner, ctx: ApplyContext): number {
  if (owner.kind !== 'scene') return 0;
  const scene = owner.sceneId === null ? undefined : findScene(doc, owner.sceneId);
  if (scene !== undefined) return scene.bornAt;
  return ctx.bornAt ?? 0;
}

/**
 * 把命令里的 `sceneId: null` 落成"我当前这一镜"。
 *
 * ★ 这是多 Agent 的关键一步：场景 Agent 不该、也不必知道自己的镜头 id ——
 *   那是编排层给它的身份（`ApplyContext.scope`）。让模型自己填 id 会引入
 *   两类错误：填错（写进别人的镜）与不填（游离对象）。
 *
 * ★ 导演视角（没有 scope）下 `null` 原样保留：那是"未指定归属"，
 *   与单镜头文档里的既有行为一致 —— 空表时它对不上任何镜头，
 *   而空表本来就不做镜头过滤，所以没有可观测后果。
 */
function resolveOwner(owner: CreateOwner, ctx: ApplyContext): CreateOwner {
  if (owner.kind !== 'scene' || owner.sceneId !== null) return owner;
  const sceneId = ctx.scope !== undefined && ctx.scope.kind === 'scene' ? ctx.scope.sceneId : null;
  return { kind: 'scene', sceneId };
}

/**
 * 把命令里的归属落成文档里的 OwnerInfo。
 *
 * ★ 两件事同时发生，都必须是引擎推导（信任边界）：
 *   1. `sceneId: null` → "我当前这一镜"（编排层给的身份，见 resolveOwner）；
 *   2. `bornAt` → 由镜头表推导（不是模型声明的时间原点）。
 */
function ownerInfoFor(doc: SceneDoc, owner: CreateOwner, ctx: ApplyContext): OwnerInfo {
  if (owner.kind !== 'scene') return owner;
  const resolved = resolveOwner(owner, ctx);
  const sceneId = resolved.kind === 'scene' ? resolved.sceneId : null;
  return { kind: 'scene', sceneId: sceneId ?? '', bornAt: bornAtFor(doc, resolved, ctx) };
}

/** 把命令里的具名字段包成 FieldRecord（值 = { v }）。 */
function wrapNamed(pairs: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    if (value === undefined || value === null) continue;
    out[key] = { v: value as FieldAtom };
  }
  return out;
}

export function applyCommand(doc: SceneDoc, cmd: Command, ctx: ApplyContext = {}): ApplyResult {
  const patches: OperationPatch[] = [];
  const writes: string[] = [];
  const reads: string[] = [];

  const track = (): void => {
    for (const p of patches) {
      if (!writes.includes(p.path)) writes.push(p.path);
      if (!reads.includes(p.path)) reads.push(p.path);
    }
  };

  const done = (
    nextDoc: SceneDoc,
    assignedId?: string,
    rootPath?: string,
  ): ApplyResult => {
    track();
    const creates =
      assignedId === undefined || rootPath === undefined
        ? []
        : [{ localId: '', assignedId, rootPath }];
    return {
      kind: 'applied',
      doc: nextDoc,
      patches,
      affectedPaths: [...writes],
      effects: { writes: [...writes], reads: [...reads], creates },
      ...(assignedId === undefined ? {} : { assignedId }),
    };
  };

  /**
   * 三个 create_* 共用的收尾：把新对象（与可选的内联效果）写进文档，产出 patches。
   *
   * ★ 放在 applyCommand【内部】是因为它要用 done / patches / doc ——
   *   抽出来的理由不是"少写几行"，而是保证三条 create 路径的**记账方式完全一致**：
   *   id 分配、图层挂载、patches 形状（precondition 与撤销都读它）、assignedId 的传递。
   *   各写一遍的话，迟早有一条忘了挂图层或者 patch 少一条。
   */
  const emitCreated = (input: {
    readonly shape: string;
    readonly prefix: string;
    readonly owner: OwnerInfo;
    readonly params: Record<string, unknown>;
    readonly style: Readonly<Record<string, unknown>> | null | undefined;
    readonly layer: string | null | undefined;
    readonly motion: Readonly<Record<string, AnimTrack>> | null | undefined;
    readonly effect:
      | { readonly type: string; readonly params?: Readonly<Record<string, unknown>>; readonly ease?: string | null }
      | null
      | undefined;
  }): ApplyResult => {
    const id = allocateId(Object.keys(doc.objects), input.prefix);
    const layerId = pickLayer(doc, input.layer);

    const effectIds: string[] = [];
    let createdEffect: { id: string; eff: Effect } | null = null;
    if (input.effect !== null && input.effect !== undefined) {
      const effId = allocateId(Object.keys(doc.effects), 'eff');
      createdEffect = {
        id: effId,
        eff: {
          type: input.effect.type,
          target: id,
          params: input.effect.params === undefined ? {} : wrapFields(input.effect.params),
          ...(input.effect.ease === null || input.effect.ease === undefined ? {} : { ease: input.effect.ease }),
        },
      };
      effectIds.push(effId);
    }

    const obj: SceneObject = {
      shape: input.shape,
      owner: input.owner,
      params: input.params as FieldRecord,
      style: input.style === null || input.style === undefined ? {} : wrapFields(input.style),
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: input.motion === null || input.motion === undefined ? {} : input.motion,
      effects: effectIds,
    };

    patches.push({ path: 'objects.' + id, before: undefined, after: obj });
    if (createdEffect !== null) {
      patches.push({ path: 'effects.' + createdEffect.id, before: undefined, after: createdEffect.eff });
    }
    return done(
      {
        ...doc,
        objects: { ...doc.objects, [id]: obj },
        effects:
          createdEffect === null ? doc.effects : { ...doc.effects, [createdEffect.id]: createdEffect.eff },
        layers: addToLayer(doc, layerId, id),
      },
      id,
      'objects.' + id,
    );
  };

  switch (cmd.op) {
    case 'set_meta': {
      let meta = doc.meta;
      if (cmd.fps !== null && cmd.fps !== undefined) {
        const fps = Number(cmd.fps);
        if (!Number.isFinite(fps) || fps <= 0) {
          return fail('invalid_argument', 'fps 必须是正数，收到 ' + String(cmd.fps), 'meta.fps');
        }
        patches.push({ path: 'meta.fps', before: meta.fps, after: fps });
        meta = { ...meta, fps };
      }
      if (cmd.duration !== null && cmd.duration !== undefined) {
        const duration = Number(cmd.duration);
        if (!Number.isFinite(duration) || duration <= 0) {
          return fail('invalid_argument', 'duration 必须是正数，收到 ' + String(cmd.duration), 'meta.duration');
        }
        patches.push({ path: 'meta.duration', before: meta.duration, after: duration });
        meta = { ...meta, duration };
      }
      if (cmd.viewport !== null && cmd.viewport !== undefined) {
        const w = Number(cmd.viewport[0]);
        const h = Number(cmd.viewport[1]);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < VIEWPORT_MIN_PX || h < VIEWPORT_MIN_PX) {
          return fail(
            'invalid_argument',
            'viewport 必须是两个不小于 ' + VIEWPORT_MIN_PX + ' 的像素数，收到 [' + w + ', ' + h + ']',
            'meta.viewport',
          );
        }
        patches.push({ path: 'meta.viewport', before: meta.viewport, after: [w, h] });
        meta = { ...meta, viewport: [w, h] as const };
      }
      return done({ ...doc, meta });
    }

    case 'set_style': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const edits = collectEdits([
        ['width', cmd.width],
        ['glow', cmd.glow],
        ['stroke', cmd.stroke],
        // 第十七轮补的四个：面板早就画着控件，以前没有命令能改（拖了回 null）
        ['fill', cmd.fill],
        ['fillOpacity', cmd.fillOpacity],
        ['headSize', cmd.headSize],
        ['size', cmd.size],
        // 文字排版（P3 第一块）：对齐（枚举，到点换值）与换行宽度（数值，可插值）
        ['align', cmd.align],
        ['maxWidth', cmd.maxWidth],
        ['bold', cmd.bold],
      ]);
      return done(patchFields(doc, cmd.target, 'style', edits, patches));
    }

    /**
     * 形状几何参数（三条）。
     *
     * ★ 与 set_highlight 同一条纪律：**检查形状**。三种形状的参数集不同，
     *   对一条曲线发 set_rect 必须当场被拒 —— 否则 width 会被写进一个
     *   没有 width 的对象里，形状对、语义错，而且不报错。
     */
    case 'set_rect': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      if (obj.shape !== 'rect') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + obj.shape + '，不是 rect —— 三种形状的参数集不同，别用错命令。',
          cmd.target,
        );
      }
      const edits = collectEdits([
        ['width', cmd.width],
        ['height', cmd.height],
        ['radius', cmd.radius],
      ]);
      return done(patchFields(doc, cmd.target, 'params', edits, patches));
    }

    case 'set_line': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      if (obj.shape !== 'line') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + obj.shape + '，不是 line —— 三种形状的参数集不同，别用错命令。',
          cmd.target,
        );
      }
      const edits = collectEdits([
        ['from', cmd.from === null || cmd.from === undefined ? undefined : [cmd.from[0], cmd.from[1]]],
        ['to', cmd.to === null || cmd.to === undefined ? undefined : [cmd.to[0], cmd.to[1]]],
        ['head', cmd.head],
      ]);
      return done(patchFields(doc, cmd.target, 'params', edits, patches));
    }

    case 'set_text': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      if (obj.shape !== 'text') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + obj.shape + '，不是 text —— 改文字内容请用 set_text 指向一个文字对象。',
          cmd.target,
        );
      }
      const edits = collectEdits([['content', cmd.content]]);
      return done(patchFields(doc, cmd.target, 'params', edits, patches));
    }

    case 'set_expression': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      return done(
        patchFields(doc, cmd.target, 'params', [['expr', cmd.expr]], patches),
      );
    }

    case 'set_sampling': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const edits = collectEdits([
        ['samples', cmd.samples],
        ['domain', cmd.domain === null || cmd.domain === undefined ? undefined : [cmd.domain[0], cmd.domain[1]]],
      ]);
      return done(patchFields(doc, cmd.target, 'params', edits, patches));
    }

    case 'promote_object': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      // bornAt 是引擎推导的，模型/命令不声明（与 create 的 CreateOwner 同理）
      const to: OwnerInfo =
        cmd.to.kind === 'scene'
          ? {
              kind: 'scene',
              sceneId: cmd.to.sceneId,
              bornAt: obj.owner.kind === 'scene' ? obj.owner.bornAt : 0,
            }
          : cmd.to;
      patches.push({ path: cmd.target + '.owner', before: obj.owner, after: to });
      return done({ ...doc, objects: { ...doc.objects, [cmd.target]: { ...obj, owner: to } } });
    }

    case 'link_shared': {
      const obj = doc.objects[cmd.sharedId];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.sharedId, cmd.sharedId);
      if (obj.owner.kind !== 'shared') {
        return fail('invalid_argument', cmd.sharedId + ' 不是 shared 对象，无法追加使用窗口', cmd.sharedId);
      }
      const owner = obj.owner;
      patches.push({
        path: cmd.sharedId + '.owner.usageWindows',
        before: owner.usageWindows,
        after: [...owner.usageWindows, cmd.usageWindow],
      });
      return done({
        ...doc,
        objects: {
          ...doc.objects,
          [cmd.sharedId]: { ...obj, owner: { ...owner, usageWindows: [...owner.usageWindows, cmd.usageWindow] } },
        },
      });
    }

    case 'set_audio': {
      const idx = doc.audioTracks.findIndex((a) => a.id === cmd.target);
      const track = doc.audioTracks[idx];
      if (idx < 0 || track === undefined) {
        return fail('unknown_target', '音频轨不存在: ' + cmd.target, cmd.target);
      }
      const next = { ...track };
      if (cmd.startAt !== null && cmd.startAt !== undefined) {
        patches.push({ path: cmd.target + '.startAt', before: track.startAt, after: cmd.startAt });
        (next as { startAt: number }).startAt = cmd.startAt;
      }
      if (cmd.gain !== null && cmd.gain !== undefined) {
        patches.push({ path: cmd.target + '.gain', before: track.gain, after: cmd.gain });
        (next as { gain: number }).gain = cmd.gain;
      }
      const audioTracks = [...doc.audioTracks];
      audioTracks[idx] = next;
      return done({ ...doc, audioTracks });
    }

    case 'retime': {
      const marker = doc.markers.find((m) => m.id === cmd.fromMarker);
      if (marker === undefined) {
        return fail('unknown_target', '标记不存在: ' + cmd.fromMarker, cmd.fromMarker);
      }
      const scope: Scope | undefined =
        cmd.activeSceneId === null || cmd.activeSceneId === undefined
          ? undefined
          : { kind: 'scene', sceneId: cmd.activeSceneId, start: marker.t, end: doc.meta.duration };
      const r = shiftTimeline(doc, marker.t, cmd.delta, scope);

      /**
       * ★ 场景 Agent 把内容顶出本镜边界时【必须失败】。
       *
       *   它自己顺延不了镜头表（那会改到别人那一镜，越权），所以 delta 一大
       *   就会留下"对象属于本镜、内容却在本镜之外"的矛盾状态。
       *   这种状态画面上看不出来，只会在镜头过滤与写权限生效后才爆发，
       *   而且到那时已经查不到是哪一条 retime 造成的。
       *   宁可让这条命令当场失败，并说清差了多少 —— 模型改小 delta 就能过。
       */
      if (r.collisions.length > 0) {
        const c = r.collisions[0]!;
        return fail(
          'scene_bounds_exceeded',
          '顺延 ' + cmd.delta + 's 会把 ' + c.objectId + ' 推到 ' + c.at.toFixed(2) +
            's，超出镜头 ' + c.sceneId + ' 的结束时刻 ' + c.sceneEnd.toFixed(2) + 's。' +
            '场景 Agent 只能改本镜的时间轴，够不到后面那一镜的边界。' +
            '请把 delta 减到 ' + (c.sceneEnd - c.from).toFixed(2) + 's 以内，或请导演整体顺延。',
          c.objectId,
        );
      }

      if (r.shiftedScenes > 0) {
        patches.push({ path: 'scenes', before: doc.scenes, after: r.doc.scenes });
      }
      patches.push({ path: 'meta.duration', before: doc.meta.duration, after: r.doc.meta.duration });
      patches.push({
        path: 'timeline.owners',
        before: { skipped: [] as string[], windows: 0, scenes: 0 },
        after: { skipped: r.skippedOwners, windows: r.shiftedWindows, scenes: r.shiftedScenes },
      });
      patches.push({
        path: 'timeline.shift@' + marker.id,
        before: { delta: 0, shifted: 0 },
        after: { delta: cmd.delta, shifted: r.shifted },
      });
      return done(r.doc);
    }

    case 'link_object': {
      const layer = doc.layers.find((l) => l.id === cmd.layerId);
      if (layer === undefined) return fail('unknown_target', '图层不存在: ' + cmd.layerId, cmd.layerId);
      if (doc.objects[cmd.objectId] === undefined) {
        return fail('unknown_target', '对象不存在: ' + cmd.objectId, cmd.objectId);
      }
      if (layer.objects.includes(cmd.objectId)) return done(doc);
      patches.push({
        path: 'layers.' + cmd.layerId + '.objects',
        before: layer.objects,
        after: [...layer.objects, cmd.objectId],
      });
      return done({
        ...doc,
        layers: doc.layers.map((l) =>
          l.id === cmd.layerId ? { ...l, objects: [...l.objects, cmd.objectId] } : l,
        ),
      });
    }

    case 'unlink_object': {
      const layer = doc.layers.find((l) => l.id === cmd.layerId);
      if (layer === undefined) return fail('unknown_target', '图层不存在: ' + cmd.layerId, cmd.layerId);
      if (!layer.objects.includes(cmd.objectId)) return done(doc);
      patches.push({
        path: 'layers.' + cmd.layerId + '.objects',
        before: layer.objects,
        after: layer.objects.filter((o) => o !== cmd.objectId),
      });
      return done({
        ...doc,
        layers: doc.layers.map((l) =>
          l.id === cmd.layerId ? { ...l, objects: l.objects.filter((o) => o !== cmd.objectId) } : l,
        ),
      });
    }

    case 'set_transform': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const pairs: (readonly [string, unknown])[] = [
        ['x', cmd.x],
        ['y', cmd.y],
        ['rotate', cmd.rotate],
        ['sx', cmd.sx],
        ['sy', cmd.sy],
        ['opacity', cmd.opacity],
      ];
      let tf = obj.tf;
      for (const [key, value] of pairs) {
        if (value === null || value === undefined) continue;
        const k = key as keyof SceneObject['tf'];
        patches.push({ path: cmd.target + '.tf.' + key, before: tf[k], after: value });
        tf = { ...tf, [k]: value as number };
      }
      const next: SceneDoc = {
        ...doc,
        objects: { ...doc.objects, [cmd.target]: { ...obj, tf } },
      };
      return done(next);
    }

    case 'set_parent': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const parent = cmd.parent === null || cmd.parent === undefined ? null : String(cmd.parent);
      if (parent !== null) {
        if (parent === cmd.target) {
          return fail('invalid_argument', '对象不能以自己为父级: ' + cmd.target, cmd.target + '.parent');
        }
        if (doc.objects[parent] === undefined) {
          return fail('unknown_target', '父对象不存在: ' + parent, cmd.target + '.parent');
        }
        /**
         * ★ 成环必须在【写入时】就拒掉，而不是留给校验器。
         *   校验器报出来是"让人看见"，但一条必然产生坏文档的命令不该被提交 ——
         *   否则撤销历史里会留下一份"父级链绕回自己"的中间态。
         */
        let cursor: string | undefined = parent;
        for (let depth = 0; depth < 512 && cursor !== undefined; depth++) {
          if (cursor === cmd.target) {
            return fail(
              'invalid_argument',
              '这会让父级链成环：' + cmd.target + ' → ' + parent + ' → … → ' + cmd.target,
              cmd.target + '.parent',
            );
          }
          cursor = doc.objects[cursor]?.parent;
        }
      }
      patches.push({ path: cmd.target + '.parent', before: obj.parent, after: parent ?? undefined });
      const next: SceneObject = { ...obj };
      if (parent === null) delete (next as { parent?: string }).parent;
      else (next as { parent?: string }).parent = parent;
      return done({ ...doc, objects: { ...doc.objects, [cmd.target]: next } });
    }

    case 'set_effect': {
      const eff = doc.effects[cmd.target];
      if (eff === undefined) return fail('unknown_target', '效果不存在: ' + cmd.target, cmd.target);
      const edits = collectEdits([
        ['start', cmd.start],
        ['duration', cmd.duration],
        ['mode', cmd.mode],
        ['tip', cmd.tip],
      ]);
      let params: FieldRecord = eff.params;
      for (const [key, value] of edits) {
        patches.push({
          path: cmd.target + '.params.' + key,
          before: unwrapField(params[key]),
          after: value,
        });
        params = setFieldValue(params, key, value);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) {
        patches.push({ path: cmd.target + '.ease', before: eff.ease, after: cmd.ease });
      }
      const nextEff: Effect = {
        ...eff,
        params,
        ...(cmd.ease === null || cmd.ease === undefined ? {} : { ease: cmd.ease }),
      };
      return done({ ...doc, effects: { ...doc.effects, [cmd.target]: nextEff } });
    }

    case 'set_highlight': {
      const eff = doc.effects[cmd.target];
      if (eff === undefined) return fail('unknown_target', '效果不存在: ' + cmd.target, cmd.target);
      if (eff.type !== 'highlight') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + eff.type + ' 效果，不是 highlight —— 参数集不同，别用错命令。',
          cmd.target,
        );
      }
      const edits = collectEdits([
        ['start', cmd.start],
        ['duration', cmd.duration],
        ['color', cmd.color],
        ['intensity', cmd.intensity],
      ]);
      let params: FieldRecord = eff.params;
      for (const [key, value] of edits) {
        patches.push({
          path: cmd.target + '.params.' + key,
          before: unwrapField(params[key]),
          after: value,
        });
        params = setFieldValue(params, key, value);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) {
        patches.push({ path: cmd.target + '.ease', before: eff.ease, after: cmd.ease });
      }
      const nextEff: Effect = {
        ...eff,
        params,
        ...(cmd.ease === null || cmd.ease === undefined ? {} : { ease: cmd.ease }),
      };
      return done({ ...doc, effects: { ...doc.effects, [cmd.target]: nextEff } });
    }

    case 'set_move_along': {
      const eff = doc.effects[cmd.target];
      if (eff === undefined) return fail('unknown_target', '效果不存在: ' + cmd.target, cmd.target);
      if (eff.type !== 'moveAlong') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + eff.type + ' 效果，不是 moveAlong —— 参数集不同，别用错命令。',
          cmd.target,
        );
      }
      const edits = collectEdits([
        ['source', cmd.source],
        ['start', cmd.start],
        ['duration', cmd.duration],
      ]);
      let params: FieldRecord = eff.params;
      for (const [key, value] of edits) {
        patches.push({
          path: cmd.target + '.params.' + key,
          before: unwrapField(params[key]),
          after: value,
        });
        params = setFieldValue(params, key, value);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) {
        patches.push({ path: cmd.target + '.ease', before: eff.ease, after: cmd.ease });
      }
      const nextEff: Effect = {
        ...eff,
        params,
        ...(cmd.ease === null || cmd.ease === undefined ? {} : { ease: cmd.ease }),
      };
      return done({ ...doc, effects: { ...doc.effects, [cmd.target]: nextEff } });
    }

    /**
     * 改显隐（appear / disappear）。
     *
     * ★ 与 set_effect 的区别是它【检查类型】：两种显隐效果共用这一条 op，
     *   因为它们的字段集完全一样（只有一个 `at`）。写错目标（对一条 highlight
     *   发 set_visibility）必须当场拒 —— 否则 `at` 会被写进一个没有 at 的效果里，
     *   形状对、语义错，而且不报错。
     */
    case 'set_visibility': {
      const eff = doc.effects[cmd.target];
      if (eff === undefined) return fail('unknown_target', '效果不存在: ' + cmd.target, cmd.target);
      if (eff.type !== 'appear' && eff.type !== 'disappear') {
        return fail(
          'invalid_argument',
          cmd.target + ' 是 ' + eff.type + ' 效果，不是 appear / disappear —— 显隐命令不接受它。',
          cmd.target,
        );
      }
      const edits = collectEdits([['at', cmd.at]]);
      let params: FieldRecord = eff.params;
      for (const [key, value] of edits) {
        patches.push({
          path: cmd.target + '.params.' + key,
          before: unwrapField(params[key]),
          after: value,
        });
        params = setFieldValue(params, key, value);
      }
      return done({ ...doc, effects: { ...doc.effects, [cmd.target]: { ...eff, params } } });
    }

    case 'set_motion': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const path = cmd.target + '.anim.' + cmd.field;
      const before = obj.anim[cmd.field];
      patches.push({ path, before, after: cmd.node });
      const anim: Record<string, AnimTrack> = {};
      for (const key of Object.keys(obj.anim)) {
        if (key !== cmd.field) anim[key] = obj.anim[key] as AnimTrack;
      }
      if (cmd.node !== null) anim[cmd.field] = cmd.node;
      return done({ ...doc, objects: { ...doc.objects, [cmd.target]: { ...obj, anim } } });
    }

    case 'set_camera': {
      patches.push({ path: 'camera.keys', before: doc.camera.keys, after: cmd.keys });
      return done({ ...doc, camera: { keys: cmd.keys } });
    }

    /**
     * 相机预设：**替换**整条相机轨（语义见 CameraPresetCommand 的注释）。
     *
     * 起点取主体时间窗的左端（点主体则取 0），缓动用 easeInOutCubic。
     */
    case 'camera_preset': {
      if (cmd.preset === 'reset') {
        const keys: CameraKey[] = [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }];
        patches.push({ path: 'camera.keys', before: doc.camera.keys, after: keys });
        return done({ ...doc, camera: { keys } });
      }

      const subject = cmd.subject;
      // 主体是一个对象时：注视点取它【这一帧真实在哪】，而不是 obj.tf。
      // ★ 差别在 moveAlong 上：位置可能由路径接管，读 tf 会把镜头对到空处。
      //   时间取它时间窗的左端（也就是它出现的那一刻）。
      let look: Vec2Like = { x: 0, y: 0 };
      let startAt = 0;
      if (Array.isArray(subject)) {
        look = { x: Number(subject[0]), y: Number(subject[1]) };
      } else if (typeof subject === 'string') {
        const obj = doc.objects[subject];
        if (obj === undefined) return fail('unknown_target', '主体不存在: ' + subject, subject);
        startAt = objectTimeWindow(doc, obj)[0];
        look = worldOriginOf(doc, subject, startAt) ?? { x: obj.tf.x, y: obj.tf.y };
      }
      const intensity = cmd.intensity ?? 0.5;
      const duration = cmd.duration ?? 3;
      if (!Number.isFinite(duration) || duration <= 0) {
        return fail('invalid_argument', 'camera_preset 的 duration 必须是正数，收到 ' + String(cmd.duration));
      }
      const zoomed = 1 + intensity * 1.5;
      const key = (t: number, scale: number, ease?: string): CameraKey => ({
        t,
        tx: 0,
        ty: 0,
        scale,
        rotate: 0,
        pivot: [look.x, look.y],
        ...(ease === undefined ? {} : { ease }),
      });
      const keys: CameraKey[] =
        cmd.preset === 'pushIn'
          ? [key(startAt, 1, 'easeInOutCubic'), key(startAt + duration, zoomed)]
          : [key(startAt, zoomed, 'easeInOutCubic'), key(startAt + duration, 1)];

      patches.push({ path: 'camera.keys', before: doc.camera.keys, after: keys });
      return done({ ...doc, camera: { keys } });
    }

    case 'create_plot': {
      const id = allocateId(Object.keys(doc.objects), 'plot');
      const owner = ownerInfoFor(doc, cmd.owner, ctx);
      const params: Record<string, unknown> = {
        expr: { v: cmd.expr },
        domain: { v: [cmd.domain[0], cmd.domain[1]] },
      };
      if (cmd.samples !== null && cmd.samples !== undefined) params['samples'] = { v: cmd.samples };

      const layerId = pickLayer(doc, cmd.layer);

      const effectIds: string[] = [];
      let createdEffect: { id: string; eff: Effect } | null = null;
      if (cmd.effect !== null && cmd.effect !== undefined) {
        const effId = allocateId(Object.keys(doc.effects), 'eff');
        createdEffect = {
          id: effId,
          eff: {
            type: cmd.effect.type,
            target: id,
            params: cmd.effect.params === undefined ? {} : wrapFields(cmd.effect.params),
            ...(cmd.effect.ease === null || cmd.effect.ease === undefined ? {} : { ease: cmd.effect.ease }),
          },
        };
        effectIds.push(effId);
      }

      const obj: SceneObject = {
        shape: 'plot2d',
        owner,
        params: params as FieldRecord,
        style: cmd.style === null || cmd.style === undefined ? {} : wrapFields(cmd.style),
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: cmd.motion === null || cmd.motion === undefined ? {} : cmd.motion,
        effects: effectIds,
      };

      patches.push({ path: 'objects.' + id, before: undefined, after: obj });
      if (createdEffect !== null) {
        patches.push({
          path: 'effects.' + createdEffect.id,
          before: undefined,
          after: createdEffect.eff,
        });
      }
      return done(
        {
          ...doc,
          objects: { ...doc.objects, [id]: obj },
          effects:
            createdEffect === null
              ? doc.effects
              : { ...doc.effects, [createdEffect.id]: createdEffect.eff },
          layers: addToLayer(doc, layerId, id),
        },
        id,
        'objects.' + id,
      );
    }

    /* ── P1 形状系统：结构图的两个基元 ─────────────────────────
     * 它们与 create_object 走同一条记账（emitCreated），但字段在类型层面封闭 ——
     * 写错字段名是编译错误，而不是等运行期被 registry 拒收。
     */
    case 'create_rect':
      return emitCreated({
        shape: 'rect',
        prefix: 'rect',
        owner: ownerInfoFor(doc, cmd.owner, ctx),
        params: wrapNamed([
          ['width', cmd.width],
          ['height', cmd.height],
          ['radius', cmd.radius],
        ]),
        style: cmd.style,
        layer: cmd.layer,
        motion: cmd.motion,
        effect: cmd.effect,
      });

    case 'create_line':
      return emitCreated({
        shape: 'line',
        prefix: 'line',
        owner: ownerInfoFor(doc, cmd.owner, ctx),
        params: wrapNamed([
          ['from', cmd.from === null || cmd.from === undefined ? undefined : [cmd.from[0], cmd.from[1]]],
          ['to', cmd.to === null || cmd.to === undefined ? undefined : [cmd.to[0], cmd.to[1]]],
          ['head', cmd.head],
        ]),
        style: cmd.style,
        layer: cmd.layer,
        motion: cmd.motion,
        effect: cmd.effect,
      });

    case 'create_object': {
      const registry = ctx.registry ?? REGISTRY;
      // ① shape 本身必须被认识（params 分组存在即认为引擎认识这个 shape）
      const knownParams = registeredFields(registry, 'shape', cmd.shape, 'params');
      if (knownParams === undefined) {
        return fail('unsupported_shape', '引擎不认识这个 shape: ' + cmd.shape, 'objects');
      }
      const knownStyle = registeredFields(registry, 'shape', cmd.shape, 'style') ?? [];

      // ② 字段名必须在 registry 里登记过 —— 这是"FieldRegistry 唯一真源"的落地点
      const badParams = unknownFields(registry, 'shape', cmd.shape, 'params', Object.keys(cmd.params));
      if (badParams.length > 0) {
        return fail(
          'field_not_in_shape',
          cmd.shape + ' 的 params 里没有登记这些字段: ' + badParams.join(', ') +
            '（已登记：' + knownParams.join(', ') + '）',
          'objects',
        );
      }
      const styleKeys = cmd.style === null || cmd.style === undefined ? [] : Object.keys(cmd.style);
      const badStyle = unknownFields(registry, 'shape', cmd.shape, 'style', styleKeys);
      if (badStyle.length > 0) {
        return fail(
          'field_not_in_shape',
          cmd.shape + ' 的 style 里没有登记这些字段: ' + badStyle.join(', ') +
            (knownStyle.length === 0
              ? '（这个 shape 没有登记任何 style 字段）'
              : '（已登记：' + knownStyle.join(', ') + '）'),
          'objects',
        );
      }

      return emitCreated({
        shape: cmd.shape,
        prefix: prefixOf(cmd.shape),
        owner: ownerInfoFor(doc, cmd.owner, ctx),
        params: wrapNamed(Object.entries(cmd.params)),
        style: cmd.style,
        layer: cmd.layer,
        motion: cmd.motion,
        effect: cmd.effect,
      });
    }

    case 'add_effect': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const effId = allocateId(Object.keys(doc.effects), 'eff');
      const eff: Effect = {
        type: cmd.effect.type,
        target: cmd.target,
        params: cmd.effect.params === undefined ? {} : wrapFields(cmd.effect.params),
        ...(cmd.effect.ease === null || cmd.effect.ease === undefined ? {} : { ease: cmd.effect.ease }),
      };
      patches.push({ path: 'effects.' + effId, before: undefined, after: eff });
      patches.push({ path: cmd.target + '.effects', before: obj.effects, after: [...obj.effects, effId] });
      return done(
        {
          ...doc,
          effects: { ...doc.effects, [effId]: eff },
          objects: { ...doc.objects, [cmd.target]: { ...obj, effects: [...obj.effects, effId] } },
        },
        effId,
        'effects.' + effId,
      );
    }

    case 'delete_object': {
      const obj = doc.objects[cmd.target];
      if (obj === undefined) return fail('unknown_target', '对象不存在: ' + cmd.target, cmd.target);
      const objects: Record<string, SceneObject> = {};
      for (const key of Object.keys(doc.objects)) {
        if (key !== cmd.target) objects[key] = doc.objects[key] as SceneObject;
      }
      patches.push({ path: 'objects.' + cmd.target, before: obj, after: undefined });
      return done({
        ...doc,
        objects,
        layers: doc.layers.map((l) =>
          l.objects.includes(cmd.target)
            ? { ...l, objects: l.objects.filter((o) => o !== cmd.target) }
            : l,
        ),
      });
    }

    case 'delete_effect': {
      const eff = doc.effects[cmd.target];
      if (eff === undefined) return fail('unknown_target', '效果不存在: ' + cmd.target, cmd.target);
      const effects: Record<string, Effect> = {};
      for (const key of Object.keys(doc.effects)) {
        if (key !== cmd.target) effects[key] = doc.effects[key] as Effect;
      }
      patches.push({ path: 'effects.' + cmd.target, before: eff, after: undefined });
      const objects: Record<string, SceneObject> = {};
      for (const key of Object.keys(doc.objects)) {
        const o = doc.objects[key];
        if (o === undefined) continue;
        objects[key] = o.effects.includes(cmd.target)
          ? { ...o, effects: o.effects.filter((e) => e !== cmd.target) }
          : o;
      }
      return done({ ...doc, effects, objects });
    }

    /* ── 镜头表（P12）────────────────────────────────────────
     * 三条都是【原子】的：一次 done() 落定，中间不产生半成品文档。
     * 这不是风格问题 —— applyCommands 的预检与 Journal.commit 是两次独立的
     * 应用，命令只要有一次 done 之外的副作用，两边就会看到不同的世界。
     */
    case 'add_scene': {
      const bornAt = cmd.bornAt === null || cmd.bornAt === undefined ? undefined : Number(cmd.bornAt);
      const after = cmd.at === null || cmd.at === undefined ? undefined : String(cmd.at);
      if (bornAt === undefined && after === undefined) {
        return fail(
          'invalid_argument',
          'add_scene 必须给出 bornAt（起点）或 at（接在哪个镜头后面），' +
            '否则引擎不知道该把这一镜放在哪一段。',
          'scenes',
        );
      }
      if (bornAt !== undefined && !Number.isFinite(bornAt)) {
        return fail('invalid_argument', 'add_scene 的 bornAt 必须是有限数，收到 ' + String(cmd.bornAt), 'scenes');
      }
      if (bornAt !== undefined && bornAt < 0) {
        return fail('invalid_argument', 'add_scene 的 bornAt 不能是负数，收到 ' + bornAt, 'scenes');
      }
      if (bornAt !== undefined && after !== undefined) {
        return fail('invalid_argument', 'add_scene 的 bornAt 与 at 只能给一个。', 'scenes');
      }

      let start = bornAt ?? 0;
      if (after !== undefined) {
        const anchor = findScene(doc, after);
        if (anchor === undefined) {
          return fail('unknown_target', 'at 指向的镜头不存在: ' + after, 'scenes');
        }
        start = sceneEnd(doc, after);
      }

      const requestedId = cmd.id === null || cmd.id === undefined ? undefined : String(cmd.id);
      if (requestedId !== undefined && findScene(doc, requestedId) !== undefined) {
        return fail('invalid_argument', '镜头 id 已存在: ' + requestedId, 'scenes');
      }
      const id = requestedId ?? allocateId(doc.scenes.map((s) => s.id), 's');
      const name = cmd.name === null || cmd.name === undefined ? '镜头 ' + id : String(cmd.name);

      const scenes: Scene[] = [...doc.scenes, { id, name, bornAt: start }];
      patches.push({ path: 'scenes', before: doc.scenes, after: scenes });
      // ★ 这里必须调 reconcileDuration：新镜头的起点可能落在原片长之外，
      //   不对齐就会得到"结束早于开始"的时间窗（见 sceneEnd 的注释）。
      const next = reconcileScenes({ ...doc, scenes }, patches);
      return done(next, id, 'scenes.' + id);
    }

    case 'set_scene': {
      const scene = findScene(doc, cmd.target);
      if (scene === undefined) {
        return fail('unknown_target', '镜头不存在: ' + cmd.target, 'scenes.' + cmd.target);
      }
      let next: Scene = scene;
      if (cmd.name !== null && cmd.name !== undefined) {
        const name = String(cmd.name);
        if (name === '') return fail('invalid_argument', '镜头名字不能是空串。', 'scenes.' + cmd.target + '.name');
        patches.push({ path: 'scenes.' + cmd.target + '.name', before: scene.name, after: name });
        next = { ...next, name };
      }
      if (cmd.bornAt !== null && cmd.bornAt !== undefined) {
        const bornAt = Number(cmd.bornAt);
        if (!Number.isFinite(bornAt) || bornAt < 0) {
          return fail('invalid_argument', 'set_scene 的 bornAt 必须是非负有限数，收到 ' + String(cmd.bornAt), 'scenes.' + cmd.target + '.bornAt');
        }
        patches.push({ path: 'scenes.' + cmd.target + '.bornAt', before: scene.bornAt, after: bornAt });
        next = { ...next, bornAt };
      }
      const scenes = doc.scenes.map((s) => (s.id === cmd.target ? next : s));
      return done(reconcileScenes({ ...doc, scenes }, patches));
    }

    case 'remove_scene': {
      const scene = findScene(doc, cmd.target);
      if (scene === undefined) {
        return fail('unknown_target', '镜头不存在: ' + cmd.target, 'scenes.' + cmd.target);
      }
      if (doc.scenes.length <= 1) {
        return fail(
          'invalid_argument',
          '这是最后一个镜头，删掉之后就没有镜头表了。如果要清空整片内容，请删对象而不是删镜头。',
          'scenes',
        );
      }

      // ★ 镜内对象不许变成孤儿：改归属到相邻镜头（前一个优先）。
      //   用 sceneOrder 定序而不是数组顺序 —— 表的顺序不是真源。
      const ordered = sceneOrder(doc);
      const idx = ordered.findIndex((s) => s.id === cmd.target);
      const survivor = ordered[idx - 1] ?? ordered[idx + 1];
      if (survivor === undefined) {
        // 上面已经挡掉了"只剩一镜"，这里只是把不变量写成断言式的失败
        return fail('invalid_argument', '找不到可以接管对象的相邻镜头。', 'scenes.' + cmd.target);
      }

      const objects: Record<string, SceneObject> = { ...doc.objects };
      for (const [objectId, obj] of Object.entries(doc.objects)) {
        if (obj.owner.kind !== 'scene' || obj.owner.sceneId !== cmd.target) continue;
        const owner: OwnerInfo = { kind: 'scene', sceneId: survivor.id, bornAt: survivor.bornAt };
        objects[objectId] = { ...obj, owner };
        patches.push({ path: objectId + '.owner', before: obj.owner, after: owner });
      }

      const scenes = doc.scenes.filter((s) => s.id !== cmd.target);
      // ★ 只留一条 scenes 替换 patch（before 里就含着被删的那个镜头）。
      //   刻意【不】额外造一条 'scenes.s2.removed'：那个路径在文档里不存在，
      //   resolvePath 解析不到它，于是 replay 取值与 precondition 检测会在这条
      //   patch 上静默失效 —— 补偿看起来生效、其实取回 undefined。
      //   逆操作直接从 before 里按 id 找镜头（见 journal/invert.ts）。
      patches.push({ path: 'scenes', before: doc.scenes, after: scenes });
      // 删镜头【不】缩短片长（reconcileDuration 的单向规则），但要对齐：
      // 删掉的可能正是那个把片长撑长的镜头，对齐不会缩，只是保证不变量成立。
      const next = reconcileScenes({ ...doc, scenes, objects }, patches);
      return done(next);
    }

    default: {
      const op = (cmd as { op: string }).op;
      return fail('unsupported_op', '未实现的命令: ' + op);
    }
  }
}

/**
 * 改完 scenes 之后统一收口：对齐 meta.duration。
 *
 * ★ 存在的意义是让"每条改 scenes 的命令都要记得调它"这件事只写一次，
 *   而且调漏了会立刻被看穿 —— 所有 scene 命令都从这里出去。
 *   不做这件事的症状是 sceneEnd() 算出"结束早于开始"的窗口，
 *   而那种窗口在画面上表现为"对象整段消失"，极难反推到镜头表。
 */
function reconcileScenes(doc: SceneDoc, patches: OperationPatch[]): SceneDoc {
  const next = reconcileDuration(doc);
  if (next === doc) return doc;
  patches.push({ path: 'meta.duration', before: doc.meta.duration, after: next.meta.duration });
  return next;
}

function pickLayer(doc: SceneDoc, requested: string | null | undefined): string | undefined {
  if (requested !== null && requested !== undefined) return requested;
  return doc.layers[0]?.id;
}

/**
 * shape 名 → id 前缀。
 *
 * 只用于生成人可读的 id（plot#1 / text#1）。契约是"id 里不允许出现 '.'"，
 * 所以这里必须把 shape 名里的非标识符字符剔掉 —— 否则一个叫 'my.shape'
 * 的 shape 会造出 'my.shape#1' 这种把点分路径解析搞坏的 id。
 */
function prefixOf(shape: string): string {
  const cleaned = shape.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned === '' ? 'obj' : cleaned;
}

function addToLayer(doc: SceneDoc, layerId: string | undefined, id: ObjectId): SceneDoc['layers'] {
  if (layerId === undefined) return doc.layers;
  return doc.layers.map((l) => (l.id === layerId ? { ...l, objects: [...l.objects, id] } : l));
}

/** 只读：取某路径的当前裸值。revert 的冲突检测用它。 */
export function readAt(doc: SceneDoc, objectId: string, zone: 'style' | 'params', key: string): FieldAtom | undefined {
  const obj = doc.objects[objectId];
  if (obj === undefined) return undefined;
  const record = zone === 'style' ? obj.style : obj.params;
  return unwrapField(record[key]);
}

export { fieldValues };
