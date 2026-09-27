/**
 * 坐标契约（规范 §4）。这是整个项目最先必须写对的一段代码。
 *
 * ── 规范原文 ──────────────────────────────────────────────
 *   base = min(viewport.w / worldWidth, viewport.h / worldHeight)
 *   x0 = worldWidth * base / 2
 *   y0 = worldHeight * base / 2
 *   worldToPixel(p, M) = M · { x: x0 + p.x*base, y: y0 - p.y*base }
 *   M = T(cx, cy) · S(scale) · R(rotate) · T(-pivot·base)
 *
 * ── 原文里两处必须补全的地方（有算术证明，见 test/camera.test.ts）────
 *
 * (1) cx, cy 没有定义。任何字面取值都会把恒等相机的世界原点打到画布角落：
 *       cx,cy = 视口中心 (960,540)  → 世界原点落在 (1920,1080)，右下角
 *       cx,cy = 相机 tx,ty（恒等即 0）→ 世界原点落在 (0,0)，左上角
 *     两者都不成立。唯一自洽的取法是"视口中心 + 绕被注视点的缩放旋转"：
 *
 *       M = T(cx, cy) · S(scale) · R(rotate) · T(−fit(look))     look = pivot + (tx, ty)
 *
 *     于是 worldToPixel(pivot + (tx,ty)) === (cx, cy)：
 *     相机注视的那个世界点恰好落在视口中心。恒等相机下世界原点 → 视口中心。
 *
 * (2) T(-pivot·base) 里的 pivot·base 不是 pivot 在像素空间的坐标。
 *     贴合后的坐标是 fit(p) = (x0 + p.x*base, y0 − p.y*base)，
 *     所以反向平移量应当是 fit(pivot)，而不是 pivot·base ——
 *     后者只有在 x0 = y0 = 0 时才与前者相等。用 fit(pivot) 才能让 pivot
 *     真正成为缩放/旋转的不动点。
 *
 * ── 由 (1)(2) 推出的两个几何事实（都有断言）──────────────
 *   a. 世界可视矩形以原点为中心：[-W/2, W/2] × [-H/2, H/2]。
 *   b. 贴合后的矩形【居中】于视口 —— viewport 宽高比与世界不一致时，
 *      留白左右/上下均分。这正是 (1) 的直接后果：
 *      贴合矩形中心 fit(0,0) = (x0,y0) 被映射到视口中心 (cx,cy)。
 *
 * ── 单位与方向 ────────────────────────────────────────────
 *   - tx / ty / pivot 全部是【世界单位】。文档里不存在像素概念（规范 §4）。
 *   - rotate 作用在像素空间（y 轴向下），因此正值在屏幕上表现为【顺时针】。
 *   - 描边宽度、圆角、发光半径、虚线间隔：乘相机 scale 后再画。
 *     canvas.width/height 就是导出像素，永不使用 devicePixelRatio。
 */
import type { Mat2D } from './math/mat2d';
import * as Mat from './math/mat2d';
import type { Vec2 } from './math/vec2';
import * as Vec from './math/vec2';
import type { Camera, CameraKey, DocMeta } from './doc/types';
import { applyEase } from './anim/ease';

export interface ViewportFit {
  readonly viewportW: number;
  readonly viewportH: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** 等比适配比例 */
  readonly base: number;
  /** 贴合后世界原点落在像素空间的 x：worldWidth*base/2 */
  readonly x0: number;
  /** 贴合后世界原点落在像素空间的 y：worldHeight*base/2 */
  readonly y0: number;
  /** 视口中心 x（相机矩阵的锚点） */
  readonly cx: number;
  /** 视口中心 y */
  readonly cy: number;
}

export interface CameraState {
  readonly tx: number;
  readonly ty: number;
  readonly scale: number;
  readonly rotate: number;
  /** pivot 用世界单位表示 */
  readonly pivot: Vec2;
}

export const IDENTITY_CAMERA: CameraState = Object.freeze({
  tx: 0,
  ty: 0,
  scale: 1,
  rotate: 0,
  pivot: Vec.ZERO,
});

/** 由 meta 推出等比适配参数。 */
export function fitViewport(meta: DocMeta): ViewportFit {
  const viewportW = meta.viewport[0];
  const viewportH = meta.viewport[1];
  const worldWidth = meta.worldWidth;
  const worldHeight = meta.worldHeight;
  const base = Math.min(viewportW / worldWidth, viewportH / worldHeight);
  return {
    viewportW,
    viewportH,
    worldWidth,
    worldHeight,
    base,
    x0: (worldWidth * base) / 2,
    y0: (worldHeight * base) / 2,
    cx: viewportW / 2,
    cy: viewportH / 2,
  };
}

/** 世界点 → 贴合后的像素点（还没进相机矩阵）。fit(p) 的中心就是 (x0, y0)。 */
export function fitToPixel(p: Vec2, fit: ViewportFit): Vec2 {
  return { x: fit.x0 + p.x * fit.base, y: fit.y0 - p.y * fit.base };
}

/** 相机注视的世界点 = pivot + (tx, ty)。 */
export function cameraLookAt(cam: CameraState): Vec2 {
  return { x: cam.pivot.x + cam.tx, y: cam.pivot.y + cam.ty };
}

/** 相机矩阵：M = T(cx,cy) · S(scale) · R(rotate) · T(−fit(look)) */
export function cameraMatrix(cam: CameraState, fit: ViewportFit): Mat2D {
  const anchor = fitToPixel(cameraLookAt(cam), fit);
  return Mat.compose(
    Mat.translation(fit.cx, fit.cy),
    Mat.scaling(cam.scale, cam.scale),
    Mat.rotation(cam.rotate),
    Mat.translation(-anchor.x, -anchor.y),
  );
}

/** 规范原文给出的主公式：worldToPixel(p, M) = M · fit(p) */
export function worldToPixel(p: Vec2, fit: ViewportFit, m: Mat2D): Vec2 {
  return Mat.applyToPoint(m, fitToPixel(p, fit));
}

/** 便捷版本：直接给相机状态。 */
export function projectWithCamera(p: Vec2, fit: ViewportFit, cam: CameraState): Vec2 {
  return worldToPixel(p, fit, cameraMatrix(cam, fit));
}

/** 屏幕像素 → 世界，用于命中测试与反向操作。fit 不可逆时返回 null。 */
export function pixelToWorld(p: Vec2, fit: ViewportFit, m: Mat2D): Vec2 | null {
  const inv = Mat.invert(m);
  if (inv === null) return null;
  const fitted = Mat.applyToPoint(inv, p);
  return { x: (fitted.x - fit.x0) / fit.base, y: (fit.y0 - fitted.y) / fit.base };
}

/** 世界空间的一个长度（含方向无关）换算到屏幕像素。 */
export function worldLengthToPixel(len: number, fit: ViewportFit, cam: CameraState): number {
  return len * fit.base * cam.scale;
}

/** 相机对绘制量的统一缩放倍数（描边宽度 / 圆角 / 发光半径都乘它）。 */
export function cameraScale(cam: CameraState): number {
  return cam.scale;
}

function keyToState(k: CameraKey): CameraState {
  return {
    tx: k.tx,
    ty: k.ty,
    scale: k.scale,
    rotate: k.rotate,
    pivot: Vec.fromTuple(k.pivot),
  };
}

function lerpState(a: CameraState, b: CameraState, k: number): CameraState {
  return {
    tx: a.tx + (b.tx - a.tx) * k,
    ty: a.ty + (b.ty - a.ty) * k,
    scale: a.scale + (b.scale - a.scale) * k,
    rotate: a.rotate + (b.rotate - a.rotate) * k,
    pivot: Vec.lerp(a.pivot, b.pivot, k),
  };
}

/**
 * 在时刻 t 采样相机关键帧。
 * t 在任何关键帧之前取第一帧，之后取最后一帧（不做外推）。
 * 缓动取【左端关键帧】上标注的 ease。
 */
export function sampleCamera(camera: Camera, t: number): CameraState {
  const keys = camera.keys;
  const first = keys[0];
  if (first === undefined) return IDENTITY_CAMERA;
  if (t <= first.t) return keyToState(first);
  const last = keys[keys.length - 1];
  if (last === undefined) return keyToState(first);
  if (t >= last.t) return keyToState(last);

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (a === undefined || b === undefined) continue;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const raw = span <= 0 ? 1 : (t - a.t) / span;
      return lerpState(keyToState(a), keyToState(b), applyEase(a.ease, raw));
    }
  }
  return keyToState(last);
}
