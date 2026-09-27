/**
 * 审批卡（P10 第 2、3、7 条）。
 *
 * 刻意做成【一个可复用组件】：审核队列用它，
 * 将来聊天流里的内联审批卡（DSH 插件侧）也用它 —— 三处呈现共用一份实现，
 * 才不会出现"队列里能批准、聊天里批准不了"这种分叉。
 *
 * 卡上必须说清四件事：当前值 / 目标值 / 画面变化 / 理由。
 */
import type { Proposal } from '@sva/engine-core';
import { h } from './dom';

export interface ProposalCardHost {
  readonly onApprove: (proposalId: string) => void;
  readonly onReject: (proposalId: string, note: string) => void;
  /** 改为手动设定：认可方向，取用户手调的值 */
  readonly onOverride: (proposalId: string, value: number) => void;
  /** 剩余毫秒。返回 undefined 表示不显示倒计时。 */
  readonly remainingMs?: (proposalId: string) => number | undefined;
}

const fmt = (v: unknown): string => {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

export function renderProposalCard(p: Proposal, host: ProposalCardHost): HTMLElement {
  const card = h('div', { class: 'pcard' });

  const head = h('div', { class: 'phead' });
  head.append(h('span', { class: 'pby' }, p.by === 'ai' ? 'AI 提议' : '用户提议'));
  head.append(h('code', { class: 'ppath' }, p.target));
  const left = host.remainingMs?.(p.proposalId);
  if (left !== undefined) {
    head.append(h('span', { class: 'pttl' }, '剩余 ' + Math.max(0, Math.round(left / 1000)) + ' 秒'));
  }
  card.append(head);

  // 四件事，缺一不可
  const reason = h('dl', { class: 'preason' });
  reason.append(h('dt', {}, '当前值'), h('dd', {}, fmt(p.reasonDetail.currentValue)));
  const dd = h('dd', {}, fmt(p.reasonDetail.targetValue));
  dd.className = 'target';
  reason.append(h('dt', {}, '目标值'), dd);
  reason.append(h('dt', {}, '画面变化'), h('dd', {}, p.reasonDetail.visualChange));
  reason.append(h('dt', {}, '理由'), h('dd', { class: 'rationale' }, p.reasonDetail.rationale));
  card.append(reason);

  const row = h('div', { class: 'pactions' });

  const approve = h('button', { class: 'btn ok', type: 'button' }, '批准');
  approve.addEventListener('click', () => host.onApprove(p.proposalId));
  row.append(approve);

  const reject = h('button', { class: 'btn no', type: 'button' }, '拒绝');
  reject.addEventListener('click', () => host.onReject(p.proposalId, '用户点了拒绝。'));
  row.append(reject);

  // 第三个选项：认可方向，但最终值由用户手定
  const overrideBox = h('input', { class: 'num', type: 'number' });
  overrideBox.value = String(typeof p.after === 'number' ? p.after : 0);
  overrideBox.title = '改为手动设定：保留 AI 的方向，用这个值作为最终值';
  const override = h('button', { class: 'btn manual', type: 'button' }, '改为手动设定');
  override.addEventListener('click', () => {
    const v = Number(overrideBox.value);
    if (Number.isFinite(v)) host.onOverride(p.proposalId, v);
  });
  row.append(overrideBox, override);

  card.append(row);
  return card;
}
