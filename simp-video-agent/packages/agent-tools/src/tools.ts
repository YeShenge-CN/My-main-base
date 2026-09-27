/**
 * 工具定义与分发。
 *
 * 所有 schema 都是 strict 形态（P6 清单第 3 条）：
 *   - object 的所有属性都进 required
 *   - additionalProperties: false
 *   - 可选字段写成 anyOf:[T, {type:"null"}]，null 表示"这一项不改"
 *   - 不用 minLength / maxItems（DeepSeek strict 不接受）
 *
 * ★ 一个结构性发现：strict 的 additionalProperties:false 与"动态键"天然冲突。
 *   所以 create_plot 的内联 motion（键是任意轨道路径，如 'tf.opacity'）
 *   无法在 strict schema 里表达 —— 只能用 set_motion 分两步做。
 *   内联 style 之所以可行，是因为每个 shape 的样式字段是【封闭集合】。
 *   这一点与规范 §7 "create_* 必须支持内联 motion"直接冲突，需要你定夺：
 *   (a) 放弃 strict，(b) 把轨道路径也枚举进 schema，(c) motion 一律走 set_motion。
 *   我暂时按 (c) 实现。
 */
import {
  ALL_GROUPS,
  applyCommands,
  encodeFormulaGeometry,
  generateObjectSchema,
  getObject,
  getRenderState,
  getSceneSummary,
  DEFAULT_SUMMARY_TOKEN_BUDGET,
  REGISTRY,
  type BudgetState,
  type Command,
  type CreateOwner,
  type JsonSchema,
  type RenderState,
  type SceneDoc,
  type Journal,
  type ValidatorGroup,
  type Proposal,
  validate,
  summarizeIssues,
  autoFix,
  VIEWPORT_MAX_PX,
  VIEWPORT_MIN_PX,
  type Scope,
} from '@sva/engine-core';
import {
  L1_MAX_FRAMES,
  L2_MAX_IMAGES,
  L2_MAX_RENDER_CALLS,
  NOT_LOOKED_MESSAGE,
  type BudgetTracker,
} from './budget';
import { renderFormula } from './formula';
import type { CritiqueResult } from './critique';

/* ── schema 构造小工具 ─────────────────────────────────────── */

const num = { type: 'number' } as const;
const str = { type: 'string' } as const;

/**
 * 新建对象的【符号名】：同批后续命令用它引用这个新对象。
 *
 * ★ 这个说明是【实测补上的】：把内联 effect 从 create_* 拿掉之后，
 *   真调模型的第一轮就写了 `localId:"c1"` 配 `target:"$c1"` ——
 *   结构完全正确，只是漏了 `$` 前缀，于是整批报 `unknown_local_id`，
 *   白烧一轮（那一轮 60k 输入 token）。
 *   以前模型几乎不需要 localId（内联 effect 一步到位），所以这个"裸 str"
 *   的缺口一直没暴露 —— **凡是模型要写的字段，都要问一句"格式说清了吗"**。
 */
const localIdField = {
  type: 'string',
  description: '本批次的符号名，必须以 $ 开头（如 $c1）。',
} as const;

const nullable = (schema: unknown): unknown => ({ anyOf: [schema, { type: 'null' }] });

/**
 * ★★ 一条会让人白跑一趟的硬约束：**schema 里不许出现嵌套 anyOf**。
 *
 *   `nullable({ anyOf: [A, B] })` 会被 DeepSeek 的 strict 校验【整表拒收】：
 *     Invalid tool parameters schema : field `anyOf`: field `anyOf`: missing field `type`
 *   也就是模型一次都调不到（不是"少一个效果类型"）。它曾经在四条 create 分支的
 *   内联 effect 里活了整整三轮，因为真调模型的测试全是 opt-in。
 *
 *   现在有两道守卫：`schema-from-registry.test.ts` 的结构断言（逐节点查，毫秒级）+
 *   一条 opt-in 的 API 金丝雀（`tool-schema-api.test.ts`，SVA_ACCEPTANCE=1）。
 *   要写"可空的联合"时，把 null 与各支**并列在同一层**：`{anyOf:[A, B, {type:'null'}]}`。
 */

function obj(props: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  };
}

const arr = (items: unknown): Record<string, unknown> => ({ type: 'array', items });

/**
 * ★ 字段级 schema 一律从 FieldRegistry 生成（规范 §6 的第 1 份产物）。
 *
 * 在这个改动之前，下面的 min/max/enum 都是手写的 —— 于是"模型看见的范围"
 * 与"校验器接受的范围"会各自漂移。最典型的例子：samples 在 registry 里
 * 下限是 16、自动修的目标是 2400，而手写 schema 只有一个光秃秃的 integer，
 * 模型根本看不见下限，只能靠引擎每次替它擦。
 *
 * groupId 的形态不统一（'shape.plot2d.params' 是 kind.owner.section，
 * 'motion.key' 是 kind.组名，section 藏在分组里），所以这里【不猜】——
 * 直接按 kind + 名字去 registry 里找，section 从找到的分组上读。
 */
function fieldsOf(groupId: string, include?: readonly string[]): JsonSchema {
  const dot = groupId.indexOf('.');
  const kind = groupId.slice(0, dot < 0 ? groupId.length : dot);
  const name = dot < 0 ? undefined : groupId.slice(dot + 1);
  const group = REGISTRY.groups.find(
    (g) => g.kind === kind && (name === undefined || g.owner === name || g.section === name || g.id === groupId),
  );
  if (group === undefined) {
    throw new Error('registry 里找不到分组 ' + groupId + '（可用: ' + REGISTRY.groups.map((g) => g.id).join(', ') + '）');
  }
  return generateObjectSchema(
    group,
    include === undefined ? { mode: 'all-nullable' } : { mode: 'all-nullable', include },
  );
}

/**
 * 取出 all-nullable 包装里的【真实字段约束】。
 *
 * ★ 改一个字段的描述时必须先脱掉这层 `anyOf`：描述挂在 anyOf 外层虽然模型也看得到，
 *   但仓库里的读法（测试、面板）都是"inner 才是字段本身"，两处形状不一致迟早出事。
 */
function innerField(schema: JsonSchema): JsonSchema {
  return (schema['anyOf'] as JsonSchema[] | undefined)?.[0] ?? schema;
}

/** 从生成出来的 object schema 里取单个字段（保持同一份约束）。 */
function fieldOf(groupId: string, key: string): JsonSchema {
  const props = (fieldsOf(groupId, [key])['properties'] ?? {}) as Record<string, JsonSchema>;
  const hit = props[key];
  if (hit === undefined) throw new Error('registry 分组 ' + groupId + ' 缺少字段 ' + key);
  return hit;
}

/* ── apply_commands 的命令分支 ─────────────────────────────── */

const OWNER = obj({
  kind: { type: 'string', enum: ['scene', 'global'] },
  sceneId: nullable(str),
});

const PLOT_STYLE = fieldsOf('shape.plot2d.style');

/**
 * 效果载荷：type 是命令层的判别字段（registry 只描述某一类效果的参数），
 * 参数部分全部由 registry 生成。
 */
const EFFECT = fieldsOf('effect.drawOn.params');
const HIGHLIGHT = fieldsOf('effect.highlight.params');
const MOVE_ALONG = fieldsOf('effect.moveAlong.params');
const APPEAR = fieldsOf('effect.appear.params');
const DISAPPEAR = fieldsOf('effect.disappear.params');

/**
 * 【创建】时用的效果形状：参数是必填的。
 *
 * ★ 这里曾经有一个实测出来的坑：创建与编辑用了同一份 all-nullable 形状，
 *   而 effect 又比 style 多嵌一层 `params`，于是模型很自然地写成
 *     "effect": { "type":"drawOn", "start":0, "duration":1.5, ... }   ← 参数写在顶层
 *   引擎的字段路径偏偏是 effect.params.* —— 结果 params 落地成 {}，
 *   duration 变成"缺失"，被判成 drawon_duration_nonpositive 并自动夹到 0.2，
 *   模型要的 1.5 秒生长变成 0.2 秒。三次真实运行都稳定复现。
 *
 *   现在创建/追加效果时 params 及其字段【必填】，形状校验会当场挡住写错的层级。
 *
 * ★ 两种效果类型各一个分支（`anyOf`）。刻意【不】做"一个分支里 type 用 enum、
 *   params 全可空"：那正是上面那个坑的形状 —— params 里会出现"另一个类型的字段"，
 *   而 strict schema 无法表达"按 type 二选一"。每种效果一份完整形状更笨但不会错。
 */
function inlineEffect(type: string, params: JsonSchema): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [type] },
      params: {
        type: 'object',
        properties: (params['properties'] ?? {}) as Record<string, unknown>,
        required: (params['required'] ?? []) as string[],
        additionalProperties: false,
      },
    },
    // ease 是可选的（省略 = 线性）；strict 下写成 nullable 更省心，这里直接省略
    required: ['type', 'params'],
    additionalProperties: false,
  };
}

/**
 * 效果的形状（五种类型各一支）。
 *
 * ★★ 它【只】出现在 `add_effect` 里 —— 四条 `create_*` 分支的"内联 effect"已经拿掉。
 *
 *   这是一次【用 token 换结构】的取舍，理由不是"预算不够所以砍功能"：
 *
 *   1. 内联 effect 的代价是**每支都要在四条 create 分支里复制一份**：
 *      drawOn + highlight 两份 ≈ 680 token，而它们与 `add_effect` 里的那两份
 *      **逐字相同**。这是纯粹的重复。
 *   2. 它换来的东西（"建对象 + 挂效果"一次说完）**并不需要内联**：
 *      引擎的批次本来就支持符号 id —— `create_rect {localId:"$c1"}` 之后紧跟
 *      `add_effect {target:"$c1"}`，两条命令**在同一批**、依赖由引擎自动推导
 *      （`batch.ts` 的 `mapLocalIds` / `referencedLocalIds`）。
 *      规范 §7 要的是"消除假依赖"，而假依赖来自"要等回执拿到 assignedId 才能挂效果"；
 *      同一批的符号 id 已经把这件事消掉了 —— 换句话说：**§7 的理由仍然成立，
 *      变的只是表达形式**（一次批量调用里的两条命令，而不是一条命令的两个字段）。
 *   3. 提示词里"用 localId 引用同批新对象"从第一版起就写着（`prompt.ts` 第 3 条
 *      与 id 一节），所以模型不需要学新东西。
 *
 *   ⚠️ 引擎侧的 `create_*.effect` 字段**保留**（`inline-effect.test.ts` 一直守着它）：
 *      面板、预设、测试夹具仍然可以用一条命令建出"带效果的对象"。
 *      拿掉的是【模型看得到的那个字段】，不是这个能力。
 *      想加回来时，`schema-from-registry.test.ts` 里有一条断言会告诉你动哪里。
 */
const EFFECT_ADD: Record<string, unknown> = {
  anyOf: [
    inlineEffect('drawOn', EFFECT),
    inlineEffect('highlight', HIGHLIGHT),
    /**
     * moveAlong / appear / disappear 从一开始就只在 add_effect 里
     * （它们要么需要"已经存在的另一个对象"，要么本来就与"建对象"无关）。
     * 现在五种类型都在这里 —— 模型只有这一条路，不用记"哪三种能内联"。
     */
    inlineEffect('moveAlong', MOVE_ALONG),
    inlineEffect('appear', APPEAR),
    inlineEffect('disappear', DISAPPEAR),
  ],
};

/**
 * 动画关键帧的字段（t / v / ease）。
 *
 * ★ 从 registry 生成，所以 ease 拿到了 enum 白名单。
 *   压力测试实测：模型写过 `"ease":"easeOut"` —— 这个缓动名不存在，
 *   而 applyEase 对未知名字是【静默回退 linear】，模型永远不知道自己写错了。
 *   现在它在形状校验层就会被挡住。
 *   ease 传 null 表示"用线性"（strict 模式下"不改/不指定"统一用 null 表达）。
 */
const ANIM_KEY = obj({
  ...((fieldsOf('motion.key')['properties'] ?? {}) as Record<string, unknown>),
});

const ANIM_NODE = nullable(
  obj({
    kind: { type: 'string', enum: ['keys', 'expr'] },
    keys: nullable(arr(ANIM_KEY)),
    expr: nullable(str),
  }),
);

const COMMAND_BRANCHES: Record<string, unknown>[] = [
  obj({
    op: { type: 'string', enum: ['create_plot'] },
    localId: localIdField,
    ...((fieldsOf('shape.plot2d.params', ['expr', 'domain', 'samples'])['properties'] ?? {}) as Record<string, unknown>),
    style: nullable(PLOT_STYLE),
    // ★ 没有 effect 字段了：要挂效果就紧跟一条 add_effect，target 写这里的 localId（见 EFFECT_ADD 的注释）
    owner: OWNER,
  }),
  /** 结构图的两个基元：矩形（方块）与线段/箭头（连线）。 */
  obj({
    op: { type: 'string', enum: ['create_rect'] },
    localId: localIdField,
    ...(fieldsOf('shape.rect.params')['properties'] as Record<string, unknown>),
    style: nullable(fieldsOf('shape.rect.style')),
    // ★ 没有 effect 字段了：要挂效果就紧跟一条 add_effect，target 写这里的 localId（见 EFFECT_ADD 的注释）
    owner: OWNER,
  }),
  obj({
    op: { type: 'string', enum: ['create_line'] },
    localId: localIdField,
    ...(fieldsOf('shape.line.params')['properties'] as Record<string, unknown>),
    style: nullable(fieldsOf('shape.line.style')),
    // ★ 没有 effect 字段了：要挂效果就紧跟一条 add_effect，target 写这里的 localId（见 EFFECT_ADD 的注释）
    owner: OWNER,
  }),
  obj({
    op: { type: 'string', enum: ['create_object'] },
    localId: localIdField,
    shape: {
      type: 'string',
      enum: ['text'],
      description:
        '要新建的对象类型（本分支只支持 text）。★ 引擎【没有】圆 / 树 / 流程图布局 这类形状。',
    },
    params: fieldsOf('shape.text.params', ['content']),
    style: nullable(fieldsOf('shape.text.style')),
    // ★ 没有 effect 字段了：要挂效果就紧跟一条 add_effect，target 写这里的 localId（见 EFFECT_ADD 的注释）
    owner: OWNER,
  }),
  obj({
    op: { type: 'string', enum: ['set_meta'] },
    ...((fieldsOf('scene.meta', ['duration', 'fps'])['properties'] ?? {}) as Record<string, unknown>),
    viewport: nullable(
      arr({ type: 'integer', minimum: VIEWPORT_MIN_PX, maximum: VIEWPORT_MAX_PX }),
    ),
  }),
  obj({
    op: { type: 'string', enum: ['set_style'] },
    target: str,
    ...((fieldsOf('shape.plot2d.style')['properties'] ?? {}) as Record<string, unknown>),
    /**
     * 另外四种样式字段：它们各自只属于一种形状（rect 的填充、line 的箭头大小、
     * text 的字号），但都是"画一笔时会说出口的词"，所以共用这一条 op。
     * ★ 以前它们【没有任何命令能改】—— 面板画着控件、拖了只说一句"改不动"。
     */
    ...((fieldsOf('shape.rect.style', ['fill', 'fillOpacity'])['properties'] ?? {}) as Record<string, unknown>),
    ...((fieldsOf('shape.line.style', ['headSize'])['properties'] ?? {}) as Record<string, unknown>),
    ...((fieldsOf('shape.text.style', ['size', 'align', 'maxWidth', 'bold'])['properties'] ?? {}) as Record<string, unknown>),
  }),
  /**
   * 形状几何参数（三条）。
   *
   * ★ 每种形状一条 op：字段集是形状自己的，并成一条会让"给曲线设置 from/to"
   *   变成合法但无意义的命令。引擎会检查形状，写错目标当场被拒。
   * ★ 字段全部来自 registry（约束不许手写）。
   */
  obj({
    op: { type: 'string', enum: ['set_rect'] },
    target: { type: 'string', description: '矩形对象的 id（rect#1）。' },
    ...((fieldsOf('shape.rect.params')['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({
    op: { type: 'string', enum: ['set_line'] },
    target: { type: 'string', description: '线段 / 箭头对象的 id（line#1）。' },
    ...((fieldsOf('shape.line.params')['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({
    op: { type: 'string', enum: ['set_text'] },
    target: { type: 'string', description: '文字对象的 id（text#1）。' },
    ...((fieldsOf('shape.text.params')['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({ op: { type: 'string', enum: ['set_expression'] }, target: str, expr: fieldOf('shape.plot2d.params', 'expr') }),
  obj({
    op: { type: 'string', enum: ['set_transform'] },
    target: str,
    ...((fieldsOf('object.tf')['properties'] ?? {}) as Record<string, unknown>),
  }),  obj({
    op: { type: 'string', enum: ['set_parent'] },
    target: { type: 'string', description: '要改归属的【对象】id。' },
    parent: nullable({
      // "整组一起动"的用法在系统提示里有一整节，这里只留字段本身的约束。
      type: 'string',
      description: '父对象 id（继承它的变换）。null = 脱离分组。成环会被当场拒。',
    }),
  }),
  obj({
    op: { type: 'string', enum: ['set_effect'] },
    target: {
      type: 'string',
      description: '【效果】的 id（形如 eff#1），不是对象 id —— 新建对象时用内联 effect / add_effect。',
    },
    ...((EFFECT['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({
    op: { type: 'string', enum: ['set_motion'] },
    target: { type: 'string', description: '对象 id。' },
    field: {
      type: 'string',
      // ★ 这里只留"schema 独有的信息"：params.expr 不能驱动、以及 tf./style. 前缀
      //   那两条【系统提示里已经写过一遍】，每轮重发的两份里留一份就够。
      description:
        '轨道路径（带 tf. / style. 前缀），如 tf.opacity、style.width。' +
        '★ style.stroke 也能动：颜色字段的关键帧之间按颜色插值，不是到点突变。',
    },
    node: ANIM_NODE,
  }),
  obj({
    op: { type: 'string', enum: ['camera_preset'] },
    preset: {
      type: 'string',
      enum: ['pushIn', 'pullOut', 'reset'],
      description: '镜头预设。会【替换】整条相机轨（不是追加）。',
    },
    subject: nullable(str),
    duration: nullable(num),
    intensity: nullable(num),
  }),
  obj({
    op: { type: 'string', enum: ['add_effect'] },
    target: {
      type: 'string',
      description:
        '要挂效果的对象 id（形如 plot#1），或同一批里刚建对象的符号 id（$c1）—— 后者免去等回执。',
    },
    effect: EFFECT_ADD,
  }),
  obj({
    op: { type: 'string', enum: ['set_highlight'] },
    target: {
      type: 'string',
      description: '【效果】的 id（eff#1），不是对象 id。',
    },
    ...((HIGHLIGHT['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({
    op: { type: 'string', enum: ['set_move_along'] },
    target: {
      type: 'string',
      description: '【效果】的 id（eff#1），不是对象 id。',
    },
    ...((MOVE_ALONG['properties'] ?? {}) as Record<string, unknown>),
  }),
  obj({
    op: { type: 'string', enum: ['set_visibility'] },
    target: {
      type: 'string',
      description: 'appear / disappear 效果的 id（eff#1），别的类型会被拒。',
    },
    /**
     * ★ 只有一个 `at`：appear 与 disappear 的字段集完全一样（这就是它们共用一条 op 的理由）。
     *   边界与默认值仍然来自 registry（见 appear 分组），这里只把描述改成对两者都成立的说法 ——
     *   registry 里那份描述是"出现时刻"，照抄过来会让"改消失时刻"这个用法读起来自相矛盾。
     */
    at: nullable({
      ...(innerField(fieldOf('effect.appear.params', 'at')) as Record<string, unknown>),
      description: '新的时刻（秒）：对 appear 是出现时刻，对 disappear 是消失时刻。',
    }),
  }),

  /* ── 镜头表（P12）────────────────────────────────────────────
   * ★ 这四条以前不在工具表里，模型看不见它们。现在渲染已经能按镜切
   *   （engine-core 的 shot.ts），所以暴露出来【不是空转】：
   *   建了镜头，画面就真的按镜分段。
   *
   * ★ add_scene 的 `id` 字段【刻意不放进来】：那是引擎专用字段
   *   （remove_scene 的逆操作按原 id 装回镜头用）。让模型指定镜头 id
   *   会把"谁分配 id"这件事变成可被模型影响 —— 而 id 分配必须是
   *   从文档现状推导的确定过程（不变量 1）。schema_from_registry 里有一条
   *   断言守着这个字段不许出现。
   */
  obj({
    op: { type: 'string', enum: ['add_scene'] },
    name: nullable(str),
    bornAt: nullable({
      type: 'number',
      description: '这一镜的起点（秒），相对【整片】时间轴而不是上一镜。',
    }),
    at: nullable({
      type: 'string',
      description:
        '接在哪个镜头【结束之后】—— 传那一镜的 id（形如 s#1），不用先读时间轴算起点。',
    }),
  }),
  obj({
    op: { type: 'string', enum: ['set_scene'] },
    target: { type: 'string', description: '【镜头】的 id（形如 s#1），不是对象 id。' },
    name: nullable({ type: 'string', description: '改镜头名（给人看的）。不能是空串。' }),
    bornAt: nullable({
      type: 'number',
      description:
        '挪这一镜的起点（秒，≥0）。⚠️ 只挪边界、内容不跟着走（要搬内容用 retime），且会改变【前一镜】的结束时刻。',
    }),
  }),
  /**
   * 删掉一个对象。
   *
   * ★★ 它以前【不在】这张表里，而引擎里早就有了 —— 后果是实测抓到的：
   *   用户说「删除当前内容从零开始」，模型只能猜命令名，一次提交了
   *   `[remove_object, delete_object, delete, remove, clear]` —— 4 条
   *   `unsupported_op`，而唯一猜对的 `delete_object` **悄悄生效了**。
   *   「看不见但能用」比「不能用」更坏：一半生效、一半报错，模型和人都看不懂。
   *
   * ★ 描述里那句「id 立刻失效」是冲着另一个实测症状写的：模型删完对象又去
   *   `get_object` 同一个 id，连吃三条「对象不存在」。
   */
  obj({
    op: { type: 'string', enum: ['delete_object'] },
    target: {
      type: 'string',
      description: '要删掉的对象 id（plot#1）。删掉之后这个 id 立刻失效，挂在它身上的效果也一起消失；这一步不可撤销。',
    },
  }),
  obj({
    op: { type: 'string', enum: ['remove_scene'] },
    target: {
      type: 'string',
      description:
        '要删的【镜头】id。镜内对象不会丢（改归属到相邻镜头，优先前一个）。最后一个镜头不许删，删镜头不缩短片长。',
    },
  }),
  obj({
    op: { type: 'string', enum: ['retime'] },
    fromMarker: { type: 'string', description: '【标记】的 id（markers 里的，不是镜头 id）。' },
    delta: {
      type: 'number',
      description:
        '从这个标记起把后面的一切（关键帧 / 效果 / 标记 / 相机 / 镜头边界 / 片长）整体平移多少秒，正数后移。',
    },
  }),
];

/* ── 工具表 ─────────────────────────────────────────────────── */

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'get_scene_summary',
    description:
      '画布总览：版本、时长、fps、图层、对象清单（不含任何参数值）、效果、【镜头表】、标记、锁、当前问题数。' +
      'scenes 给出每一镜的 id / 名字 / 时间范围 / 本镜对象数 —— 空数组表示没有镜头表（全片一镜）。' +
      '硬预算 ' + DEFAULT_SUMMARY_TOKEN_BUDGET +
      ' token，超了会截断并如实报出省略了多少（锁与镜头结构优先保留）。' +
      '想知道某个对象的参数值，必须先 get_object。',
    parameters: obj({}),
  },
  {
    name: 'get_object',
    description: '读取单个对象的参数与样式、时间窗、以及打在它身上的效果。detail=full 时额外返回动画轨道、效果完整参数与该对象路径下的锁。',
    parameters: obj({
      id: str,
      detail: nullable({ type: 'string', enum: ['brief', 'full'] }),
    }),
  },
  {
    name: 'get_render_state',
    description:
      '文字版屏幕状态：每一项的屏幕 AABB【像素】、文本占位、相机 scale、画面外项数，' +
      '以及 world 那一节 —— 它给出【世界单位 ↔ 像素】的换算与世界的可见范围。' +
      '★ 改 tf.x / tf.y 之前必须先看 world.visible：tf 是【世界单位】（原点在画面中心、y 轴向上），' +
      '不是像素。把世界单位当像素写（例如想让标题到顶部却写 y=105）会让对象飞出画布。' +
      '判断重叠/遮挡/构图越界优先用它 —— 比渲染图片便宜几百倍。',
    parameters: obj({ t: num }),
  },
  {
    name: 'render_formula',
    description:
      '把一段 LaTeX 排版成矢量公式放进画面（几何由引擎算，你只管写公式）。' +
      '★ 公式只有这一条路 —— 用文字对象手拼上下标是排不好的。屏幕空间对象，字号不随相机缩放。' +
      '写错了返回 latex_error，改公式再调一次。',
    parameters: obj({
      source: { type: 'string', description: 'LaTeX 源码（不要 $ 定界符），如分式、x^2+y^2=r^2。' },
      x: { type: 'number', description: '世界单位水平位置（tf.x 同一套，可见 ±8）。' },
      y: { type: 'number', description: '世界单位垂直位置（y 向上，可见 ±4.5）。' },
      size: nullable({ type: 'number', description: '字号像素，默认 24（正文 20~32）。' }),
      color: nullable({ type: 'string', description: '颜色 #rrggbb，省略用前景色。' }),
    }),
  },
  {
    name: 'apply_commands',
    description:
      '批量提交领域化命令。返回四态：ok / proposals（命中用户锁，待批准）/ blocked（上游失败）/ errored。intent 里可以写一句"为什么改"，会进操作日志。',
    parameters: obj({
      baseVersion: { type: 'integer' },
      atomic: nullable({ type: 'boolean' }),
      intent: nullable(str),
      commands: arr({ anyOf: COMMAND_BRANCHES }),
    }),
  },
  {
    name: 'render_frames',
    /**
     * ★ 三个数字都从 budget.ts 插值，不手写 —— 手写的那一份一定会与真正的上限漂移，
     *   而漂移的方向永远是"说明比实际上限小"，于是模型以为没额度了（坑表里那条
     *   「护栏的标题与断言各说各话」是同一个病）。
     */
    description:
      '渲染若干时刻的画面。单次最多 ' + L1_MAX_FRAMES + ' 帧；本镜累计最多 ' + L2_MAX_IMAGES +
      ' 张图、最多 ' + L2_MAX_RENDER_CALLS + ' 次调用。超预算直接报错。' +
      '★ 画面是你唯一的视觉依据 —— 文字回执说得再准也答不出「看起来好不好」。' +
      '一次多帧（把关键节点铺开）比反复单帧更省调用次数；看的时候【先看最关键的那一帧】。' +
      '判断重叠/越界这类几何问题仍可先用 get_render_state（便宜几百倍）。',
    parameters: obj({ timestamps: arr(num) }),
  },
  {
    name: 'finish_shot',
    description:
      '声明这个镜头已经做完并结束本轮。调用后本轮立即结束，你不会再有机会修改。' +
      '★ 硬性前提：至少有一个对象、validate 没有 error、并且【已经渲染看过画面】——' +
      '一次 render_frames 都没调过就收尾，会被直接拒绝（get_render_state 不算：它只是文字）。' +
      '★ 收尾时请如实报告：有多项 layout 问题没解决就写清楚，不要声称完成。',
    parameters: obj({ summary: str }),
  },

  {
    name: 'critique_frame',
    description:
      '请一个【独立评审】看这一帧并回结构化意见（不是你自己评价自己 —— 你会放过自己的问题）。' +
      '它渲染这一帧（花 1 张图片额度），换一条系统提示只看这张图，回 findings（每条有 code / severity / detail / fixHint）与 verdict。' +
      '★ 评审看不见你的对话，所以要用 intent 说清你想让人看到什么。' +
      '★ 没发现问题时它回 pass 且 findings 为空 —— 那就不要再改画面了。',
    parameters: obj({
      t: num,
      intent: nullable(str),
      checklist: nullable(arr(str)),
    }),
  },
  {
    name: 'validate',
    description:
      '跑校验器，返回问题清单（含 fixClass 与 suggestedFix）。groups 可选值：environment / semantic / motion / layout / export（默认全跑）。' +
      '注意：文档里【没有对象】时也会报一条 export/empty_shot —— 那说明这一镜还没有内容，不要当成"没问题"。',
    parameters: obj({
      groups: nullable(
        arr({ type: 'string', enum: ['environment', 'semantic', 'motion', 'layout', 'export'] }),
      ),
    }),
  },
];

/**
 * schema 里【模型能看见】的全部 op。
 *
 * ★ 从 COMMAND_BRANCHES 推导，不手写第二份 —— 手写的那份一定会与 schema 漂移。
 * ★ 它的用途只有一个：**把「看不见的命令」挡在引擎外面**。
 *   在此之前，模型猜中一个没暴露的 op（比如 `delete_object`）会**直接生效**，
 *   而猜不中就是 `unsupported_op` —— 同一个批次里一半生效一半报错，
 *   既不像成功也不像失败（实测抓到过，见 delete_object 分支上的注释）。
 *   schema 既然是模型的唯一词汇表，那它就必须同时是**可执行命令的白名单**。
 */
export const SCHEMA_OPS: readonly string[] = COMMAND_BRANCHES.map((b) => {
  const props = b['properties'] as Record<string, { readonly enum?: readonly string[] }> | undefined;
  return props?.['op']?.enum?.[0] ?? '';
}).filter((op) => op !== '');

/* ── 分发 ───────────────────────────────────────────────────── */

export interface ToolContext {
  readonly doc: () => SceneDoc;
  readonly journal: Journal;
  readonly budget: BudgetTracker;
  readonly baseVersion: () => number;
  readonly turnId: string;
  /**
   * 这个 Agent 的身份/权限范围（多 Agent）。
   *
   * 不传 = 导演：全权（可以加删镜头、跨镜指派归属）。
   * 传了 = 场景 Agent：只能动本镜，新建对象默认落在本镜。
   *
   * ★ 它是【编排层给的】，不是模型声明的 —— 这正是信任边界的样子：
   *   模型表达"放一个曲线"，"放进哪一镜"由引擎按身份推导。
   */
  readonly scope?: Scope;
  /** 渲染器由宿主注入：engine-node 提供 headless 实现，浏览器端提供 canvas 实现。 */
  readonly render: (
    doc: SceneDoc,
    timestamps: readonly number[],
  ) => readonly { t: number; pngBase64: string; sha256: string }[];
  readonly now: () => number;
  /**
   * 视觉评审【由宿主注入】——与 render 完全同一条边界。
   *
   * ★ 为什么不在这里直接调模型：dispatchTool 是纯逻辑层（可以毫秒级单测、不联网）。
   *   谁有 API key，谁注入；没有注入时 critique_frame 会如实回 critique_unavailable，
   *   而不是假装评审过了。
   */
  readonly critique?: (req: CritiqueToolRequest) => Promise<CritiqueResult>;
  /** 接口地址（作业 3 起可由页面覆盖）。省略 = DEEPSEEK_BETA_URL。 */
  readonly baseUrl?: string;
  /**
   * 取走本轮的提案决策记录（由宿主提供的审批策略产生）。
   * 压力测试用它统计介入率与 stale 率 —— 引擎只负责记，怎么判是策略的事。
   */
  readonly takeProposalDecisions?: () => readonly string[];
  /**
   * 审批策略。apply_commands 产生提案后交给它 ——
   * 谁能批准、批不批是宿主的事，引擎只负责判定与记账。
   */
  readonly approvalPolicy?: (proposals: readonly { readonly proposal: Proposal }[]) => readonly string[];
  /**
   * 指令级策略。返回一句话表示【拒绝这条命令】。
   *
   * 用途：把'这一镜的对象已经排满'这类制作约束变成模型无法绕过的能力边界。
   * 没有它的时候，模型面对被锁的路径会直接 create_plot 一个新对象把 width 内联进去 ——
   * 完全合法的绕过，而锁是按路径绑定的，于是提案永远不会产生。
   */
  readonly policy?: (cmd: Command) => string | null;
}

/** critique_frame 交给宿主评审函数的东西（文档 + 时刻 + 已经渲染好的那一帧）。 */
export interface CritiqueToolRequest {
  readonly doc: SceneDoc;
  readonly t: number;
  readonly pngBase64: string;
  readonly intent?: string;
  readonly checklist?: readonly string[];
}

export interface ToolOutcome {
  readonly text: string;
  readonly images?: readonly { readonly dataUrl: string; readonly label: string }[];
  /**
   * ★ 终止信号。为 true 时 Runtime 立刻结束本轮 ——
   *   在此之前，终止完全依赖"模型某轮自愿不再调工具"，
   *   而压力测试证明那件事它做不到（20 个镜头里 18 个撞满轮数）。
   */
  readonly finished?: boolean;
}

const json = (v: unknown): string => JSON.stringify(v);

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'get_scene_summary': {
      // ★ issues 字段以前是硬编码 0（`opts.issues ?? 0`），而工具层从没传过它。
      //   于是空文档的摘要写着 issues:0，模型要再花一轮 validate 才知道有事。
      //   现在摘要就把真实问题数报出来 —— 默认入口必须是可信的。
      return { text: json(getSceneSummary(ctx.doc(), { issues: validate(ctx.doc()).length })) };
    }

    case 'get_object': {
      const id = String(args['id'] ?? '');
      const detail = args['detail'] === 'full' ? 'full' : 'brief';
      const view = getObject(ctx.doc(), id, detail);
      return { text: view === null ? json({ error: '对象不存在: ' + id }) : json(view) };
    }

    case 'get_render_state': {
      const t = Number(args['t'] ?? 0);
      const view = getRenderState(ctx.doc(), t, evaluateProduce);
      /**
       * ★ 这【算看过画面】（§0.28 作业 1c）。
       *   文字版屏幕状态给出每项的 AABB 与相机换算，足以判断重叠与越界 ——
       *   如果它不算，模型就会为了过 finish_shot 的关卡去白烧图片额度，正好反效果。
       */
      ctx.budget.markLooked('get_render_state');
      return { text: json(view) };
    }

    case 'render_formula': {
      const source = typeof args['source'] === 'string' ? args['source'] : '';
      const rendered = renderFormula(source);
      if (!rendered.ok) {
        return {
          text: json({
            error: 'latex_error',
            message: rendered.error,
            hint: '检查 LaTeX 语法（不要带 $；分式用 frac 命令，根号用 sqrt 命令）。',
          }),
        };
      }
      const g = rendered.geometry;
      const sizeArg = Number(args['size']);
      const size = Number.isFinite(sizeArg) && sizeArg > 0 ? sizeArg : 24;
      const colorArg = args['color'];
      const color = typeof colorArg === 'string' && colorArg !== '' ? colorArg : ctx.doc().theme.fg;
      /**
       * ★ 归属按【身份】推导，不让模型写：
       *   场景 Agent（有 scope）→ 落在当前这一镜（引擎用 scope 填 sceneId）；
       *   导演视角（没有 scope）→ global（全片共用，不会变成悬空引用）。
       *   让模型自己填 owner 会引入两类错误：填错镜、以及不填。
       */
      const owner: CreateOwner =
        ctx.scope === undefined ? { kind: 'global' } : { kind: 'scene', sceneId: null };
      const commands: Command[] = [
        {
          op: 'create_object',
          localId: '$formula1',
          shape: 'formula',
          params: {
            source: g.source,
            paths: encodeFormulaGeometry(g.subpaths),
            width: g.width,
            ascent: g.ascent,
            depth: g.depth,
          },
          style: { size, fill: color },
          owner,
          intent: '排版公式 ' + g.source,
        },
        {
          op: 'set_transform',
          target: '$formula1',
          x: Number(args['x'] ?? 0),
          y: Number(args['y'] ?? 0),
          intent: '把公式放到 (' + Number(args['x'] ?? 0) + ', ' + Number(args['y'] ?? 0) + ')',
        },
      ];
      const res = applyCommands(
        { baseVersion: ctx.baseVersion(), commands },
        {
          journal: ctx.journal,
          budget: () => ctx.budget.remaining(),
          actor: 'agent',
          turnId: ctx.turnId,
          now: ctx.now,
          ...(ctx.scope === undefined ? {} : { scope: ctx.scope }),
        },
      );
      /**
       * ★ 回执里给出【像素尺寸】与 em 尺度：模型的下一步常常是把它放到标题下面，
       *   而它需要知道刚画出来的东西有多大（§0.6 的教训：它要用的数字必须到达它眼前）。
       */
      return {
        text: json({
          ok: res.ok.length === commands.length,
          id: res.ok[0]?.assignedId ?? null,
          source: g.source,
          emBox: { width: g.width, ascent: g.ascent, depth: g.depth },
          pixelSize: { width: Math.round(g.width * size), height: Math.round((g.ascent + g.depth) * size) },
          errored: res.errored,
          version: res.version,
        }),
      };
    }

    case 'apply_commands': {
      const commands = Array.isArray(args['commands']) ? (args['commands'] as Command[]) : [];
      /**
       * ★★ 词汇表闸门：schema 里没有的 op，一条都不许进引擎。
       *
       *   这不是「多一层校验」—— 它是**唯一**能保证「模型猜出来的命令不会碰巧生效」
       *   的地方。整批拒掉而不是逐条跳过：一半生效比全失败更难查（实测症状见
       *   delete_object 分支上的注释）。回执里给出完整清单，模型下一步就能改对。
       */
      const unknown = [...new Set(commands.map((c) => String((c as { op?: unknown }).op)))]
        .filter((op) => !SCHEMA_OPS.includes(op));
      if (unknown.length > 0) {
        return {
          text: json({
            error: 'unknown_op',
            message:
              '这些命令不在你的命令表里：' + unknown.join(', ') +
              '。可用的 op 只有：' + SCHEMA_OPS.join(' / ') + '。',
            validOps: SCHEMA_OPS,
          }),
        };
      }
      if (ctx.policy !== undefined) {
        for (const c of commands) {
          const why = ctx.policy(c);
          if (why !== null) {
            return { text: json({ error: 'policy_rejected', message: why, rejectedOp: c.op }) };
          }
        }
      }
      const intent = typeof args['intent'] === 'string' ? args['intent'] : undefined;
      const withIntent = intent === undefined ? commands : commands.map((c) => ({ ...c, intent }));
      const res = applyCommands(
        {
          baseVersion: Number(args['baseVersion'] ?? ctx.baseVersion()),
          ...(args['atomic'] === true ? { atomic: true } : {}),
          commands: withIntent,
        },
        {
          journal: ctx.journal,
          budget: () => ctx.budget.remaining(),
          actor: 'agent',
          turnId: ctx.turnId,
          now: ctx.now,
          // ★ 身份/权限范围：场景 Agent 的 `owner.sceneId: null` 落成"我这一镜"，
          //   `retime` 只顺延本镜（越界时整条命令失败）。见 BatchDeps.scope。
          ...(ctx.scope === undefined ? {} : { scope: ctx.scope }),
          // ★ 引擎自动修接在这里。以前它是断的：模型被要求去修引擎自己判定为
          //   "无需任何判断"的问题，然后卡住。
          //   SVA_AUTOFIX_TRACE=1 时把"修之前的问题 / 修之前的样子 / 修了什么"打出来 ——
          //   实测这条 trace 是定位"引擎把好值改坏"这类问题的唯一手段。
          autoFix: () => {
            if (process.env['SVA_AUTOFIX_TRACE'] !== '1') {
              return autoFix({ journal: ctx.journal, now: ctx.now }).fixed;
            }
            const docBefore = ctx.journal.currentDoc();
            const before = validate(docBefore);
            const plan = autoFix({ journal: ctx.journal, now: ctx.now });
            if (plan.fixed.length > 0) {
              console.log(
                '[autofix] issues=' + JSON.stringify(before.map((i) => i.code + '@' + i.path)) +
                  ' effBefore=' + JSON.stringify(docBefore.effects) +
                  ' effAfter=' + JSON.stringify(ctx.journal.currentDoc().effects) +
                  ' fixed=' + JSON.stringify(plan.fixed),
              );
            }
            return plan.fixed;
          },
        },
      );
      if (res.proposals.length > 0 && ctx.approvalPolicy !== undefined) {
        ctx.approvalPolicy(res.proposals);
      }
      return { text: json(res) };
    }

    case 'render_frames': {
      const raw = Array.isArray(args['timestamps']) ? (args['timestamps'] as unknown[]) : [];
      const timestamps = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
      // ★ L1 + L2 都在【渲染之前】检查，绝不先渲染再拒绝
      const check = ctx.budget.checkRender(timestamps);
      if (!check.ok) {
        return {
          text: json({
            error: check.rejection.code,
            message: check.rejection.message,
            budget: ctx.budget.remaining(),
          }),
        };
      }
      const frames = ctx.render(ctx.doc(), timestamps);
      ctx.budget.chargeRender(frames.length);
      ctx.budget.markLooked('render_frames');
      return {
        text: json({
          frames: frames.map((f) => ({ t: f.t, sha256: f.sha256.slice(0, 16) })),
          budget: ctx.budget.remaining(),
          // 让模型随时知道收尾关卡通没通过，而不是等到 finish_shot 被拒才知道
          looked: ctx.budget.lookRecord(),
        }),
        images: frames.map((f) => ({
          dataUrl: 'data:image/png;base64,' + f.pngBase64,
          label: 't=' + f.t,
        })),
      };
    }

    case 'finish_shot': {
      /**
       * ★★ 强制节奏（§0.28 作业 1c）：**没看过画面就不许收尾**。
       *
       *   收尾之后模型再没有机会修改，所以"自信地交一份没校对过的稿"是这里最贵的失败。
       *   这条关卡是整份作业里最便宜的一条，也最直接地治「不看就交」。
       *   ★ 回绝时【不设 finished】—— 本轮继续，模型还有机会补看。
       *   ★ 也刻意不自动帮它看：那会把"模型自己核对过"变成一句空话。
       */
      if (!ctx.budget.hasRenderedFrame()) {
        /**
         * ★ 死锁逃生口：额度已经不够渲染【哪怕一帧】时，一直拒绝收尾会把它困死在
         *   轮数上限里（实测的 maxImages=0 就是这种配置）。这时放行，
         *   但把「从未渲染过」如实写进回执 —— finishReport 会把它报成人看得见的一句话。
         *   ★ 刻意不在这里替它渲染：那会把「模型自己核对过」变成一句空话。
         */
        const canStillRender = ctx.budget.checkRender([0]).ok;
        if (canStillRender) {
          return {
            text: json({
              error: 'look_before_finish',
              message: NOT_LOOKED_MESSAGE,
              look: ctx.budget.lookRecord(),
              next: '调用 render_frames([...]) 看一帧，然后再调 finish_shot。',
            }),
          };
        }
      }
      const summary = typeof args['summary'] === 'string' ? args['summary'] : '';
      /**
       * ★★ 收尾必须【如实】：还剩几项没达标要说出来（§0.28 作业 1 验收第 3 条）。
       *
       *   issues 是总数，但真正的判据是**未决**的那些 —— fixClass 为 agent / human
       *   的问题引擎不会自动修，它们会原样留在成片里。只报总数会让「3 项 auto 被自动修掉」
       *   与「3 项构图缺陷还挂着」在回执里长得一模一样。
       */
      const all = validate(ctx.doc());
      const unresolved = all.filter((i) => i.fixClass !== 'auto');
      return {
        text: json({
          status: 'finished',
          summary,
          issues: all.length,
          unresolved: unresolved.length,
          unresolvedCodes: unresolved.map((i) => i.code),
          looked: ctx.budget.lookRecord(),
          // ★ 关卡放行 ≠ 真的看过。这里如实报出来，收尾话术据此加一句警告。
          lookedFrame: ctx.budget.hasRenderedFrame(),
        }),
        finished: true,
      };
    }

    case 'critique_frame': {
      if (ctx.critique === undefined) {
        return {
          text: json({
            error: 'critique_unavailable',
            message: '这个宿主没有配置视觉评审（critique）。改用 get_render_state 自查，不要假装已经评审过。',
          }),
        };
      }
      const t = Number(args['t'] ?? 0);
      // ★ 走同一套图片预算：评审要的那一帧也是真的渲染、真的进模型
      const check = ctx.budget.checkRender([t]);
      if (!check.ok) {
        return {
          text: json({ error: check.rejection.code, message: check.rejection.message, budget: ctx.budget.remaining() }),
        };
      }
      const frames = ctx.render(ctx.doc(), [t]);
      ctx.budget.chargeRender(frames.length);
      ctx.budget.markLooked('render_frames');
      const png = frames[0]?.pngBase64 ?? '';
      if (png === '') {
        return { text: json({ error: 'render_failed', message: 't=' + t + ' 这一帧没有渲染出来。' }) };
      }
      const intent = typeof args['intent'] === 'string' && args['intent'].trim() !== '' ? args['intent'] : undefined;
      const rawList = Array.isArray(args['checklist']) ? (args['checklist'] as unknown[]) : [];
      const checklist = rawList.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      const result = await ctx.critique({
        doc: ctx.doc(),
        t,
        pngBase64: png,
        ...(intent === undefined ? {} : { intent }),
        ...(checklist.length === 0 ? {} : { checklist }),
      });
      return {
        text: json({
          t,
          verdict: result.verdict,
          findings: result.findings,
          // ★ 解析失败要【如实说】，并把评审的原话带回来 —— 否则"评审没意见"与
          //   "评审的回执我们没读懂"长得一模一样（坑表里 MathJax 那条的同一族）。
          ...(result.unparsed ? { unparsed: true, criticSaid: result.raw.slice(0, 600) } : {}),
          next:
            result.findings.length === 0
              ? '评审没有发现问题（pass）：不要再为了它改画面。'
              : '按 findings 逐条改，改完可以再 critique_frame 一次核对。',
          budget: ctx.budget.remaining(),
        }),
        images: [{ dataUrl: 'data:image/png;base64,' + png, label: 't=' + t }],
      };
    }

    case 'validate': {
      // 空数组 / 不传 → 跑全部分组。
      // ★ 这里原来是 `{ groups: undefined }`，于是传了空数组时会走到
      //   `{ groups: [] }`：聚合器把空数组当成"一个分组都不跑"，
      //   回执永远是 {total: 0, issues: []} —— 一次也不报错的假绿。
      const raw = Array.isArray(args['groups']) ? (args['groups'] as unknown[]) : [];
      const known = raw.filter((g): g is ValidatorGroup =>
        (ALL_GROUPS as readonly string[]).includes(String(g)),
      );
      const issues = validate(ctx.doc(), known.length === 0 ? {} : { groups: known });
      const objectCount = Object.keys(ctx.doc().objects).length;
      return {
        text: json({
          // ★ 主动给收尾指令。压力测试里 #10 是 issues=0 却撞满 12 轮的 ——
          //   验收线只写在系统提示词里，模型看不见"现在可以收工了"。
          next:
            issues.length !== 0 || objectCount === 0
              ? undefined
              : ctx.budget.hasRenderedFrame()
                ? 'issues 已归零且文档里有对象，画面也渲染看过了 —— 现在就调用 finish_shot 结束本轮，不要再微调。'
                : 'issues 已归零且文档里有对象，但【还没渲染过画面】—— 先用 render_frames([...]) ' +
                  '看一帧再调 finish_shot（不看会被拒）。get_render_state 只能判几何，不能替代看画面。',
          counts: summarizeIssues(issues),
          issues: issues.map((i) => ({
            severity: i.severity,
            group: i.group,
            code: i.code,
            path: i.path,
            ...(i.at === undefined ? {} : { at: i.at }),
            message: i.message,
            fixClass: i.fixClass,
            hasSuggestedFix: (i.suggestedFix?.length ?? 0) > 0,
          })),
        }),
      };
    }

    default:
      return { text: json({ error: 'unknown_tool', message: '未注册的工具: ' + name }) };
  }
}

/** get_render_state 需要一个 RenderState 生产者；这里用 engine-core 的 evaluate。 */
import { evaluate, type RenderState as RS } from '@sva/engine-core';

function evaluateProduce(doc: SceneDoc, t: number): RS {
  return evaluate(doc, t);
}

export type { BudgetState, RenderState };