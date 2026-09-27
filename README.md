# My-main-base

个人项目主仓库，用于汇总和备份各类练习与课程项目。

## 内容

| 目录 | 说明 |
| --- | --- |
| [`School Trade/`](School%20Trade/) | 校园二手交易平台，Django + MySQL 的课程项目，含一键启动器 |
| [`stock/`](stock/) | A股量化分析系统，Streamlit + 双均线策略 + 随机森林预测，含一键启动器 |
| [`神秘音乐编辑小网站/`](%E7%A5%9E%E7%A7%98%E9%9F%B3%E4%B9%90%E7%BC%96%E8%BE%91%E5%B0%8F%E7%BD%91%E7%AB%99/) | 音乐旋律编辑器，单文件纯前端（HTML + Canvas + Web Audio）的钢琴卷帘编曲工具 |
| [`deepseek_qa_assistant/`](deepseek_qa_assistant/) | DeepSeek 知识问答桌面应用，PyQt5 + openai SDK 接入，PyInstaller 打包为免安装 exe |
| [`simp-video-agent/`](simp-video-agent/) | AI 视频生成器，TypeScript + Node 的自研动画引擎与 LLM Agent，含浏览器编辑面板与 MP4 导出 |

## 神秘音乐编辑小网站

单文件纯前端应用，双击 `index.html` 即可在浏览器中使用，无需安装任何依赖。

- **编曲方式**：Canvas 2D 钢琴卷帘，鼠标点击/拖动输入音符，时间标尺点击跳转播放位置
- **鼓组轨道**：底鼓 / 军鼓 / 踩镲 / 开镲 / 拍手 / 嗵鼓 / 边击 / 牛铃，卷帘底部 8 行输入，键盘 `A S D F G H J K` 映射
- **音色合成**：Web Audio 振荡器（正弦 / 方波 / 锯齿 / 三角）+ 滤波与 ADSR 包络
- **播放控制**：BPM 调节、节拍器、空格播放/暂停、多轨道管理
- **存储与导出**：IndexedDB 自动保存、JSON 项目导入导出、混音导出为 WAV
- **示例工程**：`星际拓荒BGM带鼓点.json`，用界面上的「导入」按钮载入即可试听

## Simp Video Agent

用一句话生成可编辑的动画成片：自研确定性动画引擎 + LLM Agent + 无框架编辑面板。
TypeScript / Node，pnpm monorepo（5 个包、约 3.6 万行、1074 条单测）。

- **自研动画引擎**：`evaluate(doc, t)` 是纯函数（不碰 DOM、不读时钟、不取随机数，由 ESLint 自定义规则强制）；
  32 种领域命令 + Operation Journal 撤销栈；关键帧与缓动、自研表达式引擎、分组父子变换、相机与命中测试
- **LLM Agent**：9 个工具 / 24 条模型可见命令的 strict JSON Schema；多 Agent 编排（导演分镜 → 逐镜串行，每镜独立身份与预算）；
  独立评审自检（LLM-as-a-Judge）+「连续两轮无改善就停」的终止条件
- **Token 成本工程**：实测一帧 960×540 画面固定 323 token 且与画面复杂度无关，据此重标定三层图片预算；
  输入拆成缓存命中 / 未命中 / 思考 / 图片四类分别记账
- **双渲染后端**：Skia 无头 canvas（默认）与 Chrome CDP 截图两条路径，用逐像素对比工具量化差异，
  证明「预览 = 成片」无结构分叉；FFmpeg 编码导出 MP4
- **编辑面板（无框架）**：自研 schema→控件 渲染器；时间轴（拖播放头 / 拖镜头接缝 / 拖关键帧手柄）、
  审核队列、可撤销的 Journal、工程文件（含聊天上下文）保存与恢复
- **公式排版**：模型只写 LaTeX，MathJax 在 Node 里渲染成 SVG 轮廓 → 展平为 em 点列 → 按 nonzero 环绕规则填充

**运行**：双击 `simp-video-agent/start-panel.cmd`（首次会自动装依赖、建 bundle、起服务并打开浏览器）。
需要 Node ≥ 20.10；API key 写进 `simp-video-agent/.env.local` 的 `DEEPSEEK_API_KEY`，
也可以直接在页面顶部的「API 设置」里填（只存在服务端内存，不落盘）。

## 克隆

```bash
git clone https://github.com/YeShenge-CN/My-main-base.git
```

各子项目有独立的 README 说明运行方式。