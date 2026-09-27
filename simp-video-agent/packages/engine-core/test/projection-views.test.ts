import { describe, expect, it } from 'vitest';
import { getCamera, getEffect, getMarkers, getTimeline } from '../src/projection/timeline';
import { diffDocs, getDiff, type SnapshotSource } from '../src/projection/diff';
import { getLockDetails, resolvePath } from '../src/projection/locks';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc, type MakeDocOptions } from './fixtures';

function sampleDoc(opts: MakeDocOptions = {}): SceneDoc {
  const doc = makeDoc(3, { effectsPerObject: 1, ...opts });
  const plot1 = doc.objects['plot#1'];
  if (plot1 === undefined) throw new Error('fixture 缺 plot#1');
  return {
    ...doc,
    markers: [
      { id: 'intro', t: 0 },
      { id: 'peak', t: 3 },
    ],
    camera: {
      keys: [
        { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] },
        { t: 6, tx: 2, ty: 0, scale: 1.8, rotate: 0, pivot: [0, 0], ease: 'easeInOutCubic' },
      ],
    },
    objects: {
      ...doc.objects,
      'plot#1': {
        ...plot1,
        anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 0.6, v: 1 }] } },
      },
    },
  };
}

describe('get_timeline', () => {
  it('把对象 / 效果 / 标记 / 相机 / 动画键摊平成一条按时间排序的事件流', () => {
    const events = getTimeline(sampleDoc());
    const times = events.map((e) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toContain('object');
    expect(kinds).toContain('effect');
    expect(kinds).toContain('marker');
    expect(kinds).toContain('camera');
    expect(kinds).toContain('anim');
  });

  it('kinds 过滤', () => {
    const events = getTimeline(sampleDoc(), { kinds: ['marker'] });
    expect(events.length).toBe(2);
    for (const e of events) expect(e.kind).toBe('marker');
  });

  it('时间区间过滤保留"跨越该区间"的事件', () => {
    const events = getTimeline(sampleDoc(), { from: 5, to: 6 });
    // 对象时间窗是 [0,12]，仍然覆盖 [5,6]，必须保留
    expect(events.some((e) => e.kind === 'object')).toBe(true);
    // 相机关键帧只在 t=6
    expect(events.filter((e) => e.kind === 'camera').map((e) => e.t)).toEqual([6]);
  });

  it('maxEvents 截断', () => {
    expect(getTimeline(sampleDoc(), { maxEvents: 2 }).length).toBe(2);
  });

  it('效果事件带 [start, end] 且 detail 写明 type -> target', () => {
    const events = getTimeline(sampleDoc(), { kinds: ['effect'] });
    expect(events[0]?.t).toBe(0.8);
    expect(events[0]?.end).toBe(3);
    expect(events[0]?.detail).toBe('drawOn -> plot#1');
  });
});

describe('get_effect', () => {
  it('返回参数裸值、时间区间与引用完整性', () => {
    const eff = getEffect(sampleDoc(), 'eff#1');
    expect(eff).not.toBeNull();
    expect(eff?.type).toBe('drawOn');
    expect(eff?.target).toBe('plot#1');
    expect(eff?.params['mode']).toBe('arc');
    expect(eff?.range).toEqual([0.8, 3]);
    expect(eff?.targetExists).toBe(true);
  });

  it('悬空引用会被如实报出（targetExists=false）', () => {
    const doc = sampleDoc();
    const dangling = { ...doc, effects: { ...doc.effects, 'eff#9': { type: 'fade', target: 'ghost#1', params: {} } } };
    expect(getEffect(dangling, 'eff#9')?.targetExists).toBe(false);
  });

  it('同一个目标上的多个效果互相可见（重叠发光这类坑）', () => {
    const doc = sampleDoc();
    const added = {
      ...doc,
      effects: { ...doc.effects, 'eff#9': { type: 'fade', target: 'plot#1', params: {} } },
    };
    expect(getEffect(added, 'eff#1')?.sharesTargetWith).toEqual(['eff#9']);
  });

  it('未知 id 返回 null', () => {
    expect(getEffect(sampleDoc(), 'nope')).toBeNull();
  });
});

describe('get_camera', () => {
  it('给出关键帧、镜头数与运动概览', () => {
    const cam = getCamera(sampleDoc());
    expect(cam.shots).toBe(2);
    expect(cam.keys.length).toBe(2);
    expect(cam.scaleMin).toBe(1);
    expect(cam.scaleMax).toBe(1.8);
    expect(cam.moves).toBe(true);
  });

  it('range 过滤关键帧，但概览仍基于全部关键帧', () => {
    const cam = getCamera(sampleDoc(), { from: 5, to: 7 });
    expect(cam.keys.length).toBe(1);
    expect(cam.shots).toBe(2);
    expect(cam.scaleMax).toBe(1.8);
  });

  it('给 at 时附带该时刻采样出来的相机状态', () => {
    const cam = getCamera(sampleDoc(), { at: 3 });
    expect(cam.sampled?.scale).toBeCloseTo(1.4, 9);
    expect(cam.sampled?.tx).toBeCloseTo(1, 9);
    expect(getCamera(sampleDoc()).sampled).toBeUndefined();
  });

  it('静止镜头 moves=false', () => {
    expect(getCamera(makeDoc(1)).moves).toBe(false);
  });
});

describe('get_markers', () => {
  it('标记 + 是否与相机关键帧同刻', () => {
    const markers = getMarkers(sampleDoc());
    expect(markers.map((m) => m.id)).toEqual(['intro', 'peak']);
    expect(markers[0]?.atCameraKey).toBe(true);
    expect(markers[1]?.atCameraKey).toBe(false);
  });
});

describe('get_diff', () => {
  const before = makeDoc(2);
  const p1 = before.objects['plot#1'];
  if (p1 === undefined) throw new Error('fixture 缺 plot#1');
  const after: SceneDoc = {
    ...before,
    docVersion: 1,
    objects: {
      ...before.objects,
      'plot#1': { ...p1, tf: { ...p1.tf, opacity: 0.25 } },
    },
  };

  it('结构 diff 精确定位到叶子路径', () => {
    const d = diffDocs(before, after);
    expect(d.entries.map((e) => e.path)).toEqual(['objects.plot#1.tf.opacity']);
    expect(d.entries[0]?.from).toBe(1);
    expect(d.entries[0]?.to).toBe(0.25);
    expect(d.entries[0]?.change).toBe('changed');
  });

  it('docVersion 这个纯计数器被忽略', () => {
    expect(diffDocs(before, after).entries.some((e) => e.path === 'docVersion')).toBe(false);
  });

  it('新增与删除分别标记', () => {
    const added = { ...before, objects: { ...before.objects, 'plot#9': { ...p1 } } };
    expect(diffDocs(before, added).entries.find((e) => e.path === 'objects.plot#9')?.change).toBe(
      'added',
    );

    const { 'plot#2': dropped, ...restObjects } = before.objects;
    expect(dropped).toBeDefined();
    const removed = { ...before, objects: restObjects };
    expect(diffDocs(before, removed).entries.find((e) => e.path === 'objects.plot#2')?.change).toBe(
      'removed',
    );

    // 数组整体变化算 changed（空数组是"已定义的值"，不是缺失）
    const emptied = { ...before, markers: [] };
    expect(diffDocs(before, emptied).entries.find((e) => e.path === 'markers')?.change).toBe(
      'changed',
    );
  });

  it('相同文档没有条目', () => {
    expect(diffDocs(before, before).entries).toEqual([]);
  });

  it('maxEntries 截断并如实报数', () => {
    const d = diffDocs(before, after, { maxEntries: 0 });
    expect(d.entries).toEqual([]);
    expect(d.truncated).toBe(1);
  });

  it('get_diff 从版本快照取，取不到返回 null', () => {
    const store = new Map<number, SceneDoc>([
      [0, before],
      [1, after],
    ]);
    const source: SnapshotSource = { get: (v) => store.get(v) };
    expect(getDiff(source, 0, 1)?.entries.length).toBe(1);
    expect(getDiff(source, 0, 42)).toBeNull();
  });
});

describe('get_lock_details', () => {
  const base = makeDoc(1);
  const p1 = base.objects['plot#1'];
  if (p1 === undefined) throw new Error('fixture 缺 plot#1');
  const doc: SceneDoc = {
    ...base,
    objects: {
      ...base.objects,
      'plot#1': { ...p1, anim: { 'style.width': { kind: 'keys', keys: [{ t: 0, v: 1 }, { t: 2, v: 5 }] } } },
    },
    locks: {
      'plot#1.style.width': { by: 'user', at: 111 },
      'plot#1.style.glow': { by: 'ai', at: 222 },
    },
  };

  it('hard = 用户手动改过，必须 request_patch', () => {
    const d = getLockDetails(doc, ['plot#1.style.width'])[0];
    expect(d?.locked).toBe(true);
    expect(d?.class).toBe('hard');
    expect(d?.by).toBe('user');
    expect(d?.currentValue).toBe(3);
  });

  it('soft = AI 拥有；被动画驱动时额外标出来（提醒"会覆盖动画"）', () => {
    const d = getLockDetails(doc, ['plot#1.style.glow'])[0];
    expect(d?.class).toBe('soft');
    expect(d?.by).toBe('ai');
    expect(d?.animationDriven).toBe(false);
    expect(d?.currentValue).toBe(0.6);
    expect(getLockDetails(doc, ['plot#1.style.width'])[0]?.animationDriven).toBe(true);
  });

  it('未加锁的路径如实返回 locked=false，不编造锁', () => {
    const d = getLockDetails(doc, ['plot#1.tf.opacity'])[0];
    expect(d?.locked).toBe(false);
    expect(d?.by).toBeUndefined();
    expect(d?.class).toBeUndefined();
  });

  it('解析不到的路径给 error，而不是静默 undefined', () => {
    const d = getLockDetails(doc, ['plot#1.style.nope', 'not.a.path'])[0];
    expect(d?.error).toBeDefined();
  });

  it('resolvePath 能解出值，也能识别不存在', () => {
    expect(resolvePath(doc, 'meta.duration')).toEqual({ found: true, value: 12 });
    expect(resolvePath(doc, 'objects.plot#1.style.width.v')).toEqual({ found: true, value: 3 });
    expect(resolvePath(doc, 'objects.ghost.style.width').found).toBe(false);
  });
});
