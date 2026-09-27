import { describe, expect, it } from 'vitest';
import { keyPlaceholder, probeMessage, settingsPatchFrom } from '../src/api-settings';

/**
 * 「API 设置」的规则层（作业 3）。
 *
 * ★ 这一份的重点全在【别把没改的东西写成改了】和【别回显 key】两件事上 ——
 *   前者会让设置悄悄漂移，后者是安全问题。
 */
const CURRENT = { baseUrl: 'https://api.deepseek.com/beta/chat/completions', model: 'deepseek-chat' };

describe('表单 → 请求体：只发真的改过的字段', () => {
  it('什么都没改 → 空 patch（不发多余的写入）', () => {
    expect(settingsPatchFrom({ ...CURRENT, apiKey: '' }, CURRENT)).toEqual({});
  });

  it('★ 空 key = 不改（页面永远拿不到原文，空框是常态）', () => {
    expect(settingsPatchFrom({ ...CURRENT, apiKey: '   ' }, CURRENT)).toEqual({});
  });

  it('改了 model 就只发 model', () => {
    expect(settingsPatchFrom({ ...CURRENT, model: 'deepseek-reasoner', apiKey: '' }, CURRENT)).toEqual({
      model: 'deepseek-reasoner',
    });
  });

  it('★ 清空 key 只能显式点"清除"（否则与"没填"混在一起会把 key 悄悄删掉）', () => {
    expect(settingsPatchFrom({ ...CURRENT, apiKey: '', clearKey: true }, CURRENT)).toEqual({ apiKey: '' });
  });

  it('填了新 key 就发它', () => {
    expect(settingsPatchFrom({ ...CURRENT, apiKey: 'sk-abc' }, CURRENT)).toEqual({ apiKey: 'sk-abc' });
  });
});

describe('key 栏的提示：只显示掩码', () => {
  it('已设置时显示掩码 + "留空=不改"', () => {
    const text = keyPlaceholder({ hasKey: true, keyMask: 'sk-…abcd' });
    expect(text).toContain('sk-…abcd');
    expect(text).toContain('留空');
  });

  it('未设置时说清"只在服务端内存里"', () => {
    expect(keyPlaceholder({ hasKey: false, keyMask: '' })).toContain('内存');
  });
});

describe('测试连接：三类失败必须分得开', () => {
  it('成功时给延迟与模型回执名', () => {
    const s = probeMessage({ ok: true, kind: 'ok', latencyMs: 123, status: 200, modelEcho: 'deepseek-chat', message: '连接正常' });
    expect(s).toContain('连接正常');
    expect(s).toContain('123ms');
    expect(s).toContain('deepseek-chat');
  });

  it('错的 key / 错的地址 / 超时 三种措辞互不相同', () => {
    const auth = probeMessage({ ok: false, kind: 'auth', latencyMs: 40, status: 401, message: 'key 被拒绝' });
    const url = probeMessage({ ok: false, kind: 'bad_url', latencyMs: 0, message: '主机不在白名单里' });
    const time = probeMessage({ ok: false, kind: 'timeout', latencyMs: 10000, message: '没有回应' });
    expect(auth).toContain('key 被拒绝');
    expect(url).toContain('baseURL 不合法');
    expect(time).toContain('超时');
    expect(new Set([auth, url, time]).size).toBe(3);
  });
});
