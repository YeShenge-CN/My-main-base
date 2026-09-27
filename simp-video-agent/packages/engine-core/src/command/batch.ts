/**
 * apply_commands —— 批量事务（规范 §7）。
 *
 * 执行语义严格按序：
 *   1. schema / 位置校验
 *   2. 预检 simulate()：在文档副本上顺序执行，得到 diff
 *   3. 依赖推导（自动，模型不写）—— ★ 精确到"localId 的产生者"，不是"前一条命令"
 *   4. 提交 ok[] 部分，docVersion++，追加 Operation Journal
 *   5. 默认不回滚；atomic:true 时才全或无
 *   6. 超过 15 条提示模型切分
 *
 * 四态：ok / proposals / blocked / errored。
 *   ok        已提交
 *   proposals 命中 hard 锁，未提交，等审批
 *   blocked   上游是 proposal 或 error（传递闭包）
 *   errored   引擎判定这条命令不合法
 */
import type { SceneDoc } from '../doc/types';
import type { FieldGroup } from '../registry/types';
import { lockClassOf } from '../doc/types';
import { applyCommand, type ApplyContext, type ApplyFailure } from './apply';
import type { Command } from './commands';
import type { Scope } from '../doc/permissions';
import { resolveValue } from '../doc/paths';
import type { Journal } from '../journal/store';
import type { Actor } from '../journal/types';
import type { Precondition, Proposal } from './proposal';
import {
  MAX_BATCH_SIZE,
  type ApplyCommandsRequest,
  type ApplyCommandsResponse,
  type AutofixRecord,
  type BlockedOutcome,
  type BlockedReason,
  type BudgetState,
  type CommandError,
  type CommandErrorCode,
  type CommandOutcome,
  type ErroredOutcome,
  type IssueCounts,
  type Notice,
  type OkOutcome,
  type ProposalOutcome,
} from './results';

/* ══════════════════════════════════════════════════════════════
 * 命令的静态分析：产生 / 引用 / 写入哪些 id 与路径
 * ══════════════════════════════════════════════════════════════ */

function collectLocalIds(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('$')) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectLocalIds(v, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectLocalIds(v, out);
  }
}

/**
 * 这条命令引用了哪些符号 id。
 *
 * 三个字段必须排除，它们不是"引用"：
 *   intent     自由文本，里面完全可能写到 $c1
 *   dependsOn  依赖声明的下标，不是 id
 *   localId    这是【产物】不是引用 —— 漏掉它会让 create 命令自己引用自己，
 *              于是第一条命令就报 unknown_local_id
 */
export function referencedLocalIds(cmd: Command): readonly string[] {
  const clone: Record<string, unknown> = { ...(cmd as unknown as Record<string, unknown>) };
  delete clone['intent'];
  delete clone['dependsOn'];
  delete clone['localId'];
  const out = new Set<string>();
  collectLocalIds(clone, out);
  return [...out].sort();
}

/** 这条命令会产生哪些符号 id。 */
export function producedLocalIds(cmd: Command): readonly string[] {
  if (cmd.op === 'create_plot' || cmd.op === 'create_object' || cmd.op === 'create_rect' || cmd.op === 'create_line') {
    return [cmd.localId];
  }
  if (cmd.op === 'add_effect' || cmd.op === 'add_scene') {
    return cmd.localId === null || cmd.localId === undefined ? [] : [cmd.localId];
  }
  return [];
}

/** 把命令里所有 '$$x' 形式的引用替换成真实 id。 */
export function mapLocalIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    const replaced = map.get(value);
    return (replaced === undefined ? value : replaced) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => mapLocalIds(v, map)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapLocalIds(v, map);
    return out as unknown as T;
  }
  return value;
}

/**
 * 这条命令会写哪些路径（不执行就推出来）。
 * 锁判定必须在【应用之前】做出来，否则没法决定是提交还是转提案。
 * 新建类命令返回空数组 —— 还不存在的 id 上不可能有锁。
 */
export function writeSetOf(cmd: Command): readonly string[] {
  switch (cmd.op) {
    case 'set_meta': {
      const out: string[] = [];
      if (cmd.fps !== null && cmd.fps !== undefined) out.push('meta.fps');
      if (cmd.duration !== null && cmd.duration !== undefined) out.push('meta.duration');
      if (cmd.viewport !== null && cmd.viewport !== undefined) out.push('meta.viewport');
      return out;
    }
    case 'set_style': {
      const out: string[] = [];
      if (cmd.width !== null && cmd.width !== undefined) out.push(cmd.target + '.style.width');
      if (cmd.glow !== null && cmd.glow !== undefined) out.push(cmd.target + '.style.glow');
      if (cmd.stroke !== null && cmd.stroke !== undefined) out.push(cmd.target + '.style.stroke');
      if (cmd.fill !== null && cmd.fill !== undefined) out.push(cmd.target + '.style.fill');
      if (cmd.fillOpacity !== null && cmd.fillOpacity !== undefined) out.push(cmd.target + '.style.fillOpacity');
      if (cmd.headSize !== null && cmd.headSize !== undefined) out.push(cmd.target + '.style.headSize');
      if (cmd.size !== null && cmd.size !== undefined) out.push(cmd.target + '.style.size');
      if (cmd.align !== null && cmd.align !== undefined) out.push(cmd.target + '.style.align');
      if (cmd.maxWidth !== null && cmd.maxWidth !== undefined) out.push(cmd.target + '.style.maxWidth');
      if (cmd.bold !== null && cmd.bold !== undefined) out.push(cmd.target + '.style.bold');
      return out;
    }
    /** 形状几何（三条）：几何类改动，路径落在 params 上。 */
    case 'set_rect': {
      const out: string[] = [];
      if (cmd.width !== null && cmd.width !== undefined) out.push(cmd.target + '.params.width');
      if (cmd.height !== null && cmd.height !== undefined) out.push(cmd.target + '.params.height');
      if (cmd.radius !== null && cmd.radius !== undefined) out.push(cmd.target + '.params.radius');
      return out;
    }
    case 'set_line': {
      const out: string[] = [];
      if (cmd.from !== null && cmd.from !== undefined) out.push(cmd.target + '.params.from');
      if (cmd.to !== null && cmd.to !== undefined) out.push(cmd.target + '.params.to');
      if (cmd.head !== null && cmd.head !== undefined) out.push(cmd.target + '.params.head');
      return out;
    }
    case 'set_text': {
      return cmd.content === null || cmd.content === undefined ? [] : [cmd.target + '.params.content'];
    }
    case 'set_expression':
      return [cmd.target + '.params.expr'];
    case 'set_parent':
      return [cmd.target + '.parent'];
    case 'set_transform': {
      const out: string[] = [];
      const pairs: [string, unknown][] = [
        ['x', cmd.x],
        ['y', cmd.y],
        ['rotate', cmd.rotate],
        ['sx', cmd.sx],
        ['sy', cmd.sy],
        ['opacity', cmd.opacity],
      ];
      for (const [key, value] of pairs) {
        if (value !== null && value !== undefined) out.push(cmd.target + '.tf.' + key);
      }
      return out;
    }
    case 'set_effect': {
      const out: string[] = [];
      const pairs: [string, unknown][] = [
        ['start', cmd.start],
        ['duration', cmd.duration],
        ['mode', cmd.mode],
        ['tip', cmd.tip],
      ];
      for (const [key, value] of pairs) {
        if (value !== null && value !== undefined) out.push(cmd.target + '.params.' + key);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) out.push(cmd.target + '.ease');
      return out;
    }
    case 'set_highlight': {
      const out: string[] = [];
      const pairs: [string, unknown][] = [
        ['start', cmd.start],
        ['duration', cmd.duration],
        ['color', cmd.color],
        ['intensity', cmd.intensity],
      ];
      for (const [key, value] of pairs) {
        if (value !== null && value !== undefined) out.push(cmd.target + '.params.' + key);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) out.push(cmd.target + '.ease');
      return out;
    }
    case 'set_move_along': {
      const out: string[] = [];
      const pairs: [string, unknown][] = [
        ['source', cmd.source],
        ['start', cmd.start],
        ['duration', cmd.duration],
      ];
      for (const [key, value] of pairs) {
        if (value !== null && value !== undefined) out.push(cmd.target + '.params.' + key);
      }
      if (cmd.ease !== null && cmd.ease !== undefined) out.push(cmd.target + '.ease');
      return out;
    }
    case 'set_visibility': {
      const out: string[] = [];
      if (cmd.at !== null && cmd.at !== undefined) out.push(cmd.target + '.params.at');
      return out;
    }
    case 'set_motion':
      return [cmd.target + '.anim.' + cmd.field];
    case 'set_sampling': {
      const out: string[] = [];
      if (cmd.samples !== null && cmd.samples !== undefined) out.push(cmd.target + '.params.samples');
      if (cmd.domain !== null && cmd.domain !== undefined) out.push(cmd.target + '.params.domain');
      return out;
    }
    case 'link_object':
    case 'unlink_object':
      return ['layers.' + cmd.layerId + '.objects'];
    case 'set_audio': {
      const out: string[] = [];
      if (cmd.startAt !== null && cmd.startAt !== undefined) out.push(cmd.target + '.startAt');
      if (cmd.gain !== null && cmd.gain !== undefined) out.push(cmd.target + '.gain');
      return out;
    }
    case 'promote_object':
      return [cmd.target + '.owner'];
    case 'link_shared':
      return [cmd.sharedId + '.owner.usageWindows'];
    case 'retime':
      return ['meta.duration', 'timeline'];
    case 'set_camera':
    case 'camera_preset':
      return ['camera.keys'];
    case 'delete_object':
      return ['objects.' + cmd.target];
    case 'delete_effect':
      return ['effects.' + cmd.target];
    case 'create_plot':
    case 'create_object':
    case 'create_rect':
    case 'create_line':
    case 'add_effect':
      return [];
    /* ── 镜头表（P12）─────────────────────────────────────────
     * ★ 这三条不许落进 default 的空数组 —— 那等于"没有锁"，而不是"不需要检查"。
     *   它们的写集是【结构】而不是某个字段：锁是按点分路径记的，
     *   所以这里写的是"这次改动落到哪些路径上"，与 apply 产出的 patch 路径同构。
     */
    case 'add_scene':
      // 新镜头还不存在，不可能被锁住（与 create_* 同理）
      return [];
    case 'set_scene': {
      const out: string[] = [];
      if (cmd.name !== null && cmd.name !== undefined) out.push('scenes.' + cmd.target + '.name');
      // ⚠️ 改 bornAt 会连带改变【本镜与前一镜】的时间窗（sceneEnd 派生）。
      //    这里只声明直接写入的路径，是刻意的：时间窗是派生量、没有自己的锁。
      //    将来若把 locks 扩到派生量上，这里要一起改。
      if (cmd.bornAt !== null && cmd.bornAt !== undefined) out.push('scenes.' + cmd.target + '.bornAt');
      return out;
    }
    case 'remove_scene':
      // 删镜头 = 改 scenes 表 + 把镜内对象改归属，两者都在写集里
      return ['scenes', 'objects'];
    default:
      return [];
  }
}

/* ══════════════════════════════════════════════════════════════
 * 批量事务
 * ══════════════════════════════════════════════════════════════ */

export interface BatchDeps {
  readonly journal: Journal;
  /** 图像预算剩余量（规范 §10 的 L2 层）。回执里必须带上，否则模型记不住。 */
  readonly budget: () => BudgetState;
  readonly actor: Actor;
  /**
   * 本次写入的身份/权限范围（多 Agent：谁是作者）。
   *
   * 不传 = 导演视角 = 全权。
   * 传了 = 场景 Agent：`owner.sceneId: null` 落成"我这一镜"，
   *        `retime` 只顺延本镜（越界时整条命令失败）。
   */
  readonly scope?: Scope;
  /** Agent Runtime 的轮次 id，会写进 compound。 */
  readonly turnId?: string;
  /**
   * 【一次用户手势】的 id：同一批命令共用它 → 同一个 compound → **一次撤销能全撤回来**。
   *
   * ★ 为什么必须有这个概念（而不是让调用方自己拼 compoundId）：
   *   compound 的分组键是 `turnId ?? gestureId ?? 'solo-N'` ——
   *   不传就是"每条命令各自一个 compound"。于是"加一镜"这种**两条命令**的手势
   *   （add_scene + set_meta）会被拆成两个可撤销单元：用户点一次"撤销"，
   *   只撤掉了后半截，留下一个**零长度的镜头** —— 看起来像撤销坏了。
   *
   * ★ 而且 journal 里那个 compoundId 的字符串格式（`c:<actor>:<key>`）是
   *   journal 的默认约定，**不能让调用方自己拼**（拼错了不报错，只是撤销找不到东西）。
   *   所以这里只收 id，拼装与置位都在引擎里做。
   *
   * ★ 传了它（且没传 turnId），本函数会在提交之后把这些 compound 置为 settled ——
   *   用户手势在 applyCommands 返回时就已经结束了，不像 Agent 的轮次还要等下一轮。
   *   两个都给时按 turnId 分组、也由 Runtime 置位：轮次的生命周期轮不到 gesture 说了算。
   *   这条"别忘了 settle"以前只写在注释里，结果是**面板里用户自己的编辑从来不可撤销**
   *   （按钮永远灰着），所以现在由引擎兜住。
   */
  readonly gestureId?: string;
  /** 墙上时钟毫秒。engine-core 禁止读时钟（不变量 1），所以由宿主注入。 */
  readonly now: () => number;
  /** 校验器产出的问题计数。P7 接上 validate() 之后注入真实值。 */
  readonly issues?: () => IssueCounts;
  /**
   * 引擎自动修。**必须由宿主注入** —— autoFix 在 validate/ 下，而 validate 依赖本模块，
   * 直接 import 会成环。注入还有额外好处：谁来修（引擎 / 另一个进程）由宿主决定。
   *
   * 规范 §9：fixClass 为 auto 的问题"引擎可直接执行"。这块以前根本没接线，
   * 压力测试量化出了代价：14 条失败里 7 条是引擎判定为 auto 却没执行的。
   */
  readonly autoFix?: () => readonly AutofixRecord[];
  /**
   * 字段级约束的真源（默认内置 REGISTRY）。
   *
   * 存在两个理由：引擎侧的字段名校验靠它（见 apply.ts 的 create_object）；
   * 以及测试可以注册一个只属于该测试的 shape，而不必污染全局登记表。
   */
  readonly registry?: { readonly groups: readonly FieldGroup[] };
}

const EMPTY_ISSUES: IssueCounts = { total: 0, byGroup: {} };

/** 必须人工确认的命令：Agent 不得自行执行（P12 第 3 条）。 */
export const CONFIRM_REQUIRED_OPS: ReadonlySet<string> = new Set(['promote_object']);

function toCommandError(failure: ApplyFailure): CommandError {
  /**
   * ApplyFailure.code → CommandErrorCode。
   *
   * ★ 原来是一串三元表达式，默认落到 invalid_argument。加 field_not_in_shape 时
   *   实测后果：引擎明明报的是字段名问题，回执里却写着 invalid_argument ——
   *   模型据此完全看不出该改字段名。现在 ApplyFailure 是封闭联合 + 这里显式列举，
   *   漏一个分支类型系统就会提醒（known 表与联合的差集靠人工核对，注释里写明）。
   */
  const passthrough: readonly CommandErrorCode[] = [
    'unknown_target',
    'unsupported_op',
    'unsupported_shape',
    'field_not_in_shape',
    'invalid_argument',
    'scene_bounds_exceeded',
  ];
  const code: CommandErrorCode = passthrough.includes(failure.code as CommandErrorCode)
    ? (failure.code as CommandErrorCode)
    : 'invalid_argument';
  return failure.path === undefined
    ? { code, message: failure.message }
    : { code, message: failure.message, path: failure.path };
}

export function applyCommands(req: ApplyCommandsRequest, deps: BatchDeps): ApplyCommandsResponse {
  const journal = deps.journal;
  // 字段级约束的真源往下传：create_object 的字段名校验要用它
  /**
   * ★ 预检与提交必须用**同一份** applyCtx（历史上的"命令凭空消失"就是这个坑）。
   *   所以 scope 与 registry 一起在这里构造一次，两处共用。
   */
  const applyCtx: ApplyContext = {
    ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    ...(deps.scope === undefined ? {} : { scope: deps.scope }),
  };
  const doc0 = journal.currentDoc();
  const commands = req.commands;
  const notices: Notice[] = [];

  if (commands.length > MAX_BATCH_SIZE) {
    notices.push({
      code: 'batch_too_large',
      message: '本批 ' + commands.length + ' 条，超过 ' + MAX_BATCH_SIZE + ' 条上限，请拆成几批提交。',
    });
  }

  // ── 依赖推导 ──────────────────────────────────────────────────
  // 生产者表：符号 id → 产生它的命令下标
  const producers = new Map<string, number>();
  commands.forEach((cmd, i) => {
    for (const localId of producedLocalIds(cmd)) {
      if (!producers.has(localId)) producers.set(localId, i);
    }
  });

  const depsOf: number[][] = commands.map((cmd, i) => {
    const set = new Set<number>();
    for (const ref of referencedLocalIds(cmd)) {
      const producer = producers.get(ref);
      if (producer !== undefined && producer !== i) set.add(producer);
    }
    for (const d of cmd.dependsOn ?? []) {
      if (d >= 0 && d < commands.length && d !== i) set.add(d);
    }
    return [...set].sort((a, b) => a - b);
  });

  // ── 预检：在文档副本上顺序执行 ────────────────────────────────
  const outcomes: (CommandOutcome | null)[] = commands.map(() => null);
  const resolved: (Command | null)[] = commands.map(() => null);
  const assigned = new Map<string, string>();
  let working: SceneDoc = doc0;

  for (let i = 0; i < commands.length; i++) {
    const raw = commands[i];
    if (raw === undefined) continue;

    if (raw.index !== undefined && raw.index !== i) {
      outcomes[i] = {
        kind: 'errored',
        index: i,
        error: {
          code: 'index_mismatch',
          message: '命令声明的 index=' + raw.index + ' 与实际位置 ' + i + ' 不一致',
        },
      };
      continue;
    }

    const blockers = depsOf[i]?.filter((d) => {
      const o = outcomes[d];
      return o !== null && o !== undefined && o.kind !== 'ok';
    }) ?? [];
    if (blockers.length > 0) {
      const by = blockers[0] ?? 0;
      const upstream = outcomes[by];
      // 传递闭包要报【根因】：如果上游本身也是被挡住的，就把它的根因与根因下标继承下来，
      // 否则模型会以为是"中间那一条"出了问题。
      const inherited = upstream?.kind === 'blocked' ? upstream.blockedBy : by;
      const reason: BlockedReason =
        upstream?.kind === 'proposal'
          ? 'proposal_pending'
          : upstream?.kind === 'blocked'
            ? upstream.reason
            : 'error_upstream';
      outcomes[i] = {
        kind: 'blocked',
        index: i,
        blockedBy: inherited,
        reason,
        detail: '依赖第 ' + by + ' 条命令，最终被第 ' + inherited + ' 条挡住',
      };
      continue;
    }

    const missing = referencedLocalIds(raw).filter((r) => !assigned.has(r));
    if (missing.length > 0) {
      const later = missing.filter((m) => (producers.get(m) ?? -1) > i);
      outcomes[i] = {
        kind: 'errored',
        index: i,
        error: {
          code: 'unknown_local_id',
          message:
            (later.length > 0
              ? '引用了靠后的命令才会产生的符号 id: ' + later.join(', ')
              : '未知的符号 id: ' + missing.join(', ')) +
            '（符号名必须以 $ 开头，且必须由本批靠前的命令产生；' +
            '想引用已经存在的对象就直接写它的真实 id，如 plot#1）',
        },
      };
      continue;
    }

    const cmd = mapLocalIds(raw, assigned);
    resolved[i] = cmd;

    // ★ P12 第 3 条：改归属需要人工确认。
    //   Agent 发起时一律降级为提案 —— 它不能自己给自己扩权。
    if (CONFIRM_REQUIRED_OPS.has(cmd.op) && deps.actor === 'agent') {
      outcomes[i] = {
        kind: 'proposal',
        index: i,
        proposal: buildProposal({
          index: i,
          cmd,
          paths: [String((cmd as { target?: string }).target ?? '') + '.owner'],
          doc: working,
          docVersion: journal.currentVersion(),
          actor: deps.actor,
          at: deps.now(),
        }),
      };
      continue;
    }

    // 锁：hard 必须走 request_patch，因此在这里降级成提案（文档不动）
    const writePaths = writeSetOf(cmd);
    const hard = writePaths.filter((p) => {
      const entry = working.locks[p];
      return entry !== undefined && lockClassOf(entry) === 'hard';
    });
    const soft = writePaths.filter((p) => {
      const entry = working.locks[p];
      return entry !== undefined && lockClassOf(entry) === 'soft';
    });

    // ★ 锁是'AI 必须先问我'，不是'我问我自己'。
    //   少了 actor 判断，用户自己改自己被锁的字段也会变成提案 ——
    //   对抗臂的'用户写入'因此从未落盘，precondition 恒成立，stale 恒为 0。
    if (hard.length > 0 && deps.actor !== 'user') {
      const proposal = buildProposal({
        index: i,
        cmd,
        paths: hard,
        doc: working,
        docVersion: journal.currentVersion(),
        actor: deps.actor,
        at: deps.now(),
      });
      outcomes[i] = { kind: 'proposal', index: i, proposal };
      continue;
    }

    const applied = applyCommand(working, cmd, applyCtx);
    if (applied.kind === 'failed') {
      outcomes[i] = { kind: 'errored', index: i, error: toCommandError(applied.error) };
      continue;
    }

    working = applied.doc;
    if (applied.assignedId !== undefined) {
      for (const localId of producedLocalIds(raw)) assigned.set(localId, applied.assignedId);
    }
    if (hard.length > 0 && deps.actor === 'user') {
      notices.push({
        code: 'own_lock_overridden',
        message: '第 ' + i + ' 条改的是用户自己锁住的字段: ' + hard.join(', ') + '。锁按用户本人意愿放行。',
      });
    }
    if (soft.length > 0) {
      notices.push({
        code: 'soft_lock_overwritten',
        message: '第 ' + i + ' 条改了动画驱动的字段，会覆盖动画: ' + soft.join(', '),
      });
    }
    outcomes[i] = {
      kind: 'ok',
      index: i,
      affectedPaths: applied.affectedPaths,
      versionBefore: journal.currentVersion(),
      versionAfter: journal.currentVersion(),
      operationId: '',
      ...(applied.assignedId === undefined ? {} : { assignedId: applied.assignedId }),
    };
  }

  const proposals: ProposalOutcome[] = [];
  const blocked: BlockedOutcome[] = [];
  const errored: ErroredOutcome[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o === null || o === undefined) continue;
    if (o.kind === 'proposal') proposals.push(o);
    else if (o.kind === 'blocked') blocked.push(o);
    else if (o.kind === 'errored') errored.push(o);
  }

  // ── atomic：全或无 ────────────────────────────────────────────
  const anyFailure = proposals.length > 0 || errored.length > 0 || blocked.length > 0;
  if (req.atomic === true && anyFailure) {
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (o === null || o === undefined || o.kind !== 'ok') continue;
      blocked.push({
        kind: 'blocked',
        index: i,
        blockedBy: -1,
        reason: 'atomic_abort',
        detail: 'atomic:true 且批次内有失败，整批未提交',
      });
    }
    blocked.sort((a, b) => a.index - b.index);
    return {
      version: journal.currentVersion(),
      ok: [],
      proposals,
      blocked,
      errored,
      autofixed: [],
      changed: [],
      issues: deps.issues?.() ?? EMPTY_ISSUES,
      budget: deps.budget(),
      ...(notices.length === 0 ? {} : { notices }),
    };
  }

  // ── 提交 ok[]：顺序写进 Journal（append-only）─────────────────
  const ok: OkOutcome[] = [];
  const changed = new Set<string>();
  /** 这一批落进哪个/哪些 compound（gestureId 给定时用来置 settled）。 */
  const gestureCompounds = new Set<string>();
  for (let i = 0; i < commands.length; i++) {
    const o = outcomes[i];
    const cmd = resolved[i];
    if (o === null || o === undefined || o.kind !== 'ok' || cmd === null || cmd === undefined) {
      continue;
    }
    const committed = journal.commit({
      actor: deps.actor,
      command: cmd,
      applyCtx,
      ...(deps.turnId === undefined ? {} : { turnId: deps.turnId }),
      ...(deps.gestureId === undefined ? {} : { gestureId: deps.gestureId }),
    });
    // commit 会再应用一遍命令。预检已经用**同一份** applyCtx 应用过一次，
    // 所以这里理论上不可能失败；一旦失败说明两条路径的上下文/文档分叉了。
    // 以前这里只是 `continue` —— 命令会从 ok/errored/blocked 里同时消失，
    // 调用方只能看到一个空回执。宁可炸出来也不要静默丢命令。
    if (committed.kind !== 'committed') {
      throw new Error(
        '内部不一致：第 ' + i + ' 条命令（' + cmd.op + '）预检通过但提交失败：' +
          committed.error.code + ' ' + committed.error.message,
      );
    }
    for (const p of o.affectedPaths) changed.add(p);
    gestureCompounds.add(committed.operation.compoundId);
    ok.push({
      ...o,
      versionBefore: committed.operation.baseVersion,
      versionAfter: committed.operation.resultVersion,
      operationId: committed.operation.opId,
    });
  }

  /**
   * ★ 用户手势在【这一批提交完】就结束了 → 立刻置为 settled，它才是可撤销的。
   *
   *   journal 侧的原话是"用户手势与引擎自动修不经过 Runtime，由调用方显式 settle" ——
   *   而"由调用方"在过去几轮里的实际结果是**没有任何调用方做**，
   *   于是面板里用户改的每一样东西都停在"进行中"，撤销按钮永远是灰的。
   *   既然 gestureId 已经表达了"这是一次完整的手势"，置位就该由引擎一起做掉。
   */
  // ★ 只在【没有 turnId】时置位：turnId 的语义是"这一轮归 Runtime 管"，
  //   它的生命周期必须以 Runtime 的 settle 为准（Agent 一轮里可能提交好几批）。
  if (deps.gestureId !== undefined && deps.turnId === undefined) {
    for (const id of gestureCompounds) journal.settleCompound(id);
  }

  // ── 提交之后跑一次引擎自动修 ────────────────────────────────
  // 刻意放在【提交之后】：auto 类问题的判定依据是"当前文档"，
  // 而当前文档只有在 ok 部分落盘之后才成立。
  const autofixWanted = req.autoFix === undefined || req.autoFix.length > 0;
  const autofixed: AutofixRecord[] =
    autofixWanted && deps.autoFix !== undefined ? [...deps.autoFix()] : [];

  return {
    version: journal.currentVersion(),
    ok,
    proposals,
    blocked,
    errored,
    autofixed,
    changed: [...changed].sort(),
    issues: deps.issues?.() ?? EMPTY_ISSUES,
    budget: deps.budget(),
    ...(notices.length === 0 ? {} : { notices }),
  };
}

interface BuildProposalInput {
  readonly index: number;
  readonly cmd: Command;
  readonly paths: readonly string[];
  readonly doc: SceneDoc;
  readonly docVersion: number;
  readonly actor: Actor;
  readonly at: number;
}

/**
 * 生成提案。
 *
 * preconditions 由引擎推导，模型不能声明（规范 §8）：
 *   writeSet ∪ (readSet ∩ 同一 object 子树)
 * 本实现里 set_* 类命令的 readSet 就等于 writeSet（改前先读），
 * 因此 precondition 就是命中的那些写路径本身。
 */
function buildProposal(input: BuildProposalInput): Proposal {
  const { cmd, paths, doc, docVersion, actor, at, index } = input;
  const preconditions: Precondition[] = paths.map((path) => ({
    path,
    expected: resolveValue(doc, path),
    kind: 'value',
  }));
  const applied = applyCommand(doc, cmd, {});
  const first = paths[0] ?? '';

  // 画面变化：逐条列出这条提案会改动的路径从多少变成多少。
  // 刻意不做像素级描述 —— 那需要真的渲染一遍，而提案阶段不该烧预算。
  const changes: string[] = [];
  if (applied.kind === 'applied') {
    for (const p of paths) {
      const a = resolveValue(doc, p);
      const b = resolveValue(applied.doc, p);
      changes.push(p + '：' + JSON.stringify(a) + ' → ' + JSON.stringify(b));
    }
  }
  const reasonDetail = {
    currentValue: resolveValue(doc, first),
    targetValue: applied.kind === 'applied' ? resolveValue(applied.doc, first) : undefined,
    visualChange: changes.length === 0 ? '（无明显画面变化）' : changes.join('；'),
    rationale:
      typeof cmd.intent === 'string' && cmd.intent !== ''
        ? cmd.intent
        : '（模型没有说明理由）',
  };

  return {
    reasonDetail,
    // 确定性 id：同一个版本 + 同一个下标 → 同一个提案 id
    proposalId: 'p_' + docVersion + '_' + index,
    baseVersion: docVersion,
    target: first,
    before: resolveValue(doc, first),
    after: applied.kind === 'applied' ? resolveValue(applied.doc, first) : undefined,
    preconditions,
    reason: '命中 hard 锁（用户手动改过），需要用户同意: ' + paths.join(', '),
    state: 'pending',
    by: actor === 'agent' ? 'ai' : 'user',
    at,
    command: cmd,
    affectedPaths: [...paths],
  };
}