/**
 * 命令词汇表（`SCHEMA_OPS`）：schema 里没有的 op，一条都不许进引擎。
 *
 * ★ 这一份来自一次实测失败：用户说「删除当前内容从零开始」，模型一次提交了
 *   `[remove_object, delete_object, delete, remove, clear]` ——
 *   而 `delete_object` 当时【在引擎里有、在工具表里没有】，于是它猜对了的那一条
 *   **悄悄生效了**（删掉了 plot#1），另外 4 条报 unsupported_op。
 *   一半生效一半报错：既不像成功也不像失败，模型和人两边都看不懂。
 *
 * 现在两件事同时成立：
 *   1. `delete_object` 正大光明地进了工具表（模型有真正的删除能力）；
 *   2. 没进表的东西**猜也猜不生效** —— schema 就是可执行命令的白名单。
 */
import { describe, expect, it } from 'vitest';
import { createJournal, type SceneDoc, type SceneObject } from '@sva/engine-core';
import { BudgetTracker, DEFAULT_LIMITS } from '../src/budget';
import { dispatchTool, SCHEMA_OPS, TOOLS, type ToolContext } from '../src/tools';

function rect(): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: ['eff#1'],
  };
}

function doc(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 8, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1'] }],
    objects: { 'rect#1': rect() },
    effects: { 'eff#1': { type: 'drawOn', target: 'rect#1', params: { start: { v: 0 }, duration: { v: 1 } } } },
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

function makeCtx(): ToolContext {
  const journal = createJournal(doc(), { now: () => 1_700_000_000_000 });
  return {
    doc: () => journal.currentDoc(),
    journal,
    budget: new BudgetTracker('shot-1', DEFAULT_LIMITS),
    baseVersion: () => journal.currentVersion(),
    turnId: 'turn-1',
    render: () => {
      throw new Error('这一份测试不渲染');
    },
    now: () => 1_700_000_000_000,
  };
}

/** ★ dispatchTool 是 async 的（踩过：忘了 await 会拿到 undefined.text）。 */
async function call(ctx: ToolContext, commands: readonly unknown[]): Promise<Record<string, unknown>> {
  const out = await dispatchTool('apply_commands', { commands, baseVersion: ctx.baseVersion() }, ctx);
  return JSON.parse(out.text) as Record<string, unknown>;
}

describe('delete_object 现在在工具表里（以前只能靠猜）', () => {
  it('分支存在，字段恰好 op / target', () => {
    const params = TOOLS.find((t) => t.name === 'apply_commands')?.parameters as Record<string, unknown>;
    const branches = (((params['properties'] as Record<string, unknown>)['commands'] as Record<string, unknown>)['items'] as Record<string, unknown>)['anyOf'] as Record<string, unknown>[];
    const opOf = (b: Record<string, unknown>): string | undefined => {
      const props = b['properties'] as Record<string, Record<string, string[]> | undefined> | undefined;
      return props?.['op']?.['enum']?.[0];
    };
    const branch = branches.find((b) => opOf(b) === 'delete_object');
    expect(branch, '缺少 delete_object 分支').toBeDefined();
    expect(Object.keys((branch?.['properties'] ?? {}) as object).sort()).toEqual(['op', 'target']);
    // 描述里必须写清「删完 id 就失效」—— 实测里模型删完又去 get_object 同一个 id
    expect(JSON.stringify(branch)).toContain('失效');
  });

  it('★ 白名单与 schema 逐字一致（推导出来的，不手写第二份）', () => {
    const params = TOOLS.find((t) => t.name === 'apply_commands')?.parameters as Record<string, unknown>;
    const branches = (((params['properties'] as Record<string, unknown>)['commands'] as Record<string, unknown>)['items'] as Record<string, unknown>)['anyOf'] as Record<string, unknown>[];
    const fromSchema = branches.map((b) => {
      const props = b['properties'] as Record<string, Record<string, string[]> | undefined> | undefined;
      return (props?.['op']?.['enum'] ?? [])[0];
    });
    expect([...SCHEMA_OPS]).toEqual(fromSchema);
    expect(SCHEMA_OPS).toContain('delete_object');
  });
});

describe('★ 猜出来的命令不许碰巧生效', () => {
  it('引擎里有、工具表里没有的 op（delete_effect）→ 当场拒，并给出完整清单', async () => {
    const ctx = makeCtx();
    const res = await call(ctx, [{ op: 'delete_effect', target: 'eff#1' }]);
    expect(res['error']).toBe('unknown_op');
    expect(String(res['message'])).toContain('delete_effect');
    expect(String(res['message'])).toContain('delete_object');
    expect(res['validOps']).toEqual([...SCHEMA_OPS]);
    // 引擎一点没动
    expect(Object.keys(ctx.doc().effects)).toEqual(['eff#1']);
  });

  it('★ 混合批次（1 条合法 + 1 条编造）→ 整批拒掉，一条都不生效', async () => {
    const ctx = makeCtx();
    const before = ctx.baseVersion();
    const res = await call(ctx, [{ op: 'delete_object', target: 'rect#1' }, { op: 'clear', target: 'rect#1' }]);
    expect(res['error']).toBe('unknown_op');
    expect(ctx.doc().objects['rect#1'], '半批生效了 —— 这正是最难查的那种失败').toBeDefined();
    expect(ctx.baseVersion()).toBe(before);
  });

  it('合法的删除照常生效，且回执里报出成功条数（判据要用它）', async () => {
    const ctx = makeCtx();
    const res = await call(ctx, [{ op: 'delete_object', target: 'rect#1' }]);
    expect((res['ok'] as unknown[]).length).toBe(1);
    expect(ctx.doc().objects['rect#1']).toBeUndefined();
    expect(ctx.doc().layers[0]?.objects).toEqual([]);
  });

  it('删不存在的对象 → unknown_target（错误信息里带 id）', async () => {
    const ctx = makeCtx();
    const res = await call(ctx, [{ op: 'delete_object', target: 'plot#9' }]);
    const errored = res['errored'] as { error?: { code?: string; message?: string } }[];
    expect(errored[0]?.error?.code).toBe('unknown_target');
    expect(String(errored[0]?.error?.message)).toContain('plot#9');
  });
});
