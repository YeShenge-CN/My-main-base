/**
 * 「API 设置」这一块里那些【能判对错】的部分（作业 3）。
 *
 * ★ 与 command-path.ts 同一个思路：DOM 事件里只留"接线"，
 *   规则（发什么、显示什么、什么时候算"改过了"）抽成纯函数 ——
 *   于是它们能在毫秒级被断言，不必开浏览器。
 */

export interface ApiSettingsView {
  readonly baseUrl: string;
  readonly model: string;
  readonly hasKey: boolean;
  /** 形如 sk-…abcd。★ 服务端永远不回原文。 */
  readonly keyMask: string;
  readonly allowedHosts: readonly string[];
}

export interface SettingsFormInput {
  readonly baseUrl: string;
  readonly model: string;
  /** ★ 空 = "不改"。页面拿不到原文，所以空框是常态。 */
  readonly apiKey: string;
  /** 显式清除 key（唯一一条能把 key 弄没的路径，必须是用户主动点的）。 */
  readonly clearKey?: boolean;
}

/**
 * 表单 → 请求体。
 *
 * ★ 只发【真的改过】的字段。把没改的字段也发一遍，会让"我明明没碰 model"
 *   与实际生效的设置之间产生一次看不见的写入（服务端也会把它记成 changed）。
 * ★ 空字符串的语义分两种：baseUrl / model 空 = 不改；key 空 = 不改，
 *   要清空必须显式点"清除"（clearKey）。让"没填"与"清空"共用一个空串，
 *   迟早会把用户的 key 悄悄删掉。
 */
export function settingsPatchFrom(
  input: SettingsFormInput,
  current: Pick<ApiSettingsView, 'baseUrl' | 'model'>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  if (baseUrl !== '' && baseUrl !== current.baseUrl) patch['baseUrl'] = baseUrl;
  if (model !== '' && model !== current.model) patch['model'] = model;
  if (input.clearKey === true) patch['apiKey'] = '';
  else if (input.apiKey.trim() !== '') patch['apiKey'] = input.apiKey.trim();
  return patch;
}

/** key 那一栏的提示文字。★ 只显示掩码，绝不回显原文。 */
export function keyPlaceholder(view: Pick<ApiSettingsView, 'hasKey' | 'keyMask'>): string {
  return view.hasKey ? '已设置 ' + view.keyMask + '（留空 = 不改）' : '还没有设置 key（只在服务端内存里，不落盘）';
}

export interface ProbeResultView {
  readonly ok: boolean;
  readonly kind: 'ok' | 'bad_url' | 'auth' | 'timeout' | 'http' | 'network';
  readonly latencyMs: number;
  readonly status?: number;
  readonly modelEcho?: string;
  readonly message: string;
}

const KIND_LABEL: Readonly<Record<ProbeResultView['kind'], string>> = {
  ok: '连接正常',
  bad_url: 'baseURL 不合法',
  auth: 'key 被拒绝',
  timeout: '超时',
  http: 'HTTP 错误',
  network: '发不出去',
};

/** 「测试连接」的结果 → 一句话。三类失败必须【看得出来是哪一类】。 */
export function probeMessage(result: ProbeResultView): string {
  const head =
    (result.ok ? '✓ ' : '✗ ') + KIND_LABEL[result.kind] +
    '（' + String(result.latencyMs) + 'ms' + (result.status === undefined ? '' : '，HTTP ' + String(result.status)) + '）';
  const echo = result.modelEcho === undefined ? '' : '，模型回执 ' + result.modelEcho;
  return head + echo + '：' + result.message;
}
