import { describe, expect, it } from 'vitest';
import {
  cameraMatrix,
  fitViewport,
  fitToPixel,
  pixelToWorld,
  projectWithCamera,
  sampleCamera,
  worldLengthToPixel,
  worldToPixel,
  type CameraState,
} from '../src/camera';
import * as Mat from '../src/math/mat2d';
import * as Vec from '../src/math/vec2';
import type { Camera, DocMeta } from '../src/doc/types';

const META_16x9: DocMeta = {
  fps: 60,
  viewport: [1920, 1080],
  worldWidth: 16,
  worldHeight: 9,
  duration: 12,
  seed: 1234,
};

const IDENT: CameraState = { tx: 0, ty: 0, scale: 1, rotate: 0, pivot: Vec.ZERO };

describe('坐标契约（规范 §4）', () => {
  it('base / x0 / y0 按规范原文计算', () => {
    const fit = fitViewport(META_16x9);
    expect(fit.base).toBe(120);
    expect(fit.x0).toBe(960);
    expect(fit.y0).toBe(540);
    expect(fit.cx).toBe(960);
    expect(fit.cy).toBe(540);
  });

  it('世界可视矩形以原点为中心：[-W/2, W/2] × [-H/2, H/2]', () => {
    const fit = fitViewport(META_16x9);
    // 四个角恰好落在贴合矩形的四角
    expect(fitToPixel(Vec.vec2(-8, -4.5), fit)).toEqual({ x: 0, y: 1080 });
    expect(fitToPixel(Vec.vec2(8, 4.5), fit)).toEqual({ x: 1920, y: 0 });
  });

  it('恒等相机把世界原点映射到视口中心', () => {
    const fit = fitViewport(META_16x9);
    const p = projectWithCamera(Vec.ZERO, fit, IDENT);
    expect(p.x).toBeCloseTo(960, 9);
    expect(p.y).toBeCloseTo(540, 9);
  });

  it('恒等相机下四角映射正确（y 轴翻转）', () => {
    const fit = fitViewport(META_16x9);
    const tl = projectWithCamera(Vec.vec2(-8, 4.5), fit, IDENT);
    const br = projectWithCamera(Vec.vec2(8, -4.5), fit, IDENT);
    expect([tl.x, tl.y]).toEqual([0, 0]);
    expect([br.x, br.y]).toEqual([1920, 1080]);
  });

  it('宽高比不一致时，贴合矩形【居中】于视口（留白均分）', () => {
    const fit = fitViewport({ ...META_16x9, viewport: [1000, 1000] });
    expect(fit.base).toBe(62.5);
    // 世界原点仍在视口中心 —— 这是"居中"的等价表述
    const origin = projectWithCamera(Vec.ZERO, fit, IDENT);
    expect(origin.x).toBeCloseTo(500, 9);
    expect(origin.y).toBeCloseTo(500, 9);
    // 贴合矩形的上下边界对称地落在中心两侧：218.75 / 781.25
    const top = projectWithCamera(Vec.vec2(0, 4.5), fit, IDENT);
    const bottom = projectWithCamera(Vec.vec2(0, -4.5), fit, IDENT);
    expect(top.y).toBeCloseTo(218.75, 9);
    expect(bottom.y).toBeCloseTo(781.25, 9);
    expect(top.y).toBeCloseTo(1000 - bottom.y, 9);
  });

  it('相机的注视点恰好落在视口中心', () => {
    const fit = fitViewport(META_16x9);
    const cam: CameraState = { tx: 2, ty: 1, scale: 3, rotate: 0.7, pivot: Vec.vec2(3, -2) };
    const look = Vec.vec2(cam.pivot.x + cam.tx, cam.pivot.y + cam.ty);
    const p = projectWithCamera(look, fit, cam);
    expect(p.x).toBeCloseTo(fit.cx, 9);
    expect(p.y).toBeCloseTo(fit.cy, 9);
  });

  it('scale 与 rotate 绕注视点发生，注视点是不动点', () => {
    const fit = fitViewport(META_16x9);
    const look = Vec.vec2(1, 1);
    for (const scale of [0.5, 1, 4]) {
      for (const rotate of [0, 0.3, -1.2]) {
        const cam: CameraState = { tx: 0, ty: 0, scale, rotate, pivot: look };
        const p = projectWithCamera(look, fit, cam);
        expect(p.x).toBeCloseTo(fit.cx, 9);
        expect(p.y).toBeCloseTo(fit.cy, 9);
      }
    }
  });

  it('缩放倍数作用在世界长度上：像素长度 = 世界长度 × base × scale', () => {
    const fit = fitViewport(META_16x9);
    const cam: CameraState = { ...IDENT, scale: 2 };
    const a = projectWithCamera(Vec.ZERO, fit, cam);
    const b = projectWithCamera(Vec.vec2(1, 0), fit, cam);
    expect(b.x - a.x).toBeCloseTo(worldLengthToPixel(1, fit, cam), 9);
    expect(worldLengthToPixel(1, fit, cam)).toBe(240);
  });

  it('worldToPixel 与 pixelToWorld 互逆', () => {
    const fit = fitViewport(META_16x9);
    const cam: CameraState = { tx: -1.5, ty: 0.75, scale: 2.5, rotate: 0.4, pivot: Vec.vec2(2, 1) };
    const m = cameraMatrix(cam, fit);
    const p = Vec.vec2(3.25, -1.75);
    const px = worldToPixel(p, fit, m);
    const back = pixelToWorld(px, fit, m);
    expect(back).not.toBeNull();
    if (back === null) return;
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('相机矩阵在 scale=0 时不可逆，pixelToWorld 返回 null 而不是 NaN', () => {
    const fit = fitViewport(META_16x9);
    const m = cameraMatrix({ ...IDENT, scale: 0 }, fit);
    expect(Mat.determinant(m)).toBe(0);
    expect(pixelToWorld(Vec.vec2(10, 10), fit, m)).toBeNull();
  });

  it('相机矩阵等价于规范原文的 T · S · R · T 形态', () => {
    const fit = fitViewport(META_16x9);
    const cam: CameraState = { tx: 0.5, ty: -0.25, scale: 1.5, rotate: 0.2, pivot: Vec.vec2(1, 2) };
    const anchor = fitToPixel(Vec.vec2(1.5, 1.75), fit); // look = pivot + (tx,ty)
    const manual = Mat.compose(
      Mat.translation(fit.cx, fit.cy),
      Mat.scaling(cam.scale),
      Mat.rotation(cam.rotate),
      Mat.translation(-anchor.x, -anchor.y),
    );
    expect(Mat.equals(cameraMatrix(cam, fit), manual, 1e-12)).toBe(true);
  });
});

describe('相机关键帧采样', () => {
  const camera: Camera = {
    keys: [
      { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0], ease: 'easeInOutCubic' },
      { t: 4, tx: 2, ty: 0, scale: 2, rotate: 0, pivot: [0, 0] },
    ],
  };

  it('区间外不做外推', () => {
    expect(sampleCamera(camera, -5).scale).toBe(1);
    expect(sampleCamera(camera, 99).scale).toBe(2);
    expect(sampleCamera({ keys: [] }, 3).scale).toBe(1);
  });

  it('区间内按左端关键帧的 ease 插值', () => {
    expect(sampleCamera(camera, 0).scale).toBe(1);
    expect(sampleCamera(camera, 4).scale).toBe(2);
    // easeInOutCubic 在中点恰好是 0.5
    const mid = sampleCamera(camera, 2);
    expect(mid.scale).toBeCloseTo(1.5, 9);
    expect(mid.tx).toBeCloseTo(1, 9);
  });

  it('未标注 ease 时按线性', () => {
    const linear: Camera = {
      keys: [
        { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] },
        { t: 2, tx: 0, ty: 0, scale: 3, rotate: 0, pivot: [0, 0] },
      ],
    };
    expect(sampleCamera(linear, 0.5).scale).toBeCloseTo(1.5, 9);
  });
});
