/**
 * get_lock_details(paths[]) —— 只在准备 request_patch 时调。
 *
 * 刻意【没有】get_locks()：锁路径已经在 get_scene_summary() 里了。
 * 再开一个列举接口只会诱导模型先列一遍再决定，白白烧 token。
 * 这个接口回答的是另一个问题："我打算改这几条路径，各自会被什么挡住？"
 *
 * 规范 §8 的锁分类：
 *   hard  用户手动改过 → 必须 request_patch + 用户同意
 *   soft  AI 仍拥有 → AI 可改，但如果当前是动画驱动，必须说明"会覆盖动画"
 */
import type { LockClass, SceneDoc } from '../doc/types';
import { lockClassOf } from '../doc/types';
import { unwrapField } from '../doc/fields';

export interface LockDetail {
  readonly path: string;
  readonly locked: boolean;
  readonly by?: 'user' | 'ai';
  /** 墙上时钟毫秒时间戳，仅用于展示 */
  readonly at?: number;
  /** hard = 必须 request_patch；soft = 可直接改但要说明 */
  readonly class?: LockClass;
  /** 该路径当前是否被动画轨道驱动（soft 锁真正要提示的东西） */
  readonly animationDriven?: boolean;
  readonly currentValue?: unknown;
  /** 路径在文档里解析不到时的说明 */
  readonly error?: string;
}

/**
 * 路径解析实现已上移到 doc/paths.ts —— 命令层与日志层都要用它，
 * 挂在投影层下会造成 journal -> projection 的反向依赖。
 * 这里保留再导出，是为了不让 P3 的调用方被迫改 import。
 */
import { resolvePath } from '../doc/paths';

export { resolvePath, walk } from '../doc/paths';

/** 该对象的某个轨道路径上是否存在动画轨道（轨道名用对象相对形式，如 'style.width'）。 */
function isAnimationDriven(doc: SceneDoc, path: string): boolean {
  const parts = path.split('.');
  if (parts.length < 2) return false;
  const id = parts[0];
  if (id === undefined) return false;
  const obj = doc.objects[id];
  if (obj === undefined) return false;
  const track = parts.slice(1).join('.');
  return Object.prototype.hasOwnProperty.call(obj.anim, track);
}

export function getLockDetails(doc: SceneDoc, paths: readonly string[]): readonly LockDetail[] {
  return paths.map((path) => {
    const entry = doc.locks[path];
    const resolved = resolvePath(doc, path);
    const current = resolved.found ? unwrapField(resolved.value) : undefined;

    const common: {
      path: string;
      locked: boolean;
      animationDriven: boolean;
      currentValue?: unknown;
      error?: string;
    } = {
      path,
      locked: entry !== undefined,
      animationDriven: isAnimationDriven(doc, path),
    };
    if (resolved.found && current !== undefined) common.currentValue = current;
    if (!resolved.found) common.error = '路径在文档里不存在';

    if (entry === undefined) return common;

    const withLock = {
      ...common,
      by: entry.by,
      at: entry.at,
      class: lockClassOf(entry),
    };
    return withLock;
  });
}
