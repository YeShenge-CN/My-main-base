/**
 * 聊天窗口：用自然语言命令 Agent 做事。
 *
 * ★ 它只是一个【外壳】：消息怎么发、Agent 怎么跑、结果怎么落到文档上，
 *   全在宿主（app.ts）手里。这里刻意不认识任何引擎类型 ——
 *   这样它能和面板的其余部分分开测试，也不会因为引擎改了而跟着改。
 *
 * ★ 一条铁律：聊天里【不】承诺"我改了"，只显示引擎回执里的事实
 *   （成功几条 / 提案几条 / 失败几条 / 引擎自动修几次）。
 *   面向人的措辞与引擎的判定分家，是这个项目最容易骗自己的地方。
 */
import { clear, h } from './dom';

export type ChatRole = 'user' | 'tool' | 'note' | 'error';

export interface ChatLine {
  readonly role: ChatRole;
  readonly text: string;
  /** 工具名（role=tool 时用来做前缀色块）。 */
  readonly name?: string;
  readonly turn?: number;
}

export interface ChatHost {
  /** 用户按下发送。宿主负责真正去跑（可能是网络请求）。 */
  readonly onSubmit: (task: string) => void;
  /** 请求期间的占位提示，返回的元素会在结束后被移除。 */
  readonly busyLabel?: string;
}

export interface ChatView {
  readonly root: HTMLElement;
  /** 追加一条消息并滚到底部。 */
  add(line: ChatLine): void;
  /** 整批替换（比如切换文档时）。 */
  reset(lines: readonly ChatLine[]): void;
  /**
   * 当前显示的那些行（保存工程时把上下文一起带走）。
   *
   * ★ 只读快照，不是活的引用：调用方改它不会影响界面。
   */
  lines(): readonly ChatLine[];
  /** 显示/隐藏"正在跑"。 */
  setBusy(busy: boolean, label?: string): void;
  /** 输入框内容。 */
  draft(): string;
  /** 是否正在跑（宿主用来禁用重复提交）。 */
  isBusy(): boolean;
  /** 聚焦输入框。 */
  focus(): void;
  /** 塞一句提示词进输入框（预设按钮用）。 */
  fill(text: string): void;
  /**
   * 改发送按钮的文字（面板用它区分「发送」与「生成整片」）。
   *
   * ★ 两个模式共用一个输入框，如果按钮永远写着「发送」，
   *   用户就没法在按下之前知道自己要花掉的是几秒还是几分钟。
   */
  setSendLabel(label: string): void;
}

const ROLE_CLASS: Readonly<Record<ChatRole, string>> = {
  user: 'msg-user',
  tool: 'msg-tool',
  note: 'msg-note',
  error: 'msg-error',
};

const PRESETS: readonly { readonly label: string; readonly text: string }[] = [
  { label: '画一条正弦曲线', text: '画一条 y=sin(x) 的曲线，x 从 -7 到 7，用 2 秒生长出来。' },
  { label: '让它发光', text: '把这条曲线的发光调到 0.9，让它亮一点。' },
  { label: '加一行标题', text: '在画面顶部加一行中文标题：「正弦曲线」。' },
  { label: '推近镜头', text: '用 camera_preset 推近这条曲线，持续 3 秒。' },
  { label: '检查画面', text: '用 get_render_state 检查一下构图，有没有对象跑到画面外面。' },
];

export function createChatView(host: ChatHost): ChatView {
  /** 已显示的行（`add` / `reset` 都同步维护它）。 */
  let shown: ChatLine[] = [];
  const list = h('div', { class: 'chat-list', id: 'chatlist' });
  const presetRow = h('div', { class: 'chat-presets', id: 'chatpresets' });
  const input = h('textarea', { class: 'chat-input', id: 'chatinput', rows: '2' });
  input.placeholder = '用一句话告诉 Agent 你要什么，例如：画一条 y=sin(x) 的曲线…（Ctrl+Enter 发送）';
  const sendBtn = h('button', { class: 'btn chat-send', id: 'chatsend', type: 'button' }, '发送');
  const status = h('span', { class: 'chat-status', id: 'chatstatus' }, '');

  const view: ChatView = {
    root: h('div', { class: 'chat', id: 'chat' }, list, presetRow, h('div', { class: 'chat-compose' }, input, sendBtn), status),
    add(line) {
      shown.push(line);
      list.append(lineEl(line));
      list.scrollTop = list.scrollHeight;
    },
    reset(lines) {
      shown = [...lines];
      clear(list);
      for (const l of lines) list.append(lineEl(l));
      list.scrollTop = list.scrollHeight;
    },
    lines: () => [...shown],
    setBusy(busy, label) {
      sendBtn.disabled = busy;
      input.disabled = busy;
      status.textContent = busy ? (label ?? host.busyLabel ?? 'Agent 正在工作…') : '';
      status.className = busy ? 'chat-status on' : 'chat-status';
    },
    draft: () => input.value.trim(),
    isBusy: () => sendBtn.disabled,
    focus: () => input.focus(),
    fill(text) {
      input.value = text;
      input.focus();
    },
    setSendLabel(label) {
      sendBtn.textContent = label;
    },
  };

  for (const p of PRESETS) {
    const b = h('button', { class: 'chip', type: 'button' }, p.label);
    b.addEventListener('click', () => view.fill(p.text));
    presetRow.append(b);
  }

  const submit = (): void => {
    const task = view.draft();
    if (task === '' || view.isBusy()) return;
    input.value = '';
    host.onSubmit(task);
  };
  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (ev) => {
    // Ctrl/Cmd + Enter 发送；单独 Enter 换行（免得长任务被误发）
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submit();
    }
  });

  return view;
}

function lineEl(line: ChatLine): HTMLElement {
  const cls = ROLE_CLASS[line.role];
  if (line.role === 'tool') {
    const head = h('span', { class: 'msg-tool-head' }, (line.turn === undefined ? '' : '第' + line.turn + '轮 · ') + (line.name ?? 'tool'));
    return h('div', { class: 'msg ' + cls }, head, h('span', { class: 'msg-tool-text' }, line.text));
  }
  return h('div', { class: 'msg ' + cls }, line.text);
}
