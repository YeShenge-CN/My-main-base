/**
 * 单镜头 CLI：把 Agent 跑起来，看得见它每一步做了什么、最后画出了什么。
 *
 * 用法（在仓库根目录）：
 *   node --experimental-strip-types packages/agent-tools/cli.ts --list
 *   node --experimental-strip-types packages/agent-tools/cli.ts --preset empty \
 *     --task "画一条 y=sin(x) 的曲线，用 2 秒生长出来" --render
 *
 * 参数：
 *   --task <文字>        任务描述（必填，除非 --list）
 *   --preset <id>        起始文档预设，见 --list。默认 empty
 *   --doc <路径>         直接给一份 Scene Doc（优先于 --preset）
 *   --out <目录>         产物目录，默认 out/run
 *   --render             跑完渲染若干帧（默认 t=0 与 t=duration）
 *   --at <秒,秒>         指定渲染时刻
 *   --max-turns <n>      轮数上限
 *   --model <名字>       DeepSeek 模型
 *   --quiet              只打关键行
 *   --list               列出预设与用法后退出
 *
 * API key：优先 $env:DEEPSEEK_API_KEY，其次仓库根的 .env.local。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SceneDoc } from '@sva/engine-core';
import { evaluate, planShotFrames, type Issue, type summarizeIssues } from '@sva/engine-core';
// ★ 只取 engine-node 的【无浏览器】半边：包根会拖进 puppeteer-core
//   （chrome/screenshot/export 那条链），而跑一个镜头只需要 canvas 渲染。
import { renderFrames } from '@sva/engine-node/headless';
import { SHOT_PRESETS, presetById } from './src/shot';
import { runOneShot, type RunOneShotResult, type ShotRenderer } from './src/run';
import { resolveShotTasks, runMultiShot, type RunMultiShotResult, type ShotTask } from './src/multi-shot';
import type { ToolEvent } from './src/runtime';

/**
 * 找仓库根。
 *
 * ★ 不能写死相对深度：这个文件的【源】在 packages/agent-tools/cli.ts，
 *   而【产物】在 packages/agent-tools/dist/cli.mjs —— 同一个 '../../'
 *   在两处指向不同的地方（实测第一版就因为少了一层而找不到 .env.local）。
 *   所以从产物位置逐级向上找"同时有 pnpm-workspace.yaml 与 packages/ 的那一层"。
 */
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

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

interface Args {
  task?: string;
  preset: string;
  docPath?: string;
  outDir: string;
  render: boolean;
  at?: readonly number[];
  maxTurns?: number;
  model?: string;
  quiet: boolean;
  list: boolean;
  /** 不调模型，只用当前文档渲染抽样帧。用于复查一次已有产物。 */
  noAgent: boolean;
  /**
   * 按镜头渲染：只画这一镜的内容（与导出同一条判据）。
   *
   * ★ 不传时渲染【全部对象】—— 那是单镜头诊断想要的口径（看整片铺开），
   *   但对多镜头文档会误导：画面里会同时出现几镜的内容，
   *   而成片里它们各归各的。要按镜看就给这个参数。
   */
  scene?: string;
  /** 把每一镜的首帧各渲染一张（多镜头复查用，不用先知道镜头 id）。 */
  allScenes: boolean;
  /**
   * 多镜头串行：按镜头表逐镜起一个 Agent。
   *
   * 取值是逐镜任务，形如 `s#1:画正弦;s#2:画波包`；
   * 只写 `--multi`（不给值）时每一镜都跑 --task 那一个任务。
   */
  multi?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    preset: 'empty',
    outDir: join(findRepoRoot(process.cwd()), 'out', 'run'),
    render: false,
    quiet: false,
    list: false,
    noAgent: false,
    allScenes: false,
  };
  const out: Record<string, unknown> = { ...args };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith('--')) throw new Error(flag + ' 缺少取值');
      i += 1;
      return value;
    };
    switch (flag) {
      case '--task': out['task'] = take(); break;
      case '--preset': out['preset'] = take(); break;
      case '--doc': out['docPath'] = take(); break;
      case '--out': out['outDir'] = take(); break;
      case '--model': out['model'] = take(); break;
      case '--max-turns': out['maxTurns'] = Number(take()); break;
      case '--at': out['at'] = take().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)); break;
      case '--render': out['render'] = true; break;
      case '--quiet': out['quiet'] = true; break;
      case '--list': out['list'] = true; break;
      case '--no-agent': out['noAgent'] = true; break;
      case '--scene': out['scene'] = take(); break;
      case '--all-scenes': out['allScenes'] = true; break;
      case '--multi':
        // 可选取值：下一个参数是 -- 开头（或没有）就当"不带值"
        out['multi'] = value === undefined || value.startsWith('--') ? '' : take();
        break;
      default:
        if (flag !== undefined && flag.startsWith('--')) throw new Error('未知参数: ' + flag);
    }
  }
  return out as unknown as Args;
}

function usage(): string {
  const lines = [
    '单镜头 CLI —— 把 Agent 跑在一个镜头上，并给出可检查的产物。',
    '',
    '先打包一次（改了 cli.ts 或它依赖的代码之后要重跑）：',
    '  pnpm --filter @sva/agent-tools build:cli        # 产出 packages/agent-tools/dist/cli.mjs',
    '',
    '用法：',
    '  node packages/agent-tools/dist/cli.mjs --task "画一条…" [--preset empty] [--render]',
    '',
    '预设（--preset）：',
  ];
  for (const p of SHOT_PRESETS) lines.push('  ' + p.id.padEnd(8) + p.label + ' —— ' + p.description);
  lines.push(
    '',
    '其他参数：--doc <路径> --out <目录> --max-turns 12 --model deepseek-chat --quiet',
    '          --no-agent   不调模型，只用给定文档渲染抽样帧（复查产物用，零 token 成本）',
    '          --at 0,1,2   指定抽样时刻；验证生长/淡入必须给中间时刻，只看两端看不出中间动没动',
    '          --scene s#2  只渲染这一镜的内容（与导出同一条判据）',
    '          --all-scenes 每一镜的首帧各渲染一张，叠加在 --no-agent 上',
    '                       ★ 多镜头文档不加这两个参数时是【不过滤】口径：几镜的内容会同时出现，',
    '                         而成片里它们各归各的 —— 复查画面时别被误导。',
    '',
    '产物（写在 --out 目录，默认 out/run）：',
    '  doc.json   运行结束时的 Scene Doc（可直接喂给 --doc 再跑一次）',
    '  run.json   轮数 / token / 轨迹 / 问题清单 / 提案决策',
    '  final-*.png  最终文档在 t=0 与 t=时长 的渲染（每跑必出，用来自查画面）',
    '',
    '退出码：0 正常；2 被轮数上限截断；3 收尾时仍有 error 级问题。',
  );
  return lines.join('\n');
}

function apiKey(): string {
  const fromEnv = process.env['DEEPSEEK_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const envFile = join(REPO_ROOT, '.env.local');
  if (!existsSync(envFile)) {
    throw new Error('缺少 DEEPSEEK_API_KEY：既没有环境变量，也没有 ' + envFile);
  }
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  if (line === undefined) throw new Error('.env.local 里没有 DEEPSEEK_API_KEY');
  const value = line.slice('DEEPSEEK_API_KEY='.length).trim();
  if (value === '') throw new Error('.env.local 里的 DEEPSEEK_API_KEY 是空的');
  return value;
}

function loadDoc(args: Args): { doc: SceneDoc; source: string } {
  if (args.docPath !== undefined) {
    const path = isAbsolute(args.docPath) ? args.docPath : resolve(process.cwd(), args.docPath);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as SceneDoc;
    return { doc, source: path };
  }
  const preset = presetById(args.preset);
  if (preset === undefined) {
    throw new Error('未知预设 ' + args.preset + '（可用：' + SHOT_PRESETS.map((p) => p.id).join(', ') + '）');
  }
  return { doc: preset.doc, source: 'preset:' + preset.id };
}

/**
 * 报告逻辑需要的全部字段 —— 单镜头与多镜头两条路都适配成它。
 *
 * ★ 抽这一层是为了让报告代码只写一份。两条路各写一遍的话，
 *   "Agent 操作数""问题数"这类口径迟早会分叉。
 */
interface AgentRunSummary {
  readonly doc: SceneDoc;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly agentOperations: number;
  readonly issues: readonly Issue[];
  readonly issueCounts: ReturnType<typeof summarizeIssues>;
  readonly turns: number;
  readonly truncated: boolean;
  readonly finished: boolean;
  readonly finalMessage: string;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  readonly budget: { readonly imagesUsed: number; readonly imagesLeft: number; readonly renderCallsLeft: number };
  readonly proposalDecisions: readonly string[];
  readonly trace: readonly { readonly turn: number; readonly name: string; readonly args: unknown; readonly result: string; readonly imageCount: number }[];
}

/** 单镜头结果 → 统一的报告形状。 */
function asSummary(r: RunOneShotResult): AgentRunSummary {
  return {
    doc: r.doc,
    fromVersion: r.fromVersion,
    toVersion: r.toVersion,
    agentOperations: r.agentOperations,
    issues: r.issues,
    issueCounts: r.issueCounts,
    turns: r.run.turns,
    truncated: r.run.truncated,
    finished: r.run.finished,
    finalMessage: r.run.finalMessage,
    usage: r.run.usage,
    budget: r.run.budget,
    proposalDecisions: r.run.proposalDecisions,
    trace: r.run.trace,
  };
}

/** 多镜头结果 → 统一的报告形状（逐镜相加，并把每镜的数字也带上）。 */
function summarizeMulti(r: RunMultiShotResult): AgentRunSummary & { readonly shots: RunMultiShotResult['shots'] } {
  const traces = r.shots.flatMap((s) => s.run.trace);
  const decisions = r.shots.flatMap((s) => s.run.proposalDecisions);
  return {
    doc: r.doc,
    fromVersion: r.fromVersion,
    toVersion: r.toVersion,
    agentOperations: r.shots.reduce((a, s) => a + s.agentOperations, 0),
    issues: r.issues,
    issueCounts: r.issueCounts,
    turns: r.shots.reduce((a, s) => a + s.run.turns, 0),
    // 任何一镜被截断，整体就算被截断 —— "跑完了但有一镜没跑成"不该伪装成成功
    truncated: r.shots.some((s) => s.run.truncated),
    finished: r.shots.every((s) => s.run.finished),
    finalMessage: r.shots.map((s) => s.sceneId + ': ' + s.run.finalMessage).join(' | '),
    usage: r.usage,
    budget: r.shots.reduce(
      (a, s) => ({
        imagesUsed: a.imagesUsed + s.run.budget.imagesUsed,
        imagesLeft: Math.min(a.imagesLeft, s.run.budget.imagesLeft),
        renderCallsLeft: Math.min(a.renderCallsLeft, s.run.budget.renderCallsLeft),
      }),
      { imagesUsed: 0, imagesLeft: Number.POSITIVE_INFINITY, renderCallsLeft: Number.POSITIVE_INFINITY },
    ),
    proposalDecisions: decisions,
    trace: traces,
    shots: r.shots,
  };
}

/**
 * 多镜头模式：把 `--multi "s#1:任务;s#2:任务"` 解析成逐镜任务后逐镜跑。
 *
 * 只写 `--multi`（不给值）时每一镜都跑 `--task` 那一个任务。
 */
async function runMultiMode(o: {
  readonly args: Args;
  readonly key: string;
  readonly task: string;
  readonly startDoc: SceneDoc;
  readonly render: ShotRenderer;
  readonly onTool: (ev: ToolEvent) => void;
  readonly multi: string;
}): Promise<RunMultiShotResult> {
  const tasks: ShotTask[] = [];
  for (const chunk of o.multi.split(';')) {
    const text = chunk.trim();
    if (text === '') continue;
    const at = text.indexOf(':');
    // 形如 "s#1:画正弦"；没有冒号时当成"这一镜的任务"但不知道是哪一镜 → 报错而不是猜
    if (at <= 0) throw new Error('--multi 的每一段必须形如 "s#1:这一镜要做什么"，收到：' + text);
    tasks.push({ sceneId: text.slice(0, at).trim(), task: text.slice(at + 1).trim() });
  }
  const planned = resolveShotTasks(o.startDoc, tasks.length === 0 ? undefined : tasks, o.task);
  if (planned.length === 0) {
    console.log('⚠ 这份文档没有镜头表 —— 无法逐镜分工，退化成跑一次全片。');
  }
  return runMultiShot({
    apiKey: o.key,
    ...(o.args.model === undefined ? {} : { model: o.args.model }),
    doc: o.startDoc,
    render: o.render,
    ...(tasks.length === 0 ? {} : { tasks }),
    fallbackTask: o.task,
    ...(o.args.maxTurns === undefined ? {} : { maxTurns: o.args.maxTurns }),
    onShotStart: (info) => {
      console.log('');
      console.log('── 第 ' + info.index + '/' + info.total + ' 镜 · ' + info.sceneId + ' ──');
      console.log('   任务: ' + info.task);
    },
    onTool: o.onTool,
  });
}

/** 只打一行：工具名 + 关键参数/结果，人眼能扫。 */
function briefToolLine(ev: ToolEvent): string {
  const args = ev.args as Record<string, unknown>;
  switch (ev.name) {
    case 'apply_commands': {
      const cmds = Array.isArray(args['commands']) ? (args['commands'] as { op?: string }[]) : [];
      const ops = cmds.map((c) => c.op ?? '?').join(', ');
      const res = JSON.parse(ev.result) as {
        ok?: unknown[];
        proposals?: unknown[];
        blocked?: unknown[];
        errored?: { error?: { code?: string } }[];
        autofixed?: unknown[];
        version?: number;
      };
      const bad = (res.errored ?? []).map((e) => e.error?.code ?? '?').join(',');
      return (
        'apply_commands [' + ops + '] → ok=' + (res.ok?.length ?? 0) +
        ' 提案=' + (res.proposals?.length ?? 0) +
        ' 阻断=' + (res.blocked?.length ?? 0) +
        (bad === '' ? '' : ' 错误=' + bad) +
        ' 自动修=' + (res.autofixed?.length ?? 0) +
        ' → v' + String(res.version ?? '?')
      );
    }
    case 'render_frames': {
      const res = JSON.parse(ev.result) as { frames?: { t: number }[]; budget?: { imagesLeft?: number }; error?: string };
      if (res.error !== undefined) return 'render_frames 被拒：' + res.error;
      return 'render_frames ' + (res.frames ?? []).map((f) => 't=' + f.t).join(' ') + '（剩余图片 ' + String(res.budget?.imagesLeft ?? '?') + '）';
    }
    case 'finish_shot':
      return 'finish_shot ← 收尾';
    case 'validate': {
      const res = JSON.parse(ev.result) as { counts?: { total?: number } };
      return 'validate → ' + String(res.counts?.total ?? 0) + ' 条问题';
    }
    case 'get_object': {
      const res = JSON.parse(ev.result) as { id?: string; shape?: string; params?: unknown; error?: string };
      if (res.error !== undefined) return 'get_object → ' + res.error;
      return 'get_object ' + String(res.id) + ' (' + String(res.shape) + ')';
    }
    case 'get_render_state': {
      const res = JSON.parse(ev.result) as { items?: { id: string }[]; offscreen?: number };
      return 'get_render_state → ' + (res.items ?? []).map((i) => i.id).join(',') + '（画外 ' + String(res.offscreen ?? 0) + '）';
    }
    case 'get_scene_summary': {
      const res = JSON.parse(ev.result) as { objects?: unknown[]; issues?: number; v?: number };
      return 'get_scene_summary → v' + String(res.v) + ' 对象=' + (res.objects?.length ?? 0) + ' 问题=' + String(res.issues ?? 0);
    }
    default:
      return ev.name;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log(usage());
    return 0;
  }
  if (args.task === undefined && !args.noAgent) {
    console.log(usage());
    return 1;
  }

  const { doc: startDoc, source } = loadDoc(args);
  mkdirSync(args.outDir, { recursive: true });

  /**
   * ★ --no-agent：只渲染当前文档，不调模型。
   *
   * 为什么需要它：复查一次已有产物（"这一镜到底画出来什么样"）如果每次都要
   * 付一次模型调用的钱，人就不会去复查 —— 而"跑完看一眼"正是这套东西
   * 最该形成的习惯。实测第一次实现 --doc 时就是这样：只想渲染几帧，
   * 却白烧了 14071 个输入 token。
   */
  if (args.noAgent) {
    const times = args.at !== undefined && args.at.length > 0 ? args.at : [0, startDoc.meta.duration];
    console.log('=== 只渲染（不调模型）===');
    console.log('文档      : ' + source);
    const plan = planShotFrames(startDoc);
    /**
     * ★ 镜头口径必须说清楚，否则多镜头文档的画面会被误读。
     *   --all-scenes：每镜首帧各一张（不用先知道镜头 id）
     *   --scene <id>：只画那一镜
     *   两者都不给：不过滤（单镜头诊断口径），但多镜头时明确提示。
     */
    const artifacts: string[] = [];
    if (args.allScenes) {
      if (plan.shots.length === 0) {
        console.log('文档没有镜头表（全片一镜），--all-scenes 等价于不过滤。');
      }
      for (const shot of plan.shots) {
        const f = renderFrames(startDoc, [shot.start], { sceneId: shot.sceneId })[0];
        if (f === undefined) continue;
        const name = 'shot-' + shot.sceneId.replace(/[^\w-]/g, '_') + '-t' + shot.start.toFixed(2).replace('.', '_') + '.png';
        writeFileSync(join(args.outDir, name), f.png);
        artifacts.push(name + '=' + f.sha256.slice(0, 12) + '(' + f.png.length + 'B)');
      }
      console.log('镜头数量  : ' + plan.shots.length);
      console.log('逐镜首帧  : ' + artifacts.join('  '));
      console.log('产物      : ' + join(args.outDir, 'shot-*.png'));
      return 0;
    }
    const byScene = args.scene !== undefined;
    if (plan.shots.length > 0 && !byScene) {
      console.log(
        '⚠ 这份文档有 ' + plan.shots.length + ' 个镜头，而你没有指定 --scene：' +
          '本次渲染【不过滤】，几镜的内容会同时出现（成片里它们各归各的）。' +
          '要按镜看请加 --scene <id> 或 --all-scenes。',
      );
    }
    const frames = renderFrames(startDoc, times, byScene ? { sceneId: args.scene ?? null } : {});
    const lines: string[] = [];
    for (const f of frames) {
      const name = 'final-t' + f.t.toFixed(2).replace('.', '_') + '.png';
      writeFileSync(join(args.outDir, name), f.png);
      lines.push(name + '=' + f.sha256.slice(0, 12) + '(' + f.png.length + 'B)');
    }
    if (byScene) console.log('镜头      : ' + String(args.scene));
    console.log('抽样画面  : ' + lines.join('  '));
    console.log('产物      : ' + join(args.outDir, 'final-*.png'));
    return 0;
  }

  const task = args.task;
  if (task === undefined) {
    console.log(usage());
    return 1;
  }

  const key = apiKey();
  console.log('=== 单镜头运行 ===');
  console.log('任务      : ' + task);
  console.log('起始文档  : ' + source + '（视口 ' + startDoc.meta.viewport.join('×') + '，时长 ' + startDoc.meta.duration + 's，' + Object.keys(startDoc.objects).length + ' 个对象）');
  console.log('产物目录  : ' + args.outDir);
  console.log('');

  const started = Date.now();
  // 渲染器在宿主这一层包：engine-node 出 PNG，CLI 负责把 PNG 落盘（--render）。
  const render: ShotRenderer = (docToRender, timestamps) =>
    renderFrames(docToRender, timestamps).map((f) => {
      if (args.render) {
        const name = 'frame-' + f.t.toFixed(2).replace('.', '_') + '.png';
        writeFileSync(join(args.outDir, name), f.png);
        console.log('  ↳ 写出 ' + name + '（' + f.png.length + ' 字节）');
      }
      return { t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 };
    });

  // TS 不会把"args.task !== undefined 且没走 --no-agent"这条跨分支的事实带到这里，
  // 所以上面已经显式收窄；这里直接用 task，它不可能为 undefined。
  const multi = args.multi;
  const onTool = (ev: ToolEvent): void => {
    if (ev.finished) console.log('  [turn ' + ev.turn + '] ' + ev.name);
    else if (!args.quiet) console.log('  [turn ' + ev.turn + '] ' + briefToolLine(ev));
  };

  /**
   * ★ 两条路（单镜头 / 多镜头）适配成同一个结果形状，报告逻辑只写一份。
   *
   *   它们本质上是同一件事的不同编排：多镜头就是"按 sceneOrder 逐镜跑单镜头循环"。
   *   让报告代码各写一遍，两个数字迟早会分叉（比如"Agent 操作数"的口径）。
   */
  const result: AgentRunSummary =
    multi === undefined
      ? asSummary(
          await runOneShot({
            apiKey: key,
            ...(args.model === undefined ? {} : { model: args.model }),
            task,
            doc: startDoc,
            render,
            ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
            onTool,
          }),
        )
      : summarizeMulti(await runMultiMode({ args, key, task, startDoc, render, onTool, multi }));
  const elapsed = Date.now() - started;

  console.log('');
  console.log('=== 结果 ===');
  console.log('轮数      : ' + result.turns + (result.truncated ? '（被轮数上限截断）' : '（正常收尾）'));
  console.log('文档版本  : v' + result.fromVersion + ' → v' + result.toVersion);
  console.log('Agent 操作: ' + result.agentOperations);
  console.log('问题      : ' + result.issueCounts.total + ' 条 ' + JSON.stringify(result.issueCounts.byGroup));
  console.log('图片预算  : 用了 ' + result.budget.imagesUsed + ' 张');
  console.log('token     : 输入 ' + result.usage.promptTokens + ' / 输出 ' + result.usage.completionTokens);
  console.log('耗时      : ' + (elapsed / 1000).toFixed(1) + 's');
  console.log('');
  console.log('对象      : ' + Object.keys(result.doc.objects).join(', ') || '(无)');
  for (const id of Object.keys(result.doc.objects)) {
    const item = evaluate(result.doc, result.doc.meta.duration).items.find((i) => i.id === id);
    console.log(
      '  ' + id + ' 屏幕框=[' + (item?.box.x ?? 0).toFixed(0) + ',' + (item?.box.y ?? 0).toFixed(0) +
        ' ' + (item?.box.w ?? 0).toFixed(0) + '×' + (item?.box.h ?? 0).toFixed(0) + ']' +
        ' 不透明度=' + (item?.opacity ?? 0) + ' 可见=' + (item?.visibleFraction ?? 0),
    );
  }
  if (result.issues.length > 0) {
    console.log('');
    for (const i of result.issues) {
      console.log('  [' + i.severity + '/' + i.group + '/' + i.fixClass + '] ' + i.code + ' @ ' + i.path);
      console.log('      ' + i.message);
    }
  }

  // 产物落盘：文档 + 轨迹 + 指标。跑完能复查，而不是只有一屏日志。
  writeFileSync(join(args.outDir, 'doc.json'), JSON.stringify(result.doc, null, 2));

  /**
   * ★ 最终文档的抽样渲染：每跑必出，不用加参数。
   *
   * 理由：说"做完了"和"画面里真的有东西"是两件事。有几张 PNG，
   * 跑完的第一件事就是打开看一眼 —— 这也是那个"动画写进文档但画面不动"
   * 的洞唯一能用肉眼抓住的地方。
   *
   * 默认给 t=0 与 t=时长（两端）。要验证【生长/淡入】这类过程动画，
   * 用 --at 0,1,2,12 指定中间时刻 —— 只看两端是看不出"中间有没有动"的。
   */
  const finalTimes = args.at !== undefined && args.at.length > 0 ? args.at : [0, result.doc.meta.duration];
  const finals = renderFrames(result.doc, finalTimes);
  const finalHashes: string[] = [];
  for (const f of finals) {
    const name = 'final-t' + f.t.toFixed(2).replace('.', '_') + '.png';
    writeFileSync(join(args.outDir, name), f.png);
    finalHashes.push(name + '=' + f.sha256.slice(0, 12) + '(' + f.png.length + 'B)');
  }
  const stillFrames = new Set(finals.map((f) => f.sha256)).size === 1;

  const multiShots: RunMultiShotResult['shots'] =
    'shots' in result ? (result as { shots: RunMultiShotResult['shots'] }).shots : [];

  const report = {
    task: args.task,
    preset: args.preset,
    model: args.model ?? '(default)',
    // 多镜头时额外带上逐镜的数字，复盘时才看得出是哪一镜拖了后腿
    ...(multi === undefined ? {} : { multi: true, shots: multiShots.map((s) => ({
      sceneId: s.sceneId, turns: s.run.turns, writes: s.agentOperations,
      truncated: s.run.truncated, issueCount: s.issueCount,
    })) }),
    startedAt: started,
    elapsedMs: elapsed,
    turns: result.turns,
    truncated: result.truncated,
    finished: result.finished,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    agentOperations: result.agentOperations,
    usage: result.usage,
    budget: result.budget,
    issueCounts: result.issueCounts,
    issues: result.issues.map((i) => ({ code: i.code, group: i.group, severity: i.severity, fixClass: i.fixClass, path: i.path })),
    proposalDecisions: result.proposalDecisions,
    trace: result.trace.map((t) => ({ turn: t.turn, name: t.name, args: t.args, result: t.result, imageCount: t.imageCount })),
    finalMessage: result.finalMessage,
    // 最终画面的两帧指纹：两帧相同 = 整段没有任何时间上的变化（可能是静态构图，
    // 也可能是动画没生效 —— 这条数字是判断前者的起点）。
    finalFrames: finalHashes,
    finalFramesIdentical: stillFrames,
  };
  writeFileSync(join(args.outDir, 'run.json'), JSON.stringify(report, null, 2));
  console.log('');
  console.log('最终画面  : ' + finalHashes.join('  '));
  if (stillFrames) console.log('            （t=0 与 t=' + result.doc.meta.duration + ' 的画面完全相同 —— 这一镜在时间上是静止的）');
  console.log('产物      : ' + join(args.outDir, 'doc.json') + ' , ' + join(args.outDir, 'run.json'));

  // 退出码：截断或仍有 error 级问题 → 非零。"跑完了但没跑成"不该伪装成成功。
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  if (result.truncated) return 2;
  if (errors > 0) return 3;
  return 0;
}

const cliPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
const selfPath = resolve(fileURLToPath(import.meta.url));
if (cliPath === selfPath || dirname(cliPath) === dirname(selfPath)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('运行失败: ' + (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    });
}
