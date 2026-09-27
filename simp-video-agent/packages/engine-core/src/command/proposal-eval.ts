/**
 * 提案审批的三分支判定（规范 §8）。
 *
 *   版本 === baseVersion 且所有 precondition 成立          → approve
 *   版本 >  baseVersion 且本提案要写的那条路径没被别人写过，
 *                        且 precondition 成立               → fast-forward approve
 *   任一 precondition 不成立                                → stale
 *
 * stale 时【不执行】，并把每一条前提的 expected/actual 逐条回报给模型 ——
 * 这是让模型能自我纠正的唯一途径。
 */
import type { SceneDoc } from '../doc/types';
import { deepEqual, resolveValue } from '../doc/paths';
import type {
  PreconditionFailure,
  PreconditionFailureReason,
  Proposal,
  ProposalDecision,
} from './proposal';

export interface ProposalContext {
  readonly doc: SceneDoc;
  readonly currentVersion: number;
  /** baseVersion 之后被写过的路径（去重）。判定能否 fast-forward 用。 */
  readonly writtenSince: readonly string[];
}

function matches(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(path + '.') || path.startsWith(candidate + '.');
}

function checkPrecondition(
  path: string,
  expected: unknown,
  kind: Proposal['preconditions'][number]['kind'],
  doc: SceneDoc,
): PreconditionFailure | null {
  const actual = resolveValue(doc, path);
  if (kind === 'exists') {
    return actual === undefined
      ? { path, expected, actual, reason: 'missing' }
      : null;
  }
  if (kind === 'absent') {
    return actual === undefined
      ? null
      : { path, expected, actual, reason: 'unexpected' };
  }
  if (deepEqual(actual, expected)) return null;
  const reason: PreconditionFailureReason = actual === undefined ? 'missing' : 'value_changed';
  return { path, expected, actual, reason };
}

export function evaluateProposal(proposal: Proposal, ctx: ProposalContext): ProposalDecision {
  const failures: PreconditionFailure[] = [];
  for (const p of proposal.preconditions) {
    const failure = checkPrecondition(p.path, p.expected, p.kind, ctx.doc);
    if (failure !== null) failures.push(failure);
  }
  if (failures.length > 0) return { kind: 'stale', failures };

  if (ctx.currentVersion === proposal.baseVersion) return { kind: 'approve' };

  // 版本前进了：只有当本提案要写的路径没被别人碰过，才能快进
  const conflicts = ctx.writtenSince.filter((written) =>
    proposal.affectedPaths.some((mine) => matches(written, mine)),
  );
  if (conflicts.length > 0) {
    return {
      kind: 'stale',
      failures: conflicts.map((path) => ({
        path,
        expected: undefined,
        actual: resolveValue(ctx.doc, path),
        reason: 'value_changed' as const,
      })),
    };
  }
  return {
    kind: 'fast-forward',
    skippedPaths: ctx.writtenSince.filter(
      (written) => !proposal.affectedPaths.some((mine) => matches(written, mine)),
    ),
  };
}
