import { describe, expect, it } from 'vitest';
import * as Mat from '../src/math/mat2d';
import * as Vec from '../src/math/vec2';

describe('Mat2D 存储约定', () => {
  it('布局与 Canvas2D setTransform 一致：x\' = a*x + c*y + e', () => {
    const m = Mat.of(2, 0, 0, 3, 10, 20);
    const p = Mat.applyToPoint(m, Vec.vec2(1, 1));
    expect(p).toEqual({ x: 12, y: 23 });
  });

  it('含非对角项时按 a,b,c,d 的语义展开', () => {
    // c = 5 表示"y 贡献到 x'"
    const m = Mat.of(1, 0, 5, 1, 0, 0);
    expect(Mat.applyToPoint(m, Vec.vec2(0, 2))).toEqual({ x: 10, y: 2 });
  });

  it('toTransform / fromTransform 是六元组往返', () => {
    const m = Mat.of(1, 2, 3, 4, 5, 6);
    expect(Mat.toTransform(m)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Mat.fromTransform([1, 2, 3, 4, 5, 6])).toEqual(m);
  });
});

describe('Mat2D 乘法顺序（相机矩阵依赖这条契约）', () => {
  const T = Mat.translation(10, 0);
  const S = Mat.scaling(2, 2);

  it('multiply(A, B) 表示先施加 B 再施加 A', () => {
    // A = T, B = S：先缩放 (1,1)->(2,2)，再平移 ->(12,2)
    expect(Mat.applyToPoint(Mat.multiply(T, S), Vec.vec2(1, 1))).toEqual({ x: 12, y: 2 });
    // 反过来：先平移 (1,1)->(11,1)，再缩放 ->(22,2)
    expect(Mat.applyToPoint(Mat.multiply(S, T), Vec.vec2(1, 1))).toEqual({ x: 22, y: 2 });
  });

  it('compose 从左到右复合，与书写顺序一致', () => {
    const A = Mat.translation(10, 0);
    const B = Mat.scaling(2, 2);
    const C = Mat.rotation(Math.PI / 2);
    expect(Mat.equals(Mat.compose(A, B), Mat.multiply(A, B))).toBe(true);
    expect(Mat.equals(Mat.compose(A, B, C), Mat.multiply(Mat.multiply(A, B), C))).toBe(true);
  });

  it('compose 结合律与单位元', () => {
    const A = Mat.translation(3, -4);
    const B = Mat.scaling(2, 5);
    const C = Mat.rotation(0.7);
    expect(Mat.equals(Mat.compose(Mat.compose(A, B), C), Mat.compose(A, Mat.compose(B, C)))).toBe(
      true,
    );
    expect(Mat.isIdentity(Mat.compose())).toBe(true);
    expect(Mat.equals(Mat.multiply(A, Mat.identity()), A)).toBe(true);
    expect(Mat.equals(Mat.multiply(Mat.identity(), A), A)).toBe(true);
  });

  it('相机矩阵形态 M = T · S · R · T(pivot) 的顺序可被显式验证', () => {
    // 取一个非平凡点，手工推导：先反向平移 pivot，再旋转、缩放、正向平移
    const cx = 100;
    const cy = 50;
    const pivot = Vec.vec2(10, 20);
    const M = Mat.compose(
      Mat.translation(cx, cy),
      Mat.scaling(2),
      Mat.rotation(Math.PI / 2),
      Mat.translation(-pivot.x, -pivot.y),
    );
    // pivot 本身是不动点：变换后仍回到 (cx, cy)
    const mapped = Mat.applyToPoint(M, pivot);
    expect(mapped.x).toBeCloseTo(cx, 10);
    expect(mapped.y).toBeCloseTo(cy, 10);
    // pivot + (1,0) 先减去 pivot 得 (1,0)，旋转 90 度得 (0,1)，缩放 2 得 (0,2)，平移得 (cx, cy+2)
    const mapped2 = Mat.applyToPoint(M, Vec.vec2(pivot.x + 1, pivot.y));
    expect(mapped2.x).toBeCloseTo(cx, 10);
    expect(mapped2.y).toBeCloseTo(cy + 2, 10);
  });
});

describe('Mat2D 几何量', () => {
  it('旋转矩阵在数学坐标系下是逆时针', () => {
    const r = Mat.applyToPoint(Mat.rotation(Math.PI / 2), Vec.UNIT_X);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });

  it('applyToVector 忽略平移', () => {
    const m = Mat.compose(Mat.translation(100, 200), Mat.scaling(3, 4));
    expect(Mat.applyToVector(m, Vec.vec2(1, 1))).toEqual({ x: 3, y: 4 });
  });

  it('行列式', () => {
    expect(Mat.determinant(Mat.identity())).toBe(1);
    expect(Mat.determinant(Mat.scaling(2, 3))).toBe(6);
    expect(Mat.determinant(Mat.rotation(1))).toBeCloseTo(1, 12);
  });

  it('scaleOf 给出两个轴向上的缩放倍数（描边宽度要用它）', () => {
    expect(Mat.scaleOf(Mat.scaling(3, 4))).toEqual({ x: 3, y: 4 });
    const r = Mat.scaleOf(Mat.rotation(0.6));
    expect(r.x).toBeCloseTo(1, 12);
    expect(r.y).toBeCloseTo(1, 12);
    // 先缩放再旋转，轴长不变
    const sr = Mat.scaleOf(Mat.multiply(Mat.rotation(0.6), Mat.scaling(3, 4)));
    expect(sr.x).toBeCloseTo(3, 12);
    expect(sr.y).toBeCloseTo(4, 12);
  });

  it('averageScale 在等比时等于该比例', () => {
    expect(Mat.averageScale(Mat.scaling(2.5))).toBeCloseTo(2.5, 12);
  });
});

describe('Mat2D 求逆', () => {
  it('逆矩阵往返回到原点', () => {
    const m = Mat.compose(
      Mat.translation(37, -11),
      Mat.rotation(0.9),
      Mat.scaling(2, 5),
      Mat.translation(-3, 7),
    );
    const inv = Mat.invert(m);
    expect(inv).not.toBeNull();
    if (inv === null) return;
    const p = Vec.vec2(1.25, -8.5);
    const round = Mat.applyToPoint(inv, Mat.applyToPoint(m, p));
    expect(round.x).toBeCloseTo(p.x, 9);
    expect(round.y).toBeCloseTo(p.y, 9);
  });

  it('M * M^-1 是单位矩阵', () => {
    const m = Mat.compose(Mat.translation(5, 5), Mat.rotation(0.3), Mat.scaling(1.5, 2.5));
    const inv = Mat.invert(m);
    expect(inv).not.toBeNull();
    if (inv === null) return;
    expect(Mat.isIdentity(Mat.multiply(m, inv), 1e-9)).toBe(true);
  });

  it('奇异矩阵返回 null，而不是 NaN 矩阵', () => {
    expect(Mat.invert(Mat.scaling(0))).toBeNull();
    expect(Mat.invert(Mat.scaling(3, 0))).toBeNull();
    // 数值下溢导致行列式为 0 的极端缩放同样判定为不可逆
    expect(Mat.invert(Mat.scaling(1e-200))).toBeNull();
  });

  it('任何 invert 的返回值要么是有限矩阵，要么是 null', () => {
    const cases = [Mat.scaling(1e-8), Mat.scaling(1e8), Mat.rotation(1), Mat.of(1, 2, 2, 4, 0, 0)];
    for (const m of cases) {
      const inv = Mat.invert(m);
      if (inv !== null) expect(Mat.isFiniteMat(inv)).toBe(true);
    }
  });
});

describe('Mat2D 是纯函数（不变量 1）', () => {
  it('输入被冻结时仍可正常运算', () => {
    const a = Object.freeze(Mat.of(1, 2, 3, 4, 5, 6));
    const b = Object.freeze(Mat.translation(1, 1));
    expect(() => {
      Mat.multiply(a, b);
      Mat.compose(a, b, a);
      Mat.invert(a);
      Mat.scaleOf(a);
      Mat.applyToPoint(a, Vec.vec2(0, 0));
    }).not.toThrow();
  });
});
