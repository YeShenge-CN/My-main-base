import { describe, expect, it } from 'vitest';
import * as Vec from '../src/math/vec2';

const P = Vec.vec2(3, 4);
const Q = Vec.vec2(-1, 2);

describe('Vec2 基本运算', () => {
  it('构造与元组互转', () => {
    expect(Vec.vec2(1, 2)).toEqual({ x: 1, y: 2 });
    expect(Vec.fromTuple([1, 2])).toEqual({ x: 1, y: 2 });
    expect(Vec.toTuple({ x: 1, y: 2 })).toEqual([1, 2]);
  });

  it('加减标量乘', () => {
    expect(Vec.add(P, Q)).toEqual({ x: 2, y: 6 });
    expect(Vec.sub(P, Q)).toEqual({ x: 4, y: 2 });
    expect(Vec.scale(P, 2)).toEqual({ x: 6, y: 8 });
    expect(Vec.negate(P)).toEqual({ x: -3, y: -4 });
    expect(Vec.mul(P, Q)).toEqual({ x: -3, y: 8 });
  });

  it('点积与叉积', () => {
    expect(Vec.dot(P, Q)).toBe(-3 + 8);
    // 叉积 z 分量 = 有向面积两倍：UNIT_X -> UNIT_Y 是 +1
    expect(Vec.cross(Vec.UNIT_X, Vec.UNIT_Y)).toBe(1);
    expect(Vec.cross(Vec.UNIT_Y, Vec.UNIT_X)).toBe(-1);
  });

  it('长度与距离', () => {
    expect(Vec.length(P)).toBe(5);
    expect(Vec.lengthSq(P)).toBe(25);
    expect(Vec.distance(Vec.ZERO, P)).toBe(5);
    expect(Vec.distanceSq(Vec.ZERO, P)).toBe(25);
  });
});

describe('Vec2 退化行为（必须确定，不能产生 NaN）', () => {
  it('零向量单位化返回 ZERO', () => {
    expect(Vec.normalize(Vec.ZERO)).toEqual(Vec.ZERO);
    expect(Vec.isFiniteVec(Vec.normalize(Vec.ZERO))).toBe(true);
  });

  it('非有限向量单位化返回 ZERO', () => {
    expect(Vec.normalize(Vec.vec2(Number.NaN, 1))).toEqual(Vec.ZERO);
    expect(Vec.normalize(Vec.vec2(Number.POSITIVE_INFINITY, 0))).toEqual(Vec.ZERO);
  });

  it('正常单位化', () => {
    const n = Vec.normalize(P);
    expect(Vec.length(n)).toBeCloseTo(1, 12);
    expect(n).toEqual({ x: 0.6, y: 0.8 });
  });

  it('isFiniteVec 判定', () => {
    expect(Vec.isFiniteVec(P)).toBe(true);
    expect(Vec.isFiniteVec(Vec.vec2(Number.NaN, 0))).toBe(false);
    expect(Vec.isFiniteVec(Vec.vec2(0, Number.NEGATIVE_INFINITY))).toBe(false);
  });
});

describe('Vec2 几何', () => {
  it('逆时针旋转 90 度（数学坐标系，y 轴向上）', () => {
    const r = Vec.rotate(Vec.UNIT_X, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
  });

  it('极角', () => {
    expect(Vec.angle(Vec.UNIT_X)).toBe(0);
    expect(Vec.angle(Vec.UNIT_Y)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('线性插值不夹紧 k', () => {
    expect(Vec.lerp(Vec.ZERO, Vec.vec2(10, 20), 0.25)).toEqual({ x: 2.5, y: 5 });
    expect(Vec.lerp(Vec.ZERO, Vec.vec2(10, 20), 2)).toEqual({ x: 20, y: 40 });
  });

  it('容差比较', () => {
    expect(Vec.equals(Vec.vec2(1, 1), Vec.vec2(1 + 1e-12, 1))).toBe(true);
    expect(Vec.equals(Vec.vec2(1, 1), Vec.vec2(1.001, 1))).toBe(false);
    expect(Vec.isZero(Vec.vec2(1e-12, -1e-12))).toBe(true);
  });
});

describe('Vec2 是纯函数（不变量 1）', () => {
  it('输入对象被冻结时仍可正常运算', () => {
    const a = Object.freeze(Vec.vec2(1, 2));
    const b = Object.freeze(Vec.vec2(3, 4));
    expect(() => {
      Vec.add(a, b);
      Vec.sub(a, b);
      Vec.scale(a, 2);
      Vec.normalize(a);
      Vec.rotate(a, 1);
      Vec.lerp(a, b, 0.5);
    }).not.toThrow();
  });
});
