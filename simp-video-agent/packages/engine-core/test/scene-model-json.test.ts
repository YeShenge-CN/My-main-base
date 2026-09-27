/**
 * 模型写出的【原始 JSON】到命令的往返。
 *
 * 这一份补的是三个测试层之间的一道缝：
 *   scene-commands.test.ts  验引擎语义（用 TS 对象字面量）
 *   scene-tools.test.ts     验 schema 形状（静态结构）
 *   而【模型实际会写出来的那份 JSON】没人验过 —— 它是 schema 与引擎之间唯一
 *   真正的接口。strict schema 逼着模型把没给的字段写成 null，
 *   而引擎的每条命令自己决定 null 是什么意思（"这一项不改"）。
 *   这两侧一旦对不上，模型会看到"字段名合法但行为不是我要的"，且无从判断。
 *
 * 所以这里用【逐字的 JSON 字符串】喂进去 —— 不经过任何 TS 类型检查或转换。
 */
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../src/command/batch';
import { createJournal, type Journal } from '../src/journal/store';
import type { Command } from '../src/command/commands';
import type { SceneDoc } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

const BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

function setup(doc: SceneDoc): Journal {
  let clock = 1_700_000_000_000;
  return createJournal(doc, { now: () => (clock += 1000) });
}

/** 两镜文档，两个对象各归自己那一镜。 */
function twoShotDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  return {
    ...withScenes(base, [{ id: 's#1', name: '开场', bornAt: 0 }, { id: 's#2', name: '收尾', bornAt: 6 }]),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1'] }],
    objects: {
      'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#1', bornAt: 0 } }),
      'b#1': makeObject('b#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#2', bornAt: 6 } }),
    },
    effects: {},
    markers: [{ id: 'peak', t: 2 }],
  };
}

/**
 * 把模型写出的 JSON 字符串解析成命令数组。
 *
 * ★ 刻意走 JSON.parse 而不是写 TS 字面量：这样测的就是【模型真正交上来的那份字节】。
 *   类型断言是必须的（引擎收到的本来就是 unknown），但它是唯一的转换。
 */
function fromModelJson(json: string): readonly Command[] {
  return JSON.parse(json) as Command[];
}

function run(j: Journal, commands: readonly Command[]) {
  return applyCommands({ baseVersion: j.currentVersion(), commands }, {
    journal: j,
    budget: () => BUDGET,
    actor: 'agent',
    now: () => 1_700_000_001_000,
  });
}

describe('★ 模型写的 JSON 能直接走通引擎', () => {
  it('add_scene（字段全给、未用的写 null）', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"add_scene","name":"第三镜","bornAt":9,"at":null}
    ]`);
    const res = run(j, commands);
    expect(res.errored).toEqual([]);
    expect(res.ok[0]?.assignedId).toBe('s#3');
    const scene = j.currentDoc().scenes.find((s) => s.id === 's#3');
    expect(scene?.bornAt).toBe(9);
    expect(scene?.name).toBe('第三镜');
  });

  it('add_scene 用 at 接续：模型不用知道时间轴也能放到正确位置', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"add_scene","name":null,"bornAt":null,"at":"s#1"}
    ]`);
    const res = run(j, commands);
    expect(res.errored).toEqual([]);
    // s#1 的结束 = 下一镜起点 = 6
    expect(j.currentDoc().scenes.find((s) => s.id === 's#3')?.bornAt).toBe(6);
    // name 给 null → 引擎给默认名，不会变成字符串 "null"
    expect(j.currentDoc().scenes.find((s) => s.id === 's#3')?.name).toBe('镜头 s#3');
  });

  it('set_scene 只改名（bornAt 写 null = 这一项不改）', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"set_scene","target":"s#2","name":"尾声","bornAt":null}
    ]`);
    expect(run(j, commands).errored).toEqual([]);
    const scene = j.currentDoc().scenes.find((s) => s.id === 's#2');
    expect(scene?.name).toBe('尾声');
    expect(scene?.bornAt).toBe(6); // 没被 null 冲掉
  });

  it('remove_scene：镜内对象被接管，且回执里没有 error', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"remove_scene","target":"s#2"}
    ]`);
    const res = run(j, commands);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    expect(doc.scenes.map((s) => s.id)).toEqual(['s#1']);
    expect(doc.objects['b#1']?.owner).toEqual({ kind: 'scene', sceneId: 's#1', bornAt: 0 });
  });

  it('retime：只给两个字段，镜头与内容一起走', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"retime","fromMarker":"peak","delta":2}
    ]`);
    const res = run(j, commands);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    // 标记在 2，s#2 的起点 6 ≥ 2 → 挪到 8；片长 12 → 14
    expect(doc.scenes.find((s) => s.id === 's#2')?.bornAt).toBe(8);
    expect(doc.meta.duration).toBe(14);
  });

  it('★ add_scene 两个位置都不给 → 引擎报错且说清怎么改（模型照着就能修）', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"add_scene","name":"猜猜我在哪","bornAt":null,"at":null}
    ]`);
    const res = run(j, commands);
    expect(res.ok).toEqual([]);
    expect(res.errored).toHaveLength(1);
    const err = res.errored[0]?.error;
    expect(err?.code).toBe('invalid_argument');
    // 回执必须能让模型自己修好：说清"必须给一个"
    expect(err?.message).toContain('bornAt');
    expect(err?.message).toContain('at');
    expect(j.currentDoc().scenes).toHaveLength(2);
  });

  it('★ 一批里 create + add_scene 用 localId 互相引用（依赖推导要认它）', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"add_scene","name":"新镜","bornAt":12,"at":null,"localId":"$s3"},
      {"op":"create_plot","localId":"$c1","expr":"cos(x)","domain":[-7,7],"samples":null,
       "style":null,"effect":null,"owner":{"kind":"scene","sceneId":"$s3"}}
    ]`);
    const res = run(j, commands);
    expect(res.errored).toEqual([]);
    expect(res.blocked).toEqual([]);
    expect(res.ok.map((o) => o.index)).toEqual([0, 1]);
    // 新对象落在新镜头里，时间窗也对上（片长被撑到 12）
    const doc = j.currentDoc();
    const created = doc.objects['plot#1'];
    expect(created?.owner).toEqual({ kind: 'scene', sceneId: 's#3', bornAt: 12 });
  });

  it('strict 的 null 不会把已有值冲掉（镜头与对象两处都验）', () => {
    const j = setup(twoShotDoc());
    const commands = fromModelJson(`[
      {"op":"set_scene","target":"s#1","name":null,"bornAt":null}
    ]`);
    const res = run(j, commands);
    // 什么都没改 → 仍然 ok，但文档一个字段都没动
    const scene = j.currentDoc().scenes.find((s) => s.id === 's#1');
    expect(scene).toEqual({ id: 's#1', name: '开场', bornAt: 0 });
    expect(res.errored).toEqual([]);
  });
});
