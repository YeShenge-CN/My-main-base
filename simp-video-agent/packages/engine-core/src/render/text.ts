/**
 * 文字排版：宽度估算、换行、行高。
 *
 * ★ 为什么排版【必须】在 engine-core 里算，而不是交给画笔：
 *   这个项目的铁律是"预览 = 成片"。文字一旦换行，**行的划分**就成了画面的一部分 ——
 *   如果让画笔（canvas / Chrome 两条路）各自去 measureText 再决定怎么折行，
 *   同一份文档在两个后端上会折出不同的行、给出不同的画面。
 *   所以折行、行数、行高、包围盒都在这一个纯函数模块里定下来，
 *   画笔只负责"按给定的行画"。
 *
 * ★ 估算刻意粗糙（罗马字母 0.55em、CJK 1.0em）：
 *   规范 §10 的顺序是"计算优先，视觉兜底"。0.55 > 实际拉丁字形宽度是**故意的** ——
 *   估宽偏大 → 折行偏早 → 永远不会溢出 maxWidth（宁可窄一点，不要压线）。
 */
import type { FieldAtom } from '../doc/types';

/** 全角（CJK / 假名 / 韩文 / 全角标点）判定：按 1em 估算。 */
export function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

/**
 * 文字宽度的估算，只服务于 AABB 与折行。
 *
 * 罗马字母按 0.55em、CJK 按 1.0em。**不追求像素级**：
 * 为了精确去量文本会把渲染器拖进求值路径（而求值必须纯、无宿主）。
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 1.0 : 0.55;
  return em * fontSize;
}

/** 行高 = 字号 × 它。一个常数，两条后端共用（画笔从 TextPlacement.lineHeight 取）。 */
export const TEXT_LINE_HEIGHT_RATIO = 1.25;

/**
 * 把一段文字切成【可折行的最小单位】。
 *
 * 规则（中英混排的常见情形）：
 *   · CJK 一个字一个单位（中文可以任意处断行）；
 *   · 拉丁字母 / 数字 / 连接成一个"词"，词内不断（除非一个词本身就超宽）；
 *   · 空格单独成一个单位（折行时丢掉行尾空格）。
 * 这样"CPU 是一个方块"会切成 ['CPU',' ','是','一','个','方','块']，
 * 折行不会把 CPU 劈成 C/P/U。
 */
export function splitTokens(text: string): readonly string[] {
  const out: string[] = [];
  let word = '';
  const flush = (): void => {
    if (word !== '') out.push(word);
    word = '';
  };
  for (const ch of text) {
    if (isWideCodePoint(ch.codePointAt(0) ?? 0)) {
      flush();
      out.push(ch);
    } else if (ch === ' ') {
      flush();
      out.push(' ');
    } else {
      word += ch;
    }
  }
  flush();
  return out;
}

/**
 * 折行。返回**至少一行**（空串也返回 ['']）。
 *
 * 口径：
 *   · 显式的 \n 【永远】断行（与 maxWidth 无关）—— 模型与人都习惯用它分段；
 *   · maxWidth <= 0 → 不自动折行（单行，但 \n 仍然生效）；
 *   · 自动折行是"贪心填满一行"：塞不下就换行；单个单位比 maxWidth 还宽时
 *     **硬切**（否则会得到一个比 maxWidth 宽得多的行，且永远不会换行）。
 *   · 行尾空格在折行时丢掉（否则包围盒会被看不见的空格撑宽）。
 */
export function wrapText(text: string, maxWidth: number, fontSize: number): readonly string[] {
  const paragraphs = text.split('\n');
  if (maxWidth <= 0) return paragraphs;

  const out: string[] = [];
  for (const para of paragraphs) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const token of splitTokens(para)) {
      const tokenWidth = estimateTextWidth(token, fontSize);
      if (lineWidth + tokenWidth <= maxWidth || line === '') {
        if (line === '' && tokenWidth > maxWidth) {
          // 单个单位就超宽（一个很长的英文单词 / 一长串数字）→ 按字符硬切
          let chunk = '';
          let chunkWidth = 0;
          for (const ch of token) {
            const w = estimateTextWidth(ch, fontSize);
            if (chunk !== '' && chunkWidth + w > maxWidth) {
              out.push(chunk);
              chunk = '';
              chunkWidth = 0;
            }
            chunk += ch;
            chunkWidth += w;
          }
          line = chunk;
          lineWidth = chunkWidth;
          continue;
        }
        line += token;
        lineWidth += tokenWidth;
        continue;
      }
      out.push(line.replace(/ +$/, ''));
      line = token === ' ' ? '' : token;
      lineWidth = token === ' ' ? 0 : tokenWidth;
    }
    out.push(line.replace(/ +$/, ''));
  }
  return out;
}

/** 一帧文字排版的结果（求值层把它塞进 TextPlacement，画笔逐行画）。 */
export interface TextLayout {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
}

/** 把内容 + 字号 + 最大宽度算成"几行、多宽、多高"。 */
export function layoutText(content: string, fontSize: number, maxWidth: number): TextLayout {
  const lines = wrapText(content, maxWidth, fontSize);
  let width = 0;
  for (const line of lines) width = Math.max(width, estimateTextWidth(line, fontSize));
  const lineHeight = fontSize * TEXT_LINE_HEIGHT_RATIO;
  return { lines, width, height: lines.length * lineHeight, lineHeight };
}

/** 从字段值里读对齐方式（非白名单值一律退回 center —— 与其它字段的容错口径一致）。 */
export function alignOf(raw: FieldAtom | undefined): 'left' | 'center' | 'right' {
  return raw === 'left' || raw === 'right' ? raw : 'center';
}
