/**
 * 镜头命令暴露给模型之后的工具表约束。
 *
 * 这一份守的是【信任边界】（不变量 4）在工具层的那一侧：
 *   模型只表达意图，引擎负责一切判定。具体两件事：
 *
 *   1. add_scene.id 是【引擎专用】字段（remove_scene 的逆操作按原 id 装回镜头用），
 *      **绝不能**出现在工具 schema 里 —— 否则模型可以自己指定镜头 id，
 *      而 id 分配必须是"从文档现状推导"的确定过程。
 *   2. 镜头/标记的 id 与对象/效果 id 是四套东西，最容易混。命令分支的
 *      required 与字段集合必须与引擎的命令类型逐字对齐，否则模型写的形状
 *      会被形状校验拦下，而它看不出为什么。
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '@sva/engine-core';
import { TOOLS } from '../src/tools';
import { SYSTEM_PROMPT } from '../src/prompt';

function branches(): JsonSchema[] {
  const params = TOOLS.find((t) => t.name === 'apply_commands')?.parameters as Record<string, unknown>;
  const commands = (params['properties'] as Record<string, JsonSchema>)['commands'];
  return ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
}

function branchOf(op: string): JsonSchema {
  for (const b of branches()) {
    const props = (b['properties'] ?? {}) as Record<string, JsonSchema>;
    if (((props['op']?.['enum'] ?? []) as string[])[0] === op) return b;
  }
  throw new Error('找不到命令分支 ' + op);
}

function propsOf(op: string): Record<string, JsonSchema> {
  return (branchOf(op)['properties'] ?? {}) as Record<string, JsonSchema>;
}

/** 取出 anyOf:[T, null] 里的 T。 */
function innerOf(schema: JsonSchema): JsonSchema {
  return ((schema['anyOf'] as JsonSchema[] | undefined)?.[0] ?? schema) as JsonSchema;
}

describe('镜头命令已经暴露给模型', () => {
  it('四条命令分支都在（add_scene / set_scene / remove_scene / retime）', () => {
    const ops = branches().map(
      (b) => (((b['properties'] ?? {}) as Record<string, JsonSchema>)['op']?.['enum'] as string[])?.[0],
    );
    for (const op of ['add_scene', 'set_scene', 'remove_scene', 'retime']) {
      expect(ops, '缺少命令分支 ' + op).toContain(op);
    }
  });

  it('★ add_scene 里【不许】有 id 字段（那是引擎专用，模型不能指定镜头 id）', () => {
    const props = propsOf('add_scene');
    expect(props['id']).toBeUndefined();
    // 也确认它确实不是被别的名字漏进去的
    expect(Object.keys(props).sort()).toEqual(['at', 'bornAt', 'name', 'op']);
  });

  it('★ 命令分支里不出现引擎专用字段（防止以后顺手加回来）', () => {
    // 引擎专用：add_scene.id（逆操作按原 id 装回）、retime.activeSceneId（场景 Agent 身份）。
    // ★ 只看【命令分支】：顶层工具参数里的 get_object.id 是正当的，
    //   对整表做字符串搜索会把它误伤。
    const text = JSON.stringify(branches());
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('activeSceneId');
  });

  it('add_scene 的位置字段是 bornAt / at 两个可空项（引擎强制"二选一"，schema 只能说可空）', () => {
    const props = propsOf('add_scene');
    // strict 模式要求所有属性进 required，所以"二选一"表达不了 ——
    // 由引擎在 apply 阶段报 invalid_argument，回执里会说清"必须给一个"。
    expect(props['bornAt']?.['anyOf']).toHaveLength(2);
    expect(props['at']?.['anyOf']).toHaveLength(2);
    expect(innerOf(props['bornAt']!)['type']).toBe('number');
    expect(innerOf(props['at']!)['type']).toBe('string');
    // obj() 的 required 就是 Object.keys(props)（插入顺序），逐字对上
    expect(branchOf('add_scene')['required']).toEqual(['op', 'name', 'bornAt', 'at']);
  });

  it('set_scene 改的是 name / bornAt，而且【没有】混进 scene.meta 的字段', () => {
    const props = propsOf('set_scene');
    expect(Object.keys(props).sort()).toEqual(['bornAt', 'name', 'op', 'target']);
    // duration / fps 是 meta 的，不是镜头的 —— 一度差点被 fieldsOf('scene.meta') 带进来
    expect(props['duration']).toBeUndefined();
    expect(props['fps']).toBeUndefined();
  });

  it('remove_scene 只说 target，不暴露"接管者"（那由引擎按 sceneOrder 推导）', () => {
    const props = propsOf('remove_scene');
    expect(Object.keys(props).sort()).toEqual(['op', 'target']);
  });

  it('retime 只有 fromMarker / delta（scope 由运行时决定，不由模型写）', () => {
    const props = propsOf('retime');
    expect(Object.keys(props).sort()).toEqual(['delta', 'fromMarker', 'op']);
    expect(innerOf(props['delta']!)['type']).toBe('number');
    expect(props['fromMarker']?.['type']).toBe('string');
  });

  it('描述里必须说清模型会踩的坑（id 形态 / 只挪边界 / 自动接管）', () => {
    const addTxt = JSON.stringify(propsOf('add_scene'));
    const setTxt = JSON.stringify(propsOf('set_scene'));
    const removeTxt = JSON.stringify(propsOf('remove_scene'));
    // add_scene：说清 at 是"接在谁之后"，并且要给出 id 形态
    expect(addTxt).toContain('s#1');
    expect(addTxt).toContain('结束之后');
    // set_scene：说清只挪边界、且会改变前一镜的结束时刻
    expect(setTxt).toContain('只挪边界');
    expect(setTxt).toContain('前一镜');
    // remove_scene：说清内容不会丢 + 最后一镜不许删
    expect(removeTxt).toContain('改归属');
    expect(removeTxt).toContain('最后一个镜头不许删');
  });

  it('命令分支总数（新增四条后仍然是 strict 的：required == properties）', () => {
    const all = branches();
    expect(all.length).toBeGreaterThanOrEqual(14);
    for (const b of all) {
      const props = Object.keys((b['properties'] ?? {}) as Record<string, unknown>);
      expect(b['additionalProperties']).toBe(false);
      expect(b['required']).toEqual(props);
    }
  });
});

/**
 * ★ 固定开销预算。
 *
 * 工具 schema 每轮都要重发一次，所以它是【按轮数计费】的。
 *
 * 实测基线（内联 effect 出 create 分支之后）：
 *   系统提示 2940 · 工具表 6008 · 其中 apply_commands 一个 4830（比例 2.04×）
 *
 * ★★ 第二十一轮加了一个【新工具】 render_formula（约 280）：公式是规范 §3 要的能力，
 *   不是重复 —— 所以工具表上限 5800 → **6100**。注意它【不】动 apply_commands
 *   （那条 op 表仍是最大的一块，4830/4900，只剩 ~70）。
 *   单分支：create_plot 321 / create_rect 353 / create_line 336 / create_object 289
 *           set_style 217 / set_rect 136 / set_line 144 / set_text 71 / add_effect 680
 *
 * ★ 第十九轮又加了【四个编辑能力】（形状参数三条 + set_style 补四个字段）：毛增 454。
 *   按 §0.14 的先例先删掉与提示词重复的说明（约 290：localId 的第二句、camera_preset 的枚举复述、
 *   add_effect.target 的"为什么"、retime.delta 的枚举、set_parent.parent、remove_scene.target 等），
 *   净增约 164。**上限随之从 5600/4700 重标定到 5800/4900** —— 理由是"这是新能力，不是重复"，
 *   而且刻意留出 ~200 给 P3（文字样式字段），否则下一轮又会卡在这里。
 *   绝对上限本来就是随功能走的刻度，**真正拦膨胀的仍是下面那条相对关系（当前 1.90×）**。
 *           add_effect 728 / set_highlight 165 / set_move_along 132 / set_visibility 132
 *
 * ★★ 第十七轮做掉了那条最大的减法：**内联 effect 出四条 create 分支**。
 *   实测省下 **1017**（apply_commands 5551 → 4534；四条分支合计 2489 → 1409，
 *   其中多出来的那 ~180 是 localId 的格式说明 —— 它是【实测补上的】，见下）——
 *   比交接文档里估的 ~680 多得多，因为每条分支当时带的是【两份】完整效果形状
 *   （drawOn + highlight，含 registry 生成的字段描述），而它们与 add_effect 里
 *   那份**逐字相同**：纯粹是重复。
 *
 *   ★ 为什么这次敢做（文档里当初挂着"需要拍板"）：
 *     规范 §7 要的是"create_* 支持内联 effect —— **消除假依赖的必要手段**"，
 *     而假依赖的根源是"必须等回执拿到 assignedId 才能挂效果"。引擎的批次
 *     本来就支持符号 id：create_rect {localId:"$c1"} + add_effect {target:"$c1"}
 *     **同一批**提交，依赖由 batch.ts 自动推导；提示词从第一版起就写着
 *     "用 localId 引用同批新对象"。
 *     也就是说：**§7 的理由仍然成立，变的只是表达形式**（一次批量调用里的两条
 *     命令，而不是一条命令的两个字段），而后者是纯粹的重复。引擎侧的
 *     create_*.effect 字段保留（面板 / 预设 / 夹具在用，有 inline-effect.test.ts
 *     守着它）。两条路的等价性有断言：engine-core/test/symbol-effect.test.ts。
 *
 *   ★★ 而且这条路【真调模型验过】，并且第一次就抓出一个缺陷：模型写对了结构
 *     （create + 两条 add_effect 一批），却把 localId 写成 "c1" 而 target 写 "$c1" ——
 *     因为 schema 里 localId 是个【没有任何说明的裸 str】。整批报 unknown_local_id，
 *     白烧一轮（60k 输入 token）。给 localId 补上"必须以 $ 开头"的说明 + 让引擎的
 *     报错说清格式之后，同一个任务变成一轮 3 条命令全绿（轮数 6 → 5，输入 token 60029 → 49972）。
 *     **凡是模型要写的字段，都要问一句"格式说清了吗"** —— 这条已进坑表。
 *
 * ★ 上限这一轮【收紧】了（不是被调松）：6600 → 5600、5600 → 4700。
 *   刚腾出来的空间是给 P3（文字样式 / 公式）用的，所以留出 ~350 的余量，
 *   而不是把上限继续挂在 6600 —— 那样这条护栏就白放了。
 *
 * ★ 还剩下的一条可优化项（仍然需要拍板）：
 *   把 create_rect / create_line 合并回 create_object —— 省约 2×300 token，
 *   代价是形状特定字段失去**类型层**的封闭性（引擎的 field_not_in_shape 仍然
 *   会拦，但拦在提交时而不是形状校验时），而且合并后的分支会要求模型为无关
 *   字段填 null。现在不缺这 600，先不动。
 *
 * ★★ 一个结构事实值得记下来：**工具 schema 比系统提示贵一倍多**
 *   （6291 vs 2845）。想省 token，动提示词几乎没有意义 —— 该动的是
 *   `apply_commands` 的 schema，而它贵的根因是"每条 create 分支都内嵌
 *   一份内联 effect 的完整字段约束"，加了效果类型之后那份还会继续长
 *   （四条 create 分支各 ~620，合计 ~2500，占 apply_commands 的一半）。
 *
 * ★ 提示词的绝对上限从 2900 抬到 3000，理由写在这里而不是悄悄改：
 *   这一轮加了"把东西送过去（moveAlong）"这一节（+143），
 *   而【真正拦住膨胀的是下面那条相对关系（< 2.6×）】——
 *   绝对数字本来就是随功能走的刻度，相对关系才是不会随便被调松的护栏。
 *
 * ★★ 第二十九轮按【用户拍板】再次放宽绝对上限：**8000 / 7000**（此前 6400 / 5200）。
 *   理由与第二十三轮同一条，只是这次更彻底：用户明确「比起节省 token，我更想要画面效果」。
 *   这一轮要加进来的是【能力】而不是废话 —— 视觉评审工具 critique_frame，
 *   以及把 layout 自检的问题说清楚所需要的描述。
 *   ★ 相对护栏（下面那条 2.6×）依旧一条没动。
 *
 * ★★ 第二十三轮按【用户拍板】放宽了绝对上限：**6400 / 5200 / 3100**（此前 6100 / 4900 / 3000）。
 *   理由：基本功能已成型，接下来要么加能力（多行公式、编排），要么重跑压力测试 ——
 *   继续把力气花在"再省 50 token"上不划算。**相对护栏（下面那条 2.6×）一条没动**，
 *   它才是真正拦住"schema 悄悄膨胀到没人读得懂"的那道；当前 2.04×。
 *
 * ★ 这里【记录事实】而不是拍一个好看的数。已知的可优化项（都需要拍板）：
 *   1. 把内联 effect 从四条 create 分支里拿掉、一律走 add_effect
 *      —— 省约 4×170 token，但规范 §7 明确要求 create_* 支持内联 effect
 *      （"消除假依赖的必要手段"）；现在 moveAlong 就【只】在 add_effect 里，
 *      正是这条预算压力下的取舍（schema-from-registry 里有一条断言守着它）；
 *   2. 把 create_rect / create_line 合并回 create_object
 *      —— 省约 2×550 token，代价是形状特定字段失去类型层的封闭性。
 *
 * 估算刻意粗糙：目的是挡住数量级上的失控，真实 token 以 API 回执为准。
 */
function estTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e80) cjk += 1;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

describe('固定开销有预算', () => {
  it('整个工具表的粗估开销不超过 8000（第二十九轮放宽，此前 6400）', () => {
    const n = estTokens(JSON.stringify(TOOLS));
    expect(n, '工具表开销涨到 ' + n + '（放宽后的上限 8000）。加工具或加长 description 前先想清楚性价比').toBeLessThan(8000);
  });

  it('apply_commands 一个不超过 7000（第二十九轮放宽，此前 5200）——它是最大的一块', () => {
    // ★ 上限以【拍板的数】为准：以前这里的标题写着 5200、断言却还是 4900 ——
    //   标题与断言各说各话，等于两条护栏里只有紧的那条在生效，而没人知道是哪一条。
    //   **标题与断言里必须是同一个数**（坑表里那条）。
    const cmd = TOOLS.find((t) => t.name === 'apply_commands');
    const n = estTokens(JSON.stringify(cmd));
    expect(n).toBeLessThan(7000);
  });

  it('系统提示不超过 3600（第二十九轮加了「画面规范」一节，此前 3100 / 2940）', () => {
    // ★ 这一节是 §0.28 四【点名】的缺口：「提示词里一条画质规范都没有 ——
    //   2940 token 全在讲怎么调命令，没有任何一句讲画面怎么才好看。这条一分钱不花」。
    //   付账方式先说清楚：相对护栏（下面那条 2.6×）没动，而且顺手删掉了一处重复
    //   （highlight 那一节末尾的「别用透明度」与节首重复）。
    expect(estTokens(SYSTEM_PROMPT)).toBeLessThan(3600);
  });

  it('★ 相对约束：工具表不许超过系统提示的 2.6 倍（当前 2.07×）', () => {
    // 绝对上限会随功能增长而调；相对关系是一条不会随便被调松的护栏 ——
    // 它挡住的是"schema 悄悄膨胀到没人再读得懂"这件事。
    const tools = estTokens(JSON.stringify(TOOLS));
    const prompt = estTokens(SYSTEM_PROMPT);
    expect(tools / prompt, '工具表相对提示词膨胀了：' + (tools / prompt).toFixed(2) + '×').toBeLessThan(2.6);
  });
});

