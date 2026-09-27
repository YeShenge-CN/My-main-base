/**
 * layout 组的【表现层】自检（第二十九轮，§0.28 作业 1a）。
 *
 * ★ 为什么单独一份：在这一轮之前，layout 只有两条判据（整段都在画外 / 整段都太小），
 *   而「文字出画 / 被裁 / 字号太小 / 两个元素压在一起」一条都报不出来。
 *   于是 Agent 的自检只能回答「引擎与形状对不对」，回答不了「画得对不对」。
 *
 * ★★ 这一份里最重要的是【第一条】：一份本来合格的文档必须一条都不报。
 *   假阳性的代价在这个项目里特别高 —— 模型会照着它去改一份本来没问题的文档，
 *   而 §0.28 作业 1 的验收第 2 条正是「已经合格时不许瞎改」。
 */
import { describe, expect, it } from 'vitest';
import { validate } from '../src/validate/index';
import { AUTO_FIX_GROUPS } from '../src/validate/types';
import {
  MAX_CLIPPED_FRACTION,
  MIN_FORMULA_FONT_SIZE_PX,
  MIN_OVERLAP_RATIO,
  MIN_READABLE_FONT_SIZE_PX,
  SAFE_MARGIN_PX,
} from '../src/validate/validators';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { makeDoc } from './fixtures';

/** 一个居中的文字对象。viewport 1920×1080 / world 16×9 ⇒ 1 世界单位 = 120px。 */
function textObject(id: string, over: Partial<SceneObject> = {}, style: Record<string, unknown> = {}): SceneObject {
  return {
    shape: 'text',
    owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
    params: { content: { v: '标题' } },
    style: { size: { v: 32 }, fill: { v: '#e8eef8' }, ...style },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function docWith(objects: readonly SceneObject[]): SceneDoc {
  const base = makeDoc(0);
  const byId: Record<string, SceneObject> = {};
  for (const [i, o] of objects.entries()) byId['o#' + (i + 1)] = o;
  return {
    ...base,
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: Object.keys(byId) }],
    objects: byId,
    effects: {},
  };
}

/** 只取这一组的问题，方便逐条断言。 */
function layoutCodes(doc: SceneDoc): readonly string[] {
  return validate(doc, { groups: ['layout'] }).map((i) => i.code);
}

describe('★ 合格的文档必须一条都不报（防假阳性）', () => {
  it('一个居中的 32px 标题', () => {
    expect(layoutCodes(docWith([textObject('o#1')]))).toEqual([]);
  });

  it('两行文字上下排开、彼此不压', () => {
    const a = textObject('o#1', { tf: { x: 0, y: 0.6, rotate: 0, sx: 1, sy: 1, opacity: 1 } });
    const b = textObject('o#2', { tf: { x: 0, y: -0.6, rotate: 0, sx: 1, sy: 1, opacity: 1 } });
    expect(layoutCodes(docWith([a, b]))).toEqual([]);
  });
});

describe('① 字号太小', () => {
  it('8px 的文字被报 text_too_small，并说清下限', () => {
    const issues = validate(docWith([textObject('o#1', {}, { size: { v: 8 } })]), { groups: ['layout'] });
    const issue = issues.find((i) => i.code === 'text_too_small');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('8px');
    expect(issue?.message).toContain(String(MIN_READABLE_FONT_SIZE_PX));
    expect(issue?.fixClass).toBe('agent');
  });

  it('刚好到下限不报（边界）', () => {
    expect(layoutCodes(docWith([textObject('o#1', {}, { size: { v: MIN_READABLE_FONT_SIZE_PX } })]))).toEqual([]);
  });

  /**
   * ★★ 这一条是【防假阳性】的核心：在 1920 宽的画布上，旧的"太小"判据
   *   （边长占比 < 0.02）等于 38px —— 一行 18px 的注释会被它误报成"几乎看不见"。
   *   文字的可读性由字号决定，不由它占多少屏幕决定。
   */
  it('★ 小字号但可读的标注【不该】被报 object_too_small', () => {
    const caption = textObject('o#1', { tf: { x: 0, y: -3.6, rotate: 0, sx: 1, sy: 1, opacity: 1 } }, { size: { v: 18 } });
    expect(layoutCodes(docWith([caption]))).toEqual([]);
  });

  it('公式的下限更高', () => {
    // 只断言常数关系本身：公式下限 > 文字下限（更密的字形更难认）
    expect(MIN_FORMULA_FONT_SIZE_PX).toBeGreaterThan(MIN_READABLE_FONT_SIZE_PX);
  });
});

describe('② 被画布边缘裁掉', () => {
  it('一半在画外的标题被报 text_clipped', () => {
    // tf.x = 8 世界单位 = 960px → 盒子从 1888 到 1952，右半 32px 在画外
    const off = textObject('o#1', { tf: { x: 8, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 } });
    const issues = validate(docWith([off]), { groups: ['layout'] });
    const issue = issues.find((i) => i.code === 'text_clipped');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('%');
    expect(issue?.fixClass).toBe('agent');
    // 它【不该】同时被报成完全出画（那是另一条判据的事）
    expect(issues.map((i) => i.code)).not.toContain('object_offscreen');
  });

  it('容差之内不报（抗锯齿与斜体溢出不该变成缺陷）', () => {
    expect(MAX_CLIPPED_FRACTION).toBeGreaterThan(0);
    // 完全在画内 → 没有 clip 问题
    expect(layoutCodes(docWith([textObject('o#1')]))).toEqual([]);
  });
});

describe('③ 贴边（完全在画内但离边缘太近）', () => {
  it('离边缘 16px 的标题被报 text_in_safe_margin', () => {
    // tf.x = 7.6 → 盒子右边界离画布右边 16px（< 24）
    const near = textObject('o#1', { tf: { x: 7.6, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 } });
    const issues = validate(docWith([near]), { groups: ['layout'] });
    const issue = issues.find((i) => i.code === 'text_in_safe_margin');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain(String(SAFE_MARGIN_PX));
    expect(issue?.severity).toBe('info');
  });
});

describe('④ 两个可读元素压在一起', () => {
  it('两段文字完全重合被报 text_overlap，并点名两个 id', () => {
    const a = textObject('o#1');
    const b = textObject('o#2');
    const issues = validate(docWith([a, b]), { groups: ['layout'] });
    const issue = issues.find((i) => i.code === 'text_overlap');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('o#1');
    expect(issue?.message).toContain('o#2');
    expect(MIN_OVERLAP_RATIO).toBeGreaterThan(0);
  });

  it('★ 看不见的对象不参与重叠判定（透明度 0）', () => {
    const a = textObject('o#1');
    const hidden = textObject('o#2', { tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 0 } });
    expect(layoutCodes(docWith([a, hidden]))).toEqual([]);
  });
});

describe('★ 新问题全部是 agent 类，绝不进 autoFix', () => {
  it('group=layout、fixClass=agent、且 layout 不在可自动修的分组里', () => {
    const doc = docWith([textObject('o#1', {}, { size: { v: 8 } })]);
    const issues = validate(doc, { groups: ['layout'] });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.group === 'layout')).toBe(true);
    expect(issues.every((i) => i.fixClass === 'agent')).toBe(true);
    expect(AUTO_FIX_GROUPS).not.toContain('layout');
  });
});

describe('回归：老的两条判据行为不变', () => {
  it('整段都在画外的对象仍然报 object_offscreen', () => {
    const far = textObject('o#1', { tf: { x: 900, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 } });
    expect(layoutCodes(docWith([far]))).toContain('object_offscreen');
  });

  it('整段都小到看不见的【曲线】仍然报 object_too_small', () => {
    // 域宽 0.001 世界单位 ≈ 0.12px —— 屏幕上就是一个点
    const tinyPlot: SceneObject = {
      shape: 'plot2d',
      owner: { kind: 'scene', sceneId: 's1', bornAt: 0 },
      params: { expr: { v: 'x' }, domain: { v: [0, 0.001] }, samples: { v: 2400 } },
      style: { stroke: { v: '#4ea1ff' }, width: { v: 3 } },
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {},
      effects: [],
    };
    expect(layoutCodes(docWith([tinyPlot]))).toContain('object_too_small');
  });
});
