# 本机环境约束（实测）

这些不是"配置建议"，是在当前机器 + 当前 DSH 沙箱模式下**实测撞到**的硬约束。
每条都附证据与已验证的应对方式。写下来是因为它们会在后续阶段重复出现
（尤其是 P8 导出管线）。

---

## 1. Windows 上 Chrome 需要 `danger-full-access`

**现象**：受限沙箱（`workspace-write`）下，Chrome 无论怎么启动都起不来：

```
FATAL:mojo\public\cpp\platform\platform_channel.cc:108] Check failed: . : 拒绝访问。 (0x5)
crashpad_client_win.cc:142] crash server failed to launch, self-terminating
```

**根因**：Chrome 在 Windows 上用**命名管道**做 Mojo 跨进程 IPC，而受限沙箱禁止
创建命名管道。这跟 stdio 怎么配无关。

**已排除的两条无效绕路**（都实测过）：

| 尝试 | 结果 |
|---|---|
| `puppeteer.launch()`（管道 stdio） | `spawn EPERM` |
| `spawn(chrome, ..., { stdio: 'ignore', detached: true })` + CDP `connect()` | 进程起得来、`DevToolsActivePort` 一度出现，随后仍 Mojo FATAL 自杀 |
| `--single-process --no-zygote` | 同上，DevTools 起来了但随即自杀 |

**结论**：任何需要真的拉起浏览器的步骤（P1 截图夹具、P8 导出管线），
必须以 `danger-full-access` 运行。已验证：在该模式下 Chrome 153 正常启动、
DevTools 正常监听。

**影响**：浏览器相关测试不能放进默认的 `pnpm test`，否则受限模式下一跑就红。
单独脚本 + 单独 script 名，跑之前升权限。

---

## 2. 不能有 vite / vitest 配置文件

**现象**：只要根目录存在 `vitest.config.ts`，`vitest run` 立刻启动失败：

```
failed to load config from .../vitest.config.ts
[plugin externalize-deps] Error: spawn EPERM
```

**根因**：Windows 下 vite 解析真实路径时会走 `windowsSafeRealPathSync()`，
它调用 `exec("net use")` 探测网络盘。这段调用**在 try/catch 之外**，
沙箱一拦就是同步抛出，配置文件的 bundling 直接崩。

**应对**：所有 vitest 参数写在 `package.json` 的 script 里（CLI flag），不放配置文件。
代价是将来要用 `test.projects` 给不同包配不同环境时，需要重新想办法。

---

## 3. vitest 必须用 `--pool=threads`

**现象**：默认 `forks` 池下每个测试文件都 `spawn EPERM`。

**根因**：`forks` 池用 `child_process` + 管道 stdio 起 worker。

**应对**：`--pool=threads`（worker_threads，不 spawn 进程）。engine-core 的测试
全是纯计算，本来就适合线程池。

---

## 3.5 `pnpm -r` 必须加 `--workspace-concurrency=1`

**现象**：工作区有 2 个及以上包时，`pnpm -r run <script>` 报 `spawn EPERM`；
但 `pnpm --filter <pkg> run <script>` 正常。只有 1 个包时也正常。

**根因**：pnpm 的 workspace 并行 runner 会 spawn 子进程并用管道收回输出。

**应对**：根脚本统一用 `pnpm -r --workspace-concurrency=1 ...`（串行，本来就够快）。

---

## 4. pnpm store 落在工作区内

pnpm 把 content-addressable store 放在 `<workspace>/.pnpm-store/`（同盘策略）。
已加入 `.gitignore`，并在 eslint / vitest 的 ignore 里排除 —— 否则 glob 会扫进
整个 store 里的第三方测试文件。

---

## 附：shell 层

`npm.ps1` / `pnpm.ps1` 被执行策略挡住（`UnauthorizedAccess`），
一律用 `npm.cmd` / `pnpm.cmd`。

---

## 5. 导出管线（P8）实测

**Chrome**：153.0.8010.53。导出全程需要 \`danger-full-access\`（见第 1 节）。

**ffmpeg**：环境里没有，需自备。\`Invoke-WebRequest\` 在本机 TLS 握手失败
（\`基础连接已经关闭\`），改用 **Node 的 fetch** 下载成功：

    node -e "fetch(url).then(r=>pipeline(...))"

静态构建落在 \`out/tools/ffmpeg-9.0.2-essentials_build/bin/\`（已 gitignore）。

**stdin 管道**：规范要求的 \`-f image2pipe -i -\` 在 \`danger-full-access\` 下可用，
实测走的就是 pipe 模式。但受限沙箱会拒绝管道 stdio（EPERM），
所以 \`encodeMp4()\` 内置了"写 PNG 序列 + \`-i pattern\`"的回退，调用方不用管。

**HTTP 静态服务**：必须去根路径的尾部分隔符，否则路径守卫会把自己的文件判成越界（403）。
