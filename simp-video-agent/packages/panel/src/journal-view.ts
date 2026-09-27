/**
 * Journal 视图（P9 第 8 条）："AI 在第 N 轮做了什么"，带撤销整轮按钮。
 *
 * 撤销的是 CompoundOperation，不是单条操作 ——
 * 这正是"撤销 AI 上一轮"和"细粒度 undo"两件事的分界（规范 §12）。
 * 未 settled 的 compound 不允许撤，按钮在这里就是禁用的。
 */
import type { Journal } from '@sva/engine-core';
import { clear, h } from './dom';

export interface JournalHost {
  readonly journal: Journal;
  readonly onRevert: (compoundId: string) => void;
}

const ACTOR_LABEL: Readonly<Record<string, string>> = {
  user: '用户',
  agent: 'AI',
  'engine-autofix': '引擎自动修',
};

export function renderJournal(container: HTMLElement, host: JournalHost): void {
  clear(container);
  const compounds = [...host.journal.compounds()].reverse();
  if (compounds.length === 0) {
    container.append(h('p', { class: 'muted' }, '还没有任何操作。'));
    return;
  }

  for (const c of compounds) {
    const ops = c.opIds
      .map((id) => host.journal.operation(id))
      .filter((o): o is NonNullable<typeof o> => o !== undefined);

    const card = h('div', { class: 'jcard' });
    const head = h('div', { class: 'jhead' });
    head.append(h('span', { class: 'jactor jactor-' + c.actor }, ACTOR_LABEL[c.actor] ?? c.actor));
    if (c.turnId !== undefined) head.append(h('span', { class: 'jturn' }, '第 ' + c.turnId + ' 轮'));
    head.append(h('span', { class: 'jver' }, 'v' + c.fromVersion + ' → v' + c.toVersion));
    head.append(h('span', { class: c.settled ? 'jstate ok' : 'jstate pending' }, c.settled ? '已结束' : '进行中'));
    card.append(head);

    const list = h('ul', { class: 'jops' });
    for (const op of ops) {
      const li = h('li', {});
      li.append(h('code', {}, op.command.op));
      if (op.intent !== undefined) li.append(h('em', { class: 'intent' }, '「' + op.intent + '」'));
      for (const p of op.affectedPaths) li.append(h('span', { class: 'path' }, p));
      list.append(li);
    }
    card.append(list);

    const btn = h('button', { class: 'revert', type: 'button' }, '撤销这一轮');
    if (!c.settled) {
      btn.setAttribute('disabled', 'disabled');
      btn.title = '这一轮还没结束，不能撤销';
    } else {
      btn.addEventListener('click', () => host.onRevert(c.compoundId));
    }
    card.append(btn);
    container.append(card);
  }
}
