# -*- coding: utf-8 -*-
"""程序入口。

启动流程：
    1. 处理高 DPI 显示（避免小窗口在高分屏上模糊）；
    2. 创建 QApplication 并设置全局字体；
    3. 显示 ChatWindow 主窗口。

运行方式：
    python main.py
"""

from __future__ import annotations

import sys
import traceback

# 应用名称与版本（不依赖 PyQt5，便于 --version 直接输出）
APP_NAME = "知识问答小助手"
APP_VERSION = "1.0.0"


def _log(message: str) -> None:
    """输出诊断信息。

    打包为 --windowed 的 exe 没有控制台，print 的内容会被系统丢弃，
    因此运行在打包环境中时，把信息同时写入 exe 同级目录的启动日志，
    方便用户与开发者排查启动失败问题。
    """
    print(message)

    if not getattr(sys, "frozen", False):
        return

    try:
        from pathlib import Path

        log_path = Path(sys.executable).resolve().parent / "启动日志.log"
        with open(log_path, "a", encoding="utf-8") as handle:
            from datetime import datetime

            stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            handle.write(f"[{stamp}] {message}\n")
    except Exception:  # noqa: BLE001 - 日志失败绝不能影响主流程
        pass


def _bootstrap_env() -> str:
    """引导 .env 配置文件，返回需要提示给用户的信息（无则返回空串）。

    为什么需要这一步：
        PyInstaller 单文件 exe 会把代码解包到临时目录，
        因此 .env 不能放在 exe 内部（否则密钥随 exe 分发，有泄露风险）。
        这里的做法是：exe 首次运行时，把随包附带的 .env.example
        复制到 exe 同级目录并命名为 .env，用户直接编辑即可。

    副作用：
        若刚刚生成了 .env，会重新加载一次环境变量，
        使本次运行就能读取到其中的配置。
    """
    try:
        import config
    except ImportError:
        return ""

    notice = config.prepare_env_file()
    if notice.startswith("已生成配置文件"):
        # 重新加载，让本次启动就能用上新建的 .env
        try:
            from dotenv import load_dotenv

            load_dotenv(dotenv_path=config.APP_DIR / ".env", override=False)
        except ImportError:
            pass
    return notice


def _enable_high_dpi() -> None:
    """开启高 DPI 支持。

    必须在 QApplication 实例化之前调用，否则不生效。
    Qt5 中这些属性在部分平台可能不存在，因此做容错处理。
    """
    try:
        from PyQt5.QtCore import Qt
        from PyQt5.QtWidgets import QApplication

        # 兼容 Qt 5.14 之前 / 之后的写法
        if hasattr(Qt, "AA_EnableHighDpiScaling"):
            QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
        if hasattr(Qt, "AA_UseHighDpiPixmaps"):
            QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    except Exception:  # noqa: BLE001 - 高 DPI 设置失败不应阻断启动
        pass


def _register_system_fonts() -> None:
    """把系统中文字体目录注册进 Qt 字体库。

    背景：
        Qt 自带字体库在多数发行包里是空的（官方提示 «Qt no longer ships fonts»），
        某些环境（精简安装、打包后、离屏渲染）下若无法自动发现系统字体，
        界面文字会显示为空白或方块。这里显式补充常见系统字体目录。
    """
    import os

    try:
        from PyQt5.QtGui import QFontDatabase
    except ImportError:
        return

    if os.name == "nt":
        # Windows：注册系统字体目录（涵盖微软雅黑、宋体等）
        fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
        candidates = [fonts_dir]
    elif sys.platform == "darwin":
        candidates = ["/System/Library/Fonts", "/Library/Fonts"]
    else:
        candidates = [
            "/usr/share/fonts",
            "/usr/local/share/fonts",
            os.path.expanduser("~/.fonts"),
        ]

    for path in candidates:
        if os.path.isdir(path):
            # 失败不阻断启动：系统字体通常能被 Qt 自动发现
            try:
                QFontDatabase.addApplicationFont(path)
            except Exception:  # noqa: BLE001
                pass
            # 目录形式对部分平台无效，逐个文件补充注册
            try:
                for entry in os.listdir(path):
                    if entry.lower().endswith((".ttf", ".otf", ".ttc")):
                        QFontDatabase.addApplicationFont(os.path.join(path, entry))
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    """应用主函数，返回进程退出码。"""
    _log(f"===== 启动 {APP_NAME} {APP_VERSION} =====")
    _log(f"打包运行：{getattr(sys, 'frozen', False)}")
    _log(f"Python：{sys.version.split()[0]}")

    # ------------------------------------------------------------------
    # 命令行参数：便于打包后的 exe 做无界面自检
    # ------------------------------------------------------------------
    argv = sys.argv[1:]
    if "--help" in argv or "-h" in argv:
        _log(
            f"{APP_NAME}\n\n"
            "用法：\n"
            f"  {APP_NAME}.exe              启动图形界面\n"
            f"  {APP_NAME}.exe --selfcheck  无界面自检（检查配置与 API 连通性）\n"
            f"  {APP_NAME}.exe --version    显示版本信息\n"
        )
        return 0

    if "--version" in argv:
        _log(f"{APP_NAME} {APP_VERSION}")
        return 0

    if "--selfcheck" in argv:
        # selfcheck 内部会导入 config，因此必须先完成 .env 引导
        _bootstrap_env()
        import selfcheck

        return selfcheck.main()

    try:
        from PyQt5.QtGui import QFont
        from PyQt5.QtWidgets import QApplication
    except ImportError:
        _log("缺少 PyQt5 依赖，请先安装：pip install -r requirements.txt")
        return 1

    _enable_high_dpi()

    import config
    from prompts import WINDOW_TITLE
    from ui import ChatWindow

    # 打包运行时，若 exe 同级目录没有 .env，则用附带模板生成一份
    notice = _bootstrap_env()
    if notice:
        _log(f"[提示] {notice}")

    _log(f"配置文件：{config.ENV_FILE}")
    # 启动时记录一份脱敏配置信息，方便排查问题（不含密钥明文）
    _log(f"[配置] {config.describe()}")

    app = QApplication(sys.argv)
    app.setApplicationName(WINDOW_TITLE)
    app.setApplicationDisplayName(WINDOW_TITLE)

    # 注册系统字体后再设置全局字体，避免中文字符无法渲染
    _register_system_fonts()

    # 全局默认字体：优先使用中文显示效果较好的字体
    font = QFont("Microsoft YaHei", 9)
    app.setFont(font)

    window = ChatWindow()
    window.show()

    _log("主窗口已显示，进入事件循环")
    code = app.exec_()
    _log(f"事件循环结束，退出码={code}")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - 顶层兜底，避免闪退看不到错误
        detail = traceback.format_exc()
        _log("启动失败，异常信息如下：")
        _log(detail)
        sys.exit(1)
