/**
 * token 拆账的【显示层】。
 *
 * ★ 为什么要单独一个模块：这句话以前是内联在 app.ts 里的一个加法
 *   （promptTokens + completionTokens），于是界面上只有一个总数 ——
 *   而"钱花在哪"恰恰是用户最想问的问题（§0.28 作业 3）。
 *   抽成纯函数之后，"三类分开报"这件事能在毫秒级被断言，不必开浏览器。
 *
 * ★ 三个数【不能相加】：图片帧数的 token 已经含在 promptTokens 里，
 *   思考 token 已经含在 completionTokens 里。这里分开报，正是为了让这件事看得见。
 */
export interface TokenUsageView {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** 输入里缓存命中的部分（单价更低）。 */
  readonly cachedTokens?: number;
  /** 思考 token（已含在 completionTokens 里）。 */
  readonly reasoningTokens?: number;
  /** 这次带了几帧画面（token 已含在 promptTokens 里）。 */
  readonly imageFrames?: number;
}

/** 千分位。token 动辄五位数，不分组读不出量级。 */
function n(v: number): string {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 一句话报清三类 token。
 *
 * 例：输入 12,000（缓存 8,000）· 输出 1,200（思考 900）· 图片 4 帧
 */
export function formatUsage(u: TokenUsageView): string {
  const parts: string[] = [];
  const cached = u.cachedTokens ?? 0;
  parts.push('输入 ' + n(u.promptTokens) + (cached > 0 ? '（缓存 ' + n(cached) + '）' : ''));
  const reasoning = u.reasoningTokens ?? 0;
  parts.push('输出 ' + n(u.completionTokens) + (reasoning > 0 ? '（思考 ' + n(reasoning) + '）' : ''));
  const frames = u.imageFrames ?? 0;
  // ★ 0 帧也要报：它正是"模型没看画面"的直接证据，不该被省略掉
  parts.push('图片 ' + n(frames) + ' 帧');
  return parts.join(' · ');
}

/** 总 token（只用于"这一次跑了多少"的量级感，不要拿它做任何计价）。 */
export function totalTokens(u: TokenUsageView): number {
  return u.promptTokens + u.completionTokens;
}
