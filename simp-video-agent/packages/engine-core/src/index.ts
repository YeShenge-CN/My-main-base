/**
 * @sva/engine-core —— 纯逻辑层。
 *
 * 铁律（规范 §2 不变量 1）：本包禁止 import 任何 DOM / Node / 渲染框架模块。
 * 由 eslint.config.mjs 与 test/purity.test.ts 双重强制。
 *
 * 导出风格：类型直接具名导出（Vec2 / Mat2D），函数按命名空间导出
 * （Vec.add / Mat.multiply），避免 add/sub/scale 这类通用名在顶层互相打架。
 */

export type { Vec2 } from './math/vec2';
export type { Mat2D, TransformTuple } from './math/mat2d';

export * as Vec from './math/vec2';
export * as Mat from './math/mat2d';

// FieldRegistry：字段级约束元数据的唯一真源（规范 §6）
export * from './registry/types';
export * from './registry/fields';
export * from './registry/ui';
export * from './registry/schema';

// 坐标契约、缓动、文档类型
export * as Ease from './anim/ease';
export * from './anim/track-path';
export * from './anim/track';
export * from './camera';
export * from './doc/types';
export * from './render-state';

// State Read API（P3）
export * from './projection/index';

// 命令与批量事务（P4）
export * from './command/index';

// 变更内核 + Operation Journal（P5）
export * from './journal/index';
export * from './command/apply';
export * from './doc/fields';
export * from './doc/paths';
export * from './doc/locks';
export * from './doc/permissions';

// 表达式 / 采样 / 求值（P0 第 4~7 步）
export * from './expr/index';
export * from './sampling/plot';
export * from './evaluate';

// 公式几何的文档格式（工具写、求值层读的契约）
export * from './render/formula-geometry';

// 公式几何的文档格式（工具写、求值层读的契约）
export * from './render/formula-geometry';

// 多镜头串行渲染的编排层（P12）：帧计划 + 按镜头过滤
export * from './shot';

// 校验与自动修（P7）
export * from './validate/index';