# DeepSeek 知识问答小助手

一个基于 **Python + PyQt5** 的桌面知识问答小助手：窗口固定 **360 × 640（9:16 竖屏）**，
输入问题后调用 **DeepSeek V4.1 Flash** 模型，以**流式**方式逐字显示回答。

---

## 一、重要提醒：模型名称请按官方文档核对

需求文档中使用的模型名 `deepseek-v4.1-flash` **不是** DeepSeek 官方对外提供的模型名。

经查阅 DeepSeek 官方文档并实测 `/models` 接口确认，当前可用模型为：

| 对外模型名 | 对应版本 | 说明 |
| --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash | 本项目默认使用 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | Pro 版本，价格更高 |

> 官方文档原文：「模型名请使用 `deepseek-flash`。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应模型已下线。」
>
> 参考：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>

因此本项目 **默认使用 `deepseek-flash`**。若官方后续调整命名，只需修改 `.env` 中的
`DEEPSEEK_MODEL`，**无需改动任何代码**。

---

## 二、目录结构

```
deepseek_qa_assistant/
├── main.py            # 程序入口：高 DPI 设置、字体注册、创建 QApplication 与主窗口
├── config.py          # 配置读取：dotenv 加载、模型/思考模式/超时、配置校验
├── worker.py          # QThread 工作线程：流式请求 + 信号回传 + 错误翻译
├── ui.py              # 界面：固定 360x640 布局、流式追加、历史与清空
├── prompts.py         # 系统提示词与界面文案常量
├── selfcheck.py       # 自检脚本：不启动 GUI 也能验证 API 是否连通
├── gui_smoke_test.py  # 冒烟测试：自动验证尺寸/流式/历史/清空等 26 项
├── render_preview.py  # 开发辅助：离屏渲染界面截图（preview.png）
├── build_exe.py       # 一键打包脚本：生成单文件 exe
├── requirements.txt   # 依赖清单
├── .env.example       # 环境变量示例（占位符，不含真实 Key）
├── .env               # 你的真实配置（需自行创建，勿提交到 Git）
├── .gitignore         # 忽略 .env、打包产物与截图
└── README.md          # 本说明文档
```

---

## 三、环境要求

- Python **3.10+**（已在 Python 3.12.3 上验证）
- 操作系统：Windows / macOS / Linux
- 首次使用前请检查依赖是否已安装，避免重复安装：

```bash
python -c "import PyQt5, openai; print('依赖已就绪')"
```

若提示 `ModuleNotFoundError`，再执行下一步安装。

---

## 四、安装依赖

```bash
cd deepseek_qa_assistant
pip install -r requirements.txt
```

如果只需要运行（不需要打包），安装以下三项即可：

```bash
pip install PyQt5 openai python-dotenv
```

---

## 五、配置 .env

1. 复制示例文件：

   Windows (PowerShell)：

   ```powershell
   Copy-Item .env.example .env
   ```

   macOS / Linux：

   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env`，填入你的 API Key（从 <https://platform.deepseek.com/> 获取）：

   ```ini
   DEEPSEEK_API_KEY=sk-你的真实密钥
   DEEPSEEK_BASE_URL=https://api.deepseek.com
   DEEPSEEK_MODEL=deepseek-flash
   DEEPSEEK_THINKING=true
   DEEPSEEK_REASONING_EFFORT=high
   DEEPSEEK_TEMPERATURE=0.4
   DEEPSEEK_TIMEOUT=120
   MAX_HISTORY_ROUNDS=10
   ```

### 配置项说明

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | — | API 密钥，仅从环境变量读取，**不硬编码在源码中** |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | API 服务地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-flash` | 模型名，需按官方文档核对 |
| `DEEPSEEK_THINKING` | 否 | `true` | 思考模式开关（官方默认开启） |
| `DEEPSEEK_REASONING_EFFORT` | 否 | `high` | 思考强度：`low` / `high` / `max` |
| `DEEPSEEK_TEMPERATURE` | 否 | `0.4` | 采样温度，**仅思考模式关闭时生效** |
| `DEEPSEEK_TIMEOUT` | 否 | `120` | 单次请求超时（秒） |
| `MAX_HISTORY_ROUNDS` | 否 | `10` | 保留最近多少轮对话 |

### ⚠ 关于 temperature 的重要说明

DeepSeek 官方文档明确：**思考模式不支持 `temperature` 参数**（传入不会报错，但会被忽略）。

本项目的处理方式：

- `DEEPSEEK_THINKING=true`（默认）：开启思考模式，传递 `reasoning_effort` 与
  `extra_body={"thinking": {"type": "enabled"}}`，**不传递** `temperature`；
- `DEEPSEEK_THINKING=false`：关闭思考模式（`{"thinking": {"type": "disabled"}}`），
  此时 `DEEPSEEK_TEMPERATURE`（默认 0.4）才会真正生效。

这样既符合官方文档，也能让「响应更快」与「回答更准」两种模式自由切换。

---

## 六、运行

### 1. 先自检（推荐）

不启动图形界面即可验证配置与网络：

```bash
python selfcheck.py
```

正常输出示例：

```
[通过] 配置校验无误
[通过] 可用模型：['deepseek-flash', 'deepseek-v4-pro']
开始流式请求……
[通过] 流式接口工作正常
```

### 2. 启动图形界面

```bash
python main.py
```

---

## 七、界面与操作说明

窗口固定 **360 × 640**，比例 **9:16**，不可调整大小。

| 区域 | 内容 |
| --- | --- |
| 顶部 | 标题「知识问答小助手」+ 状态标签（就绪 / 思考中 / 回答中 / 错误 / 已停止）+「显示思考过程」开关 |
| 中部 | 对话显示区（只读，自动滚动到底部） |
| 底部 | 输入框 + 发送按钮 + 清空按钮 |

操作方式：

- **Enter** —— 发送问题
- **Shift + Enter** —— 输入框内换行
- **发送 / 停止** —— 生成过程中按钮变为「停止」，点击可中断本次生成
- **清空** —— 重置对话历史与界面
- **显示思考过程** —— 勾选后在回答上方以灰色样式显示模型思维链，**默认不显示**

其他行为：

- 对话区中用户消息以蓝色「你：」开头，助手消息以绿色「助手：」开头；
- 流式输出逐段追加并自动滚动到底部；
- 生成期间发送按钮不会被误触发送，生成结束后自动恢复；
- 缺少 API Key 时启动会弹窗提示，**程序不会崩溃**。

---

## 八、错误处理

| 情况 | 提示文案 |
| --- | --- |
| 缺少 API Key | 未配置 API Key，请检查 .env |
| 429 限流 | 请求过于频繁，请稍后重试 |
| 请求超时 | 请求超时，请检查网络后重试 |
| 网络异常 / 连接失败 | 网络异常，请检查网络后重试 |
| Key 无效 | API Key 无效或已过期，请检查 .env 中的 DEEPSEEK_API_KEY |
| 余额不足 | 账户余额不足，请前往 DeepSeek 平台充值 |
| 模型名错误 | 模型名 xxx 不可用，请按官方文档修改 .env 中的 DEEPSEEK_MODEL |

任何异常都会被捕获并通过状态栏 + 对话区提示，**不会导致程序崩溃**。
若生成中途出错，已经显示的部分内容仍会保留在对话历史中。

---

## 九、对话历史管理

- 历史以 `messages` 列表维护，首条固定为 `system` 提示词；
- 用户提问后追加 `user` 消息，回答完成后追加 `assistant` 消息；
- 请求时向工作线程传入**历史副本**，避免线程与界面同时修改同一列表；
- 每轮结束后自动截断为 **system + 最近 10 轮**（可在 `.env` 中用
  `MAX_HISTORY_ROUNDS` 调整），防止 token 消耗过大。

---

## 十、打包为 exe

### 一键打包（推荐）

```bash
pip install pyinstaller
python build_exe.py              # 默认：文件夹模式（onedir，推荐）
python build_exe.py --onefile    # 单文件模式（onefile）
python build_exe.py --console    # 保留控制台窗口，便于看报错
```

脚本会自动完成：环境检查 → 清理旧产物 → 调用 PyInstaller → 复制 `.env` 到产物目录。

### 产物结构

**默认的文件夹模式（onedir）：**

```
dist/知识问答小助手/
├── 知识问答小助手.exe    # 双击运行（8.6 MB）
├── _internal/            # 运行时依赖，不可删除
├── .env                  # 外部配置（脚本自动从项目根目录复制）
├── 启动日志.log          # 启动时自动生成
└── 自检报告.log          # 运行 --selfcheck 后生成
```

**单文件模式（onefile）：**

```
dist/知识问答小助手.exe   # 单文件（约 50 MB）
```

### onedir 与 onefile 如何选择

| | onedir（默认） | onefile |
| --- | --- | --- |
| 分发形态 | 一个文件夹 | 单个 exe |
| 启动速度 | 快 | 慢（每次启动需解包约 50 MB） |
| 稳定性 | 高 | 受临时目录权限影响 |
| 适用场景 | 本机使用、受限环境 | 需要单文件分发 |

> **为什么默认用 onedir？**
> onefile 每次启动都要把内容解包到系统临时目录。若临时目录被安全软件、
> 沙箱或权限策略限制，会出现「双击没反应」的静默崩溃。
> onedir 不需要运行时解包，因此更稳定。若你确实需要单文件，
> 用 `--onefile` 即可，并在真机上双击验证一次。

### 手动执行 PyInstaller 命令

```bash
# 文件夹模式
pyinstaller -w --name 知识问答小助手 --add-data ".env.example;." main.py

# 单文件模式
pyinstaller -F -w --name 知识问答小助手 --add-data ".env.example;." main.py
```

| 参数 | 作用 |
| --- | --- |
| `-F` / `--onefile` | 打成单个 exe 文件 |
| `-D` / `--onedir`（默认） | 打成文件夹形态 |
| `-w` / `--windowed` | 不显示黑色控制台窗口 |
| `--name` | 指定程序名称 |
| `--add-data ".env.example;."` | 把配置模板打进包内（Windows 用 `;` 分隔，Linux/macOS 用 `:`） |

### exe 的配置读取机制（重要）

`config.py` 会按以下优先级查找 `.env`：

1. 环境变量 `DEEPSEEK_ENV_FILE` 指定的路径（绿色版/多配置切换用）；
2. **exe 同级目录** 的 `.env` ← 打包分发时使用这个；
3. 当前工作目录的 `.env`；
4. 打包内部资源目录（仅兜底，**不建议**把密钥打进 exe）。

因为打包后代码可能被解包到临时目录，所以 `.env` **必须放在 exe 外部**。
程序的处理方式：

- 首次运行 exe 时，若同级目录没有 `.env`，会自动用包内的 `.env.example`
  生成一份 `.env`（实测日志：`[提示] 已生成配置文件：...\知识问答小助手\.env`）；
- 修改 `.env` 后需要**重新启动** exe 才会生效；
- 也可以通过系统环境变量直接设置 `DEEPSEEK_API_KEY`（优先级高于 `.env`）。

### exe 的三种运行方式

```powershell
.\知识问答小助手.exe               # 启动图形界面
.\知识问答小助手.exe --selfcheck   # 无界面自检，检查配置与 API 连通性
.\知识问答小助手.exe --version     # 查看版本
```

### ⚠ 排错：exe 双击没反应怎么办

`--windowed` 模式没有控制台，`print` 的内容会被系统丢弃。因此程序在打包环境下
会把诊断信息写入 **exe 同级目录的 `启动日志.log`**：

```
[2026-09-18 16:31:02] ===== 启动 知识问答小助手 1.0.0 =====
[2026-09-18 16:31:02] 打包运行：True
[2026-09-18 16:31:02] 配置文件：...\dist\知识问答小助手\.env
[2026-09-18 16:31:02] [配置] 模型=deepseek-flash | APIKey=已配置 | 思考模式=开启（effort=high）
[2026-09-18 16:31:06] 主窗口已显示，进入事件循环
```

`--selfcheck` 的完整结果写入 **`自检报告.log`**，包含可用模型列表、
回答内容与思维链字数。

**如果连 `启动日志.log` 都没有生成**，说明程序在 Python 代码执行前就崩溃了，
通常是打包引导层问题（例如 onefile 无法解包到临时目录）。此时：

1. 改用文件夹模式重新打包：`python build_exe.py`；
2. 用 `python build_exe.py --console` 打包，双击后可直接看到报错文本；
3. 检查安全软件是否拦截了程序运行。

**如果报错 `Failed to load Python DLL '...\build\知识问答小助手\_internal\python312.dll'`：**

说明运行的是 `build/` 目录里的**中间产物**，不是最终程序。

- `build/` 是 PyInstaller 的临时工作目录，里面的同名 exe **缺少 `_internal` 依赖，无法运行**；
- 正确的程序在 **`dist/知识问答小助手/知识问答小助手.exe`**；
- `build_exe.py` 在打包成功后会自动删除 `build/`，以避免误点；
- 若 `build/` 删除失败，通常是上一次的 exe 还在运行（含报错弹窗）锁住了文件，
  关闭后重新执行 `python build_exe.py` 即可。

另外建议**不要**把真实 `.env` 提交到 Git 或随 exe 一起分发——
一旦密钥随程序外泄，需立即到 DeepSeek 平台吊销。

---

## 十一、测试清单

项目自带一个自动化冒烟测试脚本，会以离屏方式启动界面并真实调用一次 API：

```bash
python gui_smoke_test.py
```

共 26 项检查，全部通过时输出 `失败 0 项` 并以退出码 0 结束。覆盖范围：

| 检查分组 | 覆盖内容 |
| --- | --- |
| 窗口尺寸 | 固定 360×640、9:16 比例、不可调整大小 |
| 初始状态 | 状态栏为「就绪」、历史仅含 system |
| 历史截断 | 12 轮裁剪为 system + 10 轮且保留最新一轮 |
| 流式问答 | 按钮变「停止」、超时前完成、历史落库 assistant |
| 渲染 | 「你：」「助手：」前缀、正文片段、自动滚动到底部 |
| 思考过程 | 思维链已累积、开关打开显示 / 关闭隐藏 |
| 清空 | 历史重置、输入框清空、旧内容消失 |

> 该脚本使用离屏渲染（`QT_QPA_PLATFORM=offscreen`），不会弹出真实窗口，
> 但会消耗一次真实的 API 调用额度。

如需人工核对界面外观，可运行：

```bash
python render_preview.py
```

它会注入一段模拟问答并生成 `preview.png`（360×640）供查看。

### 手工测试清单

| 测试项 | 预期结果 |
| --- | --- |
| 窗口比例 | 固定 360 × 640，无法拉伸，9:16 |
| 流式输出 | 回答逐段出现，自动滚动到底部 |
| Enter / Shift+Enter | Enter 发送，Shift+Enter 换行 |
| 多轮历史 | 上一轮内容被正确带入上下文 |
| 清空 | 历史与界面重置，system 提示词保留 |
| 缺少 Key | 启动弹窗提示，不崩溃 |
| 错误提示 | 限流/超时/网络异常均有中文提示 |
| 打包 | `pyinstaller -F -w main.py` 生成可执行文件并可从外部 .env 读取配置 |

---

## 十二、安全说明

- API Key **只从环境变量 / `.env` 读取**，源码中不含任何真实密钥；
- `.env.example` 仅包含占位符，可安全分享；
- 请将 `.env` 加入 `.gitignore`，避免误提交：

  ```gitignore
  .env
  __pycache__/
  dist/
  build/
  *.spec
  ```

- 本文档与示例代码中均不包含真实密钥。

---

## 十三、常见问题

**Q：提示「未配置 API Key，请检查 .env」？**
A：确认 `.env` 与 `main.py` 在同一目录，且已把示例占位符替换为真实 Key。

**Q：提示「模型名 xxx 不可用」？**
A：请按官方文档核对模型名，当前应使用 `deepseek-flash`。

**Q：设置了 `DEEPSEEK_TEMPERATURE` 但没有效果？**
A：思考模式下 `temperature` 会被官方忽略。如需让温度生效，请设置
`DEEPSEEK_THINKING=false`。

**Q：回答很慢？**
A：思考模式默认开启且强度为 `high`。可在 `.env` 中设置
`DEEPSEEK_THINKING=false`，或将 `DEEPSEEK_REASONING_EFFORT` 调为 `low`。

**Q：界面中文显示为方块？**
A：系统缺少中文字体。Windows / macOS 通常自带；Linux 可安装
`fonts-noto-cjk` 或 `wqy-zenhei`。
