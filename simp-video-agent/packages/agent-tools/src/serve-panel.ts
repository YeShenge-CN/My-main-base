/**
 * 面板常驻服务：起一个静态服务，把交互界面打开。
 *
 * 用法（仓库根目录，先 `pnpm --filter @sva/agent-tools build:cli`）：
 *   node packages/agent-tools/dist/serve-panel.mjs
 *   node packages/agent-tools/dist/serve-panel.mjs --doc out/panel-demo.json --no-open
 *   node packages/agent-tools/dist/serve-panel.mjs --reasoning high   # 打开思考模式
 *
 * ★ 为什么不写"第二份服务"：静态服务、端口守卫、MIME 表都已经在
 *   engine-node/src/server.ts 里（导出管线在用同一份）。这里只把它包起来，
 *   再顺手打开浏览器。多写一份的结果一定是两份慢慢漂。
 *
 * ★ 需要 danger-full-access：Chrome 在 Windows 上用命名管道做 Mojo IPC，
 *   受限沙箱禁止命名管道（docs/environment.md 有完整实测证据）。
 *   加 --no-open 时只起静态服务、不拉 Chrome，受限模式下也能用。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SceneDoc, ShotFrame } from '@sva/engine-core';
import { buildPreviewBundle } from '@sva/engine-node/internal';
import { renderFramesWithChrome } from '@sva/engine-node/export';
import type { ChromeFrames } from './export-job';
import { DEFAULT_REASONING, isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from './deepseek';
import { resolveApiKey, startPanelServer } from './panel-server';

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

const noOpen = process.argv.includes('--no-open');
const rebuild = !process.argv.includes('--no-build');
const docArg = argValue('--doc', '');
const modelArg = argValue('--model', '');

/**
 * 思考强度。省略 = 用 DEFAULT_REASONING（high）。
 *
 * ★ 它现在只是【页面初始值】：面板顶部有下拉框，用户随时能改，改完每一轮都带上。
 *   所以这个命令行参数管的是「刚打开页面时选中哪一档」。
 * ★ 非法值【当场报错退出】而不是静默降级：静默降级会让人以为开了思考。
 */
const reasoningArg = argValue('--reasoning', '');
if (reasoningArg !== '' && !isReasoningEffort(reasoningArg)) {
  console.error('--reasoning 只接受 ' + REASONING_EFFORTS.join(' / ') + '，收到：' + reasoningArg);
  process.exit(2);
}
const reasoningEffort: ReasoningEffort | undefined = reasoningArg === '' ? undefined : reasoningArg;
const docPath = docArg === '' ? join(ROOT, 'out', 'panel-demo.json') : resolve(process.cwd(), docArg);

function findChrome(): string | undefined {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return undefined;
}

/** 面板文档：默认用演示文档；没有就现场造一个"有东西可看"的镜头。 */
function ensureDoc(): string {
  if (existsSync(docPath)) return docPath;
  mkdirSync(dirname(docPath), { recursive: true });
  const demo = {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['plot#1'] }],
    objects: {
      'plot#1': {
        shape: 'plot2d',
        owner: { kind: 'global' },
        params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
        style: { stroke: { v: '#4ea1ff' }, width: { v: 4 }, glow: { v: 0.6 } },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: { 'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1.2, v: 1, ease: 'easeOutCubic' }] } },
        effects: ['eff#1'],
      },
    },
    effects: {
      'eff#1': { type: 'drawOn', target: 'plot#1', params: { start: { v: 0.2 }, duration: { v: 2.5 }, mode: { v: 'arc' }, tip: { v: true } } },
    },
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [{ id: 'intro', t: 0 }],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
  writeFileSync(docPath, JSON.stringify(demo, null, 2));
  return docPath;
}

ensureDoc();

if (rebuild) {
  // 面板改动之后必须重新打包，否则浏览器里跑的是旧代码 ——
  // 而且它看起来一切正常（页面能开、控件能点），只是逻辑是旧的。
  await buildPreviewBundle(join(ROOT, 'packages', 'panel', 'src', 'boot.ts'), join(ROOT, 'out', 'panel-bundle.js'));
  console.log('已重新打包面板 bundle');
}

const apiKey = resolveApiKey(ROOT);
if (apiKey === '') {
  console.log('⚠ 没有找到 DEEPSEEK_API_KEY（环境变量或 .env.local）—— 编辑器可用，但聊天窗口发不出消息。');
}

/**
 * Chrome 渲染后端：在宿主这一层提供。
 *
 * ★ 只在用户显式选 chrome 时才会被调用（默认走 canvas），因为它慢得多、
 *   而且需要 danger-full-access（Chrome 用命名管道做 Mojo IPC）。
 *
 * ★ 用【静态】import 而不是动态 import()：
 *   动态 import 会触发打包器的 code-splitting，与"单文件产物"冲突；
 *   而把它标成 external 又会在运行期解析失败 —— engine-node 的 exports 指向
 *   .ts 源码（本仓库靠打包器解析无扩展名 import，Node 直跑必然 ERR_MODULE_NOT_FOUND）。
 *   静态 import 让这段代码被打进同一个 bundle，两种麻烦一起消失。
 *   代价：bundle 里始终带着 chrome 那条路，即便你从不用它。
 */
const chromeRender = async (doc: SceneDoc, frames: readonly ShotFrame[]): Promise<ChromeFrames> => {
  const docHash = createHash('sha256').update(JSON.stringify(doc)).digest('hex');
  const handle = await renderFramesWithChrome({
    doc,
    docHash,
    frames,
    rootDir: ROOT,
    docFileName: 'out/panel-export-doc.json',
    userDataDir: join(ROOT, 'out', 'chrome-profile-export'),
  });
  try {
    return { pngs: handle.result.pngs, chromeVersion: handle.result.chromeVersion };
  } finally {
    await handle.session.close();
    await handle.server.close();
  }
};

const server = await startPanelServer({
  root: ROOT,
  docPath,
  apiKey,
  chromeRender,
  ...(modelArg === '' ? {} : { model: modelArg }),
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
});
// startPanelServer 已经包了静态服务，所以面板地址带 doc 查询参数；
// 路径用相对 URL 拼，不依赖端口。
const url = server.panelUrl.replace('?doc=', '?doc=');
console.log('面板地址 : ' + url);
console.log('聊天接口 : ' + server.origin + '/api/chat' + (apiKey === '' ? '（未配置 key）' : ''));
console.log('思考强度 : ' + (reasoningEffort ?? DEFAULT_REASONING + '（默认；页面上那个下拉框可随时改）'));
console.log('文档     : ' + docPath);
console.log('静态根   : ' + ROOT);

if (!noOpen) {
  const chrome = findChrome();
  if (chrome === undefined) {
    console.log('找不到 Chrome，请手动打开上面的地址。');
  } else {
    const profile = join(ROOT, 'out', 'chrome-profile-panel-live');
    const child = spawn(chrome, ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', url], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    console.log('已拉起 Chrome（若没弹窗，手动打开上面的地址）。');
  }
}

const stop = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

/**
 * 兜底：任何一路没接住的异步异常都不该把面板服务带走。
 *
 * ★ 实测代价：导出作业里 spawn ffmpeg 同步抛 EPERM（沙箱禁管道 stdio），
 *   异常穿透了 void runExport(...) —— 整个服务进程直接终止，
 *   浏览器那边只看到一串"无法连接"。一个后台作业失败不该等于服务下线。
 */
process.on('unhandledRejection', (reason) => {
  console.error('[未捕获的异步异常] ' + (reason instanceof Error ? reason.stack ?? reason.message : String(reason)));
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获的异常] ' + err.stack);
});

console.log('服务已就绪，Ctrl+C 结束。');
await new Promise(() => {});
