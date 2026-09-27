import { describe, expect, it } from 'vitest';
import type { AnimTrack, SceneDoc } from '@sva/engine-core';
import { renderFrames } from '../src/render';

/**
 * 动画的【像素级】验证。
 *
 * 为什么单测不够：单测只能证明 RenderState 里的字段变了。
 * 本项目实际出过一次事故 —— 加了 text shape 之后 Level A 的 sha256
 * 与"没有文字"时一模一样（浏览器端 bundle 是旧的，没人重新打包）。
 * 结构对了而画面没变，是所有"看起来通过了"里最难发现的一种。
 *
 * 所以这一组直接比 PNG 的 sha256：动画必须让【画出来的像素】不一样。
 * 默认跳过（要拉 @napi-rs/canvas 渲染），需要时：
 *   SVA_PIXELS=1 pnpm test
 */
const ENABLED = process.env['SVA_PIXELS'] === '1';

function shot(anim: Record<string, AnimTrack>, style: Record<string, unknown> = {}): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [320, 180], worldWidth: 16, worldHeight: 9, duration: 4, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] }],
    objects: {
      'plot#1': {
        shape: 'plot2d',
        owner: { kind: 'global' },
        params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 800 } },
        style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: 0.4 }, ...style },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim,
        effects: [],
      },
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function hashesAt(doc: SceneDoc, times: readonly number[]): readonly string[] {
  return renderFrames(doc, times).map((f) => f.sha256);
}

describe.skipIf(!ENABLED)('动画真的改变像素', () => {
  it('不透明度 0→1：每一帧都不一样，且首帧与空文档一致（真的透明）', () => {
    const doc = shot({ 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }] } });
    const hashes = hashesAt(doc, [0, 1, 2]);
    expect(new Set(hashes).size).toBe(3);

    const empty: SceneDoc = { ...shot({}), objects: {}, layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }] };
    expect(hashes[0]).toBe(hashesAt(empty, [0])[0]);
    expect(hashes[2]).not.toBe(hashesAt(empty, [2])[0]);
  });

  it('线宽 1→9：像素变化', () => {
    const doc = shot({ 'style.width': { kind: 'keys', keys: [{ t: 0, v: 1 }, { t: 2, v: 9 }] } });
    const hashes = hashesAt(doc, [0, 2]);
    expect(new Set(hashes).size).toBe(2);
  });

  it('颜色 蓝→红：像素变化', () => {
    const doc = shot({
      'style.stroke': { kind: 'keys', keys: [{ t: 0, v: '#4ea1ff' }, { t: 2, v: '#ff0000' }] },
    });
    const hashes = hashesAt(doc, [0, 2.5]);
    expect(new Set(hashes).size).toBe(2);
  });

  it('位移与旋转：像素变化', () => {
    const moved = shot({ 'tf.x': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 2, v: 2 }] } });
    expect(new Set(hashesAt(moved, [0, 2])).size).toBe(2);
    const turned = shot({ 'tf.rotate': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 2, v: 0.8 }] } });
    expect(new Set(hashesAt(turned, [0, 2])).size).toBe(2);
  });

  it('把不透明度【恒定为 0】必须真的看不见（动画值不能被当成"没有动画"）', () => {
    const faded = shot({ 'tf.opacity': { kind: 'expr', expr: '0' } });
    const empty: SceneDoc = { ...shot({}), objects: {}, layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }] };
    expect(hashesAt(faded, [1])[0]).toBe(hashesAt(empty, [1])[0]);
  });

  it('没有动画时同帧两次渲染字节相同（确定性没有被动画路径破坏）', () => {
    const still = shot({});
    expect(hashesAt(still, [1])[0]).toBe(hashesAt(still, [1])[0]);
  });
});

describe.skipIf(ENABLED)('动画像素验证（未启用）', () => {
  it('默认跳过，需要 SVA_PIXELS=1', () => {
    expect(ENABLED).toBe(false);
  });
});
