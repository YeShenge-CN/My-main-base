import { describe, expect, it } from 'vitest';
import { formatUsage, totalTokens } from '../src/usage';

/**
 * 「输入 / 输出 / 图片」三类必须分开报（§0.28 作业 2 的验收第 3 条）。
 *
 * ★ 这一条最容易退化的地方是"看起来报全了，其实把图片当 0 省掉了"——
 *   而图片帧数恰恰是"模型到底看没看画面"的唯一数字证据。
 */
describe('token 三类的显示', () => {
  it('★ 三类都报出来，缓存与思考作为附注', () => {
    const s = formatUsage({
      promptTokens: 12000,
      completionTokens: 1200,
      cachedTokens: 8000,
      reasoningTokens: 900,
      imageFrames: 4,
    });
    expect(s).toContain('输入 12,000');
    expect(s).toContain('缓存 8,000');
    expect(s).toContain('输出 1,200');
    expect(s).toContain('思考 900');
    expect(s).toContain('图片 4 帧');
  });

  it('★ 图片 0 帧也要报（它是"没看画面"的证据，不能被省略）', () => {
    expect(formatUsage({ promptTokens: 10, completionTokens: 5 })).toContain('图片 0 帧');
  });

  it('没有缓存/思考时不显示那两个附注（省得读成"有但为 0"）', () => {
    const s = formatUsage({ promptTokens: 10, completionTokens: 5, imageFrames: 1 });
    expect(s).not.toContain('缓存');
    expect(s).not.toContain('思考');
  });

  it('totalTokens 只加输入与输出（图片与思考已经含在里面，不能重复加）', () => {
    expect(totalTokens({ promptTokens: 100, completionTokens: 20, imageFrames: 4, reasoningTokens: 15 })).toBe(120);
  });
});
