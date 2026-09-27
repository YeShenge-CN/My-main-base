/**
 * 收尾判定（judgeTurn）。
 *
 * ★ 这一份存在的理由是一个真 bug：
 *   `cleanTurns >= 3`（issues 连续三轮为 0 就收尾）那条【漏了 anyWrite 护栏】，
 *   于是给 Agent 一个本来就零 issue 的文档，它连读三轮、一次没写，
 *   就被判成"做完了"。用户的要求一个字都没落地，却记成成功。
 *   实测症状（面板实机校验抓到的）：聊天里只留下一句
 *   `（Runtime 收尾：issues 已连续三轮为 0）`，而版本号一动没动。
 *
 *   而它当初能活下来，是因为这段逻辑内联在 runShot 的 for 循环里 ——
 *   想测它就得真调一次模型（要钱、要网、结果不确定），所以没人测。
 *   抽成纯函数之后，下面这些用例全都在毫秒级内跑完。
 */
import { describe, expect, it } from 'vitest';
import { judgeTurn, verdictMessage, type TurnVerdictInput, type VerdictState } from '../src/runtime';
import type { ToolTrace } from '../src/runtime';

/** apply_commands 的【成功】回执：判据看的就是这里面 ok 有几条。 */
const WROTE = JSON.stringify({ ok: [{ op: 'set_style' }], proposals: [], blocked: [], errored: [] });
/** apply_commands 的【全失败】回执：调了，但一条都没落地。 */
const FAILED = JSON.stringify({ ok: [], proposals: [], blocked: [], errored: [{ op: 'delete', error: { code: 'unsupported_op' } }] });

function row(turn: number, name: string, result?: string): ToolTrace {
  return {
    turn,
    name,
    args: {},
    // 默认给 apply_commands 一条【成功】回执：这个 helper 表达的是「写了」；
    // 要表达「调了但全失败」必须显式传 result（见下面那条用例）。
    result: result ?? (name === 'apply_commands' ? WROTE : '{}'),
    imageCount: 0,
  };
}

function trace(...rows: readonly (readonly [number, string])[]): ToolTrace[] {
  return rows.map(([turn, name]) => row(turn, name));
}

const READ_ONLY = ['get_scene_summary', 'get_object', 'get_render_state'] as const;

function input(over: Partial<TurnVerdictInput> = {}): TurnVerdictInput {
  return {
    trace: [],
    turn: 1,
    issueCount: 0,
    prev: { wrotePrevTurn: false, cleanTurns: 0 },
    stopRequested: false,
    noToolCalls: false,
    // ★ 第二十九轮新增的两个前提，默认给"看过 + 还渲染得起"——
    //   这样本文件里那些【关于 anyWrite 的老用例】仍在测它们原本要测的东西。
    //   新前提本身由下面单独一节测。
    sawFrame: true,
    canStillRender: true,
    ...over,
  };
}

const FRESH: VerdictState = { wrotePrevTurn: false, cleanTurns: 0 };

/**
 * ★★ 第二十九轮：**兜底收尾也必须"看过画面"**。
 *
 *   这是真机跑出来的：模型连着三轮把 issues 清成 0，Runtime 按 clean_three_turns
 *   收尾 —— 而 5 轮里 render_frames 一次都没有。收尾关卡管得到 finish_shot，
 *   管不到 Runtime 自己的兜底规则，于是「强制看画面」被从后门绕了过去。
 */
describe('★ 兜底收尾的第二个前提：看过画面（或已经渲染不起了）', () => {
  it('★ issues 连三轮为 0、也写过，但【没渲染过】→ 不收尾', () => {
    const t = trace([1, 'apply_commands']);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 0, prev: { wrotePrevTurn: true, cleanTurns: 2 }, sawFrame: false }),
    );
    expect(v.kind).toBe('continue');
  });

  it('★ 连续两轮无写入那条兜底同样要看过', () => {
    const t = trace([1, 'apply_commands']);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 0, prev: { wrotePrevTurn: false, cleanTurns: 0 }, sawFrame: false }),
    );
    expect(v.kind).toBe('continue');
  });

  it('渲染过之后，两条兜底照常工作（不许把正常的收尾也堵死）', () => {
    const t = trace([1, 'apply_commands']);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 0, prev: { wrotePrevTurn: false, cleanTurns: 0 }, sawFrame: true }),
    );
    expect(v.kind).toBe('finish');
  });

  it('★ 逃生口：额度连一帧都渲染不起时，兜底照常收尾（否则困死在轮数上限里）', () => {
    const t = trace([1, 'apply_commands']);
    const v = judgeTurn(
      input({
        trace: t,
        turn: 3,
        issueCount: 0,
        prev: { wrotePrevTurn: false, cleanTurns: 0 },
        sawFrame: false,
        canStillRender: false,
      }),
    );
    expect(v.kind).toBe('finish');
  });

  it('finish_shot 是模型主动收尾，不受这条前提影响（它自己会被关卡拒）', () => {
    const t = trace([1, 'finish_shot']);
    const v = judgeTurn(input({ trace: t, turn: 2, stopRequested: true, sawFrame: false }));
    expect(v.kind).toBe('finish');
    if (v.kind !== 'finish') return;
    expect(v.reason).toBe('tool_requested');
  });
});

describe('★ 零写入的 Agent 不许被判成"做完了"', () => {
  it('★ 连读三轮、一次没写、issues 为 0 → 必须继续（这是那个 bug 的最小复现）', () => {
    // 三轮纯读的 trace，且文档本来就零 issue
    const t = trace([1, READ_ONLY[0]], [2, READ_ONLY[1]], [2, READ_ONLY[1]], [3, READ_ONLY[2]]);
    let state = FRESH;
    for (let turn = 1; turn <= 3; turn++) {
      const v = judgeTurn(input({ trace: t, turn, issueCount: 0, prev: state }));
      expect(v.kind, '第 ' + turn + ' 轮就被收尾了 —— 用户的要求还没落地').toBe('continue');
      state = v.state;
    }
  });

  it('★ 读满十轮也不收尾（没有 anyWrite 就永远不认"干净"）', () => {
    const t = trace([1, READ_ONLY[0]]);
    let state = FRESH;
    for (let turn = 1; turn <= 10; turn++) {
      const v = judgeTurn(input({ trace: t, turn, issueCount: 0, prev: state }));
      expect(v.kind).toBe('continue');
      state = v.state;
    }
    // cleanTurns 确实在涨 —— 它只是【不生效】
    expect(state.cleanTurns).toBe(10);
  });

  it('★ 同一份 trace 一旦有了写入，两条兜底才会开始生效', () => {
    // 第 1 轮写过，之后三轮只读 → 应当收尾
    const t = trace([1, 'apply_commands'], [2, READ_ONLY[0]], [3, READ_ONLY[1]], [4, READ_ONLY[2]]);
    let state = FRESH;
    const verdicts: string[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      const v = judgeTurn(input({ trace: t, turn, issueCount: 0, prev: state }));
      state = v.state;
      verdicts.push(v.kind);
      if (v.kind === 'finish') break;
    }
    expect(verdicts).toContain('finish');
  });
});

describe('★ 调用过 apply_commands 不等于写成了', () => {
  it('★ 一整批命令全失败（unsupported_op）→ 不算写过，两条兜底都不许触发', () => {
    // 这正是实测抓到的那一轮：模型猜命令名，5 条里 4 条 unsupported_op。
    const t = [row(1, 'apply_commands', FAILED), row(2, READ_ONLY[0]), row(3, READ_ONLY[1])];
    let state = FRESH;
    for (let turn = 1; turn <= 5; turn++) {
      const v = judgeTurn(input({ trace: t, turn, issueCount: 0, prev: state }));
      expect(v.kind, '全失败的批次被当成了写入，于是第 ' + turn + ' 轮就收尾了').toBe('continue');
      state = v.state;
    }
  });

  it('★ 同一轮里只要有一条真成功，就算写过（别把部分成功也抹掉）', () => {
    const t = [row(1, 'apply_commands', WROTE)];
    const v = judgeTurn(input({ trace: t, turn: 2, issueCount: 0, prev: { wrotePrevTurn: true, cleanTurns: 2 } }));
    expect(v.kind).toBe('finish');
  });

  it('回执读不懂（不是 JSON）→ 按没写成算（宁可继续跑，也别凭它宣称做完）', () => {
    const t = [row(1, 'apply_commands', '服务器 500'), row(2, READ_ONLY[0])];
    let state = FRESH;
    for (let turn = 1; turn <= 5; turn++) {
      const v = judgeTurn(input({ trace: t, turn, issueCount: 0, prev: state }));
      expect(v.kind).toBe('continue');
      state = v.state;
    }
  });
});

describe('★ 收尾话术不许看起来像成功（措辞是规格的一部分）', () => {
  it('兜底收尾要说明这是兜底规则、不代表任务做完', () => {
    expect(verdictMessage('clean_three_turns', true)).toContain('不代表任务做完了');
    expect(verdictMessage('quiet_two_turns', true)).toContain('不代表任务做完了');
  });

  it('★ 一次写入都没落地时，收尾语必须直说', () => {
    expect(verdictMessage('clean_three_turns', false)).toContain('一次写入都没有落地');
    expect(verdictMessage('quiet_two_turns', false)).toContain('一次写入都没有落地');
    expect(verdictMessage('clean_three_turns', true)).not.toContain('一次写入都没有落地');
  });
});

describe('两条兜底各自的触发条件', () => {
  it('连续两轮无写入 + issues 归零 → quiet_two_turns', () => {
    const t = trace([1, 'apply_commands'], [2, READ_ONLY[0]]);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 0, prev: { wrotePrevTurn: false, cleanTurns: 2 } }),
    );
    expect(v.kind).toBe('finish');
    if (v.kind === 'finish') expect(v.reason).toBe('quiet_two_turns');
  });

  it('issues 不为 0 时两条都不触发（还有事没做完）', () => {
    const t = trace([1, 'apply_commands'], [2, READ_ONLY[0]]);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 4, prev: { wrotePrevTurn: false, cleanTurns: 9 } }),
    );
    expect(v.kind).toBe('continue');
    if (v.kind === 'continue') expect(v.state.cleanTurns).toBe(0); // issues 出现就清零
  });

  it('上一轮写过时不走 quiet_two_turns（刚写完不算安静）', () => {
    const t = trace([1, 'apply_commands'], [2, 'apply_commands']);
    const v = judgeTurn(
      input({ trace: t, turn: 2, issueCount: 0, prev: { wrotePrevTurn: false, cleanTurns: 1 } }),
    );
    // cleanTurns 从 1 涨到 2，未到 3；quiet 那条要求 !wroteThisTurn
    expect(v.kind).toBe('continue');
    if (v.kind === 'continue') expect(v.state).toEqual({ wrotePrevTurn: true, cleanTurns: 2 });
  });

  it('cleanTurns 到 3 且写过 → clean_three_turns（治反复微调）', () => {
    const t = trace([1, 'apply_commands'], [2, READ_ONLY[0]]);
    const v = judgeTurn(
      input({ trace: t, turn: 3, issueCount: 0, prev: { wrotePrevTurn: true, cleanTurns: 2 } }),
    );
    expect(v.kind).toBe('finish');
    if (v.kind === 'finish') expect(v.reason).toBe('clean_three_turns');
  });
});

describe('模型自己停手 / 工具要求收尾', () => {
  it('noToolCalls（模型用文字收尾）→ model_stopped', () => {
    const v = judgeTurn(input({ noToolCalls: true, trace: trace([1, READ_ONLY[0]]) }));
    expect(v.kind).toBe('finish');
    if (v.kind === 'finish') expect(v.reason).toBe('model_stopped');
  });

  it('finish_shot → tool_requested（优先级最高）', () => {
    const v = judgeTurn(
      input({ stopRequested: true, noToolCalls: true, trace: trace([1, 'finish_shot']) }),
    );
    expect(v.kind).toBe('finish');
    if (v.kind === 'finish') expect(v.reason).toBe('tool_requested');
  });

  it('Runtime 自己的收尾语不算"模型说的话"（界面据此不重复显示）', () => {
    expect(verdictMessage('quiet_two_turns')).toContain('Runtime');
    expect(verdictMessage('clean_three_turns')).toContain('Runtime');
    // 模型自己停手时没有 Runtime 文案（那句话来自模型）
    expect(verdictMessage('model_stopped')).toBe('');
  });
});
