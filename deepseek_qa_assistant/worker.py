# -*- coding: utf-8 -*-
"""后台工作线程模块。

职责：
    在独立的 QThread 中完成 DeepSeek API 的流式请求，
    通过 pyqtSignal 与主线程（UI）通信，避免网络阻塞界面。

信号约定：
    chunk_received(str)  —— 流式正文片段（增量）
    reasoning_received(str) —— 流式思维链片段（增量，可选显示）
    finished(str)        —— 完整回答文本
    error(str)           —— 友好的错误提示
"""

from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

from PyQt5.QtCore import QThread, pyqtSignal

import config
from prompts import (
    ERR_NETWORK,
    ERR_RATE_LIMIT,
    ERR_TIMEOUT,
    ERR_UNKNOWN,
)


class StreamWorker(QThread):
    """执行一次流式对话请求的工作线程。

    使用方式：
        worker = StreamWorker(messages)
        worker.chunk_received.connect(on_chunk)
        worker.finished.connect(on_finished)
        worker.error.connect(on_error)
        worker.start()
    """

    # ---- 信号定义 ----
    chunk_received = pyqtSignal(str)
    reasoning_received = pyqtSignal(str)
    finished = pyqtSignal(str)
    error = pyqtSignal(str)

    def __init__(
        self,
        messages: List[Dict[str, Any]],
        parent: Optional[Any] = None,
    ) -> None:
        """初始化工作线程。

        参数：
            messages: 发送给 API 的完整消息列表（调用方需传入副本）。
            parent:   Qt 父对象，可为 None。
        """
        super().__init__(parent)
        # 使用 list(...) 做浅拷贝，避免主线程修改历史时影响正在进行的请求
        self._messages: List[Dict[str, Any]] = [dict(m) for m in messages]

        # 用于支持「停止生成」：外部调用 stop() 时置位
        self._cancel_event = threading.Event()

    # ------------------------------------------------------------------
    # 对外控制接口
    # ------------------------------------------------------------------
    def stop(self) -> None:
        """请求停止本次流式生成。

        注意：这里只是设置取消标志，真正的网络连接会在下一次
        chunk 到达时被检测到并主动关闭，因此停止是「尽快」而非「立即」。
        """
        self._cancel_event.set()

    # ------------------------------------------------------------------
    # 内部工具方法
    # ------------------------------------------------------------------
    def _build_request_kwargs(self) -> Dict[str, Any]:
        """构造 chat.completions.create 的参数字典。

        关键点（依据 DeepSeek 官方文档）：
            * 思考模式通过 extra_body={"thinking": {"type": "enabled"}} 开启；
            * 思考模式下 temperature 不生效（传了不报错但被忽略），
              因此仅在非思考模式下才传递 temperature，避免误导；
            * reasoning_effort 仅在思考模式下有意义。
        """
        kwargs: Dict[str, Any] = {
            "model": config.MODEL,
            "messages": self._messages,
            "stream": True,
            "timeout": config.TIMEOUT,
        }

        if config.THINKING_ENABLED:
            # 思考模式：开启思维链 + 思考强度
            kwargs["reasoning_effort"] = config.REASONING_EFFORT
            kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
        else:
            # 非思考模式：显式关闭思考，并启用温度采样
            kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            kwargs["temperature"] = config.TEMPERATURE

        return kwargs

    @staticmethod
    def _friendly_error(exc: Exception) -> str:
        """把底层异常翻译成用户能看懂的中文提示。"""
        # 部分异常类型可能因 SDK 版本不同而不同，这里按类名/文本判断更稳
        name = type(exc).__name__
        text = str(exc)
        lowered = text.lower()

        # 限流
        if "429" in text or "rate limit" in lowered or "ratelimit" in name.lower():
            return ERR_RATE_LIMIT

        # 超时
        if "timeout" in lowered or "timed out" in lowered or "Timeout" in name:
            return ERR_TIMEOUT

        # 认证失败
        if (
            "401" in text
            or "invalid api key" in lowered
            or "authentication" in lowered
            or "unauthorized" in lowered
        ):
            return "API Key 无效或已过期，请检查 .env 中的 DEEPSEEK_API_KEY"

        # 余额不足
        if "402" in text or "insufficient balance" in lowered:
            return "账户余额不足，请前往 DeepSeek 平台充值"

        # 模型名错误
        if "404" in text or "model not found" in lowered or "does not exist" in lowered:
            return (
                f"模型名 {config.MODEL} 不可用，"
                "请按官方文档修改 .env 中的 DEEPSEEK_MODEL"
            )

        # 网络类问题（DNS / 连接失败 / TLS 等）
        network_hints = (
            "connection",
            "connect",
            "network",
            "getaddrinfo",
            "ssl",
            "proxy",
            "unreachable",
            "reset by peer",
        )
        if any(h in lowered for h in network_hints):
            return ERR_NETWORK

        # 兜底：给出简短错误，且限制长度避免刷屏
        brief = text.strip().replace("\n", " ")
        if len(brief) > 160:
            brief = brief[:160] + "..."
        return f"{ERR_UNKNOWN}：{brief}" if brief else ERR_UNKNOWN

    # ------------------------------------------------------------------
    # 线程主逻辑
    # ------------------------------------------------------------------
    def run(self) -> None:  # noqa: C901 - 流式解析逻辑集中在此，保持可读性
        """线程入口：执行流式请求并逐段发出信号。"""
        # 延迟导入：让缺少 openai 依赖时也能给出清晰提示
        try:
            from openai import OpenAI
        except ImportError:
            self.error.emit("未安装 openai，请先执行：pip install openai")
            return

        if not config.has_api_key():
            self.error.emit("未配置 API Key，请检查 .env")
            return

        client = OpenAI(
            api_key=config.API_KEY,
            base_url=config.BASE_URL,
        )

        full_content_parts: List[str] = []
        stream = None

        try:
            stream = client.chat.completions.create(**self._build_request_kwargs())

            for chunk in stream:
                # 用户点击「停止」后立刻中断读取
                if self._cancel_event.is_set():
                    break

                # 某些心跳/用量 chunk 的 choices 可能为空，需要防御性判断
                if not getattr(chunk, "choices", None):
                    continue

                delta = chunk.choices[0].delta
                if delta is None:
                    continue

                # ---- 思维链片段（思考模式下才有）----
                # 使用 getattr 兼容不同 SDK 版本的字段缺失
                reasoning_piece = getattr(delta, "reasoning_content", None)
                if reasoning_piece:
                    self.reasoning_received.emit(reasoning_piece)

                # ---- 正文片段 ----
                content_piece = getattr(delta, "content", None)
                if content_piece:
                    full_content_parts.append(content_piece)
                    self.chunk_received.emit(content_piece)

            full_content = "".join(full_content_parts)

            # 正常结束（含用户主动停止）：把已生成的内容交回主线程入库
            self.finished.emit(full_content)

        except Exception as exc:  # noqa: BLE001 - 需要兜住所有异常避免线程崩溃
            # 若已经产出部分内容，先把这部分内容落库，再报告错误，
            # 避免用户已经看到的文字在历史中丢失。
            partial = "".join(full_content_parts)
            if partial:
                self.finished.emit(partial)
            self.error.emit(self._friendly_error(exc))

        finally:
            # 主动关闭 HTTP 流，释放连接
            if stream is not None:
                close = getattr(stream, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:  # noqa: BLE001 - 关闭失败无需打扰用户
                        pass
