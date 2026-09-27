/**
 * 写权限（规范 §11 / P12）。
 *
 * owner.kind 决定谁能写：
 *   scene   该镜的 Agent 可写，且时间必须落在本镜 [start, end] 内
 *   global  只有导演可写
 *   shared  只有导演可写【本体】；场景 Agent 只能 link_shared 加窗口
 *
 * "谁"由 Scope 表示。导演是默认视角（不传 scope），场景 Agent 必须带上自己的 sceneId。
 */
import type { ObjectId, SceneDoc, SceneObject } from './types';

export interface SceneScope {
  readonly kind: 'scene';
  readonly sceneId: string;
  readonly start: number;
  readonly end: number;
}

export type Scope = SceneScope | { readonly kind: 'director' };

export type DenyReason =
  | 'global_owned'
  | 'shared_body'
  | 'other_scene'
  | 'outside_scene_window'
  | 'unknown_object';

export type WriteVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenyReason; readonly message: string };

export function canWrite(
  doc: SceneDoc,
  scope: Scope,
  objectId: ObjectId,
  t?: number,
): WriteVerdict {
  const obj: SceneObject | undefined = doc.objects[objectId];
  if (obj === undefined) {
    return { allowed: false, reason: 'unknown_object', message: '对象不存在: ' + objectId };
  }
  if (scope.kind === 'director') return { allowed: true };

  if (obj.owner.kind === 'global') {
    return {
      allowed: false,
      reason: 'global_owned',
      message: objectId + ' 是 global 对象，只有导演可写。跨镜改动请走 retime。',
    };
  }
  if (obj.owner.kind === 'shared') {
    return {
      allowed: false,
      reason: 'shared_body',
      message: objectId + ' 是 shared 对象，本体只有导演可写；你只能 link_shared 追加使用窗口。',
    };
  }
  if (obj.owner.sceneId !== scope.sceneId) {
    return {
      allowed: false,
      reason: 'other_scene',
      message: objectId + ' 属于镜头 ' + obj.owner.sceneId + '，不属于 ' + scope.sceneId + '。',
    };
  }
  if (t !== undefined && (t < scope.start || t > scope.end)) {
    return {
      allowed: false,
      reason: 'outside_scene_window',
      message: 't=' + t + ' 落在本镜 [' + scope.start + ', ' + scope.end + '] 之外。',
    };
  }
  return { allowed: true };
}

/** 场景 Agent 是否可以追加共享窗口（本体一律不可写）。 */
export function canLinkShared(scope: Scope): WriteVerdict {
  if (scope.kind === 'director') return { allowed: true };
  return { allowed: true }; // 场景 Agent 可加窗口 —— 这正是 link_shared 的存在意义
}
