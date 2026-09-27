/**
 * FieldRegistry 的【唯一一份数据】（规范 §6）。
 *
 * 三份产物都从它生成：strict tool JSON Schema、UI 控件元数据、字段级校验规则。
 * 这三处任何一处手写 min/max 都算缺陷 —— 所以这里出现的每个数字，就是全局的唯一真相。
 *
 * 登记范围（P9 需要的最小完整集 + P1 形状系统的第一批）：
 *   scene.meta / theme / object.tf / object.parent
 *   shape.plot2d.{params,style} / shape.text.{params,style}
 *   shape.rect.{params,style} / shape.line.{params,style}
 *   effect.drawOn.params / effect.highlight.params / effect.moveAlong.params
 *   camera.key / motion.key
 * 还有其余 shape（paramCurve / contour / region / scatter / vectorField / formula）
 * 没登记，等它们的采样器落地再补（登记了就必然要在校验器里兑现）。
 */
import type { FieldGroup, FieldRegistry } from './types';
import { EASE_NAMES } from '../anim/ease';

const SEC = { geometry: 'params', draw: 'style' } as const;

const plotParams: FieldGroup = {
  id: 'shape.plot2d.params',
  kind: 'shape',
  owner: 'plot2d',
  section: 'params',
  label: '曲线几何',
  pathTemplate: 'objects.*.params',
  fields: {
    expr: {
      type: 'expr',
      label: '函数表达式',
      description: '以 x 为自变量的表达式，例如 sin(x)。白名单函数与常量由编译器强制。',
      default: 'sin(x)',
      variables: ['x'],
    },
    domain: {
      type: 'range',
      label: '定义域',
      description: '曲线的 x 取值范围，世界单位。',
      default: [-7, 7],
      item: { kind: 'bounded', min: -1000, max: 1000, unit: 'world', step: 0.5 },
    },
    samples: {
      type: 'integer',
      label: '采样数',
      description: '全定义域上的采样点数。绘制动画不会重新采样，所以它只影响曲线的圆滑度。',
      default: 2400,
      bounds: { kind: 'bounded', min: 16, max: 20000, step: 1, unit: 'count' },
    },
  },
};

const plotStyle: FieldGroup = {
  id: 'shape.plot2d.style',
  kind: 'shape',
  owner: 'plot2d',
  section: 'style',
  label: '曲线样式',
  pathTemplate: 'objects.*.style',
  fields: {
    stroke: { type: 'color', label: '线条颜色', default: '#4ea1ff' },
    width: {
      type: 'number',
      label: '线宽',
      description: '世界单位。绘制时会乘以相机 scale。',
      default: 3,
      bounds: { kind: 'bounded', min: 0.5, max: 10, step: 0.5, unit: 'world' },
      animatable: true,
    },
    glow: {
      type: 'number',
      label: '发光强度',
      default: 0.6,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' },
      animatable: true,
    },
  },
};

const textParams: FieldGroup = {
  id: 'shape.text.params',
  kind: 'shape',
  owner: 'text',
  section: 'params',
  label: '文本内容',
  pathTemplate: 'objects.*.params',
  fields: {
    content: {
      type: 'string',
      label: '文字',
      description: '屏幕空间渲染：只跟随位置，不跟随相机角度，字号也不随相机缩放。',
      default: '',
      validation: { maxChars: 200 },
    },
  },
};

/**
 * 公式（方案 B：几何由 Agent 的工具物化进文档）。
 *
 * ★ 这些字段【全是 engineOnly】：写它们的是工具（LaTeX → 矢量轮廓），
 *   不是人也不是模型直接改。面板不渲染它们（改了会让 source 与几何两处真源打架）。
 * ★ 几何存的是 **em 单位**（与字号无关）：于是改字号 / 让字号动起来都不用重算几何。
 */
const formulaParams: FieldGroup = {
  id: 'shape.formula.params',
  kind: 'shape',
  owner: 'formula',
  section: 'params',
  label: '公式几何',
  pathTemplate: 'objects.*.params',
  fields: {
    source: {
      type: 'string',
      label: 'LaTeX 源码',
      description: '写下来的那一串（留档与诊断用）。改它不会重算几何 —— 重画请用工具重新生成。',
      default: '',
      engineOnly: true,
    },
    paths: {
      type: 'string',
      label: '矢量轮廓',
      description: '工具物化出来的点列（em 单位，y 向下，原点在基线与左边缘）。求值层只做平移缩放。',
      default: '',
      engineOnly: true,
    },
    width: { type: 'number', label: '宽度(em)', default: 0, bounds: { kind: 'unbounded' }, engineOnly: true },
    ascent: { type: 'number', label: '基线以上(em)', default: 0, bounds: { kind: 'unbounded' }, engineOnly: true },
    depth: { type: 'number', label: '基线以下(em)', default: 0, bounds: { kind: 'unbounded' }, engineOnly: true },
  },
};

const formulaStyle: FieldGroup = {
  id: 'shape.formula.style',
  kind: 'shape',
  owner: 'formula',
  section: 'style',
  label: '公式样式',
  pathTemplate: 'objects.*.style',
  fields: {
    size: {
      type: 'number',
      label: '字号',
      description: '像素。与文字同口径：永不随相机缩放（规范 §4），几何按它等比缩放。',
      default: 24,
      bounds: { kind: 'bounded', min: 6, max: 400, step: 1, unit: 'px' },
      animatable: true,
    },
    fill: { type: 'color', label: '颜色', default: '#e8eef8' },
    align: {
      type: 'enum',
      label: '对齐',
      description: '与文字同口径：左对齐时锚点在公式左边缘。',
      default: 'center',
      values: ['left', 'center', 'right'],
      optionLabels: { left: '左对齐', center: '居中', right: '右对齐' },
    },
  },
};

const textStyle: FieldGroup = {
  id: 'shape.text.style',
  kind: 'shape',
  owner: 'text',
  section: 'style',
  label: '文字样式',
  pathTemplate: 'objects.*.style',
  fields: {
    size: {
      type: 'number',
      label: '字号',
      description: '像素。永不随相机缩放 —— 放进 scale() 会让预览与导出不一致。',
      default: 20,
      bounds: { kind: 'bounded', min: 6, max: 200, step: 1, unit: 'px' },
      animatable: true,
    },
    fill: { type: 'color', label: '文字颜色', default: '#e8eef8' },
    /**
     * 对齐与换行宽度：这两条把"一行标题"变成"能排版的一段话"。
     *
     * ★ 它们都在【屏幕空间】（与 size 一样不进相机 scale，规范 §4）。
     * ★ 折行由 engine-core 的 render/text.ts 一处算完：折行是画面的一部分，
     *   两个渲染后端各量一次文本就会折出不同的行。
     */
    align: {
      type: 'enum',
      label: '对齐',
      description: '相对锚点：左对齐时锚点在文字左边（适合标注/列表），居中适合标题。',
      default: 'center',
      values: ['left', 'center', 'right'],
      optionLabels: { left: '左对齐', center: '居中', right: '右对齐' },
    },
    bold: {
      type: 'boolean',
      label: '粗体',
      description: '自托管的中文 700 字重（不是浏览器合成的假粗体）—— 标题与强调用。',
      default: false,
    },
    maxWidth: {
      type: 'number',
      label: '换行宽度',
      description: '超过这个宽度就自动换行（像素）。0 = 不换行。显式的换行符永远生效。',
      default: 0,
      bounds: { kind: 'bounded', min: 0, max: 4096, step: 1, unit: 'px' },
      animatable: true,
    },
  },
};

/* ── P1 形状系统：结构图的两个基元（矩形 + 线段/箭头）────────────
 *
 * ★ 为什么是这两个先做：在这之前引擎只能画函数曲线与文字，
 *   于是"CPU 是一个方块、内存是另一个方块、总线连起来"这件事【根本表达不了】。
 *   规范 P0 第 5 步一直列着"其余 shape 需要各自的采样器"，
 *   这一组就是那笔欠账的第一部分。
 *
 * ★ 几何参数与样式分开（规范 §5 的硬分界）：
 *   params（width / height / …）改动 → geometry 类 → 触发重采样；
 *   style（stroke / fill / …）改动 → draw 类 → 只重绘。
 *   矩形没有 samples —— 它是【精确几何】，不需要采样密度这个旋钮。
 */

const rectParams: FieldGroup = {
  id: 'shape.rect.params',
  kind: 'shape',
  owner: 'rect',
  section: 'params',
  label: '矩形几何',
  pathTemplate: 'objects.*.params',
  fields: {
    width: {
      type: 'number',
      label: '宽',
      description: '世界单位。16×9 的世界里一个"方块"通常 3~4 宽。',
      default: 3,
      bounds: { kind: 'bounded', min: 0.05, max: 200, step: 0.05, unit: 'world' },
      animatable: false,
    },
    height: {
      type: 'number',
      label: '高',
      description: '世界单位。可视范围只有 ±4.5 高。',
      default: 1.6,
      bounds: { kind: 'bounded', min: 0.05, max: 200, step: 0.05, unit: 'world' },
      animatable: false,
    },
    radius: {
      type: 'number',
      label: '圆角半径',
      description: '世界单位。0 = 直角；超过半边长会自动夹住。',
      default: 0.15,
      bounds: { kind: 'bounded', min: 0, max: 10, step: 0.05, unit: 'world' },
      animatable: false,
    },
  },
};

const rectStyle: FieldGroup = {
  id: 'shape.rect.style',
  kind: 'shape',
  owner: 'rect',
  section: 'style',
  label: '矩形样式',
  pathTemplate: 'objects.*.style',
  fields: {
    stroke: { type: 'color', label: '描边颜色', default: '#4ea1ff' },
    width: {
      type: 'number',
      label: '线宽',
      description: '像素（不是世界单位），绘制时再乘相机 scale —— 与曲线同口径。',
      default: 2,
      bounds: { kind: 'bounded', min: 0, max: 200, step: 0.5, unit: 'px' },
      animatable: true,
    },
    fill: {
      type: 'color',
      label: '填充颜色',
      description: '方块底色。要"实心"就设它；纯框图可设成背景色。',
      default: '#16223a',
      animatable: false,
    },
    fillOpacity: {
      type: 'number',
      label: '填充不透明度',
      description: '只影响填充，不影响描边 —— "半透明底 + 实心边"因此能直接做出来。',
      default: 1,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' },
      animatable: true,
    },
    glow: {
      type: 'number',
      label: '发光强度',
      default: 0.35,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' },
      animatable: true,
    },
  },
};

/**
 * 线段的端点。
 *
 * ★ 端点用 `at`（相对本对象原点）而不是绝对坐标：这样它就能被
 *   `tf.x / tf.y` 整体搬动、被 `tf.rotate` 旋转 —— 与其它对象同一套变换语义。
 *   绝对端点会让"把这组连线整体挪一下"变成改两个字段 × N 条线。
 */
const lineParams: FieldGroup = {
  id: 'shape.line.params',
  kind: 'shape',
  owner: 'line',
  section: 'params',
  label: '线段几何',
  pathTemplate: 'objects.*.params',
  fields: {
    from: {
      type: 'vec2',
      label: '起点',
      description: '相对本对象原点的世界坐标。',
      default: [-2, 0],
      item: { kind: 'bounded', min: -1000, max: 1000, step: 0.05, unit: 'world' },
      animatable: false,
    },
    to: {
      type: 'vec2',
      label: '终点',
      description: '相对本对象原点的世界坐标。箭头画在这一端。',
      default: [2, 0],
      item: { kind: 'bounded', min: -1000, max: 1000, step: 0.05, unit: 'world' },
      animatable: false,
    },
    head: {
      type: 'enum',
      label: '端点样式',
      description: 'none = 一条线；arrow = 在终点画箭头（表示数据流向）。',
      default: 'arrow',
      values: ['none', 'arrow'],
      optionLabels: { none: '无线头', arrow: '箭头' },
    },
  },
};

const lineStyle: FieldGroup = {
  id: 'shape.line.style',
  kind: 'shape',
  owner: 'line',
  section: 'style',
  label: '线段样式',
  pathTemplate: 'objects.*.style',
  fields: {
    stroke: { type: 'color', label: '线条颜色', default: '#7fb2ff' },
    width: {
      type: 'number',
      label: '线宽',
      description: '像素，绘制时再乘相机 scale。',
      default: 2,
      bounds: { kind: 'bounded', min: 0, max: 200, step: 0.5, unit: 'px' },
      animatable: true,
    },
    headSize: {
      type: 'number',
      label: '箭头大小',
      description: '像素。它是几何而非线宽，所以不随线宽变化。12~20 是常见量级。',
      default: 16,
      bounds: { kind: 'bounded', min: 0, max: 400, step: 1, unit: 'px' },
      animatable: false,
    },
    glow: {
      type: 'number',
      label: '发光强度',
      default: 0.4,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' },
      animatable: true,
    },
  },
};

const objectTf: FieldGroup = {
  id: 'object.tf',
  kind: 'object',
  section: 'tf',
  label: '变换',
  pathTemplate: 'objects.*.tf',
  fields: {
    x: { type: 'number', label: '水平位置', default: 0, bounds: { kind: 'unbounded', unit: 'world' }, animatable: true },
    y: { type: 'number', label: '垂直位置', default: 0, bounds: { kind: 'unbounded', unit: 'world' }, animatable: true },
    rotate: {
      type: 'number',
      label: '旋转',
      default: 0,
      bounds: { kind: 'bounded', min: -6.2832, max: 6.2832, step: 0.0175, unit: 'rad' },
      animatable: true,
    },
    sx: { type: 'number', label: '横向缩放', default: 1, bounds: { kind: 'bounded', min: 0.01, max: 20, step: 0.01, unit: 'ratio' }, animatable: true },
    sy: { type: 'number', label: '纵向缩放', default: 1, bounds: { kind: 'bounded', min: 0.01, max: 20, step: 0.01, unit: 'ratio' }, animatable: true },
    opacity: {
      type: 'number',
      label: '不透明度',
      default: 1,
      bounds: { kind: 'bounded', min: 0, max: 1, step: 0.01, unit: 'ratio' },
      animatable: true,
    },
  },
};

/**
 * 分组（父子关系）。
 *
 * ★ 单独一个分组而不是塞进 `object.tf`：它【不是】变换字段，而是"继承谁的变换"。
 *   混进 tf 会让面板把它当数值控件渲染，而它要的是一串对象 id 的下拉。
 */
const objectParent: FieldGroup = {
  id: 'object.parent',
  kind: 'object',
  section: 'parent',
  label: '分组',
  pathTemplate: 'objects.*.parent',
  fields: {
    parent: {
      type: 'string',
      label: '父对象',
      description:
        '继承哪个对象的变换。父级移动/旋转/缩放时，本对象跟着动。留空 = 顶层对象。' +
        '成环会被拒绝（写入时就拒，不只是校验器报）。',
      default: '',
      validation: { maxChars: 64 },
    },
  },
};

/**
 * 高亮效果（P2 动画原语的第一条）。
 *
 * ★ 它解决的是科普视频最核心的手法："现在看这一层"。
 *   在此之前"强调某个元素"只能靠透明度闪一下 —— 而透明度一变，
 *   元素会淡出，读起来是"它要消失了"，不是"它在被强调"。
 */
const highlightParams: FieldGroup = {
  id: 'effect.highlight.params',
  kind: 'effect',
  owner: 'highlight',
  section: 'params',
  label: '高亮',
  pathTemplate: 'effects.*.params',
  fields: {
    start: {
      type: 'number',
      label: '开始时刻',
      description: '相对镜头起点的秒数。',
      default: 1,
      bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.1, unit: 's' },
    },
    duration: {
      type: 'number',
      label: '渐入时长',
      description:
        '从"没高亮"到"最高亮"用多久（秒）。高亮会【保持】在最高亮，不会自己退回 ——' +
        '要恢复原样就再挂一条从某时刻开始、color 设成原色的高亮，或者用两条高亮做脉冲。',
      default: 0.6,
      bounds: { kind: 'bounded', min: 0, max: 60, step: 0.1, unit: 's' },
    },
    color: {
      type: 'color',
      label: '高亮颜色',
      description: '描边（文字是字色）会朝这个颜色渐变。暖黄在暗背景上最像"强调"。',
      default: '#ffd479',
    },
    intensity: {
      type: 'number',
      label: '强度',
      description:
        '0~1 是渐变到高亮色的比例；>1 会过曝（颜色被推向更亮，发光继续加）。' +
        '1 就够用，1.5 用于需要"跳出来"的场合。',
      default: 1,
      bounds: { kind: 'bounded', min: 0, max: 3, step: 0.05, unit: 'ratio' },
    },
  },
};

/**
 * 沿路径移动（P2 动画原语的第三条）。
 *
 * ★ 它解决的是"把东西送过去"这个动作：数据包沿着箭头流进下一个方块、
 *   电子沿着导线跑到电容、小球从起点滚到终点。在此之前只能靠 `tf.x/tf.y`
 *   写两条关键帧手动算两个端点 —— 而那要求模型先把两个对象的坐标都读出来
 *   再做一次世界坐标算术，实测里这类"手工算坐标"是出错最多的一环。
 *
 * ★ 路径【不复制几何】，而是引用一个已有的 line 对象："沿那条线走"。
 *   理由：路径复制一份之后，箭头一改，走的那条路就悄悄对不上了 ——
 *   两个真源里总有一个是错的。引用则天然一致。
 *
 * 限制（刻意画清边界，不假装全能）：
 *   · 源必须是 `line`（起点→终点是直线，所以路上各点由两端点线性插值得到）；
 *   · 路径【不跟随】也挂了 moveAlong 的源对象 —— 移动的路径不叠。
 */
const moveAlongParams: FieldGroup = {
  id: 'effect.moveAlong.params',
  kind: 'effect',
  owner: 'moveAlong',
  section: 'params',
  label: '沿路径移动',
  pathTemplate: 'effects.*.params',
  fields: {
    source: {
      type: 'string',
      label: '路径对象',
      description:
        '拿哪个对象的【起点→终点】当路径 —— 传一个 line 对象的 id（形如 line#1）。' +
        '★ 路径取自那个对象自己的坐标系，所以它被移动/旋转时路径跟着走，不会对不上。',
      default: '',
      validation: { maxChars: 64 },
    },
    start: {
      type: 'number',
      label: '开始时刻',
      description: '相对镜头起点的秒数。',
      default: 0.8,
      bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.1, unit: 's' },
    },
    duration: {
      type: 'number',
      label: '走完用时',
      description:
        '从路径起点走到终点用多久（秒）。走完就【停在终点】，不会自己走回来 ——' +
        '要来回走就再加一条方向相反的（把源换成一个反向的 line）。',
      default: 1.6,
      bounds: { kind: 'bounded', min: 0.1, max: 60, step: 0.1, unit: 's' },
    },
  },
};

/**
 * 显隐（P2 动画原语的第四条）：`appear` / `disappear`。
 *
 * ★ "真显隐"与"透明度淡入"是两件事。透明度到 0 的对象【仍然在 RenderState 里】：
 *   get_render_state 会把它报出来（visible=0）、它仍然参与包围盒与可见性统计，
 *   文档语义上它是"现在透明的"，不是"还没出现"。
 *   appear / disappear 之前之后的对象【根本不在那一帧】—— 反馈与语义都跟着变。
 *   （命中测试与画笔对两种情况的处理是一样的：都跳过。差别在"它在不在这一帧"。）
 *
 * ★ 为什么分成两个效果类型，而不是一个带 mode 的类型：
 *   "第 1 秒出现、第 5 秒消失"是这个原语最常见的用法，而效果解析的口径是
 *   【同类型多条时后定义的生效】。合成一个类型的话，后写的那条会把前一条
 *   整个吃掉；分成两个类型，两者天然各管一端（下界与上界），可以同时挂。
 *
 * ★ 参数只有一个 `at`：它是【阶跃】不是渐变 —— 渐变已经有了两条现成的路
 *   （tf.opacity 的动画轨道、highlight 的渐入），再给这里加一个 duration
 *   只会多出"duration 与轨道谁说了算"这类没有答案的问题。
 */
const appearParams: FieldGroup = {
  id: 'effect.appear.params',
  kind: 'effect',
  owner: 'appear',
  section: 'params',
  label: '出现',
  pathTemplate: 'effects.*.params',
  fields: {
    at: {
      type: 'number',
      label: '出现时刻',
      description: '这一时刻【起】它才在画面里；之前它根本不在这一帧。要淡入就给 tf.opacity 打关键帧，两者互不冲突。',
      default: 1,
      bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.1, unit: 's' },
    },
  },
};

/**
 * 与 `appear` 成对的另一端。语义是 `t >= at` 时它不在。
 *
 * 两个都挂时：`[appear.at, disappear.at)` 是它的可见窗口；
 * 若窗口为空（出现晚于消失）由校验器报 `visibility_window_empty` —— 那种文档
 * 渲染出来什么都没有，而"什么都没有"是最难从画面上反推原因的一种失败。
 */
const disappearParams: FieldGroup = {
  id: 'effect.disappear.params',
  kind: 'effect',
  owner: 'disappear',
  section: 'params',
  label: '消失',
  pathTemplate: 'effects.*.params',
  fields: {
    at: {
      type: 'number',
      label: '消失时刻',
      description: '这一时刻【起】它从画面里消失（含此刻）。与 appear 配合时必须晚于出现时刻。',
      default: 5,
      bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.1, unit: 's' },
    },
  },
};

const drawOnParams: FieldGroup = {
  id: 'effect.drawOn.params',
  kind: 'effect',
  owner: 'drawOn',
  section: 'params',
  label: '生长绘制',
  pathTemplate: 'effects.*.params',
  fields: {
    start: {
      type: 'number',
      label: '开始时刻',
      default: 0,
      bounds: { kind: 'bounded', min: 0, max: 600, step: 0.05, unit: 's' },
    },
    duration: {
      type: 'number',
      label: '持续时长',
      default: 2.2,
      bounds: { kind: 'bounded', min: 0.2, max: 10, step: 0.1, unit: 's' },
    },
    mode: {
      type: 'enum',
      label: '生长方式',
      description: '按定义域：x 均匀推进。按弧长：速度均匀，曲线陡的地方不会突然变快。',
      default: 'arc',
      values: ['domain', 'arc'],
      optionLabels: { domain: '按定义域', arc: '按弧长' },
    },
    tip: { type: 'boolean', label: '显示笔尖', default: true },
  },
};

const sceneMeta: FieldGroup = {
  id: 'scene.meta',
  kind: 'scene',
  section: 'meta',
  label: '场景',
  pathTemplate: 'meta',
  fields: {
    fps: { type: 'integer', label: '帧率', default: 60, bounds: { kind: 'bounded', min: 1, max: 120, step: 1, unit: 'perSecond' }, engineOnly: true },
    duration: {
      type: 'number',
      label: '时长',
      default: 12,
      bounds: { kind: 'bounded', min: 0.1, max: 3600, step: 0.1, unit: 's' },
      animatable: false,
    },
    worldWidth: { type: 'number', label: '世界宽度', default: 16, bounds: { kind: 'bounded', min: 0.1, max: 1000, step: 0.1, unit: 'world' }, engineOnly: true },
    worldHeight: { type: 'number', label: '世界高度', default: 9, bounds: { kind: 'bounded', min: 0.1, max: 1000, step: 0.1, unit: 'world' }, engineOnly: true },
  },
};

const theme: FieldGroup = {
  id: 'theme',
  kind: 'theme',
  section: 'meta',
  label: '主题',
  pathTemplate: 'theme',
  fields: {
    bg: { type: 'color', label: '背景色', default: '#0b0e14' },
    fg: { type: 'color', label: '前景色', default: '#e8eef8' },
    accent: { type: 'color', label: '主色', default: '#4ea1ff' },
    glow: { type: 'number', label: '默认发光', default: 0.6, bounds: { kind: 'bounded', min: 0, max: 1, step: 0.05, unit: 'ratio' } },
  },
};

const cameraKey: FieldGroup = {
  id: 'camera.key',
  kind: 'camera',
  section: 'camera',
  label: '相机关键帧',
  pathTemplate: 'camera.keys.*',
  fields: {
    t: { type: 'number', label: '时刻', default: 0, bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.05, unit: 's' } },
    tx: { type: 'number', label: '注视点 X', default: 0, bounds: { kind: 'unbounded', unit: 'world' } },
    ty: { type: 'number', label: '注视点 Y', default: 0, bounds: { kind: 'unbounded', unit: 'world' } },
    scale: { type: 'number', label: '缩放', default: 1, bounds: { kind: 'bounded', min: 0.05, max: 50, step: 0.05, unit: 'ratio' } },
    rotate: { type: 'number', label: '旋转', default: 0, bounds: { kind: 'bounded', min: -6.2832, max: 6.2832, step: 0.0175, unit: 'rad' } },
  },
};

/**
 * 动画关键帧的字段（规范 §5 的 anim.keys[]）。
 *
 * ★ 为什么必须登记：压力测试的 completion 臂 #12 实测到模型写
 *   `"ease":"easeOut"` —— 这个缓动名【不存在】（只有 easeOutCubic）。
 *   而 applyEase 对未知名字是【回退到 linear 而不报错】（那是求值路径的容错口径，
 *   本身没错），于是模型以为自己指定了缓动，实际拿到的是线性，没有任何反馈。
 *   登记进 registry 之后，tool schema 里就有 enum 了，模型写错名字会被形状校验挡住。
 */
const motionKey: FieldGroup = {
  id: 'motion.key',
  kind: 'motion',
  section: 'anim',
  label: '动画关键帧',
  pathTemplate: 'objects.*.anim.*.keys.*',
  fields: {
    t: { type: 'number', label: '时刻', default: 0, bounds: { kind: 'bounded', min: 0, max: 3600, step: 0.05, unit: 's' } },
    v: { type: 'number', label: '取值', default: 0, bounds: { kind: 'unbounded' } },
    ease: {
      type: 'enum',
      label: '缓动',
      description: '这一段用哪种缓动。名字必须在白名单里，写错会被拒绝（不会静默变成线性）。',
      default: 'linear',
      values: [...EASE_NAMES],
      optionLabels: {
        linear: '线性',
        easeInCubic: '缓入',
        easeOutCubic: '缓出',
        easeInOutCubic: '缓入缓出',
        easeOutBack: '回弹（会过冲）',
      },
    },
  },
};

export const REGISTRY: FieldRegistry = {
  version: '0.1.0',
  groups: [
    sceneMeta,
    theme,
    objectTf,
    objectParent,
    plotParams,
    plotStyle,
    textParams,
    textStyle,
    formulaParams,
    formulaStyle,
    rectParams,
    rectStyle,
    lineParams,
    lineStyle,
    drawOnParams,
    highlightParams,
    moveAlongParams,
    appearParams,
    disappearParams,
    cameraKey,
    motionKey,
  ],
};

export { SEC };
