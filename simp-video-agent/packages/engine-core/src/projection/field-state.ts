/**
 * 三态可视（P9 第 3 条）：白点=静态值，蓝点=动画驱动，锁图标=锁定。
 *
 * 一个字段可以【同时】是动画驱动与被锁定（比如 AI 拥有但正在播动画），
 * 所以这里返回的是两个正交信息：
 *   state             主指示器（锁定优先）
 *   animationDriven   是否被动画驱动（面板据此画蓝点）
 * 面板因此能画出"蓝点 + 软锁图标"这种组合，而不是被迫二选一。
 */
import type { SceneDoc } from '../doc/types';
import { lockClassOf } from '../doc/types';

export type FieldVisualState = 'static' | 'animated' | 'locked-hard' | 'locked-soft';

export interface FieldState {
  readonly path: string;
  readonly state: FieldVisualState;
  readonly animationDriven: boolean;
  readonly locked: boolean;
  readonly lockedBy?: 'user' | 'ai';
  /** hard = 必须 request_patch；soft = 可直接改但要说明会覆盖动画 */
  readonly lockClass?: 'hard' | 'soft';
}

/** 轨道路径是 'objects.<id>.' 之后的部分；这里收的是对象相对形式 'plot#1.style.width'。 */
function animationDriven(doc: SceneDoc, path: string): boolean {
  const parts = path.split('.');
  const id = parts[0];
  if (id === undefined) return false;
  const obj = doc.objects[id];
  if (obj === undefined) return false;
  const track = parts.slice(1).join('.');
  return Object.prototype.hasOwnProperty.call(obj.anim, track);
}

export function resolveFieldState(doc: SceneDoc, path: string): FieldState {
  const entry = doc.locks[path];
  const animated = animationDriven(doc, path);

  if (entry === undefined) {
    return {
      path,
      state: animated ? 'animated' : 'static',
      animationDriven: animated,
      locked: false,
    };
  }

  const lockClass = lockClassOf(entry);
  return {
    path,
    state: lockClass === 'hard' ? 'locked-hard' : 'locked-soft',
    animationDriven: animated,
    locked: true,
    lockedBy: entry.by,
    lockClass,
  };
}

/** 批量解析，面板渲染一整组控件时用，避免逐个调用。 */
export function resolveFieldStates(
  doc: SceneDoc,
  paths: readonly string[],
): ReadonlyMap<string, FieldState> {
  const m = new Map<string, FieldState>();
  for (const p of paths) m.set(p, resolveFieldState(doc, p));
  return m;
}

/** 面板图例用：状态 → 视觉标记。文案集中在这里，不在面板里散落。 */
export const FIELD_STATE_LEGEND: Readonly<Record<FieldVisualState, string>> = {
  static: '静态值（白点）',
  animated: '动画驱动（蓝点）',
  'locked-hard': '用户锁定（实心锁图标）',
  'locked-soft': 'AI 拥有 · 可改但会覆盖动画（空心锁图标）',
};
