/**
 * validate() 聚合器 与 autoFix() 自动修（规范 §9 / P7 清单）。
 *
 * ★ 硬规则：fixClass 为 agent 或 human 的 Issue，即使带 suggestedFix，
 *   也【不得】在 autoFix 路径执行。这条在这里被两道锁守着：
 *     1. planAutoFix 只收 fixClass === 'auto' 且 group ∈ AUTO_FIX_GROUPS 的；
 *     2. 提交之前再按"来源 Issue"复核一遍，不一致直接抛 —— 宁可炸，不可默默改错东西。
 */
import type { SceneDoc } from '../doc/types';
import type { Journal } from '../journal/store';
import type { Actor } from '../journal/types';
import { applyCommands } from '../command/batch';
import type { AutofixRecord, BudgetState, ValidatorGroup } from '../command/results';
import type { Command } from '../command/commands';
import { ALL_GROUPS, VALIDATORS } from './validators';
import {
  AUTO_FIX_GROUPS,
  summarizeIssues,
  type FixClass,
  type Issue,
  type IssueSummary,
} from './types';

export * from './types';
export * from './validators';

export interface ValidateOptions {
  readonly groups?: readonly ValidatorGroup[];
}

/** validate(scope?) 是聚合器，可按 group 调用。 */
export function validate(doc: SceneDoc, opts: ValidateOptions = {}): readonly Issue[] {
  const groups = opts.groups ?? ALL_GROUPS;
  const out: Issue[] = [];
  for (const group of groups) {
    const fn = VALIDATORS[group];
    if (fn === undefined) continue;
    out.push(...fn(doc));
  }
  out.sort((a, b) => {
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return out;
}

/* ══════════════════ 自动修 ══════════════════ */

export type AutoFixSkipReason =
  | 'fix_class_not_auto'
  | 'group_not_autofixable'
  | 'no_suggested_fix';

export interface AutoFixSkip {
  readonly path: string;
  readonly code: string;
  readonly fixClass: FixClass;
  readonly reason: AutoFixSkipReason;
}

export interface AutoFixPlan {
  readonly commands: readonly Command[];
  readonly provenance: ReadonlyMap<Command, Issue>;
  readonly skipped: readonly AutoFixSkip[];
}

/**
 * 纯函数：从 Issue 列表里挑出【可以自动执行】的修复命令。
 * 被跳过的每一条都带原因，不会被静默忽略。
 */
export function planAutoFix(issues: readonly Issue[]): AutoFixPlan {
  const commands: Command[] = [];
  const provenance = new Map<Command, Issue>();
  const skipped: AutoFixSkip[] = [];

  for (const issue of issues) {
    if (issue.fixClass !== 'auto') {
      skipped.push({ path: issue.path, code: issue.code, fixClass: issue.fixClass, reason: 'fix_class_not_auto' });
      continue;
    }
    if (!AUTO_FIX_GROUPS.includes(issue.group)) {
      skipped.push({ path: issue.path, code: issue.code, fixClass: issue.fixClass, reason: 'group_not_autofixable' });
      continue;
    }
    if (issue.suggestedFix === undefined || issue.suggestedFix.length === 0) {
      skipped.push({ path: issue.path, code: issue.code, fixClass: issue.fixClass, reason: 'no_suggested_fix' });
      continue;
    }
    for (const cmd of issue.suggestedFix) {
      commands.push(cmd);
      provenance.set(cmd, issue);
    }
  }
  return { commands, provenance, skipped };
}

export interface AutoFixOptions {
  readonly journal: Journal;
  readonly now: () => number;
  readonly actor?: Actor;
  readonly maxRounds?: number;
  readonly groups?: readonly ValidatorGroup[];
  readonly budget?: () => BudgetState;
}

export interface AutoFixResult {
  readonly fixed: readonly AutofixRecord[];
  readonly skipped: readonly AutoFixSkip[];
  readonly rounds: number;
  /** 收工时的剩余问题数。auto 类应当为 0；agent / human 类会留着。 */
  readonly issues: IssueSummary;
  readonly doc: SceneDoc;
  readonly version: number;
}

const EMPTY_BUDGET: BudgetState = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

/**
 * 引擎一键批量提交全部 auto 类修复，不经过 LLM。
 *
 * 循环：validate → 挑 auto → apply_commands → 再 validate，直到没有 auto 类问题，
 * 或者某一轮没有产生任何改动（防死循环）。
 */
export function autoFix(opts: AutoFixOptions): AutoFixResult {
  const journal = opts.journal;
  const maxRounds = opts.maxRounds ?? 8;
  const validateOpts: ValidateOptions = opts.groups === undefined ? {} : { groups: opts.groups };

  const fixed: AutofixRecord[] = [];
  const skipped: AutoFixSkip[] = [];
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const issues = validate(journal.currentDoc(), validateOpts);
    const plan = planAutoFix(issues);
    for (const s of plan.skipped) {
      if (!skipped.some((x) => x.path === s.path && x.code === s.code)) skipped.push(s);
    }
    if (plan.commands.length === 0) break;

    // ★ 提交前的第二道锁：按来源 Issue 复核。
    for (const cmd of plan.commands) {
      const source = plan.provenance.get(cmd);
      if (source === undefined || source.fixClass !== 'auto' || !AUTO_FIX_GROUPS.includes(source.group)) {
        throw new Error(
          'autoFix 路径上出现了非 auto 的修复（' +
            (source === undefined ? '来源未知' : source.code + '/' + source.fixClass) +
            '），拒绝执行。',
        );
      }
    }

    const before = journal.currentVersion();
    const res = applyCommands(
      { baseVersion: before, commands: plan.commands },
      {
        journal,
        budget: opts.budget ?? (() => EMPTY_BUDGET),
        actor: opts.actor ?? 'engine-autofix',
        now: opts.now,
      },
    );

    for (let i = 0; i < plan.commands.length; i++) {
      const cmd = plan.commands[i];
      const okOutcome = res.ok.find((o) => o.index === i);
      if (cmd === undefined || okOutcome === undefined) continue;
      const source = plan.provenance.get(cmd);
      fixed.push({
        path: source?.path ?? '',
        code: source?.code ?? '',
        from: undefined,
        to: okOutcome.affectedPaths,
        index: i,
      });
    }

    // 没有任何提交成功 → 再循环也不会变，直接停，避免死转
    if (res.ok.length === 0) break;
  }

  const doc = journal.currentDoc();
  return {
    fixed,
    skipped,
    rounds,
    issues: summarizeIssues(validate(doc, validateOpts)),
    doc,
    version: journal.currentVersion(),
  };
}
