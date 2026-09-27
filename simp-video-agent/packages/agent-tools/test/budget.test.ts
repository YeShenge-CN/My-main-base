import { describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  DEFAULT_LIMITS,
  enforceContextBudget,
  L1_MAX_FRAMES,
  L2_MAX_IMAGES,
  L2_MAX_RENDER_CALLS,
} from '../src/budget';

/**
 * 三层图像预算的确定性断言（不依赖 LLM）。
 * 验收原文："预算耗尽时报错而非静默继续"。
 */
/**
 * 三层图像预算的确定性断言（不依赖 LLM）。
 * 验收原文：「预算耗尽时报错而非静默继续」。
 *
 * ★★ 第二十九轮把判据改成【从常量推导】（上限 + 1 被拒 / 正好到上限放行）。
 *   原来写死的是 4 帧 / 5 帧，于是「放开上限」这一轮里 6 条断言全红 ——
 *   而它们红的原因与「预算语义坏没坏」毫无关系。
 *   上限值本身仍然只在一处硬编码（下面那条 ★ 断言），改它必须是有意的。
 */
describe('L1：单次渲染的帧数上限', () => {
  it('★ 三个上限值本身（改它们必须是有意的，见 §0.28 的决定）', () => {
    expect(L1_MAX_FRAMES).toBe(6);
    expect(L2_MAX_IMAGES).toBe(16);
    expect(L2_MAX_RENDER_CALLS).toBe(6);
  });

  it('上限 + 1 帧被【渲染前】拒绝', () => {
    const b = new BudgetTracker('s1');
    const check = b.checkRender(Array.from({ length: L1_MAX_FRAMES + 1 }, (_, i) => i));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.rejection.code).toBe('L1_too_many_frames');
  });

  it('正好到上限放行', () => {
    const ts = Array.from({ length: L1_MAX_FRAMES }, (_, i) => i);
    expect(new BudgetTracker('s1').checkRender(ts).ok).toBe(true);
  });

  it('被拒绝的请求【不记账】—— 拒绝就是拒绝，不能悄悄消耗额度', () => {
    const b = new BudgetTracker('s1');
    expect(b.checkRender(Array.from({ length: L1_MAX_FRAMES + 1 }, (_, i) => i)).ok).toBe(false);
    expect(b.remaining().imagesUsed).toBe(0);
    expect(b.remaining().renderCallsLeft).toBe(L2_MAX_RENDER_CALLS);
  });
});

describe('L2：每镜累计额度', () => {
  it('图片额度用尽后拒绝，并说清楚差多少', () => {
    // 渲染次数放到很宽，好让这条只测【图片额度】这一层
    const b = new BudgetTracker('s1', { ...DEFAULT_LIMITS, maxRenderCalls: 99 });
    b.chargeRender(L2_MAX_IMAGES - 1);
    // 注意：要请求【一整个 L1 批次】的帧数，不是只传一个数
    const check = b.checkRender(Array.from({ length: L1_MAX_FRAMES }, (_, i) => i));
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.rejection.code).toBe('L2_images_exhausted');
    expect(check.rejection.message).toContain(L2_MAX_IMAGES - 1 + '/' + L2_MAX_IMAGES);
  });

  it('调用次数用尽后拒绝', () => {
    const limits = { ...DEFAULT_LIMITS, maxImages: 99 };
    const b = new BudgetTracker('s1', limits);
    for (let i = 0; i < L2_MAX_RENDER_CALLS; i++) {
      b.chargeRender(1);
    }
    const check = b.checkRender([0]);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.rejection.code).toBe('L2_calls_exhausted');
  });

  it('remaining() 随记账递减', () => {
    const b = new BudgetTracker('s1');
    b.chargeRender(2);
    expect(b.remaining()).toEqual({
      imagesUsed: 2,
      imagesLeft: L2_MAX_IMAGES - 2,
      renderCallsLeft: L2_MAX_RENDER_CALLS - 1,
    });
  });
});

describe('L3：上下文里的图片上限', () => {
  const img = (url: string) => ({ type: 'image_url', image_url: { url } });

  it('不超过上限时原样返回', () => {
    const msgs = [{ role: 'user', content: [img('a')] }];
    const out = enforceContextBudget(msgs, 3);
    expect(out.summarized).toBe(0);
    expect(out.messages).toEqual(msgs);
  });

  it('超出时把【更早的】替换成一行文字摘要，而不是直接删掉', () => {
    const msgs = [
      { role: 'user', content: [img('a'), img('b')] },
      { role: 'user', content: [img('c')] },
      { role: 'user', content: [img('d')] },
    ];
    const out = enforceContextBudget(msgs, 3);
    // 一共 4 张图，上限 3 → 折叠掉最老的 1 张（第一条消息里的 'a'）
    expect(out.summarized).toBe(1);
    const parts = out.messages[0]?.content as { type: string; text?: string }[];
    const images = parts.filter((p) => p.type === 'image_url');
    const texts = parts.filter((p) => p.type === 'text');
    // 同一消息里剩下的那张图【不该】被误伤
    expect(images.length).toBe(1);
    expect(texts.some((p) => (p.text ?? '').includes('折叠'))).toBe(true);
  });

  it('只保留最近的 max 张图', () => {
    const msgs = [img('a'), img('b'), img('c'), img('d')].map((i) => ({ role: 'user', content: [i] }));
    const out = enforceContextBudget(msgs, 2);
    const stillImages = out.messages.filter(
      (m) => Array.isArray(m.content) && (m.content as { type: string }[]).some((p) => p.type === 'image_url'),
    );
    expect(stillImages.length).toBe(2);
  });
});
