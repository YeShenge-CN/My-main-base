/**
 * 命令的【领域化形态】。
 *
 * 反面教材（本项目刻意不提供，且类型系统不允许）：
 *     { op: 'set_param', target: 'plot#1', path: 'style.width', value: 5 }
 *     { op: 'set_param', target: 'plot#1', path: 'params.expr',  value: 'cos(x)' }
 *
 * 为什么通用 path/value 命令是错的：
 *   1. 它让"字段是否属于这个 shape""改动要不要重采样""命中了哪把锁"
 *      全都变成运行时字符串匹配，类型系统一点忙都帮不上；
 *   2. 它把 FieldRegistry（规范 §6：字段级约束的唯一真源）架空成一张查表；
 *   3. 它让 precondition 的 readSet/writeSet 只能靠猜 —— 引擎无法从
 *      'params.expr' 这个字符串知道"改它会连带影响哪些字段"。
 *
 * 领域化之后，每条命令自己就知道自己读什么、写什么、改完后要重算到哪一步。
 * 依赖推导（规范 §7.3）和 precondition 推导（规范 §8）才有了确定的输入。
 *
 * 关于字段名的类型强度：
 *   set_style / set_transform 这类"所有对象共有"的命令，字段名是封闭的，
 *   所以在这里写成具名字段（瞎写字段名 = 编译错误）。
 *   create_* 内联的 style / motion 是"按 shape 而定"的，字段名清单要等
 *   P2 item 2 把 FieldRegistry 填全之后才能生成字面量键类型；在那之前是
 *   Record<string, …>，由 simulate 阶段用 FieldRegistry 校验，未登记的名字
 *   报 errored(field_not_in_shape)。
 */
import type { AnimTrack, CameraKey } from '../doc/types';
import type { CommandEnvelope, Editable, IdRef } from './ids';

/**
 * create 命令里【模型能给的】归属信息。
 *
 * 与 doc 里的 OwnerInfo 唯一的区别：没有 bornAt。
 * 规范两处示例正好体现了这一点 ——
 *   §5 的文档：  "owner": { "kind":"scene", "sceneId":"s1", "bornAt":0 }
 *   §7 的命令：  "owner": { "kind":"scene", "sceneId":"s1" }
 * bornAt 是【命令生效时刻】，由引擎推导。让模型声明它等于让模型自己挑时间原点，
 * 是信任边界（不变量 4）上的一个洞：模型参数只经过 schema 与 FieldRegistry 两层正向校验，
 * 边界外的推导一律归引擎。
 *
 * ★ `sceneId: null` 的含义 = 【放进我当前这一镜】。
 *
 *   多 Agent 落地时才发现这件事必须由引擎兜住：场景 Agent 不该、也不必知道
 *   自己的镜头 id —— 那是编排层给它的身份。让模型自己填 id 会引入两类错误：
 *   填错（写进别人的镜）与不填（游离对象）。现在它只写 `kind: 'scene'`，
 *   引擎用 ApplyContext.scope 把它落到当前镜上。
 *
 *   导演视角（没有 scope）下 `null` 保持原样 —— 那是"未指定归属"，
 *   对应用户/工具在单镜头文档里的既有行为。
 */
export type CreateOwner =
  | { readonly kind: 'scene'; readonly sceneId: string | null }
  | { readonly kind: 'global' }
  | {
      readonly kind: 'shared';
      readonly sharedId: string;
      readonly usageWindows: readonly (readonly [number, number])[];
    };

/* ══════════════════════════════════════════════════════════════
 * 内联载荷：create_* 专用
 * ══════════════════════════════════════════════════════════════ */

/**
 * 内联动画：轨道路径 → 轨道节点。
 *
 * ⚠️ 待确认：规范 §7 的示例写的是 "motion": {"reveal": {...}} —— 键名是 "reveal"，
 * 不是字段路径。而 §5 的文档里 anim 的键是字段路径（"tf.opacity"）。
 * 我按【字段路径】实现（与文档一致）。如果 "reveal" 是有意的具名动画通道，
 * 那它是另一个概念，需要单独定义。
 */
export type InlineMotion = Readonly<Record<string, AnimTrack>>;

/**
 * 内联效果定义。
 *
 * 规范 §7：「create_* 系列必须支持内联 style / motion / effect。
 * 这不是便利性优化，是消除假依赖的必要手段。」
 * 用一条命令完成"建对象 + 加效果"，依赖图里就不会出现
 * "加效果依赖建对象"这种本来不存在的边。
 */
export interface InlineEffect {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly ease?: string | null;
}

/** create_* 共有的部分。 */
interface CreateBase extends CommandEnvelope {
  /** 批次内符号 id，形如 '$c1'。 */
  readonly localId: string;
  /** 归属。决定写权限与 retime 行为（规范 §11）。bornAt 不在这里，由引擎推导。 */
  readonly owner: CreateOwner;
  /** 落在哪个图层。省略时用文档的第一个图层。 */
  readonly layer?: Editable<string>;
  /** 内联样式：键必须是该 shape 已登记的 style 字段名。 */
  readonly style?: Readonly<Record<string, unknown>> | null;
  /** 内联动画。 */
  readonly motion?: InlineMotion | null;
  /** 内联效果。 */
  readonly effect?: InlineEffect | null;
}

/* ══════════════════════════════════════════════════════════════
 * create_* 系列
 * ══════════════════════════════════════════════════════════════ */

/**
 * 建一条 2D 曲线。
 *
 * 注意 expr / domain / samples 是【顶层具名字段】，不是 params 包：
 * 这样"改表达式"就是一条 set_expression 命令，而不是一次字符串拼接。
 *
 * ⚠️ 其余 shape（paramCurve / contour / region / scatter / vectorField / text / formula）
 * 的 create 命令形状与此完全同构，只是各自的几何字段不同。它们的字段清单来自
 * FieldRegistry —— P2 item 2 落地后按同一模板补齐，不需要在这里预判。
 */
export interface CreatePlotCommand extends CreateBase {
  readonly op: 'create_plot';
  readonly expr: string;
  readonly domain: readonly [number, number];
  readonly samples?: Editable<number>;
}

/**
 * 建一个对象（通用形态）。
 *
 * ★ 与 create_plot 的关系：create_plot 是它的一种"几何字段已经具名化"的特例
 *   （expr / domain / samples 在顶层）。这里的 params 是【按 shape 而定】的键值，
 *   所以字段名的合法性必须由引擎按 FieldRegistry 判定 —— 未登记的键报 errored，
 *   绝不允许"模型/界面写什么就存什么"。
 *
 * 为什么需要它：create_plot 是此前唯一能建对象的命令，于是"一条文本标题"这种
 * 完全正当的需求在文档里根本无法从零产生（只能靠夹具预置）。
 */
export interface CreateObjectCommand extends CreateBase {
  readonly op: 'create_object';
  readonly shape: string;
  /** 几何类字段（键必须在该 shape 的 params 分组里登记过）。 */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * 建一个矩形（P1 形状系统）。
 *
 * ★ 为什么给它一个【具名 op】而不是让模型走 `create_object`：
 *   结构图的基本单元就是"一个方框"，它值得和 `create_plot` 同等的地位 ——
 *   字段在类型层面封闭（width/height/radius），写错名字是编译错误而不是运行期拒收。
 *   这与 commands.ts 开头那段"领域化命令优于通用 path/value"的理由是同一条。
 */
export interface CreateRectCommand extends CreateBase {
  readonly op: 'create_rect';
  readonly width?: Editable<number>;
  readonly height?: Editable<number>;
  readonly radius?: Editable<number>;
}

/**
 * 建一条线段（可带箭头）。
 *
 * `head` 是 `none | arrow`（枚举来自 registry，写错会被 schema 挡住）。
 * 端点用相对本对象原点的世界坐标，于是 `tf.x/tf.y` 能整体搬运一组连线。
 */
export interface CreateLineCommand extends CreateBase {
  readonly op: 'create_line';
  readonly from?: Editable<readonly [number, number]>;
  readonly to?: Editable<readonly [number, number]>;
  readonly head?: Editable<string>;
}

/* ══════════════════════════════════════════════════════════════
 * 编辑类命令：按领域分组
 * ══════════════════════════════════════════════════════════════ */

/**
 * 改绘制样式。只重绘，不重采样（规范 §5 的 draw 类）。
 *
 * 这就是"领域化"的样子：字段名是画一条曲线时会说出口的词，
 * 不是 'style.width' 这种给机器看的路径。
 */
export interface SetStyleCommand extends CommandEnvelope {
  readonly op: 'set_style';
  readonly target: IdRef;
  readonly width?: Editable<number>;
  readonly glow?: Editable<number>;
  readonly stroke?: Editable<string>;
  /**
   * 下面四个是第十七轮补的：它们在 registry 里早就登记了、面板也早就画出了控件，
   * 但【没有任何命令能改】—— 拖动时面板只能回 null（"这个控件改不动"）。
   * 形状之间共用这一条 op：它们都是绘制类字段，且字段名不冲突
   * （fill / fillOpacity 属于 rect，headSize 属于 line，size 属于 text）。
   */
  readonly fill?: Editable<string>;
  readonly fillOpacity?: Editable<number>;
  readonly headSize?: Editable<number>;
  /** text 的字号（像素）。与 plot2d 的 width（世界单位线宽）不是一回事。 */
  readonly size?: Editable<number>;
  /** 文字对齐（'left' | 'center' | 'right'）。 */
  readonly align?: Editable<string>;
  /** 文字换行宽度（像素，0 = 不换行）。 */
  readonly maxWidth?: Editable<number>;
  /** 文字粗体（自托管的 700 字重）。 */
  readonly bold?: Editable<boolean>;
}

/**
 * 改几何表达式。会触发重采样（geometry 类）。
 * 单独成一条命令而不是塞进 set_style，是因为它的变更等级不同：
 * 引擎读到这里就知道"采样缓存要失效"。
 */
export interface SetExpressionCommand extends CommandEnvelope {
  readonly op: 'set_expression';
  readonly target: IdRef;
  readonly expr: string;
}

/**
 * 改采样参数。geometry 类 —— 会触发重采样。
 * P7 的 "采样过低" 自动修用这条命令落下去。
 */
export interface SetSamplingCommand extends CommandEnvelope {
  readonly op: 'set_sampling';
  readonly target: IdRef;
  readonly samples?: Editable<number>;
  readonly domain?: Editable<readonly [number, number]>;
}

/**
 * 把对象挂进 / 摘出图层。
 * P7 的引用完整性自动修需要它 —— 悬空引用与"对象不在任何图层"都只能靠这两条命令修，
 * 不能靠直接改数组（那会开出第二条写路径）。
 */
export interface LinkObjectCommand extends CommandEnvelope {
  readonly op: 'link_object';
  readonly layerId: string;
  readonly objectId: IdRef;
}

export interface UnlinkObjectCommand extends CommandEnvelope {
  readonly op: 'unlink_object';
  readonly layerId: string;
  readonly objectId: IdRef;
}

/** 改音频轨的起始时刻与增益。 */
export interface SetAudioCommand extends CommandEnvelope {
  readonly op: 'set_audio';
  readonly target: IdRef;
  readonly startAt?: Editable<number>;
  readonly gain?: Editable<number>;
}

/** 从某个标记点起整体顺延（P11 第 3 条 / P12 第 5 条）。一条命令、原子、产出一个 CompoundOperation。 */
export interface RetimeCommand extends CommandEnvelope {
  readonly op: 'retime';
  readonly fromMarker: string;
  readonly delta: number;
  /**
   * 场景 Agent 发起时【必须】带上自己的 sceneId。
   * 引擎据此只顺延它有权写的对象：global 不动、shared 只挪窗口、别镜不动。
   */
  readonly activeSceneId?: Editable<string>;
}

/** 改归属。只有导演/UI 能调，且需要人工确认（P12 第 3 条）。 */
export interface PromoteObjectCommand extends CommandEnvelope {
  readonly op: 'promote_object';
  readonly target: IdRef;
  readonly to:
    | { readonly kind: 'global' }
    | { readonly kind: 'scene'; readonly sceneId: string }
    | {
        readonly kind: 'shared';
        readonly sharedId: string;
        readonly usageWindows: readonly (readonly [number, number])[];
      };
}

/** 给 shared 对象追加一个使用窗口。场景 Agent 可调，但改不了本体（P12 第 4 条）。 */
export interface LinkSharedCommand extends CommandEnvelope {
  readonly op: 'link_shared';
  readonly sharedId: IdRef;
  readonly sceneId: string;
  /** 要追加的使用窗口。刻意不叫 window —— 那是 DOM 全局的名字，会永远绊住宿主无关检查。 */
  readonly usageWindow: readonly [number, number];
}

/** 改对象变换。draw 类。 */
export interface SetTransformCommand extends CommandEnvelope {
  readonly op: 'set_transform';
  readonly target: IdRef;
  readonly x?: Editable<number>;
  readonly y?: Editable<number>;
  readonly rotate?: Editable<number>;
  readonly sx?: Editable<number>;
  readonly sy?: Editable<number>;
  readonly opacity?: Editable<number>;
}

/**
 * 改父级（分组）。传 `parent: null` 表示脱离分组。
 *
 * ★ 它是"整体移动一组东西"的唯一入口：父级一动，子级跟着动。
 *   自引用与成环由校验器报 `parent_cycle`；求值路径另有深度截断兜底。
 */
export interface SetParentCommand extends CommandEnvelope {
  readonly op: 'set_parent';
  readonly target: IdRef;
  /** 父对象 id；null = 变成顶层对象。 */
  readonly parent: Editable<string> | null;
}

/**
 * 改效果参数。
 *
 * ⚠️ 这里的字段是【drawOn 的字段】。等效果类型变多，有两条路：
 *   (a) 每种效果一条 op（set_drawOn / set_fade / …）；
 *   (b) 保持 set_effect 但字段集随类型扩张。
 * 我倾向 (a)（与 create_* 一脉相承：类型层面挡住瞎写字段名），但这会让 op 数量膨胀。
 * 请你定。
 */
export interface SetEffectCommand extends CommandEnvelope {
  readonly op: 'set_effect';
  readonly target: IdRef;
  readonly start?: Editable<number>;
  readonly duration?: Editable<number>;
  readonly mode?: Editable<string>;
  readonly tip?: Editable<boolean>;
  readonly ease?: Editable<string>;
}

/**
 * 改高亮效果的参数。
 *
 * ★ 为什么单独一条 op 而不是把字段并进 `set_effect`：`set_effect` 的字段集是
 *   drawOn 的（mode / tip），而 highlight 的是 color / intensity —— 两者只在
 *   start / duration 上重合。并在一起会让"给高亮设置 mode"变成一条合法但无意义的命令。
 *   这正是 `SetEffectCommand` 上面那段注释里说的 (a) 方案：每种效果一条 op。
 */
export interface SetHighlightCommand extends CommandEnvelope {
  readonly op: 'set_highlight';
  readonly target: IdRef;
  readonly start?: Editable<number>;
  readonly duration?: Editable<number>;
  readonly color?: Editable<string>;
  readonly intensity?: Editable<number>;
  readonly ease?: Editable<string>;
}

/**
 * 改"沿路径移动"效果的参数。
 *
 * ★ 与 set_highlight 同一条理由：字段集是 moveAlong 自己的
 *   （source / start / duration），并进 set_effect 只会让"给 drawOn 设置 source"
 *   变成一条合法但无意义的命令。每种效果一条 op —— 类型层挡住瞎写字段名。
 */
export interface SetMoveAlongCommand extends CommandEnvelope {
  readonly op: 'set_move_along';
  readonly target: IdRef;
  /** 路径来源：一个 line 对象的 id。 */
  readonly source?: Editable<string>;
  readonly start?: Editable<number>;
  readonly duration?: Editable<number>;
  readonly ease?: Editable<string>;
}

/**
 * 改"显隐"效果的参数（appear / disappear）。
 *
 * ★ 两种效果共用一条 op：它们的字段集【完全一样】（只有一个 `at`），
 *   这就是 `SetEffectCommand` 注释里说的"字段集相同就共用"的那一支。
 *   与 set_effect 的区别在于它会【检查效果类型】—— 对一条 highlight 发
 *   set_visibility 会被当场拒掉，而不是把 at 写进一个没有 at 的效果里。
 */
export interface SetVisibilityCommand extends CommandEnvelope {
  readonly op: 'set_visibility';
  readonly target: IdRef;
  /** 出现 / 消失的时刻（秒，相对镜头起点）。 */
  readonly at?: Editable<number>;
}

/* ── 形状几何参数（P1 的欠账：面板一直画着控件，但改不动）────────
 *
 * ★ 为什么每种形状一条 op，而不是一条通用的 set_params：
 *   与 SetEffectCommand 那条注释同一个理由 —— 字段集是形状自己的
 *   （rect 的宽高、line 的两个端点、text 的内容），并成一条会让
 *   "给一条曲线设置 from/to" 变成一条【形状上合法、语义上无意义】的命令。
 *   引擎在这里做类型检查：对 rect 发 set_line 会被当场拒。
 *
 * ★ 它们是【geometry 类】：改完要重算几何（与 set_expression 同级），
 *   而 set_style 补的那四个是 draw 类（只重绘）。这个分界在规范 §5，
 *   registry 的 section 已经把它表达出来了（params vs style）。
 */

/** 改矩形的几何。 */
export interface SetRectCommand extends CommandEnvelope {
  readonly op: 'set_rect';
  readonly target: IdRef;
  readonly width?: Editable<number>;
  readonly height?: Editable<number>;
  readonly radius?: Editable<number>;
}

/**
 * 改线段的几何。
 *
 * ★ 端点用【相对本对象原点】的坐标（与 create_line 同一套），
 *   所以整条线仍然可以被 tf.x / tf.y 搬动、被 tf.rotate 旋转。
 */
export interface SetLineCommand extends CommandEnvelope {
  readonly op: 'set_line';
  readonly target: IdRef;
  readonly from?: Editable<readonly [number, number]>;
  readonly to?: Editable<readonly [number, number]>;
  /** 'none' 或 'arrow'（registry 里的枚举，写别的值由字段校验兜住）。 */
  readonly head?: Editable<string>;
}

/** 改文字内容。 */
export interface SetTextCommand extends CommandEnvelope {
  readonly op: 'set_text';
  readonly target: IdRef;
  readonly content?: Editable<string>;
}

/** 改动画轨道。node 传 null 表示删掉这条轨道。 */
export interface SetMotionCommand extends CommandEnvelope {
  readonly op: 'set_motion';
  readonly target: IdRef;
  /** 轨道路径（对象相对），如 'style.width'、'tf.opacity'。 */
  readonly field: string;
  readonly node: AnimTrack | null;
}

/* ══════════════════════════════════════════════════════════════
 * 镜头元数据
 * ══════════════════════════════════════════════════════════════ */

/**
 * 改镜头元数据。
 *
 * ★ 刻意【不】包含 worldWidth / worldHeight，这不是遗漏而是硬约束：
 *   它们是"世界 → 像素"的基准（base = min(viewport/world)）。改一次，
 *   所有已有对象的屏幕位置、大小、描边宽度全部跟着变 ——
 *   那是一次【重新取景】，不是一次编辑。这类参数只应该在新建镜头时定，
 *   事后要改就等于把整镜重做。
 *
 * 允许改的三项与既有校验器天然衔接：
 *   duration  改短了会触发 drawon_overruns_shot / audio_starts_beyond_shot
 *   fps       只影响导出与采样密度，不动画面内容
 *   viewport  改画布像素尺寸，不改世界坐标
 */
export interface SetMetaCommand extends CommandEnvelope {
  readonly op: 'set_meta';
  readonly fps?: Editable<number>;
  readonly duration?: Editable<number>;
  readonly viewport?: Editable<readonly [number, number]>;
}

/* ══════════════════════════════════════════════════════════════
 * 相机
 * ══════════════════════════════════════════════════════════════ */
/** 整体替换相机关键帧。 */
export interface SetCameraCommand extends CommandEnvelope {
  readonly op: 'set_camera';
  readonly keys: readonly CameraKey[];
}

/**
 * 相机预设。
 *
 * ★ 语义（我定的，实现与界面都依赖它，所以写在这里）：
 *   预设【替换】整条相机轨，而不是追加。
 *   理由：追加语义下，点两次"推近"会得到两段推近（第一段还没结束第二段就接上），
 *   而用户看到的是一个按钮，期待的是"让镜头推近"这一个状态。
 *   要精细控制请用 set_camera 直接给关键帧。
 *
 *   pushIn   把主体放到视口中心，并推近（终点 scale = 1 + 强度×1.5）
 *   pullOut  反过来：从近处拉开（起点 scale = 1 + 强度×1.5，终点 1）
 *   reset    复位成静止的恒等镜头（一个关键帧）
 */
export type CameraPresetName = 'pushIn' | 'pullOut' | 'reset';

export interface CameraPresetCommand extends CommandEnvelope {
  readonly op: 'camera_preset';
  readonly preset: CameraPresetName;
  /**
   * 主体。可以是对象 / 符号 id，也可以直接是世界坐标点。
   * 规范示例用的是 "$c1"；支持点是为了"镜头对准某个空区域"这种构图需求。
   * preset=reset 时忽略。
   */
  readonly subject?: Editable<IdRef | readonly [number, number]>;
  /** 时长（秒）。preset=reset 时忽略。 */
  readonly duration?: number;
  /** 强度，0..1。省略时用预设自己的默认值。 */
  readonly intensity?: Editable<number>;
}

/* ══════════════════════════════════════════════════════════════
 * 结构性命令
 * ══════════════════════════════════════════════════════════════
 * ⚠️ 下面三条不在你给的清单里。但没有它们闭环不成立：
 *   - create_* 只能在"新建对象"时内联效果；给一个【已存在】的对象加效果没有别的路。
 *   - 没有删除，撤销永远只能靠 undo，而 doc 会只增不减。
 * 我先按最小形态定义，请你确认是否保留。
 */

/** 给已存在的对象加一个效果。 */
export interface AddEffectCommand extends CommandEnvelope {
  readonly op: 'add_effect';
  /** 目标对象。 */
  readonly target: IdRef;
  readonly effect: InlineEffect;
  /** 新效果的符号 id，便于本批次后续命令引用。 */
  readonly localId?: Editable<string>;
}

export interface DeleteObjectCommand extends CommandEnvelope {
  readonly op: 'delete_object';
  readonly target: IdRef;
}

export interface DeleteEffectCommand extends CommandEnvelope {
  readonly op: 'delete_effect';
  readonly target: IdRef;
}

/* ══════════════════════════════════════════════════════════════
 * 镜头表（P12）
 * ══════════════════════════════════════════════════════════════
 * 三条命令的边界刻意画得很窄，理由见各自注释。总原则是：
 *   结构（有几镜、各从哪开始）归这三条；内容（镜里的东西怎么动）归 retime。
 */

/**
 * 加一个镜头。
 *
 * 位置只有两种给法，且必须给一种：
 *   bornAt  直接用这个起点（秒）
 *   at      "接在哪个镜头后面"：`at:'s1'` = s1 结束的那一刻，也就是接续。
 *           ★ 这是它存在的全部理由 —— 让"再加一镜"不需要读时间轴就知道往哪放。
 *
 * 不默认追加到片尾："再加一镜"的意图不等于"接在最后"，猜错了会把镜头放到
 * 一个谁也想不到的位置。省略二者直接报 invalid_argument。
 */
export interface AddSceneCommand extends CommandEnvelope {
  readonly op: 'add_scene';
  readonly name?: Editable<string>;
  readonly bornAt?: Editable<number>;
  readonly at?: Editable<string>;
  /** 本批次内引用这个新镜头用的符号 id。 */
  readonly localId?: Editable<string>;
  /**
   * 指定 id，省略时由引擎分配（`s#N`）。
   *
   * ★ 【引擎专用】—— 工具的 strict schema 里没有这个字段，模型传不进来。
   *   它是为了 remove_scene 的逆操作：撤销"删掉 s2"必须把镜头按【原 id】
   *   装回去，否则对象上的 owner.sceneId 会全部悬空。
   *   与 delete_object 不可逆（invert.ts 里如实报告）相比，这条让镜头的增删
   *   变成了真正可撤销的操作 —— 代价就是这一个后门字段。
   */
  readonly id?: Editable<string>;
}

/**
 * 改一个镜头。只改镜头表自己的东西。
 *
 * ⚠️ 改 bornAt 只挪【镜头边界】，镜内对象**不跟着走** —— 要整镜搬内容请用 retime。
 *    这不是偷懒：内容迁移涉及 anim keys / effects / markers / camera keys 的
 *    连锁顺延，是 retime 的完整语义，在这里做一半等于制造两个"移动镜头"的实现。
 *    所以改名与挪边界分开对待，挪边界只是结构操作。
 */
export interface SetSceneCommand extends CommandEnvelope {
  readonly op: 'set_scene';
  readonly target: IdRef;
  readonly name?: Editable<string>;
  readonly bornAt?: Editable<number>;
}

/**
 * 删一个镜头。**最后一条不许删**（先把内容并走，见下面）。
 *
 * 镜内对象不会变成孤儿：它们被**改归属**到相邻镜头（前一个，没有前一个就用后一个），
 * 并同步把 owner.bornAt 写成新镜头的 bornAt（bornAt 的真源是镜头表，落盘的那份
 * 只是一致性缓存）。删镜头顺手弄丢它的内容是不可接受的 —— 那等于一次静默丢数据。
 *
 * ⚠️ 它**不动 meta.duration**：删镜头不自动缩短片长（见 reconcileDuration 的单向规则），
 *    片尾留白由人来收，或者由 retime 来收。顺延后续镜头同样【不做】——
 *    "删了镜头后面的内容要不要往前挪"是时间轴决策，属于 retime。
 */
export interface RemoveSceneCommand extends CommandEnvelope {
  readonly op: 'remove_scene';
  readonly target: IdRef;
}

/* ══════════════════════════════════════════════════════════════
 * 联合
 * ══════════════════════════════════════════════════════════════ */

export type Command =
  | CreatePlotCommand
  | CreateObjectCommand
  | CreateRectCommand
  | CreateLineCommand
  | SetMetaCommand
  | SetStyleCommand
  | SetRectCommand
  | SetLineCommand
  | SetTextCommand
  | SetExpressionCommand
  | SetSamplingCommand
  | SetTransformCommand
  | SetParentCommand
  | LinkObjectCommand
  | UnlinkObjectCommand
  | SetAudioCommand
  | RetimeCommand
  | PromoteObjectCommand
  | LinkSharedCommand
  | SetEffectCommand
  | SetHighlightCommand
  | SetMoveAlongCommand
  | SetVisibilityCommand
  | SetMotionCommand
  | SetCameraCommand
  | CameraPresetCommand
  | AddEffectCommand
  | DeleteObjectCommand
  | DeleteEffectCommand
  | AddSceneCommand
  | SetSceneCommand
  | RemoveSceneCommand;

export type CommandOp = Command['op'];

/** 一条命令执行后引擎推导出来的读写集，是 precondition 与依赖推导的唯一输入。 */
export interface CommandEffects {
  /** 会被写入的点分路径（对象相对形式，如 'plot#1.style.width'、'eff#3.duration'）。 */
  readonly writes: readonly string[];
  /** 会被读取的点分路径。precondition 只取它与"同一 object 子树"的交集（规范 §8）。 */
  readonly reads: readonly string[];
  /** 该命令产生的新 id。依赖推导靠它精确到"localId 的产生者"。 */
  readonly creates: readonly CreatedId[];
}

export interface CreatedId {
  readonly localId: string;
  readonly assignedId: string;
  /** 新实体在文档里的根路径，如 'objects.plot#7'。 */
  readonly rootPath: string;
}
