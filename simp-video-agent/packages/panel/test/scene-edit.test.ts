/**
 * 面板的镜头管理（P4 #14）：加一镜 / 改名 / 删一镜。
 *
 * ★ 引擎的三条命令（add_scene / set_scene / remove_scene）从 P12 起就绪、且有 33 条断言守着，
 *   缺的一直是**人的入口** —— AI 有工具，人没有。这一份测的就是那个人口。
 *
 * 两层：
 *   1. 纯函数层（scene-edit.ts）：该发哪几条命令、顺序是什么、什么时候干脆不发；
 *   2. 端到端：产出的命令经 Journal（唯一写路径）落到文档上，且**一次撤销能全回来**。
 */
import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createJournal,
  findScene,
  sceneOrder,
  validate,
  type Command,
  type Effect,
  type SceneDoc,
  type SceneObject,
} from '@sva/engine-core';
import {
  MIN_SCENE_SECONDS,
  NEW_SCENE_SECONDS,
  addSceneCommands,
  nextSceneName,
  removeSceneCommand,
  renameSceneCommand,
  sceneCount,
  sceneUnderCaret,
  trimBoundaryCommand,
  trimEndCommand,
  withTrimPreview,
} from '../src/scene-edit';

/* ── 夹具 ───────────────────────────────────────────────────── */

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

function makeDoc(scenes: SceneDoc['scenes'], duration = 8): SceneDoc {
  const effects: Record<string, Effect> = {
    'eff#1': { type: 'drawOn', target: 'rect#1', params: { start: { v: 0 }, duration: { v: 1 } } },
  };
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['rect#1'] }],
    objects: { 'rect#1': rect({ effects: ['eff#1'] }) },
    effects,
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes,
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

/** 一份两镜文档：s#1 [0,4) / s#2 [4,8)。 */
function twoShots(): SceneDoc {
  return makeDoc([
    { id: 's#1', name: '第一镜', bornAt: 0 },
    { id: 's#2', name: '第二镜', bornAt: 4 },
  ]);
}

const NO_BUDGET = { imagesUsed: 0, imagesLeft: 6, renderCallsLeft: 3 };

/**
 * 走【和面板一样的那条路】：applyCommands + 一次手势一个 compound。
 *
 * ★ 以前这里用的是 `journal.commit({command})` —— 它一次只收一条命令，
 *   传数组进去会安静地什么都不做（`applyCommand` 拿到数组、op 是 undefined）。
 *   这个坑值得记：**多命令手势必须走 applyCommands**，那是唯一会做预检 + 顺序提交 +
 *   compound 分组的入口。
 */
function commit(doc: SceneDoc, commands: readonly Command[], gestureId = 'g1'): SceneDoc {
  let clock = 1_700_000_000_000;
  const j = createJournal(doc, { now: () => (clock += 1000) });
  applyCommands({ baseVersion: j.currentVersion(), commands: [...commands] }, {
    journal: j,
    budget: () => NO_BUDGET,
    actor: 'user',
    gestureId,
    now: () => (clock += 1000),
  });
  return j.currentDoc();
}

/* ── 加一镜 ─────────────────────────────────────────────────── */

describe('加一镜：接在最后一镜之后，并把片长一起延出去', () => {
  it('空表 → 建第一镜，起点 0，不动片长', () => {
    const doc = makeDoc([]);
    expect(addSceneCommands(doc)).toEqual([{ op: 'add_scene', name: '新镜头', bornAt: 0 }]);
  });

  it('★ 有镜头表时是【两条】命令：先 add_scene（落在旧片尾）、再 set_meta（延长片长）', () => {
    const cmds = addSceneCommands(twoShots());
    expect(cmds).toHaveLength(2);
    // 顺序不能反：先延长片长的话，at 会解析到新的片尾
    expect(cmds[0]?.['op']).toBe('add_scene');
    expect(cmds[1]?.['op']).toBe('set_meta');
    expect(cmds[0]).toMatchObject({ at: 's#2', name: nextSceneName(3) });
    expect(cmds[1]).toMatchObject({ duration: 8 + NEW_SCENE_SECONDS });
  });

  it('★ 为什么必须延长：落在片尾的镜头是【零长度】的（[8,8)），加了等于没加', () => {
    const before = twoShots();
    const after = commit(before, addSceneCommands(before));
    const ids = sceneOrder(after).map((s) => s.id);
    expect(ids).toEqual(['s#1', 's#2', 's#3']);
    // 新镜 [8,12)：有 4 秒可用，而且没有塌掉
    const newScene = findScene(after, 's#3');
    expect(newScene?.bornAt).toBe(8);
    expect(after.meta.duration).toBe(12);
    // 已有的两镜一秒都没动
    expect(findScene(after, 's#1')?.bornAt).toBe(0);
    expect(findScene(after, 's#2')?.bornAt).toBe(4);
  });

  it('★ 加完不许产生 scene_ref_missing / visibility 之类的 error（镜头表与内容仍然自洽）', () => {
    const after = commit(twoShots(), addSceneCommands(twoShots()));
    const errors = validate(after).filter((i) => i.severity === 'error');
    expect(errors.map((e) => e.code)).toEqual([]);
  });

  it('连加两次得到 4 镜、片长 16（每次都延长默认镜长）', () => {
    const once = commit(twoShots(), addSceneCommands(twoShots()));
    const twice = commit(once, addSceneCommands(once));
    expect(sceneCount(twice)).toBe(4);
    expect(twice.meta.duration).toBe(8 + NEW_SCENE_SECONDS * 2);
    expect(sceneOrder(twice).map((s) => s.id)).toEqual(['s#1', 's#2', 's#3', 's#4']);
  });

  it('★ 一次手势 = 一个 compound：撤销一下把两条命令【一起】撤回来', () => {
    let clock = 1_700_000_000_000;
    const before = twoShots();
    const j = createJournal(before, { now: () => (clock += 1000) });
    applyCommands({ baseVersion: j.currentVersion(), commands: [...addSceneCommands(before)] }, {
      journal: j,
      budget: () => NO_BUDGET,
      actor: 'user',
      gestureId: 'add-scene-1',
      now: () => (clock += 1000),
    });
    // 两条命令 → 一个 compound
    const cs = j.compounds();
    expect(cs).toHaveLength(1);
    const cmp = cs[0];
    if (cmp === undefined) throw new Error('缺 compound');
    expect(cmp.opIds).toHaveLength(2);
    // ★ 而且是【已结束】的：不然撤销按钮永远是灰的（这正是修之前的样子）
    expect(cmp.settled).toBe(true);
    expect(sceneCount(j.currentDoc())).toBe(3);

    j.revertCompound(cmp.compoundId);
    const back = j.currentDoc();
    expect(sceneCount(back)).toBe(2);
    expect(back.meta.duration).toBe(8);
  });

  it('★ 不传 gestureId 时是"每条命令各自一个 compound"（旧行为，写下来免得踩回去）', () => {
    let clock = 1_700_000_000_000;
    const before = twoShots();
    const j = createJournal(before, { now: () => (clock += 1000) });
    applyCommands({ baseVersion: j.currentVersion(), commands: [...addSceneCommands(before)] }, {
      journal: j,
      budget: () => NO_BUDGET,
      actor: 'user',
      now: () => (clock += 1000),
    });
    // 两个 compound，而且都不是 settled —— 点一次撤销只会撤掉后半截
    expect(j.compounds()).toHaveLength(2);
    expect(j.compounds().every((c) => !c.settled)).toBe(true);
  });
});

/* ── 改名 ───────────────────────────────────────────────────── */

describe('改名', () => {
  it('改得动，且只改名字（边界与内容都不动）', () => {
    const before = twoShots();
    const cmd = renameSceneCommand('s#2', '  波包演示  ');
    expect(cmd).not.toBeNull();
    const after = commit(before, [cmd as Command]);
    expect(findScene(after, 's#2')?.name).toBe('波包演示'); // 前后空白被去掉
    expect(findScene(after, 's#2')?.bornAt).toBe(4);
    expect(after.meta.duration).toBe(8);
  });

  it('空名字 / 纯空白 → null（不发一条注定被拒的命令）', () => {
    expect(renameSceneCommand('s#1', '')).toBeNull();
    expect(renameSceneCommand('s#1', '   ')).toBeNull();
    expect(renameSceneCommand('', 'x')).toBeNull();
  });
});

/* ── 删一镜 ─────────────────────────────────────────────────── */

describe('删一镜', () => {
  it('删得掉，且镜内对象被改归属而不是被丢掉', () => {
    const doc = twoShots();
    const withContent: SceneDoc = {
      ...doc,
      objects: {
        'rect#1': rect({
          owner: { kind: 'scene', sceneId: 's#2', bornAt: 4 },
          effects: ['eff#1'],
        }),
      },
    };
    const cmd = removeSceneCommand(withContent, 's#2');
    const after = commit(withContent, [cmd as Command]);
    expect(sceneOrder(after).map((s) => s.id)).toEqual(['s#1']);
    expect(after.objects['rect#1']).toBeDefined();
    // 归属被挪到相邻镜头（优先前一个），而不是留下悬空引用
    expect(after.objects['rect#1']?.owner).toMatchObject({ kind: 'scene', sceneId: 's#1' });
    expect(validate(after).filter((i) => i.code === 'scene_ref_missing')).toEqual([]);
  });

  it('★ 只剩一镜时返回 null（引擎的硬规则：最后一镜不许删）', () => {
    const one = makeDoc([{ id: 's#1', name: '唯一一镜', bornAt: 0 }]);
    expect(removeSceneCommand(one, 's#1')).toBeNull();
    // 空表同样不给删（没有可删的东西）
    expect(removeSceneCommand(makeDoc([]), 's#1')).toBeNull();
  });

  it('镜头不存在 / 空 id → null', () => {
    expect(removeSceneCommand(twoShots(), 's#9')).toBeNull();
    expect(removeSceneCommand(twoShots(), '')).toBeNull();
  });
});

/* ── 当前这一镜 ─────────────────────────────────────────────── */

describe('"当前这一镜"的落点', () => {
  it('播放头在某镜里 → 就是那一镜', () => {
    expect(sceneUnderCaret(twoShots(), 's#2')).toBe('s#2');
  });

  it('★ 播放头落在空档 / 没有镜头表 → 退回最后一镜（而不是什么都不做）', () => {
    expect(sceneUnderCaret(twoShots(), null)).toBe('s#2');
    expect(sceneUnderCaret(twoShots(), 's#9')).toBe('s#2');
    expect(sceneUnderCaret(makeDoc([]), null)).toBeNull();
  });
});

/* ── 时间轴拉伸（PR 式的拖接缝 / 拖片尾） ────────────────────
 *
 * 规则全在纯函数里，这一块只断言规则本身 —— DOM 那层（手柄、指针、
 * 局部重排）由实机校验看，规则错了却能在毫秒级被抓出来。
 */

/** 三镜文档：s#1 [0,2) / s#2 [2,6) / s#3 [6,10)。中间那镜两边都有邻居。 */
function threeShots(): SceneDoc {
  return makeDoc(
    [
      { id: 's#1', name: 'A', bornAt: 0 },
      { id: 's#2', name: 'B', bornAt: 2 },
      { id: 's#3', name: 'C', bornAt: 6 },
    ],
    10,
  );
}

describe('拖接缝：改的是【后一镜的 bornAt】（A1 的推论）', () => {
  it('拖中间那条缝 → 前镜变长、后镜变短，内容一秒都不动', () => {
    const before = twoShots();
    const cmd = trimBoundaryCommand(before, 's#2', 5);
    expect(cmd).toEqual({ op: 'set_scene', target: 's#2', bornAt: 5 });
    const after = commit(before, [cmd as Command], 'trim-scene');
    expect(findScene(after, 's#1')?.bornAt).toBe(0);
    expect(findScene(after, 's#2')?.bornAt).toBe(5);
    // 片长不动：拉长一镜 = 另一镜缩短，总长不变（这正是 PR 里拖接缝的手感）
    expect(after.meta.duration).toBe(8);
    expect(validate(after).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('★ 第一镜的起点不给拖（那是整片开头，挪它只会留下黑场）', () => {
    expect(trimBoundaryCommand(twoShots(), 's#1', 1)).toBeNull();
  });

  it('镜头不存在 → null（不发一条注定被拒的命令）', () => {
    expect(trimBoundaryCommand(twoShots(), 's#9', 5)).toBeNull();
  });

  it('★ 夹住最短镜长：往前拖到底也不会造出零长度镜头', () => {
    // s#1 起点 0 → 缝最早只能到 0 + 0.2
    expect(trimBoundaryCommand(twoShots(), 's#2', -3)).toMatchObject({ bornAt: MIN_SCENE_SECONDS });
    // 往后拖到底 → 停在后一镜片尾前 0.2s（没有后一镜时停在片尾前 0.2s）
    const three = threeShots();
    expect(trimBoundaryCommand(three, 's#3', 99)).toMatchObject({ bornAt: 10 - MIN_SCENE_SECONDS });
  });

  it('★ 两镜已经挤到最短 → null（宁可不给拖，也不把邻居压成零长度）', () => {
    const tight = makeDoc(
      [
        { id: 's#1', name: 'A', bornAt: 0 },
        { id: 's#2', name: 'B', bornAt: 0.25 },
        { id: 's#3', name: 'C', bornAt: 0.5 },
      ],
      2,
    );
    // s#2 的可动区间是 [0.2, 0.5 - 0.2] = [0.2, 0.3]，还有余地
    expect(trimBoundaryCommand(tight, 's#2', 0.25)).toBeNull(); // 没变化 → 不提交
    const tighter = makeDoc(
      [
        { id: 's#1', name: 'A', bornAt: 0 },
        { id: 's#2', name: 'B', bornAt: 0.15 },
        { id: 's#3', name: 'C', bornAt: 0.25 },
      ],
      2,
    );
    // [0.2, 0.25 - 0.2] 已经空了 → 干脆不给拖
    expect(trimBoundaryCommand(tighter, 's#2', 0.2)).toBeNull();
  });

  it('吸附到帧网格：60fps 下拖到 5.01 会落在第 301 帧', () => {
    const cmd = trimBoundaryCommand(twoShots(), 's#2', 5.01);
    expect(cmd).toMatchObject({ bornAt: 301 / 60 });
  });

  it('没变化 → null（点一下接缝不该产生一条 Journal）', () => {
    expect(trimBoundaryCommand(twoShots(), 's#2', 4)).toBeNull();
  });
});

describe('拖片尾：改的是 meta.duration（整片拉长 / 缩短）', () => {
  it('拉到 12s → 片长 12，镜头边界不动', () => {
    const before = twoShots();
    const cmd = trimEndCommand(before, 12);
    expect(cmd).toEqual({ op: 'set_meta', duration: 12 });
    const after = commit(before, [cmd as Command], 'trim-scene');
    expect(after.meta.duration).toBe(12);
    expect(findScene(after, 's#2')?.bornAt).toBe(4);
    expect(validate(after).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('★ 片长有下限：不能短于「最后一镜起点 + 最短镜长」', () => {
    expect(trimEndCommand(twoShots(), 1)).toMatchObject({ duration: 4 + MIN_SCENE_SECONDS });
  });

  it('★ 没有镜头表时同样可拖（整片一镜，片尾就是片尾）', () => {
    const bare = makeDoc([], 8);
    expect(trimEndCommand(bare, 3)).toEqual({ op: 'set_meta', duration: 3 });
    expect(trimEndCommand(bare, 0)).toMatchObject({ duration: MIN_SCENE_SECONDS });
  });

  it('没变化 → null', () => {
    expect(trimEndCommand(twoShots(), 8)).toBeNull();
  });
});

describe('拖动中的预览文档：拖到哪儿 = 松手后是什么', () => {
  it('★ 预览与提交走同一套规则（不然「看到的」和「得到的」会分叉）', () => {
    const before = threeShots();
    const preview = withTrimPreview(before, { kind: 'boundary', sceneId: 's#2' }, 5, 60);
    const cmd = trimBoundaryCommand(before, 's#2', 5);
    const after = commit(before, [cmd as Command], 'trim-scene');
    expect(findScene(preview, 's#2')?.bornAt).toBe(findScene(after, 's#2')?.bornAt);
    expect(preview.meta.duration).toBe(after.meta.duration);
  });

  it('★ 预览不改原文档（拖动中的几十个中间值一个都不进 Journal）', () => {
    const before = twoShots();
    const snapshot = JSON.stringify(before);
    withTrimPreview(before, { kind: 'boundary', sceneId: 's#2' }, 5, 60);
    withTrimPreview(before, { kind: 'end' }, 12, 60);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('预览同样夹下限（拖到底看到的就是 0.2s，不会先看到 0 再跳回来）', () => {
    const preview = withTrimPreview(twoShots(), { kind: 'boundary', sceneId: 's#2' }, -5, 60);
    expect(findScene(preview, 's#2')?.bornAt).toBe(MIN_SCENE_SECONDS);
    expect(withTrimPreview(twoShots(), { kind: 'end' }, -5, 60).meta.duration).toBe(4 + MIN_SCENE_SECONDS);
  });

  it('片尾预览只动 meta.duration', () => {
    const before = twoShots();
    const preview = withTrimPreview(before, { kind: 'end' }, 12, 60);
    expect(preview.meta.duration).toBe(12);
    expect(preview.scenes).toEqual(before.scenes);
  });
});

describe('拉伸的可撤销性：一次拖动 = 一个 compound = 一次撤销', () => {
  it('★ 拖完再撤销 → 镜头边界与片长【一起】回到原样', () => {
    let clock = 1_700_000_000_000;
    const before = twoShots();
    const j = createJournal(before, { now: () => (clock += 1000) });
    const cmd = trimBoundaryCommand(before, 's#2', 5) as Command;
    applyCommands({ baseVersion: j.currentVersion(), commands: [cmd] }, {
      journal: j,
      budget: () => NO_BUDGET,
      actor: 'user',
      gestureId: 'trim-scene#1',
      now: () => (clock += 1000),
    });
    const cs = j.compounds();
    expect(cs).toHaveLength(1);
    const cmp = cs[0];
    if (cmp === undefined) throw new Error('缺 compound');
    expect(cmp.settled).toBe(true); // 不 settle 的话撤销按钮永远是灰的
    expect(findScene(j.currentDoc(), 's#2')?.bornAt).toBe(5);

    j.revertCompound(cmp.compoundId);
    const back = j.currentDoc();
    expect(findScene(back, 's#2')?.bornAt).toBe(4);
    expect(back.meta.duration).toBe(before.meta.duration);
  });
});
