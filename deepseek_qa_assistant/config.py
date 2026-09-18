# -*- coding: utf-8 -*-
"""配置读取模块。

职责：
    1. 使用 python-dotenv 从项目根目录的 .env 文件加载环境变量；
    2. 暴露统一的配置常量（API Key / Base URL / 模型名 / 思考模式等）；
    3. 提供配置校验函数，缺少 API Key 时返回友好提示而不是直接崩溃。

安全约定：
    API Key 只从环境变量读取，绝不硬编码在源码中。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 加载 .env 文件
# ---------------------------------------------------------------------------
# load_dotenv 在 python-dotenv 缺失时不应导致整个程序无法启动，
# 因此这里做了容错处理：没有该库时退化为「纯环境变量」模式。
try:
    from dotenv import load_dotenv

    _DOTENV_AVAILABLE = True
except ImportError:  # pragma: no cover - 仅在未安装依赖时触发
    _DOTENV_AVAILABLE = False

# 是否运行在 PyInstaller 打包后的环境中
IS_FROZEN = bool(getattr(sys, "frozen", False))

# 应用资源目录：
#   * 源码运行 -> 本文件所在目录
#   * 打包运行 -> exe 所在目录（用于读写用户配置）
if IS_FROZEN:
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent

# 兼容旧命名（源码运行时二者相同）
BASE_DIR = APP_DIR

# 打包内部资源目录（--add-data 的内容会被解包到这里）
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))


def candidate_env_files() -> list:
    """返回按优先级排列的 .env 查找路径。

    优先级说明：
        1. 环境变量 DEEPSEEK_ENV_FILE 显式指定 —— 便于绿色版/多配置切换；
        2. exe（或项目）同级目录 —— 打包分发时用户编辑的就是这个文件；
        3. 当前工作目录 —— 从其他目录启动时仍能找到项目配置；
        4. 打包内部资源目录 —— 仅作为兜底（不建议把密钥打进 exe）。
    """
    candidates = []

    explicit = os.getenv("DEEPSEEK_ENV_FILE", "").strip()
    if explicit:
        candidates.append(Path(explicit).expanduser())

    candidates.append(APP_DIR / ".env")

    try:
        cwd = Path.cwd()
        if cwd != APP_DIR:
            candidates.append(cwd / ".env")
    except OSError:  # pragma: no cover - 极端环境下的兜底
        pass

    if BUNDLE_DIR != APP_DIR:
        candidates.append(BUNDLE_DIR / ".env")

    return candidates


def resolve_env_file() -> Path:
    """返回实际存在且将被加载的 .env 路径；都不存在时返回首选路径。"""
    candidates = candidate_env_files()
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


# 实际生效的 .env 路径（用于界面提示与自检输出）
ENV_FILE = resolve_env_file()

if _DOTENV_AVAILABLE:
    # override=False：已存在的系统环境变量优先，避免 .env 覆盖真实环境
    load_dotenv(dotenv_path=ENV_FILE, override=False)


def prepare_env_file() -> str:
    """确保 exe / 项目同级目录下存在 .env 文件。

    打包分发场景：首次运行 exe 时，若同级目录没有 .env，
    就用随包附带的 .env.example 复制一份出来，方便用户直接填写。

    返回提示信息；无需处理时返回空字符串。
    """
    target = APP_DIR / ".env"
    if target.is_file():
        return ""

    # 依次寻找可用的模板文件
    templates = [APP_DIR / ".env.example", BUNDLE_DIR / ".env.example"]
    for template in templates:
        if template.is_file():
            try:
                target.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
            except OSError:
                # 目录只读（例如装在 Program Files）时无法写入，交给上层提示
                return (
                    f"未找到 .env，且无法在 {APP_DIR} 创建。\n"
                    f"请手动把 .env.example 复制为 .env 并填入 API Key。"
                )
            return f"已生成配置文件：{target}\n请填入你的 DEEPSEEK_API_KEY 后重新启动。"

    return (
        f"未找到 .env 配置文件。\n"
        f"请在 {APP_DIR} 下创建 .env 并填入 DEEPSEEK_API_KEY，"
        f"或设置系统环境变量 DEEPSEEK_API_KEY。"
    )


def _get_str(name: str, default: str = "") -> str:
    """读取字符串型环境变量，并去除首尾空白。"""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip()


def _get_bool(name: str, default: bool) -> bool:
    """读取布尔型环境变量，兼容 true/1/yes/on 等写法。"""
    raw = _get_str(name, "").lower()
    if raw == "":
        return default
    return raw in ("1", "true", "yes", "y", "on", "enabled")


def _get_float(name: str, default: float) -> float:
    """读取浮点型环境变量，解析失败时回退到默认值。"""
    raw = _get_str(name, "")
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _get_int(name: str, default: int) -> int:
    """读取整型环境变量，解析失败时回退到默认值。"""
    raw = _get_str(name, "")
    if raw == "":
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# 对外配置常量
# ---------------------------------------------------------------------------

# 【必填】DeepSeek API Key
API_KEY: str = _get_str("DEEPSEEK_API_KEY", "")

# 【可选】API 服务地址
BASE_URL: str = _get_str("DEEPSEEK_BASE_URL", "https://api.deepseek.com") or (
    "https://api.deepseek.com"
)

# 【可选】模型名称。
# 重要：DeepSeek 官方对「DeepSeek-V4.1-Flash」对外提供的模型名是 deepseek-flash。
#       需求文档中写的 deepseek-v4.1-flash 并非官方可用模型名，
#       因此这里默认使用官方文档确认过的 deepseek-flash。
#       若官方后续更名，请直接修改 .env 中的 DEEPSEEK_MODEL，无需改代码。
#       参考：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
MODEL: str = _get_str("DEEPSEEK_MODEL", "deepseek-flash") or "deepseek-flash"

# 【可选】思考模式开关（DeepSeek 默认开启思考模式）
THINKING_ENABLED: bool = _get_bool("DEEPSEEK_THINKING", True)

# 【可选】思考强度：low / high / max，默认 high
REASONING_EFFORT: str = _get_str("DEEPSEEK_REASONING_EFFORT", "high") or "high"

# 【可选】采样温度；注意思考模式下该参数不生效（官方说明：不报错但被忽略）
TEMPERATURE: float = _get_float("DEEPSEEK_TEMPERATURE", 0.4)

# 【可选】单次请求超时（秒）
TIMEOUT: int = _get_int("DEEPSEEK_TIMEOUT", 120)

# 【可选】对话历史保留的轮数（1 轮 = 一问一答）
MAX_HISTORY_ROUNDS: int = _get_int("MAX_HISTORY_ROUNDS", 10)

# 允许的思考强度取值，用于非法值兜底
_VALID_EFFORTS = ("low", "high", "max")
if REASONING_EFFORT not in _VALID_EFFORTS:
    REASONING_EFFORT = "high"

# 采样温度做合法的范围裁剪
if TEMPERATURE < 0.0:
    TEMPERATURE = 0.0
elif TEMPERATURE > 2.0:
    TEMPERATURE = 2.0

# 超时时间兜底，避免设置成 0 或负数导致请求立即失败
if TIMEOUT <= 0:
    TIMEOUT = 120


# ---------------------------------------------------------------------------
# 配置校验
# ---------------------------------------------------------------------------

def has_api_key() -> bool:
    """判断是否已配置可用的 API Key。

    占位符（例如 .env.example 里的示例值）会被视为「未配置」。
    """
    if not API_KEY:
        return False
    # 明显的占位符直接判为无效，避免用户忘记替换就运行
    lowered = API_KEY.lower()
    if "在此填入" in API_KEY or "your" in lowered or "xxxx" in lowered:
        return False
    # 真实 Key 通常以 sk- 开头且长度较长
    return len(API_KEY) >= 16


def get_config_error() -> str:
    """返回配置错误提示；配置正常时返回空字符串。"""
    if not _DOTENV_AVAILABLE:
        return "未安装 python-dotenv，请先执行：pip install python-dotenv"
    if not has_api_key():
        if not ENV_FILE.exists():
            return "未找到 .env 文件，请复制 .env.example 为 .env 并填入 API Key"
        return "未配置 API Key，请检查 .env"
    return ""


def describe() -> str:
    """返回当前配置的可读描述，便于日志排查（不包含密钥明文）。"""
    masked = "已配置" if has_api_key() else "未配置"
    thinking = (
        f"开启（effort={REASONING_EFFORT}）" if THINKING_ENABLED else "关闭"
    )
    return (
        f"模型={MODEL} | 地址={BASE_URL} | APIKey={masked} | "
        f"思考模式={thinking} | 温度={TEMPERATURE} | 超时={TIMEOUT}s"
    )
