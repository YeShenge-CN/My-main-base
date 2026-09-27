/**
 * 命令层（P4）。
 *
 * 这一层是【唯一的写路径】（不变量 2）。
 *   ids.ts            符号 id 与"null 表示不改"的约定
 *   commands.ts       领域化命令联合 —— 没有 set_param(path, value) 这种逃生舱
 *   apply.ts          变更内核：一条命令 → 新文档 + patches（结构共享）
 *   batch.ts          apply_commands 批量事务：四态 + 依赖推导（精确到 localId 产生者）
 *   proposal.ts       Proposal / precondition / 审批三分支
 *   proposal-eval.ts  三分支判定的实现
 *   results.ts        四态结果与批量事务回执
 *   bus.ts            CommandBus 接口
 */
export * from './ids';
export * from './commands';
export * from './apply';
export * from './proposal';
export * from './proposal-eval';
export * from './proposal-store';
export * from './results';
export * from './batch';
export * from './bus';
