/**
 * 压力测试：真实跑 20 个独立镜头任务，采集健康指标。
 *
 * 默认跳过：SVA_STRESS=1 pnpm test
 *
 * ★ 度量口径（必须写在前面，否则数字会被误读）：
 *   intervention_rate  本测试里【没有真人】。口径 = 出现提案的比例。
 *                      提案正是"引擎判定需要人类批准"的信号，所以它可以代理介入率，
 *                      但它测不到"真人不同意"这件事。
 *   stale_rate         天然臂恒为 0（没有并发写入者）。所以每 5 个任务额外跑一条
 *                      【对抗臂】：提案挂起后由 user 去写同一条路径，再判审批。
 *                      两个数分开统计，不混在一起。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyCommands,
  createJournal,
  evaluateProposal,
  fieldValues,
  validate,
  type Proposal,
  type SceneDoc,
  type Command,
} from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node';
import { BudgetTracker } from '../src/budget';
import { emptyShot as emptyShotDoc, shotWithPlot } from '../src/shot';
import { runShot, type ToolTrace } from '../src/runtime';
import { dispatchTool, type ToolContext } from '../src/tools';

const ENABLED = process.env['SVA_STRESS'] === '1';
/**
 * 两个【互相独立】的臂。上一轮我把"完成度"和"协作路径"塞进同一次运行，
 * 于是两种数据都不可信 —— 夹具同时影响任务语义和协作触发。
 * 现在分开：夹具不同、任务集不同、报告文件也不同。
 */
const MODE = process.env['SVA_STRESS_MODE'] === 'collab' ? 'collab' : 'completion';
const COLLAB = MODE === 'collab';
/** 审批决策分支。三种都要在真实运行里跑过，不能只有 approve。 */
const DECISION = process.env['SVA_STRESS_DECISION'] ?? 'approve';

/** 用户手定值：把命令里第一个数值字段换掉（override 用）。 */
function withValue(c: Command, v: number): Command {
  const w = c as unknown as Record<string, unknown>;
  for (const k of ['width', 'glow', 'opacity', 'x', 'y', 'rotate', 'sx', 'sy', 'samples']) {
    if (typeof w[k] === 'number') return { ...w, [k]: v } as unknown as Command;
  }
  return c;
}

/**
 * 审批结果分布。
 *
 * 口径：approvalPolicy 里每判一次提案就 push 一次 d.kind，所以
 *   approve       版本没动、前提成立
 *   fast-forward  版本前进了但本提案要写的路径没被别人碰过
 *   stale         前提不成立（对抗臂的目标就是让它出现）
 * 与 approved_executed_total 的区别：后者数的是"判定通过【并且】真的执行成功"，
 * 它比 counts 小就说明"判过了但没落地"，那是另一种故障。
 */
function summarizeDecisions(kinds: readonly string[]): {
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
} {
  const counts: Record<string, number> = {};
  for (const k of kinds) counts[k] = (counts[k] ?? 0) + 1;
  return { counts, total: kinds.length };
}
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const TASKS: readonly string[] = [
  '画一条 y=sin(x) 的曲线，x 从 -7 到 7，用 1.5 秒从无到有生长出来。',
  '画一条 y=cos(x) 的曲线，然后用 3 秒推近它。',
  '画 y=x^2/8 的抛物线，让它按弧长生长 2 秒。',
  '画 y=sin(2*x) 的曲线，线宽 6，颜色用亮青色。',
  '画两条曲线：y=sin(x) 和 y=cos(x)，都要能看见。',
  '画一条曲线，加一行中文标题在顶部。',
  '画 y=exp(-x^2)*3 的钟形曲线，用 2 秒生长。',
  '画一条曲线然后让相机推近，最后加一行文字说明。',
  '画 y=abs(sin(x)) 的曲线，发光强一点。',
  '画 y=sin(x)/x 的曲线，注意原点附近。',
  '画一条曲线，把它整体往上挪 1 个单位。',
  '画一条曲线，不透明度从 0 淡入到 1。',
  '画 y=tan(x) 的曲线，x 范围 -1 到 1。',
  '画一条曲线，然后把它旋转 30 度。',
  '画 y=floor(x) 的阶梯图。',
  '画一条曲线，标题写「信号采样」。',
  '画 y=sin(x)+sin(3*x)/3 的叠加波形。',
  '画一条曲线，先推近再拉远。',
  // ★ #19/#20 原来是"把【这条】曲线加粗，线宽改成 8" —— 而 completion 臂是空文档，
  //   "这条曲线"并不存在。实测结果：Agent 正确地读摘要、看到 empty_shot、如实报告
  //   "场景为空，没有可改的目标"，而判据把它记成"一次写入都没成功"。
  //   那不是模型不行，是【任务与夹具不匹配】：这两条任务本来就属于 collab 臂。
  //   现在改成从零生成，并且带一个可检验的硬要求（线宽/发光的确切值）——
  //   C 方案的价值就在于有真值可测：不只是"建出来了"，而是"建成了要求的那个样子"。
  '画一条曲线，线宽必须是 8。没有现成的曲线，你需要自己建一条。',
  '画一条曲线，发光强度必须是 0.9，让它亮一点。曲线需要你自己建。',
];

/** collab 臂的任务：全部指向那条【被锁住】的路径，逼出提案。 */
/**
 * collab 臂的任务：【意图级】诉求，不是"把 X 设成 N"的命令。
 *
 * 上一版全是"把线宽改成 N"，而 width 是 hard 锁 —— 等于在叫模型做一件
 * 系统刚刚告诉它别做的事。模型于是礼貌地绕开，proposals 恒为 0。
 * 这不是模型不行，是任务写错了：协作本来就该由【判断】触发，不是直接命令。
 */
/** 明确指向被硬锁字段的任务。配合新提示词里的"看到锁照样提交，引擎会转成提案"。 */
const LOCK_TASKS: readonly string[] = [
  '把这条曲线的线宽改成 8。',
  '线宽调大到 7。',
  '把线宽设为 5.5。',
  '线宽加粗到 9。',
  '把发光强度调到 0.9。',
  '发光设成 0.95。',
  '把发光降到 0.1。',
  '线宽 6，发光 0.8。',
  '线宽改成 10。',
  '发光设成 0。',
  '线宽 8、发光 0.9。',
  '线宽 4.5。',
  '发光 0.3。',
  '线宽和发光都调高。',
  '线宽设成 6.5。',
  '发光 0.85。',
  '线宽调到 9.5。',
  '发光改成 0.2。',
  '线宽设为 8.5。',
  '发光 0.7。',
];

/**
 * 起始文档统一从 shot.ts 取（与 CLI、验收测试同一份），不再各自抄一遍。
 *
 * ★ collab 臂要的"一条已有曲线 + 三条硬锁"就是 shot.ts 的 locked 预设，
 *   先取它再覆写视口/时长与曲线参数 —— 两处曾经各写一遍，而且已经漂了。
 */
function emptyShot(): SceneDoc {
  // completion 臂：空文档。任务语义必须是"从零画一条曲线"，
  // 预置对象会把"画曲线"悄悄变成"改已有曲线"，判据随之失真。
  return COLLAB
    ? shotWithPlot({
        locks: ['plot#1.style.width', 'plot#1.style.glow', 'plot#1.style.stroke'],
        duration: 6,
        viewport: [480, 270],
      })
    : emptyShotDoc({ viewport: [480, 270], duration: 6 });
}

/**
 * 意图检验（C 方案的核心）。
 *
 * 任务的硬要求是"线宽必须是 8"这种【可检验的真值】。判据如果只看
 * "文档里有对象"，那模型建一条线宽 3 的曲线也算过 —— 而它并没有照做。
 * 这里刻意只在任务里写死了确切数值时才检查，不猜"好不好看"。
 */
interface TaskExpectation {
  readonly styleKey: 'width' | 'glow';
  readonly value: number;
  readonly tolerance: number;
  readonly label: string;
}

const TASK_EXPECTATIONS: Readonly<Record<string, TaskExpectation>> = {
  '画一条曲线，线宽必须是 8。没有现成的曲线，你需要自己建一条。': {
    styleKey: 'width',
    value: 8,
    tolerance: 0.01,
    label: '线宽=8',
  },
  '画一条曲线，发光强度必须是 0.9，让它亮一点。曲线需要你自己建。': {
    styleKey: 'glow',
    value: 0.9,
    tolerance: 0.01,
    label: '发光=0.9',
  },
};

interface IntentCheck {
  /** 没有任何可检验的硬要求时是 null（大部分任务如此）。 */
  readonly label: string | null;
  readonly expected: number | null;
  readonly actual: number | null;
  readonly satisfied: boolean;
}

/** 取文档里所有对象上该字段的值（取最大值：多建一条不罚，但至少要有一条达标）。 */
function intentCheckOf(task: string, doc: SceneDoc): IntentCheck {
  const expectation = TASK_EXPECTATIONS[task];
  if (expectation === undefined) {
    return { label: null, expected: null, actual: null, satisfied: true };
  }
  const values: number[] = [];
  for (const id of Object.keys(doc.objects)) {
    const obj = doc.objects[id];
    if (obj === undefined) continue;
    const raw = fieldValues(obj.style)[expectation.styleKey];
    if (typeof raw === 'number' && Number.isFinite(raw)) values.push(raw);
  }
  const actual = values.length === 0 ? null : Math.max(...values);
  return {
    label: expectation.label,
    expected: expectation.value,
    actual,
    satisfied: actual !== null && Math.abs(actual - expectation.value) <= expectation.tolerance,
  };
}

interface ShotMetrics {
  readonly index: number;
  readonly task: string;
  readonly ok: boolean;
  readonly failReason: string;
  readonly turns: number;
  readonly finished: boolean;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly batchCount: number;
  readonly reads: number;
  readonly writes: number;
  readonly autofixed: number;
  readonly issuesTotal: number;
  readonly agentWrites: number;
  readonly approvedExecuted: number;
  readonly decisionKinds: readonly string[];
  readonly validateCycles: number;
  readonly proposals: number;
  readonly stale: number;
  readonly errors: number;
  readonly imagesUsed: number;
  readonly imagesLeftInContext: number;
  readonly arm: 'natural' | 'adversarial';
  /** 是否被轮数上限截断（区别于"模型卡住"）。 */
  readonly truncated: boolean;
  /** 任务里写死的硬要求是否被满足（没有硬要求的任务是 null）。 */
  readonly intent: IntentCheck;
  /**
   * 本镜的原始工具轨迹（每个工具调用两行）。
   *
   * ★ 它是【每个镜头都带】的，不再只挂在 SVA_STRESS_TRACE 上。
   *   零写入收尾这种问题，指标只能告诉你"没写"，写进报告的轨迹才能告诉你"它读了什么、
   *   为什么决定不写"。跑一次就要留下能复盘的东西。
   */
  readonly traceLines: readonly string[];
}

/** 把一次运行的原始工具轨迹整理成可读行。零写入类问题只有靠它才能复盘。 */
function traceLinesOf(index: number, task: string, doc: SceneDoc, result: { readonly trace: readonly ToolTrace[] }): string[] {
  const out: string[] = [
    '===== 镜头 #' + index + ' 的原始 trace =====',
    '  task: ' + task,
    '  objects: ' + JSON.stringify(Object.keys(doc.objects)),
    '  locks: ' + JSON.stringify(Object.keys(doc.locks)),
  ];
  for (const t of result.trace) {
    out.push('  [turn ' + t.turn + '] ' + t.name);
    out.push('    args: ' + JSON.stringify(t.args).slice(0, 400));
    out.push('    ret : ' + t.result.slice(0, 400));
  }
  return out;
}

function apiKey(): string {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  if (line === undefined) throw new Error('缺少 DEEPSEEK_API_KEY');
  return line.slice('DEEPSEEK_API_KEY='.length).trim();
}

async function runOne(index: number, task: string, arm: 'natural' | 'adversarial'): Promise<ShotMetrics> {
  const journal = createJournal(emptyShot(), { now: () => 1_700_000_000_000 });
  const budget = new BudgetTracker('shot-' + index);
  let clock = 1_700_000_000_000;
  const seen: Proposal[] = [];
  const decisions: string[] = [];
  let validateCycles = 0;
  let lastIssueCount = -1;
  let autofixed = 0;
  let approvedExecuted = 0;
  const decisionKinds: string[] = [];

  const ctx: ToolContext = {
    doc: () => journal.currentDoc(),
    journal,
    budget,
    baseVersion: () => journal.currentVersion(),
    turnId: 'shot-' + index,
    render: (d, ts) =>
      renderFrames(d, ts).map((f) => ({ t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 })),
    now: () => (clock += 1000),
    // 制作约束：这一镜的对象已经排满，只能改已有对象。
    ...(COLLAB
      ? {
          policy: (c: Command) =>
            c.op === 'create_plot' || c.op === 'add_effect'
              ? '这一镜的对象已经排满，不能新增。请修改已有的 plot#1。'
              : null,
        }
      : {}),
    // ★ 审批不再只是记一笔：批准 → 【真的执行】→ 文档变化。
    //   在此之前这段是空的，所以『决策 → 执行』从未在端到端里被验证过。
    approvalPolicy: (list) => {
      const out: string[] = [];
      for (const item of list) {
        const p = item.proposal;
        seen.push(p);
        if (DECISION === 'fast-forward') {
          // 制造『版本前进，但本提案要写的路径没被碰过』—— 写一个别的字段即可。
          applyCommands(
            { baseVersion: journal.currentVersion(), commands: [{ op: 'set_transform', target: 'plot#1', x: 0.5 }] },
            { journal, budget: () => budget.remaining(), actor: 'user', now: () => (clock += 1000) },
          );
        }
        const d = evaluateProposal(p, {
          doc: journal.currentDoc(),
          currentVersion: journal.currentVersion(),
          writtenSince: journal.query({ from: p.baseVersion + 1 }).flatMap((o) => o.affectedPaths),
        });
        decisionKinds.push(d.kind);
        const cmd = DECISION === 'override' ? withValue(p.command, 99) : p.command;
        const res = applyCommands(
          { baseVersion: journal.currentVersion(), commands: [cmd] },
          { journal, budget: () => budget.remaining(), actor: 'user', now: () => (clock += 1000) },
        );
        if (res.ok.length > 0) approvedExecuted += 1;
        out.push(d.kind + (res.ok.length > 0 ? '+executed' : '+blocked') + ':' + p.proposalId);
      }
      decisions.push(...out);
      return out;
    },
    takeProposalDecisions: () => decisions.splice(0, decisions.length),
  };

  // validate 轮数：包一层，数"从红到绿"
  const originalDispatch = dispatchTool;
  void originalDispatch;

  const result = await runShot({
    apiKey: apiKey(),
    task,
    ctx,
    // 8 轮实测偏紧：#10/#12 都是"写到一半、还在自愈"就被截断记成失败。
    // 纠错花掉的那两轮是健康行为，不是浪费。
    maxTurns: 12,
    onTurn: () => {
      const issues = validate(journal.currentDoc());
      if (lastIssueCount !== 0 || issues.length > 0) validateCycles += 1;
      lastIssueCount = issues.length;
    },
  });

  // 结算时的真实问题数
  const finalIssues = validate(journal.currentDoc());

  // 对抗臂：提案挂起后由 user 写同一条路径，再判审批
  let stale = 0;
  if (arm === 'adversarial') {
    for (const p of seen) {
      const parts = p.target.split('.');
      const target = parts[0];
      const key = parts[2];
      if (target === undefined || key === undefined) continue;
      const cmd =
        key === 'width' || key === 'glow'
          ? { op: 'set_style' as const, target, [key]: 42 }
          : null;
      if (cmd === null) continue;
      const { applyCommands } = await import('@sva/engine-core');
      applyCommands(
        { baseVersion: journal.currentVersion(), commands: [cmd] },
        { journal, budget: () => budget.remaining(), actor: 'user', now: () => (clock += 1000) },
      );
      const d = evaluateProposal(p, {
        doc: journal.currentDoc(),
        currentVersion: journal.currentVersion(),
        writtenSince: [p.target],
      });
      if (d.kind === 'stale') stale += 1;
    }
  }

  const traceLines = traceLinesOf(index, task, journal.currentDoc(), result);
  if (process.env['SVA_STRESS_TRACE'] === '1') {
    for (const line of traceLines) console.log(line);
  }
  const reads = result.trace.filter((t) => t.name.startsWith('get_')).length;
  const writes = result.trace.filter((t) => t.name === 'apply_commands').length;
  const batches = result.trace.filter((t) => t.name === 'apply_commands');
  for (const b of batches) {
    const m = /"autofixed":\[(.*?)\]/.exec(b.result);
    const g = m?.[1];
    if (g !== undefined && g !== '') autofixed += g.split('},').length;
  }

  // ★ 判据必须落在【Agent 自己的产出】上。
  //   上一版写的是"文档里有对象"，而夹具预热了一个对象 ——
  //   于是 20/20 通过、而 Agent 一次 apply_commands 都没发过。
  //   改夹具的同时改判据，就会制造这种假数据。
  // ★ 判据落在"Agent 有没有成功写入过"，而不是"有没有 create"。
  //   上一版要求 create，惩罚了正确答案：在已有的曲线上改表达式本来就是对的。
  const agentWrites = journal.operations().filter((o) => o.actor === 'agent').length;
  // ★ 意图检验：任务写死的硬要求（线宽=8 / 发光=0.9）必须真的落到文档里。
  //   只判"有对象"会让"建了一条线宽 3 的曲线"也算过 —— 而它并不算照做。
  const intent = intentCheckOf(task, journal.currentDoc());
  // 协作臂的成功口径：Agent 的意图被实现即可 —— 自己写入，或提案获批后被执行。
  const ok =
    result.finished &&
    finalIssues.length === 0 &&
    (agentWrites > 0 || approvedExecuted > 0) &&
    intent.satisfied;
  const failReason = ok
    ? ''
    : !intent.satisfied
      ? '没照做：要求 ' + String(intent.label) + '，实际 ' + String(intent.actual)
      : result.truncated
        ? '被轮数上限截断（写到一半，不是卡住）'
        : agentWrites === 0
          ? 'Agent 一次写入都没成功'
          : '收尾时仍有 ' + finalIssues.length + ' 条 issue: ' + finalIssues.map((i) => i.code).join(',');

  return {
    index,
    task,
    ok,
    failReason,
    turns: result.turns,
    finished: result.finished,
    tokens: result.usage.promptTokens + result.usage.completionTokens,
    toolCalls: result.trace.length,
    batchCount: writes,
    reads,
    writes,
    autofixed,
    issuesTotal: finalIssues.length,
    agentWrites,
    approvedExecuted,
    decisionKinds,
    validateCycles,
    proposals: seen.length,
    stale,
    errors: 0,
    imagesUsed: budget.remaining().imagesUsed,
    imagesLeftInContext: Math.max(0, 3 - Math.min(3, budget.remaining().imagesUsed)),
    arm,
    truncated: result.truncated,
    intent,
    traceLines,
  };
}

describe.skipIf(!ENABLED)('压力测试：20 个镜头', () => {
  it('真实跑完并输出健康指标', async () => {
    const ONE = process.env['SVA_STRESS_ONE'] === '1';
    const all = COLLAB ? LOCK_TASKS : TASKS;
    // ★ SVA_STRESS_ONE 只跑最后两条，但【编号必须保持全量口径】。
    //   上一版从 1 重新编号，于是 "追 #19/#20" 跑出来的报告写着 index=1/2 ——
    //   读报告的人无法判断它到底对应哪两个任务。
    const offset = ONE ? Math.max(0, all.length - 2) : 0;
    const activeTasks = ONE ? all.slice(offset) : all;
    const shots: ShotMetrics[] = [];
    const traceDumps: string[] = [];
    for (let i = 0; i < activeTasks.length; i++) {
      const task = activeTasks[i];
      if (task === undefined) continue;
      const taskIndex = offset + i + 1;
      const arm = taskIndex % 5 === 0 ? 'adversarial' : 'natural';
      // 两个分支（成功 / 抛异常）都会给它赋值，所以这里只声明不初始化 ——
      // eslint 的 no-useless-assignment 会挡住"赋一个马上被覆盖的值"。
      let dumpLines: string[];
      try {
        const m = await runOne(taskIndex, task, arm);
        shots.push(m);
        dumpLines = [...m.traceLines];
        console.log('[stress] #' + m.index + ' ' + (m.ok ? 'OK ' : 'FAIL') + ' turns=' + m.turns + ' tokens=' + m.tokens + ' proposals=' + m.proposals + ' ' + m.failReason);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dumpLines = ['===== 镜头 #' + taskIndex + ' 抛异常 =====', '  task: ' + task, '  err : ' + msg];
        shots.push({
          index: taskIndex, task, ok: false, failReason: '异常: ' + msg.slice(0, 200), turns: 0, finished: false,
          tokens: 0, toolCalls: 0, batchCount: 0, reads: 0, writes: 0, autofixed: 0, issuesTotal: -1, agentWrites: 0,
          approvedExecuted: 0,
          decisionKinds: [],
          validateCycles: 0, proposals: 0, stale: 0, errors: 1, imagesUsed: 0, imagesLeftInContext: 0, arm,
          truncated: false,
          intent: { label: null, expected: null, actual: null, satisfied: true },
          traceLines: [],
        });
      }
      traceDumps.push(dumpLines.join('\n'));
    }

    const allKinds = shots.flatMap((x) => x.decisionKinds);
    const successes = shots.filter((s) => s.ok);
    const natural = shots.filter((s) => s.arm === 'natural');
    const adversarial = shots.filter((s) => s.arm === 'adversarial');
    const proposals = shots.reduce((a, s) => a + s.proposals, 0);
    const stale = adversarial.reduce((a, s) => a + s.stale, 0);
    const adversarialProposals = adversarial.reduce((a, s) => a + s.proposals, 0);

    const report = {
      total: shots.length,
      success: successes.length,
      task_success_rate: successes.length / shots.length,
      intervention_rate: shots.filter((s) => s.proposals > 0).length / shots.length,
      token_per_success: successes.length === 0 ? null : successes.reduce((a, s) => a + s.tokens, 0) / successes.length,
      validate_cycles: shots.length === 0 ? 0 : shots.reduce((a, s) => a + s.validateCycles, 0) / shots.length,
      // 判据说明：自然臂恒为 0 不是漏了 precondition，是没有竞争者。
      // 单 Agent 单镜头下，提案挂起后没有人会写同一条路径。
      // 真正有信号的是对抗臂。
      stale_rate_natural: natural.length === 0 ? null : 0,
      stale_rate_adversarial: adversarialProposals === 0 ? null : stale / adversarialProposals,
      image_cost_avg: shots.length === 0 ? 0 : shots.reduce((a, s) => a + s.imagesUsed, 0) / shots.length,
      diagnostics: {
        tool_calls_avg: shots.length === 0 ? 0 : shots.reduce((a, s) => a + s.toolCalls, 0) / shots.length,
        batch_count_avg: shots.length === 0 ? 0 : shots.reduce((a, s) => a + s.batchCount, 0) / shots.length,
        read_before_write_ratio:
          shots.reduce((a, s) => a + s.reads, 0) /
          Math.max(1, shots.reduce((a, s) => a + s.reads, 0) + shots.reduce((a, s) => a + s.writes, 0)),
        autofix_ratio: shots.reduce((a, s) => a + s.autofixed, 0) / Math.max(1, shots.reduce((a, s) => a + s.issuesTotal + s.autofixed, 0)),
      },
      proposals_total: proposals,
      approved_executed_total: shots.reduce((a, x) => a + x.approvedExecuted, 0),
      decision: DECISION,
      decision_kinds: allKinds,
      // ★ 每个决策分支的分布要能一眼读出来，而不是只在数组里数。
      //   上一版实测：approve / fast-forward / override 三条路的 decision_kinds
      //   都只有一种值，靠原始数组看等于人工数 20 个字符串。
      decision_kinds_summary: summarizeDecisions(allKinds),
      // ★ 有硬要求的任务单独统计：这是"照做了吗"的真值，不是"有没有动过手"。
      //   混进总的成功率里会被"建了但没照要求建"稀释掉。
      intent_checks: shots
        .filter((s) => s.intent.label !== null)
        .map((s) => ({
          index: s.index,
          task: s.task,
          requirement: s.intent.label,
          expected: s.intent.expected,
          actual: s.intent.actual,
          satisfied: s.intent.satisfied,
        })),
      shots,
      // 每个镜头的原始工具轨迹，跟报告一起落盘 —— 指标说"没写"，轨迹说"为什么"。
      trace: traceDumps,
    };

    mkdirSync(join(ROOT, 'out'), { recursive: true });
    // ★ 文件名必须带上决策分支。上一版只带 MODE，于是 collab 的 approve 报告
    //   被后来的 override 运行整份覆盖掉了 —— 三条决策路径的数据只剩最后一条。
    const reportFile = 'stress-report-' + MODE + '-' + DECISION + '.json';
    writeFileSync(join(ROOT, 'out', reportFile), JSON.stringify(report, null, 2));
    console.log('[stress] === 汇总 ===');
    console.log(JSON.stringify(report, null, 1).split('\n').slice(0, 30).join('\n'));

    console.log('[stress] report=' + reportFile);
    console.log('[stress] mode=' + MODE + ' decision=' + DECISION + ' 成功=' + successes.length + '/' + shots.length);
    // 轨迹随日志一起打出来（报告里也有一份）。只跑两条时这是最直接的复盘材料。
    for (const dump of traceDumps) console.log('[stress] ' + dump.split('\n').join('\n[stress] '));
    expect(shots.length).toBeGreaterThan(0);
  }, 3_600_000);
});

describe.skipIf(ENABLED)('压力测试（未启用）', () => {
  it('默认跳过，需要 SVA_STRESS=1', () => {
    expect(ENABLED).toBe(false);
  });
});