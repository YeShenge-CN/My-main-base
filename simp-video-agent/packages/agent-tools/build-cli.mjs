/**
 * 把几个【会被 node 直接执行】的入口打成一个文件各自一份：packages/agent-tools/dist/*.mjs
 *
 * ★ 为什么不直接 `node --experimental-strip-types src/cli.ts`：
 *   那个模式**不改写无扩展名 import**，而本仓库的 TS 源码全用
 *   `from './doc/types'` 这种写法（由 bundler 解析）。实测直跑会在
 *   engine-core / engine-node 的第一层 import 就 ERR_MODULE_NOT_FOUND
 *   （连 `./chrome` 这种同目录 import 也一样断）。
 *   打包同时还顺手验证了"生产路径能不能跑"，而不是让这些入口活在一个
 *   只有测试才走得通的加载方式里。
 *
 * ★ 产物必须落在【本包自己的 dist/】里，不能放仓库根的 out/：
 *   pnpm 不做 hoist，@napi-rs/canvas 只被链接到 packages/agent-tools/node_modules。
 *   放 <repo>/out 时 Node 逐级向上只看到 <repo>/node_modules，那里没有它。
 *
 * 用 rolldown 的编程式 API，不走配置文件 —— 本环境下配置文件加载会触发
 * vite 的 windowsSafeRealPathSync，那里有一个沙箱一拦就崩的 exec("net use")。
 */
import { mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const here = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(here, 'dist');
mkdirSync(distDir, { recursive: true });

/** 会被 node 直接执行的入口（相对本包根）。加新入口只改这一行。 */
const ENTRIES = ['cli.ts', 'src/serve-panel.ts', 'src/verify-backends.ts', 'src/diag-backends.ts', 'src/diag-text-metrics.ts', 'src/diag-text-offset.ts', 'src/diag-visibility.ts', 'test/verify-panel.ts'];

const external = [
  // Node 内置：显式标出来，否则 rolldown 会为每个 node:* 报一条 UNRESOLVED_IMPORT
  ...builtinModules,
  ...builtinModules.map((m) => 'node:' + m),
  // 原生模块不能打进 bundle：要按普通依赖在运行期解析
  '@napi-rs/canvas',
  'puppeteer-core',
  'rolldown',
];

for (const entry of ENTRIES) {
  // 产物名取 basename：test/verify-panel.ts → dist/verify-panel.mjs
  const base = entry.split('/').pop() ?? entry;
  const outFile = join(distDir, base.replace(/\.ts$/, '.mjs'));
  // ★ input 用绝对路径：rolldown 的入口是相对【当前工作目录】解析的，
  //   而这个脚本可能从任何目录被调用（实测第一次就在这里报 UNRESOLVED_ENTRY）。
  const bundle = await rolldown({ input: join(here, entry), external });
  try {
    await bundle.write({ file: outFile, format: 'esm' });
    console.log('已打包 ' + outFile);
  } finally {
    await bundle.close();
  }
}
