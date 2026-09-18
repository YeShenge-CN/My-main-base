# -*- coding: utf-8 -*-
"""界面截图脚本（开发辅助，不参与运行）。

用途：
    在离屏模式下渲染界面并保存 PNG，用于人工核对布局与配色。
    脚本会注入一段模拟的问答内容，便于检查「你：/助手：」样式、
    思维链样式与长文本换行效果。

运行：
    python render_preview.py
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt5.QtCore import QTimer  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from main import _register_system_fonts  # noqa: E402
from ui import ChatWindow  # noqa: E402

# 模拟对话：用户提问 + 助手回答（含思维链）
DEMO_USER = "为什么天空是蓝色的？"
DEMO_REASONING = (
    "用户问的是天空颜色成因。这属于大气光学问题，核心是瑞利散射："
    "短波长的蓝光被大气分子散射的强度与波长的四次方成反比，"
    "因此蓝光散射远强于红光，进入眼睛的比例更高。"
)
DEMO_ANSWER = (
    "天空呈蓝色，是因为太阳光被大气分子散射时，短波长的蓝光散射得更强烈。\n"
    "详细解释：\n"
    "1. 瑞利散射：散射强度与波长四次方成反比，蓝光波长约为红光的 0.6 倍，"
    "散射强度却高出数倍。\n"
    "2. 观察结果：进入我们眼睛的散射光以蓝光为主，因此天空呈蓝色。\n"
    "3. 补充现象：日出日落时阳光穿过更厚的大气，蓝光几乎被散射殆尽，"
    "所以天空偏红。"
)


def main() -> int:
    app = QApplication(sys.argv)
    _register_system_fonts()

    window = ChatWindow()
    window.show()
    window.show_reasoning_box.setChecked(True)

    def fill() -> None:
        """注入模拟对话内容后截图。"""
        window.messages = [window.messages[0]]
        window.messages.append({"role": "user", "content": DEMO_USER})
        window.messages.append(
            {
                "role": "assistant",
                "content": DEMO_ANSWER,
                "reasoning": DEMO_REASONING,
            }
        )
        window._render_all()
        window.status_label.setText("就绪")

        QTimer.singleShot(300, capture)

    def capture() -> None:
        """保存截图并退出。"""
        ok = window.grab().save("preview.png")
        print(f"截图保存{'成功' if ok else '失败'}: preview.png", flush=True)
        app.quit()

    QTimer.singleShot(300, fill)
    app.exec_()
    return 0


if __name__ == "__main__":
    sys.exit(main())
