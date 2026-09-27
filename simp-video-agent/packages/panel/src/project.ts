/**
 * 工程文件（保存 / 打开）。
 *
 * ★ 为什么要有它：文档本身只是一半。真正让人「接着上次干活」的是**上下文** ——
 *   聊天里发生过什么（`chatHistory` 会作为下一轮给 Agent 的背景）、
 *   推理等级选了哪一档、是不是在整片模式。只存文档的话，
 *   打开之后 Agent 对你的项目一无所知，你得从头再讲一遍。
 *
 * ★ 纯函数：构造、解析、校验、文件名都在这里，`app.ts` 只负责接 DOM。
 *   理由与其它模块一样 —— 规则要能在毫秒级被断言，DOM 里测不了它。
 */
import type { SceneDoc } from '@sva/engine-core';

export const PROJECT_FORMAT = 'sva-project';
/**
 * 格式版本。
 *
 * ★ 只往【上】认：比我新的工程文件一律拒收并说清版本号，
 *   而不是「试着读读看」—— 半读进去的工程比打不开更糟（用户以为打开成功了）。
 */
export const PROJECT_FORMAT_VERSION = 1;

/** 聊天里的一条（与 chat.ts 的 ChatLine 同形，这里只留需要存的部分）。 */
export interface ProjectChatLine {
  readonly role: string;
  readonly text: string;
  readonly name?: string;
  readonly turn?: number;
}

export interface ProjectContext {
  /** 给 Agent 的历史背景（下一轮会带过去）。 */
  readonly chatHistory: readonly string[];
  /** 聊天窗口里看得见的那些行（打开工程后接着看）。 */
  readonly chat: readonly ProjectChatLine[];
  /** 推理档位（服务端给的那张档位表里的一档）。 */
  readonly reasoning: string;
  /** 是不是整片模式。 */
  readonly filmMode: boolean;
}

export interface ProjectFile {
  readonly format: string;
  readonly formatVersion: number;
  /** ISO 时间串（人看）。 */
  readonly savedAt: string;
  readonly doc: SceneDoc;
  readonly context: ProjectContext;
}

/**
 * 聊天历史最多留这么多条。
 *
 * ★ 第二十九轮从 4 抬到 12（§0.28 三 ⑤：跨轮没有连续性，"再亮一点"这类指代无从落实）。
 * ★ 它的角色是【客户端自己的保留量】，服务端那一份（HISTORY_MAX_ENTRIES）才是权威 ——
 *   两边不一致时只会让客户端少发，绝不会让服务端多收。所以这里小一点是安全的，
 *   大一点也不会出事（服务端照样截断）。
 */
export const PROJECT_HISTORY_CAP = 12;
/** 单条历史的长度上限（同上）。 */
export const PROJECT_HISTORY_CHAR_CAP = 1200;
/** 聊天行最多存这么多（再多也没人翻）。 */
export const PROJECT_CHAT_CAP = 300;

export function emptyContext(): ProjectContext {
  return { chatHistory: [], chat: [], reasoning: 'high', filmMode: false };
}

export function buildProject(input: {
  readonly doc: SceneDoc;
  readonly context: ProjectContext;
  readonly now?: Date;
}): ProjectFile {
  const now = input.now ?? new Date();
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt: now.toISOString(),
    doc: input.doc,
    context: {
      chatHistory: input.context.chatHistory.slice(-PROJECT_HISTORY_CAP),
      chat: input.context.chat.slice(-PROJECT_CHAT_CAP),
      reasoning: input.context.reasoning,
      filmMode: input.context.filmMode,
    },
  };
}

export function projectToJson(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/**
 * 文件名：`sva-<标题>-<时间>.json`。
 *
 * ★ 标题里的非法字符要洗掉：它默认取文档里的文字对象，
 *   而文字里什么都可能有（斜杠、冒号、问号）。
 */
export function projectFilename(project: ProjectFile, fallback = 'project'): string {
  const d = new Date(project.savedAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes());
  const title = guessTitle(project.doc, fallback).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
  return 'sva-' + title + '-' + stamp + '.json';
}

/** 从文档里猜一个标题（第一个文字对象的内容），猜不到就用兜底。 */
export function guessTitle(doc: SceneDoc, fallback = 'project'): string {
  for (const obj of Object.values(doc.objects)) {
    if (obj.shape !== 'text') continue;
    const content = obj.params?.['content'];
    const raw = (content as { readonly v?: unknown } | undefined)?.v;
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().slice(0, 40);
  }
  return fallback;
}

export type ProjectParse =
  | { readonly ok: true; readonly project: ProjectFile; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

function isDoc(v: unknown): v is SceneDoc {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  if (typeof d['meta'] !== 'object' || d['meta'] === null) return false;
  if (typeof d['objects'] !== 'object' || d['objects'] === null) return false;
  if (!Array.isArray(d['scenes'])) return false;
  return true;
}

function readContext(raw: unknown, warnings: string[]): ProjectContext {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('这份工程没有上下文（聊天历史 / 推理档位），已按空上下文载入。');
    return emptyContext();
  }
  const c = raw as Record<string, unknown>;
  const chatHistory = (Array.isArray(c['chatHistory']) ? c['chatHistory'] : [])
    .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
    .slice(-PROJECT_HISTORY_CAP)
    .map((h) => h.slice(0, PROJECT_HISTORY_CHAR_CAP));
  const chat: ProjectChatLine[] = [];
  for (const line of Array.isArray(c['chat']) ? c['chat'] : []) {
    if (typeof line !== 'object' || line === null) continue;
    const l = line as Record<string, unknown>;
    if (typeof l['text'] !== 'string' || typeof l['role'] !== 'string') continue;
    chat.push({
      role: l['role'],
      text: l['text'].slice(0, 2000),
      ...(typeof l['name'] === 'string' ? { name: l['name'] } : {}),
      ...(typeof l['turn'] === 'number' ? { turn: l['turn'] } : {}),
    });
  }
  const reasoning = typeof c['reasoning'] === 'string' && c['reasoning'] !== '' ? c['reasoning'] : 'high';
  return {
    chatHistory,
    chat: chat.slice(-PROJECT_CHAT_CAP),
    reasoning,
    filmMode: c['filmMode'] === true,
  };
}

/**
 * 解析一份工程文件。
 *
 * ★ 每一处失败都要说清【哪一步不对】：用户拿到的是一个 .json 文件，
 *   而「打不开」与「这是另一个软件的文件」在他眼里长得一模一样。
 */
export function parseProject(text: string): ProjectParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '这不是一份 JSON 文件（解析失败）' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '工程文件的内容不是一个对象' };
  const p = raw as Record<string, unknown>;
  if (p['format'] !== PROJECT_FORMAT) {
    return { ok: false, error: '这不是 Simp Video Agent 的工程文件（缺少 format 标记）' };
  }
  const version = typeof p['formatVersion'] === 'number' ? p['formatVersion'] : 0;
  if (version > PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      error: '这份工程来自更新的版本（v' + version + '），当前只认到 v' + PROJECT_FORMAT_VERSION + '。',
    };
  }
  if (!isDoc(p['doc'])) {
    return { ok: false, error: '工程里的文档不像一份 Scene Doc（缺 meta / objects / scenes）' };
  }
  const warnings: string[] = [];
  const context = readContext(p['context'], warnings);
  return {
    ok: true,
    project: {
      format: PROJECT_FORMAT,
      formatVersion: version === 0 ? PROJECT_FORMAT_VERSION : version,
      savedAt: typeof p['savedAt'] === 'string' ? p['savedAt'] : new Date(0).toISOString(),
      doc: p['doc'],
      context,
    },
    warnings,
  };
}