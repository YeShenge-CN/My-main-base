/**
 * 跨镜交接摘要（用户拍板：带上前面各镜的一段紧凑摘要）。
 *
 * ★ 为什么事实部分必须【从文档推导】：模型自己写的交接摘要会漂 ——
 *   它描述的是自己想做而不是做了什么。这一份断言钉的就是"数字来自文档"。
 */
import { describe, expect, it } from 'vitest';
import type { SceneDoc, SceneObject } from '@sva/engine-core';
import { HANDOFF_MAX_ENTRIES, handoffSummary } from '../src/multi-shot';
import { historyMessage, type RunResult } from '../src/runtime';

function obj(id: string, shape: string, sceneId: string | null, style: Record<string, unknown> = {}): SceneObject {
  return {
    shape,
    owner: sceneId === null ? { kind: 'global' } : { kind: 'scene', sceneId, bornAt: 0 },
    params: shape === 'text' ? { content: { v: '标题' } } : { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
    style: { stroke: { v: '#4ea1ff' }, ...style },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

function docWith(objects: Record<string, SceneObject>): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: Object.keys(objects) }],
    objects,
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [{ id: 's#1', name: '一', bornAt: 0 }, { id: 's#2', name: '二', bornAt: 6 }],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

const run = (finalMessage: string): RunResult => ({ finalMessage } as unknown as RunResult);

describe('handoffSummary：事实来自文档', () => {
  it('只数【本镜】的对象，别人的与 global 的不算', () => {
    const doc = docWith({
      'plot#1': obj('plot#1', 'plot2d', 's#1'),
      'text#1': obj('text#1', 'text', 's#1'),
      'plot#2': obj('plot#2', 'plot2d', 's#2'),
      'bg#1': obj('bg#1', 'rect', null),
    });
    const s = handoffSummary(doc, 's#1', run('画好了'));
    expect(s).toContain('这一镜有 2 个对象');
    expect(s).toContain('plot#1（plot2d）');
    expect(s).toContain('text#1（text）');
    expect(s).not.toContain('plot#2');
    expect(s).not.toContain('bg#1');
  });

  it('★ 颜色与字号要带上（视觉语言里最容易被下一镜忘掉的两样）', () => {
    const doc = docWith({
      'plot#1': obj('plot#1', 'plot2d', 's#1', { stroke: { v: '#ffb454' } }),
      'text#1': obj('text#1', 'text', 's#1', { size: { v: 36 }, fill: { v: '#e8eef8' } }),
    });
    const s = handoffSummary(doc, 's#1', run(''));
    expect(s).toContain('#ffb454');
    expect(s).toContain('36px');
  });

  it('结论文本截断到 160 字（交接摘要是"紧凑"的）', () => {
    const doc = docWith({ 'plot#1': obj('plot#1', 'plot2d', 's#1') });
    const s = handoffSummary(doc, 's#1', run('x'.repeat(500)));
    expect(s).toContain('x'.repeat(160));
    expect(s).not.toContain('x'.repeat(161));
  });

  it('本镜什么都没有时如实说（无），而不是留一段空白', () => {
    const doc = docWith({ 'bg#1': obj('bg#1', 'rect', null) });
    expect(handoffSummary(doc, 's#1', run(''))).toContain('（无）');
  });

  it('★ 上限是个【小】数 —— 它是一致性的锚，不是完整历史', () => {
    expect(HANDOFF_MAX_ENTRIES).toBeLessThanOrEqual(6);
    expect(HANDOFF_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe('history 那一段的标题要说得对', () => {
  it('默认标题说的是"这个镜头的上一轮"', () => {
    const msg = historyMessage(['做过 A']);
    expect(String(msg?.content)).toContain('这个镜头的上一轮');
  });

  it('★ 跨镜交接时标题必须换掉（说错比不说更糟：模型会以为这是它自己的历史）', () => {
    const msg = historyMessage(['第 1 镜做了 A'], '前面几镜的交接摘要（背景，用于保持风格一致）');
    expect(String(msg?.content)).toContain('前面几镜的交接摘要');
    expect(String(msg?.content)).not.toContain('这个镜头的上一轮');
  });

  it('没有历史时返回 null（不生成空的一段）', () => {
    expect(historyMessage([])).toBeNull();
  });
});
