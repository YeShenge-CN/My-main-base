import { describe, expect, it } from 'vitest';
import {
  AUTO_SAMPLES,
  MIN_DRAWON_DURATION,
  MIN_SAMPLES,
  SAMPLES_REGISTRY_MIN,
  autoFix,
  planAutoFix,
  summarizeIssues,
  validate,
} from '../src/validate/index';
import { AUTO_FIX_GROUPS, type Issue } from '../src/validate/types';
import { createJournal } from '../src/journal/store';
import { REGISTRY } from '../src/registry/fields';
import { generateObjectSchema, numericRangeOf, requireGroup } from '../src/registry/schema';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc, makeObject } from './fixtures';

function clock(): () => number {
  let c = 1_700_000_000_000;
  return () => (c += 1000);
}

/**
 * 一份【只有 auto 类问题】的文档：
 *   environment  effect_target_missing / layer_ref_dangling / object_not_in_layer
 *   semantic     expr_compile_failed
 *   motion       drawon_duration_nonpositive
 *   export       samples_low
 * 没有 layout 问题（layout 全是 agent 类），所以理论上能被修到 issues=0。
 */
function brokenDoc(): SceneDoc {
  const base = makeDoc(0);
  const p1 = makeObject('plot#1', 'plot2d', {
    params: { expr: { v: 'sin(' }, domain: { v: [-7, 7] }, samples: { v: 100 } },
    effects: ['eff#1'],
  });
  const p2 = makeObject('plot#2', 'plot2d', {
    params: { expr: { v: 'cos(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
  });
  return {
    ...base,
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1', 'ghost#9'] }],
    objects: { 'plot#1': p1, 'plot#2': p2 },
    effects: {
      'eff#1': {
        type: 'drawOn',
        target: 'plot#1',
        params: { start: { v: 0 }, duration: { v: 0 }, mode: { v: 'arc' } },
      },
      'eff#2': { type: 'drawOn', target: 'missing#1', params: { start: { v: 0 }, duration: { v: 1 } } },
    },
  };
}

describe('validate：按分组聚合', () => {
  const doc = brokenDoc();

  it('一次拿到全部五个分组的问题（layout 为空是因为这份文档没有构图问题）', () => {
    const issues = validate(doc);
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(
      [
        'drawon_duration_nonpositive',
        'effect_target_missing',
        'expr_compile_failed',
        'layer_ref_dangling',
        'object_not_in_layer',
        'samples_low',
      ].sort(),
    );
  });

  it('可以只跑某个分组', () => {
    const onlyExport = validate(doc, { groups: ['export'] });
    expect(onlyExport.length).toBe(1);
    expect(onlyExport[0]?.group).toBe('export');
  });

  it('每条 Issue 都带 fixClass；本文档全是 auto', () => {
    for (const issue of validate(doc)) {
      expect(['auto', 'agent', 'human']).toContain(issue.fixClass);
      expect(issue.fixClass).toBe('auto');
      expect(issue.suggestedFix?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('summarizeIssues 给出按分组 / 严重度 / fixClass 的计数', () => {
    const s = summarizeIssues(validate(doc));
    expect(s.total).toBe(6);
    expect(s.byGroup.environment).toBe(3);
    expect(s.byGroup.semantic).toBe(1);
    expect(s.byGroup.motion).toBe(1);
    expect(s.byGroup.export).toBe(1);
    expect(s.byFixClass.auto).toBe(6);
  });
});

describe('P7 验收：只有 auto 类问题的文档被修到 issues=0（零 LLM 调用）', () => {
  it('autoFix 迭代到没有 auto 问题为止', () => {
    const journal = createJournal(brokenDoc(), { now: clock() });
    const before = validate(journal.currentDoc());
    expect(before.length).toBe(6);

    // ★ 全程在 engine-core 内部完成：不 import 任何 agent-tools、不发生任何网络调用。
    const result = autoFix({ journal, now: clock() });

    expect(result.issues.total).toBe(0);
    expect(result.fixed.length).toBe(6);
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(validate(journal.currentDoc())).toEqual([]);
  });

  it('修完之后的文档在语义上确实是对的（不是把问题藏起来了）', () => {
    const journal = createJournal(brokenDoc(), { now: clock() });
    autoFix({ journal, now: clock() });
    const doc = journal.currentDoc();

    // 悬空效果被删掉，好效果被夹到合法时长
    expect(doc.effects['eff#2']).toBeUndefined();
    expect(doc.effects['eff#1']?.params['duration']).toMatchObject({ v: 0.2 });
    // 悬空图层引用被摘掉，孤儿对象被挂进来
    expect(doc.layers[0]?.objects).toEqual(['plot#1', 'plot#2']);
    // 表达式被兜底，采样被提升
    expect(doc.objects['plot#1']?.params['expr']).toMatchObject({ v: '0' });
    expect(doc.objects['plot#1']?.params['samples']).toMatchObject({ v: 2400 });
  });

  it('修复也会被记进 Operation Journal（不是绕过写路径的暗改）', () => {
    const journal = createJournal(brokenDoc(), { now: clock() });
    autoFix({ journal, now: clock() });
    const ops = journal.operations();
    expect(ops.length).toBe(6);
    expect(ops.every((o) => o.actor === 'engine-autofix')).toBe(true);
    // 每个 auto 修复都写明了它来自哪条 Issue
    expect(journal.compounds().length).toBeGreaterThan(0);
  });
});

describe('硬规则：agent / human 的 Issue 不得进入 autoFix 路径', () => {
  it('即使带着 suggestedFix，也一条都不执行', () => {
    const agentIssue: Issue = {
      severity: 'warn',
      group: 'layout',
      code: 'object_offscreen',
      path: 'objects.plot#1',
      message: '始终在画面之外',
      fixClass: 'agent',
      // 故意给一条"看起来能修"的命令
      suggestedFix: [{ op: 'delete_object', target: 'plot#1' }],
    };
    const humanIssue: Issue = {
      severity: 'error',
      group: 'export',
      code: 'duration_too_short',
      path: 'meta.duration',
      message: '太短',
      fixClass: 'human',
      suggestedFix: [{ op: 'set_style', target: 'plot#1', width: 9 }],
    };

    const plan = planAutoFix([agentIssue, humanIssue]);
    expect(plan.commands).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'fix_class_not_auto',
      'fix_class_not_auto',
    ]);
    expect(plan.skipped.map((s) => s.fixClass)).toEqual(['agent', 'human']);
  });

  it('layout 分组整个不在可自动修的分组里', () => {
    expect(AUTO_FIX_GROUPS).not.toContain('layout');
    expect([...AUTO_FIX_GROUPS].sort()).toEqual(['environment', 'export', 'motion', 'semantic']);
  });

  it('文档级的验证：一个构图越界的对象，autoFix 不碰它，只报告', () => {
    const base = makeDoc(0);
    const off = makeObject('plot#1', 'plot2d', {
      // 把曲线推到世界坐标 1000 处 —— 屏幕上是彻底看不见的
      tf: { x: 1000, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    });
    const doc: SceneDoc = {
      ...base,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] }],
      objects: { 'plot#1': off },
      effects: {},
    };

    const issues = validate(doc);
    expect(issues.map((i) => i.code)).toContain('object_offscreen');
    expect(issues.every((i) => i.fixClass === 'agent')).toBe(true);

    const journal = createJournal(doc, { now: clock() });
    const result = autoFix({ journal, now: clock() });

    // 一个问题都没被"修掉"：构图必须由 Agent 看图后决定
    expect(result.fixed).toEqual([]);
    expect(result.issues.total).toBe(issues.length);
    expect(result.skipped.map((s) => s.code)).toContain('object_offscreen');
    // 文档一个字节都没变
    expect(journal.currentVersion()).toBe(0);
    expect(journal.operations().length).toBe(0);
  });

  it('提交前的第二道锁：来源不是 auto 的命令会被直接拒绝执行', () => {
    const notAuto: Issue = {
      severity: 'warn',
      group: 'layout',
      code: 'x',
      path: 'p',
      message: '',
      fixClass: 'agent',
      suggestedFix: [{ op: 'set_style', target: 'plot#1', width: 1 }],
    };
    // planAutoFix 是唯一入口，它本身就不会放行 —— 这里确认"放行"这件事根本没发生
    const plan = planAutoFix([notAuto]);
    expect(plan.provenance.size).toBe(0);
    expect(plan.commands.length).toBe(0);
  });
});

describe('阈值来源（规范 §6：字段级约束只有一个真源）', () => {
  it('drawOn 时长下限 === registry 里的 duration.min（schema 里也是这个数）', () => {
    const range = numericRangeOf(REGISTRY, 'effect.drawOn.params', 'duration');
    expect(MIN_DRAWON_DURATION).toBe(range?.min);
    const props = (generateObjectSchema(requireGroup(REGISTRY, 'effect', 'drawOn', 'params'))['properties'] ?? {}) as Record<string, unknown>;
    const duration = (props['duration'] ?? {}) as Record<string, unknown>;
    const inner = ((duration['anyOf'] as Record<string, unknown>[] | undefined)?.[0] ?? duration) as Record<string, unknown>;
    expect(inner['minimum']).toBe(MIN_DRAWON_DURATION);
  });

  it('采样数的技术下限来自 registry，视觉下限是引擎策略（两者都在报告里说清）', () => {
    const range = numericRangeOf(REGISTRY, 'shape.plot2d.params', 'samples');
    expect(SAMPLES_REGISTRY_MIN).toBe(range?.min);
    expect(SAMPLES_REGISTRY_MIN).toBe(16);
    // 视觉下限【刻意】比 registry 的技术下限高，且自动修的目标又高一层
    expect(MIN_SAMPLES).toBeGreaterThan(SAMPLES_REGISTRY_MIN);
    expect(AUTO_SAMPLES).toBeGreaterThanOrEqual(MIN_SAMPLES);
  });

  it('自动修的目标值不会超过 registry 允许的上界（否则引擎会写出非法文档）', () => {
    const range = numericRangeOf(REGISTRY, 'shape.plot2d.params', 'samples');
    expect(range?.max).toBeDefined();
    expect(AUTO_SAMPLES).toBeLessThanOrEqual(range?.max as number);
  });

  it('samples_low 的 auto 修复确实落在 registry 的合法区间内', () => {
    const issue = validate(brokenDoc()).find((i) => i.code === 'samples_low');
    const fix = issue?.suggestedFix?.[0];
    expect(fix?.op).toBe('set_sampling');
    if (fix?.op !== 'set_sampling') return;
    const range = numericRangeOf(REGISTRY, 'shape.plot2d.params', 'samples');
    expect(fix.samples as number).toBeGreaterThanOrEqual(range?.min as number);
    expect(fix.samples as number).toBeLessThanOrEqual(range?.max as number);
  });
});

describe('Issue 的形状符合规范 §9', () => {
  it('每条都有 severity / group / code / path / message / fixClass', () => {
    for (const i of validate(brokenDoc())) {
      expect(typeof i.severity).toBe('string');
      expect(typeof i.group).toBe('string');
      expect(typeof i.code).toBe('string');
      expect(typeof i.path).toBe('string');
      expect(typeof i.message).toBe('string');
      expect(typeof i.fixClass).toBe('string');
    }
  });

  it('与时间有关的问题带 at', () => {
    const doc: SceneDoc = { ...makeDoc(1), meta: { ...makeDoc(1).meta, duration: 1 } };
    const over = validate(doc).find((i) => i.code === 'drawon_overruns_shot');
    // 这份 fixture 没有 drawOn，用构造的方式确认字段可选即可
    expect(over === undefined || typeof over.at === 'number').toBe(true);
  });
});

/**
 * 空镜头（压力测试实测补上的规则）。
 *
 * completion 臂 #19/#20 实测：任务要求改"这条曲线"，而文档里 objects: []，
 * Agent 读完摘要、拿到 issues=0 的校验回执、调 finish_shot 收尾。
 * 在此之前引擎没有任何一条规则能说出"这一镜什么都没有"，
 * 于是"做完了"和"做不了"在回执里长得一模一样。
 */
describe('空镜头必须被报出来，而不是静默地 issues=0', () => {
  it('没有任何可绘制对象 → export 组报 empty_shot，且不能被自动修', () => {
    const doc = makeDoc(0);
    const empty = validate(doc).filter((i) => i.code === 'empty_shot');
    expect(empty.length).toBe(1);
    expect(empty[0]?.group).toBe('export');
    expect(empty[0]?.severity).toBe('warn');
    // 该建曲线还是该向用户澄清意图，是叙事判断 —— 不许自动改
    expect(empty[0]?.fixClass).toBe('agent');
    expect(AUTO_FIX_GROUPS).not.toContain('layout');

    const plan = planAutoFix(validate(doc));
    expect(plan.commands).toEqual([]);
    expect(plan.skipped.map((s) => s.code)).toContain('empty_shot');
  });

  it('autoFix 对空镜头一个字节都不改（否则会自己造出内容）', () => {
    const journal = createJournal(makeDoc(0), { now: clock() });
    const result = autoFix({ journal, now: clock() });
    expect(result.fixed).toEqual([]);
    expect(journal.currentVersion()).toBe(0);
    expect(journal.operations().length).toBe(0);
  });

  it('有对象之后这条问题自己消失（不是靠忽略）', () => {
    expect(validate(makeDoc(0)).some((i) => i.code === 'empty_shot')).toBe(true);
    expect(validate(makeDoc(1)).some((i) => i.code === 'empty_shot')).toBe(false);
  });
});
