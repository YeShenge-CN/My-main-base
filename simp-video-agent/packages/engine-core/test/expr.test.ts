import { describe, expect, it } from 'vitest';
import { compileExpr } from '../src/expr';

/**
 * 表达式编译器：白名单、元数、以及 clamp 的参数序。
 *
 * 范围刻意收窄到"契约"层面：编译不编译得过、算出什么值、以及
 * 白名单与实现表是否一一对应。语义细节（sin/cos…）不是本项目的风险点，
 * 真正出过问题的是【参数序】与【未知函数被放行】这两类。
 */

const evalAt = (src: string, env: Record<string, number>): number => {
  const r = compileExpr(src, Object.keys(env));
  if (!r.ok) throw new Error('编译失败: ' + r.error.message);
  return r.eval(env);
};

describe('clamp 的参数序（规范 §7 的写法）', () => {
  it('clamp(v, lo, hi)：低于下界、区间内、高于上界', () => {
    expect(evalAt('clamp(x,0,1)', { x: -3 })).toBe(0);
    expect(evalAt('clamp(x,0,1)', { x: 0.4 })).toBe(0.4);
    expect(evalAt('clamp(x,0,1)', { x: 9 })).toBe(1);
  });

  it('规范 §7 的原句 clamp(t/2.2,0,1) 在 t=5 时是 1（而不是 2.27）', () => {
    expect(evalAt('clamp(t/2.2,0,1)', { t: 5 })).toBe(1);
    expect(evalAt('clamp(t/2.2,0,1)', { t: 1.1 })).toBeCloseTo(0.5, 9);
  });

  it('NaN 原样传出（由采样层剔除，不在这里静默变成一个合法值）', () => {
    expect(Number.isNaN(evalAt('clamp(x,0,1)', { x: Number.NaN }))).toBe(true);
  });
});

describe('白名单与元数', () => {
  it('白名单外的函数编译失败，而且不会被当成 0 元函数放行', () => {
    const r = compileExpr('foo(1)', ['x']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('unknown_function');
  });

  it('元数不对直接报错（名字对、参数个数错也要拦）', () => {
    expect(compileExpr('clamp(1,2)', ['x']).ok).toBe(false);
    expect(compileExpr('sin(1,2)', ['x']).ok).toBe(false);
    const ok = compileExpr('pow(2,3)', ['x']);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.eval({})).toBe(8);
  });

  it('未声明的自由变量报错（动画表达式只有 t，曲线只有 x）', () => {
    expect(compileExpr('x+1', ['t']).ok).toBe(false);
    expect(compileExpr('t+1', ['t']).ok).toBe(true);
  });

  it('白名单里的每个函数都能真的算出一个有限值（防止登记了没实现）', () => {
    const cases: readonly (readonly [string, number])[] = [
      ['sin(x)', 0.5],
      ['cos(x)', 0.5],
      ['tan(x)', 0.5],
      ['exp(x)', 0.5],
      ['log(x)', 2],
      ['sqrt(x)', 4],
      ['abs(x)', -3],
      ['floor(x)', 1.7],
      ['ceil(x)', 1.2],
      ['round(x)', 1.6],
      ['sign(x)', -2],
      ['pow(x,2)', 3],
      ['min(x,1)', 5],
      ['max(x,1)', 0.2],
      ['mod(x,2)', 5],
      ['atan2(x,1)', 1],
      ['clamp(x,0,1)', 5],
    ];
    for (const [src, value] of cases) {
      const out = evalAt(src, { x: value });
      expect(Number.isFinite(out), src + ' 没算出有限值').toBe(true);
    }
  });

  it('常量与 ^ 的右结合', () => {
    expect(evalAt('PI', {})).toBeCloseTo(Math.PI, 12);
    expect(evalAt('E', {})).toBeCloseTo(Math.E, 12);
    expect(evalAt('2^3^2', {})).toBe(512); // 右结合 → 2^(3^2)
  });
});
