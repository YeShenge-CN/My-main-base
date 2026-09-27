# Simp Video Agent

用一句话生成**可编辑的动画成片**：自研确定性动画引擎 + LLM Agent + 无框架浏览器编辑面板。

TypeScript / Node，pnpm monorepo（5 个包，约 3.6 万行，1074 条单测）。

## 三个设计要点

1. **求值是纯函数。** `evaluate(doc, t)` 不碰 DOM、不读时钟、不取随机数 —— 由 ESLint 自定义规则强制
   （`engine-core` 里连 `Date`、`Math.random`、`fetch`、`node:*` 都会被 lint 拦下），另有一条 purity 测试兜底。
2. **预览 = 成片，是结构上成立的。** 无头 Skia canvas 与 Chrome CDP 两条渲染路径
   共用同一份帧计划与同一份排版结果（折行在引擎层算完，画笔只按给定行画），
   并用逐像素对比工具量化差异，证明两条路没有结构分叉。
3. **模型的输出只是意图。** 形状靠 strict JSON Schema、字段约束靠字段注册表，
   锁 / 依赖 / 图像预算 / 问题归属全部由引擎推导与强制 —— schema 同时就是可执行命令的白名单。

## 快速开始

需要 **Node ≥ 20.10** 与 **pnpm**。

```bash
git clone https://github.com/YeShenge-CN/My-main-base.git
cd My-main-base/simp-video-agent
```

**Windows 最省事**：双击 `start-panel.cmd` —— 首次会自动 `pnpm install` + 打包各入口，
然后起面板服务并打开浏览器。也可以把一个文档路径当参数传给它：`start-panel.cmd out\my.json`。

**手动跑**：

```bash
pnpm install
pnpm --filter @sva/agent-tools build:cli   # 把各入口打成单文件 ESM 到 packages/agent-tools/dist/
node packages/agent-tools/dist/serve-panel.mjs
```

> 服务端在文档不存在时会**自动生成一份演示文档**（画了一条带生长动画的正弦曲线），
> 所以新克隆下来直接跑就有东西可看。加 `--no-open` 可以只起服务不拉浏览器。
> 面板 bundle 由服务启动时自动重新打包（`--no-build` 可跳过）。

### API key

聊天窗口要能命令 Agent，就需要一个 DeepSeek key。三种给法：

- 环境变量 `DEEPSEEK_API_KEY`；
- 项目根目录的 `.env.local`（该文件已被 gitignore）；
- 直接在面板顶部展开「**API 设置**」填写 —— 它**只存在服务端内存里**，不落盘、
  不进浏览器存储，服务重启就要重填（刻意如此）。

同一处还会显示 key 的掩码、model、baseURL，并有「测试连接」（会如实区分 *key 错* / *地址错* / *超时*）。
baseURL 只允许官方地址与本机地址 —— 白名单在服务端强制，要接自建网关请改
`packages/agent-tools/src/settings.ts`。

## 命令行

```bash
node packages/agent-tools/dist/cli.mjs --list
node packages/agent-tools/dist/cli.mjs --preset empty \
  --task "画一条 y=sin(x) 的曲线，用 2 秒生长出来" --render
```

起始文档预设：`empty` / `plot` / `diagram` / `grouped` / `flow` / `visibility` / `locked`。
常用参数：`--doc` `--out` `--at` `--max-turns` `--model` `--quiet`
`--no-agent`（只渲染不调模型，零 token）`--scene` `--all-scenes` `--multi`。

面板服务的思考档位用 `--reasoning off|low|high|max` 指定（默认 `high`），也可以在页面上随时改。

## 目录结构

| 包 | 职责 |
| --- | --- |
| `packages/engine-core` | **纯逻辑层**：求值、32 种领域命令、Operation Journal（撤销栈）、投影（给模型读的视图）、校验器、字段注册表。**禁止 import DOM / Node / 渲染框架**，由 eslint 规则 + purity 测试双重强制 |
| `packages/engine-render` | 画笔层：canvas 绘制、命中测试、排版与字体（自托管 WOFF2 子集，不依赖系统字体） |
| `packages/engine-node` | Node 宿主：无头渲染 / Chrome 截图 / FFmpeg 导出，拆成 headless、internal、screenshot、export、encode、chrome 六档 |
| `packages/agent-tools` | LLM Agent：DeepSeek 客户端、工具表、Runtime、多镜头编排、整片流程、面板服务、CLI、验收脚本 |
| `packages/panel` | 浏览器编辑面板：**无框架**，自研 schema→控件 渲染器；时间轴 / 关键帧 / 审核队列 / Journal |

## 门禁

```bash
pnpm run typecheck   # 每个包的三个 tsconfig（. / .test / .node）都要过
pnpm test            # vitest：1074 条通过
pnpm run lint
pnpm run check       # 上面三条串起来
```

**真调模型的验收是 opt-in 的**（默认跳过，普通的 `pnpm test` 不会打网络）：

```bash
SVA_ACCEPTANCE=1 pnpm test   # 单镜/多镜端到端 + 工具表 API 金丝雀（真调 DeepSeek）
SVA_STRESS=1     pnpm test   # 20 镜压力测试
```

**实机校验**（会拉起真 Chrome、真鼠标事件，需要先有跑着的面板）：

```bash
node packages/agent-tools/dist/verify-panel.mjs <面板地址>    # 面板交互回归，51 项
node packages/agent-tools/dist/verify-backends.mjs --at 0.2,0.6,0.9   # 两条导出后端逐像素对比
```

## 已知环境约束

- **Windows 上拉 Chrome 需要放开沙箱**：Chrome 用命名管道做 Mojo IPC，受限沙箱下会
  `拒绝访问 (0x5)` 然后自杀 —— 和 stdio 怎么配无关。详见 `docs/environment.md`。
- **部分 Windows 机器上 git 的 schannel 后端握手失败**（`SEC_E_NO_CREDENTIALS`）：
  `git config --global http.sslBackend openssl` 可解。
- **`out/` 与 `packages/*/dist/` 不进版本库**（构建产物、Chrome profile、渲染产物），
  所以克隆后第一次跑要先 `build:cli`；`out/` 里个别开发脚本没有随仓库发布。

## 文档

- `docs/progress.md` —— 开发交接文档（约 208 KB）：逐轮的实测数据、设计拍板记录，
  以及一张 60 多条的「症状 ↔ 根因」坑表。这个项目里几乎每个反直觉的决定都能在这里找到出处。
- `docs/environment.md` —— 本机与沙箱的实测环境约束（每条都附现象、根因、已验证的应对）。
- `docs/backend-parity.md` —— canvas 与 Chrome 两条导出后端的逐像素对比数据。
- `docs/formula-plan.md` —— 公式排版方案的取舍记录。
