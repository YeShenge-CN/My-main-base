/**
 * 面板的 Agent 服务：静态文件 + 一个 /api/chat 接口。
 *
 * ★ 为什么必须有这一层：DeepSeek 的 API key【绝不能进浏览器】。
 *   界面要能命令 Agent，就必须有人在服务端持有 key 并代它调用。
 *
 * ★ 服务端【不持有文档状态】，这是刻意的：
 *   请求体里带着浏览器当前的完整文档，Agent 就在这份文档上跑，结果再回传。
 *   于是"文档以谁为准"永远只有一个答案（浏览器那份），
 *   两个进程各存一份文档、然后慢慢漂移这种事根本不会发生。
 *
 * 接口：
 *   GET  /api/health           → { ok, model, hasKey, reasoning, reasoningOptions, limits }
 *   GET  /api/settings         → 当前 API 设置（key 只回掩码）
 *   POST /api/settings         → 改 baseUrl / model / API key（只在服务端内存里）
 *   POST /api/settings/test    → 发一次最小请求，如实报状态 / 延迟 / 模型回执名
 *   POST /api/chat             → 跑一个镜头，回传"要搬进浏览器 Journal 的操作"
 *     body: { task, doc, maxTurns? }
 *     resp: { ok, startVersion, doc, entries[], compoundId, chat{messages}, issues, usage, ... }
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { renderFrames } from '@sva/engine-node/headless';
import type { SceneDoc, ShotFrame } from '@sva/engine-core';
import { DEFAULT_REASONING, isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from './deepseek';
import {
  DEFAULT_MAX_TURNS_PER_SHOT,
  FilmRegistry,
  MAX_SHOTS,
  runFilm,
  type FilmEvent,
  type FilmJob,
} from './film';
import { runOneShot } from './run';
import {
  L1_MAX_FRAMES,
  L2_MAX_IMAGES,
  L2_MAX_RENDER_CALLS,
  L3_MAX_IMAGES_IN_CONTEXT,
} from './budget';
import { ExportRegistry, defaultFfmpegPaths, runExport, type ChromeFrames, type ExportJob } from './export-job';
import { ApiSettingsStore, defaultSettings, probeConnection } from './settings';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * /api/chat 的 history 上限（条数 × 单条字符数）。
 *
 * ★ 第二十九轮从 4×400 放宽到 12×1200（§0.28 三 ⑤）。这两个数【必须在服务端】：
 *   它们是"外部调用方最多能往提示词里注入多少"的边界，不是成本旋钮。
 */
export const HISTORY_MAX_ENTRIES = 12;
export const HISTORY_MAX_CHARS = 1200;

export interface PanelServerOptions {
  /** 静态根（仓库根）。 */
  readonly root: string;
  readonly docPath: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxTurns?: number;
  /** 单次请求体上限，防止一个巨型文档把内存吃掉。 */
  readonly maxBodyBytes?: number;
  /**
   * Chrome 渲染后端，由宿主注入。
   *
   * ★ 注入而不是 import：engine-node 的那条路径（renderFramesWithChrome）
   *   带 page.evaluate，签名需要 DOM 类型，而这个模块在 agent-tools 的【无 DOM】
   *   程序里。谁有能力提供浏览器，谁注入 —— 与渲染器、Chrome 驱动同一套边界。
   */
  readonly chromeRender?: (doc: SceneDoc, frames: readonly ShotFrame[]) => Promise<ChromeFrames>;
}

export interface PanelServer {
  readonly origin: string;
  readonly port: number;
  /** 面板页面地址（带 doc 查询参数）。 */
  readonly panelUrl: string;
  /** 查询导出作业（校验脚本与调试用）。 */
  exportJob(id: string): ExportJob | undefined;
  close(): Promise<void>;
}

/** 给界面看的聊天消息：一条用户话 + Agent 的每一次工具调用。 */
export interface ChatEvent {
  readonly kind: 'user' | 'tool' | 'note';
  readonly turn: number;
  readonly text: string;
  /** 工具名，kind=tool 时有。 */
  readonly name?: string;
  /** 这次工具调用有没有产生文档写入。 */
  readonly wrote?: boolean;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体超过 ' + maxBytes + ' 字节'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/** 把一次 Agent 运行压成人能读的聊天流。 */
export function toChatEvents(
  trace: readonly { turn: number; name: string; args: unknown; result: string }[],
  finalMessage?: string,
): readonly ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const t of trace) {
    const wrote = t.name === 'apply_commands';
    let text = t.name;
    try {
      const parsed = JSON.parse(t.result) as Record<string, unknown>;
      if (typeof parsed['error'] === 'string') {
        /**
         * ★ 「不看就交」被拒这件事必须【一眼看得出来】。
         *   通用分支会把它显示成 "finish_shot 被拒：look_before_finish"，
         *   而人读到的应该是一句人话 —— 否则用户会以为模型坏了。
         */
        text =
          parsed['error'] === 'look_before_finish'
            ? '收尾被拒：还没看过画面'
            : t.name + ' 被拒：' + parsed['error'];
      } else if (wrote) {
        const ok = Array.isArray(parsed['ok']) ? parsed['ok'].length : 0;
        const proposals = Array.isArray(parsed['proposals']) ? parsed['proposals'].length : 0;
        const errored = Array.isArray(parsed['errored']) ? parsed['errored'].length : 0;
        const autofixed = Array.isArray(parsed['autofixed']) ? parsed['autofixed'].length : 0;
        const cmds = Array.isArray((t.args as Record<string, unknown>)['commands'])
          ? ((t.args as Record<string, unknown>)['commands'] as { op?: string }[]).map((c) => c.op).join(',')
          : '';
        text =
          '提交 [' + cmds + '] → 成功 ' + ok + ' · 提案 ' + proposals + ' · 失败 ' + errored +
          (autofixed > 0 ? ' · 引擎自动修 ' + autofixed : '');
      } else if (t.name === 'finish_shot') {
        /**
         * ★★ 收尾话术必须如实（§0.28 作业 1 验收第 3 条：不许看起来像成功）。
         *   引擎仍然会收尾，但"还有 N 项没达标"要写在人能看见的这一行上。
         */
        const unresolved = typeof parsed['unresolved'] === 'number' ? parsed['unresolved'] : 0;
        text = unresolved > 0 ? '收尾（⚠ 还有 ' + unresolved + ' 项没达标）' : '收尾';
      } else if (t.name === 'validate') {
        const counts = parsed['counts'] as { total?: number } | undefined;
        text = '校验 → ' + String(counts?.total ?? 0) + ' 条问题';
      }
    } catch {
      // 回执不是 JSON 就原样带一句
      text = t.name;
    }
    out.push({ kind: 'tool', turn: t.turn, name: t.name, text, wrote });
  }
  /**
   * ★ 把模型最后那句话也报出来。
   *
   *   它是"模型为什么停下"的唯一证据：Runtime 在 `tool_calls` 为空时就用
   *   它的 content 收尾，而在此之前这句话【从来没有显示给用户】。
   *   实测代价：一轮下来 0 次写入、聊天里只有工具名，看不出模型是
   *   "觉得做完了"、"不知道要改哪个"、还是"被拒后放弃了"。
   */
  const last = finalMessage?.trim() ?? '';
  if (last !== '') out.push({ kind: 'note', turn: 0, text: '模型最后说：' + last });
  return out;
}

/**
 * 解析 /api/chat 请求体里的推理档位。
 *
 * ★ 白名单校验在【服务端】做，不信浏览器 —— 与「模型的输出只是意图」同一条规矩：
 *   界面给什么都要过一遍引擎/服务的校验。
 * ★ 返回 `null` = 传了但非法。调用方要回 400，**不要静默回退**：
 *   静默回退会让界面显示 high、实际跑的是 off，又是一处「看起来正常」。
 */
export function resolveRequestedReasoning(
  provided: unknown,
  fallback: ReasoningEffort,
): ReasoningEffort | null {
  if (provided === undefined || provided === null) return fallback;
  return typeof provided === 'string' && isReasoningEffort(provided) ? provided : null;
}

export async function startPanelServer(opts: PanelServerOptions): Promise<PanelServer> {
  const root = normalize(opts.root).replace(/[\\/]+$/, '');
  const maxBody = opts.maxBodyBytes ?? 8 * 1024 * 1024;
  const started = Date.now();
  let jobs = 0;
  const exports = new ExportRegistry();
  /** 整片作业：与导出同一套「起作业 + 轮询」的形状。 */
  const films = new FilmRegistry();
  const ffmpeg = defaultFfmpegPaths(root);
  const ffmpegReady = existsSync(ffmpeg.ffmpeg) && existsSync(ffmpeg.ffprobe);
  const chromeRender = opts.chromeRender;
  /**
   * ★★ 运行期的 API 设置（作业 3）。
   *
   *   在此之前 key 只能来自环境变量或 .env.local、model 只能来自 --model、
   *   baseURL 写死在 deepseek.ts —— 页面上一个都改不了。
   *   现在它们都在这里，而且**只在内存里**（见 settings.ts 的三条决定）；
   *   命令行给的值仍然只是【初值】，页面上改过就以页面为准。
   */
  const settings = new ApiSettingsStore(defaultSettings(opts.apiKey, opts.model));

  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0] ?? '/';

    // ── /api/health ────────────────────────────────────────────
    if (raw === '/api/health') {
      json(res, 200, {
        ok: true,
        model: settings.snapshot().model,
        // 思考强度如实报出来：它决定了「模型想不想」，而这件事在界面上本来完全看不见。
        reasoning: opts.reasoningEffort ?? DEFAULT_REASONING,
        // ★ 选项表也由服务端给：面板【不】自己抄一份白名单，
        //   否则加一档就要改两个仓库包，而漏改的那一半会静默地少一个选项。
        reasoningOptions: [...REASONING_EFFORTS],
        hasKey: settings.snapshot().apiKey !== '',
        // ★ 三类的上限也如实报出来：面板不抄第二份数字（见 reasonOptions 的先例）
        limits: {
          framesPerCall: L1_MAX_FRAMES,
          imagesPerShot: L2_MAX_IMAGES,
          renderCallsPerShot: L2_MAX_RENDER_CALLS,
          imagesInContext: L3_MAX_IMAGES_IN_CONTEXT,
          historyEntries: HISTORY_MAX_ENTRIES,
          historyChars: HISTORY_MAX_CHARS,
        },
        ffmpeg: ffmpegReady,
        uptimeMs: Date.now() - started,
      });
      return;
    }

    // ── /api/settings：读 / 写 API 设置（作业 3）─────────────────
    //
    // ★ key 只在服务端内存里，GET 永远只回掩码（见 settings.ts 的三条决定）。
    if (raw === '/api/settings') {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, settings: settings.view() });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req, maxBody)) as Record<string, unknown>;
          const applied = settings.apply(body);
          if (!applied.ok) {
            // ★ 一处非法就整批不动，并把每一条原因都说出来（不做静默的"部分成功"）
            json(res, 400, { ok: false, errors: applied.errors, settings: settings.view() });
            return;
          }
          json(res, 200, { ok: true, changed: applied.changed, settings: settings.view() });
        } catch (err) {
          json(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    // ── /api/settings/test：发一次最小请求，如实报三类失败 ──────────
    if (raw === '/api/settings/test') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req, maxBody)) as Record<string, unknown>;
          const cur = settings.snapshot();
          /**
           * ★ 允许"先填再测"：请求体里的值优先，缺了就用当前生效的。
           *   但白名单照样在 probeConnection 里强制 —— 能测不等于能存。
           */
          const pick = (v: unknown, fallback: string): string =>
            typeof v === 'string' && v.trim() !== '' ? v : fallback;
          const result = await probeConnection({
            apiKey: pick(body['apiKey'], cur.apiKey),
            baseUrl: pick(body['baseUrl'], cur.baseUrl),
            model: pick(body['model'], cur.model),
          });
          json(res, 200, { ok: result.ok, result });
        } catch (err) {
          json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    // ── /api/export：提交一个导出作业 ───────────────────────────
    if (raw === '/api/export') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      if (!ffmpegReady) {
        json(res, 503, {
          ok: false,
          error:
            '找不到 ffmpeg。请把它放到 ' + ffmpeg.ffmpeg +
            '（本机实测要用 Node 的 fetch 下载，Invoke-WebRequest 会 TLS 握手失败，见 docs/environment.md）。',
        });
        return;
      }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req, maxBody)) as { doc?: unknown; backend?: unknown };
          const doc = body.doc as SceneDoc | undefined;
          if (doc === undefined || typeof doc !== 'object' || doc.meta === undefined) {
            json(res, 400, { ok: false, error: 'doc 不是一份有效的 Scene Doc' });
            return;
          }
          const backend = body.backend === 'chrome' ? 'chrome' : 'canvas';
          const job = exports.create(doc, backend);
          // 不 await：导出要几十秒，请求不能挂着。
          // ★ catch 必须在这里：runExport 内部已经兜了一次错，但"兜错本身出错"
          //   （比如 spawn 同步抛 EPERM）会变成未捕获的 rejection，
          //   在 Node 24 下默认直接终止进程 —— 实测就这么把面板服务整个干掉了。
          void runExport(job, doc, exports, {
            root,
            ffmpegPath: ffmpeg.ffmpeg,
            ffprobePath: ffmpeg.ffprobe,
            ...(backend === 'chrome' ? { chromeRender: chromeRender } : {}),
          }).catch((err: unknown) => {
            exports.update(job.id, {
              state: 'failed',
              error: err instanceof Error ? err.message : String(err),
              finishedAt: Date.now(),
            });
          });
          json(res, 202, { ok: true, job });
        } catch (err) {
          json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    // ── /api/export/<id>：查作业状态；?download=1 时直接给 MP4 ────
    if (raw.startsWith('/api/export/')) {
      const rest = raw.slice('/api/export/'.length);
      const [id, sub] = rest.split('/');
      const job = id === undefined ? undefined : exports.get(id);
      if (job === undefined) {
        json(res, 404, { ok: false, error: 'export_not_found' });
        return;
      }
      if (sub === 'download') {
        if (job.state !== 'done' || job.outPath === undefined) {
          json(res, 409, { ok: false, error: 'not_ready', state: job.state });
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="' + job.id + '.mp4"',
        );
        createReadStream(job.outPath).pipe(res);
        return;
      }
      json(res, 200, { ok: true, job });
      return;
    }

    // ── /api/film：整片（导演分镜 → 逐镜跑）────────────────────
    //
    // ★ 起作业 + 轮询，而不是一个挂几十秒的 POST：与导出同一条口径。
    //   POST 只回 filmId；进度靠 GET /api/film/<id> 一条条拉。
    if (raw === '/api/film') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      jobs += 1;
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req, maxBody)) as {
            brief?: unknown;
            doc?: unknown;
            maxShots?: unknown;
            maxTurnsPerShot?: unknown;
            reasoning?: unknown;
          };
          const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
          if (brief === '') {
            json(res, 400, { ok: false, error: 'brief 不能为空' });
            return;
          }
          const doc = body.doc as SceneDoc | undefined;
          if (doc === undefined || typeof doc !== 'object' || doc.meta === undefined) {
            json(res, 400, { ok: false, error: 'doc 不是一份有效的 Scene Doc' });
            return;
          }
          const reasoning = resolveRequestedReasoning(body.reasoning, opts.reasoningEffort ?? DEFAULT_REASONING);
          if (reasoning === null) {
            json(res, 400, {
              ok: false,
              error: 'reasoning 只接受 ' + REASONING_EFFORTS.join(' / ') + '，收到：' + String(body.reasoning),
            });
            return;
          }
          const maxShots =
            typeof body.maxShots === 'number' && body.maxShots > 0
              ? Math.min(MAX_SHOTS, Math.floor(body.maxShots))
              : MAX_SHOTS;
          const maxTurnsPerShot =
            typeof body.maxTurnsPerShot === 'number' && body.maxTurnsPerShot > 0
              ? Math.floor(body.maxTurnsPerShot)
              : (opts.maxTurns ?? DEFAULT_MAX_TURNS_PER_SHOT);

          const job = films.create(brief);
          json(res, 200, { ok: true, filmId: job.id });

          /** 进度 → 作业表（面板轮询它）。★ 事件不 await，作业照跑。 */
          const onEvent = (e: FilmEvent): void => films.pushEvent(job.id, e);
          try {
            const live = settings.snapshot();
            const result = await runFilm({
              apiKey: live.apiKey,
              baseUrl: live.baseUrl,
              brief,
              doc,
              model: live.model,
              reasoningEffort: reasoning,
              maxShots,
              maxTurnsPerShot,
              render: (d, ts) =>
                renderFrames(d, ts).map((f) => ({ t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 })),
              onEvent,
              onPlan: (plan) => {
                films.update(job.id, { state: 'running', plan, title: plan.title, shotsTotal: plan.shots.length });
              },
            });
            // 逐镜进度：面板靠它显示「第 2/4 镜」
            films.update(job.id, {
              state: 'done',
              title: result.title,
              plan: result.plan,
              shotsTotal: result.plan.shots.length,
              shotsDone: result.shots.length,
              usage: result.usage,
              doc: result.doc,
              entries: result.entries,
              fromVersion: result.fromVersion,
              toVersion: result.toVersion,
              issueCodes: result.issues.map((i) => i.code),
              finishedAt: Date.now(),
            });
          } catch (err) {
            films.update(job.id, {
              state: 'failed',
              error: err instanceof Error ? err.message : String(err),
              finishedAt: Date.now(),
            });
          }
        } catch (err) {
          json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
          jobs -= 1;
        }
      })();
      return;
    }

    // ── /api/film/<id>：查整片进度（完成时一并给文档与操作）────────
    if (raw.startsWith('/api/film/')) {
      const id = raw.slice('/api/film/'.length);
      const job: FilmJob | undefined = films.get(id);
      if (job === undefined) {
        json(res, 404, { ok: false, error: '作业不存在: ' + id });
        return;
      }
      json(res, 200, {
        ok: true,
        film: {
          id: job.id,
          state: job.state,
          title: job.title ?? '',
          plan: job.plan ?? null,
          shotsDone: job.shotsDone,
          shotsTotal: job.shotsTotal,
          events: job.events,
          usage: job.usage,
          startedAt: job.startedAt,
          ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
          ...(job.error === undefined ? {} : { error: job.error }),
          // ★ 文档与操作只在完成时给：中途给出去，面板会拿到一份半成品文档。
          ...(job.state === 'done'
            ? {
                doc: job.doc,
                entries: job.entries,
                fromVersion: job.fromVersion,
                toVersion: job.toVersion,
                issueCodes: job.issueCodes,
              }
            : {}),
        },
      });
      return;
    }

    // ── /api/chat：跑一个镜头 ───────────────────────────────────
    if (raw === '/api/chat') {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }
      void (async () => {
        jobs += 1;
        try {
          const body = JSON.parse(await readBody(req, maxBody)) as {
            task?: unknown;
            doc?: unknown;
            maxTurns?: unknown;
            history?: unknown;
            reasoning?: unknown;
          };
          // ★ 页面上的那个下拉框每一轮都把它选的值带过来；服务端配的档位只是
          //   【页面的初值】。传了非法值就 400（不静默回退，见 resolveRequestedReasoning）。
          const reasoning = resolveRequestedReasoning(body.reasoning, opts.reasoningEffort ?? DEFAULT_REASONING);
          if (reasoning === null) {
            json(res, 400, {
              ok: false,
              error: 'reasoning 只接受 ' + REASONING_EFFORTS.join(' / ') + '，收到：' + String(body.reasoning),
            });
            return;
          }
          const task = typeof body.task === 'string' ? body.task.trim() : '';
          if (task === '') {
            json(res, 400, { ok: false, error: 'task 不能为空' });
            return;
          }
          const doc = body.doc as SceneDoc | undefined;
          if (doc === undefined || typeof doc !== 'object' || doc.meta === undefined) {
            json(res, 400, { ok: false, error: 'doc 不是一份有效的 Scene Doc' });
            return;
          }
          // 只收字符串，并限长限条数：这段文字会被塞进提示词，
          // 让调用方能无限制注入上下文等于把提示词交给外部。
          // ★ 第二十九轮放宽：4 条 × 400 字 → 12 条 × 1200 字。
          //   实测症状（§0.28 三 ⑤）：跨轮没有连续性，"再亮一点"这类指代无从落实。
          //   上限仍然存在 —— 它挡的是"外部调用方无限注入上下文"，不是成本。
          const history = (Array.isArray(body.history) ? body.history : [])
            .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
            .slice(-HISTORY_MAX_ENTRIES)
            .map((h) => h.slice(0, HISTORY_MAX_CHARS));

          const live = settings.snapshot();
          const result = await runOneShot({
            apiKey: live.apiKey,
            model: live.model,
            baseUrl: live.baseUrl,
            reasoningEffort: reasoning,
            task,
            doc,
            ...(history.length === 0 ? {} : { history }),
            maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : (opts.maxTurns ?? 12),
            render: (d, ts) =>
              renderFrames(d, ts).map((f) => ({ t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 })),
          });

          // ── 提取"要搬进浏览器 Journal 的操作" ──────────────────
          // 只搬 Agent 自己写的那些：审批补偿、引擎自动修都在服务端发生，
          // 它们的效果已经包含在 result.doc 里，不需要（也不该）在浏览器里再演一遍。
          const agentOps = result.journal.operations().filter((o) => o.actor === 'agent');
          const entries = agentOps.map((o) => ({
            patches: o.patches,
            affectedPaths: o.affectedPaths,
            ...(o.assignedId === undefined ? {} : { assignedId: o.assignedId }),
            ...(o.intent === undefined ? {} : { intent: o.intent }),
          }));

          json(res, 200, {
            ok: true,
            task,
            startVersion: result.fromVersion,
            endVersion: result.toVersion,
            compoundId: 'c:agent:chat:' + started + ':' + jobs,
            doc: result.doc,
            entries,
            chat: {
              events: toChatEvents(result.run.trace, result.run.finalMessage),
              finalMessage: result.run.finalMessage,
            },
            issues: result.issues.map((i) => ({
              severity: i.severity,
              group: i.group,
              code: i.code,
              path: i.path,
              message: i.message,
              fixClass: i.fixClass,
            })),
            usage: result.run.usage,
            turns: result.run.turns,
            truncated: result.run.truncated,
            finished: result.run.finished,
            budget: result.run.budget,
            agentOperations: result.agentOperations,
          });
        } catch (err) {
          json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        } finally {
          jobs -= 1;
        }
      })();
      return;
    }

    // ── 静态文件 ───────────────────────────────────────────────
    const rel = decodeURIComponent(raw);
    const target = normalize(join(root, rel));
    if (!target.startsWith(root + sep) && target !== root) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    try {
      const buf = readFileSync(target);
      res.setHeader('Content-Type', TYPES[extname(target)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found: ' + rel);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  // 文档路径转成静态服务的相对 URL。用 path.relative 而不是切字符串 ——
  // 切最后 N 段在 out/ 之外的路径上必错。
  const docRel = '/' + relative(root, opts.docPath).split('\\').join('/');
  return {
    origin: 'http://127.0.0.1:' + port,
    port,
    // 不传 api 端口：面板用【相对 URL】('/api/chat') 调接口，
    // 反正页面本身就是这个服务发出来的，同源。
    panelUrl: 'http://127.0.0.1:' + port + '/packages/panel/index.html?doc=' + docRel,
    exportJob: (id) => exports.get(id),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 从环境或 .env.local 取 key。服务端唯一持有它的地方。 */
export function resolveApiKey(repoRoot: string): string {
  const fromEnv = process.env['DEEPSEEK_API_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const envFile = join(repoRoot, '.env.local');
  if (!existsSync(envFile)) return '';
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  return line === undefined ? '' : line.slice('DEEPSEEK_API_KEY='.length).trim();
}
