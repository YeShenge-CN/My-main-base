/**
 * API 设置（第二十九轮作业 3）。
 *
 * ★★ 三条【已拍板】的决定（§8 里那三个"别自己决定"的问题）：
 *
 *   1. **key 只存服务端内存。** 不落盘、不写回 .env.local、不进 localStorage。
 *      服务重启就没了（要重填一次），而这是刻意的：明文 key 落盘的风险
 *      远大于"重填一次"的成本；localStorage 更糟 —— 这个页面的 URL 是可以发给别人的。
 *   2. **baseURL 可改，但只允许白名单。** 默认 api.deepseek.com，外加本机
 *      （localhost / 127.0.0.1 / [::1]）—— 接自建网关或本地代理是真实需求，
 *      而"服务端替人往任意地址发请求"是一整片 SSRF 面，不能默认敞着。
 *   3. **密钥只回掩码。** GET 只给 sk-…abcd 与 hasKey，**绝不回原文**。
 *
 * ★ 这个模块刻意不 import node 的任何东西（除了类型），于是它能在毫秒级被单测。
 */
import { DEFAULT_MODEL, DEEPSEEK_BETA_URL } from './deepseek';

/** 允许的远端主机（本机地址另外单独放行，见 isLocalHost）。 */
export const ALLOWED_REMOTE_HOSTS: readonly string[] = ['api.deepseek.com'];

export interface ApiSettingsView {
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
  /** 形如 sk-…abcd。★ 永远不是原文。 */
  readonly keyMask: string;
  /** 服务端接受的远端主机（页面拿它做提示，不抄第二份白名单）。 */
  readonly allowedHosts: readonly string[];
}

export interface ApiSettingsSnapshot {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
}

export type BaseUrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * 校验 baseURL。
 *
 * ★ 判据比"看着像不像 URL"严得多，因为它的用途是**让服务端替调用方发请求**：
 *   · 只允许 http/https（file:/data:/gopher: 之类一律拒）；
 *   · 不许带用户名密码（否则会把凭据编进请求）；
 *   · 主机必须在白名单里，或者是本机地址。
 */
export function checkBaseUrl(raw: string): BaseUrlCheck {
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'baseURL 不能为空' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: '不是一个合法的 URL：' + text };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: '只允许 http/https，收到 ' + url.protocol };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'baseURL 里不许带用户名或密码' };
  }
  if (!isLocalHost(url.hostname) && !ALLOWED_REMOTE_HOSTS.includes(url.hostname.toLowerCase())) {
    return {
      ok: false,
      reason:
        '主机 ' + url.hostname + ' 不在白名单里（允许：' + ALLOWED_REMOTE_HOSTS.join(' / ') +
        ' / 本机地址）。要接自建网关请改服务端的 ALLOWED_REMOTE_HOSTS —— ' +
        '不开放任意地址是刻意的：那等于让这个本地服务替任何人往任何地方发请求。',
    };
  }
  return { ok: true, url: url.toString() };
}

/** sk-abcdef…wxyz → sk-…wxyz。短 key 一律只回固定掩码，避免"掩码本身泄漏了 key"。 */
export function maskApiKey(key: string): string {
  const k = key.trim();
  if (k === '') return '';
  if (k.length <= 8) return '····';
  return k.slice(0, 3) + '…' + k.slice(-4);
}

/**
 * 内存里的设置。
 *
 * ★ 没有 persist()，也不该有 —— 见文件头的第 1 条决定。
 */
export class ApiSettingsStore {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(initial: ApiSettingsSnapshot) {
    this.baseUrl = initial.baseUrl;
    this.model = initial.model;
    this.apiKey = initial.apiKey;
  }

  snapshot(): ApiSettingsSnapshot {
    return { baseUrl: this.baseUrl, model: this.model, apiKey: this.apiKey };
  }

  view(): ApiSettingsView {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
      hasKey: this.apiKey.trim() !== '',
      keyMask: maskApiKey(this.apiKey),
      allowedHosts: ALLOWED_REMOTE_HOSTS,
    };
  }

  /**
   * 应用一批改动。
   *
   * ★ 语义：**字段缺席 = 不改**（不是"清空"）。要清掉 key 显式传空串。
   * ★ 一处非法就整批不动（返回 errors）—— 半套用的设置会让"我明明改了 baseURL"
   *   与"实际请求打到哪"对不上，那是最难查的一类。
   */
  apply(patch: {
    readonly baseUrl?: unknown;
    readonly model?: unknown;
    readonly apiKey?: unknown;
  }): { readonly ok: true; readonly changed: readonly string[] } | { readonly ok: false; readonly errors: readonly string[] } {
    const errors: string[] = [];
    let nextBaseUrl = this.baseUrl;
    let nextModel = this.model;
    let nextKey = this.apiKey;

    if (patch.baseUrl !== undefined) {
      if (typeof patch.baseUrl !== 'string') errors.push('baseUrl 必须是字符串');
      else {
        const check = checkBaseUrl(patch.baseUrl);
        if (!check.ok) errors.push(check.reason);
        else nextBaseUrl = check.url;
      }
    }
    if (patch.model !== undefined) {
      if (typeof patch.model !== 'string') errors.push('model 必须是字符串');
      else if (patch.model.trim() === '') errors.push('model 不能为空（要恢复默认请填 ' + DEFAULT_MODEL + '）');
      else nextModel = patch.model.trim();
    }
    if (patch.apiKey !== undefined) {
      if (typeof patch.apiKey !== 'string') errors.push('apiKey 必须是字符串');
      else nextKey = patch.apiKey.trim();
    }
    if (errors.length > 0) return { ok: false, errors };

    const changed: string[] = [];
    if (nextBaseUrl !== this.baseUrl) changed.push('baseUrl');
    if (nextModel !== this.model) changed.push('model');
    if (nextKey !== this.apiKey) changed.push('apiKey');
    this.baseUrl = nextBaseUrl;
    this.model = nextModel;
    this.apiKey = nextKey;
    return { ok: true, changed };
  }
}

export function defaultSettings(apiKey: string, model?: string): ApiSettingsSnapshot {
  return { baseUrl: DEEPSEEK_BETA_URL, model: model ?? DEFAULT_MODEL, apiKey };
}

/* ── 「测试连接」─────────────────────────────────────────────── */

export type ProbeKind = 'ok' | 'bad_url' | 'auth' | 'timeout' | 'http' | 'network';

export interface ProbeResult {
  readonly ok: boolean;
  readonly kind: ProbeKind;
  readonly latencyMs: number;
  /** HTTP 状态码（有的话）。 */
  readonly status?: number;
  /** 服务端回执里报的模型名 —— "我配的 model 生效了吗"的唯一证据。 */
  readonly modelEcho?: string;
  readonly message: string;
}

/**
 * 发一次【最小】请求，如实报三件事：状态、延迟、模型回执名。
 *
 * ★ 三类失败必须分得开（作业 3 的验收）：错的 key / 错的 baseURL / 超时。
 *   混成一句"连接失败"等于让人自己猜 —— 而这个项目里"看起来正常"与"看起来失败"
 *   一样贵。
 * ★ fetch 可注入：这一条路径因此能在毫秒级、无网络地被断言。
 */
export async function probeConnection(opts: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const check = checkBaseUrl(opts.baseUrl);
  if (!check.ok) return { ok: false, kind: 'bad_url', latencyMs: 0, message: check.reason };
  if (opts.apiKey.trim() === '') {
    return { ok: false, kind: 'auth', latencyMs: 0, message: '还没有填 API key。' };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(check.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + opts.apiKey },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'auth', latencyMs, status: res.status, message: 'key 被拒绝（HTTP ' + res.status + '）：' + text.slice(0, 200) };
    }
    if (!res.ok) {
      return { ok: false, kind: 'http', latencyMs, status: res.status, message: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
    }
    let echo: string | undefined;
    try {
      const parsed = JSON.parse(text) as { model?: unknown };
      if (typeof parsed.model === 'string') echo = parsed.model;
    } catch {
      // 回执不是 JSON 也算通了（状态码 200 已经说明地址与 key 都对）
    }
    return {
      ok: true,
      kind: 'ok',
      latencyMs,
      status: res.status,
      ...(echo === undefined ? {} : { modelEcho: echo }),
      message: '连接正常' + (echo === undefined ? '' : '，模型回执名 ' + echo),
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const aborted = err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted);
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      latencyMs,
      message: aborted
        ? '超过 ' + timeoutMs + 'ms 没有回应（地址通了但服务不响应，或者网络被挡）'
        : '请求发不出去：' + (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}
