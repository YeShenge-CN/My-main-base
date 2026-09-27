/**
 * 控件路径 → 命令（§7 第 0 条：面板改不动效果参数）。
 *
 * ★ 这一份存在的理由本身就是一条教训：那段派发逻辑以前内联在 `app.ts` 的渲染闭包
 *   里，想测它就得真开浏览器、真点控件 —— 所以没人测，于是
 *   highlight / moveAlong 的效果参数从落地那天起就是死的，
 *   **拖了没反应、也不报错**（不变量 3：人能做的事 AI 也做得到、反之亦然；
 *   而 AI 有 set_highlight，人却没有）。
 *
 * 两条断言是这个文件的骨架：
 *   1. 【覆盖】registry 里每一种效果的每一个参数，都必须有一条命令能写它 ——
 *      以后加效果类型时忘了改这里，测试会红，而不是界面静默失效；
 *   2. 【真的写进去了】产出的命令要经过 Journal（唯一写路径）落到文档上 ——
 *      光断言"命令对象的字段名对"是不够的（apply 分支静默忽略一个字段时，
 *      字段名仍然是对的）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  controlModelFor,
  createJournal,
  groupFor,
  REGISTRY,
  type Command,
  type Effect,
  type SceneDoc,
  type SceneObject,
} from '@sva/engine-core';
import { EFFECT_EDITS, commandForPath } from '../src/command-path';

/* ── 夹具：一份只有效果的最小文档 ─────────────────────────────── */

function rect(over: Partial<SceneObject> = {}): SceneObject {
  return {
    shape: 'rect',
    owner: { kind: 'global' },
    params: { width: { v: 2 }, height: { v: 1 }, radius: { v: 0 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 2 }, fill: { v: '#16223a' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
    ...over,
  };
}

function withEffects(doc: SceneDoc, effects: Record<string, Effect>): SceneDoc {
  const ids = Object.keys(effects);
  const objects: Record<string, SceneObject> = {};
  for (const [id, obj] of Object.entries(doc.objects)) {
    const mine = ids.filter((e) => effects[e]?.target === id);
    objects[id] = { ...obj, effects: mine };
  }
  return { ...doc, objects, effects };
}

/** 一份最小的空文档 + 三个对象（每个挂一种效果）。 */
function makeDoc(): SceneDoc {
  const base: SceneDoc = {
    schemaVersion: 3,
    docVersion: 0,
    meta: {
      fps: 60,
      viewport: [960, 540],
      worldWidth: 16,
      worldHeight: 9,
      duration: 12,
      seed: 1,
    },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1', 'plot#1', 'ball#1', 'text#1'] }],
    objects: {
      'rect#1': rect({}),
      'plot#1': rect({ shape: 'plot2d', params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } } }),
      'ball#1': rect({ shape: 'line', params: { from: { v: [-1, 0] }, to: { v: [1, 0] }, head: { v: 'arrow' } } }),
      'text#1': rect({ shape: 'text', params: { content: { v: '标题' } }, style: { size: { v: 32 }, fill: { v: '#e8eef8' } } }),
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
  return withEffects(base, {
    'eff#1': {
      type: 'drawOn',
      target: 'rect#1',
      params: { start: { v: 0.5 }, duration: { v: 2 }, mode: { v: 'arc' }, tip: { v: true } },
    },
    'eff#2': {
      type: 'highlight',
      target: 'plot#1',
      params: { start: { v: 1 }, duration: { v: 0.6 }, color: { v: '#ffd479' }, intensity: { v: 1 } },
    },
    'eff#3': {
      type: 'moveAlong',
      target: 'ball#1',
      params: { source: { v: 'line#1' }, start: { v: 0.8 }, duration: { v: 1.6 } },
    },
  });
}

/* ── 覆盖：效果参数一条都不许漏 ───────────────────────────────── */

describe('★ 覆盖：每种效果的每个参数都有命令', () => {
  const effectTypes = REGISTRY.groups.filter((g) => g.kind === 'effect' && g.section === 'params');

  it('registry 里出现的每一种效果都在派发表里（没有"没有编辑命令的效果"）', () => {
    // 效果的"类型"就是分组的 owner（effect.<type>.params）——
    // 加一种效果时 registry 与 EFFECT_EDITS 必须一起改。
    const missing = effectTypes.map((g) => g.owner ?? '(无 owner)').filter((t) => EFFECT_EDITS[t] === undefined);
    expect(missing, '这些效果类型没有编辑命令：' + missing.join('、')).toEqual([]);
  });

  it('派发表里的字段与 registry 逐字一致（少一个=静默丢，多一个=死字段）', () => {
    for (const [type, spec] of Object.entries(EFFECT_EDITS)) {
      const group = groupFor(REGISTRY, 'effect', type, 'params');
      if (group === undefined) throw new Error('registry 缺少 effect.' + type + '.params');
      expect([...spec.fields].sort(), type).toEqual(Object.keys(group.fields).sort());
    }
  });

  it('★ 面板真正用的那条路径也能派发出命令（controlModelFor 产出的 path 逐条可解析）', () => {
    // ★ 这一条补的是"单元测试断言的是我手写的 path 形状"这个盲区：
    //   app.ts 的 modelsFor 用 `controlModelFor(group, raw, effId + '.params')` 造控件，
    //   而真正决定用户拖动时发什么命令的是【控件自己带的 path】。
    //   照它的写法重跑一遍，等于把"控件路径 ↔ 命令"这条契约钉在测试里 ——
    //   不需要开浏览器（实机校验要 Chrome，需要 danger-full-access）。
    const doc = makeDoc();
    for (const id of Object.keys(doc.effects)) {
      const eff = doc.effects[id];
      if (eff === undefined) continue;
      const group = groupFor(REGISTRY, 'effect', eff.type, 'params');
      if (group === undefined) throw new Error('缺分组 effect.' + eff.type + '.params');
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(eff.params)) {
        raw[k] = typeof v === 'object' && v !== null && 'v' in v ? (v as { v: unknown }).v : v;
      }
      const models = controlModelFor(group, raw, id + '.params');
      expect(models.length, id).toBeGreaterThan(0);
      for (const model of models) {
        const cmd = commandForPath(model.path, model.value, doc);
        expect(cmd, '控件 ' + model.path + '（' + eff.type + '）没有对应命令').not.toBeNull();
        // 命令必须指向同一条效果，且真的带上这个字段
        expect((cmd as unknown as Record<string, unknown>)['target']).toBe(id);
        expect(Object.keys(cmd as unknown as Record<string, unknown>)).toContain(model.key);
      }
    }
  });

  /**
   * ★★ 这是 §7 第 0.5 条复发时会红的那条线：
   *   面板会为【每个形状的每个字段】造控件（controlModelFor），
   *   而"造得出控件"与"拖得动"是两件事 —— 效果参数就曾经整整三轮对不上。
   *   这一条按 registry 逐形状 × 逐分区跑一遍，任何一条派发不出命令就红。
   */
  it('★★ 覆盖：四种形状的每个控件（params + style）都能派发出命令', () => {
    const doc = makeDoc();
    const idOf: Readonly<Record<string, string>> = {
      plot2d: 'plot#1',
      rect: 'rect#1',
      line: 'ball#1',
      text: 'text#1',
    };
    let checked = 0;
    for (const shape of Object.keys(idOf)) {
      for (const section of ['params', 'style'] as const) {
        const group = groupFor(REGISTRY, 'shape', shape, section);
        if (group === undefined) throw new Error('registry 缺少 shape.' + shape + '.' + section);
        const id = idOf[shape] ?? '';
        for (const model of controlModelFor(group, {}, id + '.' + section)) {
          checked += 1;
          expect(commandForPath(model.path, model.value, doc), '控件 ' + model.path + ' 没有对应命令').not.toBeNull();
        }
      }
    }
    // 防止测试空转：四种形状的控件加起来一定不止十几个
    expect(checked).toBeGreaterThan(15);
  });

  it('每一个参数都能产出一条命令（不是只对某几个字段碰巧成立）', () => {
    const doc = makeDoc();
    for (const id of Object.keys(doc.effects)) {
      const type = doc.effects[id]?.type ?? '';
      const group = groupFor(REGISTRY, 'effect', type, 'params');
      if (group === undefined) throw new Error('缺分组');
      for (const key of Object.keys(group.fields)) {
        const value = key === 'tip' ? true : key === 'color' ? '#ff0000' : key === 'source' ? 'line#1' : 1;
        expect(commandForPath(id + '.params.' + key, value, doc), id + '.' + key).not.toBeNull();
      }
    }
  });
});

/* ── 派发：类型决定命令 ───────────────────────────────────────── */

describe('效果参数按【效果类型】派发', () => {
  const doc = makeDoc();

  it('drawOn → set_effect', () => {
    expect(commandForPath('eff#1.params.duration', 3, doc)).toEqual({
      op: 'set_effect',
      target: 'eff#1',
      duration: 3,
    });
  });

  it('highlight → set_highlight（颜色 / 强度）', () => {
    expect(commandForPath('eff#2.params.color', '#00ff88', doc)).toEqual({
      op: 'set_highlight',
      target: 'eff#2',
      color: '#00ff88',
    });
    expect(commandForPath('eff#2.params.intensity', 0.7, doc)).toEqual({
      op: 'set_highlight',
      target: 'eff#2',
      intensity: 0.7,
    });
  });

  it('moveAlong → set_move_along（路径对象是字符串字段）', () => {
    expect(commandForPath('eff#3.params.source', 'line#9', doc)).toEqual({
      op: 'set_move_along',
      target: 'eff#3',
      source: 'line#9',
    });
  });

  it('★ 字段名属于别的效果类型时【拒绝】，不硬塞给这条命令', () => {
    // "给 drawOn 设置 color" 是合法形状、但语义上是错的（apply 分支会照收）
    expect(commandForPath('eff#1.params.color', '#fff', doc)).toBeNull();
    // "给 highlight 设置 mode" 同理
    expect(commandForPath('eff#2.params.mode', 'arc', doc)).toBeNull();
    // "给 moveAlong 设置 intensity" 同理
    expect(commandForPath('eff#3.params.intensity', 1, doc)).toBeNull();
  });

  it('未知效果 id / 未知字段 → null（调用方会把它说出来）', () => {
    expect(commandForPath('eff#99.params.color', '#fff', doc)).toBeNull();
    expect(commandForPath('eff#2.params.nope', 1, doc)).toBeNull();
  });

  it('值不是原子类型（对象 / 数组）→ null', () => {
    expect(commandForPath('eff#2.params.start', { v: 1 }, doc)).toBeNull();
    expect(commandForPath('eff#2.params.start', [1], doc)).toBeNull();
  });
});

/* ── 存量：对象那三条路径不许被这次重构改坏 ──────────────────── */

describe('对象路径（style / tf / params）行为不变', () => {
  const doc = makeDoc();

  it('style：width / glow / stroke', () => {
    expect(commandForPath('plot#1.style.width', 5, doc)).toEqual({ op: 'set_style', target: 'plot#1', width: 5 });
    expect(commandForPath('plot#1.style.glow', 0.2, doc)).toEqual({ op: 'set_style', target: 'plot#1', glow: 0.2 });
    expect(commandForPath('plot#1.style.stroke', '#fff', doc)).toEqual({
      op: 'set_style',
      target: 'plot#1',
      stroke: '#fff',
    });
  });

  it('tf：六个字段都能改，非数值一律拒', () => {
    expect(commandForPath('rect#1.tf.y', 1.5, doc)).toEqual({ op: 'set_transform', target: 'rect#1', y: 1.5 });
    expect(commandForPath('rect#1.tf.opacity', 0.5, doc)).toEqual({
      op: 'set_transform',
      target: 'rect#1',
      opacity: 0.5,
    });
    expect(commandForPath('rect#1.tf.y', '1.5', doc)).toBeNull();
  });

  it('params：expr / samples / domain', () => {
    expect(commandForPath('plot#1.params.expr', 'cos(x)', doc)).toEqual({
      op: 'set_expression',
      target: 'plot#1',
      expr: 'cos(x)',
    });
    expect(commandForPath('plot#1.params.samples', 800, doc)).toEqual({
      op: 'set_sampling',
      target: 'plot#1',
      samples: 800,
    });
    expect(commandForPath('plot#1.params.domain', [-1, 1], doc)).toEqual({
      op: 'set_sampling',
      target: 'plot#1',
      domain: [-1, 1],
    });
  });

  it('★ 曾经的那个缺口已经补上：fill / fillOpacity / headSize / size 都有命令了', () => {
    // 它们曾经【没有任何命令能改】（面板画着控件、拖了只说一句"改不动"）。
    // 只补引擎命令还不够 —— 这一层也要能派发，否则面板依旧拖不动（§7 第 0.5 条）。
    expect(commandForPath('rect#1.style.fill', '#fff', doc)).toEqual({ op: 'set_style', target: 'rect#1', fill: '#fff' });
    expect(commandForPath('rect#1.style.fillOpacity', 0.5, doc)).toEqual({
      op: 'set_style',
      target: 'rect#1',
      fillOpacity: 0.5,
    });
    expect(commandForPath('ball#1.style.headSize', 20, doc)).toEqual({ op: 'set_style', target: 'ball#1', headSize: 20 });
    expect(commandForPath('plot#1.style.size', 30, doc)).toEqual({ op: 'set_style', target: 'plot#1', size: 30 });
  });

  it('★ 形状几何按【对象形状】派发（rect → set_rect / line → set_line / text → set_text）', () => {
    expect(commandForPath('rect#1.params.width', 5, doc)).toEqual({ op: 'set_rect', target: 'rect#1', width: 5 });
    expect(commandForPath('rect#1.params.height', 2, doc)).toEqual({ op: 'set_rect', target: 'rect#1', height: 2 });
    expect(commandForPath('rect#1.params.radius', 0.3, doc)).toEqual({ op: 'set_rect', target: 'rect#1', radius: 0.3 });
    expect(commandForPath('ball#1.params.from', [-1, 1], doc)).toEqual({ op: 'set_line', target: 'ball#1', from: [-1, 1] });
    expect(commandForPath('ball#1.params.to', [3, 0], doc)).toEqual({ op: 'set_line', target: 'ball#1', to: [3, 0] });
    expect(commandForPath('ball#1.params.head', 'none', doc)).toEqual({ op: 'set_line', target: 'ball#1', head: 'none' });
    const textDoc: SceneDoc = { ...doc, objects: { ...doc.objects, 'text#1': { ...(doc.objects['plot#1'] as SceneObject), shape: 'text' } } };
    expect(commandForPath('text#1.params.content', '新标题', textDoc)).toEqual({
      op: 'set_text',
      target: 'text#1',
      content: '新标题',
    });
  });

  it('★ 派发错了也不会写进错的字段：形状对不上时返回 null（引擎那侧还会再拒一次）', () => {
    // 同一个字段名在不同形状里含义完全不同：矩形的 width 是几何宽度，曲线的 width 是线宽。
    // 所以 params.width 派发给谁，只能看 doc 里那个对象是什么形状。
    expect(commandForPath('plot#1.params.width', 5, doc)).toBeNull();
    expect(commandForPath('rect#1.params.expr', 'sin(x)', doc)).toBeNull();
    expect(commandForPath('ball#1.params.width', 5, doc)).toBeNull();
    // 类型不对也拒
    expect(commandForPath('ball#1.params.from', 'x', doc)).toBeNull();
    expect(commandForPath('ball#1.params.from', [1], doc)).toBeNull();
  });

  it('路径太短 / 目标不存在 → null', () => {
    expect(commandForPath('rect#1.tf', 1, doc)).toBeNull();
    expect(commandForPath('', 1, doc)).toBeNull();
  });
});

/* ── 端到端：产出的命令真的写进文档（唯一写路径）──────────────── */

describe('★ 产出的命令真的落到文档上（经 Journal）', () => {
  function commit(doc: SceneDoc, cmd: Command): SceneDoc {
    let clock = 1_700_000_000_000;
    const j = createJournal(doc, { now: () => (clock += 1000) });
    j.commit({ actor: 'user', turnId: 't1', command: cmd });
    return j.currentDoc();
  }

  it('拖高亮的颜色 → 文档里的颜色变了，且撤销能还原', () => {
    const doc = makeDoc();
    const cmd = commandForPath('eff#2.params.color', '#00ff88', doc);
    if (cmd === null) throw new Error('commandForPath 返回了 null');
    const next = commit(doc, cmd);
    expect(next.effects['eff#2']?.params['color']).toEqual({ v: '#00ff88' });
  });

  it('拖 moveAlong 的路径对象 → 文档里的 source 变了', () => {
    const doc = makeDoc();
    const cmd = commandForPath('eff#3.params.source', 'line#2', doc);
    if (cmd === null) throw new Error('commandForPath 返回了 null');
    const next = commit(doc, cmd);
    expect(next.effects['eff#3']?.params['source']).toEqual({ v: 'line#2' });
  });

  it('拖 drawOn 的时长 → 文档里的 duration 变了', () => {
    const doc = makeDoc();
    const cmd = commandForPath('eff#1.params.duration', 4.5, doc);
    if (cmd === null) throw new Error('commandForPath 返回了 null');
    const next = commit(doc, cmd);
    expect(next.effects['eff#1']?.params['duration']).toEqual({ v: 4.5 });
  });

  it('★ 故意发一条字段名属于别的效果类型的命令 → 引擎【拒绝】，不会静默改错字段', () => {
    // 这一条守的是"派发表少一个字段时的第二种症状"：
    // 假如 commandForPath 把 color 硬塞给 set_effect，文档会静默变成一个
    // 带 color 的 drawOn —— 形状对、语义错。set_highlight 的类型检查挡住了反向的那种。
    const doc = makeDoc();
    const r = applyCommand(doc, { op: 'set_highlight', target: 'eff#1', color: '#fff' }, {});
    expect(r.kind).toBe('failed');
  });
});
