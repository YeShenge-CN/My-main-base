/**
 * 锁的推导（规范 §8 / §11）。
 *
 * ★ 在这个文件之前，doc.locks 是【只读】的：全仓库没有任何命令、也没有任何代码
 *   写过它。锁判定（batch.ts）读它、投影读它、面板读它，而它只能靠夹具预置。
 *   于是"用户手动改过 → hard 锁"这条链路在真实运行里从未发生过 ——
 *   压力测试里的 hard 锁全是测试自己塞进去的。
 *
 * ── 设计决定（需要拍板，写在最前面）────────────────────────────
 * 谁写：由【actor】决定，而不是由模型或用户显式声明。
 *   用户改过的字段 → by:'user' → lockClassOf → 'hard'（AI 必须先问）
 *   Agent 改过的字段 → 不自动加锁（它本来就随时可改；soft 锁是"AI 拥有"的标记，
 *     由未来的"归属"功能显式设置，不由每次编辑隐式产生）
 *   引擎自动修 → 不加锁（修的是引擎自己判定为无需判断的问题）
 * 为什么不让模型写锁：锁是【权限状态】。允许被授权方声明授权状态，
 * 等于把信任边界（不变量 4）开一个洞 —— 模型可以给自己解锁。
 *
 * 粒度：字段级（'plot#1.style.width'），与 doc.locks 的键完全一致，
 * 也与 writeSetOf / affectedPaths 的粒度一致。
 *
 * 何时加：在【写路径】上加，即 Journal.commit。这样只有一个地方会改 locks，
 * 而且它天然能记 actor。revert 一个 compound 时对应地摘掉这些锁
 * （否则撤销之后字段还是锁着的，用户会以为是 bug）。
 */
import type { LockEntry, SceneDoc } from '../doc/types';
import type { Actor } from '../journal/types';

/** 锁的合并结果。 */
export interface LockMerge {
  readonly doc: SceneDoc;
  /** 这次新加的锁（用于回执与测试）。 */
  readonly added: readonly string[];
}

/**
 * 某个 actor 写过这些路径之后，locks 应该变成什么样。
 *
 * 只对 user 产生锁；其余 actor 原样返回（连对象都不重建，保持结构共享）。
 */
export function mergeLocksForActor(
  doc: SceneDoc,
  actor: Actor,
  paths: readonly string[],
  at: number,
): LockMerge {
  if (actor !== 'user' || paths.length === 0) return { doc, added: [] };

  const locks: Record<string, LockEntry> = { ...doc.locks };
  const added: string[] = [];
  for (const path of paths) {
    if (path === '') continue;
    const existing = locks[path];
    // 已经是用户的锁就不动它（保留最初的 at —— 那是"用户什么时候开始拥有它"）
    if (existing !== undefined && existing.by === 'user') continue;
    locks[path] = { by: 'user', at };
    added.push(path);
  }
  if (added.length === 0) return { doc, added: [] };
  return { doc: { ...doc, locks }, added };
}

/**
 * 摘掉这些路径上的锁。
 *
 * 用在 revert：撤销一次用户编辑之后，那条路径不该还锁着。
 * 刻意只摘 by:'user' 的 —— 别的来源的锁不该被撤销动作顺手抹掉。
 */
export function dropUserLocks(doc: SceneDoc, paths: readonly string[]): SceneDoc {
  let changed = false;
  const locks: Record<string, LockEntry> = { ...doc.locks };
  for (const path of paths) {
    const entry = locks[path];
    if (entry === undefined || entry.by !== 'user') continue;
    delete locks[path];
    changed = true;
  }
  return changed ? { ...doc, locks } : doc;
}
