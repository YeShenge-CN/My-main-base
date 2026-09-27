/**
 * 镜头表的写命令（P12 第二步）。
 *
 * 这一份锁的是【三条命令的边界】，而不只是它们能跑通：
 *
 *   add_scene     位置必须显式给（bornAt 或 at），不默认追加到片尾
 *   set_scene     只改镜头表自己；改 bornAt 不搬镜内内容（那是 retime 的事）
 *   remove_scene  镜内对象改归属到相邻镜头，绝不变孤儿；最后一镜不许删
 *
 * 以及三条命令的【可撤销性】。镜头与 delete_object 的取舍刻意相反：
 * 删对象不可逆（要带指定 id 重建，代价高），删镜头可逆（只有三个标量，
 * 但对象上的 owner.sceneId 指着它，不可逆就会留下永久悬空）。
 */
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/command/apply';
import { applyCommands } from '../src/command/batch';
import { canWrite } from '../src/doc/permissions';
import { createJournal, type Journal } from '../src/journal/store';
import { resolvePath } from '../src/doc/paths';
import { validateEnvironment } from '../src/validate/validators';
import type { Command } from '../src/command/commands';
import type { SceneDoc, SceneObject } from '../src/doc/types';
import { findScene, lastScene, objectTimeWindow, sceneEnd, sceneOrder } from '../src/doc/types';
import { makeDoc, makeObject, withScenes } from './fixtures';

const BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

/**
 * 两个镜头：s#1 [0,6) · s#2 [6,12)。a#1 在 s#1，b#1 在 s#2。
 *
 * ★ id 刻意用 `s#N`（allocateId 的真实产物形态），不用 `s1`：
 *   `前缀#序号` 是整个仓库的 id 约定，而 patch 路径要按点分路径解析。
 *   夹具用别的形态会让测试通过、真实文档出问题。
 */
function twoSceneDoc(): SceneDoc {
  const base = makeDoc(0, { duration: 12 });
  return {
    ...withScenes(base, [{ id: 's#1', name: '开场', bornAt: 0 }, { id: 's#2', name: '收尾', bornAt: 6 }]),
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1'] }],
    objects: {
      'a#1': makeObject('a#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#1', bornAt: 0 } }),
      'b#1': makeObject('b#1', 'plot2d', { owner: { kind: 'scene', sceneId: 's#2', bornAt: 6 } }),
    },
    effects: {},
    markers: [],
  };
}

/** 没有镜头表的单镜头文档（旧行为）；plot#1 的 sceneId 是占位名 */
function singleSceneDoc(): SceneDoc {
  return { ...makeDoc(1, { duration: 10 }), scenes: [], markers: [] };
}

function setup(doc: SceneDoc = twoSceneDoc()): Journal {
  let clock = 1_700_000_000_000;
  return createJournal(doc, { now: () => (clock += 1000) });
}

function run(j: Journal, commands: readonly Command[]) {
  return applyCommands({ baseVersion: j.currentVersion(), commands }, {
    journal: j,
    budget: () => BUDGET,
    actor: 'user',
    now: () => 1_700_000_001_000,
  });
}

function ownerOf(doc: SceneDoc, id: string): SceneObject['owner'] | undefined {
  return doc.objects[id]?.owner;
}

function sceneIds(doc: SceneDoc): string[] {
  return sceneOrder(doc).map((s) => s.id);
}

function agentCompound(j: Journal, turnId: string) {
  return j.compounds().find((c) => c.turnId === turnId && c.actor === 'agent');
}

/* ══════════════════ add_scene ══════════════════ */

describe('add_scene：位置必须显式给', () => {
  it('给出 bornAt：按它落位，需要时把片长撑到它', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', name: '加镜', bornAt: 15 }]);
    expect(res.errored).toEqual([]);
    expect(res.ok[0]?.assignedId).toBe('s#3');
    const doc = j.currentDoc();
    expect(findScene(doc, 's#3')?.bornAt).toBe(15);
    // 起点落在原片长之外 → reconcileDuration 把片长撑到 15
    expect(doc.meta.duration).toBe(15);
  });

  it('给出 at：接在那一镜结束的位置，不加长片长', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', at: 's#1' }]);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    // s#1 的结束 = 下一镜起点 = 6
    expect(findScene(doc, 's#3')?.bornAt).toBe(6);
    expect(doc.meta.duration).toBe(12);
    // 名字有默认值，不会留空
    expect(findScene(doc, 's#3')?.name).toBe('镜头 s#3');
    // 两镜同起点的边界：s#1 的结束时刻由"s#2 的 bornAt"决定，与新镜无关
    expect(sceneEnd(doc, 's#1')).toBe(6);
  });

  it('★ 两个都不给就报错，不默认追加到片尾', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', name: '猜猜我在哪' }]);
    expect(res.ok).toEqual([]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['invalid_argument']);
    expect(j.currentDoc().scenes).toHaveLength(2);
  });

  it('bornAt 与 at 同时给 → invalid_argument', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', bornAt: 3, at: 's#1' }]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['invalid_argument']);
  });

  it('at 指向不存在的镜头 → unknown_target', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', at: 's#9' }]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['unknown_target']);
  });

  it('bornAt 是负数 → invalid_argument（时间轴上没有它该在的位置）', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', bornAt: -1 }]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['invalid_argument']);
  });

  it('id 冲突 → invalid_argument（这是逆操作装回镜头时唯一可能撞的地方）', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'add_scene', id: 's#1', bornAt: 3 }]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['invalid_argument']);
  });

  it('第一条镜头可以从零建起（空表 → 表里有了一镜）', () => {
    const j = setup(singleSceneDoc());
    expect(j.currentDoc().scenes).toEqual([]);
    const res = run(j, [{ op: 'add_scene', bornAt: 0, name: '第一镜' }]);
    expect(res.errored).toEqual([]);
    expect(sceneIds(j.currentDoc())).toEqual(['s#1']);
    // 片长不动（0 ≤ duration，reconcile 是单向的）
    expect(j.currentDoc().meta.duration).toBe(10);
  });
});

/* ══════════════════ set_scene ══════════════════ */

describe('set_scene：只改镜头表自己', () => {
  it('改名', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'set_scene', target: 's#2', name: '新名字' }]);
    expect(res.errored).toEqual([]);
    expect(findScene(j.currentDoc(), 's#2')?.name).toBe('新名字');
  });

  it('改 bornAt 挪的是【边界】，镜内对象不跟着走', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'set_scene', target: 's#2', bornAt: 8 }]);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    expect(findScene(doc, 's#2')?.bornAt).toBe(8);
    // s#1 的结束时刻 = 下一镜起点 → 跟着变成 8（这是派生，不是我们搬的）
    expect(objectTimeWindow(doc, doc.objects['a#1']!)).toEqual([0, 8]);
    // b#1 的 owner.bornAt 仍是 6：它没被搬走，只是它的镜头边界变了。
    // ★ 这正是"改 bornAt ≠ 搬内容"的可观测证据 —— 要搬内容请用 retime。
    expect(ownerOf(doc, 'b#1')).toEqual({ kind: 'scene', sceneId: 's#2', bornAt: 6 });
  });

  it('改名与挪边界可以一次做完（一条命令一个补丁集）', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'set_scene', target: 's#1', name: '序幕', bornAt: 1 }]);
    expect(res.errored).toEqual([]);
    expect(findScene(j.currentDoc(), 's#1')).toEqual({ id: 's#1', name: '序幕', bornAt: 1 });
  });

  it('空名字与负数起点都拒绝', () => {
    const j = setup(twoSceneDoc());
    expect(run(j, [{ op: 'set_scene', target: 's#1', name: '' }]).errored.map((e) => e.error.code)).toEqual([
      'invalid_argument',
    ]);
    expect(run(j, [{ op: 'set_scene', target: 's#1', bornAt: -5 }]).errored.map((e) => e.error.code)).toEqual([
      'invalid_argument',
    ]);
  });

  it('id 不存在 → unknown_target', () => {
    const j = setup(twoSceneDoc());
    expect(run(j, [{ op: 'set_scene', target: 's#9', name: 'x' }]).errored.map((e) => e.error.code)).toEqual([
      'unknown_target',
    ]);
  });
});

/* ══════════════════ remove_scene ══════════════════ */

describe('remove_scene：镜内对象绝不变孤儿', () => {
  it('★ 对象改归属到【前一个】镜头，owner.bornAt 同步成新镜头的起点', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'remove_scene', target: 's#2' }]);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    expect(sceneIds(doc)).toEqual(['s#1']);
    // b#1 原本在 s#2，现在归 s#1；bornAt 也跟着写成 s#1 的 0
    // （bornAt 的真源是镜头表，落盘的那份必须跟着走，否则文档自相矛盾）
    expect(ownerOf(doc, 'b#1')).toEqual({ kind: 'scene', sceneId: 's#1', bornAt: 0 });
    // 归属全部有效 → 校验器一条都不报
    expect(validateEnvironment(doc).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('删【第一镜】时对象归到后一个（没有前一个可接管）', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [{ op: 'remove_scene', target: 's#1' }]);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    expect(sceneIds(doc)).toEqual(['s#2']);
    expect(ownerOf(doc, 'a#1')).toEqual({ kind: 'scene', sceneId: 's#2', bornAt: 6 });
  });

  it('接管顺序按 sceneOrder 而不是数组顺序（表的顺序不是真源）', () => {
    const base = twoSceneDoc();
    const shuffled: SceneDoc = { ...base, scenes: [base.scenes[1]!, base.scenes[0]!] };
    const j = setup(shuffled);
    run(j, [{ op: 'remove_scene', target: 's#2' }]);
    // 逻辑上 s#1 在 s#2 之前，所以 s#2 的对象归 s#1 —— 与数组里的位置无关
    expect(ownerOf(j.currentDoc(), 'b#1')).toMatchObject({ sceneId: 's#1' });
  });

  it('★ 最后一镜不许删', () => {
    const j = setup(twoSceneDoc());
    run(j, [{ op: 'remove_scene', target: 's#2' }]);
    const res = run(j, [{ op: 'remove_scene', target: 's#1' }]);
    expect(res.errored.map((e) => e.error.code)).toEqual(['invalid_argument']);
    expect(j.currentDoc().scenes).toHaveLength(1);
  });

  it('不缩短片长（删镜头≠收短片尾，那是 retime / set_meta 的事）', () => {
    const j = setup(twoSceneDoc());
    run(j, [{ op: 'remove_scene', target: 's#2' }]);
    expect(j.currentDoc().meta.duration).toBe(12);
    expect(lastScene(j.currentDoc())?.id).toBe('s#1');
  });

  it('只动被删镜头的对象，别镜与 global / shared 纹丝不动', () => {
    const base = twoSceneDoc();
    const doc: SceneDoc = {
      ...base,
      layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['a#1', 'b#1', 'g#1', 'sh#1'] }],
      objects: {
        ...base.objects,
        'g#1': makeObject('g#1', 'plot2d', { owner: { kind: 'global' } }),
        'sh#1': makeObject('sh#1', 'plot2d', {
          owner: { kind: 'shared', sharedId: 'asset.sin', usageWindows: [[0, 5]] },
        }),
      },
    };
    const j = setup(doc);
    const before = { g: ownerOf(doc, 'g#1'), sh: ownerOf(doc, 'sh#1'), a: ownerOf(doc, 'a#1') };
    run(j, [{ op: 'remove_scene', target: 's#2' }]);
    const after = j.currentDoc();
    expect(ownerOf(after, 'g#1')).toEqual(before.g);
    expect(ownerOf(after, 'sh#1')).toEqual(before.sh);
    expect(ownerOf(after, 'a#1')).toEqual(before.a);
  });

  it('id 不存在 → unknown_target', () => {
    const j = setup(twoSceneDoc());
    expect(run(j, [{ op: 'remove_scene', target: 's#9' }]).errored.map((e) => e.error.code)).toEqual([
      'unknown_target',
    ]);
  });
});

/* ══════════════════ 与 create_* / 写权限的衔接 ══════════════════ */

describe('add_scene 之后新建的对象落在新镜头的时间窗里', () => {
  it('先加镜再建对象：不用告诉模型任何坐标，时间窗自动对上', () => {
    const j = setup(twoSceneDoc());
    const res = run(j, [
      { op: 'add_scene', localId: '$s3', at: 's#2' },
      { op: 'create_plot', localId: '$c1', expr: 'sin(x)', domain: [-7, 7], owner: { kind: 'scene', sceneId: '$s3' } },
    ]);
    expect(res.errored).toEqual([]);
    const doc = j.currentDoc();
    const created = doc.objects['plot#1'];
    // 新镜接在 s#2 之后：s#2 的结束 = 片长 12
    expect(created?.owner).toEqual({ kind: 'scene', sceneId: 's#3', bornAt: 12 });
    expect(objectTimeWindow(doc, created!)).toEqual([12, 12]);
  });
});

describe('P12 验收：场景 Agent 只能写自己那一段', () => {
  it('canWrite 对别镜对象与越界时刻都拒绝', () => {
    const doc = twoSceneDoc();
    const scope = { kind: 'scene', sceneId: 's#1', start: 0, end: 6 } as const;
    expect(canWrite(doc, scope, 'a#1', 3).allowed).toBe(true);
    expect(canWrite(doc, scope, 'b#1', 3)).toMatchObject({ allowed: false, reason: 'other_scene' });
    expect(canWrite(doc, scope, 'a#1', 9)).toMatchObject({ allowed: false, reason: 'outside_scene_window' });
  });
});

/* ══════════════════ 可撤销性 ══════════════════ */

describe('★ 镜头增删是可撤销的（与 delete_object 的取舍相反）', () => {
  it('加一镜 → 撤销 → 镜头消失', () => {
    const j = setup(twoSceneDoc());
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'add_scene', name: '临时的', bornAt: 3 } });
    j.settle('t1');
    expect(sceneIds(j.currentDoc())).toContain('s#3');
    const c = agentCompound(j, 't1');
    if (c === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(c.compoundId);
    expect(r.kind).toBe('reverted');
    expect(sceneIds(j.currentDoc())).toEqual(['s#1', 's#2']);
  });

  it('改名/挪边界 → 撤销 → 回到原值', () => {
    const j = setup(twoSceneDoc());
    j.commit({
      actor: 'agent',
      turnId: 't1',
      command: { op: 'set_scene', target: 's#2', name: '改坏了', bornAt: 9 },
    });
    j.settle('t1');
    const c = agentCompound(j, 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    const scene = findScene(j.currentDoc(), 's#2');
    expect(scene?.name).toBe('收尾');
    expect(scene?.bornAt).toBe(6);
  });

  it('★ 删一镜 → 撤销 → 镜头按【原 id 与原 bornAt】装回来', () => {
    const j = setup(twoSceneDoc());
    const before = findScene(j.currentDoc(), 's#2');
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'remove_scene', target: 's#2' } });
    j.settle('t1');
    expect(sceneIds(j.currentDoc())).toEqual(['s#1']);

    const c = agentCompound(j, 't1');
    if (c === undefined) throw new Error('缺 compound');
    const r = j.revertCompound(c.compoundId);
    expect(r.kind).toBe('reverted');
    expect(findScene(j.currentDoc(), 's#2')).toEqual(before);

    /**
     * ⚠️ 已知边界（invert.ts 里也写了）：被改归属的对象【不】跟着回迁。
     *    原因是 Operation ↔ Command 一对一，逆操作里塞不进 N 条 promote_object。
     *    它们的归属仍然有效（不悬空），只是留在接管镜头上。
     *    这条断言把"现状"固定住 —— 哪天做到真正回迁，这里会红，提醒改文档。
     */
    expect(ownerOf(j.currentDoc(), 'b#1')).toMatchObject({ sceneId: 's#1' });
    expect(validateEnvironment(j.currentDoc()).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('删镜头的补偿走的是 journal 的重放取值，不是朴素逆序', () => {
    const j = setup(twoSceneDoc());
    // 一轮里先改名再删：撤销必须把镜头还原成【改名后】的样子
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'set_scene', target: 's#2', name: '第二幕' } });
    j.commit({ actor: 'agent', turnId: 't1', command: { op: 'remove_scene', target: 's#2' } });
    j.settle('t1');
    const c = agentCompound(j, 't1');
    if (c === undefined) throw new Error('缺 compound');
    j.revertCompound(c.compoundId);
    // 整轮摘掉 → s#2 应该回到这一轮【开始之前】的样子：既没改名也没被删
    expect(findScene(j.currentDoc(), 's#2')?.name).toBe('收尾');
  });
});

/* ══════════════════ 单镜头文档不受影响 ══════════════════ */

describe('空镜头表的文档（旧行为）也能加第一镜', () => {
  it('加完之后 owner.sceneId 上的悬空引用才开始被检查', () => {
    const j = setup(singleSceneDoc());
    // 加之前：没有表 → 不报悬空（占位名没人解析）
    expect(validateEnvironment(j.currentDoc()).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
    run(j, [{ op: 'add_scene', id: 's1', bornAt: 0 }]);
    // 加之后：表存在了，plot#1 的 sceneId 恰好也叫 s1 → 仍然不报
    expect(validateEnvironment(j.currentDoc()).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('表存在而对象指向不存在的镜 → 报出来（只报告）', () => {
    const j = setup(singleSceneDoc());
    run(j, [{ op: 'add_scene', id: 'other', bornAt: 0 }]);
    const issues = validateEnvironment(j.currentDoc()).filter((i) => i.code === 'scene_ref_missing');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fixClass).toBe('human');
    expect(issues[0]?.message).toContain('s1');
  });
});

/* ══════════════════ patch 路径必须是真路径 ══════════════════ */

describe('★ 每条 patch 的路径都要能被 resolvePath 解析', () => {
  /**
   * 这条守的是一个很隐蔽的坑：revert 的补偿值经 replay 取回，而 replay 靠
   * resolvePath 认路径。造一条"文档里不存在"的路径（比如 'scenes.s2.removed'）
   * 不会报任何错 —— 补偿会静默变成 undefined，撤销看起来成功、其实装了个空的回去。
   * 所以：凡是我们产出的 patch 路径，都应当指向文档里真实存在的位置。
   */
  const cases: readonly { readonly name: string; readonly command: Command; readonly doc: SceneDoc }[] = [
    { name: 'add_scene', command: { op: 'add_scene', bornAt: 20 }, doc: twoSceneDoc() },
    { name: 'set_scene', command: { op: 'set_scene', target: 's#2', name: 'x', bornAt: 7 }, doc: twoSceneDoc() },
    { name: 'remove_scene', command: { op: 'remove_scene', target: 's#2' }, doc: twoSceneDoc() },
  ];

  for (const { name, command, doc } of cases) {
    it(name + '：每条 patch 的 before 都能在原文档里按该路径解析出来', () => {
      const r = applyCommand(doc, command, {});
      if (r.kind !== 'applied') throw new Error(name + ' 没被应用：' + JSON.stringify(r));
      for (const p of r.patches) {
        // 对象相对路径（'a#1.owner'）由 resolvePath 的对象分支处理，同样算真路径
        const resolved = resolvePath(doc, p.path);
        expect(resolved.found, name + ' 的 patch 路径不是真路径: ' + p.path).toBe(true);
      }
    });
  }

  it('remove_scene 的补偿值里能捞回被删的镜头（撤销靠它按原 id 装回）', () => {
    const doc = twoSceneDoc();
    const r = applyCommand(doc, { op: 'remove_scene', target: 's#2' }, {});
    if (r.kind !== 'applied') throw new Error('没被应用');
    const p = r.patches.find((x) => x.path === 'scenes');
    expect(Array.isArray(p?.before)).toBe(true);
    const removed = (p!.before as readonly { id: string }[]).find((s) => s.id === 's#2');
    expect(removed).toMatchObject({ id: 's#2', name: '收尾', bornAt: 6 });
  });
});

/* ══════════════════ 直接调 applyCommand 也要成立 ══════════════════ */

describe('applyCommand 单条调用与批量走同一份实现', () => {
  it('add_scene 单条调用产出 patches，且片长对齐写在同一个 patch 集里', () => {
    const doc = twoSceneDoc();
    const r = applyCommand(doc, { op: 'add_scene', bornAt: 20 }, {});
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.assignedId).toBe('s#3');
    const paths = r.patches.map((p) => p.path);
    expect(paths).toContain('scenes');
    expect(paths).toContain('meta.duration');
    expect(r.doc.meta.duration).toBe(20);
  });
});
