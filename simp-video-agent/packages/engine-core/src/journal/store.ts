/**
 * Operation Journal 的实现。
 *
 * 它同时是"历史"和"当前文档"的持有者 —— 因为历史只有在能回答
 * "那一刻文档长什么样"时才有用（replay / revert / 面板对照都需要）。
 *
 * 快照很便宜：文档是不可变 + 结构共享的，所以每个版本存一个根引用即可，
 * 未改动的子树在所有版本之间共享同一份内存。
 *
 * 四个对外接口与工具名的对应（规范 §12）：
 *   get_journal({from,to,actor?,compoundId?})  → query()
 *   get_operations_affecting(path)             → operationsAffecting()
 *   revert_compound(compoundId)                → revertCompound()
 *   replay(fromVersion, toVersion)             → replay()
 */
import type { SceneDoc } from '../doc/types';
import { applyCommand, type ApplyContext, type ApplyFailure, type OperationPatch } from '../command/apply';
import type { Command } from '../command/commands';
import { dropUserLocks, mergeLocksForActor } from '../doc/locks';
import { deepEqual, resolveValue } from '../doc/paths';
import { invertOperation, type ValueLookup } from './invert';
import type {
  Actor,
  AppendInput,
  CompoundOperation,
  JournalDeps,
  JournalQuery,
  Operation,
  ReplayResult,
  RevertFold,
  RevertRejection,
  RevertResult,
  SkippedRevert,
} from './types';

export interface CommitInput {
  readonly actor: Actor;
  readonly command: Command;
  /**
   * 应用这条命令时的上下文（当前只有 registry）。
   *
   * ★ 必须能传进来：commit() 会**再应用一遍**命令，而 batch 的预检已经应用过一遍。
   *   两遍用的上下文一旦不同，就会出现"预检说 ok、提交说 failed"——
   *   症状是回执里 ok/errored/blocked 全是空的（命令凭空消失），极难查。
   *   参数化 registry 的测试最先踩到这个坑。
   */
  readonly applyCtx?: ApplyContext;
  readonly intent?: string;
  /** Agent Runtime 的轮次 id。同一轮内同 actor 的操作归入同一个 compound。 */
  readonly turnId?: string;
  /** 用户侧一次手势的 id（pointerdown..pointerup）。语义与 turnId 相同。 */
  readonly gestureId?: string;
}

export type CommitOutcome =
  | {
      readonly kind: 'committed';
      readonly operation: Operation;
      readonly doc: SceneDoc;
      readonly version: number;
    }
  | { readonly kind: 'failed'; readonly error: ApplyFailure; readonly doc: SceneDoc; readonly version: number };

export interface Journal {
  currentDoc(): SceneDoc;
  currentVersion(): number;

  /** 把一条命令接到提交路径上：应用 → 追加操作 → 版本前进 → 记快照。 */
  commit(input: CommitInput): CommitOutcome;

  /** 追加一条【已经应用过】的操作。revert 的补偿操作走这里。 */
  append(input: AppendInput, nextDoc: SceneDoc): Operation;

  /**
   * 把别的进程（Agent 服务端）产出的操作搬进这本日志，并把这批操作归到一个 compound 下。
   * 搬完之后 nextDoc 就是当前文档，且"撤销这一轮"可用。
   */
  appendEmbedded(
    entries: readonly Omit<AppendInput, 'actor'>[],
    nextDoc: SceneDoc,
    opts: { readonly actor: Actor; readonly compoundId: string; readonly settled?: boolean },
  ): readonly Operation[];

  registerSnapshot(doc: SceneDoc): void;
  snapshotAt(version: number): SceneDoc | undefined;

  operation(opId: string): Operation | undefined;
  operations(): readonly Operation[];

  compound(compoundId: string): CompoundOperation | undefined;
  compounds(): readonly CompoundOperation[];

  /** get_journal */
  query(q?: JournalQuery): readonly Operation[];
  /** get_operations_affecting */
  operationsAffecting(path: string): readonly Operation[];

  /** Agent Runtime 在 turn 结束时调它。返回被置位的 compoundId。 */
  settle(turnId: string): readonly string[];
  settleCompound(compoundId: string): boolean;

  /** revert_compound */
  revertCompound(compoundId: string): RevertResult;

  /** replay */
  replay(fromVersion: number, toVersion: number): ReplayResult;
}

/** 一句话描述一条命令，用于 compound 的 summary。 */
export function describeCommand(cmd: Command): string {
  switch (cmd.op) {
    case 'create_plot':
      return 'create_plot ' + cmd.localId;
    case 'create_object':
      return 'create_object ' + cmd.shape + ' ' + cmd.localId;
    case 'create_rect':
      return 'create_rect ' + cmd.localId;
    case 'create_line':
      return 'create_line ' + cmd.localId;
    case 'set_meta':
      return 'set_meta';
    case 'add_effect':
      return 'add_effect -> ' + cmd.target;
    case 'set_camera':
      return 'set_camera keys=' + cmd.keys.length;
    case 'camera_preset':
      return 'camera_preset ' + cmd.preset;
    case 'retime':
      return 'retime @' + cmd.fromMarker + ' ' + (cmd.delta >= 0 ? '+' : '') + cmd.delta + 's';
    case 'set_audio':
      return 'set_audio ' + cmd.target;
    case 'promote_object':
      return 'promote_object ' + cmd.target + ' -> ' + String((cmd.to as { kind?: string }).kind);
    case 'link_shared':
      return 'link_shared ' + cmd.sharedId + ' for ' + cmd.sceneId;
    case 'link_object':
      return 'link_object ' + cmd.objectId + ' -> ' + cmd.layerId;
    case 'unlink_object':
      return 'unlink_object ' + cmd.objectId + ' <- ' + cmd.layerId;
    case 'add_scene': {
      const where =
        cmd.bornAt === null || cmd.bornAt === undefined
          ? '接在 ' + String(cmd.at) + ' 之后'
          : '起点 ' + cmd.bornAt + 's';
      const who = cmd.id === null || cmd.id === undefined ? '' : ' id=' + cmd.id;
      return 'add_scene' + who + ' ' + where;
    }
    case 'set_parent': {
      const p = cmd.parent;
      return 'set_parent ' + cmd.target + ' → ' + (p === null || p === undefined ? '(顶层)' : String(p));
    }
    case 'set_highlight':
      return 'set_highlight ' + cmd.target;
    case 'set_move_along':
      return 'set_move_along ' + cmd.target;
    case 'set_scene':
      return 'set_scene ' + cmd.target;
    case 'remove_scene':
      return 'remove_scene ' + cmd.target;
    default:
      return cmd.op + ' ' + cmd.target;
  }
}

function pathMatches(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(path + '.') || path.startsWith(candidate + '.');
}

export function createJournal(initialDoc: SceneDoc, deps: JournalDeps): Journal {
  let doc = initialDoc;
  let version = initialDoc.docVersion;

  const ops: Operation[] = [];
  const byId = new Map<string, Operation>();
  const comps = new Map<string, CompoundOperation>();
  const snaps = new Map<number, SceneDoc>();
  snaps.set(version, doc);

  let opSeq = 0;
  let soloSeq = 0;
  let revertSeq = 0;

  function append(input: AppendInput, nextDoc: SceneDoc): Operation {
    const groupKey = input.turnId ?? input.gestureId ?? 'solo-' + (soloSeq += 1);
    const compoundId = input.compoundId ?? 'c:' + input.actor + ':' + groupKey;
    const baseVersion = version;
    const resultVersion = baseVersion + 1;
    const opId = 'op' + (opSeq += 1);

    const extras: { turnId?: string; intent?: string; assignedId?: string } = {};
    if (input.turnId !== undefined) extras.turnId = input.turnId;
    if (input.intent !== undefined) extras.intent = input.intent;
    if (input.assignedId !== undefined) extras.assignedId = input.assignedId;

    const op: Operation = {
      opId,
      compoundId,
      actor: input.actor,
      // 嵌入外部操作时没有原始命令（见 AppendInput.command 的注释）。
      // Operation.command 的类型保持必填不变，这里给一个空壳，
      // 由 appendEmbedded 的调用方显式知情。
      command: input.command ?? ({ op: 'unsupported_op' } as unknown as Command),
      baseVersion,
      resultVersion,
      affectedPaths: [...input.affectedPaths],
      at: deps.now(),
      patches: [...input.patches],
      ...extras,
    };

    ops.push(op);
    byId.set(opId, op);
    doc = nextDoc;
    version = resultVersion;
    snaps.set(version, doc);

    const existing = comps.get(compoundId);
    if (existing === undefined) {
      const cExtras: { turnId?: string } = {};
      if (input.turnId !== undefined) cExtras.turnId = input.turnId;
      comps.set(compoundId, {
        compoundId,
        actor: input.actor,
        opIds: [opId],
        fromVersion: baseVersion,
        toVersion: resultVersion,
        summary: input.summary ?? (input.command === undefined ? '嵌入操作' : describeCommand(input.command)),
        // settled 由 Agent Runtime 在 turn 结束时置位（规范 §12）。
        // 用户手势与引擎自动修不经过 Runtime，由调用方显式 settle。
        settled: false,
        ...cExtras,
      });
    } else {
      comps.set(compoundId, {
        ...existing,
        opIds: [...existing.opIds, opId],
        toVersion: resultVersion,
        summary: existing.summary + '; ' + (input.summary ?? (input.command === undefined ? '嵌入操作' : describeCommand(input.command))),
      });
    }
    return op;
  }

  /**
   * 把【别的进程跑出来的操作】搬进这本日志。
   *
   * 用途：Agent 跑在服务端（API key 不能进浏览器），它产生的写入必须进
   * 浏览器这本 Journal —— 否则"撤销 AI 这一轮"就没得撤，面板的版本号也会和文档脱节。
   *
   * ★ 语义上这是一次【受控的越权】：它绕过 applyCommand，直接接受调用方给的 patches。
   *   敢这么做是因为 nextDoc 由服务端权威产出、调用方只是搬运。
   *   但仍然走这本日志（而不是让面板直接换 doc），是为了保住三条不变量：
   *   版本单调、每个版本有快照、每个 compound 可撤。
   *
   * ★ 刻意【不】用"重放命令"实现：Agent 的操作序列里含引擎自动修
   *   （例如把缺失的 duration 补成 2 秒）。自动修只在当时的文档状态下成立，
   *   重放会算出不同结果 —— 搬一个"已知事实"比重放一份"算出来的猜测"诚实。
   */
  function appendEmbedded(
    entries: readonly Omit<AppendInput, 'actor'>[],
    nextDoc: SceneDoc,
    opts: { readonly actor: Actor; readonly compoundId: string; readonly settled?: boolean },
  ): readonly Operation[] {
    const out: Operation[] = [];
    for (const entry of entries) {
      out.push(append({ ...entry, actor: opts.actor, compoundId: opts.compoundId }, nextDoc));
    }
    // 同一批嵌入操作共享同一个结果文档：中间版本的快照指向同一份不可变 doc，
    // 这是安全的（文档不可变 + 结构共享），也让每个版本号都有快照可取。
    const compound = comps.get(opts.compoundId);
    if (compound !== undefined) {
      comps.set(opts.compoundId, { ...compound, settled: opts.settled ?? true });
    }
    return out;
  }

  /**
   * 把一条命令接到提交路径上：应用 → 追加操作 → 版本前进 → 记快照。
   *
   * ★ 这里也是【锁唯一被写入的地方】（规范 §8）：
   *   actor 为 'user' 的写入会在它改过的路径上留下 hard 锁，
   *   于是"AI 必须先问用户"这件事第一次真的会在运行中发生
   *   （在此之前 doc.locks 只能靠夹具预置）。
   */
  function commit(input: CommitInput): CommitOutcome {
    const applied = applyCommand(doc, input.command, input.applyCtx ?? {});
    if (applied.kind === 'failed') {
      return { kind: 'failed', error: applied.error, doc, version };
    }
    const locked = mergeLocksForActor(applied.doc, input.actor, applied.affectedPaths, deps.now());
    const appendInput: AppendInput = {
      actor: input.actor,
      command: input.command,
      patches: applied.patches,
      affectedPaths: applied.affectedPaths,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.gestureId === undefined ? {} : { gestureId: input.gestureId }),
      ...(applied.assignedId === undefined ? {} : { assignedId: applied.assignedId }),
    };
    const op = append(appendInput, locked.doc);
    return { kind: 'committed', operation: op, doc, version };
  }

  function query(q: JournalQuery = {}): readonly Operation[] {
    const from = q.from ?? Number.NEGATIVE_INFINITY;
    const to = q.to ?? Number.POSITIVE_INFINITY;
    return ops.filter((o) => {
      if (o.resultVersion < from || o.resultVersion > to) return false;
      if (q.actor !== undefined && o.actor !== q.actor) return false;
      if (q.compoundId !== undefined && o.compoundId !== q.compoundId) return false;
      return true;
    });
  }

  function operationsAffecting(path: string): readonly Operation[] {
    return ops.filter(
      (o) =>
        o.affectedPaths.some((p) => pathMatches(p, path)) ||
        o.patches.some((p) => pathMatches(p.path, path)),
    );
  }

  function settle(turnId: string): readonly string[] {
    const touched: string[] = [];
    for (const [id, c] of comps) {
      if (c.turnId === turnId && !c.settled) {
        comps.set(id, { ...c, settled: true });
        touched.push(id);
      }
    }
    return touched;
  }

  function settleCompound(compoundId: string): boolean {
    const c = comps.get(compoundId);
    if (c === undefined || c.settled) return false;
    comps.set(compoundId, { ...c, settled: true });
    return true;
  }

  function reject(compoundId: string, reason: RevertRejection): RevertResult {
    return {
      kind: 'rejected',
      compoundId,
      reason,
      reverted: [],
      skipped: [],
      folded: [],
      doc,
      version,
    };
  }

  /**
   * 撤销一个 compound。
   *
   * 算法是【摘除 + 重算】，不是"逐条逆序恢复"：
   *
   *   1. 取本轮开始之前的快照 base；
   *   2. 从 base 起重放【除本轮之外】的全部操作，得到 target
   *      —— target 就是"本轮从未发生过"的那个文档；
   *   3. 逐条逆序，用 target 里的值构造补偿命令，走同一条写路径写回。
   *
   * 为什么不能逐条恢复成 patches[].before：
   *   width 3 →(AI:5) →(用户:7) →(AI:9)
   *   朴素逆序会恢复成 3，把用户的 7 吃掉；摘除重算得到的是 7（正确）。
   *   发生这种折叠时会在 folded 里如实报出来，面板要能解释"为什么不是 3"。
   *
   * 只动本轮 patches 覆盖到的路径，所以用户在本轮之外的改动一定不受影响。
   */
  function revertCompound(compoundId: string): RevertResult {
    const c = comps.get(compoundId);
    if (c === undefined) return reject(compoundId, 'compound_not_found');
    if (!c.settled) return reject(compoundId, 'compound_not_settled');
    for (const other of comps.values()) {
      if (other.revertOf === compoundId) return reject(compoundId, 'already_reverted');
    }

    const base = snaps.get(c.fromVersion);
    const spliceConflicts: string[] = [];
    let target: SceneDoc | null = null;
    if (base !== undefined) {
      let working = base;
      for (const o of ops) {
        if (o.resultVersion <= c.fromVersion) continue;
        if (o.compoundId === compoundId) continue;
        const r = applyCommand(working, o.command, {});
        if (r.kind === 'applied') working = r.doc;
        else spliceConflicts.push(o.opId);
      }
      target = working;
    }

    const valueFor: ValueLookup = (p) => {
      if (target === null) return p.before;
      const v = resolveValue(target, p.path);
      return v === undefined ? p.before : v;
    };

    // 折叠报告要按【撤销开始那一刻】的历史来算，
    // 否则本次撤销刚追加的补偿操作会被误算成"中间改过这条路径的人"。
    const versionAtStart = version;

    const skipped: SkippedRevert[] = [];
    for (const opId of spliceConflicts) {
      skipped.push({
        opId,
        path: '',
        reason: 'target_missing',
        expected: undefined,
        actual: undefined,
      });
    }

    const reverted: Operation[] = [];
    const appliedPaths: string[] = [];
    const revertCompoundId = 'c:revert:' + compoundId + ':' + (revertSeq += 1);

    const members = c.opIds
      .map((id) => byId.get(id))
      .filter((o): o is Operation => o !== undefined);

    for (let i = members.length - 1; i >= 0; i--) {
      const op = members[i];
      if (op === undefined) continue;

      if (op.patches.length === 0) {
        skipped.push({
          opId: op.opId,
          path: op.affectedPaths[0] ?? '',
          reason: 'nothing_to_undo',
          expected: undefined,
          actual: undefined,
        });
        continue;
      }

      const inv = invertOperation(op, valueFor);
      if (inv.kind !== 'ok') {
        skipped.push({
          opId: op.opId,
          path: op.affectedPaths[0] ?? '',
          reason: 'not_invertible',
          expected: undefined,
          actual: undefined,
        });
        continue;
      }

      const applied = applyCommand(doc, inv.command, {});
      if (applied.kind === 'failed') {
        skipped.push({
          opId: op.opId,
          path: op.affectedPaths[0] ?? '',
          reason: 'target_missing',
          expected: undefined,
          actual: undefined,
        });
        continue;
      }

      const patches: readonly OperationPatch[] = applied.patches;
      // ★ 撤销一条【用户写入】时要把它的锁一起摘掉，
      //   否则撤销完字段还锁着，用户会当成 bug。
      //   dropUserLocks 只摘 by:'user' 的锁 —— 别的来源的锁不该被撤销动作顺手抹掉。
      const unlocked = dropUserLocks(applied.doc, applied.affectedPaths);
      const compensation = append(
        {
          actor: 'user',
          command: inv.command,
          patches,
          affectedPaths: applied.affectedPaths,
          intent: '撤销 ' + op.opId,
          summary: 'revert ' + describeCommand(op.command),
          ...(applied.assignedId === undefined ? {} : { assignedId: applied.assignedId }),
        },
        unlocked,
      );

      // 补偿操作不属于调用方原来的那个分组，改挂到 revert 自己的 compound 下
      const strayId = compensation.compoundId;
      comps.delete(strayId);
      const moved: Operation = { ...compensation, compoundId: revertCompoundId };
      byId.set(moved.opId, moved);
      const idx = ops.findIndex((o) => o.opId === moved.opId);
      if (idx >= 0) ops[idx] = moved;

      const existing = comps.get(revertCompoundId);
      if (existing === undefined) {
        comps.set(revertCompoundId, {
          compoundId: revertCompoundId,
          actor: 'user',
          opIds: [moved.opId],
          fromVersion: moved.baseVersion,
          toVersion: moved.resultVersion,
          summary: 'revert ' + compoundId,
          settled: true,
          revertOf: compoundId,
        });
      } else {
        comps.set(revertCompoundId, {
          ...existing,
          opIds: [...existing.opIds, moved.opId],
          toVersion: moved.resultVersion,
        });
      }

      reverted.push(moved);
      for (const p of patches) if (!appliedPaths.includes(p.path)) appliedPaths.push(p.path);
    }

    // 折叠报告：补偿值与"本轮改之前的值"不一致，说明中间有别人写过
    const folded: RevertFold[] = [];
    for (const path of appliedPaths) {
      const owner = members.find((m) => m.patches.some((p) => p.path === path));
      const patch = owner?.patches.find((p) => p.path === path);
      if (owner === undefined || patch === undefined || patch.before === undefined) continue;
      const appliedValue = valueFor(patch);
      if (deepEqual(appliedValue, patch.before)) continue;
      if (folded.some((f) => f.path === path)) continue;
      folded.push({
        path,
        originalBefore: patch.before,
        appliedValue,
        supersededBy: ops
          .filter(
            (o) =>
              o.resultVersion > owner.resultVersion &&
              o.resultVersion <= versionAtStart &&
              o.compoundId !== compoundId &&
              o.patches.some((p) => p.path === path),
          )
          .map((o) => o.opId),
      });
    }

    return {
      kind: 'reverted',
      compoundId,
      reverted,
      skipped,
      folded,
      doc,
      version,
      ...(reverted.length === 0 ? {} : { revertCompoundId }),
    };
  }

  function replay(fromVersion: number, toVersion: number): ReplayResult {
    const start = snaps.get(fromVersion);
    if (start === undefined) {
      return { fromVersion, toVersion, operations: [], doc: null };
    }
    let working = start;
    const selected = ops.filter(
      (o) => o.resultVersion > fromVersion && o.resultVersion <= toVersion,
    );
    for (const o of selected) {
      const r = applyCommand(working, o.command, {});
      if (r.kind === 'applied') working = r.doc;
    }
    return { fromVersion, toVersion, operations: selected, doc: working };
  }

  return {
    currentDoc: () => doc,
    currentVersion: () => version,
    commit,
    append,
    appendEmbedded,
    registerSnapshot: (d) => {
      snaps.set(d.docVersion, d);
    },
    snapshotAt: (v) => snaps.get(v),
    operation: (opId) => byId.get(opId),
    operations: () => ops,
    compound: (id) => comps.get(id),
    compounds: () => [...comps.values()],
    query,
    operationsAffecting,
    settle,
    settleCompound,
    revertCompound,
    replay,
  };
}
