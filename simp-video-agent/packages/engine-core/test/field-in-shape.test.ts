import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal } from '../src/journal/store';
import { fieldValues } from '../src/doc/fields';
import { REGISTRY } from '../src/registry/fields';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc } from './fixtures';

/**
 * 字段名必须属于该 shape（规范 §6：字段级约束的唯一真源是 FieldRegistry）。
 *
 * ★ 这一组测试是 TDD 的"红"那一步：`CommandErrorCode` 里早就定义了
 *   `field_not_in_shape`，`commands.ts` 的注释也写着"未登记的名字报 errored
 *   (field_not_in_shape)"，但**从来没有任何代码发出过它** —— 也没有测试。
 *   于是"FieldRegistry 是字段级约束的唯一真源"这句话，在写入路径上其实没有兑现：
 *   引擎会照单全收任何键名。
 *
 * 下面的断言先把【现状】钉住（未知键被接受且落盘），
 * 再加 expect 期望的行为 —— 这样缺口不会继续藏在注释里。
 */

function emptyDoc(): SceneDoc {
  const base = makeDoc(0);
  return { ...base, layers: [{ id: 'main', depth: 1, order: 1, parallax: 0.5, objects: [] }], objects: {}, effects: {} };
}

function clock(): () => number {
  let c = 1_700_000_000_000;
  return () => (c += 1000);
}

function run(commands: readonly Command[]): {
  errored: readonly string[];
  doc: SceneDoc;
  raw: ReturnType<typeof applyCommands>;
} {
  const journal = createJournal(emptyDoc(), { now: clock() });
  const res = applyCommands({ baseVersion: 0, commands }, {
    journal,
    budget: () => ({ imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 }),
    actor: 'user',
    now: clock(),
  });
  return { errored: res.errored.map((e) => e.error.code), doc: journal.currentDoc(), raw: res };
}

describe('create_object：未登记的字段名', () => {
  it('params 里的键必须在该 shape 的 registry 分组里（否则报 field_not_in_shape）', () => {
    const { errored, raw } = run([
      {
        op: 'create_object',
        localId: '$t1',
        shape: 'text',
        params: { content: '标题', 不存在的字段: 42 },
        owner: { kind: 'global' },
      },
    ]);
    expect(errored).toContain('field_not_in_shape');
    expect(raw.ok).toEqual([]);
  });

  it('style 里的键同样要登记（text 只有 size 与 fill）', () => {
    const { errored } = run([
      {
        op: 'create_object',
        localId: '$t1',
        shape: 'text',
        params: { content: '标题' },
        style: { size: 32, 颜色: '#fff' },
        owner: { kind: 'global' },
      },
    ]);
    expect(errored).toContain('field_not_in_shape');
  });

  it('未登记的 shape 也要报出来（引擎不认识它，就不该悄悄建出来）', () => {
    const { errored } = run([
      {
        op: 'create_object',
        localId: '$x1',
        shape: '不存在的形状',
        params: {},
        owner: { kind: 'global' },
      },
    ]);
    // 目前会报 unsupported_shape 或直接建出来 —— 都不该是"静默成功"
    expect(errored.length).toBeGreaterThan(0);
  });

  it('合法的 text 对象照旧能建（别把正常路径也堵了）', () => {
    const { errored, doc } = run([
      {
        op: 'create_object',
        localId: '$t1',
        shape: 'text',
        params: { content: '标题' },
        style: { size: 32, fill: '#e8eef8' },
        owner: { kind: 'global' },
      },
    ]);
    expect(errored).toEqual([]);
    expect(fieldValues(doc.objects['text#1']?.params ?? {})['content']).toBe('标题');
  });
});

describe('registry 里确实登记了 text 的字段（校验的依据）', () => {
  it('shape.text.params 有 content，shape.text.style 有字号/颜色/对齐/换行宽度', () => {
    const params = REGISTRY.groups.find((g) => g.id === 'shape.text.params');
    const style = REGISTRY.groups.find((g) => g.id === 'shape.text.style');
    expect(Object.keys(params?.fields ?? {})).toEqual(['content']);
    // 第十九轮加了 align / maxWidth（文字排版）—— 这条断言的价值就在于
    // "动 registry 的字段清单必须同时改这里"，免得加字段变成静默行为。
    expect(Object.keys(style?.fields ?? {}).sort()).toEqual(['align', 'bold', 'fill', 'maxWidth', 'size']);
  });

  it('每个 shape 分组都带 pathTemplate，校验器靠它生成 Issue.path', () => {
    const shapes = REGISTRY.groups.filter((g) => g.kind === 'shape');
    expect(shapes.length).toBeGreaterThan(0);
    for (const g of shapes) expect(g.pathTemplate).toContain('objects.*');
  });
});
