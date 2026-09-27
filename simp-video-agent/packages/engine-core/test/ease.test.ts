import { describe, expect, it } from 'vitest';
import { applyEase, clamp01, EASE_NAMES, easeFn, EASES } from '../src/anim/ease';

describe('缓动函数库', () => {
  it('五个 ease 都在册，名字是封闭集合', () => {
    expect(EASE_NAMES).toEqual([
      'linear',
      'easeInCubic',
      'easeOutCubic',
      'easeInOutCubic',
      'easeOutBack',
    ]);
  });

  it('端点恒为 0 与 1（easeOutBack 在 1 处也收敛到 1）', () => {
    for (const name of EASE_NAMES) {
      expect(EASES[name](0)).toBeCloseTo(0, 12);
      expect(EASES[name](1)).toBeCloseTo(1, 12);
    }
  });

  it('linear 是恒等', () => {
    expect(EASES.linear(0.37)).toBe(0.37);
  });

  it('easeInCubic / easeOutCubic 在中点对称', () => {
    expect(EASES.easeInCubic(0.5)).toBeCloseTo(0.125, 12);
    expect(EASES.easeOutCubic(0.5)).toBeCloseTo(0.875, 12);
  });

  it('easeInOutCubic 过 (0.5, 0.5) 且单调不减', () => {
    expect(EASES.easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    let prev = -1;
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const v = EASES.easeInOutCubic(clamp01(k));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it('easeOutBack 刻意过冲：最大值大于 1', () => {
    let max = 0;
    for (let k = 0; k <= 1; k += 0.005) max = Math.max(max, EASES.easeOutBack(k));
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThan(1.2);
  });

  it('输入被夹紧到 [0,1]', () => {
    expect(applyEase('easeOutCubic', -3)).toBe(applyEase('easeOutCubic', 0));
    expect(applyEase('easeOutCubic', 9)).toBe(applyEase('easeOutCubic', 1));
    expect(applyEase('easeOutCubic', Number.NaN)).toBe(0);
    expect(applyEase('easeOutCubic', Number.POSITIVE_INFINITY)).toBe(applyEase('easeOutCubic', 1));
  });

  it('未登记的 ease 名回退到 linear，而不是抛异常', () => {
    expect(applyEase('noSuchEase', 0.25)).toBe(0.25);
    expect(easeFn(undefined)(0.25)).toBe(0.25);
    // 原型链上的名字不能借进来
    expect(applyEase('constructor', 0.25)).toBe(0.25);
    expect(applyEase('toString', 0.25)).toBe(0.25);
  });

  it('clamp01 对非有限数返回 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });
});
