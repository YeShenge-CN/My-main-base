/**
 * API 设置（作业 3）：白名单、掩码、内存语义、以及"测试连接"的三类失败。
 *
 * ★ 这一份的重点是三条【安全/诚实】的边界：
 *   1. key 绝不回原文（连掩码都不该长得像原文）；
 *   2. baseURL 只在白名单里放行（服务端替人发请求是一整片 SSRF 面）；
 *   3. 一处非法就整批不动 —— 静默的"部分成功"是设置类功能最坏的行为。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_REMOTE_HOSTS,
  ApiSettingsStore,
  checkBaseUrl,
  defaultSettings,
  isLocalHost,
  maskApiKey,
  probeConnection,
} from '../src/settings';
import { startPanelServer } from '../src/panel-server';

const RAW_KEY = 'sk-1234567890abcdef';

describe('baseURL 白名单', () => {
  it('DeepSeek 官方地址放行', () => {
    const r = checkBaseUrl('https://api.deepseek.com/beta/chat/completions');
    expect(r.ok).toBe(true);
  });

  it('★ 本机地址放行（自建网关 / 本地代理是真实需求）', () => {
    for (const u of ['http://localhost:11434/v1/chat/completions', 'http://127.0.0.1:8080/v1/chat/completions', 'http://[::1]:9000/v1']) {
      expect(checkBaseUrl(u).ok, u).toBe(true);
    }
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('api.deepseek.com')).toBe(false);
  });

  it('★ 任意远端地址被拒（这就是 SSRF 面）', () => {
    const r = checkBaseUrl('https://evil.example.com/v1/chat/completions');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('白名单');
  });

  it('非 http(s) 协议被拒（file: / data: / gopher:）', () => {
    expect(checkBaseUrl('file:///etc/passwd').ok).toBe(false);
    expect(checkBaseUrl('data:text/plain,x').ok).toBe(false);
  });

  it('带用户名密码的 URL 被拒（否则会把凭据编进请求）', () => {
    expect(checkBaseUrl('https://user:pw@api.deepseek.com/v1').ok).toBe(false);
  });

  it('乱七八糟的串被拒，且理由说人话', () => {
    const r = checkBaseUrl('不是一个地址');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('URL');
  });

  it('默认白名单只有官方那一个（本机不算"远端"）', () => {
    expect(ALLOWED_REMOTE_HOSTS).toEqual(['api.deepseek.com']);
  });
});

describe('key 掩码', () => {
  it('长 key 只回前 3 后 4', () => {
    expect(maskApiKey(RAW_KEY)).toBe('sk-…cdef');
  });

  it('★ 掩码里不包含中间任何一段（不能靠掩码反推）', () => {
    const mask = maskApiKey(RAW_KEY);
    expect(mask).not.toContain('1234567890');
  });

  it('太短的 key 一律只回固定掩码', () => {
    expect(maskApiKey('sk-123')).toBe('····');
  });

  it('空 key 回空串（页面据此显示"还没设置"）', () => {
    expect(maskApiKey('   ')).toBe('');
  });
});

describe('ApiSettingsStore：内存语义', () => {
  it('view() 永远不含原文', () => {
    const store = new ApiSettingsStore(defaultSettings(RAW_KEY));
    const view = store.view();
    expect(view.hasKey).toBe(true);
    expect(view.keyMask).toBe('sk-…cdef');
    expect(JSON.stringify(view)).not.toContain(RAW_KEY);
  });

  it('部分字段缺席 = 不改（不是清空）', () => {
    const store = new ApiSettingsStore(defaultSettings(RAW_KEY, 'deepseek-chat'));
    const r = store.apply({ model: 'deepseek-reasoner' });
    expect(r.ok).toBe(true);
    expect(store.snapshot()).toEqual({
      apiKey: RAW_KEY,
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/beta/chat/completions',
    });
  });

  it('★ 一处非法 → 整批不动（不许"部分成功"）', () => {
    const store = new ApiSettingsStore(defaultSettings(RAW_KEY));
    const before = store.snapshot();
    const r = store.apply({ model: 'deepseek-reasoner', baseUrl: 'https://evil.example.com/v1' });
    expect(r.ok).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });

  it('显式传空串才清掉 key', () => {
    const store = new ApiSettingsStore(defaultSettings(RAW_KEY));
    expect(store.apply({ apiKey: '' }).ok).toBe(true);
    expect(store.view().hasKey).toBe(false);
  });

  it('changed 列表如实报出改了哪几项', () => {
    const store = new ApiSettingsStore(defaultSettings(RAW_KEY));
    const r = store.apply({ model: 'm2', baseUrl: 'http://localhost:1234/v1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.changed].sort()).toEqual(['baseUrl', 'model']);
  });
});

/* ── 「测试连接」：三类失败必须分得开 ───────────────────────── */

const okReply = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe('probeConnection', () => {
  it('成功：报延迟与模型回执名', async () => {
    const fetchImpl = vi.fn(async () => okReply({ model: 'deepseek-chat' })) as unknown as typeof fetch;
    const r = await probeConnection({
      apiKey: RAW_KEY,
      baseUrl: 'https://api.deepseek.com/beta/chat/completions',
      model: 'deepseek-chat',
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('ok');
    expect(r.modelEcho).toBe('deepseek-chat');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('错的 key → kind=auth（不是笼统的"连接失败"）', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }) as unknown as Response) as unknown as typeof fetch;
    const r = await probeConnection({ apiKey: 'bad', baseUrl: 'https://api.deepseek.com/beta/chat/completions', model: 'm', fetchImpl });
    expect(r.kind).toBe('auth');
    expect(r.status).toBe(401);
  });

  it('★ 错的 baseURL 在【发请求之前】就被拦下（不泄露内网探测）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await probeConnection({ apiKey: RAW_KEY, baseUrl: 'http://169.254.169.254/latest/meta-data', model: 'm', fetchImpl });
    expect(r.kind).toBe('bad_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('超时 → kind=timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    const r = await probeConnection({ apiKey: RAW_KEY, baseUrl: 'http://127.0.0.1:9/v1', model: 'm', timeoutMs: 20, fetchImpl });
    expect(r.kind).toBe('timeout');
  });

  it('没有 key → 直接说"还没填"，不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await probeConnection({ apiKey: '', baseUrl: 'https://api.deepseek.com/beta/chat/completions', model: 'm', fetchImpl });
    expect(r.kind).toBe('auth');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ── 真的起一台服务：key 不回显、非法设置整批拒绝 ─────────────── */

describe('★ /api/settings 的路由', () => {
  it('GET 只回掩码；POST 非法整批拒；POST 合法立刻生效', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const server = await startPanelServer({
      root,
      docPath: join(root, 'out', 'settings-test-doc.json'),
      apiKey: RAW_KEY,
    });
    try {
      const get1 = (await (await fetch(server.origin + '/api/settings')).json()) as {
        settings?: { baseUrl?: string; model?: string; hasKey?: boolean; keyMask?: string; allowedHosts?: string[] };
      };
      expect(get1.settings?.hasKey).toBe(true);
      expect(get1.settings?.keyMask).toBe('sk-…cdef');
      // ★ 整个响应体里不许出现原文
      expect(JSON.stringify(get1)).not.toContain(RAW_KEY);
      expect(get1.settings?.allowedHosts).toEqual([...ALLOWED_REMOTE_HOSTS]);

      // 非法 baseURL：400，且设置一点没动
      const bad = await fetch(server.origin + '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'https://evil.example.com/v1', model: 'hacked' }),
      });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { errors?: string[]; settings?: { model?: string } };
      expect(badBody.errors?.join(' ')).toContain('白名单');
      expect(badBody.settings?.model).not.toBe('hacked');

      // 合法：本机地址 + 新 model
      const good = await fetch(server.origin + '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://localhost:11434/v1/chat/completions', model: 'deepseek-reasoner' }),
      });
      expect(good.status).toBe(200);
      const goodBody = (await good.json()) as { changed?: string[]; settings?: { baseUrl?: string; model?: string } };
      expect(goodBody.changed?.sort()).toEqual(['baseUrl', 'model']);
      expect(goodBody.settings?.model).toBe('deepseek-reasoner');

      // /api/health 也跟着变（同一个真源）
      const health = (await (await fetch(server.origin + '/api/health')).json()) as { model?: string; limits?: Record<string, number> };
      expect(health.model).toBe('deepseek-reasoner');
      // ★ 上限也如实报出来（面板不抄第二份数字）
      expect(health.limits?.['imagesPerShot']).toBe(16);
      expect(health.limits?.['framesPerCall']).toBe(6);
      expect(health.limits?.['historyEntries']).toBe(12);

      // 非白名单的"测试连接"也在发请求前拦下
      const probe = await fetch(server.origin + '/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: 'http://169.254.169.254/latest' }),
      });
      expect(probe.status).toBe(200);
      const probeBody = (await probe.json()) as { ok?: boolean; result?: { kind?: string } };
      expect(probeBody.ok).toBe(false);
      expect(probeBody.result?.kind).toBe('bad_url');
    } finally {
      await server.close();
    }
  }, 20000);
});
