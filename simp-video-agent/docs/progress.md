# 交接文档（新对话从这里开始）

写给下一个会话。**先读完这一页，再动代码。** 目标是让你不问我、也不重复我已经踩过的坑，
就能直接接着干。

上次会话结束时全部实测过的状态、以及**正在等你拍板的三个设计决定**都在下面。

---

## 0. 一句话现状

### ★★ 上一轮（第三十轮，§0.29）把 §0.28 的三份作业【做完了】

1. **Agent 自检** ✅ —— layout 组补了四条**表现层**判据（被裁 / 字号太小 / 贴边 / 两块压在一起）、
   `finish_shot` 前**必须真的渲染过一帧**、收尾话术**必须如实**说「还有 N 项没达标」，
   外加**独立评审**工具 `critique_frame`（换一条系统提示、只看这一帧、回结构化清单）。
2. **开放 token 上限** ✅ —— 图片 6→**16 张/镜**、上下文 3→**16 张**、单次 4→**6 帧**、
   聊天轮数 12→**30**、整片每镜 6→**16**、摘要 1000→**4000**、历史 4×400→**12×1200**、
   **显式传 `max_tokens`（8192）**、工具表上限 6400/5200→**8000/7000**，
   还顺手补上了 §0.28 点名缺失的**「画面规范」提示词一节**。
3. **前端「API 编辑」** ✅ —— baseURL / model / key（**只存服务端内存、只回掩码**）+
   「测试连接」（三类失败分得开）。**费用按用户拍板只算 token 不做金额**，
   面板现在把**输入（缓存）/ 输出（思考）/ 图片帧数**分开报。
   ★ 顺带做掉了用户拍板的**跨镜交接摘要**（整片模式下每镜带上前几镜的事实摘要）。

★★ **真调模型改掉了两处设计**（这一轮最值钱的两条，详见 §0.29 三）：
   ① 「看过画面」若把 `get_render_state` 也算，模型**一定走那条便宜的**——
      实测 5 轮里 `render_frames` 一次都没有，却干净地收尾了；
   ② 收紧之后撞到**第二条后门**：Runtime 自己的兜底收尾（issues 连续三轮为 0）
      会在模型看画面之前就把这一镜结束掉。**两条判据打架时，后门那条必须补上同样的前提。**

**再往前一轮（第二十八轮，§0.27）加了【工程文件】与【双击启动】**：
顶栏「保存工程 / 打开工程 / 恢复上次」—— 工程 = 文档 **+ 上下文**（聊天历史、聊天记录、
推理档位、整片模式），打开时一起换掉；每 900ms 防抖自动存档到 localStorage，刷新不丢工作。
仓库根的 **`start-panel.cmd`** 双击即用（首次自动装依赖 + 建 bundle + 起服务 + 开浏览器）。
实机校验 **25/25** + 单测 10 条。

再往前一轮（第二十七轮，§0.26）把「整片」接进了面板（导演分镜 → 逐镜生成，
真调模型实测 31 秒 / 9.6 万输入 token 跑完）。

再往前一轮（第二十五轮，§0.24）把「推理等级」搬到了页面上（下拉框，默认 high，档位表来自 `/api/health`）。

再往前一轮（第二十四轮，§0.23）是这件事的起因：面板的 Agent 以前**根本没开思考**
（`deepseek-chat` 不传 reasoning 参数时默认就是关的 —— 不是「等级被调到最低」，是压根没开）。
实测代价：思考约 **3.7× completion token、2.5× 时间**，记在**输出侧**（与 §7 的输入开销是两笔钱）。
顺带也回答了你对**我这边**的疑问：不是最低，`deepseek-flash` + `reasoningEffort: high`。

再往前一轮（第二十三轮，§0.22）是面板的时间轴手势：**红线可拖、画面实时跟**、
镜头块两端的手柄能像 PR 一样**拉长 / 缩短镜头与整片**，一次拖动 = 一条命令 = 一次撤销。
实机校验（真 Chrome、真鼠标事件）**24/24**；顺带把更早欠下的面板实机校验补跑了 **51/51**。

再往前（第二十二轮，§0.21）落地了**公式（方案 B）**：模型只写 LaTeX，
**几何由 Agent 的工具物化进文档**（MathJax in Node，不需要浏览器），求值层与画笔只认点列。

接下来的候选（见 §7）：
① **多行对齐公式 / 矩阵 / cases**（MathJax 本来就支持，缺的是排版参数）；
② **压力测试三臂重跑**（好几轮没跑了，改动不小）；
③ 拖动**关键帧手柄**时画面实时跟（本轮只做了播放头与接缝）；
④ 形状/连线的老账（端点吸附到方框边缘）。
`apply_commands` 现在 4830 / 上限 4900（**只剩 ~70**）；工具表 6008 / 6100（本轮**没动 schema**）。

<details><summary>再往前一轮（第十八轮，§0.17）：内联 effect 出 create 分支</summary>

`apply_commands` 5551 → **4534**，工具表 6450 → **5432**，比例 2.19× → 1.85×，
并且**真调模型验过**（第一轮就抓出 `localId` 少写 `$` 的真缺陷，已修）。

</details>

引擎 + 面板 + Agent 循环 + 导出**都通了**，质量门全绿。
**多镜头（P12）已端到端完整**：数据模型 + 写命令 + retime + 串行渲染 + 暴露给 Agent + 面板镜头 UI。
唯一还没做的是"一镜一个 Agent"的运行时（`activeSceneId` 没有入口）——
而规范 §13 说那要等压力测试证明必要。

**P2（动画原语）只剩最后一条没做**：`drawOn` 生长 / `highlight` 强调 / 颜色走上动画轨道 /
`moveAlong` 沿路径移动 / `appear`+`disappear` 真显隐（见 §0.11–§0.14）。
**§7 第 0 条（面板改不动效果参数，不变量 3 的缺口）已经修掉**（§0.14 ①），
它顺带暴露出一个更大的缺口：**形状 / 文字的参数（rect 宽高、line 端点、text 内容、fill/字号）根本没有编辑命令** ——
AI 也改不了，所以不是不变量 3 的问题，而是被 token 预算卡住的独立工作（§0.14 末尾）。
**形状 / 文字参数的编辑命令也已经补齐**（§0.18）：引擎三条命令 + 面板按形状派发 + 工具表暴露。
剩下的引擎侧欠账见 §7（retime 可逆、`remove_scene` 归属回迁、导演自动分镜、KaTeX…）。

---

## 0.5 最近六轮改动

### 第一轮：派生规则

**拍板**：A1（镜头结束 = 下一镜起点，不单独存）+ B1（duration 与镜头表单向对齐）。
子决定：`bornAt` 保留落盘但只是缓存 / 空表 = 单镜头旧行为 / `scenes` 是**必填**字段。

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/doc/types.ts` | `Scene`、`SceneDoc.scenes`、`sceneOrder/sceneEnd/sceneWindow/lastScene/findScene/reconcileDuration`；`objectTimeWindow` 三档右端镜头感知 |
| `engine-core/src/command/apply.ts` | `bornAtFor()`：`create_*` 的 bornAt 优先取**镜头表** |
| `engine-core/src/validate/validators.ts` | `scene_ref_missing`（environment / **human**） |
| `engine-core/test/scenes.test.ts` | 22 条断言 |

### 第二轮：三条写命令

`add_scene` / `set_scene` / `remove_scene`（`add_scene.id` 是**引擎专用**字段）；
`doc/paths.ts` 新增 `scenes.<id>.<字段>` 路径分支；镜头刻意做成**可逆**。
守护：`scene-commands.test.ts`（33 条）。

### 第三轮：`retime` 接上镜头表

`doc/shift.ts` 顺延镜头边界 + 越界预检；新错误码 `scene_bounds_exceeded`。
口径：**只有导演视角挪边界**，场景 Agent 越界直接拦。
守护：`retime-scenes.test.ts`（19 条）。

### 第四轮：多镜头串行渲染

`engine-core/src/shot.ts`（**新模块**）：`planShotFrames` / `shotSpans` / `shotAt` /
`sceneItemFilter` / `filterRenderStateByScene`。导出与预览共用同一份帧计划。
守护：`shot.test.ts`（17 条）+ `shot-pixels.test.ts`（8 条像素级）。

### 第五轮：镜头命令暴露给 Agent

工具表四条命令分支 + 系统提示「分镜」一节。
引擎专用字段（`add_scene.id` / `retime.activeSceneId`）**不在** schema 里，有断言守着。
守护：`scene-tools.test.ts`（12 条，含固定开销预算）+ `scene-model-json.test.ts`（8 条 JSON 往返）。

### 第六轮：面板镜头 UI + 一个运行时真 bug

| 文件 | 改了什么 |
|---|---|
| `panel/src/timeline.ts` | **镜头泳道**（`tl-shots`）：每镜一块、当前镜高亮、点一下跳到那一镜 |
| `panel/index.html` | 泳道样式 |
| `panel/src/app.ts` | ★ **预览按镜头过滤**（与导出同一判据）；帧计划成为唯一真源；传输条报当前镜 |
| `runtime.ts` | ★ **修 `cleanTurns` 缺 `anyWrite` 护栏**（见下）；判定抽成纯函数 `judgeTurn` |
| `panel-server.ts` | `finalMessage` 进聊天流 |
| `agent-tools/test/verify-panel.ts` | 新增 7 项镜头检查（共 34 项） |
| `agent-tools/make-panel-demo.mjs` | 演示文档加两镜 + `plot#2`（只属于第二镜） |
| `agent-tools/test/runtime-verdict.test.ts` | **新测试**：10 条（零写入不许被判成做完） |

★★ **这一轮最有价值的发现**（面板实机校验抓到的，不是我看代码想出来的）：

**`cleanTurns >= 3` 那条兜底收尾漏了 `anyWrite` 护栏。**
症状：给 Agent 一个本来就零 issue 的文档，它连读三轮
（`get_scene_summary` → `get_object` ×2 → `get_render_state`）**一次都没写**，
就被判成"做完了"，聊天里只留下一句 `（Runtime 收尾：issues 已连续三轮为 0）`，
而用户的要求一个字都没落地、版本号一动没动。

旁边那条同类兜底（"连续两轮无写入"）**显式带着** `anyWrite`，注释还写着
"实测把成功率刷成了 20/20 而 Agent 零产出"——**同一道护栏，第二条漏了**。
`issues` 为 0 只在【已经写过东西】之后才说明做完了；没写过只说明还没开始。

★ 而它当初能活下来，是因为这段判定**内联在 `runShot` 的 for 循环里**：
想测它就得真调一次模型（要钱、要网、结果不确定），所以没人测。
现在抽成纯函数 `judgeTurn`，10 条断言在毫秒级跑完 —— **这是修法的一部分，不只是修 bug**。

★★ **另一处是正确性问题，不是 UI 问题**：
面板预览此前**不过滤镜头**，而导出会过滤。于是多镜头文档会出现
"预览里两个镜头的内容叠在一起、成片里各归各的" —— 正是项目里最不能接受的那类失败。
现在面板走 `filterRenderStateByScene`，**与导出同一个判据**。

### ★ 六轮里纠正的缺陷（都是"不查就会静默失效"的那类）

1. **`{id, name, bornAt}` 派生不出片长。** 见 §6 的 B1。
2. **存量 `out/*.json` 没有 `scenes` 字段。** **踩了三次**。
3. **`scenes.<id>.<字段>` 不是可解析路径** → patch 静默失效。
4. **新错误码忘了加进 `toCommandError` 的 passthrough 表**。
5. **越界检查用原始时刻比顺延后的窗口。**
6. **最后一镜的尾帧掉进空档、成片以黑屏收尾。**
7. **质量门本身有漏洞**：逐包 `tsc -p tsconfig.json` 绕过了 `.test.json` / `.node.json`，
   漏掉 **10 处**编译错误。判据改用 `pnpm -r ... run typecheck`。
8. **面板预览不过滤镜头**（预览 ≠ 成片）。
9. **`cleanTurns` 缺 `anyWrite`**（零产出被判成成功）。

**已知边界**：
- `owner.bornAt` 是**缓存**，真源是镜头表的 `bornAt`。所以**没有**做"两者必须一致"的校验。
- `remove_scene` 撤销时被改归属的对象**不跟着回迁**（`Operation ↔ Command` 一对一）。
- **`retime` 仍不可逆**（`invert.ts` 里 `unsupported_op`）。
- **CLI 仍是"不过滤"口径**：`--at 0,1,2` 渲染全部对象（对单镜头诊断是对的）。
- **场景 Agent 视角还没有入口**：`retime` 的 `activeSceneId`、越界拦截都实现好且有测试，
  但运行时永远是导演视角。多镜头串行跑多个 Agent 是下一块（规范 §13 要求先看压力测试）。






---

## 0.6 第七轮：压力测试跑出来的一个真问题（坐标契约）

★ **这一轮什么都没"加"，但可能是整轮多镜头工作里收益最大的一次** ——
因为它是压力测试（而不是我的判断）指出来的。

### 三臂结果（加了两轮多镜头改动之后重跑）

| 臂 | 结果 | 关键数字 |
|---|---|---|
| `completion` | ✅ **20/20** | token/成功 38607 · image_cost_avg 0.30 · read_before_write 0.71 |
| `collab` + `override` | ✅ **20/20** | 提案 20 · 全部批准并执行 20 · stale_rate 对抗臂 = 1 |
| `collab` + `fast-forward` | ✅ **20/20** | 同上；两条审批分支的 decision_kinds 都不是单一值 |

（`stale_rate_natural` 恒为 0 是设计使然：单 Agent 单镜头下没有竞争者。真正有信号的是对抗臂。）

### 但第一次跑时 completion 是 **18/20**

`#6`（"画一条曲线，加一行中文标题在顶部"）与 `#17`（"叠加波形 + 标题"）
**撞满 12 轮轮数上限**，各烧掉 ~95–100k token。轨迹里的原话：

```
turn 7  intent "屏幕 y 向下为正，之前方向反了；改为 y=+105 把标题移到顶部"
turn 8  get_render_state → text#1 box y = -3043.8     ← 标题飞出画布 3000px
turn 10 intent "测试 y 变换的映射关系：设为 1 看锚点位移量"
```

**根因不是模型不行，也不是审美判断，而是它缺一个我早就知道的常数**：
`tf.x / tf.y` 是【世界单位】（文档里不存在像素概念），而 `get_render_state` 报的
box 是【像素】—— 模型拿不到从世界到像素的换算，于是只能靠试。
`worldHeight = 9` 时 `tf.y` 的可用范围只有 ±4.5，它却写了 105（1 单位 = 30px → 3150px）。

### 修法（三处，都很小）

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/render-state.ts` | `RenderState.fit?` —— 把这一帧的贴合参数（base/x0/y0/cx/cy）如实交出来 |
| `engine-core/src/evaluate.ts` | 填 `fit`（它本来就在算，只是没往外给） |
| `engine-core/src/projection/render-state.ts` | `RenderStateView.world`：世界宽高、**1 世界单位 = 多少像素**、世界可见范围、相机 tx/ty（同单位）、一句契约说明 |
| `agent-tools/src/tools.ts` + `prompt.ts` | `get_render_state` 的描述与提示词点明"tf 是世界单位、可见范围是 ±8 × ±4.5、不要靠试数字探索映射" |

★ `projectRenderState(state, meta)` 里 **meta 是必填**：世界宽高**猜不出来**
（viewport 与世界宽高的比值决定换算，拍一个默认值会给出一个"看起来像真的"的错误答案）。
这是刻意的 —— 宁可让调用方显式给，也不要一个会骗人的默认值。

### 修完再跑

| 任务 | 修前 | 修后 |
|---|---|---|
| #6 中文标题 | **12 轮 / 94k token / FAIL** | 6 轮 / 45k / OK |
| #17 叠加波形 | **12 轮 / 97k / OK（险）** | 5 轮 / 36k / OK |
| 其余 18 条 | 4–9 轮 | 5–6 轮 |
| 总计 | 18/20 | **20/20** |

**定位与修复之间没有靠运气**：轨迹里模型自己写下了"测试 y 变换的映射关系"，
那就是它在说"我不知道这个换算"。把换算给它，问题就没了。

---

| 项 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm.cmd -r --workspace-concurrency=1 --if-present run typecheck > out\tc.log 2>&1`（**读文件里的退出码**） | ✅ exit 0（**三个 tsconfig 全覆盖**；以前只跑第一个，漏了 10 处错误） |
| eslint | `node node_modules/eslint/bin/eslint.js .` | ✅ exit 0，**0 字节输出** |
| vitest | `node node_modules/vitest/vitest.mjs run --pool=threads --exclude "**/node_modules/**" --exclude "**/.pnpm-store/**" --exclude "**/dist/**" --exclude "**/out/**"` | ✅ **62 文件通过 / 2 跳过（64）**；用例 **913 passed / 48 skipped（961）**（上一轮 60 文件 / 886 passed） |
| 像素级（形状 + 高亮 + 颜色轨道 + moveAlong + 显隐 + 多镜头） | `SVA_PIXELS=1` 后同上 | ✅ **`shot-pixels.test.ts` 27/27**（本轮 +4 条显隐；解锁 32 条像素断言） |
| 多 Agent 验收 | `SVA_ACCEPTANCE=1` 跑 `agent-tools/test/multi-shot-acceptance.test.ts`（**花钱调模型**） | ✅ 两镜各 1 次写入、归属正确、无越权（8.4s） |
| 面板实机校验 | `node packages/agent-tools/dist/verify-panel.mjs "<面板地址>"`（**需 danger-full-access**） | ✅ **51/51**（34 → 38 → 43 → 48 → 49 → 50 → 51）。★ 它抓到了两轮里最严重的问题：工具表嵌套 anyOf 被接口整表拒收（§0.14）、以及 `renderTimeline` 的 `clear(root)` 把镜头控件清掉（§0.15） |
| 像素级（多镜头） | `SVA_PIXELS=1` 后同上 | ✅ 多镜头像素验证 8/8 |
| P8 导出验收（Chrome） | `SVA_EXPORT=1` 跑 `engine-node/test/export.test.ts`（**需 danger-full-access**） | ✅ 8 passed / 1 skipped；Level A 逐帧 IDENTICAL、Level B **SSIM=1.000000** |
| 后端一致性回归 | `node packages/agent-tools/dist/verify-backends.mjs`（**需 danger-full-access**） | ✅ 控制臂 0.000 / 0.406 / 0.674 / 7.106，与 `docs/backend-parity.md` 记录一致 |
| 压力测试 | `SVA_STRESS=1 SVA_STRESS_MODE=completion` 等三臂（**花钱调模型**） | ✅ **三臂全 20/20**（见 §0.6 的实测数字与"坐标契约"发现） |
| 后端像素对比 | 见 `docs/backend-parity.md` | ✅ canvas vs chrome 控制臂 = 0.000 |

> ⚠️ **别用 `pnpm.cmd run check` 判断红绿。** PowerShell 会把 pnpm 的脚本头写进 stderr，
> 变成 `NativeCommandError` 污染退出码 —— 它**永远看起来是红的**。
> **但要读对退出码，请把输出重定向到文件再读 `$LASTEXITCODE`**：
> ```powershell
> $env:CI='true'
> pnpm.cmd -r --workspace-concurrency=1 --if-present run typecheck > out\tc.log 2>&1
> $LASTEXITCODE   # ← 这个才是真的（0 = 过）
> Get-Content out\tc.log | Select-String 'error TS'
> ```
> 直接 `pnpm.cmd ... 2>&1 | Select-String ...` 会把 `$LASTEXITCODE` 覆盖成 cmdlet 的。
>
> ★★ **不要再用"逐包 `tsc -p packages/<pkg>/tsconfig.json`"当判据**（前几轮交接文档的建议）。
> 各包的 `typecheck` 脚本跑的是 **三个** tsconfig：`tsconfig.json` + `tsconfig.test.json`
> + `tsconfig.node.json`。只跑第一个会让 **测试与诊断脚本的编译错误完全隐形** ——
> 第五轮实测：`SceneDoc` 加必填 `scenes` 之后，这样漏掉了 **10 处**错误
> （4 处在 `SVA_EXPORT=1` 才解锁的用例里、3 处在诊断脚本里）。
> 判据就用上面那条 `pnpm -r ... run typecheck`。

> ⚠️ 全量测试**只跑了没带环境变量的那次**。`SVA_EXPORT=1`、`SVA_PIXELS=1`、
> `SVA_ACCEPTANCE=1`、`SVA_AUTOFIX_TRACE=1` 这些开关各会解锁一批 skip 掉的用例。
> **已补跑过的**（第五轮，都需 danger-full-access）：
> `SVA_EXPORT=1` 的 P8 验收 → 8 passed / 1 skipped，Level A 逐帧 IDENTICAL、Level B SSIM=1.000000；
> `SVA_PIXELS=1` 的全量 → 784 passed / 9 skipped（`shot-pixels.test.ts` 23/23，
> 含形状 6 + 高亮 3 + 颜色轨道 3 + **moveAlong 3** + 多镜头 8）。> **仍未验**：`SVA_ACCEPTANCE=1`、`SVA_AUTOFIX_TRACE=1`、以及 P2 三条原语之后重跑的压力测试三臂。

---

## 0.7 第八轮：清缺陷 + 多 Agent 的准备工作

按"先清已知缺陷，再做多 Agent"的顺序。逐条核实过现状，没有照抄文档。

### 缺陷 1：模型看不到镜头表 ✅ 已修

`get_scene_summary` 此前连"文档里有几镜"都不说，模型为了搞清状况自己去 render 画面。
现在 `SceneSummary.scenes` 给出每镜的 `id / name / range / objects`（对象数**不含**
shared / global —— 它们不属于任何单镜，混进来会让这个数误导人）。

★ **顺手修掉一个陈旧缺陷，而我这轮会让它更严重**：
摘要超预算时原来是"objects 放不下就 `break`"，于是 **effects / markers / locks 全被静默跳过**。
预算最紧的时候，模型恰好丢掉的是【锁】（不看就白提提案，而提案花的是用户的时间）。
现在改成**按不可牺牲程度从高到低填充**：

    locks → objects → scenes → effects → markers

并且**先给 `truncated` 披露字段留出额度**（它不是可选的：静默丢数据比超预算更糟），
装不下的部分在收缩阶段按逆序丢弃、逐项如实记进 `truncated`。
代价是预算紧时对象少装几个（实测 100 对象：82 → 73），换来锁与镜头结构一定在场。

### 缺陷 2：`retime` 不可逆 ⚠️ **降级为独立工作（有理由）**

推演后发现**它不是几行的事**：`retime` 当前只给 `meta.duration` 与 `scenes` 记 patch，
而它实际还平移了**对象的 anim、markers、相机 keys、音视频轨**。
要做对，得让 `shiftTimeline` 额外报告"到底哪些标量时间实体动了"（结构性改动），
再由逆操作重建那些字段。

★ **我判断它该独立成一块**：
1. 它**不阻塞任何人** —— `retime` 只有显式动作会触发，撤销一轮含它的操作会
   **如实报告跳过**（`unsupported_op`），不是静默失败；
2. 塞进这一轮会把"缺陷修复"和"多 Agent"混成一坨，两者都不好验。
`delete_object` 的不可逆同理（取舍理由写在 `invert.ts` 里：恢复一个带几十个字段与效果的
对象需要"绕过 id 分配器的重建命令"，而镜头只有三个标量，所以镜头做成了可逆）。

### 缺陷 3：CLI 不过滤镜头 ✅ 已修

`--at 0,1,2` 在单镜头诊断下是对的（看整片铺开），但多镜头文档用它看画面会被误导。
新增两个参数，并**在没指定时明确警告**：

```powershell
node packages/agent-tools/dist/cli.mjs --doc out/panel-demo.json --no-agent --at 1,6
#   ⚠ 这份文档有 2 个镜头，而你没有指定 --scene：本次渲染【不过滤】…
node packages/agent-tools/dist/cli.mjs --doc out/panel-demo.json --no-agent --all-scenes
#   镜头数量  : 2
#   逐镜首帧  : shot-s_1-t0_00.png=ef5ac11ccc43  shot-s_2-t4_00.png=f7eab6c4636d
```

实测确认第一镜首帧里**没有 plot#2（第二镜那条曲线）**，第二镜里有。

---

## 0.8 第九轮：多 Agent（P12 最后一块）

### 引擎侧：让"我这一镜"成为默认归属

`CreateOwner.sceneId` 现在允许 `null`，含义是**放进我当前这一镜**：

| 改动 | 位置 |
|---|---|
| `CreateOwner.sceneId: string \| null` | `command/commands.ts` |
| `ApplyContext.scope`（身份/权限范围） | `command/apply.ts` |
| 新增 `resolveOwner()`：`null` → `ctx.scope.sceneId` | 同上 |
| 新增 `ownerInfoFor()`：上面那条 + `bornAt` 由镜头表推导，一处收口 | 同上 |
| `BatchDeps.scope` 透传进 `applyCtx`（与 registry 在同一处构造） | `command/batch.ts` |
| `export * from './doc/permissions'`（`Scope` 之前没导出） | `index.ts` |

★ **为什么必须由引擎兜住**：场景 Agent 不该、也不必知道自己的镜头 id ——
那是编排层给它的身份。让模型自己填 id 会引入两类错误：**填错**（写进别人的镜）
与**不填**（游离对象）。现在它只写 `kind: 'scene'`，引擎落到当前镜上。

### 编排层：`multi-shot.ts`

刻意做得**小** —— 它不是一个 Agent 编排框架，而是"按 `sceneOrder` 逐镜跑同一个单镜头循环"：

- **串行，不并发**（规范 §14 明确不做并发多 Agent 写同一文档）。附带好处：后一镜的
  Agent 看到的是前一镜改完的文档，"接着上一镜的视觉语言"不需要额外机制。
- **每镜一个身份**：`scope = { kind:'scene', sceneId, start, end }`。
- **每镜一个预算账本**：L2 层本来就按 sceneId 记账，共用会让第二镜一开始就没额度。
- **每镜一个 `turnId`**：它决定 compound 粒度，而 compound 就是"撤销这一轮"的单位 ——
  共用一个 turnId 会让用户点一下把**整片**撤掉。**这一条有断言守着。**
- 空镜头表时**退化成"跑一次全片"**（导演视角）——"空表 = 单镜头"口径的必然结果。

同时给 Runtime 加了 `turnId` 参数与 `sceneScopedTask()`：任务文本前面补一句
"【你负责的镜头】s#2，时间 [4,8)"，因为**模型看不到 scope，但它必须知道边界**。

### 实测（`SVA_ACCEPTANCE=1`，真调模型，8.4s）

```powershell
node node_modules/vitest/vitest.mjs run --pool=threads packages/agent-tools/test/multi-shot-acceptance.test.ts
```

```
[multi] s#1: 轮数=4 写入=1 问题=0 token=28844 收尾=正常
[multi] s#2: 轮数=3 写入=1 问题=0 token=21052 收尾=正常
[multi] 对象归属: [["plot#1","s#1"],["plot#2","s#2"]]
```

★ 验收三条（都在 `multi-shot-acceptance.test.ts`）：
1. 每镜都必须真的产出内容（写入数 > 0）；
2. 每个新建对象落在**跑它的那一镜**里，且时间窗不超出那一镜；
3. **没有越权**：镜头表与片长都没被动过。

### CLI

```powershell
node packages/agent-tools/dist/cli.mjs --doc out/panel-demo.json \
  --multi "s#1:画一条正弦曲线;s#2:画一条余弦曲线" --render
# 只写 --multi（不给值）= 每一镜都跑 --task 那一个任务
```

单镜头与多镜头两条路**适配成同一个报告形状**（`AgentRunSummary`），报告逻辑只写一份 ——
各写一遍的话，"Agent 操作数"这类口径迟早分叉。`run.json` 里另带逐镜数字。

### 关于规范 §13 那条限制

规范说 P13（多 Agent）"**仅在压力测试证明必要时**"才做，而压力测试的结论是
**能力够用**（三臂 20/20）。所以这一版是**按需的编排层，不是自动分镜**：
任务从哪来仍由调用方决定（人写，或将来由导演拆）。它没让系统"更聪明"，
只是让"一条任务 → 一镜"这个循环可以被驱动 N 次。

---


```powershell
# 1) 打包三个入口。改了 cli / serve-panel / verify-panel 或它们依赖的代码之后必须重跑。
node packages/agent-tools/build-cli.mjs

# 2) 起面板（同时提供 /api/chat 与 /api/export）。端口每次不同，看启动输出，/api/health 可查。
node packages/agent-tools/dist/serve-panel.mjs --doc out/panel-demo.json
#    --no-open 只起服务不拉浏览器；--no-build 跳过重新打包面板 bundle

# 3) 实机校验（需要一个已在跑的面板地址；**需要 danger-full-access**）
node packages/agent-tools/dist/verify-panel.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"

# 单镜头 CLI
node packages/agent-tools/dist/cli.mjs --preset empty --task "画一条 y=sin(x) 的曲线" --at 0,1,2,12 --render
node packages/agent-tools/dist/cli.mjs --doc out/run/doc.json --no-agent --at 0,1,2   # 只渲染，不调模型
```

预设文档：`node packages/agent-tools/make-panel-demo.mjs` → `out/panel-demo.json`

### 残留进程（离开时实测，处理一下再开工）

- `127.0.0.1:3080` 上的 node **PID 24820 是 DSH 本体的 Web GUI，别杀。**
- `127.0.0.1:8846` 上挂着一个**上次的 panel server**（PID 24820 是 DSH，8846 是另一个 node）。
  先杀掉或忽略，重新起一个即可。
- **9 个 chrome 进程还在**（8:17 起，可能持有 `out/chrome-profile-panel-live` 的锁）。
  下次 `launchChrome` 删不掉 profile 目录时会自动退到新目录名（已兜底），但最好先清掉：
  `Get-Process chrome | Stop-Process -Force`

---

## 0.9 第十轮：P1 形状系统（结构图的两个基元）

**动因**：上一轮回答"能不能做计算机架构科普视频"时核实出，引擎只能画
`plot2d`（函数曲线）与 `text` —— **方框、箭头、框图全都画不出来**。
那不是新需求，是规范 P0 第 5 步一直欠着的地基（`evaluate.ts` 的注释里写着
"其余 shape 需要各自的采样器，属于 P0 第 5 步的剩余部分"）。

### 做了什么

只做两个 shape（一次一个）：**`rect`（矩形，可圆角）与 `line`（线段/箭头）**。

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/registry/fields.ts` | 四个分组：`shape.rect.{params,style}` / `shape.line.{params,style}` |
| `engine-core/src/sampling/shapes.ts` | **新模块**：`sampleRect` / `sampleLine`（精确几何，不是采样） |
| `engine-core/src/evaluate.ts` | 三条形状分支的共同出口：都产出世界坐标点列 → 统一走 world→pixel |
| `engine-core/src/render-state.ts` | `RenderItem.closed` / `.arrow` / `style.fill` / `.fillOpacity` / `.headSize` |
| `engine-core/src/anim/track.ts` | `ResolvedItemStyle` 加 `fill` / `fillOpacity` / `headSize` |
| `engine-render/src/paint.ts` | 填充（独立 alpha）、闭合、**箭头**（末端实心三角） |
| `engine-core/src/command/{commands,apply}.ts` | `create_rect` / `create_line`，与 `create_object` 共用 `emitCreated` 记账 |
| `agent-tools/src/tools.ts` + `shot.ts` | 两条命令分支；新增 `--preset diagram` |
| 测试 | `engine-core/test/shapes.test.ts`（17 条）+ `shot-pixels.test.ts` 加 6 条像素断言 |

★ 关键设计：**三条形状分支共用同一个出口**（世界坐标点列 → world→pixel）。
所以"再加一个 shape"只需要加一个采样器 —— 变换、AABB、命中测试、镜头过滤一律不用动。

★ `rect` / `line` **没有 `samples`**：它们精确几何，点数是确定的。
给它们编一个采样旋钮只会制造一个"调了没用"的字段。

### 实测（`--preset diagram`）

```
node packages/agent-tools/dist/cli.mjs --preset diagram --no-agent --at 2 --out out/diagram
```

画面：两个圆角方块（深蓝 / 深棕，带描边与发光）+ 一条带箭头的连线。
**这是引擎第一次画出"图"，而不是"曲线与文字"。**

### ★ 像素测试抓到的三个真 bug（结构断言全是绿的）

这一轮最有价值的部分不是新代码，而是"写像素断言"逼出来的三个错：

1. **`styleFor()` 的白名单忘了加新字段** —— `fill`/`fillOpacity` 在求值层是对的，
   到画笔时被静默丢掉，方框只剩描边。而 `RenderItem` 层的断言全绿。
2. **箭头沿用了矩形留下的 `fillStyle`** —— 被涂成背景色。症状很反直觉：
   **"有箭头的图反而比没箭头的墨更少"**。箭头是线条的端点，颜色属于线。
3. **箭头大小的单位搞错了** —— 我按"世界单位"给它 0.8，而线宽那条路走的是**像素**
   口径（`width × cameraScale`，`plot2d` 一直如此，默认 3 就等于 3px）。
   于是恒等相机下箭头只有 0.8 像素：**画出来了，但肉眼与像素测试都看不见**
   （末端 30 列全是线宽的 2px，一个三角形都没有）。
   统一成像素口径后默认值改成 `width: 2` / `headSize: 16`。

★ 教训：**"画出来了"和"看得出画出来了"是两件事**，
而区分它们唯一的手段就是像素断言。已进坑表。

### 固定开销：如实记录的增长

工具表从 **3660 → 4822**（+1162，约 +36%），每轮重发。
逐分支量过：`create_plot 454 / create_rect 486 / create_line 469 / create_object 444` ——
**新分支并不比旧分支贵**，主要成本是每条 create 分支都内嵌一份
`DRAW_ON_CREATE` 的完整字段约束。

这是**真金白银的取舍**，已写成待决项：
把内联 effect 从四条 create 分支里拿掉、一律走 `add_effect`，能省约 4×350 token，
但规范 §7 明确要求 create_* 支持内联 effect（"消除假依赖的必要手段"）。
**需要你拍板。** 预算断言按实测调到 5400/4400，并注明基线数字。

---


| 想确认什么 | 怎么验 |
|---|---|
| 显隐（appear / disappear）画对了没 | ★ **`node packages/agent-tools/dist/diag-visibility.mjs`** —— 把整条时间轴拼成一张胶片图（`out/visibility-strip.png`：红框=不在、绿框=在），并把"结构判据(evaluate)"与"画面判据(该色像素数)"并排打出来。**不需要浏览器** |
| 显隐的单帧 | `node packages/agent-tools/dist/cli.mjs --preset visibility --no-agent --at 1,3,7 --out out/vis` |
| 关键帧编辑 | 面板里选中**带动画轨道的对象**（演示文档的 `plot#1`），时间轴下方会出现 ◆ 手柄：拖动改时刻、双击手柄删、双击空白插。端到端靠 `verify-panel`（48 项里的 5 项） |
| 工具表能不能被接口收下 | `SVA_ACCEPTANCE=1` 跑 `packages/agent-tools/test/tool-schema-api.test.ts`（毫秒级，几十 token） |
| 面板 UI 没坏 | `verify-panel.mjs <url>`，期望 27/27。**需要 danger-full-access** |
| 两条导出后端像素一致 | `node packages/agent-tools/dist/verify-backends.mjs --at 0.2,0.6,0.9`，门限见 `docs/backend-parity.md` |
| 字体真的注册了 | `node packages/agent-tools/dist/diag-text-metrics.mjs`（两边度量必须 0.00 px 差） |
| 文字位置偏了 | `node packages/agent-tools/dist/diag-text-offset.mjs` |
| 压力测试单条任务 | `SVA_STRESS=1 SVA_STRESS_MODE=completion SVA_STRESS_ONE=1`（只跑最后两条，编号仍是全量口径） |
| 模型到底写了什么 | `SVA_STRESS_TRACE=1` |

---

## 0.10 第十一轮：分组（`parent`）—— P1 形状系统的收尾

**动因**：上一轮补了 `rect` / `line` 之后，还剩一个基元缺口：**没有分组，
摆 20 个方块全靠手算世界坐标，模型必然摆歪**；而且"让整组倾斜 15°"这件事做不了。

### 设计决定：分组是【父子关系】，不是一个新 shape

分组要的只有一件事 —— **整体移动 / 旋转 / 缩放一组东西**。那件事的本质是"变换链"。
做成 shape 会立刻冒出三个假问题：group 自己的包围盒怎么算、它怎么被绘制、
它能不能有 style。做成父子关系，这三个问题都不存在。

★ 它顺带激活了三件早就存在、却几乎没用过的东西：`tf.rotate` / `tf.sx` / `tf.sy`。
在此之前"绕自己原点旋转"对单个方框毫无意义 —— 现在"整组倾斜"是一行命令。

★ **刻意不做布局引擎**（自动排布 / flex / 网格）：规范 §14 明确不做过度工程。
"一组方块整体挪一下"是真实需求；"自动算 20 个方块的位置"不是 ——
那件事该由 Agent 算好再写进来。

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/doc/types.ts` | `SceneObject.parent?: ObjectId` |
| `engine-core/src/evaluate.ts` | `worldMatrixOf()`：父级链矩阵（带缓存与**深度截断**） |
| `engine-core/src/registry/{fields,types}.ts` | `object.parent` 分组 + 新分区 `'parent'`（语义 = control） |
| `engine-core/src/command/{commands,apply}.ts` | `set_parent` 命令（**写入时就拒环**） |
| `engine-core/src/validate/validators.ts` | `parent_missing`（auto）/ `parent_cycle`（human） |
| `agent-tools/src/{tools,prompt}.ts` + `shot.ts` | 工具分支、提示词一节、`--preset grouped` |
| 测试 | `engine-core/test/group.test.ts`（18 条） |

### 三条边界（都是"坏文档不许把求值搞挂"）

1. **悬空父级** → 当顶层对象处理（不抛异常），校验器报 `parent_missing`。
2. **环** → 求值路径有 `MAX_PARENT_DEPTH` 截断，任何输入都能终止；
   而 `set_parent` 在**写入时**就把环拒掉 —— 一条必然产生坏文档的命令不该被提交，
   否则撤销历史里会留下一份"父级链绕回自己"的中间态。
3. **自引用** → 同上传入时就拒。

★ 校验器与防御是两件事，两个都要有：**防御**保证任何输入都能终止；
**校验器**保证问题被人看见。

### 实测（`--preset grouped`）

```
node packages/agent-tools/dist/cli.mjs --preset grouped --no-agent --at 2 --out out/grouped
```

画面：三个对象一起倾斜 8°、一起放大约 6% —— **而它们各自的 `tf` 一个都没改**，
只改了 `group#1` 的 `tf.rotate` / `tf.sx` / `tf.sy`。

---

## 0.11 第十二轮：P2 第一条 —— `highlight`（"现在看这一层"）

**动因**：P1 的形状系统已经够画一张静态框图了，而"**讲得清**"靠的是逐步高亮。
在这之前"强调某个元素"只能靠透明度闪一下 —— 而透明度一变，元素会淡出，
读起来是"它要消失了"，不是"它在被强调"。

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/registry/fields.ts` | `effect.highlight.params`（start / duration / color / intensity） |
| `engine-core/src/render/color.ts` | **新模块**：`parseColor` / `mixColor`（颜色插值的唯一实现） |
| `engine-core/src/evaluate.ts` | `resolveEffects()`：**完整解析**（原来是"找到第一条 drawOn 就返回"）；高亮**烘进样式** |
| `engine-core/src/command/{commands,apply,batch}.ts` | `set_highlight` 命令 |
| `agent-tools/src/tools.ts` | 内联 effect 改成 `anyOf: [drawOn, highlight]`；新增 `set_highlight` 分支 |
| 测试 | `engine-core/test/highlight.test.ts`（22 条）+ 像素断言 3 条 |

### ★ 两个设计决定

**1. 高亮烘进样式，画笔不需要知道 highlight 的存在。**
两种做法都能实现，选这一种是因为它是**一处解析**：画笔只消费 `RenderItem.style`
（已经是最终颜色），于是预览、headless 导出、Chrome 导出三条路拿到同一份结果。
让画笔自己去解析效果的话，"颜色渐变"就会有三份实现。

**2. 效果解析从"第一条命中就返回"改成完整解析。**
原因是效果开始有**两种互不冲突的类型**了：`drawOn` 决定"画出多少几何"，
`highlight` 决定"外观怎么被强调"。一个方框完全可以**先长出来、再被高亮** ——
用旧写法后一条效果会被静默丢掉。同类型多条时的口径：**后定义的生效**
（刻意不做"叠加/混合"：那需要回答"两条 drawOn 的进度怎么合"这类没有答案的问题）。

### 内置的两个反直觉细节

- **文字的高亮作用在 `fill` 上，不是 `stroke`** —— 那是 text 与 rect/line
  唯一一处样式语义不同的地方，不显式处理的话"高亮一行标题"会毫无效果。
- **高亮会保持，不会自己退回**。要讲解完恢复原样，得再挂一条高亮把 color 设回原色。
  这是刻意的：参数是 `start/duration`（渐入），不是 `start/duration/end`——
  多一个 end 就多一堆"end < start 怎么办"的边界。

### 实测

```
node packages/agent-tools/dist/cli.mjs --preset diagram --no-agent --at 2,6 --out out/hl
```
`diagram` 预设里右边那个方块挂了高亮：t=2 是原色 `#ffb454`，t=6 变成 `#ffd479`
（同时发光与线宽一起抬）。两帧的像素哈希 `3685d9a8823d` → `c45c3fad4891`。

### ★ 固定开销：一个值得记下来的结构事实

工具表 **4822 → 5978**，系统提示 2074 → 2557。于是：

    ★★ 工具 schema 现在比系统提示【贵一倍多】（5978 vs 2557）

**想省 token，改提示词几乎没有意义 —— 该动的是 `apply_commands` 的 schema。**
它贵的根因是每条 create 分支都内嵌一份内联 effect 的完整字段约束，
而加了第二种效果类型之后那份变成两份（每条分支 ~450 → ~620，四条合计 +680）。

已知的两个可优化项（都需要拍板，见 §7）：
1. 内联 effect 从四条 create 分支拿掉、一律走 `add_effect`（省 ~680 token）
2. `create_rect` / `create_line` 合并回 `create_object`（省 ~1100 token）

预算断言按实测调到 6600/5600/2900，并新增一条**相对约束**：
工具表不许超过系统提示的 2.6 倍（当前 2.34×）——绝对上限会随功能增长而调，
相对关系是一条不会随便被调松的护栏。

---

- **坐标契约**：`worldToPixel(p,M) = M · fit(p)`，`fit(p)=(x0+p.x·base, y0−p.y·base)`，
  `M = T(视口中心)·S(scale)·R(rotate)·T(−fit(pivot+(tx,ty)))`，`base = min(viewport/world)`。
  **规范原文的 `cx,cy` 与 `pivot·base` 有歧义，`camera.ts` 头部给了算术证明，照它读，
  别照规范那句原文重写。**
- ★ **坐标契约必须到达模型眼前**（第七轮的教训）：`tf.x/y` 是世界单位、`get_render_state`
  的 box 是像素，而模型一度拿不到换算 —— 于是它写出 `tf.y=105`（1 单位=30px → 3150px）
  想让标题到顶部，标题飞出画布，然后烧掉 6 轮在数字上试。
  现在 `RenderStateView.world` 给出 `pixelsPerUnit` 与 `visible`（世界可视矩形恒为
  `[-W/2,W/2]×[-H/2,H/2]`），工具描述与提示词也点明了。
  **加任何"模型要用的数字"时先问一句：它到达模型眼前了吗？**
- **唯一写路径**：`applyCommand → Journal.commit → applyCommands`。面板拖滑块、AI 调工具、
  引擎自动修、撤销补偿全走它。`journal.appendEmbedded()` 是唯一例外（搬别的进程产出的
  patches），用途与边界写在它自己的注释里。
- **host-free 边界**（engine-core 禁 DOM/Node）由三处强制：`engine-core/tsconfig.json`
  （`lib:["ES2022"]`、`types:[]`）、`eslint.config.mjs` 的 restricted 规则、
  `test/purity.test.ts` 的源码扫描。**加新模块先想清楚它属不属于 engine-core。**
- **engine-node 的导出边界**（按"要不要 DOM / 要不要浏览器"切）：
  `.` 包根（全部，会拉 puppeteer）· `./headless`（只要 canvas）· `./internal`（静态服务+打包器，无 DOM）·
  `./screenshot`（浏览器截图，需 DOM）· `./export`（Chrome 逐帧，需 DOM）· `./encode`（帧时序+ffmpeg/ffprobe，无 DOM）。
  放错档就会把 DOM 类型漏给不该有的包。
- **渲染器一律注入**：`runOneShot`、`panel-server` 的 `chromeRender`、`ToolContext.render`
  都是注入的。谁有能力提供宿主能力，谁注入。
- **Agent 循环固定四步**：Read → Command → Validate → Render Feedback。没有别的写路径。
- **Node CLI 入口必须打包**（rolldown，`build-cli.mjs` 有 7 个 entry）。
  `node --experimental-strip-types` **不改写无扩展名 import**，而本仓库全用这种写法。

---

## 0.12 第十三轮：P2 第二条 —— 颜色走上动画轨道

**动因**：`track.ts` 原来写着"字符串插不动就跳变"。于是 `style.stroke` 只能做
**到点换色**，做不出"从蓝渐变到黄" —— 而那正是"数据流过来时线条变亮"这类效果的载体。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/anim/track.ts` | `SampleMode`（`plain` / `color`）；`blendAtoms`：先数值 → 再颜色 → 否则跳变 |
| `engine-core/src/registry/schema.ts` | `findField()`：查字段规格的唯一入口 |
| `agent-tools/src/{tools,prompt}.ts` | 说清 `style.stroke` 能动、颜色会插值；并写清"渐变 vs 高亮怎么选" |
| 测试 | `color-track.test.ts`（15 条）+ 像素断言 3 条 |

### ★ 判据来自 FieldRegistry，不是"值看起来像不像颜色"

`sampleModeFor()` 问的是 registry："`<shape>.style.<key>` 登记成 `color` 了吗"。
**字段类型只有一处真源**（规范 §6）—— 将来加一个字符串字段（label / 公式）时，
它会自动落到 `plain`（到点换值），不需要改任何判定代码。

这条分界必须守住：对普通字符串做颜色插值，会把"到点换值"变成
"中间出现一个谁也没写过的值"——那是**语义**上的错，不是精度上的错。
所以有断言专门守着"非颜色字符串在 color 模式下仍然跳变"。

### ★ 修的时候踩到自己的坑（值得记）

第一版写成 `mode === 'color' ? lerpColor(...) : lerpAtom(...)`，于是
**数值字段在 color 模式下整条失效**（`sampleTrack(数值轨道, 0.5, 'color')` 返回左端值）。
`mode` 描述的是"字符串那一支额外允许什么"，不是"只允许什么"。
现在 `blendAtoms` 的顺序是显式的：**先数值/向量 → 再颜色 → 否则放弃**。

### 实测（像素级，`SVA_PIXELS=1`）

关键帧 `#0000ff`(0s) → `#ffff00`(2s)，线性。每一刻都**精确命中**插值算出的色：

| t | 实测主色 | 期望 |
|---|---|---|
| 0 | `0,0,255` | 纯蓝 ✅ |
| 0.5 | `64,64,191` | 25% → `#4040bf` ✅ |
| 1 | `128,128,128` | 50% → `#808080` ✅ |
| 1.5 | `191,191,64` | 75% → `#bfbf40` ✅ |
| 2 | `255,255,0` | 纯黄 ✅ |

每帧 748 个纯色像素，所以"精确匹配"是可靠判据（宽 4px 描边的中心一定有纯色行）。

★ 这一轮我又在测试里写错了期望值（`#bfbfbf` 是灰，不是 75% 处的 `#bfbf40`）。
**是探针打出真实直方图之后才定位的** —— 先怀疑测试、再看数据，比反复读代码快得多。

---

## 0.13 第十四轮：P2 第三条 —— `moveAlong`（"把它送过去"）

**动因**：要让"数据包沿着箭头流进下一个方块 / 信号传到下一级"动起来，
此前只有一条路：读两个对象的坐标、自己算插值、写两条 `tf.x` / `tf.y` 关键帧。
那正是压力测试里出错最多的一环（世界单位与像素混用、端点算错、方向搞反）。
现在模型只需要说"沿那条线走"，**坐标算术留在引擎里**。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/registry/fields.ts` | `effect.moveAlong.params`：`source`（line 对象 id）/ `start` / `duration` |
| `engine-core/src/evaluate.ts` | `FrameCtx` 上下文重构 + `planMoveAlong()` + `tfOf()` 位置覆盖 |
| `engine-core/src/validate/validators.ts` | `move_along_source_missing` / `_not_line` / `_self` 三条 |
| `engine-core/src/command/{commands,apply,batch}.ts` + `journal/{store,invert}.ts` | `set_move_along`（第五处同步，见 §10） |
| `agent-tools/src/{tools,prompt,shot}.ts` | `add_effect` 第三支 + `set_move_along` 分支；提示词一节；`--preset flow` |
| 测试 | `move-along.test.ts`（31 条，含批处理 / 锁 / 撤销 / 镜头注视点）+ 像素 3 条 |

### ★ 判据一：位置必须进【世界矩阵】，不能加在画笔那一层

`moveAlong` 改的是这个对象的**位置**，而位置在世界矩阵里。所以覆盖点在
`tfOf()`（`anim.tf` 之上叠一层 x/y），而不是 `resolveEffects()` 里再算一个偏移量。
好处是**免费**得到三件事：子级跟着走、包围盒与命中测试一致、预览与导出同一份算术。
如果加在画笔层，这三件事各要一处特判 —— 而"预览 ≠ 成片"就是这么长出来的。

于是本条效果的**全部可观测后果**就一句话：`tfOf` 把 x/y 换掉。

### ★ 判据二：分两遍算（只读探测 + 主遍），不吃遍历顺序

第一版设计想在 `resolveEffects` 里顺手算位置。问题是算位置要知道"路径源在哪"，
而算路径源的世界矩阵又可能碰到另一个对象的位置 —— 变成边算边改缓存，
**结果取决于谁先被算到**，还可能成环。

现在 `planMoveAlong(doc, t)` 单独跑一遍：它用一个 `positions` 为空的**探测上下文**，
即"这一遍不认任何 moveAlong 覆盖"，只读、不改、不递归。
主遍拿到一张纯数据的位置表，再用它建矩阵。

代价是一条必须明说的边界：**"路径源自己也在被 moveAlong 驱动"这种叠法不支持**
（路径按源对象未被该效果驱动的位置算）。文档、提示词、注释三处都写了这条。
换来的收益是：无递归、无环检测、结果与遍历顺序无关 ——
而"结果依赖顺序"正是这类效果最容易长出来的隐蔽 bug。

### 语义口径（都有断言钉着）

| 场景 | 行为 | 为什么 |
|---|---|---|
| `start` 之前 | **停在路径起点** | "球在起点等着，然后出发"是想要的那件事。挂上它之后这个对象的 tf.x/tf.y 就完全被接管了 |
| `duration` 内 | 两端点之间线性插值（`ease` 只改节奏） | 直线路径在世界空间里是仿射的，线性插值**就是**沿路径走 |
| 走完之后 | **停在终点**，不会自己走回来 | 与 `highlight` 同一条口径：效果不自己回退 |
| 同类型多条 | 后定义的生效 | 与 `drawOn` / `highlight` 同一口径 |
| 对象自己的 rotate/sx/sy | **照旧生效** | 位置只跟平移有关：世界点过一遍父级矩阵的**逆**就是自己的平移量，自己的 R/S 不参与 |
| 位置的空间 | **世界空间**（钉在路径上） | 父级的平移不再影响它（但父级的缩放仍然作用在它的大小上）。这是刻意的：判据是"它在这一帧的画面上就在那条线上" |
| 与 `anim` 冲突 | 效果赢 | 它就是"手工写两条关键帧"的替代品，语义更具体 |
| 退化输入（source 空 / 不存在 / 不是 line / 父级矩阵不可逆） | 不动，**不抛异常** | 与求值路径的容错口径一致；问题由校验器报给人（不变量 4：模型不能自称例外） |

### ★ token 预算逼出来的一个取舍（写在 `tools.ts` 里）

`moveAlong` **只在 `add_effect` 里**，四条 `create_*` 的内联 effect 仍然只有两种。
理由不是"忘了加"：每支内联分支要在四条 create 分支里各复制一份，一支约 130 token、
四份 ~520，而 `apply_commands` 的余量正好是 ~520。
语义上也说得通 —— 它要引用一个**已经存在**的 line 当路径，本来就是"两个对象都存在之后"的事。
`schema-from-registry.test.ts` 里有一条断言守着这个结构，想加回来时它会告诉你动哪里。

同轮还发现提示词里那一串 ease 名字是**schema 的复制品**（`motion.key.ease` 已经带 enum），
按"唯一真源"的原则删掉了 —— 省下的额度正好付了新增那一节。

### 实测

`node packages/agent-tools/dist/cli.mjs --preset flow --no-agent --at 0.5,2.4,4.5 --out out/flow`
（新预设：结构图 + 一个沿箭头移动的小方块）

| t | 方块墨迹重心 x（世界 −3 → 像素 100） |
|---|---|
| 0.5（start 前） | ≈ 100（停在起点）✅ |
| 2.4（路中） | ≈ 160 ✅ |
| 4.5（走完） | ≈ 220（停在终点）✅ |

像素级断言用的判据是**某个颜色的墨迹重心**，而不是"某个窗口里有多少像素"：
重心对描边宽度、抗锯齿、图形大小都不敏感。

★ 顺带看到一件"不是 bug 但要提醒"的事：路径直接引用那条箭头时，
走完的方块会**压在箭头上**（终点就是箭头尖）。不想要就把线段的 `to` 收短一点。

### ★ 这一轮改掉的连带缺陷：`tf` 不再是"它在哪"的答案

这是本条效果的一个**副作用**，必须一起处理：在此之前 `obj.tf.x/y` 就是"这个对象在哪"，
而从此以后，一个挂了 `moveAlong` 的对象**位置与 tf 无关**。
于是所有"把 tf 当坐标读"的地方都变成了错的 —— 排查后找到一处真的：

`apply.ts` 的 `camera_preset`（给某个主体推镜头）直接读 `obj.tf.x/y` 当注视点。
给一个沿路径走的对象推镜头时，**镜头会对准一个它已经不在的地方**。
现在它问 `worldOriginOf(doc, id, t)` —— 与画面走的是同一套（动画 → 位置覆盖 → 父级链）。
"对象在哪"只有一个答案，命令层 import 求值层就是为了这一件事（求值层不认识命令层，不成环）。

### 这一轮发现的、还没修的缺陷
★★ **面板里效果的参数根本改不动 —— 这是不变量 3 的缺口，不只是 UI 问题。**
面板会**显示**每个效果的参数控件（`app.ts` 用 `groupFor(REGISTRY,'effect',eff.type,'params')`
渲染），但 `commandForPath()` 只认对象的 `style/tf/params`，
`eff#1.params.*` 一律返回 `null`，调用点写的是 `if (cmd === null) return;` ——
于是**拖了没反应，也不报错**。也就是说 `highlight` 从上一轮起就是这个状态，
`moveAlong` 只是又添了一个。
"人和 AI 共用一条 CommandBus"要求人能做的事 AI 都做得到、反之亦然；
现在人手改不了任何效果参数。修法很小（`commandForPath` 需要 `doc` 才能按 `eff.type`
派发到 `set_effect` / `set_highlight` / `set_move_along`），但属于另一块，没有混进这一轮。

★ **效果级的 `ease` 没有工具入口**：`progressAt` 读 `eff.ease`，引擎支持，
但 `set_effect` / `set_highlight` / `set_move_along` 三个分支都没暴露这个字段
（`inlineEffect` 也刻意省略了它）。要补就得三处一起补，约 150 token，
而 `apply_commands` 余量只剩 ~200 —— 等 `create_rect` / `create_line` 合并回去再说。

---

## 0.29 第三十轮：§0.28 的三份作业落地（自检 + 放开 token + API 编辑）✅

**用户原话**：「读取文件，根据交接文档继续完善内容」。
开工前按 §8 的要求把三个开放问题拍板了（答案见 §8），另外两问也一并定了：

| 问题 | 拍板 |
|---|---|
| 每镜图片预算 | **16 帧 / 6 次**（§0.28 表格写 24，但同节又提醒「8–16 帧，再多会稀释注意力」，取中位） |
| API key 存哪 | **只在服务端内存**（不落盘、不写回 `.env.local`、不进 localStorage） |
| baseURL 能不能改 | **能，但只限白名单**（官方 + 本机地址） |
| 费用怎么算 | **只算 token，不做金额**（我没查证过单价，不编数字） |
| 整片要不要跨镜摘要 | **要** |

---

### 一、作业 2：放开 token 上限

| 项 | 旧 | 新 | 位置 | 数字来自 |
|---|---|---|---|---|
| 单次渲染帧数 | 4 | **6** | `budget.ts` L1 | `L1_MAX_FRAMES` |
| 每镜图片 | 6 | **16** | `budget.ts` L2 | `L2_MAX_IMAGES` |
| 每镜渲染次数 | 3 | **6** | `budget.ts` L2 | `L2_MAX_RENDER_CALLS` |
| 上下文里的图片 | 3 | **16** | `budget.ts` L3 | `L3_MAX_IMAGES_IN_CONTEXT` |
| 聊天轮数 | 12 | **30** | `runtime.ts` | `DEFAULT_MAX_TURNS` |
| 整片每镜轮数 | 6 | **16** | `film.ts` | `DEFAULT_MAX_TURNS_PER_SHOT` |
| 摘要预算 | 1000 | **4000** | `projection/summary.ts` | `DEFAULT_SUMMARY_TOKEN_BUDGET` |
| 面板历史 | 4×400 | **12×1200** | `panel-server.ts` + `project.ts` | `HISTORY_MAX_ENTRIES/CHARS` |
| 输出上限 | **没传** | **显式 8192** | `deepseek.ts` | `DEFAULT_MAX_TOKENS` |
| 工具表上限 | 6400 / 5200 | **8000 / 7000** | `test/scene-tools.test.ts` | — |

★ **三个数字全部改成从常量插值**（工具描述、系统提示、断言）——
以前它们是手写的副本，而副本漂移的方向永远是「说明比实际上限小」。
`budget.test.ts` 的判据也改成「上限 + 1 被拒 / 正好到上限放行」，改上限只动一处。

★ **没有一并放开的**（§0.28 明确点名别动）：`apply_commands` 单批 15 条的**拆分建议**
（那是引擎的部分成功语义）、`fixClass` 规则、`autoFix` 边界。

★ **顺手补了 §0.28 四那句「一分钱不花」的欠账**：系统提示以前**一条画质规范都没有**。
现在有一节「画面规范」（字号下限 / 安全边距 / 重叠 / 越界 + 四条审美要求），
并且**提示词的绝对上限只从 3100 抬到 3600** —— 抬之前先删掉了一处与节首重复的说明。

---

### 二、作业 1a：layout 组的【表现层】自检

在此之前这一组**只有两条**判据（整段都在画外 / 整段都太小），
所以 Agent 的自检只能回答「引擎与形状对不对」，回答不了「画得对不对」。
新增四条（全部 `fixClass: agent`、`group: layout`）：

| code | 判据 | 阈值 |
|---|---|---|
| `text_clipped` | 文字/公式每一帧都有 > 25% 的面积在画布外 | `MAX_CLIPPED_FRACTION` |
| `text_too_small` | 字号低于可读下限（文字 16px / 公式 18px） | `MIN_READABLE_FONT_SIZE_PX` |
| `text_in_safe_margin` | 完全在画内但离边缘 < 24px（每一帧都如此） | `SAFE_MARGIN_PX` |
| `text_overlap` | 两个可读元素的盒子每一帧都压着（≥15% 重叠） | `MIN_OVERLAP_RATIO` |

★★ **三条设计决定，都不是随手定的**：

1. **只对可读元素（文字/公式）生效。** 曲线穿过画面边缘、填充区域互相叠压都是构图常态，
   而「半个标题在画外」「两块文字压在一起」无论怎么看都是缺陷。
   把判据挂在**可读**这个语义上，比按形状名单打补丁更不容易长出假阳性。
2. **判据一律写成「每一个看得见的采样都成立」。** 宁可少报，不可乱报 ——
   一个「每帧都被裁」的标题是真缺陷，一个「滑入过程中有一帧贴边」的标题不是。
   §0.28 作业 1 的验收第 2 条（已经合格时不许瞎改）防的就是这个。
3. ★★ **旧的 `object_too_small` 从可读元素上摘掉了。**
   它的判据是「屏幕边长占比 < 0.02」，在 1920 宽的画布上**等于 38px** ——
   于是所有小于 38px 的标注都会被误报成「几乎是看不见的」，而模型会照着它去放大
   一份本来合格的画面。**文字的可读性由字号决定，不由它占多少屏幕决定。**

★ 顺带把 `validateLayout` 的求值从「每个对象各算一遍」（100 个对象 = 500 次 evaluate）
改成「每个采样时刻算一遍」—— 不只是快，更因为**跨对象**的重叠检查在旧结构里根本写不出来。

---

### 三、作业 1c：不看画面就不许收尾（**被真调模型改了两次设计**）

**第一版**（照 §0.28 作业 1c 的字面）：`render_frames` 与 `get_render_state` **都**算「看过」。

**真机跑出来的结果**（`SVA_ACCEPTANCE=1`，真调模型）：

```
轮数=5 工具序列=["get_scene_summary","get_render_state","apply_commands",
                "apply_commands","validate","get_render_state"]
预算={"imagesUsed":0,"imagesLeft":16,"renderCallsLeft":6}
```

**render_frames 一次都没有、0 张图，而它照样通过了关卡、干净地收尾了。**
教训一句话：**只要有一条便宜的路能过关，模型一定走便宜的那条。**
而「闭着眼睛画」正是这一轮要治的病。

**第二版**：关卡收紧成**必须真的渲染过至少一帧**。`get_render_state` 仍然有用
（判重叠/越界它更划算），但它不再能替代「看一眼画面」。代价是每镜至少 323 token ——
用户已经拍板「比起节省 token，我更想要画面效果」。

**收紧之后又撞到第二条后门**：

```
模型必须真的渲染过一帧：["get_scene_summary","get_render_state","apply_commands",
                          "apply_commands","validate"]
```

模型连着三轮把 issues 清成 0，**Runtime 自己的兜底规则**（`clean_three_turns`）
在它看画面之前就把这一镜结束掉了。收尾关卡管得到 `finish_shot`，
管不到 Runtime 的兜底 —— 于是「强制看画面」被从后门绕了过去。
**修法：两条兜底收尾多了一个共同前提 `sawFrame || !canStillRender`。**
★ 这是一条通用教训，已进 §9 坑表：**一条判据只要有几个出口，就必须挂在所有出口的共同下游上。**

**第三版（现在）**：真机验收全绿 ——

```
[P6] 轮数=6 工具序列=[…,"get_render_state","render_frames"] 预算={"imagesUsed":1,…}
```

★ 另有两个配套件，都为了「不许看起来像成功」：
- `finishReport()`（纯函数）：`finish_shot` 的回执是 JSON，**给人看的那句话由它产出**。
  以前面板最后显示的是 `{"status":"finished",…}`，读起来像成功，
  而「还有 3 项 layout 缺陷没解决」在那一行里根本看不见。现在收尾话术必须说
  「⚠ 还有 N 项没达标（…）—— 这份镜头【不算完成】」。
- `BLIND_FINISH_WARNING`：额度连一帧都渲染不起时关卡**放行**（否则困死在轮数上限里），
  但「这一镜从未渲染过一帧」由 `runShot` 末尾**统一**追加 —— 实测模型压根没走到
  `finish_shot`，是被兜底收尾的，所以这条警告不能只写在 `finish_shot` 的回执里。

---

### 四、作业 1b：独立视觉评审 `critique_frame`

**为什么是独立一次调用**：画家与评审若是同一次对话，它会自洽地放过自己的问题 ——
这个项目里这类失败出现过不止一次（「结构断言全绿，画面里 2π 却是豆腐块」）。

- 新工具 `critique_frame { t, intent?, checklist? }`：渲染该帧（走同一套图片预算）
  → 换一条**只做评审**的系统提示、只看这一帧 → 回**结构化**清单
  （`code` 取自 10 个判据的封闭词表 / `severity` / `detail` / `fixHint`）+ `verdict`。
- **评审不开思考**（`thinking: disabled`）：它是看一眼就下结论的活，开思考贵 3.7 倍。
- ★ **抗过度修正写在提示词里**：「没看到问题就回 pass 且 findings 为空，不要为了显得
  有用而硬找问题」—— 并有断言守着这句话存在。
- ★ **判据以证据为准，不以自评为准**：模型说 `pass` 却列了 warn/error，按 `needs_work` 处理；
  只有 info 级意见时仍算 `pass`（别把「可以更好」变成「必须改」）。
- ★ **解析失败必须如实报**（`unparsed: true` + 把评审原话带回来）——
  「评审没意见」与「评审的回执我们没读懂」长得一模一样，是这一族里最坏的失败。
- **终止条件**（§0.28 作业 1 要求的那条）：评审**连续两轮没有改善**就停
  （`critiqueStalled`：窗口起点还有问题 + 三个问题数单调不降），
  并如实说「还有 N 项没达标」。判据只用**评审自己报的问题数** —— 它可数、可断言，
  不依赖「模型说它改好了」。

★ 评审的用量**并进本轮的 token 总账**（run.ts / multi-shot.ts 各一处闭包）。

---

### 五、作业 3：前端「API 编辑」

| 端点 | 作用 |
|---|---|
| `GET /api/settings` | 当前设置（key 只回 `sk-…abcd` + `hasKey`，**绝不回原文**） |
| `POST /api/settings` | 改 baseUrl / model / API key（**只在服务端内存**） |
| `POST /api/settings/test` | 发一次最小请求，如实报 状态 / 延迟 / 模型回执名 |
| `GET /api/health` | 多了 `limits` 一节（面板**不抄第二份数字**，沿用 `reasoningOptions` 的先例） |

- **key 只存内存**：服务重启就没了。刻意如此 —— 明文落盘的风险远大于「重填一次」。
- **baseURL 白名单**：只允许 http/https、不许带用户名密码、主机必须是
  `api.deepseek.com` 或**本机地址**。★ 校验在**发请求之前**做，
  于是「错的 baseURL」不会变成一次内网探测（有断言：`fetchImpl` 一次都没被调用）。
- **一处非法就整批不动**，并把每一条原因说出来 —— 静默的「部分成功」是设置类功能最坏的行为。
- **测试连接分三类失败**：错的 key（`auth`）/ 错的地址（`bad_url`）/ 超时（`timeout`），
  措辞互不相同。混成一句「连接失败」等于让人自己猜。
- 页面：聊天窗口顶部一个**默认折起**的「API 设置」（baseURL / model / key / 保存 / 测试连接 / 清除 key）。
  key 那一栏**永远是空的**，只把掩码写在 placeholder 里。
- **费用**：按用户拍板**只算 token**。面板把三类分开报：
  `输入 12,000（缓存 8,000）· 输出 1,200（思考 900）· 图片 4 帧` ——
  图片 0 帧也照样报（那正是「模型没看画面」的唯一数字证据）。
  ★ 为此 `deepseek.ts` 的 usage 从两个数扩成 `TokenUsage` 六个数
  （缓存命中 / 未命中 / 思考 / 图片帧数），并且缓存未命中**缺字段时自己算**，
  保住 `cached + uncached === promptTokens` 这条恒等式。

---

### 六、跨镜交接摘要（用户拍板「要」）

在此之前**每镜的 Agent 完全没有历史**，只能从文档反推前面的视觉语言，于是各自发挥。

- `handoffSummary(doc, sceneId, run)`（纯函数）：**事实从文档里推导** ——
  本镜有几个对象（id + shape）、用到的主色、字号；**再附上它自己的结论**（截断 160 字）。
  ★ 事实部分刻意不让模型自己写：模型写的交接摘要会漂（它描述的是**想做**而不是**做了什么**）。
- 上限 `HANDOFF_MAX_ENTRIES = 4`：它是风格一致性的**锚**，不是完整历史。
- `history` 那一段的**标题现在可配**：同一份 history 有两种来源（同镜的上一轮 / 前面几镜的交接），
  **标题说错比不说更糟**（模型会以为那是它自己的历史）。

---

### 七、真接口 / 真模型验了什么（这一轮的验证账）

| 验的东西 | 怎么验 | 结果 |
|---|---|---|
| 加宽后的工具表（含 `critique_frame`） | `SVA_ACCEPTANCE=1` 金丝雀，整表发真接口 | **200**，无 `Invalid tool parameters schema` |
| `max_tokens=8192` + 思考 + 工具 | 新增一条金丝雀 | **200**（★ 以前从没验过这个字段） |
| 单镜端到端「必须看画面」 | p6 验收（真调模型） | 轮数 6，序列里有 `render_frames`，`imagesUsed=1` |
| 预算耗尽时的诚实收尾 | p6 验收第 2 条 | 每次都拿到 `L2_images_exhausted`，额度 0 被静默消耗，收尾话术含「从未渲染过一帧」 |
| 多 Agent 逐镜串行 | multi-shot 验收（真调模型） | 两镜都「收尾=正常」，归属正确，**无截断** |
| 白名单不外泄 | `/api/settings/test` 拿元数据地址 | `bad_url`，且 `fetchImpl` **一次都没被调用** |
| **面板实机（真 Chrome、真鼠标）** | `verify-panel.mjs`（要 danger-full-access） | **51/51 全绿** —— 加了「API 设置」那一块之后面板的回归网没有一条红 |
| 面板 bundle 能建出来 | `serve-panel.mjs` 启动时的自动打包 | 成功（30 万字节，里面确实有新的设置 UI） |
| 新端点真的在跑 | 起一台真服务直接打 | `/api/health` 报出 `limits`（6/16/6/16/12/1200）；`/api/settings` 只回 `sk-…731a`；非白名单 baseURL → **400 + 说清理由 + 设置一点没动** |

---

### 八、新基线（下一轮起点）

| 项 | 值 |
|---|---|
| 门禁 | typecheck / eslint / **vitest 75 文件 / 1074 passed**（+49 skipped） |
| 固定开销 | 系统提示 **3575** · 工具表 **6459**（`apply_commands` 4920）· 比例 **1.81×**（上限 2.6×） |
| 上限 | 工具表 < 8000 · `apply_commands` < 7000 · 系统提示 < 3600 |
| 图片预算 | 单次 ≤ 6 帧 · 每镜 ≤ 16 张 / 6 次 · 上下文 ≤ 16 张 |
| 轮数 | 聊天 30 · 整片每镜 16 |
| 真调模型 | 单镜 6 轮 / 1 帧；整片 2 镜 4.8 万 + 6.1 万输入，无截断 |

★ 五个实机脚本仍然都要 `danger-full-access`（Chrome 在 Windows 上要命名管道）。
★ **改了 `tools.ts` / `runtime.ts` / `panel-server.ts` / `film.ts` / `multi-shot.ts` / `run.ts`
之后必须重建 bundle**（`node packages/agent-tools/build-cli.mjs`）——
面板 bundle 由 `serve-panel.mjs` 启动时自动重建。

---

### 九、这一轮踩到 / 纠正的坑（已进 §9 坑表）

1. ★★ **只要有一条便宜的路能过关，模型一定走便宜的那条。** 判据写宽一格，
   效果就等于没做（`get_render_state` 版「看过画面」）。
2. ★★ **一条判据有几个出口，就要挂在所有出口的共同下游。** 关卡加在
   `finish_shot` 上，Runtime 的兜底收尾从后门绕了过去。
3. ★ **两个判据会互相打架。** 新的「字号 ≥ 16px」与旧的「屏幕占比 ≥ 0.02」
   （1920 宽下等于 38px）同时生效时，一份合格的 18px 标注会被报成「几乎看不见」。
   加判据之前先问一句：**它和已有的那条会不会在同一件事上给出相反的结论？**
4. **自己写的探针也会错**：`checkRender([L1_MAX_FRAMES])` 是「一个元素」，
   不是「L1_MAX_FRAMES 个帧」—— 测试里差点因此把一个正确的拒绝判成 bug。
5. **总 token 与拆开的 token 不能相加两次**：图片的 token 已含在 `promptTokens` 里、
   思考 token 已含在 `completionTokens` 里。界面上分开报，但求和只能取两者。

---

## 0.28 第二十九轮：token 账的实测分析 + 下一轮的三份作业单（**未改任何代码**）

> ★★ 这一轮**只做了分析**，一行代码都没动。下面三项是**下一轮要做的事**，
> 不是已完成的事 —— 别把这一节读成「已经做好了」。
>
> ✅ **下一轮（第三十轮）把它们全做完了，见 §0.29。** 这一节保留原样作为
> 「先量再动手」那份分析的存档 —— 里面的实测拆账与六处上限清单仍是判断依据。

**起因**：用户说「模型有点傻，可能是限制 token 导致任务下发不够完全」，并且明确
**「比起节省 token，我更想要画面效果；我用的是 deepseek v4 flash，并不贵」**。
我先量了一遍才回答 —— 结论是**假设大部分不成立，但确实存在「为了省 token 砍掉了能力」**，
只是砍错了地方。

### 一、每次请求到底装了多少（实测拆账）

| 组成 | 量级（token） | 出处 |
|---|---|---|
| 系统提示 | **2940** | `agent-tools/src/prompt.ts`（全是命令语法 / id 规则 / 坐标系） |
| 工具表 | **6099**（`apply_commands` 一个占 **4920**） | 每轮原样重发 |
| 任务文本 + 历史摘要 | ≤ ~500 | 历史只有 4 条 × 400 字（`app.ts` 的 `slice(-4)`） |
| 工具回执 | ~1–2k | `get_scene_summary` 硬预算 1000 封顶 |
| 图片 | 现在 ≤ 3×323 ≈ **1k** | L3 只在上下文里留 3 张 |
| **合计** | **约 10–13k / 次** | 实测：面板 3 轮 = **32,534**；整片 9 次调用 = **96,196** |

★ **85% 的输入是固定开销，文档与回执加起来才一两千。窗口远没用满** ——
所以「塞不下导致任务下发不完全」这个机制**不成立**。
★ 文档本身**从不进提示词**：模型只能通过工具读取它（这是对的，但也意味着
「模型没看见」永远发生在**工具回执**那一层，而不是提示词那一层）。

### 二、图片到底多贵（这一轮现测的，之前所有人都只是猜）

自造 PNG 直连 `api.deepseek.com/beta`，同一个问题分别带不同图：

| 内容 | prompt_tokens |
|---|---|
| 纯文字基准（不带图） | 9 |
| **960×540 纯色（= 我们画面的典型样子）** | **323** |
| 960×540 随机噪点（高熵，文件 427KB） | **323**（一样） |

★★ **一帧固定 323 token，与画面复杂度无关**（说明是按 tile 计费，不是按字节）。
换算：**一次固定开销（9039）能换 28 帧画面**。
而现在的规则是每镜最多看 6 帧、同屏只留 3 帧 —— **模型基本是闭着眼睛画**。

**顺便确认了一件更基础的事：视觉是通的。** 自造一张 64×64 纯红 PNG 问它
「这张图是什么颜色？」，回 `红色`（status 200，202 prompt_tokens）。
→ 所以「模型看不看得见图」**不是**问题；问题是我们**几乎不给它看**。

### 三、真正在砍信息的六处上限（按对画质的影响排序）

| # | 上限 | 现在 | 位置 | 症状 |
|---|---|---|---|---|
| ① | 图片预算 | 单次 4 帧 / **每镜 6 帧、3 次调用** / **上下文只留 3 帧** | `agent-tools/src/budget.ts`（L1/L2/L3） | 看不见自己的画面，靠文字想象 |
| ② | 轮数 | 面板 **12**、整片每镜 **6** | `runtime.ts` 的 `DEFAULT_MAX_TURNS`、`panel-server.ts` | **实测两次整片验收都被它截断**（一次 8 轮、一次每镜 4 轮） |
| ③ | 摘要预算 | **1000 token**，尾部截断 | `engine-core/src/projection/summary.ts` | 约 50–60 个对象触顶；实测整片第 2 镜**连着 10 次 `get_object`** |
| ④ | `get_object` 漏字段 | 无条件带 `params` | `engine-core/src/projection/objects.ts` | 公式对象的 `paths` ≈ 20KB ≈ **5–6k token**，而模型**永远改不动它** |
| ⑤ | 记忆 | 4 条 × 400 字；**整片每镜 0 历史** | `app.ts`、`multi-shot.ts` | 跨轮/跨镜没有连续性，风格一致无从谈起 |
| ⑥ | 输出上限 | **从来没传 `max_tokens`** | `deepseek.ts`（body 里没这个字段） | 用网关默认值；**思考 token 与工具调用共享这个额度**，长批次可能被截断 → `arguments` 非法 JSON → runtime 按 `{}` 处理 → 看起来像「模型乱调」 |

### 四、哪些「傻」跟 token 无关（别在错的地方花钱）

- **能力缺口**：`delete_object` 曾经在引擎里有、工具表里没有（模型只能猜名字）；
  **`delete_effect` 至今如此**。这是「token 预算卡住新工具」的直接后果 —— 省钱换走的是能力。
- **判据问题**：空跑被记成「做完了」（§0.25 已修）。
- **提示词里一条画质规范都没有**：2940 token 全在讲怎么调命令，**没有任何一句**讲
  「画面怎么才好看」（安全边距、最小字号、元素数量上限、对比度、留白）。这条一分钱不花。

### 五、下一轮的三份作业单

#### 作业 1：Agent 自检（第一次输出后主动找不合格处 → 针对性地重画 → 直到合格）

**已经有的**（别重做）：`validate()` 出 issue 清单（带 `fixClass`）；`autoFix()` 自动修机械问题
（`agent`/`human` 类**绝不**自动修）；`judgeTurn` 在「issues 归零且稳定」时收尾；模型可调 `finish_shot`。

**缺的**：**表现层**自检 —— issue 里没有「文字出画 / 被裁 / 字号太小 / 两个元素重叠 / 对比度低」这类
「画得不好看」。所以自检要做的是**画面 vs 意图**，不是引擎 vs 形状。

**三条可选实现（建议 (a)+(b) 组合，别只做 (b)）**：

- **(a) 规则化自检（最省事、最可测，先做这个）**：`validate` 已经分组了
  （`environment` / `semantic` / `motion` / `layout` / `export`），把「出画、被裁、最小字号、
  安全边距、重叠」做成 **`layout` 组的 issue** —— 于是自检＝复用现有的 validate + autoFix 通道，
  **不引入新循环**。下一轮第一步：先查 `layout` 组现在到底有什么。
- **(b) 视觉评审**：新增工具 `critique_frame { t, checklist }` → 服务端渲染该帧 + 让一次
  **独立的评审调用**（换一条系统提示，回**结构化**问题清单）→ 主 Agent 按清单改。
  ★ 独立调用的理由：画家和评审若是同一次对话，它会自洽地放过自己的问题。
- **(c) 强制节奏**：`finish_shot` 之前必须至少看过一次画面（`render_frames` 或 `get_render_state`），
  否则拒绝收尾。**这条最便宜，也最直接地治「不看就交」。**

**必须钉住的约束**：
1. 判据要**可执行**，不能只是「让模型自己说好不好」；
2. 要有**终止条件**：轮数上限（与作业 2 联动）+ 分数阈值 + 「连续两轮无改善就停并如实报告」；
3. **防过度修正**：已经合格时不许改 —— 要能输出「没问题」，而不是硬找问题；
4. 自检结果要**进聊天**（人看得见）并**进 Journal**（能撤销、能回看哪一轮因为什么改了）。

**验收标准（写成可执行断言，不靠肉眼）**：
- 造一份**故意不合格**的文档（文字出画 + 字号 8 + 两个矩形重叠）→ 跑一轮 →
  **Agent 自己**发现并修好（断言文档而不是断言话术）；
- 给一份**已经合格**的文档 → 跑一轮 → 断言它**没有**做无意义改动（版本不变）；
- 轮数内没修好时，收尾话术必须如实说「还有 N 项没达标」（**不许看起来像成功**）。

#### 作业 2：开放所有 token 上限（用户拍板：效果优先，flash 不贵）

**要动的地方（逐处）**：

| 目标 | 现在 | 建议 | 文件 |
|---|---|---|---|
| 每镜图片 | 6 帧 / 3 次 | **24 帧 / 8 次** | `budget.ts` L2 |
| 上下文字图片 | 3 张 | **16 张** | `budget.ts` L3 |
| 单次帧数 | 4 | **6** | `budget.ts` L1 |
| 聊天轮数 | 12 | **30** | `runtime.ts` `DEFAULT_MAX_TURNS` |
| 整片每镜轮数 | 6 | **16** | `panel-server.ts` |
| 摘要预算 | 1000 | **4000** | `projection/summary.ts` |
| 面板历史 | 4×400 | **12×1200** | `app.ts`、`panel-server.ts` |
| 输出上限 | **没传** | **显式 8192 / 16384** | `deepseek.ts` |
| 工具表上限 | 6400 / 5200 | **8000 / 7000**（放宽而不是删） | `test/scene-tools.test.ts` |

★ **不是所有上限都该放**（另一半是「注意力/防失控」而不是成本，别顺手全删）：
- **别动**：`apply_commands` 单批 ≤15 条的拆分**建议**（那是引擎的部分成功语义，不是成本）；
  `validate` 的 `fixClass` 规则；`autoFix` 的边界。
- **小心**：图片放太开会**稀释注意力**（模型可能忽略文字回执）。建议每镜 **8–16 帧**
  ＋在提示词里明说「重点看第 N 帧」，而不是无脑 50 帧。

**成本量级（按实测口径）**：图片放到 24/镜 ≈ +7.8k/镜；轮数翻倍 → 整片一次约 20–30 万输入。
按 flash 的价位是**分/角级**（具体单价以用户账单为准，我没查证过单价表）。

**验收标准**：
- 一次整片（4 镜）**不再出现** `truncated: true`；
- 每镜日志里至少 **2 次** `render_frames`（模型真的在看画面）；
- 与作业 3 联动：把「输入 / 输出 / 图片」三类 token **分开报出来**（现在只有一个总数）。

#### 作业 3：前端「API 编辑」+「费用计算」

**(3a) API 编辑**

现状：key 只能来自环境变量或 `.env.local`（`resolveApiKey`）；model 只能来自 `--model`；
baseURL **写死在 `deepseek.ts`**（`DEEPSEEK_BETA_URL`）且没有任何页面入口；
页面上只有推理档位能改（§0.24）。

要做：页面上加一块「API 设置」：`baseURL` / `model` / `API key`（掩码）/ `reasoning`，
外加一个**「测试连接」**按钮（发一次最小请求，如实报 status、延迟、model 回执名）。

★★ **三个必须先拍板的问题（写进 §8，别自己决定）**：
1. **key 存哪**：① 只存内存（刷新即失效，最安全）；② `out/settings.json`（明文落盘）；
   ③ 写回 `.env.local`（与现有约定一致，但会改用户的文件）；
   ④ **不要** localStorage（明文 key 进浏览器，而页面 URL 是可以分享的）。
2. **`baseURL` 可编辑 = 服务端替人发任意请求（SSRF 面）**：要么白名单/仅本机，
   要么明确写「这是本地工具，风险自负」。
3. **密钥回显**：GET 只回 `sk-…abcd` 掩码 + `hasKey`，**绝不回原文**。

**(3b) 费用计算**

现状：`/api/chat` 与 `/api/film` 已经回 `usage: {promptTokens, completionTokens}`，
面板已经显示「token N」（`app.ts` 的「本轮：… token N」）。**缺的只是钱。**

要做：一张**页面可编辑的单价表**（每百万 token 的输入 / 输出 / 缓存命中三种价），
累计到「本轮 / 本镜 / 本次会话 / 本工程」，显示 ≈¥x 并注明是估算。

**四个实现要点**：
1. **缓存命中要分开计价**：实测回执里有 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，
   两者差价很大，合并计价会明显偏高；
2. **思考 token 按输出价**：它在 `usage.completion_tokens_details.reasoning_tokens`，
   已经计入 `completion_tokens`；
3. **图片不必单独计价**（实测 323 token/帧，已含在 prompt_tokens 里），
   但要在界面上**显示「其中图片 N 帧 ≈ M token」**，否则看不懂钱花在哪；
4. **费用进工程文件**（便于对账），并区分「这份工程自己花的」与「浏览器累计」。

**验收标准**：
- 页面上改 model / baseURL 后，**下一轮请求真的用新的**（抓请求体断言，别只看界面）；
- 「测试连接」三类失败都要如实报：错的 key / 错的 baseURL / 超时；
- 一次 3 轮聊天后费用 ≈ 手算值（±1%），且能在工程文件里查到；
- 改单价后**历史累计立刻重算**（说明单价只影响显示层，不改 token 记账）。

### 六、建议的动手顺序

1. **作业 2 的「图片预算 + 轮数 + `max_tokens`」**（改动最小、立刻能用整片流程验收）；
2. **作业 1 的 (a) 规则化自检 + (c) 强制看画面**（复用 validate/autoFix，不引入新循环；
   而且它是「合格/不合格」的判据来源，作业 2 的效果要靠它量化）；
3. **作业 1 的 (b) 视觉评审**（依赖第 1 步放开的图片预算）；
4. **作业 3**（与上面三条完全独立，可以并行）。

### 七、别丢的现状数字（下一轮的基线）

| 项 | 值 |
|---|---|
| 门禁 | typecheck / eslint / **vitest 66 文件 / 973 passed**（+48 skipped）；`SVA_PIXELS=1` 时 56 passed |
| 固定开销 | 系统提示 2940 · 工具表 6099（`apply_commands` 4920）· 比例 2.07×（上限 2.6×） |
| 面板实机 | `verify-panel.mjs` **51/51**（基线文档 `out/panel-demo.json`） |
| 时间轴实机 | `verify-timeline.mjs` **24/24** |
| 推理档位实机 | `verify-reasoning-ui.mjs` **12/12** |
| 整片实机 | `verify-film-ui.mjs` **15/15** |
| 工程文件实机 | `verify-project-ui.mjs` **25/25** |
| 真调模型（本轮之前） | 整片 2 镜：31 秒 / 9.6 万输入 / 7.6 千输出 / 25 对象 / 0 issue；一句话硬跑整片：29.8 万输入 / 115 秒 / **被截断** |

★ 五个实机脚本**都要 `danger-full-access`**（Chrome 在 Windows 上用命名管道做 Mojo IPC，
受限沙箱下它会 FATAL 退出、连 `DevToolsActivePort` 都写不出来）。用法见 §0.27 / §0.22 的小节。
★ 起服务最省事的办法：双击仓库根的 **`start-panel.cmd`**（首次会自动装依赖 + 建 bundle）。

---
## 0.27 第二十八轮：工程文件（含上下文）+ 双击启动 ✅

**你的原话**：「添加一个项目保存的功能（包含上下文），来快速导入或导出项目工程，再写个脚本来双击打开这个 agent」。

### 工程文件：文档只是一半，另一半是上下文

```json
{
  "format": "sva-project",
  "formatVersion": 1,
  "savedAt": "2026-09-25T12:34:00.000Z",
  "doc": { ...整份 Scene Doc... },
  "context": {
    "chatHistory": ["用户说「…」。结果：3 次写入。之后文档里的对象：…"],
    "chat": [{ "role": "user", "text": "…" }, { "role": "tool", "text": "…", "name": "apply_commands", "turn": 2 }],
    "reasoning": "high",
    "filmMode": false
  }
}
```

★ 为什么必须带上下文：`chatHistory` 就是**下一轮发给 Agent 的背景**。只存文档的话，
打开工程之后 Agent 对你的项目一无所知 —— 「接着上次干活」这句话根本不成立。
聊天里那些行也一起存（打开后接着看），推理档位与整片模式同理。

### 三条设计决定

1. **打开 = 换一份工程，不是一次编辑。** 新的 Journal（撤销栈从零开始）、
   新的提案存储（旧提案属于上一份文档，留着会出现「批准一条指向已不存在对象的提案」）。
   ★ 这句话会**明说给用户**：「撤销栈已重置 —— 这是一份新工程，不是一次编辑」——
   「以为还能撤销」是很贵的误会。
2. **格式版本只往【上】认**：比我新的工程文件一律拒收并说清版本号，
   而不是「试着读读看」。**半读进去的工程比打不开更糟**（用户以为打开成功了）。
3. **自动存档是尽力而为 + 恢复是显式的**：每 900ms 防抖写一次 localStorage（刷新不丢工作），
   但配额爆了/隐私模式就安静放弃，绝不打断编辑；所以**不搞「打开就自动盖掉」**，
   而是把顶栏的「恢复上次」点亮（有存档才亮，没有时是灰的）。

### 双击启动

仓库根目录的 **`start-panel.cmd`**：双击即用。它做三件事 ——

1. `cd` 到自己所在的目录（`%~dp0`，放哪儿都能用）；
2. **第一次运行**时自动 `pnpm install` + 构建 bundle（`dist/serve-panel.mjs` 不存在就建）；
3. 起服务并打开浏览器；窗口关掉 = 服务停掉。

可选参数：`start-panel.cmd out\showcase.json`（不给就用 `out/showcase.json`，再不行退回 `out/panel-demo.json`）。

★ 两处刻意的写法：
  - **`chcp 65001` + 文件内容全 ASCII**：cmd.exe 按【当前代码页】读自己的脚本，
    中文混在 .cmd 里是稳定的乱码来源；界面上的中文由 node 打（那部分是 UTF-8，没问题）。
  - `title` / `pause` / `goto :failed`：双击运行时窗口不会一闪而过，出错也留得住信息。

### 实测

| 项 | 结果 |
|---|---|
| 单测 `project.test.ts` | ✅ **10 条**：往返（文档 + 上下文都不丢）、超量夹取、四种坏输入、文件名洗字符 |
| 实机 `verify-project-ui.mjs` | ✅ **25/25**：三个按钮在位、工程 JSON 内容、保存报文件名、打开后文档/档位/整片模式/聊天行**一起换掉**、坏文件被拒**且不动文档**、localStorage 自动存档、刷新后「恢复上次」点亮并真的恢复 |
| 双击启动 | ✅ 直接 `cmd /c start-panel.cmd` 跑通（ASCII 横幅无乱码、自动重建 bundle、起服务、拉起 Chrome） |
| typecheck / eslint / vitest | ✅ 全绿（**66 文件 / 973 passed**） |

### ★ 实机抓到的一个真缺陷（老坑的新变体）

刷新后的「有存档」提示**不见了**，而按钮还是亮的 —— 看起来像「有存档但没人告诉我」。
根因：createPanel 末尾的 `resetChatHint()` 会 `chat.reset(...)`，把开机时贴的那一行**清掉**。
改成：开机只准备文案，等 `resetChatHint()` 之后再贴。
**「谁最后写这个容器」这个问题，在这个项目里已经踩到第三次了**（前两次见 §9 的 DOM 复用那几条）。

### 还没做的

- **多个存档槽 / 服务端项目目录**：现在导出走浏览器下载、导入走文件选择框；
  如果想要「项目列表 + 一键切换」，得在服务端加 `out/projects/` 与两个接口；
- **自动存档只有一份**（最近一次），没有历史版本；
- **撤销栈不进工程文件**：打开即重置（见上面的决定 1）。

---
## 0.26 第二十七轮：把「整片」接进面板（导演分镜 → 逐镜生成）✅

**你的原话**：「为我接上面板」。指的就是 §0.25 结尾那条 ——
`multi-shot.ts` 早就能逐镜串行跑，缺的是「任务从哪来」与「面板怎么用」。

### 形状：两条路，一个输入框

| | 单镜（默认） | 整片（打勾） |
|---|---|---|
| 入口 | 聊天窗口 | 同一个输入框 + 勾上「整片」 |
| 服务端 | `POST /api/chat` | `POST /api/film` 起作业，`GET /api/film/<id>` 轮询 |
| 流程 | 一个 Agent 跑一轮 | 导演分镜 → 清空 + 建分镜 → 每镜一个场景 Agent → 汇总 |
| 成本量级 | 几秒 / 几千 token | 几十秒 / 十万 token 级 |

★ 默认【关】：整片比单镜贵几十倍，而面板里绝大多数操作是「改一下这条曲线」。
打勾后发送按钮会变成「生成整片」—— 按下之前就得知道这一下要花多少。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `agent-tools/src/film.ts` | **新模块**：`PLAN_TOOL`（独立的小 schema）+ `DIRECTOR_PROMPT` + `parsePlan`（纯函数）+ `planToCommands`（纯函数）+ `planFilm` + `runFilm` + `FilmRegistry` |
| `agent-tools/src/multi-shot.ts` | `RunMultiShotOptions.journal`：允许复用调用方的 Journal（否则清空那一步会落在另一条历史里，面板拿到的 entries 缺一段） |
| `agent-tools/src/panel-server.ts` | `POST /api/film`（起作业，立刻回 id）+ `GET /api/film/<id>`（进度；完成时一并给 doc 与 entries） |
| `panel/src/app.ts` | 整片开关、`runFilmBrief`（起作业 → 900ms 轮询 → 事件逐条贴进聊天 → 完成后把 entries 搬进 Journal）、`FilmProgress` 契约、`chat.setSendLabel` |
| `panel/src/chat.ts` | `setSendLabel`（发送 / 生成整片） |
| `panel/index.html` | 开关与分隔线的样式 |
| 测试 | `film.test.ts` **10 条**：纯函数 8 条 + **服务端端到端 1 条（stub 掉模型，真起服务、真走 HTTP、真落文档）** + tool_choice 约束 1 条 |
| `agent-tools/dist/verify-film-ui.mjs` | **新实机脚本**：勾开关 → 起作业 → 轮询 → 断言聊天里贴出了什么，15 条断言（劫持 fetch，不花钱） |

### ★★ 真调模型抓到的第二条 API 约束（文档里没写）

`tool_choice: 'required'` 与**思考模式不能同时用** —— 服务端直接 400：

```
Thinking mode does not support this tool_choice
```

我第一版导演就是「思考 + required」，两次真跑都在 1 秒内失败（错误信息藏在作业的 `error` 字段里，
所以第一反应是「作业根本没跑」）。现在改成**两次尝试**：先「思考 + auto」（分镜确实吃推理），
没调工具再退到「不思考 + required」（这是唯一能强制产出分镜的组合），两段用量相加。

### 实测：真调模型的整片（`--reasoning high`）

| 阶段 | 结果 |
|---|---|
| 导演分镜 | 《AI Agent 是什么？》1. 左右分屏立题（5s）· 2. 一问一答（6s） （**给多了 3 条，如实报告已丢弃** —— 探针把 maxShots 限成了 2） |
| 清空 + 建分镜 | 成功 **9** 条（删 5 个对象 + 删 1 个效果 + 复用/改名/补镜 + 定片长） |
| 第 1 镜 | 写入 **28** 条 · 4 轮 · 版本 9→37 |
| 第 2 镜 | 写入 **12** 条 · 4 轮 · 版本 37→49 |
| 收尾 | 2 镜（`@0` / `@5`）· 片长 11s · **25 个对象** · 49 个操作 · **0 issues** |
| 成本 | **31 秒 / 9.6 万输入 token / 7.6 千输出** |

★★ 与 §0.25 的「一句话硬跑整片」对比：**29.8 万输入 token、115 秒、还被轮数截断** →
**9.6 万、31 秒、跑完**。同样一件事，**省 3 倍 token 而且真的做完了** ——
这正是「导演分镜」这条路的全部理由：每一镜的上下文只装本镜。

（第 2 镜里连着 10 次 `get_object` 是个可见的浪费 —— 那是「读一堆对象再决定改哪个」的老毛病，
与整片这条链路无关，记在 §7 里。）

### 还没做的

- **每镜重跑 / 单镜重生成**：现在只能整片重来（服务端没有「只跑第 N 镜」的接口）；
- **风格统一**：镜头之间的视觉语言靠任务文本自己承接，没有共享的风格约束；
- **进度里的图片**：整片目前只在聊天里贴文字事件，不显示每镜的渲染帧；
- **暂停/取消**：作业一旦起了就跑到底（`FilmRegistry` 没有取消位）。

---
## 0.25 第二十六轮：两条实测抓到的真缺陷（看不见的命令 / 空跑被记成成功）✅

**动因**：你在面板里说「生成一条技术向科普视频关于 agent 的，为我删除当前内容从零开始生成」，
Agent 的表现是：一轮里提交 `[remove_object, delete_object, delete, remove, clear]`（成功 1 失败 4）、
接着连查三次一个**刚被它自己删掉**的对象、最后被 Runtime 按兜底规则收尾。
我把这一段逐条对到代码上，找到**两个真缺陷**。

### 缺陷一：`delete_object` 在引擎里有、在工具表里没有

| | |
|---|---|
| 引擎 | `apply.ts` 的 `case 'delete_object'` 一直在，面板的「删除」按钮走的就是它 |
| 工具表 | `COMMAND_BRANCHES` 里**没有**这个分支 —— 模型看不见它 |
| 后果 | 模型要删东西，只能**猜名字**；猜中的那条（`delete_object`）**悄悄生效**，其余 4 条 `unsupported_op` |

★ 「看不见但能用」比「不能用」更坏：**同一个批次里一半生效、一半报错**，
既不像成功也不像失败，模型和人两边都读不懂。
这也是「模型有点笨」这个观感的直接来源之一 —— 它想做的事**根本没有入口**。

**修法（两条一起，缺一不可）**：

1. `delete_object` 进工具表（+90 token）。描述里写明**「删掉之后这个 id 立刻失效、不可撤销」** ——
   冲着另一个实测症状去的：它删完又去 `get_object` 同一个 id，连吃三条「对象不存在」。
2. 新增 `SCHEMA_OPS`（**从 `COMMAND_BRANCHES` 推导，不手写第二份**）+ `apply_commands` 的**词汇表闸门**：
   schema 里没有的 op，**整批拒掉**并回上完整清单。schema 既然是模型的唯一词汇表，
   它就必须同时是可执行命令的白名单 —— 否则「猜对了就生效」永远是个洞。

### 缺陷二：`anyWrite` 看的是「调用过」，不是「写成了」

`judgeTurn` 的兜底收尾（quiet_two_turns / clean_three_turns）前提是 `anyWrite`，
而它数的是**调用过几次 `apply_commands`** —— 一整批全失败也算「写过」。
于是实测那一轮：4 条 unsupported_op + 1 条碰巧生效 = 「写过」，
接着 issues 连续三轮为 0 → 收尾，聊天里留下一句**看起来像成功**的话。

**修法**：判据改成**回执里 `ok` 非空**才算写过（读不懂的回执按 0 算）；
收尾话术补上「这是兜底规则，不代表任务做完了」，一次写入都没有落地时**直说**。
面板那边同样：写入 0 条时追加一条**红色**提示（文档没有任何变化，拆成小步再试）。

### 实测：同一句 prompt 的前后对比（真调模型，--reasoning high）

| | 修之前（你那次） | 修之后（同一句原话） |
|---|---|---|
| 删除手段 | 猜 5 个名字，4 条 `unsupported_op` | **`delete_object` ×5，全部成功** |
| 清空 + 重建 | 没做成 | 第 3 轮：10 条命令**全成功**（删 5 个对象 + 删镜头 + 改片长 + 加 2 镜） |
| 之后 | 连查 3 次刚删掉的对象 → 收尾 | 连做 5 轮：建 26 个对象（矩形/文字/连线/公式）、分组、动画、效果 |
| 结果 | 1 次碰巧的写入，收尾像成功 | **69 次写入，docVersion 0 → 70**；只剩 1 条 `object_too_small` |
| 报错 | 4 条看不懂的 op 名 | **0 条 `unknown_op`**（6 个批次全部合法） |

★ 代价也说清楚：这一轮 8 轮拉了 **29.8 万输入 token / 2.8 万输出 token（约 115 秒）**，
而且**被轮数上限截断**（`maxTurns=8`）—— 也就是说「一句话生成整片」这条路的成本是真实存在的。
正面回答你那个需求的做法不是把 maxTurns 调大，而是**导演式分镜**（`multi-shot.ts` 已经有 CLI 版，
面板还没接）：每镜一个 Agent、一个更小的上下文，这才是「生成一条视频」该有的形状。见 §7。

### token 账

| 项 | 之前 | 现在 |
|---|---|---|
| 工具表 | 6008 | **6099**（上限 6400） |
| apply_commands | 4830 | **4920**（上限 5200） |
| 相对关系 | 2.04× | **2.07×**（上限 2.6×） |

⚠️ 顺带修掉一处**护栏自相矛盾**：`apply_commands` 那条断言的**标题写着 5200、断言却是 4900**。
按标题（第二十三轮拍板的 5200）统一了 —— 否则这次 +90 会撞在一条**没人知道它在生效**的旧上限上。

---
## 0.24 第二十五轮：推理等级搬到页面上（下拉框，默认 high）✅

**你的原话**：「请你在前端页面加个选项来选择模型推理等级，默认是高，调整起来更方便」。
上一轮把它做成了命令行参数 —— 想换个档就得重起服务，而它恰恰是调 Agent 时最常动的一根旋钮。
这一轮把它搬到页面上，并且**默认改成 high**。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `agent-tools/src/deepseek.ts` | `DEFAULT_REASONING = 'high'`（**只在这一处定义**） |
| `agent-tools/src/panel-server.ts` | `/api/health` 多报 `reasoningOptions`（档位表）；`/api/chat` 接受 **每次请求** 带的 `reasoning`，按白名单校验，**传了非法值回 400**（不静默回退）；新纯函数 `resolveRequestedReasoning(provided, fallback)` |
| `agent-tools/src/serve-panel.ts` | `--reasoning` 的含义变成「**页面初值**」；横幅如实打出生效档位 |
| `panel/src/app.ts` | 聊天区最上面一行：`推理等级 [下拉框] 人话解释`；启动时问一次 `/api/health` 取档位表与初值；每一轮把它放进 `/api/chat` 的请求体；`__PANEL__.reasoning()` 供自动化断言读取 |
| `panel/index.html` | `.chat-reason` 那一行与下拉框的样式 |
| `agent-tools/test/reasoning.test.ts` | 10 → **14 条**：新增「解析请求档位」4 条 + **真起一台服务**验 health 报表、非法档位 400、合法档位能过这一关 |
| `agent-tools/dist/verify-reasoning-ui.mjs` | **新实机脚本**：真 Chrome 里点那个下拉框，检查每一轮发出去的 `reasoning`（**劫持 fetch 用假回执，不花钱、不动文档**），12 条断言 |

### ★ 三个刻意的设计决定（都有理由，别顺手改回去）

1. **选项表与初值都来自服务端**（`/api/health`），面板**不抄第二份白名单**：
   抄了就会「服务端加一档、页面少一个选项」而没人发现 —— 这正是本项目最防的那类分叉。
   读不到 health 时**不猜**：下拉框禁用并写明原因（猜一个默认值会让界面显示 high、实际跑 off）。
2. **它是运行时开关，不是文档字段 —— 所以不进 Journal**：换一档不该在撤销栈里留记录，
   也不该让 docVersion 前进。它随每一轮请求发过去，改一下对下一轮立刻生效。
3. **非法值回 400 而不是回退**：静默回退会让界面显示的和实际跑的不是一回事。
   这条与命令行参数「非法值当场退出」是同一个理由。

### 实测

| 项 | 结果 |
|---|---|
| typecheck / eslint / vitest | ✅ 全绿（vitest **63 文件 / 942 passed**） |
| ★ 实机（新脚本） | ✅ **12/12**：下拉框在（可见、四个选项、默认选中 `high`、旁边有人话解释）／点发送后请求体里 `reasoning:"high"`／在页面上换成 `off` 后下一轮变成 `off`／连着四轮分别是 `high/off/max/max`／假回执真的被渲染进聊天记录／无 JS 报错 |
| 截图 | `out/verify-reason-2-final.png`（右上角 Agent 聊天区顶部那一行就是它） |

### 怎么用

```powershell
node packages/agent-tools/dist/serve-panel.mjs --doc out/showcase.json   # 默认就是 high
node packages/agent-tools/dist/serve-panel.mjs --doc out/showcase.json --reasoning off   # 想省钱就把初值设成 off
```

页面上的下拉框随时可改（命令行只管「刚打开时选中哪一档」）。

---
## 0.23 第二十四轮：给面板 Agent 一个思考开关（`--reasoning`）✅

**动因**：你的原话「我感觉这个模型有点笨，是不是推理等级调整为最低？」
我去实测了一遍，结论与猜测**相反**，而且比「等级低」更值得修。

### 先回答那个问题：不是最低，是【根本没开】

| 位置 | 配置 | 说明 |
|---|---|---|
| 面板里的 Agent | `deepseek-chat` + `temperature:0`，**没有任何 reasoning 参数** | 实测：不传时网关**默认不开思考**（回执没有 `reasoning_content`，usage 不报 `reasoning_tokens`） |
| 我（DSH 会话） | `deepseek-flash` + `reasoningEffort: high` | 档位序 `off < low < high < max`，**high 是次高档**，不是最低 |

★ 网关把 `deepseek-chat` 解析成 `deepseek-flash` —— 同一个模型，只差**开不开思考**。
所以「笨」的观感是有据的：面板里的 Agent 一直在**张嘴就答**。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `agent-tools/src/deepseek.ts` | 新 `ReasoningEffort`（off/low/high/max）+ `REASONING_EFFORTS` + `isReasoningEffort`；`ChatRequest.reasoningEffort`；`ChatMessage.reasoning_content`；请求体按档位发 `reasoning_effort`（`off` 发 `thinking:{type:'disabled'}`） |
| `agent-tools/src/runtime.ts` | `RunOptions.reasoningEffort` + 透传；`messages.push(msg)` 上写明「整条回执原样进历史，含 reasoning_content」这条不变量 |
| `agent-tools/src/run.ts` / `panel-server.ts` | 选项透传；`/api/health` 如实报出 `reasoning`（以前「模型想不想」在界面上完全看不见） |
| `agent-tools/src/serve-panel.ts` | `--reasoning off|low|high|max`；**非法值当场退出**（静默降级会让人以为开了）；启动横幅打出思考强度 |
| `agent-tools/test/reasoning.test.ts` | **新文件，10 条断言**（stub 掉 fetch，不打网络） |

### ★ 三条只有实测才知道的事

1. **默认是关的，而且关得很安静**：不传 `reasoning_effort` 时，回执里没有任何「我没思考」的标记 ——
   没有 `reasoning_content`、usage 里也没有 `reasoning_tokens`。于是「没开」与「开了但没生效」
   在界面上长得一模一样。
2. **带 tools 时照样能思考**，但历史轮次的 `reasoning_content` 要回传。官方文档说漏了会 **400**，
   实测（2026-09）**不报错、只是那一轮思考被静默压成 0** —— 于是表现为「多轮工具调用里模型像失忆」。
   好在我们的 Runtime 本来就是**整条回执原样进历史**，这条契约天然成立；现在把它钉成了断言。
3. **`thinking` 与 `reasoning_effort` 是两个独立开关**：`off` 若只做成「不发这个字段」，
   服务端默认一变就静默变开；实测 `thinking:{type:'disabled'}` 能**压过** `reasoning_effort`，所以 `off` 走它。
   （顺带实测：思考模式下 `temperature` 被忽略，传了不报错。）

### 实测（同一台服务、同一个任务，只有 `--reasoning` 不同）

| 项 | `--reasoning high` | 默认（off） |
|---|---|---|
| 同一句任务（改曲线线宽，演示文档里那把字段带用户硬锁） | 3 轮 | 4 轮 |
| completion tokens | **2614** | **706** |
| 墙钟 | 12.7s | 5.0s |
| 结果 | 写入 1 条（endVersion 1） | 命中硬锁 → 0 写入（停在提案） |

★ 代价说清楚：**思考大约 3.7× completion token、2.5× 时间**，而且是**输出侧**的账 ——
与 §7 一直盯的「输入固定开销」是两笔钱。所以默认仍然是 off，要更聪明就显式 `--reasoning high`。
（上表那一列「1 条 vs 0 条」只是**一次**样本，而且那句任务正好压在演示文档的用户硬锁上，
不足以当「质量更好」的证据；要下那个结论得跑成套的对照。）

### 怎么用

```powershell
node packages/agent-tools/dist/serve-panel.mjs --doc out/showcase.json --reasoning high
# 不开思考（默认）：去掉 --reasoning 即可；也可以显式 --reasoning off
```

`/api/health` 现在会多一行 `reasoning` 字段 —— 想知道「到底开没开」，看它，不用猜。

---
## 0.22 第二十三轮：时间轴的三道手势（拖红线 / 拖接缝 / 拖片尾）✅

**你的原话**：「时间轴的红线可以拖动，画面实时更新，可以像 PR 一样拉长或缩短镜头时长」。
这一轮只做面板，**引擎一行没改** —— 因为要的东西引擎早就有（`set_scene` / `set_meta` + 帧计划），
缺的一直是**人的手**。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `panel/src/scene-edit.ts` | **纯规则**（毫秒级可断言）：`MIN_SCENE_SECONDS=0.2`、`trimBoundaryCommand`、`trimEndCommand`、`withTrimPreview` |
| `panel/src/timeline.ts` | ① 画布按下 + 拖动 = 挪播放头（**每次 seek 都 `setPlayhead`**，以前红线根本不重画）；② 镜头块两端 `.tl-trim` 手柄（左边缘只给非第一镜）；③ **没有镜头表时也画一整块「全片」**，右边缘可拖片尾；④ 拖动中**就地重排**镜头块（不重建 DOM）；⑤ `renderTimeline` 返回 `TimelineHandle.setPlayhead(t, sceneId)` |
| `panel/src/app.ts` | 预览文档覆盖 `trimPreview` / `previewDoc()`（`paintPreview` 与 `replan` 都读它）；`onTrimPreview` 只更新预览**并返回被夹住后的真实时刻**；`onTrimCommit` 走 `commitUser` 提交**一条**命令；播放时每帧 `setPlayhead(t, currentScene())` |
| `panel/index.html` | `.tl-trim` 手柄（9px 命中区、悬停发光）+ `body.trimming` 的 `ew-resize` 光标 |
| `panel/test/scene-edit.test.ts` | **+17 条断言**（17 → 30），覆盖夹下限、帧吸附、挤压时拒拖、预览 = 提交、撤销 |
| `agent-tools/dist/verify-timeline.mjs` | **新实机校验脚本**（与 `verify-panel.mjs` 同一套 Chrome/CDP 起法）：24 条断言 + 5 张截图 |

### 语义（为什么拖接缝改的是「后一镜的 bornAt」）

A1 的推论：镜头不存 `end`，「某镜结束」就是**下一镜的起点**。所以边界只有一个真源，
拖它就是「前镜变长、后镜变短」，**内容一秒都不动**（不像 PR 那样会把素材拉长）。四条规则：

1. **第一镜的起点不给拖** —— 那是整片的开头，挪它只会留下一段黑场；
2. **最短 0.2s**（≈6 帧）：拖到底也不会造出「看不见的零长度镜头」；
3. **吸附帧网格**（1/fps）：播放头与「这一帧属于哪一镜」用的是同一套离散化；
4. **一次拖动 = 一次手势 = 一条命令 = 一个 settled compound**：拖动中的几十个中间值
   **一个都不提交**（只改预览文档），松手才落一条。

★ 预览走的是**与提交同一个纯函数**（`withTrimPreview`），所以「拖到哪儿就看到哪儿」与
「松手后是什么」**不可能分叉** —— 这也是我把「被夹住后的时刻」从回调**返回**给时间轴的原因：
夹下限、吸附这些规则只在 `scene-edit` 里有一份，时间轴照着结果挪缝，
于是「鼠标能拖到哪儿」与「引擎接受哪儿」永远是同一个数。

### ★ 三个只有实测才能发现的地方

1. **预览文档必须同时喂给 `replan()`**，不能只喂 `paintPreview`。帧计划（总帧数、每帧归哪一镜）
   是从文档算出来的；只改画面输入会出现「镜头拉长了，红线后面却是黑场 / 帧数还是旧的」。
2. **提交前必须先清掉 `trimPreview`**：`commitUser` 成功后内部会 `refreshPanels()` → `replan()`，
   而 `replan` 读的是 `previewDoc()`。不清就等于**把预览当真文档**去算帧计划 —— 提交后画面停在一个
   文档里根本不存在的状态。
3. **拖播放头时泳道高亮是陈旧的**（实机断言直接抓到：红线在第二镜里、高亮的却是第一镜）。
   `setPlayhead` 只重画画布，`.tl-shot.cur` 还停在整面板刷新那一刻。修法不是让时间轴自己去猜
   （那会有第二份判据），而是让面板把 `currentScene()`（与渲染同一套帧计划算出来的）**一起传进来**。

另外记一条**探针自己**的坑：CSSOM 会把 `style.left = '75.0000%'` 归一化成 `'75%'`，
断言里比字符串会假失败（我第一次跑就踩了，两条 FAIL 全是探针的错，不是产品的错）。

### 实测

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **63 文件通过 / 2 跳过（65）**；用例 **929 passed / 48 skipped（977）** |
| `SVA_PIXELS=1` | ✅ **56 passed / 5 skipped**（`shot-pixels` 33 / `anim-pixels` 7 / 字体 10 …，本轮没碰画笔，重跑是为了确认没被牵连） |
| ★ 实机（本轮新脚本） | ✅ **24/24**：拖红线到 t=5.00s（红线像素落在 5/8 处、传输条同步、泳道高亮跟随）／拖接缝时**帧指纹变了**（画面实时）、镜头块实时伸缩、**文档一个字节没动**／松手后 `s#2.bornAt` = 6.00s、片长不动、**1 个 settled compound**／拖片尾 8 → 6.5 → 8.78s（预览时刻帧数 390 → 527 当场就变）／点一次撤销回到 6.5s／无 JS 报错 |
| ★ 实机（补上一轮的欠账） | ✅ **`verify-panel.mjs` 51/51 全通过**（基线文档 `out/panel-demo.json`）——含关键帧手柄、镜头管理、一次手势一次撤销、公式在真浏览器里的渲染 |
| 截图 | `out/verify-trim-1-before.png`（t=5s，第二镜 · 波包）→ `-2-during.png`（同一条红线、画面已翻到第一镜）→ `-3-after.png`（提交后 75%/25%）→ `-4-end-short.png` / `-5-end-long.png` / `-6-undo.png` |

### 怎么自己再跑一遍

```powershell
node packages/agent-tools/dist/serve-panel.mjs --doc out/showcase.json --no-open
node packages/agent-tools/dist/verify-timeline.mjs "http://127.0.0.1:<端口>/packages/panel/index.html?doc=/out/showcase.json"
```

★ 两个脚本都要 **danger-full-access**：Chrome 在 Windows 上用命名管道做 Mojo IPC，受限沙箱下它
会 FATAL 退出、写不出 `DevToolsActivePort`（症状是「Chrome 起不来」，根因与 Chrome 一点关系都没有）。

---
## 0.21 第二十二轮：公式（方案 B 落地）—— 几何由 Agent 的工具物化 ✅

**你拍的板**：目标档位 = 科普级几何风格；选 **B**（物化几何）；**由 Agent 的工具生成几何**。
这一轮把它落地了，并且**真调模型端到端跑通**（画面见 `out/run/final-t12_00.png`）。

### 关键技术选择：为什么是 MathJax 而不是 KaTeX

KaTeX 产出的是 **HTML + CSS**（位置由浏览器的排版引擎算）—— 在 Node 里**拿不到坐标**；
MathJax 的 **SVG 输出**把每个字形变成 `<path d>`，配合 `liteAdaptor` **完全不需要浏览器**。
我们要的正是「几何」，所以这条路是唯一一条既不用浏览器、又能保住确定性的。
（库的选择是实现细节，写在 `packages/agent-tools/src/formula.ts` 的头注释里。）

### 分工（这一轮的结构核心）

| 谁 | 做什么 |
|---|---|
| **模型** | 只写 LaTeX（`render_formula { source, x, y, size, color }`），**看不到几何** |
| **工具**（Node） | LaTeX → MathJax SVG → 展平成折线（em 单位）→ 编码成紧凑串 → 走**唯一写路径** `apply_commands` |
| **求值层**（engine-core） | 不认识 LaTeX：只把点列按字号缩放、按锚点平移（`decodeFormulaGeometry`） |
| **画笔**（engine-render） | 把所有子路径作为**一条路径**填充（nonzero 环绕规则） |

★ 于是「预览 = 成片」是**结构性成立**的：两条后端读的是同一串点列，谁都不需要排版能力。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `agent-tools/src/formula.ts` | **新模块**：MathJax（liteAdaptor，无浏览器）/ 路径展平（M L H V C S Q T Z）/ transform 累积（只认 translate+scale，别的当场抛）/ em 单位化 / 语法错识别 |
| `engine-core/src/render/formula-geometry.ts` | **新模块**：文档格式（`x,y x,y;...`）的 encode/decode —— **工具写、求值层读的唯一契约**；解码永不抛 |
| `engine-core/src/render-state.ts` | `RenderItem.subpaths` + `kind: 'formula'` 的注释 |
| `engine-core/src/registry/fields.ts` | `shape.formula.params`（source/paths/width/ascent/depth，**全部 engineOnly**）+ `style`（size/fill/align） |
| `engine-core/src/evaluate.ts` | 公式分支：em × 字号 → 屏幕点列；对齐与文字同口径；竖向以**基线**为准 |
| `engine-core/src/validate/validators.ts` | `formula_geometry_missing`（解不出点列 = 求值什么都不画）/ `formula_source_missing`（warn） |
| `engine-render/src/paint.ts` | 子路径作为一条路径填充 |
| `agent-tools/src/tools.ts` | **新工具 `render_formula`**：几何由工具算，归属由**身份**推导（场景 Agent → 当前镜；导演 → global） |
| `panel/src/app.ts` | inspector **不再渲染 engineOnly 字段**（§7 第 6 条的收口）+ 公式对象显示一行只读的 `公式：<LaTeX>` |
| 测试 | `formula.test.ts`（引擎 13 条 + 工具 11 条）+ 像素 3 条 |

### ★ 三个只有实测才能发现的地方

1. **路径里大量用 `T`/`S`（平滑曲线）** —— 展平器第一版只认 M/L/H/V/C/Q/Z，六个样本全部报
   「不支持的路径命令 T」。`T`/`S` 要靠**上一段控制点关于当前点的反射**，最容易被漏掉。
2. **MathJax 对语法错不抛异常，它画一个红色方框**（`data-mml-node=merror`）。
   不认这个标记的话，模型写错的公式会「成功地」画成一个空框 —— 最坏的那种失败。现在报 `latex_error`。
3. **洞**：字形轮廓里的洞靠子路径的**绕向**表达。实现成「逐个子路径单独 fill」会把 `o` 的中间填实 ——
   而**结构断言全绿**。像素测试专门造了一个环（外框 + 反向内框）来钉这件事。

### 实测

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **62 文件通过 / 2 跳过（64）**；用例 **913 passed / 48 skipped（961）** |
| `SVA_PIXELS=1` | ✅ **33/33**（新增 3 条公式像素断言） |
| ★ 真调模型 | ✅ 5 轮 / 0 issue：自己调了 `render_formula`，产出正弦定理的连等式，355×71px、20.7KB 几何 |
| ★ 画面 | ✅ 分式线、斜体变量、直立的 `sin`、间距都对（`out/run/final-t12_00.png`） |
| ⚠️ 面板实机校验 | **本轮未跑**：Chrome 起不来（审批没批下来），我没有绕过它。公式在**头部渲染**里已由像素测试覆盖，而面板预览走**同一份 paintScene + 同一份 RenderState**。**待办：下次有权限时用 `out/run/doc.json`（含 formula#1）跑一次面板实机。** |

### token 账（这一轮是**新能力**，所以上限重标定）

| 项 | 之前 | 现在 |
|---|---|---|
| 工具表 | 5595 | **6008**（上限 5800 → **6100**） |
| apply_commands | 4830 | **4830**（上限 4900，**只剩 ~70**） |
| 相对关系 | 1.90× | **2.04×**（上限 2.6×） |

`render_formula` 一个约 280 token，已经是压缩过的版本。**它不动 apply_commands** ——
几何不进 schema（模型看不到点列），这正是方案 B 省 token 的地方。

### 还没做的（写清楚）

- **多行对齐公式**（`align` 环境）、矩阵、`cases`：MathJax display 模式本来就支持（几何照收），
  但没有专门的排版参数（多行的行距与对齐点），要做再说；
- **公式的可视化拖动**：面板里它现在只能改 size/fill/align，位置要改 tf；
- **几何压缩**：一个复杂公式 ~20KB 点列进文档。嫌大可以调精度或减少曲线细分阈值；
- 面板实机校验（见上）。

---

## 0.20 第二十一轮：P3 收尾 —— 粗体（真 700 字面，不是合成）✅

**动因**：§7 第 10 条「文字样式（粗体/对齐/换行/最大宽度）」就差粗体了。

### ★ 为什么必须先解决字体，而不是先写代码

「粗体」有两种做法：让栅格化器**合成**（faux bold，把笔画描粗一遍），或者用**真的 700 字面**。
前者在 canvas 与 Chrome 上**不保证一致** —— 那正是「预览 ≠ 成片」。
所以这一轮先补字体资产（Noto Sans SC 700 + Inter 700，后者本来就有），再写代码。

| 文件 | 改了什么 |
|---|---|
| `assets/fonts/noto-sans-sc-700.woff2` | **新资产**（`out/get-fonts.mjs` 里也加了 URL，保证可复现） |
| `engine-node/src/render.ts` | 注册表的 FONT_FILES 加 700（同一族、不同字重） |
| `preview.html` / `panel/index.html` | `@font-face` 补 700（**面板那一页尤其重要**：它的预览画布用同一条字体栈，缺了就看不到粗体） |
| `registry/fields.ts` | `text.style.bold`（boolean，不做插值） |
| `anim/track.ts` + `render-state.ts` + `evaluate.ts` + `paint.ts` | 一路传到画笔：`ctx.font = '700 …'` |
| `panel` / `agent-tools` | set_style 派发 + 工具表白名单（create_object 自动带上） |
| 测试 | fonts（**注册表里真有 700 字重**）+ text-layout（bold 传到 TextPlacement）+ 像素（**粗体墨更多**） |

★ 判据的选择值得记：**不能用「宽不宽」判断真假粗体** —— CJK 的 400 与 700 字宽一样（都是全角），
合成粗体的宽度也一样。所以那条断言查的是 `GlobalFonts.families[].styles` 里**有没有 weight 700**。

### ★★ 又是两个探针自己写错的地方（这一轮的教训全在探针上）

1. **单一族的混排样本**：给 `SvaInter` 一个含中文的样本 → Chrome 对缺字**静默回退系统字体**，
   canvas 不回退 → 量出 26.83% 的「后端分叉」。**样本必须单语种**，或者给整条字体栈。
2. **探针页少声明 700 的 `@font-face`**：Chrome 于是**合成**粗体、canvas 用的是真 700 字面 → 2.95% 差。
   补上 `@font-face`（并显式 `document.fonts.load('700 …')`）之后，**七项全部 0.00px**。

（这两条与 §0.19 那条「两侧字体串不一致」是同一类：**探针在比两件不同的事**。
已进坑表 —— 现在它是那张表里出现次数最多的一类。）

### 实测

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **60 文件通过 / 2 跳过（62）**；用例 **886 passed / 45 skipped（931）** |
| `SVA_PIXELS=1` 的 shot-pixels | ✅ **30/30**（新增「粗体真的更重」） |
| fonts | ✅ 10/10（新增「真 700 字面」） |
| ★ 两条后端度量 | ✅ **七项全部 0.00px**（含粗体中文 / 粗体拉丁 / 希腊字母 / 运算符） |
| ★ 面板实机 | ✅ **51/51**（新增「粗体开关真的改到文档」） |
| ★ 真调模型 | ✅ 5 轮 / 0 issue：模型自己写了 `bold:true` 的 72px 标题 + `bold:false` 的 28px 说明 |

### 至此 §7 第 10 条（文字样式）**整条做完**

粗体 ✅ 对齐 ✅ 自动换行 ✅ 最大宽度 ✅。
剩下的公式（KaTeX）**我已经把方案对照写成 `docs/formula-plan.md`** —— 四个方案、
三条硬约束、我的推荐（D：小范围自研 + em 网格）以及**需要你回答的三个问题**都在那里面。
---

## 0.19 第二十轮：P3 第一块 —— 文字对齐 + 自动换行（外加一个真缺陷：π 是豆腐块）✅

**动因**：在这之前文字只能画**一行**，而且永远居中。于是"一段说明文字""分点讲解"
只能用多个文字对象手拼，位置还得自己算。规范 §3 要的文字样式里，
**对齐**与**换行**是最能立刻改变表达力的两条。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/render/text.ts` | **新模块**（纯函数）：`estimateTextWidth`（从 evaluate 搬来）、`splitTokens`、`wrapText`、`layoutText`、`alignOf`、`TEXT_LINE_HEIGHT_RATIO` |
| `engine-core/src/evaluate.ts` | 文字分支：折行 + 按对齐决定锚点语义 + 包围盒；`estimateTextWidth` 从这里再导出（历史调用方不变） |
| `engine-core/src/render-state.ts` | `TextPlacement` 加 `lines` / `lineHeight`（画笔逐行画，不再自己量文本） |
| `engine-core/src/anim/track.ts` | `ResolvedItemStyle` 加 `textAlign` / `maxWidth`（**逐字段转抄**那一处的老规矩：加字段要一起改） |
| `engine-render/src/paint.ts` | 逐行绘制（行位置与求值层的包围盒用同一套算术） |
| `engine-core/src/registry/fields.ts` | `shape.text.style` 加 `align`（枚举）与 `maxWidth`（像素，0 = 不换行） |
| `panel/src/command-path.ts` | 两个新字段派发到 `set_style` |
| `agent-tools/src/tools.ts` | `set_style` 的 text style 白名单加上这两个（`create_object` 自动带上） |
| 测试 | `text-layout.test.ts`（19 条）+ 像素 2 条（**第二行真的画出来了** / 对齐真的挪了墨迹） |

### 三条设计决定（都有断言）

1. **折行在 engine-core 算完，画笔只按行画。**
   如果让画笔各自 `measureText` 再决定怎么折，canvas 与 Chrome 会折出**不同的行** ——
   而折行是画面的一部分。这是"预览 = 成片"最隐蔽的一种侵蚀。
2. **估宽偏大是故意的**（拉丁 0.55em、CJK 1.0em）：宁可折行偏早，也不要溢出 maxWidth。
3. **显式换行符永远生效**（与 maxWidth 无关）；`maxWidth = 0` 就是旧行为（单行）。
   于是"我想手动断行"和"我想让它自己排"两种意图都能表达。

对齐的语义与 canvas 的 `textAlign` 一致：**锚点落在文字的哪一侧由对齐决定**
（left → 锚点是文字左边界），竖向永远以整块文字的中线为准。

### ★★ 真调模型抓出来的缺陷：`2π` 的 π 是**豆腐块**

第一次真跑（"在左上角加三行说明文字，讲讲正弦曲线的特点"）时，模型写得**完全正确** ——
`align: left`、`maxWidth: 520`、内容用显式换行分成 4 行 —— 但画面上 `2π` 变成了 `2□`。

**根因**：自托管的两个字体子集**都不含希腊字母**（Inter 的 latin 子集 + Noto Sans SC 的
chinese-simplified 子集）。而"用 π 讲正弦"是这个引擎的日常 —— 也说明
**只跑结构断言永远不会发现它**（结构全对，字是空的）。

**修法**：加 `noto-sans-math-400.woff2`（`SvaMath`），它覆盖希腊字母与常用数学符号，
**并且是将来做公式排版（KaTeX 那条路）必须先有的地基**。
五处同步齐：`paint.ts` 的字体栈、`render.ts` 的注册表、两个页面的 `@font-face`、
`out/get-fonts.mjs`（保证资产可复现）。修完重渲染同一份文档，π 正常显示。

★ 顺带记一条：**缺字不报错，它静静地画成方框**。所以"字体真的覆盖到了"
要么靠肉眼（这次就是），要么靠度量对比 —— 两条后端必须 0.00px 差。

### ★ 那个 19.93% 的度量差是【探针自己写错了】

第一次跑 `diag-text-metrics` 时混排样本报了 19.93% 的差，看起来像后端分叉。查下去发现：

    样本 = ['周期 2π 与 sin θ', 'SvaMath', 48]
    canvas 侧： ctx.font = '48px SvaMath'            ← CJK 缺字，量出来是缺字宽度
    chrome 侧： ctx.font = '48px SvaMath, sans-serif' ← CJK 回退到系统字体

**两侧在比两件不同的事。** 真正的契约是"**同一串字体栈**在两个后端上一致"，
所以样本改成携带**整条 font-family 串**、两侧逐字使用。改完：**五项全部 0.00px 差**，
包括中文+希腊字母混排与 `∑ ∫ √ ≤ ≠`。

### 实机与真调模型

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **60 文件通过 / 2 跳过（62）**；用例 **884 passed / 44 skipped（928）** |
| `SVA_PIXELS=1` 的 shot-pixels | ✅ **29/29**（新增 2 条：第二行真的画出来、对齐真的挪墨迹） |
| 字体（`fonts.test.ts`） | ✅ 9/9（新增 SvaMath 注册 / 栈里必须有它 / π 量得出宽度） |
| ★ 两条后端度量对比 | ✅ **五项全部 0.00px**（含混排与数学符号） |
| ★ 面板实机 | ✅ **50/50**（新增"对齐下拉框真的改到文档"） |
| ★ 真调模型 | ✅ 5 轮 / 0 issue；模型**主动**用了 `align:left` + `maxWidth:520` + 显式换行 |

### token 账

工具表 5698（上限 5800）、apply_commands 4799（上限 4900）、比例 1.94×。
两个新字段只进了 `set_style` 的 text style 白名单与 `create_object` 的 style（自动），约 +100。

### 还没做的（P3 的下一块）

- **粗体**：需要一份 **CJK 粗体**字面。现在只有 Inter 的 latin-700（拉丁能用，中文只能靠
  栅格化器合成，两条后端不保证一致）—— 要做就得先解决字体资产，属于"先定方案"的那类。
- **KaTeX 公式**：现在仍然只有美术字级别的文本（有了 SvaMath 之后至少希腊字母与运算符能画了）。
  真正上 KaTeX 要回答：走 DOM 还是自己排？两条渲染路径怎么保住"预览 = 成片"？
- 行高可调、字距、下划线/背景条（都不急）。

---

## 0.18 第十九轮：形状 / 文字的【参数】终于有编辑命令了 ✅（§7 第 0.5 条）

**症状**：面板把 rect 的宽高圆角、line 的两个端点与箭头、text 的内容、
以及 fill / fillOpacity / headSize / 字号**全都画成了控件** —— 但拖了只说一句"改不动"。
根因不是面板：**引擎里根本没有能改它们的命令**（set_style 只认 width/glow/stroke）。

### 引擎：三条几何命令 + set_style 补四个字段

| 命令 | 字段 | 形状检查 |
|---|---|---|
| `set_rect` | width / height / radius | 不是 rect → invalid_argument |
| `set_line` | from / to（vec2）/ head | 不是 line → invalid_argument |
| `set_text` | content | 不是 text → invalid_argument |
| `set_style`（扩） | fill / fillOpacity / headSize / size | 按名字写，不检查形状 |

★ **每种形状一条 op**（与 set_highlight 同一条纪律）：字段集是形状自己的，
并成一条会让"给曲线设置 from/to"变成合法但无意义的命令。三条都会**检查形状**。

★ `set_style` 扩的四个字段共用一条 op：它们都是"画一笔时会说出口的词"，
字段名不冲突（fill/fillOpacity 属于 rect、headSize 属于 line、size 属于 text）。

★ 五处同步点一次走全：commands / apply / batch（affected paths）/ invert / 面板派发。
其中 **invert 的 vec2 那一支有专门的坑**：补偿值是一个数组，用 asNumber 去接会得到
`undefined` —— 撤销就**静默不动**。现在有 asVec2 + 断言钉着。

### 面板：按【对象形状】派发（与效果按 type 派发同一个思路）

字段名本身不含形状信息（三种形状都有 width，含义却完全不同：曲线的 width 是线宽、
矩形的 width 是几何宽度），所以 `commandForPath` 必须问文档：`doc.objects[id].shape`。
派发错了也没关系 —— 引擎那侧还会再拒一次。

### 实机验证（两条路都跑了）

**AI 侧**（真调模型，diagram 预设）：

    [turn 3] apply_commands [set_rect, set_line] → ok=2 → v2     3 轮 / 0 issue / 30.8k 输入 token
    rect#1.params: width 3.4 → 5、radius 0.18 → 0.05
    line#1.params: head arrow → none

**面板侧**：实机校验新增 1 项 —— 选中 text#1、改"文字"那一行的控件，
文档里的 content 真的变了（48 → **49/49**）。

### token 账（这一轮是"新能力"，不是重复，所以上限重新标定）

| 项 | 之前 | 现在 |
|---|---|---|
| 工具表 | 5432 | **5595**（上限 5600 → **5800**） |
| apply_commands | 4534 | **4697**（上限 4700 → **4900**） |
| 相对关系 | 1.85× | **1.90×**（上限 2.6×，真正的那条护栏） |

四条新分支毛增 454（set_rect 136 / set_line 144 / set_text 71 / set_style +103）。
按 §0.14 的先例**先删掉与提示词重复的说明约 290**（localId 的第二句、camera_preset 的枚举复述、
add_effect.target 的"为什么"、retime.delta 的枚举、set_parent.parent、remove_scene.target…），净增约 164。
上限随之重标定到 5800/4900 —— **理由是"这是新能力"，并且刻意留出 ~200 给 P3**，
否则下一轮又会卡在这里。绝对方差本来就是随功能走的刻度。

### 这一轮踩到的两个坑（都是"探针/工具的细节"）

1. **探针的动作会改掉别人要读的状态**：我为了测"改文字"点了 outline 里 text#1，
   inspector 于是换成了 text#1 —— 而后面 6 条检查读的是 inspector 的行数与锁标记。
   症状是 6 条莫名其妙的红。**修法：做完就把选中恢复回去**（这也是"探针"第三次栽在状态互相影响上）。
2. **控件的元素类型由 registry 决定**：文字内容的 `maxChars` 是 200 > 120，
   所以 `controls.ts` 给它造的是 **textarea 而不是 input**。探针只查 `input` 就拿到 null，
   "改不动"红得像产品 bug。**查控件时用 `input, textarea`**（阈值在 registry 驱动的 deriveControl 里）。

### 这一轮的实测结论

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **59 文件通过 / 2 跳过（61）**；用例 **861 passed / 42 skipped（903）** |
| SVA_PIXELS=1 的 shot-pixels | ✅ 27/27 |
| API 金丝雀（SVA_ACCEPTANCE=1） | ✅ HTTP 200 |
| ★ 面板实机（verify-panel） | ✅ **49/49** |
| ★ 真调模型（改已有方块 / 箭头） | ✅ 一轮 2 条命令全绿，0 issue |

⚠️ 没做的：**半径/端点的"吸附到方框边缘"**（连线端点仍要手算坐标，§7 第 4 条的老账）、
**line 端点的可视化拖动**（面板现在只有数值框，没有画布上的手柄）、
以及 P3（文字样式 / 公式）—— 现在有 ~200 的余量可以开工了。

---

## 0.17 第十八轮：做掉最大的那条减法 —— 内联 effect 出 create 分支 ✅

**结论先说**：两条待拍板的减法里，我推荐**这一条**（而不是合并 create_rect / create_line），
理由在下。做完的账：**apply_commands 5551 → 4534（省 1017）**，工具表 6450 → 5432，
相对比例 2.19× → **1.85×**，而且**上限被收紧**（6600→5600、5600→4700），不是调松。

### 为什么是它，而不是合并 create_rect / create_line

| | 内联 effect 出 create 分支（做掉的这条） | 合并 create_rect / create_line（另一条） |
|---|---|---|
| 省多少 | **1017**（实测） | 约 600（交接文档估的 1100 偏乐观：合并后的分支仍要装下两套形状的字段） |
| 丢掉什么 | **什么都没丢**（见下） | 形状特定字段的**类型层封闭性**：模型能写出"rect 带 from/to"，引擎只能在提交时用 field_not_in_shape 拦；而且合并后的分支要求模型给无关字段填 null |
| 剩下的重复 | 无（四条 create 分支从 ~620 降到 ~350） | 仍在 |

★ **"什么都没丢"是关键**：规范 §7 要求"create_* 支持内联 effect —— 消除假依赖的必要手段"，
而假依赖的根源是"必须等回执拿到 assignedId 才能挂效果"。引擎的批次本来就支持**符号 id**：

    [
      {"op":"create_rect", "localId":"$c1", "width":3, "height":1.4, ...},
      {"op":"add_effect",  "target":"$c1", "effect":{"type":"highlight", ...}}
    ]

两条命令**同一批**提交（依赖由 batch.ts 的 mapLocalIds / referencedLocalIds 自动推导），
提示词从第一版起就写着"一次 apply_commands 尽量把相互依赖的改动放进同一批，用 localId 引用同批新对象"。
**§7 的理由仍然成立，变的只是表达形式** —— 而内联 effect 那份是**纯粹的重复**
（四条分支各带一份 drawOn + highlight 的完整形状，与 add_effect 里那份逐字相同）。

★ 引擎侧的 create_*.effect 字段**保留**（面板 / 预设 / 夹具在用，inline-effect.test.ts 一直守着它）：
拿掉的是**模型看得到的那个字段**，不是这个能力。两条路的等价性有断言：
新文件 engine-core/test/symbol-effect.test.ts（5 条，含"两条路产出同一份文档形状"）。

### ★★ 真调模型验了一次，第一轮就抓出一个缺陷（这条最值钱）

改完先跑了同一个任务两次（--preset empty --task "画一条 sin 曲线，2 秒内生长出来，第 3 秒高亮一下"）：

    第一次（改完就发）：
      [turn 3] apply_commands [create_plot, add_effect, add_effect] → 错误=unknown_local_id,unknown_local_id
      → 模型退回两步走，6 轮收尾，输入 60029 token

    第二次（修完再发）：
      [turn 3] apply_commands [create_plot, add_effect, add_effect] → ok=3 → v3
      → 5 轮收尾，输入 49972 token

**根因**：模型写对了结构，却把 localId 写成 "c1"、把 target 写成 "$c1" ——
因为 schema 里 localId 是个**没有任何说明的裸 str**。符号名的 $ 前缀规则只写在提示词里，
字段本身没有说明书。以前模型几乎不需要 localId（内联 effect 一步到位），所以这个缺口从没暴露。

**修法两条**：
1. localId 补一句说明（四条 create 分支共用一个常量 localIdField）："本批次内的符号名，必须以 $ 开头（如 $c1）"；
2. 引擎的 unknown_local_id 报错补一句怎么改（"符号名必须以 $ 开头，且必须由本批靠前的命令产生"）。

★ 还配了一条断言：create_* 的 localId 说明里必须出现 $（**裸 str 等于没说明书**）。
它是"凡是模型要写的字段，都要问一句格式说清了吗"的第二次现身（第一次是 §0.6 的"1 世界单位 = 多少像素"）。

### 这一轮的实测结论

| 项 | 结果 |
|---|---|
| typecheck / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **58 文件通过 / 2 跳过（60）**；用例 **841 passed / 42 skipped（883）** |
| SVA_PIXELS=1 的 shot-pixels | ✅ 27/27 |
| API 金丝雀（SVA_ACCEPTANCE=1） | ✅ HTTP 200（schema 更简单了，仍然被接口收下） |
| ★ 真调模型（同一任务，改前 / 改后） | ✅ 改后**一轮 3 条命令全绿**；轮数 6 → 5、输入 token 60029 → 49972 |
| token 账 | 工具表 6450 → **5432**；apply_commands 5551 → **4534**；提示词 2948 → 2940；比例 2.19× → **1.85×** |

### 腾出来的空间怎么用（P3 的入口）

现在 apply_commands 有 ~166 的余量、工具表 ~168，**够 P3 开个头**：
文字样式（粗体 / 对齐 / 自动换行 / 最大宽度）的字段进 registry 之后，
create_object 的 text style 与 set_style 各会多几个字段（约 +150~250）。
KaTeX 公式是另一码事（渲染路径 + 字体 + 是否走 DOM），要先定方案再动。

⚠️ 仍然**没做**的：create_rect / create_line 合并（还挂着，理由见上表）；
形状 / 文字参数的**编辑命令**（§7 第 0.5 条，现在有空间了，可以做了）；
以及压力测试三臂**本轮没重跑**（真调模型只跑了一条针对性任务）。

---

## 0.16 第十七轮：关键帧编辑（时间轴上的手柄）✅

**动因**（§7 第 4 条的原话）："现在按下动画开关 ◆ 只会生成一条'从 0 淡入到当前值'的默认轨道，
**改不了时间点**。要细粒度编辑得在时间轴上做关键帧手柄。" —— 这是文档自己标的
"完全独立、随时可做、**最有价值的下一步**"。

| 文件 | 改了什么 |
|---|---|
| `panel/src/keyframes.ts` | **新模块**（纯函数）：`keyframeRows` / `snapTime` / `moveKey` / `removeKey` / `insertKeyAt` / `animatedValueAt` / `trackOf` |
| `panel/test/keyframes.test.ts` | 18 条：吸附、夹边界、**不越邻居**、插帧不改形状、删空即删轨道、经 Journal 落盘 + 一次手势一次撤销 |
| `panel/src/app.ts` | 时间轴下方的**关键帧条**：每条轨道一行、每帧一个 ◆ 手柄。拖动改时刻 · 双击手柄删 · 双击空白插（= `set_motion`，走 `commitUser`） |
| `panel/index.html` | `.kf-strip` / `.kf-key` 样式（标签列宽与 `.tl-labels` 同为 74px，手柄横坐标与画布严格对齐） |
| `agent-tools/test/verify-panel.ts` | 加 5 项实机检查（43 → 48）：手柄数、拖动、只改时刻、双击插入、双击删除 |

### 三条编辑规则（每条都有断言，因为它们决定"拖歪一下会不会把动画写坏"）

1. **吸附帧网格并夹进 `[0, duration]`** —— 与播放头同一套离散化；
2. **不许越过邻居**（每个方向留一帧间隙）—— 越过之后"第 index 个手柄"指谁就变了，
   而手柄是按位置抓的，用户会看到它跳到自己手指外面；
3. **插帧不改变动画形状**：新帧的取值 = **引擎在那一刻求值出来的值**
   （`evaluateObjectAnim`，含缓动与颜色插值）—— 于是插入前后画面一模一样，
   用户拿到的是一个能接着拖的把手，而不是一次无法解释的跳变。

★ 取值刻意**不自己写一份线性插值**：那样"缓动"与"颜色插值"立刻会有两处口径。
顺带在测试里钉住了引擎的一条语义：**ease 标在【左端】关键帧上才有效**（"这一段用它"）——
我第一版把 ease 标在右端，拿到线性值还以为是插值的 bug。

### 交互口径

| 动作 | 结果 |
|---|---|
| 拖动手柄 | 松手时提交**一条** `set_motion`（拖动过程中不发命令 —— 每条 mousemove 都提交会造出几百个 compound，撤销面板会被淹掉） |
| 位置没变 | **不发命令**（点一下手柄不该在 Journal 里留一条） |
| 双击手柄 | 删掉这一帧；删到空 → 整条轨道删掉（空轨道是校验错误 `anim_track_empty`） |
| 双击轨道空白 | 插一帧；同一帧已有 → 不插，并在聊天里说明 |
| 表达式轨道 | 显示成只读一行（`表达式：3+clamp(t,0,2)`）—— 让用户看得出"它不是丢了" |

### 实机校验 48/48（含拖动的邻居夹住）

```
✓ 关键帧条在（2 个手柄 + 1 条只读的表达式轨道）
✓ ★ 拖动手柄：文档里那一刻真的变了，且被右边的邻居夹住（没越过它）
✓ ★ 拖动只改时刻：取值原样保留
✓ ★ 双击空白插入：手柄 +1，文档里的关键帧也 +1
✓ ★ 双击手柄删除：手柄 -1，文档里的关键帧也 -1
```

### ★ 探针第三次踩同一件事（已进坑表）

拖动那一步提交之后面板会**重建整块 DOM**，而我在开头抓到的那个 `kfTrack` 节点已经脱离文档。
点它虽然还会触发旧的闭包，但闭包里那条轨道是**拖动之前**的 ——
于是"插入"被判成"同一帧已经有了"，红得莫名其妙。
**规则：探针里凡是跨过一次提交还要用的节点，都必须"每次现取"**（这一轮在探针里踩了三次）。

### 这一轮没做的（写清楚，免得被当成"已经能做"）

- **值不可编辑**：手柄只能横向拖（改时刻）。改"值"要拖纵向或给一个数值框 —— 没做；
- **ease 不能逐帧设**：仍然只有面板给的默认缓动（编辑它要动 registry 的 `motion.key`，另说）；
- **拖动过程中画面不跟着动**：预览在松手（提交）之后才更新 —— 拖的时候只有手柄与提示在动；
- **给"还没有轨道的字段"插帧**：仍然先用控件旁的 ◇ 建一条轨道，手柄才会出现。

---

## 0.15 第十六轮：面板的镜头管理 + "用户编辑终于可撤销" ✅

**动因**：脚本侧（AI）早就有 `add_scene` / `set_scene` / `remove_scene` 三条命令、
33 条断言守着、P12 起就能用 —— 而**面板里人加不了一镜**。
顺带查出来一个更基础的问题：**用户自己的编辑从来不可撤销**。

### 做了什么

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/command/batch.ts` | **`BatchDeps.gestureId`**：一次用户手势 = 一批命令 = **一个 compound**；传了它（且没有 `turnId`）时，提交完由引擎自己把 compound 置为 settled |
| `engine-core/test/gesture.test.ts` | 6 条：分组、置位、"不传就是旧行为"、"turnId 仍然归 Runtime" |
| `panel/src/scene-edit.ts` | 镜头管理的纯函数：`addSceneCommands` / `renameSceneCommand` / `removeSceneCommand` / `sceneUnderCaret` |
| `panel/test/scene-edit.test.ts` | 14 条（含"一次手势一次撤销把两条命令一起撤回来"） |
| `panel/src/app.ts` | ① **`commitUser(commands, gesture)`** —— 面板里所有用户编辑的唯一出口（7 处调用点全改过来了，proposal 批准也是）；② 时间轴里加镜头管理控件（＋镜头 / 名字 / 改名 / 删除本镜） |
| `panel/index.html` | `.scenetools` 样式 |
| `agent-tools/test/verify-panel.ts` | 加 5 项实机检查（38 → 43） |

**顺手修掉的一个真缺口**：在这之前**用户自己的编辑从来不可撤销** ——
journal 的注释写着"用户手势由调用方显式 settle"，而没有任何调用方做，
于是面板里每个用户 compound 永远停在"进行中"，那排"撤销这一轮"按钮**一直是灰的**。
实机校验已经确认修好了（`userEditRevertEnabled: true`）。

**已经实测的**：typecheck / eslint exit 0；vitest **56 文件通过 / 2 跳过**、
用例 **818 passed / 42 skipped**；`SVA_PIXELS=1` 的 `shot-pixels` 27/27。

### ★ 实机校验抓到的那 3 项红，根因与修法

第一次跑，43 项里 3 项红（`#scenetools` 取到 null）。**根因不是这一轮的代码写错了，而是它被清掉了**：

> `timeline.ts` 的 `renderTimeline()` **第一行就是 `clear(root)`** ——
> 而 `renderTimelineSection` 是"先 append 标题、再 append 镜头控件、最后才调 `renderTimeline`"，
> 于是刚加进去的东西被下一句清得一干二净。

旁证很漂亮：面板左下角**从来没有"时间轴"这个标题** —— 它从加进去那天起就被同一句 `clear` 吃掉了，
一直没人注意（因为"少一个标题"看起来不像 bug）。

**修法**：把标题与控件挪到 `renderTimeline(...)` **之后**（`timelineSec.prepend(h3, buildSceneTools())`），
保持 `renderTimeline` 的契约不变（"给我一个容器，我负责它里面的东西"）。
修完重启服务重跑 → **43/43**，而且那个"时间轴"标题也第一次出现在界面上（截图可证）。

★ 另外还有两条**探针自己写错**的红，值得记下来（都是"测量方式"的错，不是产品的错）：

1. **别复用上一次抓到的按钮节点**：面板每次提交都会重建整块控件，旧按钮虽然点得动
   （监听器连着旧闭包一起被捕获），但闭包里的"当前这一镜"是**加镜头之前**算的 ——
   于是"改名"改到了前一镜身上。**每次点击前重新查一遍节点。**
2. **"导出完成"那条聊天消息要在加镜头之前取**：加镜头会往聊天里多写一条说明，
   `chatLast` 于是不再是导出那条。**判据读的东西被后续动作改掉 = 假红。**

### 还收紧了一条会"空过"的判据

`★ 一次手势一次撤销` 第一次是**空过**的：加镜头没成功（`scenesAfterAdd` 还是 2），
于是"撤回到 2 镜 / 片长 8"自然成立。**空过比红更危险**（它会一直假装在守）。
现在这条判据的前半截就是"先真的加成功了"（`scenesAfterAdd === 3 && durationAfterAdd === 12`）。

### 这一轮的实测结论

| 项 | 结果 |
|---|---|
| `pnpm -r run typecheck` / eslint | ✅ exit 0 |
| vitest 全量 | ✅ **56 文件通过 / 2 跳过（58）**；用例 **818 passed / 42 skipped（860）** |
| `SVA_PIXELS=1` `shot-pixels` | ✅ 27/27 |
| API 金丝雀（`SVA_ACCEPTANCE=1`） | ✅ HTTP 200 |
| ★ `verify-panel` 实机 | ✅ **43/43**（新增 5 项：镜头控件、加一镜、改名、一次手势一次撤销、用户编辑可撤销） |
| 截图 | `out/panel-live.png` —— 控件行 `＋镜头 2 镜 · 当前 s#2 ｜ 第三镜·实测 ｜ 改名 ｜ 删除本镜` 清晰可见 |

---

## 0.14 第十五轮：修掉"面板改不动效果参数" + P2 第四条（`appear` / `disappear`）

按 §7 的优先级：先清第 0 条（不变量 3 的缺口），再做 P2 剩下的原语。

### ① §7 第 0 条：面板改不动效果参数 ✅ **已修**

**症状**（上一轮记下来的）：面板会**显示**每个效果的参数控件，但拖动没反应、也不报错。
**根因**：判定内联在 `app.ts` 的渲染闭包里（`commandForPath()` 只认对象的 `style/tf/params`，
`eff#1.params.*` 一律 `null`，调用点写的是 `if (cmd === null) return;`）——
**想测它就得真开浏览器点一下**，所以没人测，于是 highlight / moveAlong 的参数从落地那天起就是死的。

| 文件 | 改了什么 |
|---|---|
| `panel/src/command-path.ts` | **新模块**：`commandForPath(path, value, doc)` 变成纯函数；效果参数按 `doc.effects[id].type` 派发到 `set_effect` / `set_highlight` / `set_move_along` / `set_visibility` |
| `panel/src/app.ts` | 删掉内联副本改为 import；**拿不到命令时在聊天里说一句**（不再静默 `return`） |
| `panel/test/command-path.test.ts` | 19 条：覆盖断言 + 按类型派发 + 对象路径回归 + 经 Journal 真的写进文档 |
| `agent-tools/test/verify-panel.ts` | 实机校验新增 4 项（改"生长时长"控件 → 文档真的变了、版本前进、能改时不产生错误提示） |

★ **三条断言的分工**（这是修法的一部分，不只是修 bug）：

1. **覆盖**：registry 里每一种效果的每一个参数都必须能派发出命令。以后加效果类型
   忘了改那张表，测试当场红 —— 而不是界面静默失效（这次的症状就是这么长出来的）。
2. **控件路径**：用 `controlModelFor`（`app.ts` 真正在用的那条路）造控件，逐条 path 断言可派发。
   这一条补的是"我手写的 path 形状碰巧和它一样"这个盲区，而且**不需要浏览器**。
3. **真的写进去**：产出的命令经 Journal 落到文档上。只断言"命令对象的字段名对"是不够的 ——
   apply 分支静默忽略一个字段时，字段名仍然是对的。
4. 还有一条反向的：对 drawOn 效果发 `set_highlight` 必须被引擎拒 —— 守的是
   "派发表漏一个字段"的第二种症状（硬塞给错的命令，形状对、语义错）。

### ② P2 第四条：`appear` / `disappear`（真显隐）✅

**动因**：`drawOn` 能"长出来"，但没有"到点才出场、到点就消失"。
在这之前只能给 `tf.opacity` 写关键帧，而那会得到一个**淡入淡出**，不是出场。

| 文件 | 改了什么 |
|---|---|
| `engine-core/src/registry/fields.ts` | 两个分组 `effect.appear.params` / `effect.disappear.params`（各一个 `at`） |
| `engine-core/src/evaluate.ts` | `EffectState.visibility`；**两个效果类型各管一端**；不在这一帧的对象**根本不进 RenderState** |
| `engine-core/src/command/{commands,apply,batch,invert}.ts` | 一条命令 `set_visibility`（**会检查效果类型**） |
| `engine-core/src/validate/validators.ts` | 新错误码 `visibility_window_empty`（出现得比消失还晚 = 整片空白） |
| `agent-tools/src/{tools,prompt,shot}.ts` | `add_effect` 加两支 + `set_visibility` 分支；提示词一节；新预设 `--preset visibility` |
| `panel/src/command-path.ts` | 两种效果**共用一条 op**（字段集一样，都是 `at`） |
| 测试 | `engine-core/test/visibility.test.ts`（21 条）+ 像素 4 条 |

**语义口径（都有断言钉着）**

| 场景 | 行为 | 为什么 |
|---|---|---|
| `t < appear.at` | **根本不在这一帧** | "它还没出现"与"它现在透明"是两句不同的话 |
| `t >= disappear.at` | 不在（闭区间左端） | 与 appear 同一口径：这一时刻【起】状态改变 |
| 两个都挂 | 可见窗口 = `[appear.at, disappear.at)` | 两个类型各管一端，所以能同时挂 |
| 同类型多条 | **后定义的生效** | 与 drawOn / highlight / moveAlong 同一口径 |
| 与 `tf.opacity` | **相乘**，不是覆盖 | "第 1 秒出现 + 从 0 淡入"因此不需要任何特判 |
| 与 `drawOn` | 互不干扰（一个管在不在、一个管画多少） | —— |
| 空窗口 | 校验器报 `visibility_window_empty` | 求值路径只会"什么都不画"，而空白最难反推原因 |

★ **为什么是两个效果类型、而不是一个带 `mode` 的类型**：
"1 秒出现、5 秒消失"是它最常见的用法，而口径是"同类型多条时后定义的生效"——
合成一个类型的话，后写的那条会把前一条整个吃掉。分成两个类型，两者天然各管一端。

★ **为什么阶跃、不给 duration**：渐变已经有两条现成的路（`tf.opacity` 的轨道、highlight 的渐入），
再加一个 duration 只会多出"它和轨道谁说了算"这类没有答案的问题。

### ★ 顺带查出来的更大缺口：形状 / 文字的【参数】也没有编辑命令

排查时把面板渲染的每一类控件都过了一遍，`commandForPath` 返回 null 的不止效果：

- `rect` 的 width / height / radius、`line` 的 from / to / head、`text` 的 content —— **没有任何命令能改**；
- `set_style` 只认 width / glow / stroke，所以 `fill` / `fillOpacity` / `headSize` / `size` 也改不了。
  （`style.size` 那条更糟：以前它发的是 `set_sampling{samples: undefined}` ——
  一条什么都不改的命令，于是"拖字号没反应"被伪装成"命令生效了"。现在它返回 null，界面会说出来。）

它和效果参数那一类**不是一回事**：AI 也改不了（工具表里没有这些 op），所以不变量 3 没有被违反 ——
它是纯粹的功能缺口。修它要新增 3~4 条引擎命令，而 `apply_commands` 现在只剩 **37** token 余量，
所以它卡在那两条待拍板的减法上（见 §7 第 16/17 条）。**降级为独立工作。**

### 固定开销：把账算清楚

| 项 | 之前 | 现在 | 说明 |
|---|---|---|---|
| 工具表 | 6291 | **6450** | 上限 6600 |
| `apply_commands` | 5392 | **5551** | 上限 5600，**只剩 49** |
| 系统提示 | 2845 | **2948** | 上限 3000 |
| 相对关系 | 2.21× | **2.19×** | 上限 2.6×（真正的那条护栏） |

（`create_*` 的 effect 从"嵌套 anyOf"改成展平之后又省了十来个 —— 见下面那条 ★★。）

新增两个效果类型只净增 171：`add_effect` 的两支 +154、`set_visibility` 一条 +132；
**减去的是"与系统提示重复"的内容**（`set_motion.field` 的"不要写 params.expr"、
`set_parent.parent` 的"整组一起动"那一节 —— 同样的话每轮发两遍本来就是浪费，提示词那份更详细）。
★ 这条经验值得记：**schema 胀了，先去找"提示词里已经说过一遍"的段落，而不是先抬上限。**

### 本轮跑了什么、没跑什么（照实记）

| 项 | 结果 |
|---|---|
| `pnpm -r run typecheck`（三个 tsconfig 全覆盖） | ✅ exit 0 |
| vitest 全量（不带环境变量） | ✅ **54 文件通过 / 2 跳过（56）**；用例 **798 passed / 42 skipped（840）** |
| `SVA_PIXELS=1` 的 `shot-pixels.test.ts` | ✅ **27/27**（新增 4 条显隐） |
| eslint | ✅ exit 0、0 字节输出 |
| 打包（`build-cli.mjs`，7 个入口） | ✅ 改完入口与它依赖的代码之后重建过 |
| 手动复查：`--preset visibility --at 1,3,7` | ✅ 三帧哈希不同，肉眼确认 t=1 左边方块**不在**、t=3 在（§0.14 ② 的图） |
| `verify-panel` 实机（38 项） | ✅ **38/38**（需要 danger-full-access；换新 bundle 重启服务后跑的，截图 `out/panel-live.png`） |
| API 金丝雀：整张工具表发给 DeepSeek | ✅ HTTP 200（新测试 `tool-schema-api.test.ts`，`SVA_ACCEPTANCE=1` 解锁） |
| `SVA_EXPORT=1` / `SVA_ACCEPTANCE=1` / `SVA_STRESS=1` / `verify-backends` | ⚠️ **本轮未重跑**。这一轮没碰 `render/` 与两条导出后端（只动了 `evaluate` 的"在不在这一帧"、registry、工具 schema、面板），所以风险低 —— 但它是**推断**，不是实测 |

### ★★ 实机校验逼出来的一个【更严重】的问题：工具表被接口整表拒收

**这是本轮最有价值的发现，而且不是我这轮引入的。**

面板实机校验第一次跑完，38 项里有 3 项红。顺着"聊天里那条报错说了什么"查下去：

```
DeepSeek HTTP 400:
  Invalid tool parameters schema : field `anyOf`: field `anyOf`: missing field `type`
```

**根因**：四条 `create_*` 分支的 `effect` 写成了 `nullable({ anyOf: [A, B] })` ——
**嵌套 anyOf**。DeepSeek 的 strict 校验不接受它，而且是**整个请求一起失败**：
模型一次都调不到，不是"少一个效果类型"。

**它是从哪来的、为什么活了这么久**：
`effect` 原本是单一形状，P2 highlight（第十二轮）把它改成"两种效果类型的联合"时
顺手包了一层 `nullable(...)`，从那一刻起每一份 create 分支都是嵌套 anyOf。
而**所有真调模型的测试都是 opt-in**（`SVA_ACCEPTANCE` / `SVA_STRESS`），
§0.13 的"仍未验"清单里恰好写着"P2 三条原语之后没重跑压力测试"——
于是"面板聊天能命令 Agent"这件事，从第十二轮起一直是**坏的**，
而它此前是过了验收的（§0.5 第六轮）。**没跑 ≠ 跑过了，在报告里长得一模一样。**

**隔离实验**（同一把 key，直接发候选形状，被拒不花钱）：

| 形状 | 结果 |
|---|---|
| A `nullable({ anyOf: [X, Y] })`（嵌套） | ❌ 400 `field anyOf: missing field type` |
| B `{ anyOf: [X, Y, {type:'null'}] }`（展平） | ✅ 200 |
| C `nullable({ type:'number', minimum…, description })` | ✅ 200 |
| D 单字段 params 的 effect 分支 | ✅ 200 |

**修法**：`tools.ts` 新增 `nullableUnion(variants)` —— 把与 null 的联合**展平**在同一个 `anyOf` 里，
四条 create 分支改用它（顺带还小省了十来个 token）。

**两条防复发的断言（一条毫秒级、一条拿真接口）**：

1. `schema-from-registry.test.ts` 新增**结构断言**：整张工具表里凡是出现 `anyOf`，
   每个分支都必须自己带 `type`（可选性用**同层**的 `{type:'null'}` 表达）。
   它把"接口的这条规矩"变成毫秒级的检查，普通 `pnpm test` 就会红。
2. 新增 `agent-tools/test/tool-schema-api.test.ts`：**API 金丝雀** ——
   把真实的整张工具表发给 DeepSeek，只确认 HTTP 200（`tool_choice:'required'` +
   一个字的任务，不会真的展开一次 Agent 循环）。`SVA_ACCEPTANCE=1` 解锁。
   结构断言只能挡住【已知】的形状错误，接口的规矩不止一条 —— 这条拿真接口兜底。

★ 顺带修掉的两个"让红变绿而看不出原因"的问题（都是这次实机校验暴露的）：

- **判据的时间窗必须正好框住被测的那件事**：原来断"Agent 写没写东西"用的是探针
  一开始读的 `v0`，而我新加的"改效果参数"已经把版本推前一格 —— 于是那条断言
  **永远通过**（哪怕 Agent 一轮就 400 失败）。现在用 `vBeforeAgent`。
- **只记错误条数等于没记**：探针原来只数 `#chat .msg-error` 的个数。
  看到"1 条报错"却不知道是谁拒的，白跑一趟。现在把报错原文一起带出来（`chatErrorText`）。

---

### 这一轮踩到/纠正的坑（都是"不查就会静默"的那类）

1. **"控件画出来了"不等于"拖得动"**，而不动的时候**可能什么都不报**。
   判定只要内联在渲染闭包里，就只能靠真开浏览器测 = 没人测。抽成纯函数是修法，不是重构。
2. **registry 里有字段 ≠ 有命令**。加了效果类型却没改派发表，老缺陷会以完全一样的方式复发 ——
   所以"覆盖"必须是断言，而不是我记住这件事。
3. **描述挂在 `anyOf` 外层**：`fieldOf()` 给的是 all-nullable 包装，直接铺开再写 description，
   描述会落到 anyOf 旁边而不是字段上。仓库里的读法（测试、面板）都是"inner 才是字段本身"，
   两处形状不一致迟早出事 —— 现在有 `innerField()` 专门脱这层。
4. **凭印象写下的断言是错的**：我一开始写"透明度 0 的对象仍然可被点中"，
   而 `engine-render/hit.ts` 对 `opacity <= 0` 与 `visibleFraction <= 0` **一样跳过**。
   真正的差别在 **RenderState**（`get_render_state` 报不报它、包围盒算不算它），
   不在命中。三条注释已按读代码的结果改掉 —— **注释里的错话会喂给下一个会话**。
5. **实机校验这轮没跑成**：它要拉起 Chrome（Windows 上 Chrome 用命名管道做 Mojo IPC，
   受限沙箱一定拒绝，见 `docs/environment.md`），而这次 `danger-full-access` 的审批没有批下来。
   所以"控件路径 → 命令"这条契约是用 `controlModelFor` 的无浏览器版测试补的（见 ① 的第 2 条），
   但 **`verify-panel` 新增的 4 项实机检查【本轮未执行】** —— 下次有权限时先跑它。


症状：`applyCommands` 的回执里 `ok`/`errored`/`blocked` **三个数组同时是空的**，
命令像没提交过一样。

根因链：
1. `batch` 的预检循环用 `applyCtx` 应用命令 —— 里面带着调用方自定义的 `registry`；
2. 通过预检后，`Journal.commit()` **会把命令再应用一遍**；
3. 而 `commit` 当时写死了 `applyCommand(doc, cmd, {})` —— 于是回退到内置 `REGISTRY`；
4. registry 与内置表不同的命令（比如测试自带的 `my.shape`）在这里 `failed`；
5. 而提交失败那行只写了 `continue` —— **既不算 ok 也不算 errored，就没了**。

修法（两处，缺一不可）：
- `CommitInput.applyCtx` 透传到 `applyCommand`，让预检与提交用**同一份**上下文；
- 提交失败**抛异常**而不是静默 `continue`（文案：`内部不一致：第 N 条命令…预检通过但提交失败`）。
  内部不一致宁可炸出来，也不要静默丢命令。

被这一点钉住的测试：`engine-core/test/create-object.test.ts` 的
「id 前缀由 shape 推导」那条（它故意用一个只属于本测试的 registry）。

### 5.2 `create_object` 会照单全收任何 shape / 任何字段名（**已修**）

`commands.ts` 的注释一直写着"未登记的名字报 `field_not_in_shape`"，但**此前没有任何代码兑现**。
现在 `apply.ts` 的 `create_object` 分支用 `registeredFields`/`unknownFields` 真查 registry，
拒掉未登记的 shape（`unsupported_shape`）与未登记的字段名（`field_not_in_shape`）。
`ApplyContext.registry` 参数化是为了让测试用手写分组、不污染全局登记表。
守护测试：`engine-core/test/field-in-shape.test.ts`（6/6）。

---

## 6. ✅ 已拍板并落地第一步：scenes 表的形状

**决定：A1 + B1。** 已实现（见 §0.5），只含派生规则，不碰 UI。

### 问题 A：每个镜头的结束时刻怎么定？→ **选 A1**

- **A1（已采用）结束时刻 = 下一个镜头的起点，不单独存。**
  表里只存 `{id, name, bornAt}`，按 `bornAt` 排序。
  好处：派生量永不与真源不一致，撤销/retime 只改一处。
  代价：表达不了"镜头之间的黑场缝隙"（真需要时再加显式的 gap，别为此引入第二真源）。
- ~~A2 显式存 `{id, name, start, end}`~~：表达力强，但"重叠了算谁的"这类冲突要长期维护。
- ~~A3 只存 `{id, name, bornAt}`，允许按镜头显式覆盖 `end`~~：两个真源，校验负担最重。

### 问题 B：`doc.meta.duration` 和镜头时长什么关系？→ **选 B1，但它比原设想窄**

- **B1（已采用）`duration` 与镜头表单向对齐。**
  ★ 但必须纠正一处原设想里的错误：`{id, name, bornAt}` **派生不出片长** ——
  最后一镜的结束点就是 `meta.duration` 本身。所以它不是"相加自动维护"，
  而是一条单向规则：**绝不短于最后一镜的起点，但永不自动缩短**。
  收短只能由显式的 `set_meta(duration)` 或删镜头的人来做。
  理由：全仓库都假设"时间轴 = `0..meta.duration`"单调累计，这样改动面最小；
  而"追加一镜顺手截掉片尾"是静默丢内容，比数字不一致危险得多。
- ~~B2 `duration` 独立，镜头越界报 issue~~。
- ~~B3 两边都改~~。

### 落实的规则（写在 `doc/types.ts`，由 `test/scenes.test.ts` 的 22 条断言守住）

| owner | 时间窗 | 为什么 |
|---|---|---|
| `scene` | `[该镜的表内 bornAt, 下一镜起点]`，最后一镜到 `meta.duration` | 左端取表内 `bornAt`：`owner.bornAt` 只是缓存，派生量不该有两个真源 |
| `shared` | 各 `usageWindows` 的并集，**不按镜头裁剪** | 裁掉窗口就等于把"跨镜复用"这件事抹了 |
| `global` | `[0, meta.duration]`，**不随镜头移动** | 规范 §11："global 对象完全不动" |

其他口径：
- `scenes` 是**必填**字段，空数组 = 单镜头（旧行为）。可选字段会让"是不是多镜头"
  变成运行期分支，规范没给这个自由度。
- 运行期读取一律经 `scenesOf()`：**存量的 `out/*.json` 没有这个字段**，
  直接 `doc.scenes.length` 会在校验器里抛异常（真踩了，见 §0.5）。
- 新增校验器 `scene_ref_missing`（environment / `human`）：**只在有镜头表时**才检查悬空
  `sceneId`。空表时 `sceneId` 只是没人解析的占位名，报 error 会把存量文档与全部夹具淹掉。
- **不做**"`owner.bornAt` 必须等于 `scene.bornAt`"的校验：缓存没人读，报了只是噪声。
- `reconcileDuration()` 目前**没有调用方**（还没有命令能改 `scenes`）。接 `set_scene` /
  `add_scene` / `retime` 时每条改 scenes 的命令都必须调它。

### 下一步

**P1 形状系统**
1. ~~`rect` + `line`/`arrow`~~ ✅（第十轮）
2. ~~`group` + 变换继承~~ ✅（第十一轮）
3. `ellipse` / `polygon`（圆、菱形 —— 流程图与状态机的常用形状）
4. 连线端点吸附到方框边缘（现在要手算端点坐标，很容易扎进方块里）

**P2 动画原语（决定"讲得清"）**
5. ~~`highlight` 效果~~ ✅（第十二轮）
6. ~~`style.stroke` 进动画白名单（颜色插值）~~ ✅（第十三轮）
7. `moveAlong(path)` 沿路径运动（数据流动画）—— 现在是"移动 + 高亮"两件套
8. `appear` / `disappear`（真显隐）
9. 高亮的**脉冲**（现在只有"渐入并保持"；来回脉动要靠两条高亮手动接）

**P3 文字与公式（决定"看得懂"）**
10. 文字样式（粗体/对齐/换行/最大宽度）
11. **KaTeX 公式**（规范 §3 要求，一直没做）
12. 字号可选"随缩放"

**P4 编排**
13. 导演自动分镜（把整片任务拆成逐镜任务）
14. 面板的镜头管理控件（加/删/改名 —— 引擎命令早已就绪）
15. `export_video` 工具 + 多镜头导出进度回报

**待你拍板的取舍（都是 token 成本）**
16. ~~**内联 effect 从四条 create 分支拿掉**~~ ✅ **第十八轮做掉了**（§0.17）：实测省 **1017**
    （apply_commands 5551 → 4534），而规范 §7 的"消除假依赖"没有丢 —— 同一批的符号 id
    （create 的 $c1 + add_effect 的 target）替代了它，**真调模型验过**。
17. **`create_rect` / `create_line` 合并回 `create_object`** —— 交接文档估的"省 1100"偏乐观，
    实测口径大约 **600**（合并后的分支仍要装下两套形状的字段）。
    代价是形状特定字段失去**类型层**的封闭性（引擎的 field_not_in_shape 仍然会拦，但拦在提交时），
    而且合并后要求模型给无关字段填 null。**现在不缺这 600，建议继续挂着。**

**其它已知缺陷**
18. `retime` 可逆（需 `shiftTimeline` 报告哪些标量时间实体动了）
19. `remove_scene` 撤销时对象归属回迁；`delete_object` 可逆（都需要"一条命令产出多条 Operation"）









---

## 7. 待办清单（按我的优先级；都不依赖未决的数据模型了）

**P0（用户已拍板）—— 三条【都做完了】，见 §0.29**

-1. ~~**Agent 自检**~~ ✅ **第三十轮做完了**（§0.29 二/三/四）：
   layout 组补了四条**表现层**判据（被裁 / 字号太小 / 贴边 / 两块压在一起）、
   `finish_shot` 前**必须真的渲染过一帧**、收尾话术**必须如实**说「还有 N 项没达标」、
   独立评审工具 `critique_frame` + 「评审连续两轮无改善就停」。
   ★ 两条只有真调模型才看得见的设计缺陷也记在 §0.29 三里（便宜的路 / 后门出口）。
-1.5. ~~**开放 token 上限**~~ ✅ **第三十轮做完了**（§0.29 一）：
   图片 16 张/镜 · 上下文 16 张 · 单次 6 帧 · 聊天 30 轮 · 整片每镜 16 轮 ·
   摘要 4000 · 历史 12×1200 · **显式 `max_tokens`** · 工具表上限 8000/7000。
   ★ 单批 15 条拆分、`fixClass`、`autoFix` 边界**一条没动**（那不是成本旋钮）。
-1.8. ~~**前端「API 编辑」+「费用计算」**~~ ✅ **第三十轮做完了**（§0.29 五）：
   baseURL / model / key（只存服务端内存、只回掩码）+ 测试连接（三类失败分得开）；
   **费用按用户拍板只算 token 不做金额**，三类分开报。
-1.9. ~~**跨镜交接摘要**~~ ✅ **第三十轮做完了**（§0.29 六）。

0. ~~面板改不动效果参数（不变量 3 的缺口）~~ ✅ **上一轮已修**（§0.14 ①）：
   `panel/src/command-path.ts` 的纯函数 + 19 条断言 + 拿不到命令时界面会说话。
0.5 ~~**形状 / 文字的【参数】没有编辑命令**~~ ✅ **第十九轮做完了**（§0.18）：
   `set_rect` / `set_line` / `set_text` 三条引擎命令（各自检查形状）+ `set_style` 补
   fill / fillOpacity / headSize / size；面板按**对象形状**派发；工具表也暴露给 AI。
   实机校验 49/49、真调模型一轮 2 条命令全绿。
   **还没做的**：连线端点吸附到方框边缘、line 端点在画布上可视化拖动（§7 第 4 条的老账）。
1. **P2 只剩最后一条**：highlight 的**脉冲**（现在只有"渐入并保持"）。
   已完成：`drawOn` / `highlight` / 颜色轨道 / `moveAlong` / `appear`+`disappear`。
   ★ 脉冲要动 `effect.highlight.params`，而它在 schema 里有 **6 处**（四条 create 的内联 + `add_effect` + `set_highlight`），
   加两个字段约 +240 token；在那之前还得先回答 §8 的新问题（周期从哪一刻算、脉动要不要回到原值）。
2. **P3：文字与公式 —— 全部做完 ✅**（§0.19/§0.20/§0.21）：
   文字样式（粗体/对齐/换行/最大宽度）+ **公式（方案 B：几何由 Agent 工具物化）**。
   **还没做的**：多行对齐公式 / 矩阵 / cases 的排版参数；公式在面板里的可视化拖动。
3. **P4：编排 —— 现在是【最高价值】的一条。**
   实测数据（§0.25）：一句话「生成一条科普视频」，8 轮拉了 **29.8 万输入 token**，而且被轮数上限截断。
   正面做法是**导演自动分镜**：导演 Agent 拆镜头 → 每镜一个场景 Agent（各自更小的上下文）→ 串行跑。
   `multi-shot.ts` 已经有 CLI 版（`--multi "s#1:任务;…"`），**面板还没接**；
   接上之后面板那个输入框才真的能「生成一条视频」。
   面板的镜头管理 UI 已经做过了（§0.15，增/改名/删 + 每步可撤销）。
   **工程文件（含上下文）与双击启动也已做完**（§0.27）。**还没做的**：多个存档槽 /
   服务端项目目录（`out/projects/` + 列表接口）、自动存档的历史版本。
   **✅ 面板里的「一键从零生成整片」已经接上**（§0.26）。**还没做的**：只重跑第 N 镜、
   镜头间的风格统一、进度里显示每镜的渲染帧、暂停/取消作业。
   **还没做的**：面板里的「一键从零生成整片」（导演分镜）、`export_video` 工具 + 多镜头导出进度（要动工具表 = 卡 token）。
4. ~~**关键帧编辑。**~~ ✅ **第十七轮做完了**（§0.16）：时间轴上的 ◆ 手柄，
   拖动改时刻 / 双击删 / 双击空白插。**还没做的**：改"值"、逐帧设 ease。
4.5 ~~**时间轴的三道手势**~~ ✅ **第二十三轮做完了**（§0.22）：拖红线 / 拖接缝 / 拖片尾，
   画面实时跟、一次拖动一次撤销。**还没做的**：拖**关键帧手柄**时画面实时跟 ——
   它现在是「松手才提交」，也就没有拖动中的预览（接缝那条路已经证明了该怎么做：
   一份 `withTrimPreview` 式的预览文档 + `replan()` + `paintPreview()`，照抄即可）。
5. **效果级的 `ease` 没有工具入口**（三处一起补约 150 token，见 §0.13 结尾）。
6. **`engineOnly` 字段在控件层没有真的 disable。** 现在只是加了 CSS 类，
   靠"根本不给它们造控件"绕开了（`worldWidth/Height` 等）。
   要在 `panel/src/controls.ts` 里强制 disable。
7. **聊天历史只在浏览器内存里**，刷新即丢、不落盘。`panel/src/chat.ts` + `app.ts` 的 `chatHistory`。
8. **`retime` 不可逆 / `remove_scene` 撤销不回迁归属**：两者都需要
   "一条命令产出多个 Operation"这个能力（`Operation ↔ Command` 现在是一对一）。

另外有一个成本发现，不是需求，你自己判断要不要做：
- token 固定开销 **9136/轮**（系统提示 2845、工具 schema 6291，
  其中 `apply_commands` 一个就占 5392）。**工具 schema 是提示词的 2.2 倍** ——
  想让 Agent 更省，动的是 `apply_commands` 的 schema，不是提示词。见 §0.13。

---

## 8. 我问过但你还没回答的开放问题

**★★ 上一轮开工前拍的板（第三十轮，全部已落地 —— 答案留在这里供回看）**：

| 问题 | 拍板 | 落地处 |
|---|---|---|
| 每镜图片预算 | **16 帧 / 6 次**（不是 §0.28 表格写的 24：同节提醒「8–16 帧，再多会稀释注意力」） | `budget.ts` |
| API key 存哪 | **只存服务端内存**（不落盘、不写回 `.env.local`、不进 localStorage） | `settings.ts` |
| baseURL 能不能改 | **能，但只限白名单**（官方 + 本机地址，且校验在发请求之前） | `settings.ts` |
| 费用怎么算 | **只算 token，不做金额**（我没查证过单价，不编数字） | `panel/src/usage.ts` |
| 整片要不要跨镜摘要 | **要** | `multi-shot.ts` 的 `handoffSummary` |

<details><summary>当时问的原话（留档）</summary>

**★★ 下一轮开工前必须先拍板的三个（与 §0.28 的作业 3 绑在一起）**：

1. **API key 存哪？**（a）只存内存，刷新即失效（最安全）；
   （b）落盘 `out/settings.json`（明文）；
   （c）写回 `.env.local`（与现有约定一致，但会改用户的文件）。
   ★ **不建议** localStorage：明文 key 进浏览器，而这个页面的 URL 是可以发给别人的。
2. **`baseURL` 允许在页面上改吗？** 改了就等于让服务端替人往任意地址发请求（SSRF 面）。
   要么限本机/白名单，要么明确接受「本地工具、风险自负」。
3. **费用单价从哪来？** 我建议写死一张默认表 + 页面可编辑（不联网抓价），
   但**单价的具体数值需要你给或确认** —— 我只实测了 token 数，没查证过单价。

另外两个与上一轮分析有关、值得你顺带回答的：

4. **图片预算放开到多少**？（我建议每镜 8–16 帧 —— 再多会稀释注意力，而且每帧固定 323 token 并不贵）
5. **整片模式下，每一镜要不要带上前面几镜的「交接摘要」**？
   现在每镜的 Agent **完全没有历史**，只能靠文档本身推断前面的视觉语言。

</details>

---

下面这些是我**按自己的判断先做了**的，和你的原意可能不一致，值得回头确认：

1. **效果类型一共哪几种？** 规范说"四种"但没给名单。现在实现了**五种**：
   `drawOn`（生长）/ `highlight`（强调）/ `moveAlong`（沿路径移动）/ `appear` / `disappear`（真显隐），
   加上"颜色走动画轨道"算一个原语。§8 的旧问题"appear/disappear 还没做"已作废。
1.5 ★ **highlight 的脉冲**（P2 最后一条）语义要怎么定？
   （a）从 `start` 起按 `period` 反复"渐入"（锯齿），还是正弦来回？
   （b）脉动要不要回到**原色**（那需要记住基色），还是只在一个区间里上下？
   （c）`start` 之前的强度是 0 还是 1？
   这三个问题不定下来，做出来的多半不是你要的那个"来回脉动"。
2. **规范 §7 里 `motion` 的 `"reveal"` 键是什么语义？** 现在实现了 `motion.key` 分组
   （缓动名白名单），但 `reveal` 没实现。
3. **doc 里内联的 `min/max/step` 是"引擎物化的副本"还是"实例覆盖"？** 现在是前者。
4. **文字要不要走 DOM + KaTeX？** 现在两条渲染路径都是 canvas `fillText`。
   （好消息：`diag-text-metrics` 证明 canvas 与 chrome 的字宽度量 **0.00 px 差**，
   所以目前没有可见问题。）

---

## 9. 踩过的坑（每条都花了真实时间，症状与根因差得很远）

| 症状 | 根因 / 应对 |
|---|---|
| 回执里 `ok`/`errored`/`blocked` 全空，命令凭空消失 | 预检与 `Journal.commit` 用了不同 `applyCtx`（见 §5.1）。**已修** |
| Chrome 起不来：`拒绝访问 (0x5)` / `spawn EPERM` | Windows 上 Chrome 用**命名管道**做 Mojo IPC，受限沙箱禁止。浏览器相关一律要 `danger-full-access`。见 `docs/environment.md` |
| `spawn ffmpeg` → **同步抛** EPERM，穿透 `void runExport(...)` 把**整个服务**干掉 | 沙箱下**带管道 stdio 的 `spawn` 是同步抛**，`'error'` 事件接不到。实测：`stdio:['pipe',…]`→SYNC_THROW、`stdio:'ignore'`→正常。现在：try/catch 包 spawn；诊断写**文件**不写管道；进程级兜底 |
| `EPERM` 删不掉 Chrome profile 目录 | `launchChrome` 现在会退到新的唯一目录名。**先清残留 chrome 进程更省事** |
| `node --experimental-strip-types cli.ts` → `ERR_MODULE_NOT_FOUND './math/vec2'` | 那个模式**不改写无扩展名 import**，本仓库全用这种写法。所有入口都要**打包** |
| 打包报 `INVALID_OPTION: output.file / output.dir` | 动态 `import()` 触发 code-splitting，与单文件产物冲突。改成静态 import（chrome 路径要打进 bundle） |
| 产物放 `out/` 后 `ERR_MODULE_NOT_FOUND '@napi-rs/canvas'` | pnpm **不 hoist**。产物必须落在**宿主包自己的 `dist/`** 里 |
| `Cannot find module '.../engine-node/src/server'` | 把 `@sva/engine-node/export` 标成 external 了，而它的 exports 指向 `.ts`。它必须**打进 bundle** |
| `UNRESOLVED_ENTRY packages/agent-tools/serve-panel.ts` | 入口在 `src/` 下；而且 rolldown 的 `input` 相对 **CWD** 解析，要用绝对路径 |
| 模型把效果参数写在 `effect` 顶层 | schema 里 `effect` 比 `style` 多嵌一层 `params`。已修：创建/追加时 `params` 及字段**必填**，缺了报 `drawon_duration_missing`，默认 `AUTO_DRAWON_DURATION = 2` |
| 模型写 `"ease":"easeOut"` 却静默变线性 | 缓动名不在白名单而 `applyEase` 静默回退。已修：登记进 registry → schema 里是 enum |
| `clamp(t/2.2,0,1)` 完全不夹且不报错 | 实现是 `clamp(lo,v,hi)`，与规范 §7 例子冲突。已修：改成规范写法，函数表与白名单同类型（漏实现=编译错误） |
| 空文档 `issues=0` 通过全部校验器 | 所有校验器都在遍历"已有的东西"。已修：新增 `export/empty_shot` |
| 中文在 headless 渲染里变成系统字体（48px 的"正弦"量出 48px 而不是 96px） | `headless` 渲染器从没注册自托管字体。已修：`registerHeadlessFonts()`，`renderFrames` 自动注册并在缺失时抛错 |
| 面板控制台 404（favicon） | `<link rel="icon" href="data:," />`，并加了"不许有失败请求"的断言 |
| 一行说明文字"选中对象后就不见了" | 它被写进了每次刷新都 `clear()` 的容器。要在会话里稳定可见的东西放**顶栏** |
| `pnpm run check` 永远红 | PowerShell 把 pnpm 脚本头写进 stderr → `NativeCommandError` 污染退出码。用 `node node_modules/<tool>/bin/...` 直接跑再读 `$LASTEXITCODE` |
| `pnpm install` 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | 设 `$env:CI='true'` 并加 `--no-frozen-lockfile`；之后可能还要 `ERR_PNPM_OUTDATED_LOCKFILE` 一起处理 |
| 手写的 `minimum: 16` 被测试抓红 | `schema-from-registry.test.ts` 有一条"整个工具表不许有手写范围"的断言。新增边界要放进 engine-core 的**具名常量**（`VIEWPORT_MIN_PX` 等） |
| 诊断报 `docHash 不匹配` | 要传真实 `createHash('sha256')` 出来的 doc hash，不能自己编 |
| JSON 注释里的 `\r\n` 被当成字面量写进 package.json | 直接重写整个文件，别用带转义的字符串拼 |
| 给 `SceneDoc` 加必填的 `scenes` 字段后，读它的地方抛异常 | 类型上必填 ≠ 运行期存在：`out/*.json` 是加字段之前落盘的。**这个坑踩了三次**（校验器 `doc.scenes.length`、`shiftScenes` 的 `.map`、`planShotFrames`）。一律防御：`scenesOf()` / `Array.isArray`。**加必填字段时先问一句"磁盘上的老文档怎么办"** |
| `set_scene` / `remove_scene` 的 patch 路径**静默失效**（撤销看起来成功、其实什么都没还原） | `scenes.s#2.name` 不是可解析路径：`resolvePath` 只有 `objects`/`effects` 两个"id 当相对根"的分支，而 `scenes` 是**数组**、`walk()` 进不去。**造 patch 路径时先确认它能被 `resolvePath` 解析**——现在有断言逐条守。注意这条分支的第一段是 `scenes` 而不是 id |
| 引擎报的新错误码到了回执里变成 `invalid_argument` | `batch.ts` 的 `toCommandError` 有一张**手写**的 `passthrough` 表，类型系统管不到。加码时两处都要改 |
| 场景 Agent 的 retime 把镜头边界也挪了 | 越权。它的 scope 就是"本镜 `[start,end]`"，挪任何边界都会改到邻镜。现在 strict 下一个都不挪，越界直接拦（`scene_bounds_exceeded`） |
| 越界检查用**原始**时刻比窗口，把"跟着镜头一起后移、其实没越界"的对象全判成越界 | 判越界必须用【顺延后】的时刻对【顺延后】的窗口 |
| 以为 `{id,name,bornAt}` 能算出片长 | 算不出 —— 最后一镜的结束点就是 `meta.duration` 本身。见 §6 的 B1 |
| 最后一镜的尾帧掉进空档、成片以黑屏收尾 | 整数帧网格下最后一帧 `t=(N−1)/fps` 够不到 `duration`。`planShotFrames` 把最后一帧特判归给最后一镜 |
| `create_object` 的 id 前缀是 **shape 名**（`plot2d#1`）而不是 `plot#1` | 只有 `create_plot` 产出 `plot#N`。写测试时别假设 |
| 用 `Set-Content -Encoding utf8` 改带中文的源码文件 | PowerShell 会把中文注释写成乱码（本仓库注释全中文）。**改文件一律用编辑工具** |
| `node --experimental-strip-types out/x.mts` 跑探针脚本 → `ERR_MODULE_NOT_FOUND` | 老坑重现：它不改写无扩展名 import。**一次性探针就写成临时 vitest 测试**（跑完删掉） |
| 用 `screenshotUrl` 截预览页时等 `__PANEL_READY__` 超时 | 它的默认 `readyFlag` 是**面板**的。预览页置的是 `__READY__`，要显式传 `readyFlag: '__READY__'` |
| 断言值自己算错（顺延后的关键帧时刻） | 改 `from`/`delta` 之后**必须重算所有期望值**。这类失败看起来像引擎 bug，实际是测试数据没跟着改 |
| `$LASTEXITCODE` 被管道里的 cmdlet 覆盖 | `node ... \| Select-String ...; $LASTEXITCODE` 读到的可能不是 node 的退出码（见过假的 `-1`）。要判红绿就**重定向到文件再单独读** |
| ★ 逐包 `tsc -p tsconfig.json` 说全绿，但测试与诊断脚本里全是编译错误 | 各包 `typecheck` 跑的是**三个** tsconfig（`tsconfig.json` + `.test.json` + `.node.json`）。只跑第一个会让后两个完全隐形 —— 实测漏掉 **10 处**（4 处在 `SVA_EXPORT=1` 才解锁的用例里）。**判据用 `pnpm -r ... run typecheck`** |
| 给 `SceneDoc` 加了必填字段后，`SVA_EXPORT=1` 那批用例悄悄坏了 | 它们默认被 skip，所以 `pnpm test` 永远不报。**加必填字段后要专门补跑带环境变量的那几批** |
| 改了 `cli.ts` / `serve-panel.ts` 之后忘了重建 bundle，实测跑的还是旧引擎 | `node packages/agent-tools/build-cli.mjs`（7 个入口）。**踩了两次**：改任何入口或它依赖的代码，先重建再实测 |
| 以为 `pnpm -r run typecheck` 永远是红的所以不用它 | 那是 PowerShell 把 pnpm 脚本头写进 stderr 造成的 `NativeCommandError`；**重定向到文件后 `$LASTEXITCODE` 是可信的**（实测 exit 0） |
| ★ 兜底收尾把"零产出"判成"做完了" | `cleanTurns >= 3` 那条漏了 `anyWrite` 护栏（旁边那条有）。**两条同类兜底共享的护栏必须写成同一处** —— 现在都在纯函数 `judgeTurn` 里。教训：判定逻辑内联在循环里 = 只能靠真调模型测 = 没人测 |
| 面板预览与导出画面不一致（预览不过滤镜头） | 多镜头落地后，预览必须用**与导出同一判据**过滤。凡是"两条渲染路径"，都要问一句"它们用的是同一个判据吗" |
| 探针自己写错了测量顺序，误报成产品失败 | `tc1` 在时间线已经跳到 5.5s 之后才读，读到的是 s#2。**探针失败先怀疑探针**：拿一个更小的、只测一个量的探针去核对（这次就用它证明了 seek 本身完全正常） |
| 面板里 Agent 说"做完了"但用户看不出它为什么停 | `finalMessage` 被服务端记下来了却从没显示。**诊断信息的价值在于它到达了人眼前**，记在协议里不算 |
| ★ 模型把世界单位当像素用，写出 `tf.y=105`，标题飞出画布 3000px，然后烧 6 轮试数字 | 它缺的是"1 世界单位 = 多少像素"。**我早就知道这个常数，却没让它到达模型眼前** —— `get_render_state` 只报像素 box，不报换算。修法见 §0.6。教训：**凡是模型要用来算的数字，都要问一句"它拿得到吗"** |
| 压力测试的失败率上升，但代码"看着没问题" | 压力测试的价值就在这里：`18/20` 配上轨迹，直接指到"模型在猜映射关系"。**别把 FAIL 读成"模型不行"** —— 先读轨迹，它常常在说"我缺一个信息" |
| ★ "撤销这一轮"把整片一起撤了 | compound 的粒度由 `turnId` 决定（`'c:' + actor + ':' + turnId`）。多 Agent 下**每镜必须有自己的 turnId**，否则所有镜头归到一个 compound。已在 `multi-shot.test.ts` 里断言。另外那个 id 格式是 journal 的默认约定，**别让调用方自己拼**（拼错了不报错，只会让撤销找不到 compound） |
| 顺手加一个字段，结果模型看不到它 | `RenderState` 有 `fit`、`evaluate` 早就知道世界↔像素的换算，但 `get_render_state` 从没报过 —— 模型于是猜了 6 轮。**加信息时问一句"它到达模型眼前了吗"**，代码里有不等于契约里有 |
| ★ "画出来了"和"看得出画出来了"是两件事 | 箭头大小按"世界单位"给了 0.8，而线宽那条路走的是像素口径 → 恒等相机下箭头只有 0.8px。**渲染成功、结构断言全绿、肉眼看不见**。区分这两件事唯一的手段是像素断言（数非背景像素、比两版差异），而不是断言"item 上有这个字段" |
| 渲染层的"字段白名单"漏了新字段，功能静默消失 | `styleFor()` 逐字段挑 pickup，加 `fill`/`fillOpacity` 时忘了加 → 求值层对、画笔丢，方框只剩描边。**凡是这种"逐字段转抄"的地方，加字段时都要一起改** —— 现在把 key 列成数组集中在一处，并写明了这条教训 |
| 复用上一步的 `fillStyle` 画填充，结果被涂成背景色 | 箭头沿用了矩形底色的 `fillStyle`。症状反直觉：**有箭头的图比没箭头的墨更少**。**画任何填充前先显式设 `fillStyle`**，别假设它还是你想要的那个 |
| ★ 工具 schema 比系统提示还贵，而没人注意到 | 实测：工具表 5978 vs 系统提示 2557 —— **想省 token 改提示词几乎没意义**。是那条"工具表不许超过提示词的 2.6 倍"的相对断言让我们看见这件事的。绝对上限会随功能增长被调松，**相对关系不会** |
| "颜色插值"改完数值轨道整条失效 | 写成了 `mode === 'color' ? lerpColor : lerpAtom` —— 而 `mode` 描述的是"字符串那一支额外允许什么"，不是"只允许什么"。**模式开关要往"更宽"的方向叠，不是替换**。现在 `blendAtoms` 的顺序是显式的：先数值 → 再颜色 → 否则放弃 |
| 测试里把 75% 处的颜色写成了 `#bfbfbf`（灰） | 那一条红了两次：第一次是容差太窄（抗锯齿），第二次是我把期望色算错（该是 `#bfbf40`）。**探针打出真实直方图之后一眼就定位了** —— 先怀疑测试、再看数据，比反复读代码快得多 |
| 同一个 helper 在两处犯了同一个错（只取 `anyOf[0]`） | 内联 effect 从"单一形状"变成"类型联合"之后，读 schema 的 `inner()` helper 只取第一支，于是"找不到 highlight 分支"。**改 schema 形状时，所有读它的 helper 都要一起过一遍** |
| ★ 面板画出了效果参数的控件，拖了没反应也**不报错**，从 highlight 落地起就没生效过 | 判定内联在渲染闭包里（`commandForPath` + `if (cmd === null) return;`）—— **只能靠真开浏览器测 = 没人测**。抽成纯函数 `command-path.ts` 才有断言；并且"拿不到命令"必须**说出来**，静默 return 是这类缺陷的温床。另配一条"registry 里每个效果参数都能派发出命令"的覆盖断言，防它复发 |
| 覆盖率测试全绿，但界面还是不动 | 断言里用的是**我手写的 path 形状**（`eff#1.params.duration`），而面板真正发出来的是 `controlModelFor(...)` 拼的 path。**"两条路各拼一次同一个字符串"必须有断言钉住它们相等** —— 现在用 `controlModelFor` 重跑一遍（无浏览器） |
| schema 的 description 写了却没进模型眼里 | `fieldOf()` 返回的是 all-nullable 包装，把描述写在它外层，读法（`inner()`）拿不到。**改一个字段的描述前先脱掉 anyOf**（`innerField()`） |
| 注释里写"透明度 0 的对象仍可被点中"，而代码不是这样 | `engine-render/hit.ts` 对 `opacity <= 0` 与 `visibleFraction <= 0` **一样跳过**；真正的差别在 RenderState。**凭印象写的断言/注释会喂给下一个会话** —— 涉及到行为差别时先去读那一行代码 |
| `apply_commands` 加两个字段就顶到 5600 上限 | 付账的方式不是抬上限，而是**删掉与系统提示重复的段落**（`set_motion.field` 的"不要写 params.expr"、`set_parent.parent` 的"整组一起动"那一节）。省下 ~95，净增 171 —— 详见 §0.14 |
| ★★ 聊天窗口发不出消息（接口 400），而它**此前是过了验收的** | `create_*` 的 effect 是 `nullable({anyOf:[…]})` —— **嵌套 anyOf**，DeepSeek strict 校验**整表拒收**。它是 P2 highlight 把 effect 改成联合时引入的，活了整整三轮：**所有真调模型的测试都是 opt-in，而"没跑"与"跑过了"在报告里长得一样**。修法是把联合与 null 展平在同一层（`nullableUnion`），并配一条**毫秒级结构断言**（任何 anyOf 的分支都必须自带 type）+ 一条 **API 金丝雀**（把真工具表发过去只要 200） |
| 探针里"Agent 写没写东西"永远通过 | 用的是探针**开头**读的版本号 `v0`，而探针自己中途的编辑已经把版本推前一格。**判据的时间窗必须正好框住被测的那件事**（现用 `vBeforeAgent`） |
| 实机校验报"1 条报错"，但不知道谁拒的 | 探针只数了 `.msg-error` 的个数。**诊断信息的价值在于它到达了人眼前** —— 现在把报错原文一起带回（`chatErrorText`），那次就是靠它一眼看到 `anyOf: missing field type` |
| ★ 往 `#timeline` 里 append 的控件"消失了" | `renderTimeline()` **第一行是 `clear(root)`** —— 在它之前 append 的任何东西都会被清掉。面板左下角从来没有"时间轴"这个 h3 就是这个原因（一直没人注意）。**往一个"会自己 clear 的容器"里加东西，必须放在它的渲染调用之后** |
| ★ 模型写得出结构、却写不对**格式**（`localId:"c1"` 配 `target:"$c1"`，整批 `unknown_local_id`，白烧一轮 60k token） | schema 里 `localId` 是个**没有任何说明的裸 `str`**，而 `$` 前缀规则只写在提示词里。**凡是模型要写的字段，都要问一句：格式说清了吗**（这是 §0.6 的"1 世界单位 = 多少像素"之后第二次现身）。修法三件：字段说明 + 报错里写清怎么改 + 一条断言（说明里必须出现 `$`） |
| 探针为了测 A 点了某个对象，结果 B/C/D 几条检查全红 | 点击会**改变选中**，而后面那些检查读的是 inspector 的行数与锁标记。**探针做完自己的动作要把状态恢复回去** —— 这是"探针自己改掉别人要读的东西"的第三次现身（前两次：节点被重建、聊天末行被新消息顶掉） |
| 探针查 `input` 拿到 null，"改不动"红得像产品 bug | 控件的元素类型由 **registry 决定**：文字内容的 `maxChars` 是 200 > 120，`deriveControl` 给它造的是 **textarea**。**查控件时用 `input, textarea`**（阈值在 registry 驱动的推导里，不在面板里） |
| 公式几何：六个样本全部报「不支持的路径命令 T」 | MathJax 的字形轮廓大量用 **`T`/`S`（平滑曲线）**，它们要靠**上一段控制点关于当前点的反射**。**写 SVG 路径解析器时先把命令表列全**（M L H V C S Q T Z + 相对形式），别按"常见的就那几个"猜 |
| 模型写错公式，却"成功地"画出一个空框 | MathJax **对语法错不抛异常**，它画一个红色方框（`data-mml-node=merror`）。**外部工具的"错误"未必是异常** —— 要按它的产物形态识别（这里就是查那个标记），否则最坏的那种失败：看起来成功了 |
| 公式的 `o`/`e`/`a` 的洞被填实，而结构断言全绿 | 洞靠子路径的**绕向**（nonzero 环绕规则）表达，逐个子路径单独 `fill` 就没了。**像素测试造一个环**（外框 + 反向内框）钉住它 —— 又一次"画出来了 ≠ 画对了" |
| 探针量出 26.83% / 2.95% 的"后端度量差"，两次都是探针自己的错 | ① 给**单一族**一个**混排**样本（Chrome 对缺字静默回退系统字体、canvas 不回退）；② 探针页**少声明 700 的 @font-face**（Chrome 于是合成粗体、canvas 用真字面）。**样本必须单语种或带整条栈；探针页必须声明每一个会用到的字重。** 这一类（探针在比两件不同的事）已经是坑表里出现次数最多的一类 |
| ★★ 一条 19.93% 的"后端度量差"，其实是探针在比两件不同的事 | 混排样本在 canvas 侧写 `48px SvaMath`、在 Chrome 侧写 `48px SvaMath, sans-serif` —— 前者 CJK 缺字、后者回退到系统字体。**契约是「同一串字体栈」，样本必须携带整条 font-family 串、两侧逐字一致**。改完五项全 0.00px。**先怀疑探针**，这条又一次成立 |
| 结构断言全绿，画面里 `2π` 却是豆腐块 | 自托管字体子集**不含希腊字母**（Inter latin + Noto SC 中文子集），而**缺字不报错**。修法：加 `SvaMath`（Noto Sans Math）+ 五处同步 + 一条"π 量得出宽度"的断言。**"画出来了"与"字是对的"是两件事** —— 这次靠肉眼，不靠断言 |
| ★ 探针里"跨过一次提交还要用的节点"必须每次现取（这一轮踩了**三次**） | 面板每提交一次就重建整块 DOM。旧节点点得动（监听器连着旧闭包一起被捕获），但闭包里的文档状态是**提交之前**的 —— 于是"改名"改到前一镜、"插入关键帧"被判成"同一帧已经有了"，红得莫名其妙。**写探针时先问一句：这个节点在两次操作之间会不会被换掉？** |
| 实机判据"空过"了（加镜头没成功，却因为"回到 2 镜"而通过） | 判据只写了结果的一半。**"撤销后回到原状"必须先证明"原状真的被改过"** —— 否则它会一直假装在守（这一条在 §0.15 里标了待收紧） |
| 断言用自己的顺序假设去卡 DOM | 硬锁标签我按"style 在前"写，实际 DOM 里效果参数与 shape 参数同属 `params` 分区、排在 `style` 之前。**判据用集合（都包含）而不是顺序** |
| 播放头拖走了，泳道高亮的却还是原来那一镜 | `setPlayhead` 只重画 canvas，`.tl-shot.cur` 是**整面板刷新那一刻**算的。修法不是让时间轴自己再判一次（会多出第二份判据），而是把 `currentScene()`（与渲染同一套帧计划）**一起传进来**。**任何"实时更新"都要问：还有哪些显示是上一次刷新时算好的？** |
| 预览文档只喂给了画笔、没喂给帧计划 | `paintPreview` 读预览文档、`replan()` 仍读真文档 → 镜头拉长后「红线后面是黑场 / 总帧数还是旧的」。**一份覆盖文档必须喂给所有从文档派生的东西**；提交前还要先把它清掉（否则 `refreshPanels → replan` 会把预览当真文档） |
| 探针比 `style.left` 字符串，两条断言假失败 | CSSOM 会把 `'75.0000%'` 归一化成 `'75%'`。**比数值（`parseFloat`）而不是比字符串** —— 又一条"先怀疑探针" |
| 「模型变笨了，大概是 token 限制」——**没量就动手** | 实测拆账后：每次调用只用 10–13k，其中 **9039 是固定开销**（提示词 2940 + 工具表 6099），文档与回执加起来才一两千，窗口远没用满。真正的病根是**六处硬上限**（图片 6 帧/镜、轮数 12/6、摘要 1000、历史 4×400、没传 `max_tokens`）与**能力缺口**（`delete_object` 曾经不可见）。**动手之前先量一次**，量法很便宜：直连 API 单独发一次、看回执里的 `prompt_tokens` 拆账 |
| `engine_only` 字段漏进模型回执 | `get_object` 无条件带 `params`，于是公式对象的 `paths`（≈20KB 点列 ≈ **5–6k token**）会被回给模型，而它**永远改不动这个字段**。这是全项目唯一一处「回执比上限还大」的地方 —— **每加一个 engineOnly 字段，都要检查它会不会从投影里漏出去** |
| 开机提示贴了，一刷新就不见了，而按钮还是亮的 | `createPanel` 末尾的 `resetChatHint()` 会 `chat.reset(...)`，把开机时贴的那行**清掉**。修法：只准备文案，等它之后再贴。**「谁最后写这个容器」在这个项目里已经踩到第三次**（前两次是 DOM 复用那两条）—— 往一个会被 rebuild 的容器里 append 之前，先问一句它什么时候被清空 |
| 工程文件「试着读读看」比打不开更糟 | 格式版本比我新的，一律拒收并说清版本号。半读进去的工程会让用户以为打开成功了 —— 而那正是最难查的一类状态（文档对了一半、上下文来自另一个项目） |
| `tool_choice: required` + 思考模式 → HTTP 400 | 官方文档没写这一条：`Thinking mode does not support this tool_choice`。而且错误藏在**作业对象的 `error` 字段**里，第一反应是「作业根本没跑」。修法是两次尝试：思考 + auto，拿不到再退到不思考 + required。**凡是「强制模型输出某个结构」的地方，都要先问一句它和思考模式兼不兼容** |
| 整片跑完 31 秒，而第一版 1 秒就 failed | 起作业的 POST 立刻回了 `{ok:true}`，失败发生在后台 —— 所以**接口层面的成功不代表事情做成了**。症状只有轮询里的 `state: failed` 能看见，而我第一版探针只打了事件没打 `error`，于是看起来像「什么都没发生」 |
| 「引擎里有、工具表里没有」的命令：模型猜中了会**悄悄生效** | `delete_object` 就是。危险的不是「不能用」，是**一半生效一半报错** —— 既不像成功也不像失败。修法两条一起：该暴露的暴露（它本来就是用户要的能力），再让 `SCHEMA_OPS` 当**可执行命令的白名单**（schema 是模型的唯一词汇表，那它就必须同时是边界）。**凡是「模型看不见却能执行」的入口，都在等着被猜中** |
| 判据用「调用过」而不是「写成了」 | `anyWrite` 数的是 `apply_commands` 的调用次数，一整批全失败也算「写过」，于是空跑被记成成功。**凡是用「动作发生了」当判据的地方，都要再问一句：它成功了吗？**（回执里 ok 非空才算） |
| 护栏的标题与断言各说各话 | `apply_commands` 那条：标题「不超过 5200」、断言 `toBeLessThan(4900)`。两条护栏里只有紧的那条在生效，而没人知道是哪一条 —— 这次 +90 token 差点撞上它。**上限只有一个数，标题与断言里必须是同一个** |
| 探针用 `waitForFunction` 的字符串表达式去等一个动态数字，把自己等死 | 断言写的是 `window.__SENT__.length === <算出来的 N>`，表达式没成立就一直等到超时，而且**超时前一行结论都不打印**（看着像产品挂了）。改成：轮询 + 超时后抛一句明确的话，并且 `catch` 里也要把已有结论打出来。**探针失败时要能自证失败在哪一步** |
| 白名单抄了两份（服务端一份、页面一份）就会「加一档、少一个选项」 | 页面的档位表与初值**都从 `/api/health` 拿**，面板里没有任何一个字面量白名单；读不到就不猜（禁用 + 说明原因）。**能由服务端说的，别让客户端复述** |
| 面板的 Agent「有点笨」，而所有人都在猜「是不是推理等级被调到最低」 | 实测：**压根没开思考** —— `deepseek-chat` 不传 reasoning 参数时默认关，回执里也不给任何「我没思考」的标记（没有 `reasoning_content`、usage 不报 `reasoning_tokens`）。**「没开」与「开了但没生效」在界面上长得一模一样**，所以猜了半天没人看出真正的原因；解法是把这件事**如实报出来**（`/api/health` 的 `reasoning` 字段） |
| 带 tools 的多轮里模型像失忆 | 历史轮次的 `reasoning_content` 没回传时，官方文档说会 400，**实测是不报错、只把那一轮思考静默压成 0**。**「没有报错」不等于「按你预期在跑」** —— 这类静默降级只能靠对照实测发现 |
| `verify-panel.mjs` 拿另一份文档跑出 25 条 FAIL | 它是**给 `out/panel-demo.json` 写的**（4 对象 / 2 镜 / 片长 8 / 那两把锁），换一份文档（哪怕只是多一个对象）就会大面积红。**验收脚本与它的夹具是一对**；换文档跑出来的红不是发现，是噪音 |
| ★★ **只要有一条便宜的路能过关，模型一定走便宜的那条** | 「收尾前必须看过画面」第一版把 `get_render_state` 也算「看过」，真机跑出来 5 轮里 `render_frames` 一次都没有、0 张图，却干净地收尾了。**判据写宽一格，效果就等于没做。** 修法：关卡收紧成「必须真的渲染过至少一帧」（代价 323 token/镜，用户已拍板值） |
| ★★ **一条判据有几个出口，就要挂在所有出口的共同下游** | 关卡加在 `finish_shot` 上，而 Runtime 自己的兜底收尾（issues 连续三轮为 0）**在模型看画面之前**就把这一镜结束了 —— 「强制看画面」被从后门绕过去。修法：两条兜底收尾补上同一个前提 `sawFrame \|\| !canStillRender`；「从未渲染过一帧」的警告也移到 `runShot` 末尾统一追加（实测模型压根没走到 `finish_shot`） |
| ★ **两条判据会在同一件事上给出相反的结论** | 新的「字号 ≥ 16px 就算可读」与旧的「屏幕边长占比 < 0.02 就算太小」同时生效：在 1920 宽的画布上后者等于 **38px**，于是 18px 的标注被报成「几乎是看不见的」，而模型会照着它去放大一份本来合格的画面。修法：`object_too_small` 从可读元素上摘掉。**加判据之前先问一句：它和已有的那条会不会打架？** |
| 自己写的探针把「一个元素」当成「N 个帧」 | `checkRender([L1_MAX_FRAMES])` 传的是一个元素的数组，不是 6 帧 —— 于是「图片额度用尽」那条测试假失败（15+1=16 不超 16）。**探针失败先怀疑探针**，这条第 N 次成立 |
| 拆开的 token 又被加了一遍 | 图片帧数的 token **已含在** `promptTokens` 里、思考 token **已含在** `completionTokens` 里。界面上分开报是为了看得懂，**求和只能取两者**（`totalTokens` 有断言守着） |
| 提示词上限撞线时想抬上限 | 加了「画面规范」+「交付前自检」两节之后正好顶到 3600。**付账方式不是抬上限，而是先删重复** —— 自检那节第 2 条把「画面规范」的四条又列了一遍，删掉后回到 3575 |

---

## 10. 项目铁律（不要违反）

1. `evaluate(doc,t)` 纯函数：不碰 DOM、不读时钟、不取随机数。
2. 写文档只有一条路径：`applyCommand → Journal`。
3. 人与 AI 走同一个 CommandBus（差别只在 `actor` 与 `intent`）。
4. 模型的输出只是**意图**；形状靠 strict schema、字段约束靠 FieldRegistry，
   `preconditions`/`dependsOn`/`blocked`/`fixClass` 适用性/图像预算**全部由引擎推导与强制**。
5. `fixClass` 为 `agent`/`human` 的 Issue **绝不**进 autoFix 路径（有断言守着）。
6. `samples` 永远是**全定义域**采样数；绘制动画是"全量采样 + 可见子集绘制"。
7. `canvas.width/height` 就是导出像素，**永不用 devicePixelRatio**。
8. 注释用中文，标识符用英文。

工作方式也是要求的一部分：**小步提交**、**每阶段先复述验收标准**、
**关键契约写成可执行断言而不是注释**、**遇歧义先问**。

---

## 11. 已完成的地基（别重做，先确认它在）

**引擎**
- 动画求值 `anim/track.ts`：`tf.*` + 数值/字符串 `style.*` 进 `evaluate`；
  `params.*` 轨道**明确不支持**并报 `anim_track_unsupported`
  （逐帧重采样违反铁律 6"`samples` 永远是全定义域采样"）。
- `create_object`（此前只有 `create_plot` 能建对象 → 文字标题无法从零产生）、
  `set_meta`（fps/duration/viewport；**刻意不含 worldWidth/Height**）。
- **镜头表的地基**（P12）：`doc/types.ts` 的 `Scene` 与
  `sceneOrder/sceneEnd/sceneWindow/lastScene/findScene/reconcileDuration`；
  `objectTimeWindow` 三档右端镜头感知；`create_*` 的 `bornAt` 由镜头表推导；
  `add_scene`/`set_scene`/`remove_scene` 三条命令（含可撤销，`remove_scene` 会自动
  把镜内对象改归属到相邻镜头）；`paths.ts` 认识 `scenes.<id>.<字段>`；
  `retime` 会顺延镜头表（只有导演视角挪边界）。
- **多镜头串行渲染**（P12 第 6 条）：`engine-core/src/shot.ts` 的 `planShotFrames`
  （帧网格 + 每帧归属 + 空档）与 `filterRenderStateByScene`（在 `evaluate` 外面套的一层
  select，**evaluate 本身仍然不知道镜头**）；headless / Chrome 两条渲染路径与 `preview.html`
  共用同一份帧计划；面板导出（`export-job.ts`）的帧数与时序也来自它。
- **镜头命令已暴露给 Agent**：工具表里有 `add_scene`/`set_scene`/`remove_scene`/`retime`
  （引擎专用的 `add_scene.id` 与 `retime.activeSceneId` **不在** schema 里，有断言守着）；
  系统提示有「分镜」一节；`scene-model-json.test.ts` 用逐字 JSON 验 schema↔引擎的往返；
  `scene-tools.test.ts` 还守着**固定开销预算**。
- **面板镜头 UI**：时间轴上的**镜头泳道**（`panel/src/timeline.ts` 的 `tl-shots`）——
  每镜一块、当前镜高亮、点一下跳到那一镜；传输条报出当前镜（`t=5.98s · s#2`）。
  **第二十三轮（§0.22）补上了三道手势**：画布拖播放头（每次 seek 都 `setPlayhead`）、
  镜头块两端的 `.tl-trim` 手柄（拖接缝 = 改后一镜的 `bornAt`；拖片尾 = 改 `meta.duration`）、
  没有镜头表时的一整块「全片」也能拖片尾；拖动中只改**预览文档**（`withTrimPreview`）、
  松手才提交一条命令。纯规则在 `panel/src/scene-edit.ts`，实机校验在
  `packages/agent-tools/dist/verify-timeline.mjs`（24 条断言 + 截图）。
  ★ 面板预览**按镜头过滤**（与导出同一判据 `filterRenderStateByScene`），
  所以多镜头文档下"预览 = 成片"这条契约仍然成立。
- **Runtime 的收尾判定抽成纯函数** `judgeTurn`（`runtime.ts`）：两条兜底收尾共享
  `anyWrite` 护栏，10 条断言在毫秒级跑完（以前只能靠真调模型，所以带着 bug 活了下来）。
- **多 Agent 串行**（P12 最后一块）：`engine-core` 的 `ApplyContext.scope` / `BatchDeps.scope`
  让"我这一镜"成为默认归属（`owner.sceneId: null` → 当前 scope）；
  `agent-tools/src/multi-shot.ts` 按 `sceneOrder` 逐镜跑，**每镜一个身份、一个预算账本、
  一个 turnId**（turnId 决定"撤销这一轮"只撤一镜）；CLI 有 `--multi "s#1:任务;s#2:任务"`。
- **形状系统（P1）**：`rect`（圆角/填充/独立 fillOpacity）、`line`（端点/箭头）、
  分组 `parent`（父子变换链，含环与超深的双重防御）。
  `--preset diagram` / `--preset grouped` 是它的手动复查入口。
- **动画原语（P2，只剩脉冲没做）**：`drawOn`、`highlight`（渐入 + 保持，烘进样式）、
  `moveAlong`（位置进世界矩阵，分两遍算不吃遍历顺序）、
  **颜色走上动画轨道**（`SampleMode`：registry 说它是 color 才插值，否则跳变）、
  **`appear` / `disappear` 真显隐**（`EffectState.visibility`；不在这一帧的对象不进 RenderState；
  一条命令 `set_visibility` **会检查效果类型**；`visibility_window_empty` 校验空窗口）、
  `render/color.ts` 的 `mixColor`（颜色插值唯一实现）、效果完整解析（多效果共存）。
  **还没做：highlight 脉冲、`retime` 可逆、面板镜头管理、导演自动分镜。**
- **公式（方案 B，§0.21）**：模型只写 LaTeX → **工具**用 MathJax（liteAdaptor，无浏览器）渲染成 SVG
  → 展平成 em 单位的折线 → 编码成紧凑串进 `params.paths` → 求值层按字号缩放、画笔按 nonzero 环绕规则填充。
  ★ `render_formula` 工具算几何；归属由**身份**推导（场景 Agent → 当前镜 / 导演 → global）。
  ★ 地形三条硬约束同时保住：求值纯函数、两条后端同一份点列、canvas 仍是默认后端。
- **文字排版**（§0.19）：`render/text.ts` 的 `wrapText` / `layoutText` / `alignOf` ——
  **折行在 engine-core 算完**（画笔只按行画，否则两条后端会折出不同的行）；
  `shape.text.style.align` / `.maxWidth`；锚点语义随对齐走；包围盒 = 最宽行 × 行数×行高。
- **字体栈三族、两档字重**：`SvaInter`（拉丁 400/700）/ `SvaNotoCJK`（中文 400/700）/
  **`SvaMath`（希腊字母与数学符号）**。粗体走真 700 字面（合成粗体会让两条后端分叉）。
  五处必须一致：`paint.ts` 的栈、`render.ts` 的注册表、两个页面的 @font-face、`out/get-fonts.mjs`。
  ★ 缺字**不报错**，它静静地画成方框 —— 所以要么靠肉眼，要么靠 `diag-text-metrics`（0.00px 差）。
- **形状 / 文字参数的编辑命令**（§0.18）：`set_rect` / `set_line` / `set_text`（各自**检查形状**）
  + `set_style` 的 fill / fillOpacity / headSize / size；面板按 `doc.objects[id].shape` 派发。
  ★ invert 里 vec2 那一支要专门的取值函数（`asVec2`）—— 拿 asNumber 接数组会得到 undefined，
  撤销就**静默不动**（有断言守着）。
- **工具表不再有内联 effect**（§0.17）：四条 `create_*` 分支只留 `localId`（符号名的说明在
  `localIdField` 常量里，含 `$` 前缀规则），效果一律走 `add_effect`（target 可写 `$c1`）。
  引擎侧的 `create_*.effect` 仍然可用（面板 / 预设 / 夹具），两条路的等价性有
  `symbol-effect.test.ts` 守着。
- **工具表的联合必须【展平】**（`tools.ts` 里那段注释；实现已随内联 effect 一起删掉）：`nullable({anyOf:[…]})` 会被
  DeepSeek strict 校验整表拒收（HTTP 400）。毫秒级结构断言 + `SVA_ACCEPTANCE=1` 的 API 金丝雀双重守着。
- **显性验收件**：`packages/agent-tools/src/diag-visibility.ts`（`dist/diag-visibility.mjs`）——
  把一段时间轴拼成一张胶片图，并对每帧并排给出"结构判据"与"画面判据"。加新原语时照它加一个。
- **面板的效果参数终于改得动**（`panel/src/command-path.ts`）：`commandForPath(path, value, doc)`
  是纯函数，效果参数按 `doc.effects[id].type` 派发；拿不到命令时界面会明说"改不动"。
- **面板的镜头管理**（`panel/src/scene-edit.ts` + `app.ts` 的 `buildSceneTools`）：
  加一镜（接在最后一镜之后，并把片长延到"新镜起点 + 4s" —— 落在片尾的镜头是零长度的）、
  改名、删一镜（只剩一镜时按钮置灰）。**加一镜是两条命令（`add_scene` + `set_meta`），
  顺序不能反**：先延长片长的话 `at` 会解析到新的片尾。
- **关键帧编辑**（`panel/src/keyframes.ts` + `app.ts` 的 `buildKeyframeStrip`）：
  时间轴下方的关键帧条，每条轨道一行、每帧一个 ◆ 手柄。规则是纯函数（吸附帧网格、
  不许越过邻居、插帧取值来自 `evaluateObjectAnim` 所以**形状不变**）；
  拖动松手才提交一条 `set_motion`。**没做**：改值、逐帧 ease、拖动时画面实时跟着动。
- **"一次手势 = 一个可撤销单元"**（`BatchDeps.gestureId` + `panel` 的 `commitUser`）：
  面板里所有用户编辑都走 `commitUser`，一个手势一个 compound、提交完由引擎置为 settled。
  在这之前**用户自己的编辑从来不可撤销**（compound 永远"进行中"，撤销按钮一直灰着）。
  **已知缺口**：形状 / 文字的 params 与 `style` 的 fill/fillOpacity/headSize/size 没有编辑命令（§7 第 0.5 条）。
- 锁可写：`doc/locks.ts` 的 `mergeLocksForActor`/`dropUserLocks` + `Journal.commit`
  按 actor 推导（用户写→hard 锁；撤销时摘锁）。
- 相机预设是**替换**语义 + `pullOut`/`reset`；逆操作是 `set_camera`（唯一确定的还原）。
- `clamp` 参数序改为规范 §7 的 `clamp(v,lo,hi)`；表达式函数表与白名单同类型（漏实现=编译错误）。
- `FieldRegistry → strict JSON Schema` 生成器（`registry/schema.ts`）；
  `motion.key` 分组（缓动名白名单来自 `EASE_NAMES`）。
- 校验：`empty_shot`（`validate/validators.ts`）· `drawon_duration_missing`（同文件，
  `AUTO_DRAWON_DURATION = 2`）· `anim_*`；阈值改从 registry 取。

**第三十轮新增的地基（§0.29；别重做，先确认它在）**
- **表现层自检**：`validate/validators.ts` 的 layout 组四条 ——
  `text_clipped` / `text_too_small` / `text_in_safe_margin` / `text_overlap`，
  全部 `fixClass: agent`、只对**可读元素**（文字/公式）生效，
  阈值是四个具名常量（`MIN_READABLE_FONT_SIZE_PX` / `MIN_FORMULA_FONT_SIZE_PX` /
  `SAFE_MARGIN_PX` / `MAX_CLIPPED_FRACTION` / `MIN_OVERLAP_RATIO`）。
  ★ `validateLayout` 现在是「每个采样时刻算一遍 evaluate」，跨对象检查才算得出来。
- **收尾关卡**：`BudgetTracker.hasRenderedFrame()`（只看 render_frames，不看 get_render_state）
  + `tools.ts` 的 `look_before_finish` 拒绝 + **额度不足以渲染一帧时的逃生口**
  + `runtime.ts` 的 `BLIND_FINISH_WARNING`（在 `runShot` 末尾统一追加）
  + `finishReport()`（收尾话术「还有 N 项没达标」）。
  ★ 两条兜底收尾（`quiet_two_turns` / `clean_three_turns`）都有 `sawFrame || !canStillRender` 前提。
- **独立评审** `critique.ts`：`critiqueFrame()` + `parseCritique()` + `CRITIQUE_CODES` 词表
  + `critiqueStalled()`（连续两轮无改善就停）。宿主通过 `ToolContext.critique` 注入。
- **token 拆账** `TokenUsage`（`deepseek.ts`）：输入 / 输出 / 缓存命中 / 未命中 / 思考 / 图片帧数，
  `addUsage` 是唯一做加法的地方；面板侧 `panel/src/usage.ts` 的 `formatUsage`。
- **API 设置** `settings.ts`：`ApiSettingsStore`（内存）、`checkBaseUrl`（白名单）、
  `maskApiKey`、`probeConnection`（三类失败）；路由在 `panel-server.ts`；
  页面侧规则在 `panel/src/api-settings.ts`。
- **跨镜交接** `multi-shot.ts` 的 `handoffSummary()` + `HANDOFF_MAX_ENTRIES`，
  以及 `historyMessage(history, label)` 的可配标题。

**面板**
- 七区：大纲（＋曲线/＋文字/删除）· 预览 · 效果控件（含动画开关 ◇/◆）· 相机（推近/拉开/复位）·
  时间轴 · 审核队列 · Journal。
- **第三十轮新增**：聊天窗口顶部一个默认折起的「API 设置」（baseURL / model / key /
  保存 / 测试连接 / 清除 key），以及把 token 三类分开报的那一行。
- 聊天窗口（能命令 Agent）· 场景设置（meta）· 导出 MP4（后端可选 canvas/chrome）。
- 播放循环（帧号推进 + 空格/方向键）。
- **无框架**：自己写的 schema→控件渲染器（`panel/src/controls.ts`）。

**基础设施**
- 单镜头 CLI（`cli.mjs`）+ 面板服务（`serve-panel.mjs`）+ 实机校验（`verify-panel.mjs`）。
- `@sva/engine-node` 拆出 headless / internal / screenshot / export / encode / chrome 六档。

---

## 12. 相关文档

- `docs/environment.md` —— 沙箱/Chrome/pnpm/vitest 的环境事实（**先读这个再配环境**）。
- `docs/backend-parity.md` —— canvas vs chrome 两条导出后端的实测对比与门限。
- `docs/formula-plan.md` —— 公式的方案对照（**已拍板选 B**，实现见 §0.21；文档保留作为取舍记录）。
