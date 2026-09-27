/**
 * Operation Journal（P5）。
 *
 * Journal 记录的是【操作】而不是"文档快照序列"，所以它天然能回答
 * "AI 刚刚做了什么"；而 CompoundOperation 是"一次工作单元"，
 * "撤销 AI 上一轮" = revert 一个 compound。
 *
 * ⚠️ 注意区分两件事（用户 P5 清单里的提醒）：
 *   细粒度 undo   是面板 Zustand temporal 中间件的栈，管"上一步/下一步"
 *   revert_compound 是 Journal 操作，管"把某一轮整体撤掉"
 * 两者互不替代，也互不干扰。
 */
export * from './types';
export * from './invert';
export * from './store';

// Actor 在 types 里，但调用方（面板/CLI/测试）经常只 import store，
// 这里再导一次省得它们为了一个类型多写一行 import。
export type { Actor } from './types';
