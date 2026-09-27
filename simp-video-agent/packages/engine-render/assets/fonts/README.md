# 自托管字体

规范 P1 清单第 6 条：字体自托管（@font-face + 本地文件），不依赖系统字体。

| 文件 | 来源 | 许可 |
|---|---|---|
| inter-latin-400.woff2 | @fontsource/inter | SIL Open Font License 1.1 |
| inter-latin-700.woff2 | @fontsource/inter | SIL Open Font License 1.1 |
| noto-sans-sc-400.woff2 | @fontsource/noto-sans-sc（chinese-simplified 子集） | SIL Open Font License 1.1 |
| noto-sans-math-400.woff2 | @fontsource/noto-sans-math（math 子集） | SIL Open Font License 1.1 |

下载命令见 `out/get-fonts.mjs`（一次性脚本，不在构建路径上）。

## 为什么必须自托管

落到系统字体就等于把"同一帧两次渲染是否一致"交给运行它的那台机器。
`preview.html` 里的 `@font-face` `font-display` 刻意用 `block` 而不是 `swap`：
宁可短暂不可见，也不要让浏览器先用替代字体画一遍。

## 验证

页面会暴露 `window.__FONT_STATUS__`（`document.fonts.check` 的结果），
导出的每帧都带着它。**如果这里为 false，Level A 的"稳定"只是同机同版本的假象** ——
所以 `packages/engine-node/test/export.test.ts` 把它做成了硬断言。

## 为什么还有一份数学字体（SvaMath）

**实测**：`2π` 的 π 曾经画成**豆腐块** —— Inter 的 latin 子集与 Noto Sans SC 的
chinese-simplified 子集**都不含希腊字母**，而「用 π 讲正弦」是这个引擎的日常。
Noto Sans Math 覆盖希腊字母与常用数学符号（∑ ∫ √ ≤ ≠ …），它同时是将来做公式
排版（KaTeX 那条路）必须先有的地基。

三条路径都要有它，缺一处就会分叉：`paint.ts` 的字体栈、`render.ts` 的注册表、
两个页面的 `@font-face`（`preview.html` 与 `panel/index.html`）。

## 已知限制

Noto Sans SC 只下了 `chinese-simplified` 子集。生僻字、日文汉字、
韩文会在这些字体里缺字并回退到系统字体 —— 那时确定性又丢了。
要彻底解决需要按实际用到的字形做子集化（构建期做，不是运行时）。

★ 顺带一条工程教训：**缺字不会报错**，它静静地画成一个方框。
所以「字体真的覆盖到了」这件事要么靠肉眼（这次就是肉眼看出来的），
要么靠度量对比（`diag-text-metrics`，两条后端必须 0.00px 差）。
