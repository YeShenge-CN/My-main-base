/**
 * 「整片」流程：导演规划、清空建分镜、以及服务端那条作业路径。
 *
 * ★ 两份测试分工：
 *   1. 纯函数（parsePlan / planToCommands）—— 毫秒级、确定性；
 *   2. 服务端端到端 —— 【stub 掉模型】但真的起一台服务、真的走 HTTP、真的落文档。
 *      它证明的是「面板要轮询的那条路」是通的，而不是某段逻辑写对了。
 *   （真调模型的验收在最后一节，由 SVA_ACCEPTANCE 打开。）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommands, createJournal, findScene, sceneOrder, validate, type SceneDoc } from '@sva/engine-core';
import { BudgetTracker, DEFAULT_LIMITS } from '../src/budget';
import {
  MAX_SHOTS,
  MIN_SHOT_SECONDS,
  MAX_SHOT_SECONDS,
  DEFAULT_SHOT_SECONDS,
  parsePlan,
  planFilm,
  planDuration,
  planToCommands,
  type FilmPlan,
} from '../src/film';
import { startPanelServer } from '../src/panel-server';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

afterEach(() => {
  vi.unstubAllGlobals();
});

function docWith(scenes: readonly { id: string; name: string; bornAt: number }[], objects: number): SceneDoc {
  const objs: Record<string, unknown> = {};
  const effects: Record<string, unknown> = {};
  const ids: string[] = [];
  for (let i = 1; i <= objects; i++) {
    const id = 'rect#' + i;
    ids.push(id);
    objs[id] = {
      shape: 'rect',
      owner: { kind: 'global' },
      params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
      style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {},
      effects: ['eff#' + i],
    };
    effects['eff#' + i] = { type: 'drawOn', target: id, params: { start: { v: 0 }, duration: { v: 1 } } };
  }
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ids }],
    objects: objs,
    effects,
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, bornAt: s.bornAt })),
    locks: {},
    audioTracks: [],
    captionTracks: [],
  } as unknown as SceneDoc;
}

const PLAN: FilmPlan = {
  title: '什么是 Agent',
  shots: [
    { name: '定义', seconds: 5, task: '在中间放一行标题文字：什么是 Agent' },
    { name: '循环', seconds: 6, task: '画一个闭环箭头，标上观察-思考-行动' },
  ],
};

describe('parsePlan：模型给的东西永远可能有毛病，能救就救', () => {
  it('正常的一份照收', () => {
    const r = parsePlan({ title: 'T', shots: [{ name: 'a', seconds: 4, task: 'do a' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.shots[0]).toEqual({ name: 'a', seconds: 4, task: 'do a' });
  });

  it('★ 时长被夹在 [1.5, 20]，缺省 5；名字缺了补「第 N 镜」', () => {
    const r = parsePlan({
      shots: [
        { task: 'a', seconds: 0.2 },
        { task: 'b', seconds: 999 },
        { task: 'c' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.shots.map((s) => s.seconds)).toEqual([MIN_SHOT_SECONDS, MAX_SHOT_SECONDS, DEFAULT_SHOT_SECONDS]);
    expect(r.plan.shots.map((s) => s.name)).toEqual(['第 1 镜', '第 2 镜', '第 3 镜']);
    expect(r.plan.title).toBe('未命名');
  });

  it('★ 超过上限就截断，并如实报出丢了几条', () => {
    const shots = Array.from({ length: MAX_SHOTS + 3 }, (_, i) => ({ name: 's' + i, seconds: 5, task: 't' + i }));
    const r = parsePlan({ shots });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.shots).toHaveLength(MAX_SHOTS);
      expect(r.dropped).toBe(3);
    }
  });

  it('没有 task 的那一镜丢掉（它跑起来只会空转）', () => {
    const r = parsePlan({ shots: [{ name: 'a', seconds: 4, task: 'ok' }, { name: 'b', seconds: 4, task: '   ' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.shots).toHaveLength(1);
      expect(r.dropped).toBe(1);
    }
  });

  it('★ 一条能用的都没有 → 如实失败（继续跑只会烧 token）', () => {
    expect(parsePlan({ shots: [] }).ok).toBe(false);
    expect(parsePlan({ shots: [{ name: 'a' }] }).ok).toBe(false);
    expect(parsePlan(null).ok).toBe(false);
    expect(parsePlan('随便一句话').ok).toBe(false);
  });
});

describe('★ 导演调用：思考模式与 tool_choice 的冲突（真调模型抓到的 400）', () => {
  it('先 auto+思考；没调工具时退到 required+不思考，并把两段用量相加', async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      n += 1;
      // 第一次：思考模式下服务端【会 400】，这里模拟模型干脆没调工具
      const message =
        n === 1
          ? { role: 'assistant', content: '好的，我来想想……' }
          : {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'plan_shots',
                    arguments: JSON.stringify({ title: 'T', shots: [{ name: 'a', seconds: 4, task: 'do' }] }),
                  },
                },
              ],
            };
      return new Response(
        JSON.stringify({
          choices: [{ message, finish_reason: n === 1 ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    });
    const result = await planFilm({ apiKey: 'k', brief: '讲清楚 agent', reasoningEffort: 'high' });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.['tool_choice']).toBe('auto');
    expect(bodies[0]?.['reasoning_effort']).toBe('high');
    // ★ 第二次必须【关掉思考】并 required —— 这是 API 允许的唯一组合
    expect(bodies[1]?.['tool_choice']).toBe('required');
    expect(bodies[1]?.['thinking']).toEqual({ type: 'disabled' });
    expect(bodies[1]?.['reasoning_effort']).toBeUndefined();
    expect(result.plan.shots[0]?.name).toBe('a');
    // ★ 第二十九轮起 usage 是【拆开的】（输入/输出/缓存/思考/图片）——
    //   这里逐字写全，是为了让「多了一个字段却没人报出去」这类问题当场现形。
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      cachedTokens: 0,
      uncachedTokens: 20,
      reasoningTokens: 0,
      imageFrames: 0,
    });
    // ★ 输出上限必须【显式发出去】（§0.28 三 ⑥：以前从来没传过 max_tokens）
    expect(bodies.every((b) => typeof b?.['max_tokens'] === 'number')).toBe(true);
  });
});
describe('planToCommands：清空 + 重排镜头表', () => {
  it('★ 先删效果再删对象（反过来会留下 effect_target_missing）', () => {
    const cmds = planToCommands(docWith([{ id: 's#1', name: '旧', bornAt: 0 }], 2), PLAN);
    const ops = cmds.map((c) => c.op);
    expect(ops.indexOf('delete_effect')).toBeLessThan(ops.indexOf('delete_object'));
    expect(ops.filter((o) => o === 'delete_effect')).toHaveLength(2);
    expect(ops.filter((o) => o === 'delete_object')).toHaveLength(2);
  });

  it('★ 镜头表被复用/补齐/裁掉，起点按分镜时长累加', () => {
    // 旧表 1 镜 → 新表 2 镜（复用 s#1 + 新增一镜）
    const grow = planToCommands(docWith([{ id: 's#1', name: '旧', bornAt: 0 }], 0), PLAN);
    expect(grow.filter((c) => c.op === 'add_scene')).toHaveLength(1);
    expect(grow.filter((c) => c.op === 'set_scene')).toHaveLength(1);
    const added = grow.find((c) => c.op === 'add_scene') as { bornAt?: number; name?: string };
    expect(added.bornAt).toBe(5);
    expect(added.name).toBe('循环');

    // 旧表 4 镜 → 新表 2 镜（裁掉 2 个）
    const shrink = planToCommands(
      docWith(
        [
          { id: 's#1', name: 'a', bornAt: 0 },
          { id: 's#2', name: 'b', bornAt: 2 },
          { id: 's#3', name: 'c', bornAt: 4 },
          { id: 's#4', name: 'd', bornAt: 6 },
        ],
        0,
      ),
      PLAN,
    );
    expect(shrink.filter((c) => c.op === 'remove_scene')).toHaveLength(2);
    // 片长最后定，且等于总时长
    const last = shrink[shrink.length - 1] as { op: string; duration?: number };
    expect(last.op).toBe('set_meta');
    expect(last.duration).toBe(planDuration(PLAN));
  });

  it('★ 整批走一遍引擎：对象清空、镜头表 = 分镜、片长 = 总时长、没有 error', () => {
    const before = docWith(
      [
        { id: 's#1', name: '旧一', bornAt: 0 },
        { id: 's#2', name: '旧二', bornAt: 4 },
        { id: 's#3', name: '旧三', bornAt: 8 },
      ],
      3,
    );
    const journal = createJournal(before, { now: () => 1_700_000_000_000 });
    const res = applyCommands(
      { baseVersion: journal.currentVersion(), commands: [...planToCommands(before, PLAN)] },
      {
        journal,
        budget: () => new BudgetTracker('x', DEFAULT_LIMITS).remaining(),
        actor: 'agent',
        turnId: 'film-setup',
        now: () => 1_700_000_000_000,
      },
    );
    expect(res.errored.map((e) => e.error.code)).toEqual([]);
    const after = journal.currentDoc();
    expect(Object.keys(after.objects)).toEqual([]);
    expect(Object.keys(after.effects)).toEqual([]);
    expect(sceneOrder(after).map((s) => s.name)).toEqual(['定义', '循环']);
    expect(findScene(after, 's#2')?.bornAt).toBe(5);
    expect(after.meta.duration).toBe(11);
    expect(validate(after).filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([]);
  });
});

describe('★ 服务端 /api/film：起作业 → 轮询 → 拿文档与操作（模型被 stub 掉）', () => {
  it('导演分镜 → 清空建分镜 → 逐镜跑 → done，全程走 HTTP', async () => {
    const realFetch = globalThis.fetch;
    const modelCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string } = {}) => {
      const u = String(url);
      if (!u.includes('api.deepseek.com')) return realFetch(url as never, init as never);
      const body = JSON.parse(init.body ?? '{}') as { tools?: { function?: { name?: string } }[] };
      const toolCount = body.tools?.length ?? 0;
      // ★ 记的是「这次请求带了几件工具」而不是第一个工具的名字：
      //   导演那次【只带 plan_shots 一件】（隔离），场景 Agent 那次带的是完整工具表。
      const isDirector = toolCount === 1 && body.tools?.[0]?.function?.name === 'plan_shots';
      modelCalls.push(isDirector ? 'director' : 'scene:' + String(toolCount));
      if (isDirector) {
        const args = JSON.stringify({
          title: '什么是 Agent',
          shots: [
            { name: '定义', seconds: 5, task: '在中间放一行标题' },
            { name: '循环', seconds: 6, task: '画一个闭环箭头' },
          ],
        });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'plan_shots', arguments: args } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '这一镜先不画（测试）' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    });

    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const server = await startPanelServer({
      root,
      docPath: join(root, 'out', 'film-test-doc.json'),
      apiKey: 'test-key',
      reasoningEffort: 'off',
    });
    try {
      const before = docWith(
        [
          { id: 's#1', name: '旧一', bornAt: 0 },
          { id: 's#2', name: '旧二', bornAt: 4 },
        ],
        2,
      );
      const started = await fetch(server.origin + '/api/film', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: '做一条讲清楚 agent 是什么的科普片', doc: before }),
      });
      const head = (await started.json()) as { ok?: boolean; filmId?: string; error?: string };
      expect(head.ok, JSON.stringify(head)).toBe(true);
      expect(typeof head.filmId).toBe('string');

      type Snapshot = {
        state: string;
        title?: string;
        plan?: FilmPlan;
        shotsDone: number;
        shotsTotal: number;
        events: { kind: string; text: string }[];
        doc?: SceneDoc;
        entries?: unknown[];
        error?: string;
      };
      let film: Snapshot | undefined;
      for (let i = 0; i < 200; i++) {
        const res = await fetch(server.origin + '/api/film/' + String(head.filmId));
        const payload = (await res.json()) as { ok?: boolean; film?: Snapshot };
        film = payload.film;
        if (film !== undefined && (film.state === 'done' || film.state === 'failed')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(film, '轮询一直没拿到作业状态').toBeDefined();
      expect(film?.state, JSON.stringify(film?.error)).toBe('done');

      // ① 导演那次请求【只带一件工具】（隔离干净），场景 Agent 带的是完整工具表
      expect(modelCalls[0]).toBe('director');
      expect(modelCalls).toHaveLength(3); // 1 次导演 + 2 镜各 1 轮
      //    场景 Agent 拿的是【完整工具表】（实测 8 件：读文档 / 渲染 / apply_commands / 收尾 …）
      expect(
        modelCalls.slice(1).every((n) => n.startsWith('scene:') && Number(n.slice(6)) >= 5),
        JSON.stringify(modelCalls),
      ).toBe(true);

      // ② 分镜与文档
      expect(film?.title).toBe('什么是 Agent');
      expect(film?.plan?.shots).toHaveLength(2);
      expect(film?.shotsTotal).toBe(2);
      expect(film?.shotsDone).toBe(2);
      expect(sceneOrder(film?.doc as SceneDoc).map((s) => s.name)).toEqual(['定义', '循环']);
      expect(Object.keys((film?.doc as SceneDoc).objects)).toEqual([]);
      expect(film?.doc?.meta.duration).toBe(11);

      // ③ 面板要搬的操作：清空那一步也在里面（同一个 Journal）
      expect((film?.entries ?? []).length).toBeGreaterThan(0);
      const paths = (film?.entries ?? []).flatMap(
        (e) => ((e as { affectedPaths?: string[] }).affectedPaths ?? []),
      );
      expect(paths.some((p) => p.startsWith('scenes'))).toBe(true);

      // ④ 事件流是面板唯一的可见性来源
      const kinds = (film?.events ?? []).map((e) => e.kind);
      expect(kinds).toContain('plan');
      expect(kinds).toContain('shot');
      expect((film?.events ?? []).some((e) => e.text.includes('第 1/2 镜'))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

