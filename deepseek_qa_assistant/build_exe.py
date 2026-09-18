# -*- coding: utf-8 -*-
"""一键打包脚本：把项目编译为 Windows 可执行程序。

用法：
    python build_exe.py              # 默认：文件夹模式（onedir，推荐）
    python build_exe.py --onefile    # 单文件模式（onefile）
    python build_exe.py --console    # 保留控制台窗口，便于看报错

产物（文件夹模式，默认）：
    dist/知识问答小助手/知识问答小助手.exe
    dist/知识问答小助手/.env              —— 自动复制的外部配置
    dist/知识问答小助手/_internal/        —— 运行时依赖（请勿删除）

产物（单文件模式）：
    dist/知识问答小助手.exe
    dist/.env

两种模式如何选择：
    * onedir（默认）：无需运行时解包，启动更快、最稳定，
      在受限环境（安全软件、沙箱、只读临时目录）下也能运行；
    * onefile：分发时只有一个文件更简洁，但每次启动都要把约 50MB 内容
      解包到临时目录，个别受限环境下可能无法启动。

设计说明：
    * 通过 --add-data 把 .env.example 打进包里作为模板：
      程序首次运行时会在 exe 同级目录生成 .env，用户直接填写即可；
    * 绝不把真实 .env 打进 exe，避免密钥随程序外泄；
    * --exclude-module 去掉用不到的重型库，显著减小体积。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

# 项目目录（本文件所在目录）
PROJECT_DIR = Path(__file__).resolve().parent

# 可执行文件名与入口脚本
EXE_NAME = "知识问答小助手"
ENTRY_SCRIPT = "main.py"

# 不需要打包的模块（Qt 的 WebEngine / 多媒体等体积大且本程序用不到）
EXCLUDED_MODULES = [
    "PyQt5.QtWebEngineWidgets",
    "PyQt5.QtWebEngineCore",
    "PyQt5.QtWebEngine",
    "PyQt5.QtQml",
    "PyQt5.QtQuick",
    "PyQt5.QtQuick3D",
    "PyQt5.QtMultimedia",
    "PyQt5.QtMultimediaWidgets",
    "PyQt5.QtBluetooth",
    "PyQt5.QtDesigner",
    "PyQt5.QtHelp",
    "PyQt5.QtLocation",
    "PyQt5.QtNfc",
    "PyQt5.QtPositioning",
    "PyQt5.QtSensors",
    "PyQt5.QtSerialPort",
    "PyQt5.QtSql",
    "PyQt5.QtTest",
    "PyQt5.QtWebSockets",
    "PyQt5.QtXmlPatterns",
    "tkinter",
    "matplotlib",
    "numpy",
    "PIL",
    "pandas",
    "scipy",
]


def check_environment() -> bool:
    """检查打包所需的环境是否就绪。"""
    print("=" * 62)
    print("环境检查")
    print("=" * 62)

    # Python 版本
    print(f"Python 版本 : {sys.version.split()[0]}")
    print(f"项目目录    : {PROJECT_DIR}")

    # 入口脚本
    entry = PROJECT_DIR / ENTRY_SCRIPT
    if not entry.is_file():
        print(f"[失败] 未找到入口脚本：{entry}")
        return False

    # 依赖检查
    missing = []
    for module in ("PyQt5", "openai", "dotenv", "PyInstaller"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        print(f"[失败] 缺少依赖：{', '.join(missing)}")
        print("       请执行：pip install PyQt5 openai python-dotenv pyinstaller")
        return False

    # 配置模板检查
    if not (PROJECT_DIR / ".env.example").is_file():
        print("[失败] 未找到 .env.example，无法生成外部配置模板")
        return False

    # 语法预检：尽早暴露语法错误，避免打包到一半才失败
    check = subprocess.run(
        [sys.executable, "-m", "py_compile", ENTRY_SCRIPT],
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
    )
    if check.returncode != 0:
        print("[失败] 入口脚本语法检查未通过：")
        print(check.stderr.strip())
        return False

    print("[通过] 环境检查全部通过")
    return True


def clean_previous() -> bool:
    """清理上一次的打包产物，避免旧文件干扰。

    返回 True 表示清理干净；False 表示有文件被占用（通常是上一次的 exe 还在运行）。

    注意：build/ 目录里会残留一个缺 _internal 的同名 exe，
    误点会报「Failed to load Python DLL」，因此每次打包前也必须清掉。
    """
    ok = True
    for name in ("build", "dist"):
        path = PROJECT_DIR / name
        if not path.exists():
            continue
        print(f"清理旧目录：{name}/")
        try:
            shutil.rmtree(path)
        except OSError:
            # 常见原因：上一次打包出的 exe 还在运行，文件被锁定
            ok = False
            print(f"[警告] {name}/ 无法完全删除，可能有程序正在运行并占用文件：")

            # 找出占用该目录的可执行文件，给出明确指引
            exe_names = {
                f.name for f in path.rglob("*.exe") if f.is_file()
            }
            for exe_name in exe_names:
                print(f"        疑似占用：{exe_name}")
            print("        请先关闭这些程序（含报错弹窗）后重新执行本脚本。")

    spec = PROJECT_DIR / f"{EXE_NAME}.spec"
    if spec.exists():
        try:
            spec.unlink()
        except OSError:
            ok = False
            print(f"[警告] 无法删除 {spec.name}，请手动删除后重试")
    return ok


def build(onefile: bool, console: bool) -> bool:
    """调用 PyInstaller 执行打包。

    参数：
        onefile: True 使用 --onefile（单文件），False 使用 --onedir（文件夹）。
        console: True 保留控制台窗口，便于查看运行时报错。
    """
    mode_name = "单文件 onefile" if onefile else "文件夹 onedir"
    print("=" * 62)
    print(f"开始打包（模式：{mode_name}，首次打包通常需要 1-3 分钟）")
    print("=" * 62)

    # --add-data 在 Windows 上使用「源;目标」格式
    separator = ";" if sys.platform == "win32" else ":"

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile" if onefile else "--onedir",
        "--console" if console else "--windowed",
        "--name",
        EXE_NAME,
        "--add-data",
        f".env.example{separator}.",
    ]

    # 排除用不到的模块，减小体积
    for module in EXCLUDED_MODULES:
        command.extend(["--exclude-module", module])

    command.append(ENTRY_SCRIPT)

    print("执行命令：")
    print("  " + " ".join(command))
    print("-" * 62)

    # 实时输出 PyInstaller 日志（stdio 继承，便于观察进度）
    result = subprocess.run(command, cwd=str(PROJECT_DIR))
    return result.returncode == 0


def post_build(onefile: bool) -> int:
    """打包后处理：复制 .env 到产物目录并输出使用说明。"""
    dist_dir = PROJECT_DIR / "dist"

    print("=" * 62)
    print("打包结果")
    print("=" * 62)

    # 两种模式的 exe 位置不同
    if onefile:
        exe_path = dist_dir / f"{EXE_NAME}.exe"
        run_dir = dist_dir
    else:
        run_dir = dist_dir / EXE_NAME
        exe_path = run_dir / f"{EXE_NAME}.exe"

    if not exe_path.is_file():
        print("[失败] 未找到生成的 exe：")
        print(f"       {exe_path}")
        return 1

    size_mb = exe_path.stat().st_size / (1024 * 1024)
    print(f"[成功] {exe_path}")
    print(f"       exe 体积：{size_mb:.1f} MB")
    if not onefile:
        total = sum(f.stat().st_size for f in run_dir.rglob("*") if f.is_file())
        print(f"       整体体积：{total / (1024 * 1024):.1f} MB（含 _internal 依赖）")

    # 把本地 .env 复制到 exe 同级目录，双击即可直接使用
    local_env = PROJECT_DIR / ".env"
    if local_env.is_file():
        target = run_dir / ".env"
        shutil.copyfile(local_env, target)
        print(f"[完成] 已复制配置文件：{target}")
    else:
        print("[提示] 项目内没有 .env，exe 首次运行会自动生成模板供填写")

    print("-" * 62)
    print("使用方式：")
    if onefile:
        print(f"  1. 双击运行 {exe_path}")
    else:
        print(f"  1. 运行 {exe_path}")
        print("  2. 整个「知识问答小助手」文件夹一起分发，_internal 目录不可删除")
    print("  3. 配置文件 .env 与 exe 放在同一目录")
    print("  4. 修改 .env 后需要重新启动程序才会生效")
    print(f"  5. 无界面自检：{EXE_NAME}.exe --selfcheck")
    print("  6. 启动异常时查看同级目录的「启动日志.log」")

    # 删除 PyInstaller 的中间目录。
    # build/ 里会残留一个缺 _internal 的同名 exe，误点会报
    # 「Failed to load Python DLL ... python312.dll」，
    # 因此打包成功后直接清掉，避免误导。
    build_dir = PROJECT_DIR / "build"
    if build_dir.exists():
        shutil.rmtree(build_dir, ignore_errors=True)
        print("-" * 62)
        print("已清理中间目录 build/（其中残留的同名 exe 无法运行）")

    return 0


def main() -> int:
    argv = sys.argv[1:]
    onefile = "--onefile" in argv
    console = "--console" in argv

    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0

    if not check_environment():
        return 1

    # 清理旧产物；若有文件被占用则提前退出，避免产出半成品
    if not clean_previous():
        print("=" * 62)
        print("[失败] 旧产物清理不完整，请关闭正在运行的程序后重试")
        return 1

    if not build(onefile=onefile, console=console):
        print("=" * 62)
        print("[失败] PyInstaller 打包失败，请查看上方日志")
        return 1

    return post_build(onefile=onefile)


if __name__ == "__main__":
    sys.exit(main())
