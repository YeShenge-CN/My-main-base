/**
 * 面板主体（P9 第 1 / 4 条）。
 *
 * 六区：大纲 / 预览 / 效果控件 / 时间轴 / 审核队列 / Journal。
 *
 * ★ 预览容器（P9 的星号条）：
 *   容器的 CSS 像素宽高【严格等于】导出像素宽高（doc.meta.viewport），
 *   画布的 width/height 也等于它。屏幕适配【只用容器级 transform: scale()】。
 *   全程不碰 devicePixelRatio —— 一旦用了，预览和导出的抗锯齿与坐标量化就分叉了。
 */
import {
  applyCommands,
  controlModelFor,
  createJournal,
  evaluate,
  filterRenderStateByScene,
  findScene,
  frameSceneId,
  getObject,
  getSceneSummary,
  getTimeline,
  lastScene,
  groupFor,
  planShotFrames,
  REGISTRY,
  resolveFieldState,
  resolveItemStyle,
  unwrapField,
  type AnimKey,
  type AnimTrack,
  type ApplyCommandsResponse,
  type Command,
  type ControlModel,
  type FieldAtom,
  type FieldGroup,
  type FieldSpec,
  type FieldState,
  type Journal,
  type ResolvedItemStyle,
  type ProposalStore,
  type SceneDoc,
  type ShotTimeline,
} from '@sva/engine-core';
import { hitTest, paintScene, SVA_FONT_STACK, type Ctx2D } from '@sva/engine-render';
import { h, clear } from './dom';
import { renderControls } from './controls';
import { renderProposalCard } from './proposal-card';
import { createProposalStore } from '@sva/engine-core';
import { evaluateProposal } from '@sva/engine-core';
import { formatUsage, type TokenUsageView } from './usage';
import {
  keyPlaceholder,
  probeMessage,
  settingsPatchFrom,
  type ApiSettingsView,
  type ProbeResultView,
} from './api-settings';
import { renderTimeline, type TimelineHandle } from './timeline';
import { renderJournal } from './journal-view';
import { createFrameScheduler } from './scheduler';
import { createChatView, type ChatHost, type ChatRole, type ChatView } from './chat';
import {
  PROJECT_HISTORY_CAP,
  buildProject,
  parseProject,
  projectFilename,
  projectToJson,
  type ProjectChatLine,
  type ProjectContext,
  type ProjectFile,
} from './project';
import { commandForPath } from './command-path';
import {
  insertKeyAt,
  keyframeRows,
  moveKey,
  removeKey,
  snapTime,
  trackOf,
} from './keyframes';
import {
  NEW_SCENE_NAME,
  addSceneCommands,
  removeSceneCommand,
  renameSceneCommand,
  sceneCount,
  sceneUnderCaret,
  trimBoundaryCommand,
  trimEndCommand,
  withTrimPreview,
} from './scene-edit';

export interface PanelDeps {
  readonly root: HTMLElement;
  readonly doc: SceneDoc;
  readonly now: () => number;
  /**
   * Agent 服务地址。省略 = 没有聊天能力（界面照常可用）。
   * 用相对路径 '/api/chat'（页面本身就是那个服务发出来的，同源）。
   */
  readonly chatEndpoint?: string;
  /** 导出服务地址（默认 '/api/export'）。 */
  readonly exportEndpoint?: string;
}

export interface PanelRenderer {
  readonly play: (on: boolean) => void;
  readonly isPlaying: () => boolean;
  readonly loop: (on: boolean) => void;
  readonly frame: () => number;
  readonly totalFrames: () => number;
  readonly time: () => number;
  readonly seek: (time: number) => void;
  readonly seekFrame: (frame: number) => void;
  /** 当前画面的指纹。时间在走 ≠ 画面在变，这个用来区分两者。 */
  readonly frameHash: () => string;
}

export interface Panel {
  invalidate(): void;
  stats(): { renders: number; scheduled: number; coalesced: number };
  doc(): SceneDoc;
  journal(): Journal;
  /** 播放控制（人验证动画、以及自动化断言用的唯一入口）。 */
  renderer(): PanelRenderer;
  /** 聊天窗口（实机校验用它检查占位与提交路径）。 */
  chat(): ChatView;
  /** 当前推理档位（页面上那个下拉框的值）。自动化断言用它，不用去猜 DOM。 */
  reasoning(): string;
  /** 当前工程的 JSON（「保存工程」走的就是这条路）。 */
  projectJson(): string;
  /** 载入一份工程 JSON（「打开工程」/「恢复上次」走的就是这条路）。 */
  loadProject(text: string): { readonly ok: boolean; readonly error?: string };
  /** 导出 MP4（与顶栏按钮同一条路径）。 */
  exportMp4(): Promise<void>;
  /** 读出当前文档的副本（导出/校验脚本用）。 */
  snapshot(): SceneDoc;
  /** 相机关键帧数（校验脚本用它确认预设真的生效，不用去猜 DOM）。 */
  cameraKeyCount(): number;
  /**
   * 跑一个镜头（与聊天窗口同一条路径）。自动化测试直接调它，不用模拟打字。
   */
  runAgent(task: string): Promise<void>;
  /**
   * 以 AI 的身份提交一条命令。命中 hard 锁时会产生提案并进入审核队列 ——
   * 面板本身不造提案，提案永远是"引擎判定锁冲突"的产物。
   */
  applyAgentCommand(command: Command, rationale: string): void;
  /** 未决提案数（顶栏徽标） */
  pendingCount(): number;
}

/**
 * 整片作业的进度快照（服务端 GET /api/film/<id> 的形状）。
 *
 * ★ 面板【不】import agent-tools（那是另一个包，而且带着 Node 侧的东西），
 *   所以这里按契约自己声明一份。字段一旦漂移，实机校验会当场发现
 *   （面板读不到 title / events 就直接显示成空的）。
 */
interface FilmEventView {
  readonly kind: 'plan' | 'shot' | 'tool' | 'note' | 'error';
  readonly text: string;
  readonly name?: string;
  readonly turn?: number;
}

interface FilmProgress {
  readonly id: string;
  readonly state: 'planning' | 'running' | 'done' | 'failed';
  readonly title?: string;
  readonly shotsDone: number;
  readonly shotsTotal: number;
  readonly events: readonly FilmEventView[];
  readonly usage?: TokenUsageView;
  readonly error?: string;
  readonly doc?: SceneDoc;
  readonly endVersion?: number;
}

/** 把提案命令里那个字段的值换成用户手定的值（"改为手动设定"用）。 */
function withValue(cmd: Command, value: number): Command {
  const wide = cmd as unknown as Record<string, unknown>;
  for (const key of ['width', 'glow', 'opacity', 'x', 'y', 'rotate', 'sx', 'sy', 'samples']) {
    if (wide[key] !== undefined && typeof wide[key] === 'number') {
      return { ...wide, [key]: value } as unknown as Command;
    }
  }
  return cmd;
}

export function createPanel(deps: PanelDeps): Panel {
  const { root } = deps;
  let doc = deps.doc;
  /**
   * ★ `let` 而不是 `const`：打开工程 = 换一份文档 + 换一条历史。
   *   之所以能安全地整体替换，是因为面板里所有写入都走 `journal` 这个【变量】，
   *   没有任何地方缓存过它。
   */
   let journal = createJournal(doc, { now: deps.now });
  let selected: string | null = Object.keys(doc.objects)[0] ?? null;
  let t = 0;

  // 提案存储：判定用真实文档 + 真实三分支
  // ★ 用工厂函数建：打开工程时要换一个干净的（旧提案属于上一份文档，
  //   留着它们会出现「批准一条指向已不存在对象的提案」）。
  const makeProposals = (): ProposalStore => createProposalStore({
    now: deps.now,
    evaluate: (p) =>
      evaluateProposal(p, {
        doc,
        currentVersion: journal.currentVersion(),
        writtenSince: journal
          .query({ from: p.baseVersion + 1 })
          .flatMap((o) => o.affectedPaths),
      }),
  });
  let proposals = makeProposals();

  clear(root);
  const exportBtn = h('button', { id: 'exportbtn', class: 'btn', type: 'button' }, '导出 MP4');
  const exportStat = h('span', { id: 'exportstat', class: 'framelabel' }, '');
  /**
   * 导出用的渲染后端。
   *
   * canvas 快、不需要浏览器（默认）；chrome 走真正的浏览器截图，
   * 保真度更高（自托管字体、真实文字栅格化），但慢得多、而且需要
   * danger-full-access（Chrome 用命名管道做 Mojo IPC）。
   * 两条路共用同一份 evaluate + paintScene，所以"画什么"是一样的，差异只在栅格化。
   */
  const exportBackend = h('select', { id: 'exportbackend', class: 'select mini' },
    h('option', { value: 'canvas' }, 'canvas'),
    h('option', { value: 'chrome' }, 'chrome'),
  );
  exportBackend.title = '渲染后端：canvas 快；chrome 保真（需要浏览器权限）';
  /**
   * 世界尺寸：只读展示 + 为什么不能改。
   *
   * ★ 放在顶栏（一次性渲染），而不是 inspector 里：
   *   inspector 每次刷新都会 clear()，把它写在那儿的话，
   *   "选中一个对象"就会把这行说明擦掉（实测就是这样，实机校验直接抓到了）。
   *   一条"解释为什么某功能不做"的说明，必须在整个会话里稳定可见。
   */
  const worldNote = h('span', { id: 'worldnote', class: 'framelabel' }, '');
  /*
   * 工程：保存 / 打开 / 恢复上次。
   *
   * ★ 放顶栏而不是聊天区：它是【整份工程】级别的动作（含上下文），
   *   与「跟 Agent 说一句话」不是一类事。
   * ★ 「恢复上次」平时是灰的 —— 只有浏览器里真的有自动存档时才亮，
   *   亮了就说明点下去有东西可恢复（不留一个点了没反应的按钮）。
   */
  const saveProjBtn = h('button', { id: 'saveprojbtn', class: 'btn', type: 'button' }, '保存工程');
  const openProjBtn = h('button', { id: 'openprojbtn', class: 'btn', type: 'button' }, '打开工程');
  const restoreBtn = h('button', { id: 'restorebtn', class: 'btn', type: 'button' }, '恢复上次');
  restoreBtn.setAttribute('disabled', 'disabled');
  const projFile = h('input', { id: 'projfile', class: 'projfile', type: 'file' });
  projFile.setAttribute('accept', '.json,application/json');
  root.append(h('header', { id: 'topbar' },
    h('strong', {}, 'Simp Video Agent'),
    h('span', { id: 'docstat' }, ''),
    worldNote,
    saveProjBtn,
    openProjBtn,
    restoreBtn,
    projFile,
    exportStat,
    exportBackend,
    exportBtn,
    h('span', { id: 'pbadge', class: 'badge' }, ''),
  ));

  const body = h('div', { id: 'body' });
  const outline = h('aside', { id: 'outline' }, h('h3', {}, '大纲'));
  const previewWrap = h('main', { id: 'previewwrap' });
  const previewPanel = h('div', { id: 'preview' });
  const inspector = h('aside', { id: 'inspector' }, h('h3', {}, '效果控件'));
  const chatAside = h('aside', { id: 'chatwrap' }, h('h3', {}, 'Agent 聊天'));
  body.append(outline, previewWrap, inspector, chatAside);
  root.append(body);

  // ── 播放控制（P9 第 5 条的"可验证"部分）────────────────────────
  // ★ 没有播放之前，面板只能看单独一帧：动画在文档里、在控件状态里、
  //   在时间轴上都有痕迹，唯独没人能【看见它动】。人验证不了，
  //   压力测试自然也验证不了（它从不渲染）。
  const playBtn = h('button', { id: 'play', class: 'btn', type: 'button' }, '▶ 播放');
  const loopBtn = h('button', { id: 'loop', class: 'btn', type: 'button' }, '循环：关');
  const frameLabel = h('span', { id: 'framelabel', class: 'framelabel' }, '');
  const tcLabel = h('span', { id: 'tclabel', class: 'framelabel' }, '');
  const controls = h('div', { id: 'transport' }, playBtn, loopBtn, h('span', { class: 'sep' }, '·'), frameLabel, tcLabel);
  previewWrap.append(previewPanel, controls);

  const bottom = h('div', { id: 'bottom' });
  const timelineSec = h('section', { id: 'timeline' }, h('h3', {}, '时间轴'));
  const cameraSec = h('section', { id: 'camera' }, h('h3', {}, '相机'));
  const reviewSec = h('section', { id: 'review' }, h('h3', {}, '审核队列'));
  const journalSec = h('section', { id: 'journal' }, h('h3', {}, 'Journal'));
  bottom.append(timelineSec, cameraSec, reviewSec, journalSec);
  root.append(bottom);

  // ── 预览容器：CSS 像素宽高 = 导出像素宽高 ────────────────────────
  // ★ 视口尺寸从【文档】现读，不缓存成常量：viewport 现在可以在场景设置里改，
  //   缓存一次就会出现"文档说 1280×720、画布还是 960×540"这种分叉。
  const viewportSize = (): { readonly w: number; readonly h: number } => ({
    w: doc.meta.viewport[0],
    h: doc.meta.viewport[1],
  });
  const canvas = h('canvas', { id: 'stage' });
  {
    const { w, h: vh } = viewportSize();
    canvas.width = w;
    canvas.height = vh;
    canvas.style.width = w + 'px';
    canvas.style.height = vh + 'px';
    previewPanel.style.width = w + 'px';
    previewPanel.style.height = vh + 'px';
  }
  previewPanel.append(canvas);
  previewWrap.append(previewPanel);
  const ctx = canvas.getContext('2d');

  /** 把画布尺寸与容器尺寸同步到当前 viewport。改 viewport 之后必须调它。 */
  const syncViewport = (): void => {
    const { w, h: vh } = viewportSize();
    canvas.width = w;
    canvas.height = vh;
    canvas.style.width = w + 'px';
    canvas.style.height = vh + 'px';
    previewPanel.style.width = w + 'px';
    previewPanel.style.height = vh + 'px';
    fitPreview();
  };

  // 退回用的样式解析：正常路径上 RenderItem.style（求值层已叠加动画）优先。
  // 这里刻意复用 engine-core 的 resolveItemStyle —— 样式解析只允许存在一份实现。
  const styleOf = (item: { id: string }): ResolvedItemStyle => {
    const obj = doc.objects[item.id];
    if (obj === undefined) return {};
    return resolveItemStyle(obj);
  };

  /**
   * 帧计划。
   *
   * ★ 它是"总帧数 / 每帧时刻 / 每帧属于哪一镜"的【唯一】真源，与导出用的是
   *   同一个函数（engine-core 的 planShotFrames）。以前这里自己算
   *   `Math.round(duration × fps)`，那正是"预览与导出各算一遍"的隐患。
   *
   * ★ 每次文档变化都重算（镜头表、duration、fps 都可能被改）。
   *   它是个纯函数，所以不存在"缓存失配"这类问题。
   */
  /**
   * 拖动接缝时的【预览文档】（时间轴拉伸，像 PR 那样）。
   *
   * ★ 它不进 Journal、不改 doc：拖动中会产生几十个中间值，一个都不提交，
   *   松手才提交一条命令（与关键帧手柄同一条口径）。
   * ★ 覆盖只走【与提交同一个纯函数】（scene-edit 的 withTrimPreview），
   *   于是「拖到哪里就看到哪里」与「松手后是什么」不可能分叉。
   */
  let trimPreview: SceneDoc | null = null;
  const previewDoc = (): SceneDoc => trimPreview ?? doc;

  /** 时间轴句柄：只动播放头（拖动 / 播放时每帧调它），不重建 DOM。 */
  let timelineHandle: TimelineHandle | null = null;

  let plan: ShotTimeline = planShotFrames(doc);
  const replan = (): void => {
    // ★ 用预览文档重算：镜头边界/片长一变，帧计划与「这一帧属于哪一镜」都得跟着变，
    //   否则会出现「拖长了、红线后面却还是黑场」。
    plan = planShotFrames(previewDoc());
  };

  /* ── 播放状态与传输条 ────────────────────────────────────────
   * 顺序上必须【先于】paintPreview 声明：paintPreview 每帧都要读它们，
   * 声明在使用之后会踩 TDZ（渲染第一帧就 ReferenceError）。
   */

  const totalFrames = (): number => plan.frameCount;
  const frameOf = (time: number): number => Math.round(time * doc.meta.fps);
  const timeOf = (frame: number): number => frame / doc.meta.fps;

  /**
   * 当前时刻落在哪一镜。
   *
   * ★ 它与渲染用的是同一个判据（frameSceneId → plan.frames[i].sceneId），
   *   所以"传输条说你在 s#2"与"画面画的是 s#2"不可能分叉。
   *
   * ★ 帧号夹到计划范围内：renderer().seek(t) 允许传任意时刻，
   *   而计划只覆盖 [0, duration]。不夹的话越界查询会返回 null = 空档，
   *   于是画面整片变黑 —— 看起来像坏了，其实只是索引越界。
   */
  const currentScene = (): string | null => {
    const frame = Math.min(totalFrames() - 1, Math.max(0, frameOf(t)));
    return frameSceneId(plan, frame);
  };

  let playing = false;
  let loop = false;
  let lastFrameAt = 0;
  let playbackRaf: number | null = null;

  const updateTransport = (): void => {
    const total = totalFrames();
    const frame = Math.min(total, Math.max(0, frameOf(t)));
    frameLabel.textContent = '帧 ' + frame + ' / ' + total + '（' + doc.meta.fps + 'fps）';
    const scene = plan.shots.length === 0 ? '' : ' · ' + (currentScene() ?? '空档');
    tcLabel.textContent = 't=' + t.toFixed(2) + 's' + scene;
    playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    loopBtn.textContent = loop ? '循环：开' : '循环：关';
    // ★ 播放头每帧都要跟着动。以前它只在整面板刷新时重画，
    //   于是播放时是「画面在跑、红线卡住」；拖动时是「拖不动」。
    //   setPlayhead 只改一个数、重画一次画布，不重建 DOM。
    timelineHandle?.setPlayhead(t, currentScene());
  };

  const setPlaying = (on: boolean): void => {
    if (playing === on) return;
    playing = on;
    if (on) {
      if (frameOf(t) >= totalFrames()) t = 0; // 播到底再按播放 → 从头来
      lastFrameAt = performance.now();
      playbackRaf = requestAnimationFrame(tick);
    } else if (playbackRaf !== null) {
      cancelAnimationFrame(playbackRaf);
      playbackRaf = null;
    }
    updateTransport();
  };

  const seekFrame = (frame: number): void => {
    const total = totalFrames();
    t = timeOf(Math.min(total, Math.max(0, Math.round(frame))));
    paintPreview();
  };

  /**
   * 只重画画布。每帧走这条，开销最小。
   *
   * ★★ 按镜头过滤 —— 这是【正确性】要求，不是锦上添花：
   *    导出走的是 `renderAllFrames(…, plan)` + `sceneId` 过滤，
   *    而预览在此之前是"不过滤"的。于是多镜头文档会出现
   *    "预览里两个镜头的内容叠在一起、成片里各归各的" ——
   *    正是项目里最不能接受的那类失败（预览 ≠ 成片）。
   *
   *    evaluate 本身仍然不知道镜头（不变量 1）：过滤只重建 items 数组。
   */
  const paintPreview = (): void => {
    if (ctx === null) return;
    // 没有镜头表时不下传 sceneId —— 与导出的口径逐字一致（filterRenderStateByScene
    // 在空表时也直接原样返回，两处都安全）。
    // ★ 读的是 previewDoc()：拖动接缝时画面按【预览文档】画，松手前 doc 一个字节都不动。
    const d = previewDoc();
    const state = plan.shots.length === 0 ? evaluate(d, t) : filterRenderStateByScene(evaluate(d, t), d, currentScene());
    paintScene(ctx as unknown as Ctx2D, state, {
      theme: d.theme,
      styleOf,
      fontFamily: SVA_FONT_STACK,
    });
    const stat = document.getElementById('docstat');
    if (stat !== null) {
      const shots = plan.shots.length;
      stat.textContent =
        'v' + journal.currentVersion() + ' · ' + Object.keys(doc.objects).length + ' 对象' +
        (shots > 0 ? ' · ' + shots + ' 镜' : '') +
        ' · t=' + t.toFixed(2) + 's';
    }
    updateTransport();
  };

  /**
   * 播放一帧。
   *
   * ★ 时间只从【帧号】推导（t = frame / fps），与导出管线同一条约定。
   *   用 elapsed 毫秒累加会出现"预览里是 3.9999s、导出时是 4.0000s"这类
   *   永远查不出来的漂移。
   */
  const tick = (nowMs?: number): void => {
    if (!playing) return;
    const now = nowMs ?? performance.now();
    const stepMs = 1000 / doc.meta.fps;
    const elapsed = now - lastFrameAt;
    if (elapsed >= stepMs) {
      const advance = Math.max(1, Math.floor(elapsed / stepMs));
      // 保住余数，避免每帧都丢一点时间（长镜头会累积成明显慢放）
      lastFrameAt = now - (elapsed - advance * stepMs);
      const total = totalFrames();
      const next = frameOf(t) + advance;
      if (next >= total) {
        if (loop) {
          t = 0;
        } else {
          t = timeOf(total);
          playing = false;
          playbackRaf = null;
          paintPreview();
          return;
        }
      } else {
        t = timeOf(next);
      }
    }
    paintPreview();
    playbackRaf = requestAnimationFrame(tick);
  };

  playBtn.addEventListener('click', () => setPlaying(!playing));
  loopBtn.addEventListener('click', () => {
    loop = !loop;
    updateTransport();
  });
  window.addEventListener('keydown', (ev) => {
    // 空格播放/暂停，左右方向键逐帧（与导出同粒度：整数帧）
    if (ev.code === 'Space') {
      ev.preventDefault();
      setPlaying(!playing);
      return;
    }
    if (ev.code === 'ArrowRight') seekFrame(frameOf(t) + 1);
    if (ev.code === 'ArrowLeft') seekFrame(frameOf(t) - 1);
  });

  const scheduler = createFrameScheduler({
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    render: paintPreview,
    // 时间戳交给调度器注入，而不是在 paintPreview 里读时钟 ——
    // 求值本身的输入仍然只有 (doc, t)，不变量 1 不受影响。
    now: () => performance.now(),
  });

  /** 屏幕适配：只改容器级 transform，绝不进渲染逻辑 */
  const fitPreview = (): void => {
    const { w, h: vh } = viewportSize();
    const availW = Math.max(80, previewWrap.clientWidth - 24);
    // 扣掉播放条占的高度，否则它会顶出容器（容器是 overflow:hidden）
    const availH = Math.max(60, previewWrap.clientHeight - 24 - 44);
    const k = Math.min(availW / w, availH / vh);
    previewPanel.style.transform = 'scale(' + k.toFixed(4) + ')';
  };

  // ── 大纲（含"新建/删除"—— 没有它，空镜头在界面里根本没法开始）────────
  /**
   * 面板里"用户做了一件事"的【唯一出口】。
   *
   * ★ 一次手势 = 一批命令 = 一个 compound = 一次可撤销的编辑。
   *   `gestureId` 让引擎把这些命令分到同一个 compound、并在提交完把它置为 settled，
   *   于是 Journal 里的"撤销这一轮"对**用户自己的编辑**也真的可用。
   *
   * ★ 在这之前：面板从不传 gestureId（引擎也没转发过），于是
   *   "加一镜"这种两条命令的手势被拆成两个 compound，点一次撤销只撤后半截 ——
   *   留下一个零长度的镜头；而且用户编辑的 compound 永远是"进行中"，
   *   撤销按钮**一直是灰的**（journal 的注释写着"用户手势由调用方显式 settle"，
   *   而实际上没有任何调用方这么做）。
   */
  let gestureSeq = 0;
  const commitUser = (commands: readonly Command[], gesture: string): ApplyCommandsResponse => {
    const res = applyCommands(
      { baseVersion: journal.currentVersion(), commands: [...commands] },
      {
        journal,
        budget: BUDGET,
        actor: 'user',
        gestureId: gesture + '#' + (gestureSeq += 1),
        now: deps.now,
      },
    );
    if (res.ok.length > 0) {
      doc = journal.currentDoc();
      refreshPanels();
    }
    return res;
  };

  /** 从落盘文档里取一个未被占用的 localId（引擎只认批次内符号 id，这里给个不冲突的名字）。 */
  let localSeq = 0;
  const nextLocalId = (): string => '$ui' + (localSeq += 1);

  /** 新建对象：走同一条 CommandBus（不新建写路径），字段默认值来自 FieldRegistry 的登记。 */
  const createObject = (shape: 'plot2d' | 'text'): void => {
    const layerId = doc.layers[0]?.id;
    const cmd: Command =
      shape === 'text'
        ? {
            op: 'create_object',
            localId: nextLocalId(),
            shape: 'text',
            params: { content: '双击下面的控件改文字' },
            style: { size: 32, fill: '#e8eef8' },
            owner: { kind: 'global' },
            ...(layerId === undefined ? {} : { layer: layerId }),
          }
        : {
            op: 'create_plot',
            localId: nextLocalId(),
            expr: 'sin(x)',
            domain: [-7, 7],
            samples: 2400,
            style: { stroke: '#4ea1ff', width: 4, glow: 0.6 },
            owner: { kind: 'global' },
            ...(layerId === undefined ? {} : { layer: layerId }),
          };
    const res = commitUser([cmd], 'create-object');
    if (res.ok.length > 0) {
      const newId = res.ok[0]?.assignedId;
      if (newId !== undefined) selected = newId;
      refreshPanels();
    } else {
      chat.add({
        role: 'error',
        text:
          '新建失败：' +
          JSON.stringify(res.errored.map((e) => e.error.code + ' ' + e.error.message).join('；') || res.blocked),
      });
    }
  };

  /** 删除选中对象。引擎会自动摘掉图层引用与挂在它身上的效果。 */
  const deleteSelected = (): void => {
    if (selected === null) return;
    const res = commitUser([{ op: 'delete_object', target: selected }], 'delete-object');
    if (res.ok.length > 0) {
      selected = Object.keys(doc.objects)[0] ?? null;
      refreshPanels();
    }
  };

  const renderOutline = (): void => {
    clear(outline);
    outline.append(
      h(
        'div',
        { class: 'outline-tools' },
        btn('＋ 曲线', () => createObject('plot2d'), '新建一条 y=sin(x) 的曲线'),
        btn('＋ 文字', () => createObject('text'), '新建一行屏幕空间文字'),
        btn('删除', () => deleteSelected(), selected === null ? '先选中一个对象' : '删除选中的 ' + selected),
      ),
    );
    const summary = getSceneSummary(doc, { tokenBudget: 100000 });
    for (const layer of doc.layers) {
      outline.append(h('div', { class: 'layer' }, '▤ ' + layer.id));
      for (const id of layer.objects) {
        const item = summary.objects.find((o) => o.id === id);
        const row = h('div', { class: 'obj' + (id === selected ? ' sel' : '') }, id);
        row.append(h('span', { class: 'otype' }, item?.type ?? '?'));
        row.addEventListener('click', () => {
          selected = id;
          refreshPanels();
        });
        outline.append(row);
      }
    }
  };

  // ── 效果控件 ────────────────────────────────────────────────────
  const stateOf = (path: string): FieldState | undefined => {
    if (path.startsWith('plot#') || /^[a-zA-Z]+#/.test(path)) return resolveFieldState(doc, path);
    return undefined;
  };

  /**
   * engineOnly 字段不进控件。
   *
   * ★ 它们是【机器写的】（公式的矢量轮廓、世界宽高…）：给人一个可编辑的框，
   *   等于邀请一次"改了但没人重算"的不一致 —— 公式的 source 与几何就会变成两个真源。
   *   所以这一层直接不渲染它们（§7 第 6 条那个"engineOnly 没有真的 disable"的收口）。
   */
  const editableOnly = (models: readonly ControlModel[]): ControlModel[] =>
    models.filter((m) => !m.engineOnly);

  const modelsFor = (id: string): readonly ControlModel[] => {
    const obj = doc.objects[id];
    if (obj === undefined) return [];
    const view = getObject(doc, id, 'full');
    const values = (zone: 'style' | 'params'): Record<string, unknown> =>
      (zone === 'style' ? view?.style : view?.params) as Record<string, unknown> ?? {};

    const out: ControlModel[] = [];
    const tf = groupFor(REGISTRY, 'object', undefined, 'tf');
    if (tf !== undefined) {
      out.push(...editableOnly(controlModelFor(tf, obj.tf as unknown as Record<string, unknown>, id + '.tf')));
    }
    for (const section of ['params', 'style'] as const) {
      const g = groupFor(REGISTRY, 'shape', obj.shape, section);
      if (g !== undefined) out.push(...editableOnly(controlModelFor(g, values(section), id + '.' + section)));
    }
    for (const effId of obj.effects) {
      const eff = doc.effects[effId];
      if (eff === undefined) continue;
      const g = groupFor(REGISTRY, 'effect', eff.type, 'params');
      if (g !== undefined) {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(eff.params)) {
          raw[k] = typeof v === 'object' && v !== null && 'v' in v ? (v as { v: unknown }).v : v;
        }
        out.push(...editableOnly(controlModelFor(g, raw, effId + '.params')));
      }
    }
    return out;
  };

  /**
   * 场景设置（meta）的控件。
   *
   * ★ worldWidth / worldHeight 【刻意】做成只读展示，而不是可以编辑的控件：
   *   它们是"世界 → 像素"的基准（base = min(viewport/world)）。改一次，
   *   所有已有对象的屏幕位置、大小、描边宽度一起漂 —— 那是重新取景，不是编辑。
   *   引擎侧的 set_meta 命令也不接受它们（只认 fps/duration/viewport）。
   */
  const sceneModels = (): readonly ControlModel[] => {
    const group = requireMetaGroup();
    // 只保留"真的能改"的两项。worldWidth/worldHeight 留在 registry 里是给
    // 新建镜头用的默认值，不是给编辑用的控件 —— 它们在界面上以只读文字出现。
    const editable: FieldGroup = {
      ...group,
      fields: { fps: group.fields['fps'] as FieldSpec, duration: group.fields['duration'] as FieldSpec },
    };
    // ★ 复用 controlModelFor，而不是在这里手搓 ControlModel：
    //   手搓等于把"控件类型与范围怎么从 registry 推导"再实现一遍。
    const out: ControlModel[] = [
      ...controlModelFor(editable, { fps: doc.meta.fps, duration: doc.meta.duration }, 'meta'),
    ];
    // 画布尺寸不是单个 meta 字段（它是 viewport 元组的两个分量），单独造两条。
    const { w, h: vh } = viewportSize();
    for (const [key, label, value] of [
      ['w', '画布宽', w],
      ['h', '画布高', vh],
    ] as const) {
      out.push({
        path: 'meta.viewport.' + key,
        key: 'viewport.' + key,
        label,
        kind: 'number',
        value,
        unit: 'px',
        min: 16,
        max: 8192,
        step: 1,
        optional: false,
        engineOnly: false,
        animatable: false,
        section: 'meta',
        changeClass: 'control',
        bounded: true,
        description: key === 'w' ? '导出像素宽。世界坐标不受影响。' : '导出像素高。世界坐标不受影响。',
      });
    }
    return out;
  };

  /** 从 registry 取 scene.meta 分组；取不到就抛（宁可红，也不要静默用手写默认值）。 */
  function requireMetaGroup(): FieldGroup {
    const group = groupFor(REGISTRY, 'scene', undefined, 'meta');
    if (group === undefined) throw new Error('registry 缺少 scene.meta 分组');
    return group;
  }

  const applyMeta = (cmd: Command): void => {
    const res = commitUser([cmd], 'set-meta');
    if (res.ok.length > 0) {
      // 视口变了要同步画布与容器，否则"文档说 1280×720、画布还是 960×540"
      syncViewport();
      refreshPanels();
      return;
    }
    const why = res.errored.map((e) => e.error.code + ' ' + e.error.message).join('；');
    chat.add({ role: 'error', text: '场景设置没生效：' + (why === '' ? JSON.stringify(res.blocked) : why) });
  };

  /** 场景设置的 onChange：把控件路径翻译成一条 set_meta 命令（与其它控件同一条写路径）。 */
  const onSceneChange = (path: string, value: unknown): void => {
    const { w, h: vh } = viewportSize();
    if (path === 'meta.fps' && typeof value === 'number') return applyMeta({ op: 'set_meta', fps: value });
    if (path === 'meta.duration' && typeof value === 'number') {
      return applyMeta({ op: 'set_meta', duration: value });
    }
    if (path === 'meta.viewport.w' && typeof value === 'number') {
      return applyMeta({ op: 'set_meta', viewport: [value, vh] });
    }
    if (path === 'meta.viewport.h' && typeof value === 'number') {
      return applyMeta({ op: 'set_meta', viewport: [w, value] });
    }
  };

  /**
   * 相机区。
   *
   * 预设是【替换】整条相机轨（见 CameraPresetCommand 的注释），所以每个按钮都是
   * "把镜头变成这样"，连点两次不会叠出两段推近。
   * 主体默认取当前选中的对象 —— 镜头的意义就是"对准某个东西"。
   */
  const renderCamera = (): void => {
    clear(cameraSec);
    cameraSec.append(h('h3', {}, '相机'));
    const subject = selected ?? Object.keys(doc.objects)[0];
    const info = h('span', { class: 'framelabel', id: 'caminfo' },
      doc.camera.keys.length + ' 个关键帧' +
        (subject === undefined ? '' : ' · 主体 ' + subject));
    const row = h('div', { class: 'camrow' },
      btn('推近', () => preset('pushIn', subject), subject === undefined ? '先建一个对象' : '镜头对准 ' + subject + ' 并推近'),
      btn('拉开', () => preset('pullOut', subject), '从近处拉到全景'),
      btn('复位', () => preset('reset', subject), '回到静止的恒等镜头'),
    );
    cameraSec.append(row, info);
  };

  const preset = (name: 'pushIn' | 'pullOut' | 'reset', subject: string | undefined): void => {
    const cmd: Command =
      name === 'reset'
        ? { op: 'camera_preset', preset: 'reset' }
        : {
            op: 'camera_preset',
            preset: name,
            // 时长给默认值：预设的秒数由引擎兜底，界面上不强迫用户先填一个数
            duration: Math.max(1, Math.min(doc.meta.duration, 3)),
            intensity: 0.6,
            ...(subject === undefined ? {} : { subject }),
          };
    const res = commitUser([cmd], 'camera-preset');
    if (res.ok.length > 0) return;
    const why = res.errored.map((e) => e.error.code + ' ' + e.error.message).join('；');
    chat.add({ role: 'error', text: '相机没动：' + (why === '' ? JSON.stringify(res.blocked) : why) });
  };

  /** 该字段上是否已有动画轨道（对象相对路径 vs 控件路径的换算在这里统一）。 */
  const animTrackOf = (path: string): string | undefined => {
    const parts = path.split('.');
    const id = parts[0];
    if (id === undefined) return undefined;
    const obj = doc.objects[id];
    if (obj === undefined) return undefined;
    const track = parts.slice(1).join('.');
    return Object.prototype.hasOwnProperty.call(obj.anim, track) ? track : undefined;
  };

  /**
   * 切换一个字段的动画轨道。
   *
   * ★ 这里【只发命令】，关键帧内容由面板给出一个"有意义的默认值"：
   *   数值字段 → 从 0 淡入到当前值（最常见、且一眼能看出在动）；
   *   其它类型（颜色/开关）→ 两端取同一个值（建一条轨道但不改变外观，
   *   用户随后可以自己拖时间轴上的关键帧）。
   *   之所以不在这里做"加一个关键帧"的细粒度编辑：那需要时间轴上的关键帧编辑 UI，
   *   而这条命令本身在文档里是完整的 —— 先能建能删，再看要不要做逐帧编辑。
   */
  const toggleAnim = (path: string, on: boolean): void => {
    const parts = path.split('.');
    const id = parts[0];
    const track = parts.slice(1).join('.');
    if (id === undefined || track === '') return;
    const cmd: Command = {
      op: 'set_motion',
      target: id,
      field: track,
      node: on ? defaultTrackFor(path) : null,
      intent: on ? '给 ' + path + ' 加一条动画轨道' : '删掉 ' + path + ' 的动画轨道',
    };
    const res = commitUser([cmd], 'set-motion');
    if (res.ok.length > 0) return;
    const why = res.errored.map((e) => e.error.code + ' ' + e.error.message).join('；');
    chat.add({
      role: 'error',
      text: '动画没加上：' + (why === '' ? JSON.stringify(res.proposals.map((p) => p.proposal.target)) : why),
    });
  };

  /** 一个字段的默认动画：数值给"从 0 淡入到当前值"，其余两端同值。 */
  const defaultTrackFor = (path: string): AnimTrack => {
    const parts = path.split('.');
    const id = parts[0] ?? '';
    const track = parts.slice(1).join('.');
    const zone = parts[1];
    const key = parts[2] ?? '';
    let current: unknown;
    if (zone === 'tf') {
      current = (doc.objects[id]?.tf as unknown as Record<string, unknown> | undefined)?.[key];
    } else if (zone === 'style') {
      current = unwrapField(doc.objects[id]?.style[key]);
    }
    const endT = Math.min(doc.meta.duration, 1.5);
    if (typeof current === 'number' && track !== '') {
      // 从 0 起：最常见的"淡入/生长"手感；终点保留用户当前的取值
      return { kind: 'keys', keys: [{ t: 0, v: 0, ease: 'easeOutCubic' }, { t: endT, v: current }] };
    }
    const value: FieldAtom = current === undefined ? 1 : (current as FieldAtom);
    return { kind: 'keys', keys: [{ t: 0, v: value }, { t: endT, v: value }] };
  };

  const renderInspector = (): void => {
    clear(inspector);
    inspector.append(h('h3', {}, '场景设置'));
    renderControls(inspector, sceneModels(), {
      stateOf: () => undefined,
      onChange: onSceneChange,
    });
    // 只读的世界尺寸：把"为什么它不能改"直接写在界面上，而不是让人以为漏做了
    worldNote.textContent =
      '世界 ' + doc.meta.worldWidth + '×' + doc.meta.worldHeight + '（不可事后修改：会重映射世界→像素，把所有已摆好的位置一起挪走）';
    inspector.append(h('h3', {}, '效果控件'));
    if (selected === null) {
      inspector.append(h('p', { class: 'muted' }, '未选中对象。'));
      return;
    }
    /**
     * 公式对象：几何是机器写的（控件被 engineOnly 挡掉了），但【它是什么】要让人看得见 ——
     * 否则面板上就是一个没有解释的图形。
     */
    if (doc.objects[selected]?.shape === 'formula') {
      const src = String(unwrapField(doc.objects[selected]?.params['source']) ?? '');
      inspector.append(h('p', { class: 'muted', id: 'formulasrc' }, '公式：' + src));
    }
    inspector.append(h('div', { class: 'legend' },
      h('span', {}, '● 静态'),
      h('span', {}, '● 动画'),
      h('span', {}, '🔒 用户锁'),
      h('span', {}, '🔓 AI 锁'),
    ));
    renderControls(inspector, modelsFor(selected), {
      stateOf,
      animatedFor: (path) => animTrackOf(path) !== undefined,
      onToggleAnim: toggleAnim,
      proposedFor: (path) => {
        const p = proposals.pendingForPath(path);
        return p === undefined ? undefined : { after: p.after };
      },
      onChange: (path, value) => {
        const cmd = commandForPath(path, value, doc);
        /**
         * ★ 拿不到命令时【必须说出来】。
         *
         * 这里以前是 `if (cmd === null) return;` —— 于是面板画出了控件、
         * 拖了没反应、也不报错。highlight / moveAlong 的效果参数从落地那天起
         * 就是死的，而界面上完全看不出来（§7 第 0 条）。
         * 静默失效比"功能没做"危险得多：前者会让人以为是自己没操作对。
         */
        if (cmd === null) {
          chat.add({ role: 'error', text: '这个控件改不动（没有对应的命令）：' + path });
          return;
        }
        commitUser([cmd], 'edit-field');
      },
    });
  };

  // ── 时间轴 / 审核队列 / Journal ─────────────────────────────────

  /**
   * 镜头管理（P4 #14）：加一镜 / 改名 / 删一镜。
   *
   * ★ 引擎的三条命令（add_scene / set_scene / remove_scene）从 P12 起就绪、
   *   有 33 条断言守着、也早就给了 AI —— 缺的一直是**人的入口**。
   *   所以这一块刻意写得很薄：它只负责"把控件画出来 + 把意图交出去"，
   *   该发哪几条命令、什么时候干脆不发，都在纯函数 scene-edit.ts 里（有断言）。
   */
  const buildSceneTools = (): HTMLElement => {
    const caret = currentScene();
    const targetId = sceneUnderCaret(doc, caret);
    const target = targetId === null ? undefined : findScene(doc, targetId);
    const count = sceneCount(doc);

    const nameInput = h('input', { id: 'scenename', class: 'text', type: 'text' });
    nameInput.value = target?.name ?? '';
    nameInput.placeholder = NEW_SCENE_NAME;
    nameInput.title = '改这一镜的名字（只改名，不动边界与内容）';

    const addBtn = btn('＋ 镜头', () => {
      const cmds = addSceneCommands(doc);
      const res = commitUser(cmds, 'add-scene');
      if (res.ok.length === 0) {
        chat.add({ role: 'error', text: '加镜头失败：' + JSON.stringify(res.errored) });
        return;
      }
      // ★ 说清它做了什么：追加一镜必然把片长延出去（否则新镜是零长度的），
      //   没有这一句，用户会以为"片长自己变了"。
      const last = lastScene(doc);
      chat.add({
        role: 'note',
        text:
          '已加一镜' + (last === undefined ? '' : '：' + last.id + ' 从 ' + last.bornAt.toFixed(2) + 's 起') +
          '，片长延到 ' + doc.meta.duration.toFixed(2) + 's（新镜需要时长，否则它是零长度的）。',
      });
    }, '在最后一镜之后加一镜（片长会相应延长）');

    const renameBtn = btn('改名', () => {
      if (targetId === null) return;
      const cmd = renameSceneCommand(targetId, nameInput.value);
      if (cmd === null) {
        chat.add({ role: 'error', text: '镜头名字不能是空的。' });
        return;
      }
      commitUser([cmd], 'rename-scene');
    }, '把这一镜改名');

    const removeBtn = btn('删除本镜', () => {
      if (targetId === null) return;
      const cmd = removeSceneCommand(doc, targetId);
      if (cmd === null) {
        chat.add({ role: 'error', text: '最后一镜不能删（删了片长就没有归属了）。' });
        return;
      }
      commitUser([cmd], 'remove-scene');
    }, '删掉这一镜（镜内对象会被改归属到相邻镜头，不会丢）');

    if (targetId === null) {
      removeBtn.setAttribute('disabled', 'disabled');
      renameBtn.setAttribute('disabled', 'disabled');
      nameInput.setAttribute('disabled', 'disabled');
    }
    if (count <= 1) {
      // 只剩一镜时删不得（引擎的硬规则）—— 提前置灰并说明，而不是让人点了看报错
      removeBtn.setAttribute('disabled', 'disabled');
      removeBtn.title = '最后一镜不能删（删了片长就没有归属了）';
    }

    return h(
      'div',
      { class: 'scenetools', id: 'scenetools' },
      addBtn,
      h('span', { class: 'framelabel' }, count === 0 ? '还没有镜头表（全片一镜）' : count + ' 镜 · 当前 ' + (target?.id ?? '—')),
      nameInput,
      renameBtn,
      removeBtn,
    );
  };

  /**
   * 时间轴区 = 时间轴本身 + 镜头管理控件。
   *
   * ★★ 顺序不能反：`renderTimeline()` 的**第一行就是 `clear(root)`**，
   *   在它之前 append 的东西会被它一起清掉 —— 这不是猜的，是实机校验抓到的：
   *   镜头管理的控件加进去之后 `#scenetools` 取到 `null`，而同一段代码
   *   单测全绿（单测看不到 DOM 顺序这件事）。
   *   顺带解释了一个一直没人注意的现象：面板左下角从来没有"时间轴"这个标题 ——
   *   它从加进去那天起就被同一句 `clear` 吃掉了。
   *
   *   修法是把它挪到 `renderTimeline(...)` **之后**（保持 `renderTimeline` 的契约不变：
   *   "你给我一个容器，我负责它里面的东西"）。
   */
  /**
   * 关键帧条（§7 第 4 条）：选中对象的每条轨道一行、每个关键帧一个手柄。
   *
   *   拖动改时刻 · 双击手柄删除 · 双击空白处插入（取值 = 那一刻的当前值，形状不变）
   *
   * ★ 三条编辑规则（吸附、夹在相邻帧之间、插帧不改形状）全在纯函数 `keyframes.ts` 里，
   *   这一块只负责"把 DOM 与鼠标事件接上去"。理由与前两块一样：
   *   规则要能被毫秒级断言，而 DOM 里测不了它。
   *
   * ★ 一次拖动 = 一次手势 = 一条命令 → 一次撤销。拖动过程中**不发命令**
   *   （每条 mousemove 都提交会造出几百个 compound，撤销面板会被淹掉），
   *   松手时才按最终位置提交一条 `set_motion`。
   */
  const commitKeys = (track: string, keys: readonly AnimKey[], what: string): void => {
    if (selected === null) return;
    const cmd: Command = { op: 'set_motion', target: selected, field: track, node: trackOf(keys), intent: what };
    const res = commitUser([cmd], 'edit-keyframe');
    if (res.ok.length === 0) {
      chat.add({
        role: 'error',
        text: what + ' 没生效：' + JSON.stringify(res.errored.map((e) => e.error.code + ' ' + e.error.message)),
      });
    }
  };

  const buildKeyframeStrip = (): HTMLElement => {
    const wrap = h('div', { class: 'kf-strip', id: 'kfstrip' });
    const obj = selected === null ? undefined : doc.objects[selected];
    const rows = obj === undefined ? [] : keyframeRows(obj);
    if (obj === undefined || rows.length === 0) {
      wrap.append(
        h('div', { class: 'kf-head' }, '关键帧：选中对象还没有动画轨道 —— 用控件旁的 ◇ 建一条，这里就会出现手柄'),
      );
      return wrap;
    }
    const duration = doc.meta.duration;
    const fps = doc.meta.fps;
    const pctOf = (t: number): string => (duration <= 0 ? '0' : ((t / duration) * 100).toFixed(4)) + '%';
    wrap.append(
      h('div', { class: 'kf-head' }, '关键帧 · ' + selected + '（拖动改时刻 · 双击手柄删除 · 双击空白插入）'),
    );

    for (const row of rows) {
      if (row.kind === 'expr') {
        wrap.append(
          h(
            'div',
            { class: 'kf-row' },
            h('span', { class: 'kf-label' }, row.track),
            h('div', { class: 'kf-track kf-expr' }, '表达式：' + (row.expr ?? '')),
          ),
        );
        continue;
      }
      const trackEl = h('div', { class: 'kf-track', 'data-track': row.track });
      const timeAt = (clientX: number): number => {
        const rect = trackEl.getBoundingClientRect();
        const frac = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
        return snapTime(frac * duration, fps, duration);
      };

      row.keys.forEach((key, index) => {
        const handle = h('button', {
          class: 'kf-key',
          type: 'button',
          'data-index': String(index),
          style: 'left:' + pctOf(key.t),
        }, '◆');
        handle.title = row.track + ' @ ' + key.t.toFixed(2) + 's = ' + String(key.v) + '（双击删除）';

        handle.addEventListener('dblclick', (ev) => {
          // ★ 必须挡住冒泡：否则这一下会同时被"轨道空白处"的插入处理器接走
          ev.stopPropagation();
          ev.preventDefault();
          const next = removeKey(row.keys, index);
          commitKeys(row.track, next, next.length === 0 ? '删掉整条关键帧轨道（最后一帧）' : '删掉一个关键帧');
        });

        handle.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const paint = (t: number): void => {
            handle.style.left = pctOf(t);
            handle.title = row.track + ' @ ' + t.toFixed(2) + 's = ' + String(key.v) + '（松手生效）';
          };
          const onMove = (e: MouseEvent): void => paint(timeAt(e.clientX));
          const onUp = (e: MouseEvent): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const next = moveKey(row.keys, index, timeAt(e.clientX), { duration, fps });
            const now = next[index]?.t;
            // 位置没变就不发命令（点一下手柄不该产生一条 Journal）
            if (now === undefined || Math.abs(now - key.t) < 1e-9) return;
            commitKeys(row.track, next, '把 ' + row.track + ' 的关键帧拖到 ' + now.toFixed(2) + 's');
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });

        trackEl.append(handle);
      });

      trackEl.addEventListener('dblclick', (ev) => {
        const t = timeAt(ev.clientX);
        const next = insertKeyAt(obj, row.track, row.keys, t, { duration, fps });
        if (next === null) {
          chat.add({ role: 'note', text: '这个时刻插不了关键帧（同一帧已经有一个，或这个字段取不到值）。' });
          return;
        }
        commitKeys(row.track, next, '在 ' + t.toFixed(2) + 's 给 ' + row.track + ' 插一个关键帧');
      });

      wrap.append(h('div', { class: 'kf-row' }, h('span', { class: 'kf-label' }, row.track), trackEl));
    }
    return wrap;
  };

  const renderTimelineSection = (): void => {
    const events = getTimeline(doc, { from: 0, to: doc.meta.duration });
    timelineHandle = renderTimeline(timelineSec, events, doc.meta.duration, t, {
      onSeek: (nt) => {
        // 吸附到帧网格：播放头与"这一帧属于哪一镜"用的是同一套离散化，
        // 不吸附会出现"播放头压在边界上、画面却属于上一镜"。
        t = timeOf(Math.min(totalFrames() - 1, Math.max(0, frameOf(nt))));
        // 播放头动了就要立刻重画：scheduler 只在有脏标记时渲染，
        // 少了这一句会出现"时间轴动了、画面没动"。
        paintPreview();
        scheduler.invalidate();
      },
      onSelectScene: () => {
        // 点镜头块 = 把播放头挪到那一镜的起点（onSeek 已经做了），
        // 这里只把界面刷新到新状态（时间轴高亮跟着 currentScene() 走，
        // 而它读的就是播放头所在的那一镜 —— 不需要第二个"选中镜头"的概念）。
        refreshPanels();
      },
      /**
       * 拖动接缝（实时）：只更新预览，一个字节都不写进 Journal。
       *
       * ★ 返回【被夹住之后】的真实时刻 —— 时间轴据此挪缝，
       *   于是「鼠标能拖到哪儿」与「引擎接受哪儿」永远是同一个数。
       */
      onTrimPreview: (target, nt) => {
        const next = withTrimPreview(doc, target, nt, doc.meta.fps);
        trimPreview = next;
        replan();
        paintPreview();
        scheduler.invalidate();
        if (target.kind === 'end') return next.meta.duration;
        return next.scenes.find((s) => s.id === target.sceneId)?.bornAt ?? nt;
      },
      /**
       * 松手（提交）：整段拖动只产生【一条】命令 = 一次撤销。
       *
       * ★ 先清掉预览再提交：commitUser 成功后会 refreshPanels() → replan()，
       *   而 replan 读的就是 previewDoc()；不清的话会把「预览」当成真文档去算帧计划。
       */
      onTrimCommit: (target, nt) => {
        trimPreview = null;
        const cmd = target.kind === 'end' ? trimEndCommand(doc, nt) : trimBoundaryCommand(doc, target.sceneId, nt);
        if (cmd === null) {
          // 没变化、或两镜已经挤到最短：什么都不提交，把界面退回真实文档
          replan();
          paintPreview();
          refreshPanels();
          return;
        }
        const res = commitUser([cmd], 'trim-scene');
        if (res.ok.length === 0) {
          chat.add({
            role: 'error',
            text: '改镜头时长没生效：' + JSON.stringify(res.errored.map((e) => e.error.code + ' ' + e.error.message)),
          });
          replan();
          paintPreview();
          refreshPanels();
        }
      },
    }, {
      shots: plan.shots,
      currentScene: currentScene(),
    });
    // ★ 必须在这里（renderTimeline 已经 clear 过容器了）—— 见上面的注释。
    //   标题与镜头控件用 prepend（顺序 = 标题、镜头管理、时间轴本体），关键帧条 append 在最下面。
    timelineSec.prepend(h('h3', {}, '时间轴'), buildSceneTools());
    timelineSec.append(buildKeyframeStrip());
  };

  const commitProposal = (p: { command: Command }, override: number | null): void => {
    const cmd = override === null ? p.command : withValue(p.command, override);
    // 批准/改值也是一次【用户手势】：撤销要能把它整条撤回来。
    commitUser([cmd], 'proposal-decide');
    doc = journal.currentDoc();
  };

  const renderReview = (): void => {
    clear(reviewSec);
    const n = proposals.count();
    reviewSec.append(h('h3', {}, '审核队列' + (n > 0 ? '（' + n + '）' : '')));
    const badge = document.getElementById('pbadge');
    if (badge !== null) {
      badge.textContent = n > 0 ? String(n) : '';
      badge.className = n > 0 ? 'badge on' : 'badge';
    }

    const pending = proposals.pending();
    if (pending.length === 0) {
      reviewSec.append(h('p', { class: 'muted' }, '当前没有待批准的提案。'));
      return;
    }
    for (const p of pending) {
      reviewSec.append(
        renderProposalCard(p, {
          onApprove: (id) => {
            const r = proposals.decide(id, 'approve');
            if (r?.decision?.kind === 'approve') commitProposal(p, null);
            else if (r?.decision?.kind === 'fast-forward') commitProposal(p, null);
            refreshPanels();
          },
          onReject: (id, note) => {
            proposals.decide(id, 'reject', { value: note });
            refreshPanels();
          },
          onOverride: (id, value) => {
            proposals.decide(id, 'override', { value });
            commitProposal(p, value);
            refreshPanels();
          },
          remainingMs: () => 10 * 60 * 1000,
        }),
      );
    }
  };

  /**
   * 防重入：控件的 onChange 会提交命令，提交完又要重建控件。
   * 没有这道闸，任何"改一下就重建、重建又改一下"的路径都会变成同步无限递归。
   */
  let refreshing = false;
  const refreshPanels = (): void => {
    if (refreshing) return;
    refreshing = true;
    try {
      refreshPanelsInner();
    } finally {
      refreshing = false;
    }
  };

  const refreshPanelsInner = (): void => {
    // ★ 帧计划在任何一次文档变化之后都必须重算（镜头表/duration/fps 都可能被改）。
    //   放在这里而不是散落在十几个 commit 之后：失败模式太隐蔽 ——
    //   漏一处就会出现"改了片长但帧数还是旧的"，而时间轴看起来一切正常。
    replan();
    // ★ 文档一变就安排一次自动存档（防抖 900ms）——刷新页面不该丢工作
    autosave();
    renderOutline();
    renderInspector();
    renderCamera();
    renderTimelineSection();
    renderReview();
    renderJournal(journalSec, {
      journal,
      onRevert: (compoundId) => {
        const r = journal.revertCompound(compoundId);
        doc = journal.currentDoc();
        refreshPanels();
        // 撤销结果如实展示，包括被跳过与折叠的路径
        const note = h('p', { class: 'muted' },
          '撤销 ' + compoundId + '：' + r.kind + '，补偿 ' + r.reverted.length + ' 条，跳过 ' + r.skipped.length + ' 条，折叠 ' + r.folded.length + ' 条');
        reviewSec.append(note);
      },
    });
    scheduler.invalidate();
  };

  /**
   * 跑一个镜头：把【当前文档】发给 Agent 服务，把它改出来的操作搬回本地 Journal。
   *
   * ★ 为什么要把当前文档一起发过去：服务端不持有文档状态。
   *   "文档以谁为准"因此永远只有一个答案（面板这份），
   *   也就不存在"服务端那份慢慢变旧"这种事。
   *
   * ★ 为什么回传的是【操作】而不是让面板直接换文档：
   *   直接换 doc 会绕过这条唯一的写路径 —— 撤销、版本号、Journal 三样一起失真。
   *   搬操作进来则是：文档照旧由本地 Journal 推进，只是这些写入的来源是 Agent。
   *   搬运本身是受控的（见 journal.appendEmbedded 的注释）。
   */
  /**
   * 多轮对话的背景：最近几轮"要它做什么 + 结果如何 + 之后有哪些对象"。
   *
   * ★ 只留摘要，不留原始消息历史：完整历史里有工具协议与图片，界面侧拼不完整，
   *   会让请求直接失败；而且每轮重发全部回执，token 会成倍涨。
   */
  const chatHistory: string[] = [];

  /**
   * 当前推理档位（页面上那个下拉框的值）。
   *
   * ★ 它是【运行时开关】，不是文档字段 —— 所以它【不进 Journal】：
   *   换一档不该在撤销栈里留下一条记录，也不该让 docVersion 前进。
   * ★ 类型是 string 而不是那四个字面量的联合：白名单由服务端给（见 /api/health），
   *   面板不抄第二份 —— 抄了就会「服务端加一档、页面少一个选项」而没人发现。
   */
  let reasoning = 'high';
  let reasoningOptions: readonly string[] = [];

  /**
   * 「整片」模式：一句话 → 导演分镜 → 逐镜生成（服务端的 /api/film）。
   *
   * ★ 为什么要有两种模式而不是一种：这两件事的成本差一个数量级 ——
   *   单镜聊天是「改一下这条曲线」（几秒、几千 token），
   *   整片是「生成一条关于 agent 的科普视频」（导演 + 每镜一个 Agent，几分钟）。
   *   把它们混成一个按钮，用户永远不知道自己按下去的是一次小改还是一次整片。
   */
  let filmMode = false;

  const runAgent = async (task: string): Promise<void> => {
    const endpoint = deps.chatEndpoint;    if (endpoint === undefined) {
      chat.add({ role: 'error', text: '这个页面上没有配置 Agent 服务地址，聊天不可用。' });
      return;
    }
    if (chat.isBusy()) return;

    const before = new Set(Object.keys(doc.objects));
    chat.add({ role: 'user', text: task });
    chat.setBusy(true, 'Agent 正在工作…（读文档 / 改文档 / 可能渲染几帧）');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          doc: journal.currentDoc(),
          baseVersion: journal.currentVersion(),
          // ★ 多轮：把最近几轮的"做了什么"当背景带过去，这样"再亮一点"这类
          //   指代才有上下文。带的是【摘要】而不是完整消息历史 —— 后者含工具协议
          //   与图片，拼不完整会让请求直接失败（见 runtime 的 history 注释）。
          history: chatHistory.slice(-PROJECT_HISTORY_CAP),
          // ★ 每一轮都带上当前档位：服务端配的只是页面初值，用户改过就以页面为准。
          reasoning,
        }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        entries?: Parameters<typeof journal.appendEmbedded>[0];
        compoundId?: string;
        doc?: SceneDoc;
        chat?: { events?: { turn: number; name?: string; text: string; role?: string }[]; finalMessage?: string };
        issues?: { code: string; message: string; severity: string }[];
        usage?: TokenUsageView;
        turns?: number;
        truncated?: boolean;
        agentOperations?: number;
      };

      if (res.status !== 200 || payload.ok !== true) {
        chat.add({ role: 'error', text: 'Agent 调用失败：' + (payload.error ?? 'HTTP ' + res.status) });
        return;
      }

      for (const ev of payload.chat?.events ?? []) {
        chat.add({
          role: ev.role === 'user' ? 'user' : 'tool',
          text: ev.text,
          ...(ev.name === undefined ? {} : { name: ev.name }),
          turn: ev.turn,
        });
      }

      const entries = payload.entries ?? [];
      const newDoc = payload.doc;
      if (newDoc === undefined) {
        chat.add({ role: 'error', text: 'Agent 没有回传文档，无法应用。' });
        return;
      }
      if (entries.length > 0) {
        // 只搬 Agent 自己写的那些：审批补偿与引擎自动修的效果已经包含在 newDoc 里，
        // 不需要（也不该）在浏览器里再演一遍。
        journal.appendEmbedded(entries, newDoc, {
          actor: 'agent',
          compoundId: payload.compoundId ?? 'c:agent:chat',
        });
      } else {
        // 一次写入都没有：文档本来就不该变，但把服务端那份登记为快照，
        // 免得后续版本的快照缺失（revert 需要它）。
        journal.registerSnapshot(newDoc);
      }
      doc = journal.currentDoc();

      const created = Object.keys(doc.objects).find((id) => !before.has(id));
      if (created !== undefined) selected = created;
      refreshPanels();

      // ★ 三类分开报（输入 / 输出 / 图片）—— 只给一个总数时，
      //   「模型基本没看画面」这件事在界面上完全看不出来（§0.28 作业 2 的验收）。
      const totals = payload.usage ?? { promptTokens: 0, completionTokens: 0 };
      const writes = payload.agentOperations ?? 0;
      chat.add({
        role: 'note',
        text:
          '本轮：' + String(payload.turns ?? 0) + ' 轮 · Agent 写入 ' + String(writes) +
          ' 条 · ' + formatUsage(totals) +
          (payload.truncated === true ? ' · ⚠ 被轮数上限截断' : ''),
      });
      /**
       * ★ 一条写入都没落地时【必须说出来】。
       *
       *   实测：用户说「删除当前内容，从零开始生成一条视频」，那一轮模型猜命令名、
       *   删错东西、Runtime 按兜底规则收尾 —— 而聊天里只有一行「Agent 写入 0 条」，
       *   读起来像「跑完了」。零写入 = 你要的东西一个字都没落地，这句话必须显眼。
       *   顺带给一句可执行的下文：这类失败几乎都是「任务太大」而不是「模型不行」。
       */
      if (writes === 0) {
        chat.add({
          role: 'error',
          text:
            '⚠ 文档没有任何变化（写入 0 条）：这一轮没有东西落地。' +
            '通常是因为要求太大或太模糊 —— 拆成小步（一次只做一件事）再试。',
        });
      }
      /**
       * ★ 把模型最后那句话显示出来。
       *
       *   它是"模型为什么停手"的唯一证据，而在此之前它被丢掉了（服务端记了、
       *   界面不显示）。实测代价：一轮 0 写入时聊天里只有工具名，
       *   看不出模型是"觉得做完了"、"不知道改哪个"、还是"被拒后放弃了"。
       *   Runtime 自己的收尾语（以"（Runtime"开头）由上面那行统计就够了，不重复。
       */
      const said = (payload.chat?.finalMessage ?? '').trim();
      if (said !== '' && !said.startsWith('（Runtime')) {
        chat.add({ role: 'note', text: '模型最后说：' + said });
      }
      // 记进多轮背景：写清"要它做什么 + 结果如何 + 现在有哪些对象"。
      // 对象清单是关键 —— 有了它，下一轮说"那条曲线"才有指代对象。
      const ids = Object.keys(doc.objects);
      chatHistory.push(
        '用户说「' + task + '」。结果：' + String(payload.agentOperations ?? 0) + ' 次写入' +
          (payload.truncated === true ? '（被轮数上限截断，可能没做完）' : '') +
          '。之后文档里的对象：' + (ids.length === 0 ? '（无）' : ids.join('、')) + '。',
      );
      if (chatHistory.length > PROJECT_HISTORY_CAP) {
        chatHistory.splice(0, chatHistory.length - PROJECT_HISTORY_CAP);
      }
      for (const issue of payload.issues ?? []) {
        chat.add({ role: issue.severity === 'error' ? 'error' : 'note', text: '[' + issue.code + '] ' + issue.message });
      }
    } catch (err) {
      chat.add({ role: 'error', text: '网络或服务异常：' + (err instanceof Error ? err.message : String(err)) });
    } finally {
      chat.setBusy(false);
      // ★ 上下文（chatHistory + 聊天里那些行）也属于工程的一部分，跑完一轮就存一次
      autosave();
    }
  };

  // 预览点击 → 命中测试 → 选中
  canvas.addEventListener('pointerdown', (ev) => {
    if (ctx === null) return;
    const rect = canvas.getBoundingClientRect();
    const k = rect.width <= 0 ? 1 : viewportSize().w / rect.width;
    const px = (ev.clientX - rect.left) * k;
    const py = (ev.clientY - rect.top) * k;
    const hit = hitTest(evaluate(doc, t), px, py);
    if (hit !== null) {
      selected = hit.id;
      refreshPanels();
    }
  });

  window.addEventListener('resize', () => {
    fitPreview();
    scheduler.invalidate();
  });

  /**
   * 导出 MP4。
   *
   * 渲染 + 编码在服务端跑（几十秒起），所以这里是【提交作业 + 轮询进度】，
   * 不是一次等到底的请求。进度来自服务端真实的帧计数 —— 界面上那个百分比
   * 不是假动画，它是"已经渲完了多少帧"。
   */
  let exporting = false;
  const startExport = async (): Promise<void> => {
    if (exporting) return;
    if (deps.exportEndpoint === undefined) {
      chat.add({ role: 'error', text: '这个页面上没有配置导出服务，导出不可用。' });
      return;
    }
    exporting = true;
    exportBtn.disabled = true;
    exportStat.textContent = '提交导出…';
    try {
      const res = await fetch(deps.exportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc: journal.currentDoc(),
          backend: (exportBackend as HTMLSelectElement).value,
        }),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        job?: { id: string; totalFrames: number; width: number; height: number; fps: number };
      };
      if (res.status !== 202 || payload.ok !== true || payload.job === undefined) {
        exportStat.textContent = '';
        chat.add({ role: 'error', text: '导出失败：' + (payload.error ?? 'HTTP ' + res.status) });
        return;
      }
      const id = payload.job.id;
      const total = payload.job.totalFrames;
      chat.add({
        role: 'note',
        text: '导出已开始：' + payload.job.width + '×' + payload.job.height + ' · ' + total + ' 帧 · ' + payload.job.fps + 'fps（作业 ' + id + '）',
      });

      // 轮询：拿到真实进度，直到 done / failed
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const poll = await fetch(deps.exportEndpoint + '/' + id);
        const body = (await poll.json()) as {
          ok?: boolean;
          job?: {
            state: string;
            framesDone: number;
            totalFrames: number;
            bytes?: number;
            error?: string;
            encodeMode?: string;
            verified?: { nbFrames: number; duration: number; fps: number };
          };
        };
        const job = body.job;
        if (job === undefined) {
          exportStat.textContent = '';
          chat.add({ role: 'error', text: '导出作业丢了（服务重启过？）' });
          return;
        }
        if (job.state === 'rendering') {
          exportStat.textContent = '渲染 ' + job.framesDone + '/' + job.totalFrames;
        } else if (job.state === 'encoding') {
          exportStat.textContent = '编码中…';
        } else if (job.state === 'done') {
          exportStat.textContent = '已导出 ' + Math.round((job.bytes ?? 0) / 1024) + ' KB';
          const v = job.verified;
          chat.add({
            role: 'note',
            text:
              '导出完成：' + Math.round((job.bytes ?? 0) / 1024) + ' KB' +
              ' · 编码方式 ' + String(job.encodeMode ?? '?') +
              (v === undefined
                ? ''
                : ' · ffprobe 回读 ' + v.nbFrames + ' 帧 / ' + v.duration.toFixed(2) + 's / ' + v.fps.toFixed(2) + 'fps'),
          });
          // 直接下载：用户点一次就该拿到文件，而不是再教他去哪个目录找
          window.location.href = deps.exportEndpoint + '/' + id + '/download';
          return;
        } else if (job.state === 'failed') {
          exportStat.textContent = '导出失败';
          chat.add({ role: 'error', text: '导出失败：' + String(job.error ?? '未知原因').slice(0, 400) });
          return;
        }
      }
    } catch (err) {
      exportStat.textContent = '';
      chat.add({ role: 'error', text: '导出异常：' + (err instanceof Error ? err.message : String(err)) });
    } finally {
      exporting = false;
      exportBtn.disabled = false;
    }
  };
  exportBtn.addEventListener('click', () => void startExport());

  // ── 工具函数 ────────────────────────────────────────────────────
  /** 小按钮。面板里到处要按一下，统一在这里，省得每处都写 addEventListener。 */
  const btn = (label: string, onClick: () => void, title?: string): HTMLElement => {
    const b = h('button', { class: 'btn mini', type: 'button' }, label);
    if (title !== undefined) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  /**
   * 面板侧的图像预算。
   *
   * 界面自己【不渲染图片】（预览是直接在画布上画的，不占 L1/L2 额度），
   * 所以这里恒为满额。传给 applyCommands 只是为了让回执结构保持完整 ——
   * 真正记账的是 Agent 服务端那个 BudgetTracker。
   */
  const BUDGET = (): { imagesUsed: number; imagesLeft: number; renderCallsLeft: number } => ({
    imagesUsed: 0,
    imagesLeft: 6,
    renderCallsLeft: 3,
  });

  /* ── 整片：起作业 → 轮询 → 把结果搬进 Journal ────────────────
   *
   * ★ 为什么是「起作业 + 轮询」而不是一个普通请求：整片是**几十秒到几分钟**的事。
   *   一个挂着不动的 POST 既看不到进度（用户不知道它在跑还是卡死了），
   *   也容易被中途的超时掐断。导出那条路（/api/export）早就是这个形状了，这里照抄。
   *
   * ★ 进度事件一条条贴进聊天窗口 —— 这是这个功能唯一的可见性来源：
   *   「导演正在分镜…」→「分镜《…》：1. 什么是 Agent（5s）· …」→
   *   「第 2/4 镜 · 隐喻：开始」→ 每镜的写入条数与版本变化。
   */
  const filmEndpoint = deps.chatEndpoint?.replace(/\/[^/]*$/, '/film');

  const runFilmBrief = async (brief: string): Promise<void> => {
    // entries 的类型由 Journal 自己决定（面板不重复声明一份补丁形状）
    type FilmEntries = Parameters<typeof journal.appendEmbedded>[0];
    type FilmSnapshot = Omit<FilmProgress, 'doc'> & {
      readonly doc?: SceneDoc;
      readonly entries?: FilmEntries;
    };
    const endpoint = filmEndpoint;
    if (endpoint === undefined) {
      chat.add({ role: 'error', text: '这个页面上没有配置 Agent 服务地址，整片流程不可用。' });
      return;
    }
    if (chat.isBusy()) return;

    chat.add({ role: 'user', text: '整片：' + brief });
    chat.setBusy(true, '整片生成中…（导演分镜 → 逐镜生成，可能要一两分钟）');
    try {
      const start = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, doc: journal.currentDoc(), reasoning }),
      });
      const head = (await start.json()) as { ok?: boolean; filmId?: string; error?: string };
      if (head.ok !== true || typeof head.filmId !== 'string') {
        chat.add({ role: 'error', text: '整片起不来：' + (head.error ?? 'HTTP ' + start.status) });
        return;
      }

      const pollUrl = endpoint + '/' + head.filmId;
      let seen = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 900));
        const res = await fetch(pollUrl, { cache: 'no-store' });
        const payload = (await res.json()) as { ok?: boolean; error?: string; film?: FilmSnapshot };
        const film = payload.film;
        if (film === undefined) {
          chat.add({ role: 'error', text: '整片进度读不到：' + (payload.error ?? 'HTTP ' + res.status) });
          return;
        }
        for (const ev of film.events.slice(seen)) {
          chat.add({
            role: ev.kind === 'error' ? 'error' : ev.kind === 'tool' ? 'tool' : 'note',
            text: ev.text,
            ...(ev.name === undefined ? {} : { name: ev.name }),
            ...(ev.turn === undefined ? {} : { turn: ev.turn }),
          });
        }
        seen = film.events.length;

        if (film.state === 'failed') {
          chat.add({ role: 'error', text: '整片失败：' + (film.error ?? '未知原因') });
          return;
        }
        if (film.state === 'done') {
          const entries = film.entries ?? [];
          const newDoc = film.doc;
          if (newDoc === undefined) {
            chat.add({ role: 'error', text: '整片没有回传文档，无法应用。' });
            return;
          }
          if (entries.length > 0) {
            journal.appendEmbedded(entries, newDoc, {
              actor: 'agent',
              compoundId: 'c:agent:film:' + head.filmId,
            });
          } else {
            journal.registerSnapshot(newDoc);
          }
          doc = journal.currentDoc();
          refreshPanels();
          const usage = film.usage ?? { promptTokens: 0, completionTokens: 0 };
          chat.add({
            role: 'note',
            text:
              '整片完成：《' + (film.title ?? '') + '》' + String(film.shotsDone) + ' 镜 · 写入 ' +
              String(entries.length) + ' 条 · ' + formatUsage(usage) +
              (film.endVersion === undefined ? '' : ' · 版本 → ' + String(film.endVersion)),
          });
          if (entries.length === 0) {
            chat.add({ role: 'error', text: '⚠ 整片跑完了但一条写入都没有落地 —— 检查一下服务端日志。' });
          }
          autosave();
          return;
        }
      }
    } catch (err) {
      chat.add({ role: 'error', text: '整片出错：' + (err instanceof Error ? err.message : String(err)) });
    } finally {
      chat.setBusy(false);
    }
  };
  // ── 聊天窗口 ────────────────────────────────────────────────────
  const chatHost: ChatHost = {
    busyLabel: 'Agent 正在工作…',
    // ★ 同一个输入框，两种跑法：整片模式走导演流程（成本高得多，所以要显式选）
    onSubmit: (task) => void (filmMode ? runFilmBrief(task) : runAgent(task)),
  };
  const chat = createChatView(chatHost);
  chatAside.append(chat.root);

  /* ── 推理等级（页面上可调的那个下拉框） ──────────────────────
   *
   * ★ 为什么要有它：档位以前只能靠命令行启动参数定，想换个档就得重起服务 ——
   *   而「模型到底想不想」恰恰是调 Agent 时最常动的一根旋钮（§0.23）。
   *   现在它随【每一次请求】发过去（/api/chat 的 reasoning 字段），改一下立刻对下一轮生效。
   *
   * ★ 选项表与初值都来自服务端（GET /api/health 的 reasoningOptions / reasoning）：
   *   面板不抄第二份白名单 —— 抄了就会「服务端加一档、页面少一个选项」而没人发现；
   *   也正因为初值来自服务端，用 `--reasoning off` 起的服务不会被页面的默认值悄悄盖掉。
   *
   * ★ 读不到 health 时【不猜】：把下拉框禁用并说明原因。
   *   猜一个默认值会让界面显示 high、实际跑 off —— 又是「看起来正常」。
   */
  const REASON_LABEL: Readonly<Record<string, string>> = {
    off: '不思考（最快最省，容易挑错字段）',
    low: '想得少',
    high: '默认（约 3.7× 输出 token、2.5× 时间）',
    max: '最强（更慢更贵，难题才用）',
  };
  const reasonSelect = h('select', { class: 'reason-select', id: 'reasonselect' });
  const reasonHint = h('span', { class: 'reason-hint', id: 'reasonhint' }, '正在读取服务端的档位…');
  /**
   * 整片模式开关。
   *
   * ★ 默认【关】：整片的成本是单镜的几十倍（导演 + 每镜一个 Agent），
   *   而面板里绝大多数操作是「改一下这条曲线」。要整片就显式打勾。
   * ★ 打勾后同一个输入框换了含义，所以标签写在勾选框右边、按钮上也跟着变。
   */
  const filmBox = h('input', { class: 'film-box', id: 'filmmode', type: 'checkbox' });
  const filmLabel = h('label', { class: 'film-label', for: 'filmmode' }, '整片（导演分镜 → 逐镜生成）');
  const reasonRow = h(
    'div',
    { class: 'chat-reason', id: 'chatreason' },
    h('span', { class: 'reason-label' }, '推理等级'),
    reasonSelect,
    reasonHint,
    h('span', { class: 'reason-sep' }),
    filmBox,
    filmLabel,
  );
  // 放在最上面：它是「这一轮模型怎么想」的总开关，不该埋在要滚动的聊天记录下面
  chat.root.prepend(reasonRow);

  /* ── API 设置（作业 3）────────────────────────────────────────
   *
   * ★ 为什么要有它：在此之前 key 只能来自环境变量或 .env.local、model 只能来自
   *   --model、baseURL 写死在服务端代码里 —— 页面上一个都改不了，
   *   想换一个中转地址就得改代码重启。
   *
   * ★★ 三条约束（都是服务端定的，页面只复述）：
   *   1. key 【只在服务端内存里】：这个输入框永远是空的，填了也只发给服务端；
   *      它不会被写进工程文件、不会被写进 localStorage（刷新页面要重填 key 是刻意的）；
   *   2. baseURL 只允许白名单（服务端拒了就原样报出来）；
   *   3. 服务端只回掩码，页面【永远拿不到 key 原文】。
   *
   * ★ 默认折起来：绝大多数时间用不到，而它一展开就占掉聊天窗口的地方。
   */
  let apiSettings: ApiSettingsView = { baseUrl: '', model: '', hasKey: false, keyMask: '', allowedHosts: [] };
  const apiUrlInput = h('input', { class: 'api-input', id: 'apiurl', type: 'text', spellcheck: 'false', placeholder: 'https://api.deepseek.com/beta/chat/completions' });
  const apiModelInput = h('input', { class: 'api-input', id: 'apimodel', type: 'text', spellcheck: 'false', placeholder: 'deepseek-chat' });
  const apiKeyInput = h('input', { class: 'api-input', id: 'apikey', type: 'password', spellcheck: 'false', autocomplete: 'off' });
  const apiStatus = h('span', { class: 'api-status', id: 'apistatus' }, '正在读取服务端的设置…');
  const apiSaveBtn = h('button', { class: 'api-btn', id: 'apisave', type: 'button' }, '保存');
  const apiTestBtn = h('button', { class: 'api-btn', id: 'apitest', type: 'button' }, '测试连接');
  const apiClearKeyBtn = h('button', { class: 'api-btn danger', id: 'apiclearkey', type: 'button' }, '清除 key');
  const apiAllowed = h('span', { class: 'api-hint', id: 'apiallowed' }, '');
  const apiRow = h(
    'details',
    { class: 'api-settings', id: 'apiset' },
    h('summary', {}, 'API 设置'),
    h(
      'div',
      { class: 'api-grid' },
      h('label', { class: 'api-label', for: 'apiurl' }, 'baseURL'),
      apiUrlInput,
      h('label', { class: 'api-label', for: 'apimodel' }, 'model'),
      apiModelInput,
      h('label', { class: 'api-label', for: 'apikey' }, 'API key'),
      apiKeyInput,
    ),
    h('div', { class: 'api-actions' }, apiSaveBtn, apiTestBtn, apiClearKeyBtn),
    apiStatus,
    apiAllowed,
  );
  chat.root.prepend(apiRow);

  const renderApiSettings = (): void => {
    apiUrlInput.value = apiSettings.baseUrl;
    apiModelInput.value = apiSettings.model;
    // ★ key 永远不回显，只把掩码写在 placeholder 里
    apiKeyInput.value = '';
    apiKeyInput.setAttribute('placeholder', keyPlaceholder(apiSettings));
    apiAllowed.textContent =
      apiSettings.allowedHosts.length === 0
        ? ''
        : 'baseURL 只允许：' + apiSettings.allowedHosts.join(' / ') + ' / 本机地址';
  };

  const renderApiStatus = (text: string, bad: boolean): void => {
    apiStatus.textContent = text;
    apiStatus.classList.toggle('bad', bad);
  };

  const settingsEndpoint = deps.chatEndpoint?.replace(/\/[^/]*$/, '/settings');
  const postSettings = async (path: string, body: unknown): Promise<{ ok: boolean; payload: Record<string, unknown> }> => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, payload: (await res.json()) as Record<string, unknown> };
  };

  if (settingsEndpoint !== undefined) {
    void (async (): Promise<void> => {
      try {
        const res = await fetch(settingsEndpoint, { cache: 'no-store' });
        const payload = (await res.json()) as { settings?: ApiSettingsView };
        if (payload.settings !== undefined) {
          apiSettings = payload.settings;
          renderApiSettings();
          renderApiStatus('设置来自服务端（key 只在服务端内存里，刷新页面不会丢、重启服务会丢）', false);
        }
      } catch {
        renderApiStatus('读不到服务端设置（' + settingsEndpoint + '）—— 改这里不会生效，请检查服务是否在跑。', true);
      }
    })();
  } else {
    renderApiStatus('这个页面上没有配置 Agent 服务地址，API 设置不可用。', true);
  }

  apiSaveBtn.addEventListener('click', () => {
    if (settingsEndpoint === undefined) return;
    const patch = settingsPatchFrom(
      { baseUrl: apiUrlInput.value, model: apiModelInput.value, apiKey: apiKeyInput.value },
      apiSettings,
    );
    if (Object.keys(patch).length === 0) {
      renderApiStatus('没有改动，什么都没发。', false);
      return;
    }
    void (async (): Promise<void> => {
      try {
        const { ok, payload } = await postSettings(settingsEndpoint, patch);
        if (!ok) {
          const errors = Array.isArray(payload['errors']) ? (payload['errors'] as string[]) : [String(payload['error'] ?? '未知原因')];
          // ★ 说清每一条原因 —— 静默的"部分成功"是设置类功能最坏的行为
          renderApiStatus('没保存：' + errors.join('；'), true);
          return;
        }
        if (payload['settings'] !== undefined) apiSettings = payload['settings'] as ApiSettingsView;
        renderApiSettings();
        const changed = Array.isArray(payload['changed']) ? (payload['changed'] as string[]).join(' / ') : '';
        renderApiStatus('已保存：' + changed + '（下一轮请求就会用新的）', false);
      } catch (err) {
        renderApiStatus('保存失败：' + (err instanceof Error ? err.message : String(err)), true);
      }
    })();
  });

  apiTestBtn.addEventListener('click', () => {
    if (settingsEndpoint === undefined) return;
    renderApiStatus('正在测试…', false);
    void (async (): Promise<void> => {
      try {
        // ★ 用【输入框里的值】测，不必先保存 —— 先试再存才是正常的顺序
        const { payload } = await postSettings(settingsEndpoint + '/test', {
          baseUrl: apiUrlInput.value,
          model: apiModelInput.value,
          apiKey: apiKeyInput.value,
        });
        const result = payload['result'] as ProbeResultView | undefined;
        renderApiStatus(result === undefined ? '测试没有返回结果' : probeMessage(result), result?.ok !== true);
      } catch (err) {
        renderApiStatus('测试失败：' + (err instanceof Error ? err.message : String(err)), true);
      }
    })();
  });

  apiClearKeyBtn.addEventListener('click', () => {
    if (settingsEndpoint === undefined) return;
    void (async (): Promise<void> => {
      try {
        const { ok, payload } = await postSettings(settingsEndpoint, { apiKey: '' });
        if (!ok) {
          renderApiStatus('没清掉：' + String(payload['error'] ?? '未知原因'), true);
          return;
        }
        if (payload['settings'] !== undefined) apiSettings = payload['settings'] as ApiSettingsView;
        renderApiSettings();
        renderApiStatus('已清除服务端内存里的 key。', false);
      } catch (err) {
        renderApiStatus('清除失败：' + (err instanceof Error ? err.message : String(err)), true);
      }
    })();
  });

  const renderReasonRow = (): void => {
    clear(reasonSelect);
    for (const level of reasoningOptions) {
      const opt = h('option', { value: level }, level);
      if (level === reasoning) opt.setAttribute('selected', 'selected');
      reasonSelect.append(opt);
    }
    reasonSelect.value = reasoning;
    reasonSelect.disabled = reasoningOptions.length === 0;
    reasonHint.textContent = REASON_LABEL[reasoning] ?? '';
  };
  reasonSelect.addEventListener('change', () => {
    reasoning = reasonSelect.value;
    renderReasonRow();
  });
  filmBox.addEventListener('change', () => {
    filmMode = filmBox.checked;
    chat.setSendLabel(filmMode ? '生成整片' : '发送');
  });
  renderReasonRow();

  /**
   * 问一次服务端：档位表 + 它配的初值。
   *
   * health 的地址由 chat 端点推导（/api/chat → /api/health）：两者本来就同源同前缀，
   * 多一个配置项只会多一处可以配错的地方。
   */
  const healthEndpoint = deps.chatEndpoint?.replace(/\/[^/]*$/, '/health');
  if (healthEndpoint !== undefined) {
    void (async (): Promise<void> => {
      try {
        const res = await fetch(healthEndpoint, { cache: 'no-store' });
        const payload = (await res.json()) as { reasoning?: unknown; reasoningOptions?: unknown };
        const options = Array.isArray(payload.reasoningOptions)
          ? payload.reasoningOptions.filter((v): v is string => typeof v === 'string')
          : [];
        reasoningOptions = options;
        if (typeof payload.reasoning === 'string' && options.includes(payload.reasoning)) {
          reasoning = payload.reasoning;
        } else if (options.length > 0) {
          reasoning = options[0] as string;
        }
      } catch {
        reasonHint.textContent = '读不到服务端的档位表（' + healthEndpoint + '）—— 换一档不会生效，请检查服务是否在跑。';
      }
      renderReasonRow();
    })();
  }

  /* ── 工程：保存 / 打开 / 自动存档 ────────────────────────────
   *
   * ★ 存的是什么：文档 + **上下文**（聊天历史、聊天里看得见的行、推理档位、整片模式）。
   *   只存文档的话，打开之后 Agent 对你的项目一无所知 —— 「接着上次干活」这句话就不成立。
   *
   * ★ 打开 = 换一份工程，不是一次编辑：新的 Journal（撤销栈从零开始）、
   *   新的提案存储（旧的提案属于上一份文档）、聊天记录换成工程里的那些。
   *   这一点会明说给用户（「撤销栈已重置」），因为「以为还能撤销」是很贵的误会。
   *
   * ★ 自动存档存在 localStorage：刷新页面不该丢掉工作。它是【尽力而为】——
   *   配额爆了或被隐私模式禁了就安静地放弃，绝不因此打断编辑。
   *   所以恢复是【显式】的（顶栏「恢复上次」），不搞「打开就自动盖掉」。
   */
  const AUTOSAVE_KEY = 'sva-project-autosave';
  const CHAT_ROLES: ReadonlySet<string> = new Set<ChatRole>(['user', 'tool', 'note', 'error']);
  let autosaveTimer: number | null = null;

  const currentContext = (): ProjectContext => ({
    chatHistory: [...chatHistory],
    chat: chat.lines().map((l): ProjectChatLine => ({
      role: l.role,
      text: l.text,
      ...(l.name === undefined ? {} : { name: l.name }),
      ...(l.turn === undefined ? {} : { turn: l.turn }),
    })),
    reasoning,
    filmMode,
  });

  const buildCurrentProject = (): ProjectFile => buildProject({ doc, context: currentContext() });

  /** 工程 JSON（保存按钮与自动化断言走的是同一条路）。 */
  const projectJson = (): string => projectToJson(buildCurrentProject());

  const autosave = (): void => {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = null;
      try {
        localStorage.setItem(AUTOSAVE_KEY, projectJson());
      } catch {
        // 配额满 / 隐私模式：自动存档是尽力而为，不要因此打断编辑
      }
    }, 900);
  };

  const downloadProject = (): void => {
    const project = buildCurrentProject();
    const name = projectFilename(project);
    const url = URL.createObjectURL(new Blob([projectToJson(project)], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    const objects = Object.keys(doc.objects).length;
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    chat.add({
      role: 'note',
      text:
        '已保存工程：' + name + '（' + objects + ' 个对象 · ' +
        String(currentContext().chatHistory.length) + ' 条上下文）',
    });
    autosave();
  };

  /** 把一份工程装进面板（打开 / 恢复上次都走它）。 */
  const applyProject = (project: ProjectFile, from: string): void => {
    // ★ 换 Journal：打开的是一份【新工程】，旧历史与新文档没有共同的版本基准
    journal = createJournal(project.doc, { now: deps.now });
    proposals = makeProposals();
    doc = journal.currentDoc();
    chatHistory.length = 0;
    chatHistory.push(...project.context.chatHistory);
    reasoning = reasoningOptions.includes(project.context.reasoning)
      ? project.context.reasoning
      : (reasoningOptions[0] ?? reasoning);
    filmMode = project.context.filmMode;
    filmBox.checked = filmMode;
    chat.setSendLabel(filmMode ? '生成整片' : '发送');
    selected = Object.keys(doc.objects)[0] ?? null;
    t = 0;
    const lines = project.context.chat
      .filter((l) => CHAT_ROLES.has(l.role))
      .map((l) => ({
        role: l.role as ChatRole,
        text: l.text,
        ...(l.name === undefined ? {} : { name: l.name }),
        ...(l.turn === undefined ? {} : { turn: l.turn }),
      }));
    chat.reset(lines);
    refreshPanels();
    renderReasonRow();
    chat.add({
      role: 'note',
      text:
        '已' + from + '工程：' + Object.keys(doc.objects).length + ' 个对象 · ' +
        doc.scenes.length + ' 镜 · ' + project.context.chat.length + ' 行聊天记录' +
        '（撤销栈已重置 —— 这是一份新工程，不是一次编辑）',
    });
    autosave();
  };

  /** 解析并载入一段工程 JSON。失败时如实说清哪一步不对。 */
  const loadProjectText = (text: string, from = '打开'): { readonly ok: boolean; readonly error?: string } => {
    const parsed = parseProject(text);
    if (!parsed.ok) {
      chat.add({ role: 'error', text: from + '工程失败：' + parsed.error });
      return { ok: false, error: parsed.error };
    }
    for (const w of parsed.warnings) chat.add({ role: 'note', text: '⚠ ' + w });
    applyProject(parsed.project, from);
    return { ok: true };
  };

  const readAutosave = (): string | null => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY);
    } catch {
      return null;
    }
  };

  saveProjBtn.addEventListener('click', downloadProject);
  openProjBtn.addEventListener('click', () => projFile.click());
  projFile.addEventListener('change', () => {
    const file = projFile.files?.[0];
    if (file === undefined) return;
    void file
      .text()
      .then((text) => {
        loadProjectText(text, '打开');
      })
      .catch((err: unknown) => {
        chat.add({ role: 'error', text: '读文件失败：' + (err instanceof Error ? err.message : String(err)) });
      })
      .finally(() => {
        // 同一份文件再选一次也要能触发 change
        projFile.value = '';
      });
  });
  restoreBtn.addEventListener('click', () => {
    const snapshot = readAutosave();
    if (snapshot === null) {
      chat.add({ role: 'error', text: '浏览器里没有自动存档。' });
      return;
    }
    loadProjectText(snapshot, '恢复上次');
  });

  /**
   * 开机时：有自动存档就把「恢复上次」点亮，并准备一句提示。
   *
   * ★ 提示【不能在这里 add】：createPanel 末尾的 `resetChatHint()` 会 `chat.reset(...)`，
   *   把这一行连同向导语一起清掉（实机校验抓到的：刷新后存档提示不见了，
   *   而按钮还是亮的 —— 看起来像「有存档但没人告诉我」）。所以只准备文案，
   *   等 resetChatHint 之后再贴。
   */
  let bootHint: string | null = null;
  const bootSnapshot = readAutosave();
  if (bootSnapshot !== null) {
    const parsed = parseProject(bootSnapshot);
    if (parsed.ok) {
      const when = new Date(parsed.project.savedAt);
      const objects = Object.keys(parsed.project.doc.objects).length;
      restoreBtn.removeAttribute('disabled');
      restoreBtn.title = '恢复到上次自动存档：' + when.toLocaleString() + '（' + objects + ' 个对象）';
      bootHint =
        '浏览器里有上次的自动存档（' + when.toLocaleString() + '，' + objects + ' 个对象）。' +
        '顶栏的「恢复上次」可以载入它。';
    }
  }
  /** 把聊天区初始化为"向导"状态：没有对象时告诉用户怎么开始。 */
  const resetChatHint = (): void => {
    const count = Object.keys(doc.objects).length;
    chat.reset([
      {
        role: 'note',
        text:
          count === 0
            ? '这一镜还是空的。可以用下面的快捷入口让 Agent 从零画，也可以点左上角「＋ 曲线」自己建一条。'
            : '当前有 ' + count + ' 个对象。直接说要改什么，Agent 会在现有文档上动手。',
      },
    ]);
  };

  fitPreview();
  refreshPanels();
  resetChatHint();
  // ★ 必须在 resetChatHint 之后：它会把聊天区整块换成向导语（见 bootHint 的注释）
  if (bootHint !== null) chat.add({ role: 'note', text: bootHint });
  // 首帧之后布局才稳定，再适配一次
  requestAnimationFrame(() => {
    fitPreview();
    scheduler.invalidate();
  });

  return {
    invalidate: () => scheduler.invalidate(),
    stats: () => scheduler.stats(),
    doc: () => doc,
    journal: () => journal,
    pendingCount: () => proposals.count(),
    /**
     * 播放控制。测试与自动化断言用：
     *   renderer().play(true) → 等一会儿 → renderer().frame() 应当前进
     * 这也是"动画到底动没动"在浏览器侧唯一的可编程探针。
     */
    renderer: () => ({
      play: (on: boolean) => setPlaying(on),
      isPlaying: () => playing,
      loop: (on: boolean) => {
        loop = on;
        updateTransport();
      },
      frame: () => frameOf(t),
      totalFrames,
      time: () => t,
      seek: (time: number) => {
        t = time;
        paintPreview();
      },
      seekFrame,
      /**
       * 当前画面的指纹（dataURL 长度 + 前 96 字符）。
       *
       * 它是"动画真的画出来了"在浏览器侧唯一的可编程证据：
       * 单看 frame() 只能说明时间在走，说明不了画面跟着变。
       */
      frameHash: () => {
        if (canvas.width === 0) return '';
        const url = canvas.toDataURL('image/png');
        return url.length + ':' + url.slice(url.length - 96);
      },
    }),
    chat: () => chat,
    reasoning: () => reasoning,
    projectJson: () => projectJson(),
    loadProject: (text) => loadProjectText(text),
    runAgent,
    exportMp4: startExport,
    snapshot: () => journal.currentDoc(),
    cameraKeyCount: () => doc.camera.keys.length,
    applyAgentCommand: (command, rationale) => {
      const withIntent: Command = { ...command, intent: rationale };
      /**
       * 这是"替 AI 提交一条命令"的模拟入口（实机校验的 prepare 阶段用它造提案）。
       * 仍然按 agent 记账，但**也是一次完整的手势** —— 不传 gestureId 的话
       * 它产生的 compound 会永远停在"进行中"，连它都撤不了。
       */
      const res = applyCommands(
        { baseVersion: journal.currentVersion(), commands: [withIntent] },
        {
          journal,
          budget: BUDGET,
          actor: 'agent',
          gestureId: 'agent-apply#' + (gestureSeq += 1),
          now: deps.now,
        },
      );
      for (const pr of res.proposals) proposals.submit(pr.proposal);
      if (res.ok.length > 0) doc = journal.currentDoc();
      refreshPanels();
    },
  };
}
