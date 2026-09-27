/**
 * 提案的生命周期（P10）。
 *
 * 引擎侧只负责【判定与记账】，怎么呈现是面板的事。这里回答四个问题：
 *   1. 同一 path 上同时只允许一个未决提案（P10 第 8 条）
 *   2. 审批时跑 precondition 的三分支（P10 第 4 条）
 *   3. stale / 拒绝 / 过期都要留下【能给模型读的回执】（P10 第 5、6、9 条）
 *   4. "改为手动设定"是第三种决策，不是拒绝（P10 第 7 条）
 */
import type { PreconditionFailure, Proposal, ProposalDecision } from './proposal';

/** 默认 10 分钟过期，AI 视为拒绝（P10 第 9 条）。 */
export const DEFAULT_PROPOSAL_TTL_MS = 10 * 60 * 1000;

export type DecisionKind =
  | 'approve'
  | 'reject'
  /** 认可方向但用用户手调的值（P10 第 7 条） */
  | 'override'
  | 'expired'
  /** 同一 path 上来了新提案，旧的作废 */
  | 'superseded';

export interface DecisionRecord {
  readonly proposalId: string;
  readonly target: string;
  readonly kind: DecisionKind;
  readonly at: number;
  /** 给模型读的一句话。拒绝与过期时这条尤其重要 —— 否则它会反复提同一个提案。 */
  readonly note: string;
  readonly overrideValue?: unknown;
  readonly staleFailures?: readonly PreconditionFailure[];
}

export type SubmitOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'superseded_previous'; readonly supersededId: string };

export interface ProposalStoreDeps {
  readonly now: () => number;
  readonly ttlMs?: number;
  /**
   * 审批时的三分支判定。由宿主注入 —— 它需要【当前文档】与"baseVersion 之后谁写过哪条路径"，
   * 这两样都不该由提案存储自己持有。
   */
  readonly evaluate: (proposal: Proposal) => ProposalDecision;
}

export interface ProposalStore {
  /** 提交。同一 path 上已有的未决提案会被作废（不是并存）。 */
  submit(proposal: Proposal): SubmitOutcome;
  pending(): readonly Proposal[];
  all(): readonly Proposal[];
  get(proposalId: string): Proposal | undefined;
  pendingForPath(path: string): Proposal | undefined;
  count(): number;
  /** 决策。approve 时返回判定结果，调用方据此决定是否执行命令。 */
  decide(
    proposalId: string,
    kind: 'approve' | 'reject' | 'override',
    opts?: { readonly value?: unknown },
  ): { readonly record: DecisionRecord; readonly decision?: ProposalDecision } | null;
  /** 扫描过期。返回这一轮作废掉的提案记录。 */
  sweep(): readonly DecisionRecord[];
  /** 回灌给模型的决策历史（新的在后）。 */
  feedback(): readonly DecisionRecord[];
  /** 面板用：清掉已决的，保留历史 */
  clearDecided(): void;
}

export function createProposalStore(deps: ProposalStoreDeps): ProposalStore {
  const ttl = deps.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const proposals = new Map<string, Proposal>();
  const order: string[] = [];
  const decisions: DecisionRecord[] = [];

  function record(r: DecisionRecord): void {
    decisions.push(r);
    const p = proposals.get(r.proposalId);
    if (p !== undefined) {
      proposals.set(r.proposalId, {
        ...p,
        state:
          r.kind === 'approve'
            ? 'approved'
            : r.kind === 'expired' || r.kind === 'reject'
              ? 'rejected'
              : 'superseded',
      });
    }
  }

  function isPending(p: Proposal): boolean {
    return p.state === 'pending';
  }

  return {
    submit(proposal: Proposal): SubmitOutcome {
      // ★ 同一 path 只能有一个未决提案
      const prev = [...proposals.values()].find((p) => p.target === proposal.target && isPending(p));
      proposals.set(proposal.proposalId, proposal);
      order.push(proposal.proposalId);
      if (prev === undefined) return { kind: 'accepted' };
      record({
        proposalId: prev.proposalId,
        target: prev.target,
        kind: 'superseded',
        at: deps.now(),
        note: '同一路径上出现了更新的提案，这条作废。',
      });
      return { kind: 'superseded_previous', supersededId: prev.proposalId };
    },

    pending: () => order.map((id) => proposals.get(id)).filter((p): p is Proposal => p !== undefined && isPending(p)),
    all: () => order.map((id) => proposals.get(id)).filter((p): p is Proposal => p !== undefined),
    get: (id) => proposals.get(id),
    pendingForPath: (path) =>
      [...proposals.values()].find((p) => p.target === path && isPending(p)),
    count: () => [...proposals.values()].filter(isPending).length,

    decide(proposalId, kind, opts) {
      const p = proposals.get(proposalId);
      if (p === undefined || !isPending(p)) return null;

      if (kind === 'reject') {
        const r: DecisionRecord = {
          proposalId,
          target: p.target,
          kind: 'reject',
          at: deps.now(),
          note:
            (opts?.value === undefined ? '' : String(opts.value) + ' ') +
            '用户拒绝了这条提案。不要再提同样的改动，除非你掌握了新的信息。',
        };
        record(r);
        return { record: r };
      }

      if (kind === 'override') {
        const r: DecisionRecord = {
          proposalId,
          target: p.target,
          kind: 'override',
          at: deps.now(),
          note:
            '方向被认可，但最终值由用户手定为 ' + String(opts?.value) + '（原提案目标是 ' + String(p.after) + '）。' +
            '按用户的值执行，不要改回去。',
          overrideValue: opts?.value,
        };
        record(r);
        return { record: r };
      }

      // approve：先跑三分支
      const decision = deps.evaluate(p);
      if (decision.kind === 'stale') {
        const r: DecisionRecord = {
          proposalId,
          target: p.target,
          kind: 'reject',
          at: deps.now(),
          note:
            'precondition 失效，提案作废：' +
            decision.failures
              .map((f) => f.path + ' 期望 ' + JSON.stringify(f.expected) + '，实际 ' + JSON.stringify(f.actual))
              .join('；'),
          staleFailures: decision.failures,
        };
        record(r);
        return { record: r, decision };
      }
      const r: DecisionRecord = {
        proposalId,
        target: p.target,
        kind: 'approve',
        at: deps.now(),
        note: decision.kind === 'approve' ? '已批准。' : '已快进批准（版本前进了，但本提案要写的那条路径没被别人碰过）。',
      };
      record(r);
      return { record: r, decision };
    },

    sweep() {
      const now = deps.now();
      const out: DecisionRecord[] = [];
      for (const p of proposals.values()) {
        if (!isPending(p)) continue;
        if (now - p.at < ttl) continue;
        const r: DecisionRecord = {
          proposalId: p.proposalId,
          target: p.target,
          kind: 'expired',
          at: now,
          note: '提案超过 ' + Math.round(ttl / 60000) + ' 分钟未决，已自动过期，视为拒绝。',
        };
        record(r);
        out.push(r);
      }
      return out;
    },

    feedback: () => decisions,
    clearDecided() {
      for (const [id, p] of proposals) {
        if (!isPending(p)) proposals.delete(id);
      }
    },
  };
}
