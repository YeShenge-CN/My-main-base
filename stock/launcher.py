"""
A股量化分析系统 —— 一键启动器
====================================
双击生成的 exe 即可自动完成：
  1. 定位项目目录（app.py / .venv）
  2. 选择可用的 Python 解释器（优先项目内 .venv）
  3. 检查 streamlit 等依赖是否齐全
  4. 启动 streamlit 服务并自动打开浏览器

只依赖 Python 标准库，方便被 PyInstaller 打包成单文件 exe。
"""

import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

PORT = 8501
APP_NAME = "A股量化分析系统"
REQUIRED_MODULES = ["streamlit", "pandas", "numpy", "plotly", "sklearn", "yfinance"]


def _init_console() -> None:
    """让 Windows 控制台按 UTF-8 输出，避免中文乱码。"""
    try:
        if os.name == "nt":
            os.system("chcp 65001 > nul")
    except OSError:
        pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


_init_console()

BANNER = r"""
  ___     _____ _   _   ___  _   _ _____ _____
 / _ \   |  _  | | | | / _ \| | | |_   _|_   _|
/ /_\ \  | | | | |_| |/ /_\ \ |_| | | |   | |
|  _  |  | | | |  _  ||  _  |  _  | | |   | |
| | | |  \_/ /| | | || | | | | | |_| |_  | |
\_| |_/  \___/ \_| |_/\_| |_/\_| |_/\___/  \_/

        A股量化分析系统 · 一键启动器
"""


def log(msg: str = "") -> None:
    print(msg, flush=True)


def step(msg: str) -> None:
    print(f"[*] {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"[OK] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[!] {msg}", flush=True)


def pause_and_exit(code: int = 1) -> None:
    """出错时暂停，避免双击运行时窗口一闪而过看不到原因。"""
    log()
    input("按回车键退出...")
    sys.exit(code)


def _looks_like_project(base: Path) -> bool:
    """目录中包含 app.py 就认为是项目根目录。"""
    try:
        return (base / "app.py").is_file()
    except OSError:
        return False


def project_dir() -> Path:
    """定位项目目录：exe / 脚本所在目录，找不到就逐级向上查找。"""
    bases = []
    if getattr(sys, "frozen", False):
        # 打包成 exe 后，以 exe 所在目录为基准
        bases.append(Path(sys.executable).resolve().parent)
    if "__file__" in globals():
        bases.append(Path(__file__).resolve().parent)
    if sys.argv and sys.argv[0]:
        bases.append(Path(sys.argv[0]).resolve().parent)
    bases.append(Path.cwd())

    # 1) 基准目录自身
    for base in bases:
        if _looks_like_project(base):
            return base

    # 2) 逐级向上查找（支持 exe 放在 dist\ 子目录的情况）
    for base in bases:
        for parent in list(base.parents)[:4]:
            if _looks_like_project(parent):
                return parent

    # 没找到就回退到 exe 所在目录，后续给出明确报错
    return bases[0]


def find_python(root: Path):
    """按优先级找出可用的、带 streamlit 的 Python 解释器。"""
    tried = []
    candidates = []

    # 1) 项目自带虚拟环境（最推荐，依赖最全）
    for rel in ("Scripts/python.exe", "bin/python"):
        candidates.append(root / ".venv" / rel)

    # 2) 当前解释器（打包后一般不可用，但源码运行时可用）
    if not getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable))

    # 3) PATH 中的 python / py
    for name in ("python", "python3", "py"):
        candidates.append(name)

    for cand in candidates:
        exe = str(cand)
        if isinstance(cand, Path) and not cand.is_file():
            continue
        tried.append(exe)
        try:
            probe = subprocess.run(
                [exe, "-c", "import streamlit, pandas, plotly, sklearn, yfinance"],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            tried.append(f"{exe} -> {exc}")
            continue
        if probe.returncode == 0:
            return exe, tried

    return None, tried


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.6)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def pick_port(start: int) -> int:
    for port in range(start, start + 20):
        if not port_in_use(port):
            return port
    return start


def wait_for_server(port: int, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_in_use(port):
            return True
        time.sleep(0.4)
    return False


def check_modules(python_exe: str, missing_hint: bool = True):
    """返回缺失的依赖列表。"""
    script = (
        "import importlib.util as u;"
        f"mods={REQUIRED_MODULES!r};"
        "print(','.join(m for m in mods if u.find_spec(m) is None))"
    )
    try:
        res = subprocess.run(
            [python_exe, "-c", script], capture_output=True, text=True, timeout=120
        )
    except (OSError, subprocess.SubprocessError):
        return []
    out = (res.stdout or "").strip()
    return [m for m in out.split(",") if m]


def main() -> int:
    log(BANNER)

    root = project_dir()
    app_path = root / "app.py"
    step(f"项目目录: {root}")

    if not app_path.is_file():
        warn(f"未找到 app.py，请把本程序放在项目根目录（与 app.py 同级）。")
        pause_and_exit(1)
    ok(f"找到入口文件: {app_path.name}")

    step("正在查找可用的 Python 环境...")
    python_exe, tried = find_python(root)
    if not python_exe:
        warn("没有找到包含所需依赖的 Python 环境。已尝试：")
        for item in tried:
            log(f"      - {item}")
        log()
        log("解决办法（任选其一）：")
        log("  1) 在项目目录执行: .venv\\Scripts\\python.exe -m pip install -r requirements.txt")
        log("  2) 安装 Python 3.10+ 后执行: pip install -r requirements.txt")
        pause_and_exit(1)
    ok(f"使用解释器: {python_exe}")

    missing = check_modules(python_exe)
    if missing:
        warn(f"缺少依赖: {', '.join(missing)}")
        log(f"请执行: \"{python_exe}\" -m pip install -r requirements.txt")
        pause_and_exit(1)

    port = pick_port(PORT)
    if port != PORT:
        warn(f"端口 {PORT} 被占用，改用 {port}")

    url = f"http://localhost:{port}"
    step(f"正在启动 {APP_NAME} ...")
    log(f"     访问地址: {url}")
    log("     停止服务: 在本窗口按 Ctrl+C")
    log()

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["STREAMLIT_BROWSER_GATHER_USAGE_STATS"] = "false"
    env["STREAMLIT_SERVER_HEADLESS"] = "true"   # 由启动器负责开浏览器
    env["BROWSER"] = "none"
    # 避免在含中文的路径下出现代理/编码问题
    env.pop("PYTHONHOME", None)

    cmd = [
        python_exe,
        "-m",
        "streamlit",
        "run",
        str(app_path),
        "--server.port",
        str(port),
        "--server.address",
        "127.0.0.1",
        "--browser.gatherUsageStats",
        "false",
    ]

    try:
        proc = subprocess.Popen(cmd, cwd=str(root), env=env)
    except OSError as exc:
        warn(f"启动失败: {exc}")
        pause_and_exit(1)

    if wait_for_server(port, timeout=90):
        ok("服务已就绪，正在打开浏览器...")
        webbrowser.open(url)
    else:
        warn("服务启动较慢或未就绪，请手动在浏览器打开上面的地址。")

    try:
        proc.wait()
    except KeyboardInterrupt:
        log()
        step("收到停止指令，正在关闭服务...")
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        ok("服务已关闭。")

    log()
    log("程序已退出。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - 兜底，双击运行时给出可读报错
        warn(f"发生未预期的错误: {exc}")
        pause_and_exit(1)
