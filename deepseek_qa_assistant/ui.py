# -*- coding: utf-8 -*-
"""界面模块。

包含：
    EnterTextEdit  —— 支持 Enter 发送 / Shift+Enter 换行的输入框
    ChatWindow     —— 固定 360x640（9:16）的主窗口

界面结构（自上而下）：
    ┌──────────────────────────────┐
    │ 标题 + 状态标签 + 思考过程开关 │  顶部区
    ├──────────────────────────────┤
    │ QTextBrowser 对话显示区（只读）│  中部区
    ├──────────────────────────────┤
    │ 输入框 + 发送/停止 + 清空      │  底部区
    └──────────────────────────────┘
"""

from __future__ import annotations

import html
from typing import Any, Dict, List, Optional

from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QKeyEvent, QTextCursor
from PyQt5.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QTextBrowser,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

import config
from prompts import (
    PREFIX_ASSISTANT,
    PREFIX_REASONING,
    PREFIX_USER,
    STATUS_ANSWER_ERR,
    STATUS_ANSWERING,
    STATUS_READY,
    STATUS_STOPPED,
    STATUS_THINKING,
    SYSTEM_PROMPT,
    WELCOME_TEXT,
    WINDOW_TITLE,
)
from worker import StreamWorker

# ---------------------------------------------------------------------------
# 窗口尺寸常量：9:16 竖屏比例
# ---------------------------------------------------------------------------
WINDOW_WIDTH = 360
WINDOW_HEIGHT = 640

# 流式刷新节流间隔（毫秒）。模型 chunk 到达频率很高，
# 若每个 chunk 都立刻重排文档会明显吃 CPU，这里合批刷新。
_FLUSH_INTERVAL_MS = 30


class EnterTextEdit(QTextEdit):
    """输入框：Enter 发送，Shift+Enter 换行。

    处理策略：
        * keyPressEvent 中拦截无修饰键的 Enter/Return 并发出发送信号，
          Shift+Enter 走默认行为（插入换行），因此天然不需要 <br> hack；
        * 直接 Ctrl+V 粘贴多行文本时，把换行转成 <br>，
          避免一次性提交多条消息。
    """

    def __init__(self, on_send, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self._on_send = on_send
        # 关闭自动格式化，避免长文本被自动换行成硬回车
        self.setLineWrapMode(QTextEdit.WidgetWidth)
        self.setTabChangesFocus(True)

    def keyPressEvent(self, event: QKeyEvent) -> None:  # noqa: N802 - Qt 命名约定
        """按键处理：Enter 发送，Shift+Enter 换行。"""
        key = event.key()
        modifiers = event.modifiers()

        is_enter = key in (Qt.Key_Return, Qt.Key_Enter)

        if is_enter and modifiers == Qt.NoModifier:
            # 纯 Enter：发送
            self._on_send()
            event.accept()
            return

        if is_enter and modifiers == Qt.ShiftModifier:
            # Shift+Enter：交给默认实现插入换行
            super().keyPressEvent(event)
            return

        super().keyPressEvent(event)

    def insertFromMimeData(self, source) -> None:  # noqa: N802 - Qt 命名约定
        """粘贴处理：把多行文本的换行转成 <br>，保持「一次粘贴=一条消息」。"""
        if source.hasText():
            text = source.text()
            if "\n" in text or "\r" in text:
                normalized = text.replace("\r\n", "\n").replace("\r", "\n")
                html_text = normalized.replace("\n", "<br>")
                self.insertHtml(html_text)
                return
        super().insertFromMimeData(source)


class ChatWindow(QWidget):
    """知识问答小助手主窗口。"""

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)

        # ---- 运行时状态 ----
        # 对话历史：仅存放 role/content，system 提示词固定在第 0 位
        self.messages: List[Dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        self._worker: Optional[StreamWorker] = None

        # 流式缓冲：正文 / 思维链分别累积，由定时器统一刷新到界面
        self._pending_content: List[str] = []
        self._pending_reasoning: List[str] = []
        # 本轮回答已收到的完整思维链（无论开关是否打开都要累积，
        # 这样用户中途打开「显示思考过程」时也能立即看到已有内容）
        self._current_reasoning: List[str] = []
        # 当前回答是否已经创建过「助手：」气泡
        self._assistant_block_open = False
        # 本次回答是否显示了思维链标题
        self._reasoning_block_open = False

        self._flush_timer = QTimer(self)
        self._flush_timer.setInterval(_FLUSH_INTERVAL_MS)
        self._flush_timer.timeout.connect(self._flush_pending)

        self._build_ui()
        self._apply_styles()
        self._check_config_on_start()

    # ==================================================================
    # 界面构建
    # ==================================================================
    def _build_ui(self) -> None:
        """构建整体布局。"""
        self.setWindowTitle(WINDOW_TITLE)
        # 固定尺寸：既保证 9:16 比例，也禁止用户拉伸
        self.setFixedSize(WINDOW_WIDTH, WINDOW_HEIGHT)

        root = QVBoxLayout(self)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(8)

        # ---------------- 顶部区：标题 + 状态 ----------------
        header = QHBoxLayout()
        header.setSpacing(6)

        self.title_label = QLabel(WINDOW_TITLE)
        self.title_label.setObjectName("titleLabel")
        header.addWidget(self.title_label)
        header.addStretch(1)

        self.status_label = QLabel(STATUS_READY)
        self.status_label.setObjectName("statusLabel")
        self.status_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        header.addWidget(self.status_label)

        root.addLayout(header)

        # ---------------- 顶部区：思考过程开关 ----------------
        self.show_reasoning_box = QCheckBox("显示思考过程")
        self.show_reasoning_box.setObjectName("reasoningToggle")
        self.show_reasoning_box.setChecked(False)  # 默认不显示思维链
        self.show_reasoning_box.stateChanged.connect(self._on_reasoning_toggle)
        root.addWidget(self.show_reasoning_box)

        # ---------------- 中部区：对话显示 ----------------
        self.chat_view = QTextBrowser()
        self.chat_view.setObjectName("chatView")
        self.chat_view.setReadOnly(True)
        self.chat_view.setOpenExternalLinks(True)
        self.chat_view.setFont(QFont("Microsoft YaHei", 9))
        root.addWidget(self.chat_view, 1)

        # ---------------- 底部区：输入 + 按钮 ----------------
        self.input_edit = EnterTextEdit(self.on_send_clicked)
        self.input_edit.setObjectName("inputEdit")
        self.input_edit.setPlaceholderText("输入问题，Enter 发送，Shift+Enter 换行")
        self.input_edit.setFixedHeight(72)  # 小窗口下限制输入区高度
        root.addWidget(self.input_edit)

        buttons = QHBoxLayout()
        buttons.setSpacing(6)

        self.clear_button = QPushButton("清空")
        self.clear_button.setObjectName("clearButton")
        self.clear_button.clicked.connect(self.on_clear_clicked)
        buttons.addWidget(self.clear_button)

        buttons.addStretch(1)

        self.send_button = QPushButton("发送")
        self.send_button.setObjectName("sendButton")
        self.send_button.setDefault(True)
        self.send_button.clicked.connect(self.on_send_clicked)
        buttons.addWidget(self.send_button)

        root.addLayout(buttons)

        # 初始化显示欢迎语
        self._render_all()

    def _apply_styles(self) -> None:
        """应用亮色简洁样式，保证小窗口下的可读性。"""
        self.setStyleSheet(
            """
            QWidget {
                background-color: #f5f6f8;
                color: #1f2328;
                font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                font-size: 12px;
            }
            QLabel#titleLabel {
                font-size: 15px;
                font-weight: bold;
                color: #1a56db;
            }
            QLabel#statusLabel {
                color: #6b7280;
                font-size: 11px;
                padding: 2px 6px;
            }
            QTextBrowser#chatView {
                background-color: #ffffff;
                border: 1px solid #e0e3e8;
                border-radius: 6px;
                padding: 6px;
            }
            QTextEdit#inputEdit {
                background-color: #ffffff;
                border: 1px solid #d0d5dd;
                border-radius: 6px;
                padding: 6px;
            }
            QTextEdit#inputEdit:focus {
                border: 1px solid #1a56db;
            }
            QPushButton {
                background-color: #ffffff;
                border: 1px solid #d0d5dd;
                border-radius: 6px;
                padding: 6px 14px;
                min-height: 22px;
            }
            QPushButton:hover {
                background-color: #eef2ff;
                border-color: #1a56db;
            }
            QPushButton:disabled {
                color: #9aa0a6;
                background-color: #f0f1f3;
                border-color: #e0e3e8;
            }
            QPushButton#sendButton {
                background-color: #1a56db;
                border: 1px solid #1a56db;
                color: #ffffff;
                font-weight: bold;
            }
            QPushButton#sendButton:hover {
                background-color: #1746b0;
            }
            QPushButton#sendButton:disabled {
                background-color: #a9bde8;
                border-color: #a9bde8;
                color: #ffffff;
            }
            QCheckBox#reasoningToggle {
                color: #6b7280;
                font-size: 11px;
            }
            """
        )

    # ==================================================================
    # 启动配置检查
    # ==================================================================
    def _check_config_on_start(self) -> None:
        """启动时检查配置，缺少 API Key 时给出友好提示而不是崩溃。"""
        error = config.get_config_error()
        if error:
            self._set_status(STATUS_ANSWER_ERR)
            self._append_error_notice(error)
            # 弹窗提示，但不阻断程序运行
            QMessageBox.warning(self, "配置提示", f"{error}\n\n配置文件位置：\n{config.ENV_FILE}")
        else:
            self._set_status(STATUS_READY)

    # ==================================================================
    # 渲染相关
    # ==================================================================
    def _render_all(self) -> None:
        """把完整对话历史重新渲染到 QTextBrowser。"""
        self.chat_view.setHtml(self._build_document_html())
        self._scroll_to_bottom()

    def _build_document_html(self) -> str:
        """根据 self.messages 生成完整 HTML 文档。"""
        body_parts: List[str] = []

        # 欢迎语（非历史消息，仅界面提示）
        body_parts.append(
            '<div class="hint">{0}</div>'.format(
                html.escape(WELCOME_TEXT).replace("\n", "<br>")
            )
        )

        for message in self.messages:
            role = message.get("role")
            content = message.get("content") or ""
            reasoning = message.get("reasoning") or ""

            if role == "system":
                continue

            if role == "user":
                body_parts.append(
                    '<p class="user"><span class="who">{0}</span>{1}</p>'.format(
                        html.escape(PREFIX_USER),
                        self._format_content(content),
                    )
                )
            elif role == "assistant":
                # 思维链仅在开关打开且有内容时显示
                if reasoning and self.show_reasoning_box.isChecked():
                    body_parts.append(
                        '<div class="reasoning"><span class="who">{0}</span>{1}</div>'.format(
                            html.escape(PREFIX_REASONING),
                            self._format_content(reasoning),
                        )
                    )
                body_parts.append(
                    '<p class="assistant"><span class="who">{0}</span>{1}</p>'.format(
                        html.escape(PREFIX_ASSISTANT),
                        self._format_content(content),
                    )
                )
            elif role == "error":
                body_parts.append(
                    '<p class="error">{0}</p>'.format(self._format_content(content))
                )

        return _HTML_TEMPLATE.format(body="".join(body_parts))

    @staticmethod
    def _format_content(text: str) -> str:
        """把纯文本转成安全的 HTML（转义 + 换行转 <br>）。"""
        return html.escape(text).replace("\n", "<br>")

    def _append_error_notice(self, text: str) -> None:
        """在对话区插入一条错误提示（同时写入历史，便于用户回看）。"""
        self.messages.append({"role": "error", "content": text})
        self._render_all()

    def _append_raw_html(self, fragment: str) -> None:
        """向 QTextBrowser 末尾追加一段 HTML 片段。

        使用 QTextCursor 在文档末尾插入，而不是每次都 setHtml 重排全文，
        这样在流式输出时开销更小、滚动位置更稳定。
        """
        cursor = self.chat_view.textCursor()
        cursor.movePosition(QTextCursor.End)
        cursor.insertHtml(fragment)
        # 让视图跟着最新内容滚动
        self.chat_view.setTextCursor(cursor)

    def _scroll_to_bottom(self) -> None:
        """滚动到对话区底部。"""
        scrollbar = self.chat_view.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    # ==================================================================
    # 流式追加逻辑
    # ==================================================================
    def _on_reasoning_toggle(self, _state: int) -> None:
        """切换「显示思考过程」时整体重绘，保证历史内容一致。"""
        self._render_all()

    def _flush_pending(self) -> None:
        """定时器回调：把缓冲的流式片段批量写入界面。"""
        # ---- 思维链 ----
        if self._pending_reasoning:
            if not self.show_reasoning_box.isChecked():
                # 开关关闭时直接丢弃，不做渲染
                self._pending_reasoning.clear()
            else:
                text = "".join(self._pending_reasoning)
                self._pending_reasoning.clear()
                if not self._reasoning_block_open:
                    self._reasoning_block_open = True
                    self._append_raw_html(
                        '<div class="reasoning"><span class="who">{0}</span>'.format(
                            html.escape(PREFIX_REASONING)
                        )
                    )
                self._append_raw_html(self._format_content(text))

        # ---- 正文 ----
        if self._pending_content:
            text = "".join(self._pending_content)
            self._pending_content.clear()
            if not self._assistant_block_open:
                self._assistant_block_open = True
                self._append_raw_html(
                    '<p class="assistant"><span class="who">{0}</span>'.format(
                        html.escape(PREFIX_ASSISTANT)
                    )
                )
            self._append_raw_html(self._format_content(text))

        self._scroll_to_bottom()

    def _close_open_blocks(self) -> None:
        """结束当前回答时闭合未完成的 HTML 标签。"""
        if self._reasoning_block_open:
            self._append_raw_html("</div>")
            self._reasoning_block_open = False
        if self._assistant_block_open:
            self._append_raw_html("</p>")
            self._assistant_block_open = False

    # ==================================================================
    # 状态控制
    # ==================================================================
    def _set_status(self, text: str) -> None:
        """更新状态栏文案。"""
        self.status_label.setText(text)

    def _set_busy(self, busy: bool) -> None:
        """切换忙碌状态：忙碌时发送按钮变成「停止」。"""
        if busy:
            self.send_button.setText("停止")
            self.send_button.setEnabled(True)
        else:
            self.send_button.setText("发送")
            self.send_button.setEnabled(True)
            self._flush_timer.stop()
            self._flush_pending()

    # ==================================================================
    # 槽函数：发送 / 清空
    # ==================================================================
    def on_send_clicked(self) -> None:
        """发送按钮 / Enter 键的处理入口；忙碌时作为「停止生成」。"""
        # 正在生成：本次点击表示停止
        if self._worker is not None and self._worker.isRunning():
            self._stop_generation()
            return

        # 取输入内容：toPlainText 会把 <br> 还原成 \n
        question = self.input_edit.toPlainText().strip()
        if not question:
            return

        if not config.has_api_key():
            self._set_status(STATUS_ANSWER_ERR)
            self._append_error_notice(config.get_config_error() or "未配置 API Key，请检查 .env")
            return

        # 清空输入框
        self.input_edit.clear()

        # 追加用户消息到历史并渲染
        self.messages.append({"role": "user", "content": question})
        self._append_raw_html(
            '<p class="user"><span class="who">{0}</span>{1}</p>'.format(
                html.escape(PREFIX_USER),
                self._format_content(question),
            )
        )
        self._scroll_to_bottom()

        # 重置流式状态
        self._pending_content.clear()
        self._pending_reasoning.clear()
        self._current_reasoning = []
        self._assistant_block_open = False
        self._reasoning_block_open = False

        # 启动工作线程（传入历史副本，避免线程与主线程共享同一列表）
        history_snapshot = self._build_request_messages()
        self._worker = StreamWorker(history_snapshot, self)
        self._worker.chunk_received.connect(self._on_chunk)
        self._worker.reasoning_received.connect(self._on_reasoning_chunk)
        self._worker.finished.connect(self._on_finished)
        self._worker.error.connect(self._on_error)

        self._set_status(
            STATUS_THINKING if config.THINKING_ENABLED else STATUS_ANSWERING
        )
        self._set_busy(True)
        self._flush_timer.start()
        self._worker.start()

    def on_clear_clicked(self) -> None:
        """清空对话：重置历史与界面。"""
        # 若正在生成，先停止，避免回调写入已清空的状态
        if self._worker is not None and self._worker.isRunning():
            self._stop_generation()

        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self._pending_content.clear()
        self._pending_reasoning.clear()
        self._current_reasoning = []
        self._assistant_block_open = False
        self._reasoning_block_open = False
        self.input_edit.clear()
        self._set_status(STATUS_READY)
        self._render_all()

    def _stop_generation(self) -> None:
        """请求停止当前生成。"""
        if self._worker is not None and self._worker.isRunning():
            self._worker.stop()
            self._set_status(STATUS_STOPPED)

    # ==================================================================
    # 工作线程信号处理
    # ==================================================================
    def _on_chunk(self, text: str) -> None:
        """收到正文片段：放入缓冲，由定时器合批刷新。"""
        self._pending_content.append(text)
        if self.status_label.text() != STATUS_ANSWERING:
            self._set_status(STATUS_ANSWERING)

    def _on_reasoning_chunk(self, text: str) -> None:
        """收到思维链片段。

        无论「显示思考过程」是否勾选，都完整累积到 _current_reasoning，
        这样用户中途打开开关或事后回看时，思维链都不会丢失。
        """
        self._current_reasoning.append(text)
        if self.show_reasoning_box.isChecked():
            self._pending_reasoning.append(text)

    def _on_finished(self, full_text: str) -> None:
        """回答完成：落库、刷新界面、恢复按钮。"""
        # 先把缓冲内容刷出去
        self._pending_content.clear()
        self._pending_reasoning.clear()
        self._close_open_blocks()

        # 取出本轮完整思维链（用于历史回看，不参与 API 请求）
        reasoning_text = "".join(self._current_reasoning)
        self._current_reasoning = []

        if full_text:
            # 把助手回答追加进历史（仅保留 role/content/reasoning，
            # 不携带任何多余字段，避免回传给 API 时出错）
            self.messages.append(
                {
                    "role": "assistant",
                    "content": full_text,
                    "reasoning": reasoning_text,
                }
            )
            self._trim_history()

        self._flush_timer.stop()
        self._set_busy(False)
        # 停止后不覆盖「已停止」状态提示
        if self.status_label.text() != STATUS_STOPPED:
            self._set_status(STATUS_READY)
        self._scroll_to_bottom()

        # 生成结束后整体重绘一次，保证 HTML 结构完整、可正确滚动
        self._render_all()

    def _on_error(self, message: str) -> None:
        """发生错误：显示提示，恢复界面。"""
        self._flush_timer.stop()
        self._flush_pending()
        self._close_open_blocks()

        self._set_status(STATUS_ANSWER_ERR)
        self._append_error_notice(f"⚠ {message}")

        self._set_busy(False)

    # ==================================================================
    # 历史管理
    # ==================================================================
    def _build_request_messages(self) -> List[Dict[str, Any]]:
        """构造发给 API 的消息列表（只含 role/content，符合 API 要求）。"""
        payload: List[Dict[str, Any]] = []
        for message in self.messages:
            role = message.get("role")
            if role not in ("system", "user", "assistant"):
                # 界面用的 error 类型不参与请求
                continue
            payload.append({"role": role, "content": message.get("content") or ""})
        return payload

    def _trim_history(self) -> None:
        """截断历史：保留 system 消息 + 最近 N 轮对话，控制 token 消耗。"""
        max_rounds = max(1, config.MAX_HISTORY_ROUNDS)
        max_messages = max_rounds * 2  # 一轮 = user + assistant

        system_message = None
        dialog: List[Dict[str, Any]] = []
        for message in self.messages:
            if message.get("role") == "system":
                if system_message is None:
                    system_message = message
            else:
                dialog.append(message)

        if len(dialog) > max_messages:
            dialog = dialog[-max_messages:]

        rebuilt: List[Dict[str, Any]] = []
        if system_message is not None:
            rebuilt.append(system_message)
        rebuilt.extend(dialog)
        self.messages = rebuilt

    # ==================================================================
    # 窗口关闭
    # ==================================================================
    def closeEvent(self, event) -> None:  # noqa: N802 - Qt 命名约定
        """关闭窗口前确保后台线程已退出，避免进程残留。"""
        if self._worker is not None and self._worker.isRunning():
            self._worker.stop()
            # 等待线程结束，最长 3 秒，超时则强制终止
            if not self._worker.wait(3000):
                self._worker.terminate()
                self._worker.wait(1000)
        super().closeEvent(event)


# ---------------------------------------------------------------------------
# 对话区 HTML 模板：使用 QTextDocument 支持的 CSS 子集
# ---------------------------------------------------------------------------
_HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
    body {{
        font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
        font-size: 12px;
        color: #1f2328;
        line-height: 150%;
    }}
    p {{ margin: 4px 0 10px 0; }}
    .who {{ font-weight: bold; }}
    p.user {{ color: #1a56db; }}
    p.user .who {{ color: #1a56db; }}
    p.assistant {{ color: #1f2328; }}
    p.assistant .who {{ color: #0f7b3f; }}
    .reasoning {{
        color: #7a7f87;
        font-size: 11px;
        background-color: #f7f8fa;
        border-left: 3px solid #d0d5dd;
        padding: 4px 6px;
        margin: 4px 0 6px 0;
    }}
    .reasoning .who {{ color: #7a7f87; }}
    .hint {{ color: #9aa0a6; font-size: 11px; margin-bottom: 8px; }}
    p.error {{ color: #b42318; background-color: #fef3f2; padding: 5px 6px; }}
</style>
</head>
<body>
{body}
</body>
</html>
"""
