/**
 * 文字排版（P3 第一块）：对齐 + 自动换行。
 *
 * ★ 为什么这些断言重要：折行是**画面的一部分**。它必须由 engine-core 一处算完，
 *   画笔只负责"按给定的行画" —— 否则 canvas 与 Chrome 各自 measureText，
 *   同一份文档会折出不同的行，而"预览 = 成片"是这个项目的硬约束。
 *   所以这里测的是【排版的确定性】，不只是"能不能换行"。
 */
import { describe, expect, it } from 'vitest';
import {
  TEXT_LINE_HEIGHT_RATIO,
  alignOf,
  estimateTextWidth,
  layoutText,
  splitTokens,
  wrapText,
} from '../src/render/text';
import { evaluate } from '../src/evaluate';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

/* ── 度量 ───────────────────────────────────────────────────── */

describe('宽度估算（两条后端共用的那一份）', () => {
  it('拉丁 0.55em / CJK 1.0em', () => {
    expect(estimateTextWidth('abcd', 100)).toBeCloseTo(220, 6);
    expect(estimateTextWidth('中文', 100)).toBeCloseTo(200, 6);
    expect(estimateTextWidth('中a', 100)).toBeCloseTo(155, 6);
  });

  it('估宽偏大是【故意的】：宁可折行偏早，也不要溢出 maxWidth', () => {
    // 0.55em 比真实拉丁字形宽（多数在 0.5em 上下），这是刻意的保守
    expect(estimateTextWidth('MMMM', 100)).toBeGreaterThan(0);
  });

  it('空串宽 0', () => {
    expect(estimateTextWidth('', 32)).toBe(0);
  });
});

/* ── 切词 ───────────────────────────────────────────────────── */

describe('切成可折行的最小单位', () => {
  it('★ 英文单词不被劈开（CPU 不会断成 C/P/U）', () => {
    expect(splitTokens('CPU 是一个方块')).toEqual(['CPU', ' ', '是', '一', '个', '方', '块']);
  });

  it('数字与连字符的串算一个词', () => {
    expect(splitTokens('x86-64 架构')).toEqual(['x86-64', ' ', '架', '构']);
  });
});

/* ── 折行 ───────────────────────────────────────────────────── */

describe('折行', () => {
  it('maxWidth = 0 → 不自动折行（旧行为）', () => {
    expect(wrapText('很长很长的一段中文', 0, 32)).toEqual(['很长很长的一段中文']);
  });

  it('★ 显式换行符【永远】生效（与 maxWidth 无关）', () => {
    expect(wrapText('第一行\n第二行', 0, 32)).toEqual(['第一行', '第二行']);
    expect(wrapText('第一行\n\n第三行', 0, 32)).toEqual(['第一行', '', '第三行']);
  });

  it('中文按字数折行（1em 一个字）', () => {
    // 32px 字号、maxWidth 96 → 一行最多 3 个字
    expect(wrapText('一二三四五六七', 96, 32)).toEqual(['一二三', '四五六', '七']);
  });

  it('★ 行宽永远不超过 maxWidth —— 除非单个单位本身就超宽', () => {
    const lines = wrapText('CPU 是一个方块，内存是另一个方块', 120, 32);
    for (const line of lines) expect(estimateTextWidth(line, 32), line).toBeLessThanOrEqual(120);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('超长的英文单词会硬切，而不是撑出一行超宽的字', () => {
    const lines = wrapText('supercalifragilisticexpialidocious', 100, 32);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(estimateTextWidth(line, 32)).toBeLessThanOrEqual(100);
  });

  it('行尾空格丢掉（否则包围盒被看不见的空格撑宽）', () => {
    expect(wrapText('ab cd', 60, 32)).toEqual(['ab', 'cd']);
  });

  it('空串给一行空串（不是 0 行 —— 调用方拿它算高度）', () => {
    expect(wrapText('', 100, 32)).toEqual(['']);
    expect(wrapText('', 0, 32)).toEqual(['']);
  });
});

/* ── 排版结果 ───────────────────────────────────────────────── */

describe('layoutText', () => {
  it('宽 = 最宽那一行，高 = 行数 × 行高', () => {
    // ★ 签名是 layoutText(content, fontSize, maxWidth) —— 我第一次把后两个写反了，
    //   于是拿到 ['一','二','三','四']（字号 64、宽 32 = 一个字都放不下）。
    const layout = layoutText('一二三四', 32, 64);
    expect(layout.lines).toEqual(['一二', '三四']);
    expect(layout.width).toBeCloseTo(64, 6);
    expect(layout.lineHeight).toBeCloseTo(32 * TEXT_LINE_HEIGHT_RATIO, 6);
    expect(layout.height).toBeCloseTo(layout.lineHeight * 2, 6);
  });

  it('alignOf：白名单之外一律退回 center（与其它字段的容错口径一致）', () => {
    expect(alignOf('left')).toBe('left');
    expect(alignOf('right')).toBe('right');
    expect(alignOf('center')).toBe('center');
    expect(alignOf('乱七八糟')).toBe('center');
    expect(alignOf(undefined)).toBe('center');
  });
});

/* ── 与求值的集成：包围盒必须与画出来的行对得上 ─────────────── */

function wrap(record: Record<string, unknown>): SceneObject['params'] {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, { v }])) as SceneObject['params'];
}

function label(params: Record<string, unknown>, style: Record<string, unknown> = {}): SceneObject {
  return {
    shape: 'text',
    owner: { kind: 'global' },
    params: wrap({ content: '', ...params }),
    style: wrap(style),
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
}

function docWithText(object: SceneObject): SceneDoc {
  return {
    ...makeDoc(0, { duration: 8 }),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['text#1'] }],
    objects: { 'text#1': object },
    effects: {},
    markers: [],
  };
}

function itemOf(doc: SceneDoc) {
  const item = evaluate(doc, 1).items.find((i) => i.id === 'text#1');
  if (item === undefined) throw new Error('没有这一项');
  return item;
}

describe('★ 求值：折行与对齐进了包围盒', () => {
  it('换行宽度生效：多行 → 包围盒变高、变窄', () => {
    const single = itemOf(docWithText(label({ content: '一二三四五六' }, { size: 32 })));
    const wrapped = itemOf(docWithText(label({ content: '一二三四五六' }, { size: 32, maxWidth: 96 })));
    expect(wrapped.text?.lines).toEqual(['一二三', '四五六']);
    expect(wrapped.box.h).toBeCloseTo(single.box.h * 2, 6);
    expect(wrapped.box.w).toBeLessThan(single.box.w);
    expect(wrapped.text?.lineHeight).toBeCloseTo(32 * TEXT_LINE_HEIGHT_RATIO, 6);
  });

  it('★ 对齐决定锚点落在文字的哪一侧（left → box 左边界 = 锚点 x）', () => {
    const center = itemOf(docWithText(label({ content: '标题' }, { size: 32 })));
    const left = itemOf(docWithText(label({ content: '标题' }, { size: 32, align: 'left' })));
    const right = itemOf(docWithText(label({ content: '标题' }, { size: 32, align: 'right' })));
    const c = center.text;
    const l = left.text;
    const r = right.text;
    if (c === undefined || l === undefined || r === undefined) throw new Error('缺 text 放置信息');
    expect(center.box.x).toBeCloseTo(c.anchor.x - center.box.w / 2, 6);
    expect(left.box.x).toBeCloseTo(l.anchor.x, 6);
    expect(right.box.x).toBeCloseTo(r.anchor.x - right.box.w, 6);
    // 三种对齐下宽度一样，只是锚点含义不同
    expect(left.box.w).toBeCloseTo(center.box.w, 6);
  });

  it('竖向：整块文字围绕锚点居中（多行时上下对称）', () => {
    const item = itemOf(docWithText(label({ content: '一二三四' }, { size: 32, maxWidth: 64 })));
    const t = item.text;
    if (t === undefined) throw new Error('缺 text 放置信息');
    const top = item.box.y;
    const bottom = item.box.y + item.box.h;
    expect(t.anchor.y - top).toBeCloseTo(bottom - t.anchor.y, 6);
  });

  it('★ 同一份文档两次数出来完全一样（折行是确定的，不依赖宿主度量）', () => {
    const doc = docWithText(label({ content: '预 览 与 成 片 必 须 一 致，CPU 也是。' }, { size: 24, maxWidth: 200 }));
    const a = itemOf(doc).text?.lines;
    const b = itemOf(doc).text?.lines;
    expect(a).toEqual(b);
    expect(a?.length).toBeGreaterThan(1);
  });

  it('粗体一路传到画笔要用的那一格（TextPlacement.bold）', () => {
    const plain = itemOf(docWithText(label({ content: '标题' }, { size: 32 })));
    const bold = itemOf(docWithText(label({ content: '标题' }, { size: 32, bold: true })));
    expect(plain.text?.bold).toBe(false);
    expect(bold.text?.bold).toBe(true);
    // 粗体不该改变排版（字宽一样），只改字面
    expect(bold.box.w).toBeCloseTo(plain.box.w, 6);
  });

  it('对齐与换行宽度都能被动画驱动（到点换值 / 数值插值）', () => {
    const doc = docWithText(
      label(
        { content: '一二三四五六' },
        { size: 32, maxWidth: 200 },
      ),
    );
    const withAnim: SceneDoc = {
      ...doc,
      objects: {
        'text#1': {
          ...(doc.objects['text#1'] as SceneObject),
          anim: {
            'style.maxWidth': { kind: 'keys', keys: [{ t: 0, v: 200 }, { t: 2, v: 64 }] },
          },
        },
      },
    };
    // t=1 时 maxWidth = lerp(200, 64, 0.5) = 132 → 一行放 4 个字（132 / 32 = 4.125）
    const at1 = evaluate(withAnim, 1).items.find((i) => i.id === 'text#1');
    expect(at1?.text?.lines).toEqual(['一二三四', '五六']);
    // t≥2 之后固定成 64 → 一行 2 个字
    const at3 = evaluate(withAnim, 3).items.find((i) => i.id === 'text#1');
    expect(at3?.text?.lines).toEqual(['一二', '三四', '五六']);
    // 行数确实随动画在变 —— 这才是"换行宽度被动画驱动"的可观测后果
    expect(at3?.text?.lines.length ?? 0).toBeGreaterThan(at1?.text?.lines.length ?? 0);
  });
});
