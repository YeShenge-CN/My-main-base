/**
 * 校验与 Issue（规范 §9）。
 *
 * fixClass 的语义（规范原文）：
 *   auto   修复唯一确定、无美学判断 → 引擎可直接执行
 *          （id 冲突改名、表达式编译兜底、NaN 剔除、超预算夹紧、采样提升）
 *   agent  需要视觉/叙事判断 → Agent 看图后决定（文字重叠、主体被遮挡、构图偏）
 *   human  涉及用户意图 → 只报告，绝不自动改
 *
 * ★ 硬规则：fixClass 为 agent 或 human 的 Issue，即使带 suggestedFix，
 *   也【不得】在 autoFix 路径执行。这条有断言测试守着，不是靠自觉。
 */
import type { Command } from '../command/commands';
import type { ValidatorGroup } from '../command/results';

export type { ValidatorGroup };

export type Severity = 'error' | 'warn' | 'info';
export type FixClass = 'auto' | 'agent' | 'human';

export interface Issue {
  readonly severity: Severity;
  readonly group: ValidatorGroup;
  readonly code: string;
  readonly path: string;
  /** 时间点（与时间有关的检查才有） */
  readonly at?: number;
  readonly message: string;
  readonly fixClass: FixClass;
  /**
   * 建议的修复命令。fixClass 为 auto 时可被 autoFix 直接执行；
   * 为 agent / human 时它只是"给人看的建议"，永远不进自动路径。
   */
  readonly suggestedFix?: readonly Command[];
}

/** 允许走自动修的分组（规范 P7 清单第 4 条）。layout 不在其中 —— 它需要视觉判断。 */
export const AUTO_FIX_GROUPS: readonly ValidatorGroup[] = [
  'environment',
  'semantic',
  'motion',
  'export',
];

/** 比 command/results 里的 IssueCounts 更细：多了按严重度与 fixClass 的分组。 */
export interface IssueSummary {
  readonly total: number;
  readonly byGroup: Readonly<Partial<Record<ValidatorGroup, number>>>;
  readonly bySeverity: Readonly<Partial<Record<Severity, number>>>;
  readonly byFixClass: Readonly<Partial<Record<FixClass, number>>>;
}

export function summarizeIssues(issues: readonly Issue[]): IssueSummary {
  const byGroup: Partial<Record<ValidatorGroup, number>> = {};
  const bySeverity: Partial<Record<Severity, number>> = {};
  const byFixClass: Partial<Record<FixClass, number>> = {};
  for (const issue of issues) {
    byGroup[issue.group] = (byGroup[issue.group] ?? 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    byFixClass[issue.fixClass] = (byFixClass[issue.fixClass] ?? 0) + 1;
  }
  return { total: issues.length, byGroup, bySeverity, byFixClass };
}
