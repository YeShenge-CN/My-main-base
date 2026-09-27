/**
 * token 估算。
 *
 * 为什么自己写而不用 tiktoken：engine-core 必须宿主无关、零依赖（不变量 1），
 * 而这里只需要一个【保守的】预算判据，不需要与某个具体分词器逐 token 对齐。
 *
 * 估算方式（刻意高估，宁可少放内容也不要超预算）：
 *   - ASCII：3 字符/token。真实 BPE 对 ASCII 通常 3.5～4 字符/token，
 *     而 JSON 这种标点密集的文本更低。取 3 是有意留出的安全边际。
 *   - CJK：1.5 token/字。主流 BPE 对汉字通常 1～1.5 token/字。
 *   - 其它（重音字母、emoji 等）：2 token/字。
 *
 * 校验（见 test/projection-summary.test.ts）：
 *   - 对纯 ASCII，estimateTokens(s) >= ceil(len/4)，即严格不低估真实下限；
 *   - 单调：s 是 t 的前缀 ⇒ estimateTokens(s) <= estimateTokens(t)。
 */

/** 每个 ASCII 字符按多少字符/token 折算（分母越小越保守）。 */
export const ASCII_CHARS_PER_TOKEN = 3;
export const CJK_TOKENS_PER_CHAR = 1.5;
export const OTHER_TOKENS_PER_CHAR = 2;

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 韩文
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角标点
    (cp >= 0x20000 && cp <= 0x2ebef) // CJK 扩展 B~F
  );
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) ascii++;
    else if (isCjk(cp)) cjk++;
    else other++;
  }
  return Math.ceil(
    ascii / ASCII_CHARS_PER_TOKEN + cjk * CJK_TOKENS_PER_CHAR + other * OTHER_TOKENS_PER_CHAR,
  );
}

/** 一个结构的 token 估算：按紧凑 JSON 计（这是模型最少会看到的形态）。 */
export function tokensOfJson(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : estimateTokens(text);
}

/**
 * 递增式 token 预算。
 *
 * 用"先试后记账"而不是"算完再截"：投影层每加一条就要知道还放不放得下，
 * 这样截断点是确定的，而且永不超预算。
 */
export class TokenBudget {
  readonly limit: number;
  private spent = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  /** 无条件记账。 */
  spend(text: string): void {
    this.spent += estimateTokens(text);
  }

  /** 放得下就记账并返回 true。 */
  trySpend(text: string): boolean {
    const cost = estimateTokens(text);
    if (this.spent + cost > this.limit) return false;
    this.spent += cost;
    return true;
  }
}
