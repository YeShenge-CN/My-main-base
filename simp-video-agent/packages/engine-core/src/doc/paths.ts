/**
 * 文档内路径的解析。整个仓库只在这里定义一次。
 *
 * 支持三种写法（都合法）：
 *   "meta.duration"                  文档根路径
 *   "plot#1.style.width"             对象相对路径（锁键与动画轨道路径用这种）
 *   "objects.plot#1.style.width.v"   完整路径
 * 约定：id 里不允许出现 '.'（'plot#1'、'eff#3' 都合规），所以按 '.' 切分是安全的。
 */
import type { SceneDoc } from './types';
import { unwrapField } from './fields';

/** 从任意根出发按点分路径取值。 */
export function walk(root: unknown, path: string): { found: boolean; value?: unknown } {
  if (path === '') return { found: true, value: root };
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (cursor === null || cursor === undefined) return { found: false };
    if (typeof cursor !== 'object') return { found: false };
    const rec = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, part)) return { found: false };
    cursor = rec[part];
  }
  return { found: true, value: cursor };
}

export function resolvePath(doc: SceneDoc, path: string): { found: boolean; value?: unknown } {
  const direct = walk(doc, path);
  if (direct.found) return direct;
  const parts = path.split('.');
  const id = parts[0];
  if (id === undefined) return { found: false };

  /**
   * 镜头相对：'scenes.s#2.name'。
   *
   * ★ 形式是 `scenes.<sceneId>.<字段>`，注意【第一段是 'scenes' 而不是 id】——
   *   这一点与对象/效果相对路径不同，别照着下面两个分支的样子写。
   *
   * 为什么必须有这个分支：scenes 是【数组】而不是 Record，walk() 只认自有属性，
   * 到不了里面。没有它的话 set_scene / remove_scene 产出的 patch 路径全部解析不到，
   * 而症状是静默的 —— replay 取补偿值拿到 undefined、precondition 检测失效，
   * 撤销"看起来成功"却什么都没还原。
   */
  if (id === 'scenes') {
    const sceneId = parts[1];
    if (sceneId === undefined) return direct; // 'scenes' 本身已由 walk 处理
    if (Array.isArray(doc.scenes)) {
      const scene = doc.scenes.find((s) => s.id === sceneId);
      if (scene !== undefined) return walk(scene, parts.slice(2).join('.'));
    }
    return { found: false };
  }

  // 对象相对：'plot#1.style.width'
  if (doc.objects[id] !== undefined) {
    return walk(doc.objects[id], parts.slice(1).join('.'));
  }
  // 效果相对：'eff#3.params.duration'
  if (doc.effects[id] !== undefined) {
    return walk(doc.effects[id], parts.slice(1).join('.'));
  }
  return { found: false };
}

/** 解析并解包成裸值。路径不存在时返回 undefined。 */
export function resolveValue(doc: SceneDoc, path: string): unknown {
  const r = resolvePath(doc, path);
  if (!r.found) return undefined;
  return unwrapField(r.value);
}

/** 深比较。revert 的 precondition 检测用它。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
