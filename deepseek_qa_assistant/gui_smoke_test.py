# -*- coding: utf-8 -*-
"""GUI 冒烟测试脚本。

用途：
    在没有人工点击的情况下自动验证界面关键行为：
        1. 窗口尺寸确实是 360x640（9:16）且不可调整；
        2. 输入问题 -> 发送 -> 流式回答 -> 历史落库；
        3. 「显示思考过程」开关可用；
        4. 清空按钮能重置历史与界面；
        5. 历史截断逻辑只保留 system + 最近 N 轮。

注意：
    本脚本会发起一次真实的 API 请求。
    使用离屏渲染（QT_QPA_PLATFORM=offscreen），不会弹出真实窗口。

运行：
    python gui_smoke_test.py
"""

from __future__ import annotations

import os
import sys

# 使用离屏渲染，避免测试时弹出真实窗口干扰用户
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt5.QtCore import QEventLoop, QTimer  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from prompts import (  # noqa: E402
    PREFIX_ASSISTANT,
    PREFIX_USER,
    STATUS_READY,
)
from ui import ChatWindow  # noqa: E402

# ---- 测试结果收集 ----
RESULTS = []


def check(name: str, passed: bool, detail: str = "") -> None:
    """记录一条检查结果并立即打印（flush 避免输出丢失）。"""
    tag = "通过" if passed else "失败"
    RESULTS.append((name, passed))
    suffix = f"  ({detail})" if detail else ""
    print(f"[{tag}] {name}{suffix}", flush=True)


def _wait_until(predicate, timeout_ms: int = 90_000, interval_ms: int = 100) -> bool:
    """在事件循环中轮询等待 predicate 成立。

    与 time.sleep 不同，这里保持 Qt 事件循环运转，
    因此工作线程的信号能够被正常投递到主线程。
    """
    loop = QEventLoop()
    elapsed = 0
    result = {"ok": False}

    def tick() -> None:
        nonlocal elapsed
        if predicate():
            result["ok"] = True
            loop.quit()
            return
        elapsed += interval_ms
        if elapsed >= timeout_ms:
            loop.quit()
            return
        QTimer.singleShot(interval_ms, tick)

    QTimer.singleShot(interval_ms, tick)
    loop.exec_()
    return result["ok"]


def run_checks(window: ChatWindow) -> None:
    """按顺序执行全部检查项。"""
    # ---------------------------------------------------------------
    # 1. 尺寸与比例
    # ---------------------------------------------------------------
    size = window.size()
    check(
        "窗口固定 360x640",
        size.width() == 360 and size.height() == 640,
        f"实际 {size.width()}x{size.height()}",
    )
    check(
        "9:16 比例校验",
        abs(size.width() / size.height() - 9 / 16) < 0.001,
        f"比例 {size.width() / size.height():.4f}",
    )
    check(
        "窗口不可调整大小",
        window.minimumSize() == window.maximumSize() == size,
    )

    # ---------------------------------------------------------------
    # 2. 初始状态
    # ---------------------------------------------------------------
    check("初始状态为就绪", window.status_label.text() == STATUS_READY,
          window.status_label.text())
    check("初始历史仅含 system", len(window.messages) == 1)

    # ---------------------------------------------------------------
    # 3. 历史截断逻辑（离线构造 12 轮，应为 system + 10 轮）
    # ---------------------------------------------------------------
    window.messages = [{"role": "system", "content": "sys"}]
    for i in range(12):
        window.messages.append({"role": "user", "content": f"q{i}"})
        window.messages.append({"role": "assistant", "content": f"a{i}"})
    window._trim_history()
    check(
        "历史截断为 system + 10 轮",
        len(window.messages) == 21 and window.messages[0]["role"] == "system",
        f"实际 {len(window.messages)} 条",
    )
    check(
        "截断后保留最新一轮",
        window.messages[-1]["content"] == "a11",
        window.messages[-1]["content"],
    )

    # ---------------------------------------------------------------
    # 4. 真实问答
    # ---------------------------------------------------------------
    window.on_clear_clicked()
    check("清空后历史重置", len(window.messages) == 1)

    # 打开「显示思考过程」，以便验证思维链的流式显示
    window.show_reasoning_box.setChecked(True)

    window.input_edit.setPlainText("用一句话解释什么是黑洞。")
    window.on_send_clicked()

    check("发送后按钮变为「停止」", window.send_button.text() == "停止",
          window.send_button.text())
    check("发送后历史含 user 消息", len(window.messages) >= 2)

    # 等待流式回答结束（按钮恢复为「发送」即代表 finished 槽已执行）
    finished_ok = _wait_until(
        lambda: window.send_button.text() == "发送" and window._worker is not None
        and not window._worker.isRunning()
    )
    check("流式回答在超时前完成", finished_ok)
    if not finished_ok:
        print("[提示] 未在超时内完成，后续检查可能不准确", flush=True)

    # 确保工作线程对象完全退出，避免销毁时崩溃
    if window._worker is not None:
        window._worker.wait(5000)

    # ---------------------------------------------------------------
    # 5. 回答与渲染校验
    # ---------------------------------------------------------------
    assistants = [m for m in window.messages if m["role"] == "assistant"]
    answer = assistants[-1]["content"] if assistants else ""

    check("收到助手回答", bool(answer.strip()), f"{len(answer)} 字")
    check("历史包含 assistant 消息", bool(assistants))
    check("发送按钮恢复为「发送」", window.send_button.text() == "发送")
    check(
        "状态恢复为就绪",
        window.status_label.text() in (STATUS_READY, "已停止"),
        window.status_label.text(),
    )

    document = window.chat_view.toPlainText()
    check("对话区显示用户消息前缀", PREFIX_USER in document)
    check("对话区显示助手消息前缀", PREFIX_ASSISTANT in document)
    check(
        "对话区包含回答正文片段",
        bool(answer) and answer[:12] in document,
    )

    scrollbar = window.chat_view.verticalScrollBar()
    check(
        "自动滚动到底部",
        scrollbar.maximum() == 0 or scrollbar.value() == scrollbar.maximum(),
        f"{scrollbar.value()}/{scrollbar.maximum()}",
    )

    # ---------------------------------------------------------------
    # 6. 思考过程
    # ---------------------------------------------------------------
    reasoning_stored = bool(assistants and assistants[-1].get("reasoning"))
    check(
        "思考模式下已累积思维链",
        reasoning_stored,
        f"{len(assistants[-1].get('reasoning') or '')} 字" if assistants else "无回答",
    )
    check(
        "开关打开时对话区显示思考过程",
        "思考过程" in window.chat_view.toPlainText(),
    )

    window.show_reasoning_box.setChecked(False)
    check("关闭开关后隐藏思考过程", "思考过程" not in window.chat_view.toPlainText())

    # ---------------------------------------------------------------
    # 7. 清空
    # ---------------------------------------------------------------
    window.on_clear_clicked()
    check("再次清空后仅剩 system", len(window.messages) == 1)
    check("清空后输入框为空", window.input_edit.toPlainText() == "")
    check(
        "清空后对话区不含旧回答",
        bool(answer) and answer[:12] not in window.chat_view.toPlainText(),
    )

    # ---------------------------------------------------------------
    # 8. 截图留证
    # ---------------------------------------------------------------
    check("生成界面截图", window.grab().save("smoke_shot.png"), "smoke_shot.png")


def main() -> int:
    app = QApplication(sys.argv)
    window = ChatWindow()
    window.show()

    exit_code = {"value": 0}

    def run() -> None:
        try:
            run_checks(window)
        except Exception as exc:  # noqa: BLE001 - 测试脚本需要打印而非静默失败
            import traceback

            traceback.print_exc()
            check("测试执行未抛异常", False, f"{type(exc).__name__}: {exc}")
        finally:
            failed = [name for name, ok in RESULTS if not ok]
            print("-" * 60, flush=True)
            print(f"共 {len(RESULTS)} 项检查，失败 {len(failed)} 项", flush=True)
            for name in failed:
                print(f"  - 未通过：{name}", flush=True)
            exit_code["value"] = 1 if failed else 0
            app.quit()

    # 让窗口先完成一次布局，再开始检查
    QTimer.singleShot(200, run)
    app.exec_()
    return exit_code["value"]


if __name__ == "__main__":
    sys.exit(main())
