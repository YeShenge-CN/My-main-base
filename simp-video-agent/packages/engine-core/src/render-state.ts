/**
 * RenderState —— evaluate(doc, t) 的产物，也是"预览=成片"的载体。
 *
 * 它必须与宿主无关：只有数字、字符串、数组，没有 DOM 对象、没有 canvas 句柄。
 * 浏览器预览和 headless 导出消费的是同一份结构（不变量 1）。
 *
 * ⚠️ 生产者 evaluate(doc, t) 属于 P0 第 7 步，目前尚未实现。
 * 本文件先把契约固定下来：P3 的 get_render_state 投影的就是它，
 * P7 的渲染反馈也投影它。等 evaluate 落地即可直接接上。
 */
import type { Mat2D } from './math/mat2d';
import type { Vec2 } from './math/vec2';
import type { CameraState, ViewportFit } from './camera';
import type { SceneDoc } from './doc/types';

/** 屏幕空间轴对齐包围盒（像素）。 */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type RenderItemKind =
  /** 折线 / 曲线 */
  | 'path'
  /** 散点 */
  | 'points'
  /** 区域填充 */
  | 'region'
  /** 屏幕空间文字（不跟随角度、字号不随相机缩放） */
  | 'text'
  /** 屏幕空间公式（矢量轮廓由工具物化进文档；同样不跟随角度） */
  | 'formula'
  /** 向量场 */
  | 'field';

/**
 * 文字项。按规范 §4：文字"跟随位置、不跟随角度"，
 * 只把锚点经 M 变换到屏幕，然后写 DOM 的 translate(-50%,-50%) scale(cameraScale)。
 * 字体大小永不放进 scale()。
 */
export interface TextPlacement {
  /** 原文（诊断与 get_render_state 用）。 */
  readonly content: string;
  /**
   * 折行之后的行。画笔【逐行画】，不再自己量文本。
   *
   * ★ 折行结果由 engine-core 的 render/text.ts 一处算出：
   *   如果让画笔各自 measureText 再决定怎么折，canvas 与 Chrome 两个后端
   *   会折出不同的行 —— 而折行是画面的一部分。
   */
  readonly lines: readonly string[];
  /** 屏幕像素坐标下的锚点 */
  readonly anchor: Vec2;
  /** 字号（像素），不受相机 scale 影响 */
  readonly fontSize: number;
  /** 行高（像素）= 字号 × TEXT_LINE_HEIGHT_RATIO。多行时用它铺开。 */
  readonly lineHeight: number;
  /** 粗体。画笔用它选 700 字重（自托管，不靠栅格化器合成）。 */
  readonly bold: boolean;
  /** 需要写进容器 CSS transform 的相机缩放 */
  readonly cameraScale: number;
  /** 文本对齐方式，影响锚点含义 */
  readonly align: 'left' | 'center' | 'right';
}

export interface RenderItem {
  readonly id: string;
  readonly kind: RenderItemKind;
  readonly layerId: string;
  /** 绘制顺序 */
  readonly order: number;
  /** 屏幕 AABB */
  readonly box: Box;
  readonly opacity: number;
  /** drawOn 这类生长效果的可见比例，1 表示完全显示 */
  readonly visibleFraction: number;
  /** 采样点数，用于"采样是否够密"的判定 */
  readonly pointCount?: number;
  readonly text?: TextPlacement;
  /**
   * 绘制几何：屏幕像素坐标下的折线（path / points 类）。
   * 只读视图（get_render_state）会忽略它；painter 直接消费它。
   */
  readonly path?: readonly Vec2[];
  /**
   * 这条折线要不要【闭合成环】（矩形 = true，曲线/线段 = false）。
   *
   * ★ 放在这里而不是"叫 rect 就闭合"：画笔只该看几何与这一格布尔值，
   *   不该回头去猜 shape 名 —— 猜名字的做法一旦多起来，
   *   "哪个 shape 走哪条绘制分支"就会散落到渲染层的各个角落。
   */
  readonly closed?: boolean;
  /**
   * 折线末端要不要画箭头。
   *
   * ★★ 为什么是布尔而不是"箭头大小"：这两个问题一度被塞进同一个字段，结果是
   *   像素测试当场抓到的错 —— `item.headSize` 只有在 head=arrow 时才设，
   *   但 size 本身是【样式字段】，画笔又会从 `style.headSize` 回退取值，
   *   于是 head=none 的那条线照样画出了箭头（两张图完全一样）。
   *   "要不要画"是几何决策（形状参数），"画多大"是样式 —— 分开之后两边各自唯一。
   */
  readonly arrow?: boolean;
  /**
   * 公式（矢量字形）的子路径，屏幕像素坐标、**已经闭合**。
   *
   * ★ 它们必须作为【一条路径】填充（nonzero 环绕规则）：字形里的洞
   *   （`o` 的中间、分数线的两侧）靠子路径的绕向表达，逐个子路径单独填充会把洞填实。
   *   几何来自工具物化的公式（见 render/formula-geometry.ts），求值层只做平移缩放。
   */
  readonly subpaths?: readonly (readonly Vec2[])[];
  /**
   * 绘制样式（动画叠加后的结果）。
   *
   * ★ 它存在的理由：动画值必须有出口。画笔原来各自去读静态 style，
   *   于是"动画驱动了 width/glow/颜色"这件事在画面上完全看不到。
   *   现在由求值层统一解析一次，画笔只消费这个字段 ——
   *   预览、headless 导出、面板四处不会再各解一遍、各解出不同结果。
   */
  readonly style?: {
    readonly stroke?: string;
    /** 世界单位的线宽，画笔乘相机 scale 后使用 */
    readonly width?: number;
    readonly glow?: number;
    /** 屏幕空间文字的字号（像素），永不进 scale() */
    readonly fontSize?: number;
    /** 内部填充色（rect 类）。与 stroke 是两件事，不能共用一格。 */
    readonly fill?: string;
    readonly fillOpacity?: number;
    /**
     * 箭头大小（世界单位）。世界单位而不是像素：箭头是几何，
     * 必须与相机缩放一致（规范 §4 的硬约束），画笔自己乘 cameraScale。
     */
    readonly headSize?: number;
  };
}

export interface RenderState {
  readonly t: number;
  readonly viewport: { readonly w: number; readonly h: number };
  readonly camera: CameraState;
  /** 世界 → 像素 的复合矩阵 */
  readonly matrix: Mat2D;
  /**
   * 这一帧用到的视口贴合（base / x0 / y0 / cx / cy）。
   *
   * ★★ 它存在的理由是【模型侧的坐标契约】：`tf.x / tf.y` 是【世界单位】，
   *   `get_render_state` 报的 box 却是【像素】—— 而模型此前拿不到从世界到像素的
   *   换算，于是只能靠试。实测（压力测试 #6/#17）：模型把 worldHeight 当成 270px、
   *   写出 `tf.y = 105` 想"把标题移到顶部"，实际落到屏幕 y = 3015，标题飞出画布，
   *   然后它花掉剩下所有轮次在 y=105 → 1 → -74 → -95 → 3.5 之间来回猜。
   *
   *   有了它，投影层可以如实报出"1 世界单位 = base 像素"与"可视世界矩形"，
   *   模型就不用猜了。也顺带让 `evaluate` 的取值在诊断里可见（此前只有 camera.scale）。
   *
   * 可选：它由 evaluate 填充；只吃 RenderState 的旧调用方不受影响。
   */
  readonly fit?: ViewportFit;
  readonly items: readonly RenderItem[];
}

/** RenderState 的生产者。P0 第 7 步的 evaluate 就是这个形状。 */
export type RenderStateProducer = (doc: SceneDoc, t: number) => RenderState;
