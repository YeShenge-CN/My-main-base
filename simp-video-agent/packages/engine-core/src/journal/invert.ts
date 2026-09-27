/**
 * 逆操作推导：从一条 Operation 推出能把文档改回去的【领域化命令】。
 *
 * 为什么必须产出命令而不是"直接写回路径"：
 *   不变量 2 —— 不存在第二条写文档的路径。补偿也是一次写，所以也必须是一条命令，
 *   要经过同一套校验、锁与依赖推导。否则 revert 就成了后门。
 *
 * ★ 补偿值从哪来，是这个模块最要紧的一件事。
 *   直觉上"逆操作 = 恢复成 op.patches[].before"，但那是错的：
 *
 *     width: 3 →(AI:5) →(用户:7) →(AI:9)
 *
 *   朴素逆序恢复：撤 op3 恢复 5，再撤 op1 恢复 3 —— 结果是 3，把用户的 7 吃掉了。
 *   正确答案是 7：把这一轮的操作整体摘掉之后，历史应当重算成 3 →(用户:7)。
 *
 *   所以 compensation 的值由调用方通过 valueFor 注入。journal/store.ts 的
 *   revertCompound 注入的是"摘除本轮后重放得到的目标文档"里的值；
 *   缺少快照时退回 op 自带的 before（naive 模式，会少折叠一次用户改动）。
 */
import type { AnimTrack, FieldAtom, Scene } from '../doc/types';
import type {
  AddSceneCommand,
  Command,
  DeleteEffectCommand,
  DeleteObjectCommand,
  RemoveSceneCommand,
  SetCameraCommand,
  SetEffectCommand,
  SetExpressionCommand,
  SetHighlightCommand,
  SetMetaCommand,
  SetMotionCommand,
  SetMoveAlongCommand,
  SetParentCommand,
  SetSceneCommand,
  SetStyleCommand,
  SetLineCommand,
  SetRectCommand,
  SetTextCommand,
  SetTransformCommand,
  SetVisibilityCommand,
} from '../command/commands';
import type { OperationPatch } from '../command/apply';
import type { Operation } from './types';

export type InvertFailure = 'delete_not_invertible' | 'unsupported_op' | 'missing_assigned_id';

export type InvertOutcome =
  | { readonly kind: 'ok'; readonly command: Command }
  | { readonly kind: 'not_invertible'; readonly reason: InvertFailure };

/** 给定一条 patch，返回补偿时应当写入的值。 */
export type ValueLookup = (patch: OperationPatch) => unknown;

const naiveLookup: ValueLookup = (p) => p.before;

function notInvertible(reason: InvertFailure): InvertOutcome {
  return { kind: 'not_invertible', reason };
}

function patchAt(op: Operation, path: string): OperationPatch | undefined {
  return op.patches.find((p) => p.path === path);
}

/** 以 prefix 开头的 patch，返回 后缀 → 补偿值。 */
function valuesUnder(
  op: Operation,
  prefix: string,
  valueFor: ValueLookup,
): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  for (const p of op.patches) {
    if (p.path.startsWith(prefix)) out.push({ key: p.path.slice(prefix.length), value: valueFor(p) });
  }
  return out;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** vec2 字段（from / to）的补偿值：必须是两个有限数。 */
function asVec2(v: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const a = asNumber(v[0]);
  const b = asNumber(v[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

export function invertOperation(op: Operation, valueFor: ValueLookup = naiveLookup): InvertOutcome {
  const cmd = op.command;

  switch (cmd.op) {
    case 'set_style': {
      const entries = valuesUnder(op, cmd.target + '.style.', valueFor);
      let inv: SetStyleCommand = { op: 'set_style', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'width') inv = { ...inv, width: asNumber(value) ?? null };
        else if (key === 'glow') inv = { ...inv, glow: asNumber(value) ?? null };
        else if (key === 'stroke') inv = { ...inv, stroke: asString(value) ?? null };
        else if (key === 'fill') inv = { ...inv, fill: asString(value) ?? null };
        else if (key === 'fillOpacity') inv = { ...inv, fillOpacity: asNumber(value) ?? null };
        else if (key === 'headSize') inv = { ...inv, headSize: asNumber(value) ?? null };
        else if (key === 'size') inv = { ...inv, size: asNumber(value) ?? null };
        else if (key === 'align') inv = { ...inv, align: asString(value) ?? null };
        else if (key === 'maxWidth') inv = { ...inv, maxWidth: asNumber(value) ?? null };
        else if (key === 'bold') inv = { ...inv, bold: typeof value === 'boolean' ? value : null };
      }
      return { kind: 'ok', command: inv };
    }

    /**
     * 形状几何（三条）：与 set_style 同构，路径落在 params 上。
     *
     * ★ vec2 那一支（from / to）要单独取：patch 的补偿值是一个数组，
     *   asNumber 会把它判成 undefined —— 于是撤销【静默不动】。
     */
    case 'set_rect': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetRectCommand = { op: 'set_rect', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'width') inv = { ...inv, width: asNumber(value) ?? null };
        else if (key === 'height') inv = { ...inv, height: asNumber(value) ?? null };
        else if (key === 'radius') inv = { ...inv, radius: asNumber(value) ?? null };
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_line': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetLineCommand = { op: 'set_line', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'from') inv = { ...inv, from: asVec2(value) ?? null };
        else if (key === 'to') inv = { ...inv, to: asVec2(value) ?? null };
        else if (key === 'head') inv = { ...inv, head: asString(value) ?? null };
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_text': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetTextCommand = { op: 'set_text', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'content') inv = { ...inv, content: asString(value) ?? null };
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_expression': {
      const p = patchAt(op, cmd.target + '.params.expr');
      const expr = p === undefined ? undefined : asString(valueFor(p));
      if (expr === undefined) return notInvertible('unsupported_op');
      const inv: SetExpressionCommand = { op: 'set_expression', target: cmd.target, expr };
      return { kind: 'ok', command: inv };
    }

    case 'set_transform': {
      const entries = valuesUnder(op, cmd.target + '.tf.', valueFor);
      let inv: SetTransformCommand = { op: 'set_transform', target: cmd.target };
      for (const { key, value } of entries) {
        const v = asNumber(value) ?? null;
        if (key === 'x') inv = { ...inv, x: v };
        else if (key === 'y') inv = { ...inv, y: v };
        else if (key === 'rotate') inv = { ...inv, rotate: v };
        else if (key === 'sx') inv = { ...inv, sx: v };
        else if (key === 'sy') inv = { ...inv, sy: v };
        else if (key === 'opacity') inv = { ...inv, opacity: v };
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_effect': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetEffectCommand = { op: 'set_effect', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'start') inv = { ...inv, start: asNumber(value) ?? null };
        else if (key === 'duration') inv = { ...inv, duration: asNumber(value) ?? null };
        else if (key === 'mode') inv = { ...inv, mode: asString(value) ?? null };
        else if (key === 'tip') inv = { ...inv, tip: typeof value === 'boolean' ? value : null };
      }
      const easePatch = patchAt(op, cmd.target + '.ease');
      if (easePatch !== undefined) inv = { ...inv, ease: asString(valueFor(easePatch)) ?? null };
      return { kind: 'ok', command: inv };
    }

    case 'set_parent': {
      const p = patchAt(op, cmd.target + '.parent');
      const raw = p === undefined ? undefined : valueFor(p);
      const inv: SetParentCommand = { op: 'set_parent', target: cmd.target, parent: asString(raw) ?? null };
      return { kind: 'ok', command: inv };
    }

    case 'set_highlight': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetHighlightCommand = { op: 'set_highlight', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'start') inv = { ...inv, start: asNumber(value) ?? null };
        else if (key === 'duration') inv = { ...inv, duration: asNumber(value) ?? null };
        else if (key === 'color') inv = { ...inv, color: asString(value) ?? null };
        else if (key === 'intensity') inv = { ...inv, intensity: asNumber(value) ?? null };
      }
      const easePatch = patchAt(op, cmd.target + '.ease');
      if (easePatch !== undefined) inv = { ...inv, ease: asString(valueFor(easePatch)) ?? null };
      return { kind: 'ok', command: inv };
    }

    case 'set_move_along': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetMoveAlongCommand = { op: 'set_move_along', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'source') inv = { ...inv, source: asString(value) ?? null };
        else if (key === 'start') inv = { ...inv, start: asNumber(value) ?? null };
        else if (key === 'duration') inv = { ...inv, duration: asNumber(value) ?? null };
      }
      const easePatch = patchAt(op, cmd.target + '.ease');
      if (easePatch !== undefined) inv = { ...inv, ease: asString(valueFor(easePatch)) ?? null };
      return { kind: 'ok', command: inv };
    }

    case 'set_visibility': {
      const entries = valuesUnder(op, cmd.target + '.params.', valueFor);
      let inv: SetVisibilityCommand = { op: 'set_visibility', target: cmd.target };
      for (const { key, value } of entries) {
        if (key === 'at') inv = { ...inv, at: asNumber(value) ?? null };
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_motion': {
      const p = patchAt(op, cmd.target + '.anim.' + cmd.field);
      const raw = p === undefined ? undefined : valueFor(p);
      const node = raw === undefined || raw === null ? null : (raw as AnimTrack);
      const inv: SetMotionCommand = {
        op: 'set_motion',
        target: cmd.target,
        field: cmd.field,
        node,
      };
      return { kind: 'ok', command: inv };
    }

    case 'set_meta': {
      let inv: SetMetaCommand = { op: 'set_meta' };
      for (const { key, value } of valuesUnder(op, 'meta.', valueFor)) {
        if (key === 'fps' && typeof value === 'number') inv = { ...inv, fps: value };
        else if (key === 'duration' && typeof value === 'number') inv = { ...inv, duration: value };
        else if (key === 'viewport' && Array.isArray(value) && value.length === 2) {
          inv = { ...inv, viewport: [Number(value[0]), Number(value[1])] };
        }
      }
      return { kind: 'ok', command: inv };
    }

    case 'set_camera': {
      const p = patchAt(op, 'camera.keys');
      const raw = p === undefined ? undefined : valueFor(p);
      if (!Array.isArray(raw)) return notInvertible('unsupported_op');
      const inv: SetCameraCommand = { op: 'set_camera', keys: raw as SetCameraCommand['keys'] };
      return { kind: 'ok', command: inv };
    }

    case 'camera_preset': {
      // 预设是"生成一串关键帧"的糖。逆操作不该再去猜另一个预设，
      // 直接给回原来的关键帧 —— 那是唯一确定的还原方式。
      const p = patchAt(op, 'camera.keys');
      const raw = p === undefined ? undefined : valueFor(p);
      if (!Array.isArray(raw)) return notInvertible('unsupported_op');
      const inv: SetCameraCommand = { op: 'set_camera', keys: raw as SetCameraCommand['keys'] };
      return { kind: 'ok', command: inv };
    }

    case 'create_plot':
    case 'create_object':
    case 'create_rect':
    case 'create_line': {
      if (op.assignedId === undefined) return notInvertible('missing_assigned_id');
      const inv: DeleteObjectCommand = { op: 'delete_object', target: op.assignedId };
      return { kind: 'ok', command: inv };
    }

    case 'add_effect': {
      if (op.assignedId === undefined) return notInvertible('missing_assigned_id');
      const inv: DeleteEffectCommand = { op: 'delete_effect', target: op.assignedId };
      return { kind: 'ok', command: inv };
    }

    case 'delete_object':
    case 'delete_effect':
      // 恢复一个被删掉的实体需要"带指定 id 重建"的命令，目前没有。
      // 与其造一个绕过 id 分配器的后门，不如如实报告"不可逆"。
      return notInvertible('delete_not_invertible');

    /* ── 镜头表（P12）─────────────────────────────────────────
     * ★ 镜头刻意做成【可逆】的（与 delete_object 相反），代价是 add_scene 多了
     *   一个引擎专用的 id 字段。
     *   理由：对象上的 owner.sceneId 指向镜头表，删一镜而无法恢复会把所有
     *   镜内对象的归属永久悬空；而镜头只有 id/name/bornAt 三个标量，
     *   按原 id 装回去的成本极低。这笔账与"对象可能带着几十个字段和效果"完全不同。
     */
    case 'add_scene': {
      // 加一镜的逆 = 删掉它。注意这里的 assignedId 是引擎推导出来的 id。
      const id = op.assignedId;
      if (id === undefined) return notInvertible('missing_assigned_id');
      const inv: RemoveSceneCommand = { op: 'remove_scene', target: id };
      return { kind: 'ok', command: inv };
    }

    case 'set_scene': {
      let inv: SetSceneCommand = { op: 'set_scene', target: cmd.target };
      const namePatch = patchAt(op, 'scenes.' + cmd.target + '.name');
      if (namePatch !== undefined) inv = { ...inv, name: asString(valueFor(namePatch)) ?? null };
      const bornPatch = patchAt(op, 'scenes.' + cmd.target + '.bornAt');
      if (bornPatch !== undefined) inv = { ...inv, bornAt: asNumber(valueFor(bornPatch)) ?? null };
      return { kind: 'ok', command: inv };
    }

    case 'remove_scene': {
      // 逆 = 按【原 id 与原 bornAt】装回去。
      // 被删镜头本身从 'scenes' 替换 patch 的补偿值里按 id 找 ——
      // 刻意不去读一条 'scenes.X.removed' 之类的假路径：那个路径在文档里不存在，
      // resolvePath 解析不到，补偿会静默取回 undefined（见 apply.ts 的同名注释）。
      const p = patchAt(op, 'scenes');
      if (p === undefined) return notInvertible('unsupported_op');
      const raw = valueFor(p);
      if (!Array.isArray(raw)) return notInvertible('unsupported_op');
      const scene = raw.find((s) => isScene(s) && s.id === cmd.target);
      if (scene === undefined || !isScene(scene)) return notInvertible('unsupported_op');

      /**
       * ⚠️ 被改归属的那些对象【不】跟着回迁：applyCommand 只产出一条 Operation，
       *    Operation↔Command 是一对一的，逆操作里塞不进 N 条 promote_object。
       *    所以撤销"删镜头"会把镜头放回来，但原来在镜内的对象留在接管镜头上 ——
       *    它们的归属仍然有效（不悬空），只是不在原来的镜里了。
       *    要连归属一起撤销，将来需要"一条命令产出多条 Operation"的机制；
       *    现在如实记在这里，不假装它做到了。
       */
      const inv: AddSceneCommand = {
        op: 'add_scene',
        id: scene.id,
        name: scene.name,
        bornAt: scene.bornAt,
      };
      return { kind: 'ok', command: inv };
    }

    default:
      return notInvertible('unsupported_op');
  }
}

/**
 * 值是不是一个形状正确的 Scene。用于从 scenes 替换 patch 里把被删的镜头捞回来。
 * 缺字段说明 patch 被别的命令写坏了，宁可报不可逆，也不要装一个残缺镜头回去。
 */
function isScene(value: unknown): value is Scene {
  if (value === null || typeof value !== 'object') return false;
  const s = value as { id?: unknown; name?: unknown; bornAt?: unknown };
  return typeof s.id === 'string' && typeof s.name === 'string' && typeof s.bornAt === 'number';
}

/** 一条操作影响的路径（面板展示"这次撤销会改哪些字段"用）。 */
export function affectedFieldsOf(op: Operation): readonly string[] {
  return op.patches.map((p) => p.path);
}

export type { FieldAtom };
