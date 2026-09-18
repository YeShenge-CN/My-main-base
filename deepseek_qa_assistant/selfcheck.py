# -*- coding: utf-8 -*-
"""API 连通性自测脚本（不依赖 PyQt5）。

用途：
    在启动图形界面之前，先确认 .env 配置、模型名与流式接口是否正常。

运行：
    python selfcheck.py
"""

from __future__ import annotations

import sys

import config


def _emit(message: str = "") -> None:
    """输出一行诊断信息。

    打包为 --windowed 的 exe 没有控制台，print 的内容会被系统丢弃。
    因此这里在打包环境下把信息追加写入 exe 同级目录的 selfcheck 报告文件，
    使「无界面自检」在 exe 中依然可用。
    """
    print(message)

    if not getattr(sys, "frozen", False):
        return

    try:
        from datetime import datetime
        from pathlib import Path

        report = Path(sys.executable).resolve().parent / "自检报告.log"
        with open(report, "a", encoding="utf-8") as handle:
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            handle.write(f"[{stamp}] {message}\n")
    except Exception:  # noqa: BLE001 - 写日志失败不影响自检
        pass


def main() -> int:
    _emit("=" * 60)
    _emit("DeepSeek 知识问答小助手 —— 配置自检")
    _emit("=" * 60)
    _emit(f".env 路径 : {config.ENV_FILE}  存在={config.ENV_FILE.exists()}")
    _emit(f"配置摘要  : {config.describe()}")

    error = config.get_config_error()
    if error:
        _emit(f"[失败] {error}")
        return 1
    _emit("[通过] 配置校验无误")

    try:
        from openai import OpenAI
    except ImportError:
        _emit("[失败] 未安装 openai，请执行：pip install openai")
        return 1

    client = OpenAI(api_key=config.API_KEY, base_url=config.BASE_URL)

    # ---- 1. 模型列表 ----
    try:
        models = [m.id for m in client.models.list().data]
        _emit(f"[通过] 可用模型：{models}")
    except Exception as exc:  # noqa: BLE001
        _emit(f"[失败] 获取模型列表失败：{type(exc).__name__}: {exc}")
        return 1

    if config.MODEL not in models:
        _emit(f"[警告] 配置的模型 {config.MODEL} 不在可用列表中，请核对官方文档")

    # ---- 2. 流式对话 ----
    kwargs = {
        "model": config.MODEL,
        "messages": [
            {"role": "system", "content": "你是一位严谨的知识问答助手。"},
            {"role": "user", "content": "用一句话说明什么是光合作用。"},
        ],
        "stream": True,
        "timeout": config.TIMEOUT,
    }
    if config.THINKING_ENABLED:
        kwargs["reasoning_effort"] = config.REASONING_EFFORT
        kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
    else:
        kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
        kwargs["temperature"] = config.TEMPERATURE

    _emit("-" * 60)
    _emit("开始流式请求……")
    reasoning_len = 0
    content_parts = []

    try:
        stream = client.chat.completions.create(**kwargs)
        for chunk in stream:
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue
            piece = getattr(delta, "reasoning_content", None)
            if piece:
                reasoning_len += len(piece)
            text = getattr(delta, "content", None)
            if text:
                content_parts.append(text)
    except Exception as exc:  # noqa: BLE001
        _emit(f"[失败] 流式请求出错：{type(exc).__name__}: {exc}")
        return 1

    answer = "".join(content_parts)
    _emit("-" * 60)
    _emit(f"回答内容：{answer}")
    _emit(f"思维链共 {reasoning_len} 字；正文共 {len(answer)} 字")
    if not answer.strip():
        _emit("[失败] 正文为空")
        return 1
    _emit("[通过] 流式接口工作正常")
    _emit("[完成] 自检全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
