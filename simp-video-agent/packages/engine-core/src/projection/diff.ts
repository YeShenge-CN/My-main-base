/**
 * get_diff(fromVersion, toVersion)。
 *
 * 引擎侧的 diff 有两个来源：
 *  1. 【结构 diff】直接比较两份 Scene Doc 快照 —— 本文件实现，自足可测；
 *  2. 【操作 diff】P5 的 Operation Journal 记录的 affectedPaths —— 更省，且能带上 intent。
 *
 * 这里把两条路合并成一个接口：getDiff 接受一个 SnapshotSource，
 * P5 落地后它会由 Journal + 版本快照实现。在它存在之前，
 * diffDocs 已经能独立工作（比如对比"AI 改之前"和"AI 改之后"）。
 */
import type { SceneDoc } from '../doc/types';

export type DiffChange = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** 文档内的点分路径，如 objects.plot#1.style.width */
  readonly path: string;
  readonly change: DiffChange;
  readonly from?: unknown;
  readonly to?: unknown;
}

export interface DocDiff {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly entries: readonly DiffEntry[];
  /** 因为 maxEntries 被省掉的条目数 */
  readonly truncated?: number;
}

export interface DiffOptions {
  readonly maxEntries?: number;
  /** 要忽略的路径前缀，默认忽略 docVersion（它只是个计数器） */
  readonly ignorePaths?: readonly string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function leafPaths(
  a: unknown,
  b: unknown,
  prefix: string,
  out: DiffEntry[],
  ignore: readonly string[],
): void {
  if (ignore.some((p) => prefix === p || prefix.startsWith(p + '.'))) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      leafPaths(a[key], b[key], prefix === '' ? key : prefix + '.' + key, out, ignore);
    }
    return;
  }

  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) return;

  if (a === undefined) {
    out.push({ path: prefix, change: 'added', to: b });
  } else if (b === undefined) {
    out.push({ path: prefix, change: 'removed', from: a });
  } else {
    out.push({ path: prefix, change: 'changed', from: a, to: b });
  }
}

export function diffDocs(from: SceneDoc, to: SceneDoc, opts: DiffOptions = {}): DocDiff {
  const ignore = opts.ignorePaths ?? ['docVersion'];
  const entries: DiffEntry[] = [];
  leafPaths(from, to, '', entries, ignore);
  const max = opts.maxEntries ?? 200;
  const base = { fromVersion: from.docVersion, toVersion: to.docVersion };
  if (entries.length <= max) return { ...base, entries };
  return { ...base, entries: entries.slice(0, max), truncated: entries.length - max };
}

export interface SnapshotSource {
  /** 取某个版本的文档快照；没有就返回 undefined。 */
  get(version: number): SceneDoc | undefined;
}

export function getDiff(
  source: SnapshotSource,
  fromVersion: number,
  toVersion: number,
  opts: DiffOptions = {},
): DocDiff | null {
  const from = source.get(fromVersion);
  const to = source.get(toVersion);
  if (from === undefined || to === undefined) return null;
  return diffDocs(from, to, opts);
}
