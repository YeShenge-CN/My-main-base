import { describe, expect, it } from 'vitest';
import { toChatEvents } from '../src/panel-server';

/**
 * 聊天流投影：把一次 Agent 运行的工具轨迹压成人能读的行。
 *
 * 它值得单独测，是因为这是【面向人的措辞】唯一的一处。
 * 一旦这里开始编故事（比如把"提案 1 条"写成"已改好"），
 * 用户看到的就与引擎判定的事实不一致 —— 那正是这个项目最容易骗自己的地方。
 */
describe('toChatEvents：只说回执里的事实', () => {
  it('apply_commands 报的是四态计数，而不是"我改好了"', () => {
    const events = toChatEvents([
      {
        turn: 3,
        name: 'apply_commands',
        args: { commands: [{ op: 'create_plot' }, { op: 'set_style' }] },
        result: JSON.stringify({
          ok: [{}],
          proposals: [{}],
          blocked: [],
          errored: [{ error: { code: 'unknown_target' } }],
          autofixed: [{}],
        }),
      },
    ]);
    expect(events.length).toBe(1);
    expect(events[0]?.wrote).toBe(true);
    expect(events[0]?.text).toContain('create_plot,set_style');
    expect(events[0]?.text).toContain('成功 1');
    expect(events[0]?.text).toContain('提案 1');
    expect(events[0]?.text).toContain('失败 1');
    expect(events[0]?.text).toContain('引擎自动修 1');
    // 不允许出现"已完成/改好了"这类断言
    expect(events[0]?.text).not.toContain('完成');
    expect(events[0]?.text).not.toContain('改好');
  });

  it('被拒的工具（回执里带 error）原样说出来', () => {
    const events = toChatEvents([
      { turn: 1, name: 'render_frames', args: {}, result: JSON.stringify({ error: 'L2_images_exhausted' }) },
    ]);
    expect(events[0]?.text).toContain('被拒');
    expect(events[0]?.text).toContain('L2_images_exhausted');
  });

  it('finish_shot / validate 有专门的短句', () => {
    const events = toChatEvents([
      { turn: 4, name: 'finish_shot', args: {}, result: JSON.stringify({ status: 'finished', issues: 0 }) },
      { turn: 2, name: 'validate', args: {}, result: JSON.stringify({ counts: { total: 3 } }) },
    ]);
    expect(events[0]?.text).toBe('收尾');
    expect(events[1]?.text).toContain('3 条问题');
  });

  /**
   * ★★ 第二十九轮的两条：**不许看起来像成功**。
   *   收尾之后模型再没有机会修改，所以「还有 N 项没达标」必须写在这一行上 ——
   *   否则一次带缺陷的交付在聊天里与一次干净的交付长得一模一样。
   */
  it('★ 收尾时若有未决问题，明说"还有 N 项没达标"（§0.28 作业 1 验收第 3 条）', () => {
    const events = toChatEvents([
      {
        turn: 6,
        name: 'finish_shot',
        args: {},
        result: JSON.stringify({ status: 'finished', issues: 3, unresolved: 3, unresolvedCodes: ['text_overlap'] }),
      },
    ]);
    expect(events[0]?.text).toContain('还有 3 项没达标');
  });

  it('★ 「不看就交」被拒时说人话，而不是抛一个错误码', () => {
    const events = toChatEvents([
      {
        turn: 2,
        name: 'finish_shot',
        args: {},
        result: JSON.stringify({ error: 'look_before_finish', message: '先看一眼' }),
      },
    ]);
    expect(events[0]?.text).toBe('收尾被拒：还没看过画面');
  });

  it('回执不是 JSON 时退回工具名，不抛异常（聊天不能因为一条坏回执就断）', () => {
    const events = toChatEvents([{ turn: 1, name: 'get_object', args: {}, result: '这不是 JSON' }]);
    expect(events[0]?.text).toBe('get_object');
  });

  it('每一行都带轮次，聊天里能对上"第几轮做了这事"', () => {
    const events = toChatEvents([
      { turn: 1, name: 'get_scene_summary', args: {}, result: '{}' },
      { turn: 5, name: 'apply_commands', args: { commands: [] }, result: JSON.stringify({ ok: [] }) },
    ]);
    expect(events.map((e) => e.turn)).toEqual([1, 5]);
  });
});
