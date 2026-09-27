/**
 * 面板实机校验：打开一个已经在跑的面板地址，跑一组结构断言 + 让 Agent 真干一件事。
 *
 * 用法（先 pnpm --filter @sva/agent-tools build:cli）：
 *   node packages/agent-tools/dist/verify-panel.mjs "http://127.0.0.1:<port>/packages/panel/index.html?doc=/out/panel-demo.json"
 *
 * ★ 需要 danger-full-access：Chrome 在 Windows 上靠命名管道做 Mojo IPC，
 *   受限沙箱禁止命名管道（docs/environment.md 有实测证据）。
 *
 * 为什么要有它：把地址交给用户之前，先确认"页面能开、七个区都在、没有失败请求、
 * 播放真的推进帧号、聊天窗口真的能让 Agent 改到文档"。这几件事任何一件不成立，
 * 用户看到的都是一个坏页面。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshotUrl } from '@sva/engine-node/screenshot';

function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const url = process.argv[2];
if (url === undefined) {
  console.error('用法: node packages/agent-tools/dist/verify-panel.mjs <面板地址>');
  process.exit(1);
}

/**
 * 页面里跑的探针。
 *
 * ★ 写成【真正的函数】再用 toString() 注入，而不是拼接字符串：
 *   手拼嵌套 Promise 时括号错了一处，报错是 puppeteer 的
 *   "Unexpected end of input"，定位成本远高于这里多写几行。
 *   所有取值都容错（null → 0/false）：探针自己崩掉会把"页面坏了"
 *   和"探针写错了"混成同一个现象。
 */
function probeFn(): Promise<string> {
  const $ = (sel: string): Element | null => document.querySelector(sel);
  const count = (sel: string): number => document.querySelectorAll(sel).length;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const panel = (window as any).__PANEL__;
  const renderer = panel.renderer();
  renderer.seek(0);
  const f0 = renderer.frame();
  const h0 = renderer.frameHash();
  const v0 = panel.journal().currentVersion();
  const lines0 = count('#chat .msg');

  /**
   * ★ 按镜头过滤的证据：同一份文档，两个镜头各停一帧，画面必须不同。
   *
   *   演示文档里 plot#2 只属于第二镜 s#2 —— 第一镜看不到它。
   *   如果预览不过滤（改这一轮之前的状态），两张图会一模一样，
   *   而"预览与成片分叉"恰恰是这个项目最不能接受的那类失败。
   */
  const hashAt = (time: number): string => {
    renderer.seek(time);
    return renderer.frameHash();
  };
  const shot1Hashes = new Set([hashAt(1.0), hashAt(1.5), hashAt(2.0)]);
  const shot2Hashes = new Set([hashAt(5.5), hashAt(6.0), hashAt(6.5)]);
  const totalShots = count('#timeline .tl-shot');
  const shotLabels = [...document.querySelectorAll('#timeline .tl-shot')].map(
    (el) => (el as HTMLElement).textContent ?? '',
  );
  // ★ 标签必须在【停在那一镜的时刻】读：先 seek 到 1.0 读第一镜，再 seek 到 5.5 读第二镜。
  //   先前我按"先两个 hash、再读两次标签"的顺序写，读到的是同一个时刻 —— 探针自己的测量错了。
  hashAt(1.0);
  const tc1 = document.getElementById('tclabel')?.textContent ?? '';
  const scene1Hash = renderer.frameHash();
  hashAt(5.5);
  const tc2 = document.getElementById('tclabel')?.textContent ?? '';
  const scene2Hash = renderer.frameHash();

  /**
   * ★ 效果参数控件必须【真的能改文档】（§7 第 0 条）。
   *
   * 这一段是那次修复的实机验收：此前 `eff#*.params.*` 一律派发不出命令，
   * 于是"生长时长"这个输入框改了没反应、也不报错 —— 而它从 highlight 落地
   * 那天起就是坏的，四条 create 分支之外的所有效果参数一起坏，
   * 却没有任何一条检查覆盖它（单测也测不到：判定内联在渲染闭包里）。
   *
   * 走的是真控件、真事件：找到标签为"持续时长"的那一行，改 number 输入框
   * 并派发 change（与用户敲回车同一条路径）。
   */
  const effBefore = panel.snapshot().effects['eff#1'];
  const vBeforeEdit = panel.journal().currentVersion();
  const errBeforeEdit = count('#chat .msg-error');
  const durationRow = [...document.querySelectorAll('#inspector .row')].find(
    (r) => (r.querySelector('label')?.textContent ?? '') === '持续时长',
  );
  const durationInput = durationRow === undefined
    ? null
    : (durationRow.querySelector('input[type=number]') as HTMLInputElement | null);
  if (durationInput !== null) {
    durationInput.value = '3.5';
    durationInput.dispatchEvent(new Event('change'));
  }
  const effAfter = panel.snapshot().effects['eff#1'];
  const vAfterEdit = panel.journal().currentVersion();
  const errAfterEdit = count('#chat .msg-error');
  /**
   * ★ 断 Agent 有没有写东西，必须用【它开始之前】的版本号。
   *
   *   这里踩过一次：原来用的是整段探针一开始读的 `v0`，而上面那次"我正在改效果参数"
   *   已经把版本推前了一格 —— 于是"Agent 的写入落到了文档上"变成**永远通过**，
   *   哪怕 Agent 一轮就 400 失败。**判据的时间窗必须正好框住被测的那件事。**
   */
  const vBeforeAgent = panel.journal().currentVersion();

  // ★ 真的让 Agent 干一件事：这是"聊天窗口能命令 Agent"的端到端证据。
  //   走的就是聊天窗口那条路径（panel.runAgent → POST /api/chat）。
  return panel.runAgent('把曲线整体往上挪 1 个单位。').then(() => {
    // ★ 再真的导出一次：验证"导出按钮 → 服务端渲染编码 → 回读校验"整条链。
    //   用界面同一个入口（panel.exportMp4），不是另写一条测试专用路径。
    return panel.exportMp4().then(() => {
      /**
       * ★ 镜头管理 + "一次手势 = 一次可撤销的编辑"（P4 #14 与这次修的那个缺口）。
       *
       * 放在【导出之后】：加镜头会改片长与泳道，前面那些基于"两镜 / 8 秒"的断言
       * 必须读到未被扰动的那份文档。顺序在这里是有意义的，不是随手排的。
       */
      const jcards = (): Element[] => [...document.querySelectorAll('#journal .jcard')];
      const revertOf = (card: Element | undefined): HTMLButtonElement | null =>
        (card?.querySelector('.revert') as HTMLButtonElement | null) ?? null;
      const scenesNow = (): number => (panel.snapshot().scenes ?? []).length;
      const durationNow = (): number => panel.snapshot().meta.duration;
      const shotBlocks = (): number => count('#timeline .tl-shot');
      /**
       * ★ 每次点击前【重新取】按钮，不能复用上一次抓到的那批。
       *
       *   面板每次提交都会把整块控件重建一遍：旧的那批按钮虽然还在内存里
       *   （点它照样触发监听器，因为监听器连同旧闭包一起被捕获了），
       *   但它闭包里那个"当前这一镜"是**加镜头之前**算出来的 ——
       *   于是"改名"会改到前一镜身上，而检查看到的是一片没变的泳道。
       *   这就是上一次"改名"红的真实原因（探针自己写错了测量顺序）。
       */
      const toolBtns = (): HTMLButtonElement[] => [
        ...(document.getElementById('scenetools')?.querySelectorAll('button') ?? []),
      ] as HTMLButtonElement[];
      /** 导出那条聊天消息要在【加镜头之前】取：之后聊天里会多出"已加一镜"的说明。 */
      const exportChat = (document.querySelector('#chat .msg:last-child')?.textContent ?? '').slice(0, 120);

      // ① 用户刚刚"改效果参数"那次编辑，撤销按钮必须是【可用】的（这是这次修的缺口）
      const editCard = jcards().find((c) => (c.textContent ?? '').includes('set_effect'));
      const userEditRevertEnabled = revertOf(editCard)?.hasAttribute('disabled') === false;

      // ② 加一镜：泳道 3 条、片长 8 → 12（新镜落在旧片尾，不延长就是零长度）
      const scenesBefore = scenesNow();
      const durationBefore = durationNow();
      const sceneToolButtons = toolBtns().length;
      toolBtns()[0]?.click();
      const scenesAfterAdd = scenesNow();
      const durationAfterAdd = durationNow();
      const lanesAfterAdd = shotBlocks();

      // ③ 改名：改的是"当前这一镜"，时间轴上的名字要跟着变
      const nameInput = document.getElementById('scenename') as HTMLInputElement | null;
      if (nameInput !== null) nameInput.value = '第三镜 · 实测';
      toolBtns()[1]?.click();
      const renamedName = '第三镜 · 实测';
      const renamedInDoc = (panel.snapshot().scenes ?? []).some(
        (s: { name?: string }) => s.name === renamedName,
      );
      const renamedInLane = [...document.querySelectorAll('#timeline .tl-shot')].some((el) =>
        (el.textContent ?? '').includes(renamedName),
      );

      // ④ 撤销"加一镜"这一个手势：add_scene 与 set_meta 必须【一起】回去
      const addCard = jcards().find((c) => (c.textContent ?? '').includes('add_scene'));
      revertOf(addCard)?.click();
      const scenesAfterUndo = scenesNow();
      const durationAfterUndo = durationNow();
      const lanesAfterUndo = shotBlocks();

      /**
       * ★ 关键帧编辑（§7 第 4 条）：拖动改时刻 / 双击空白插入 / 双击手柄删除。
       *
       * 演示文档里 plot#1 的 tf.opacity 有两个关键帧（0s / 1.2s），
       * 另有一条 expr 轨道（style.width）—— 正好把"手柄行"与"只读行"两种都覆盖到。
       */
      const kfHandles = (): HTMLElement[] => [
        ...document.querySelectorAll('#kfstrip .kf-key'),
      ] as HTMLElement[];
      const opacityKeys = (): { t: number; v: unknown }[] => {
        const tr = ((panel.snapshot().objects['plot#1']?.anim ?? {}) as Record<string, { kind?: string; keys?: { t: number; v: unknown }[] }>)['tf.opacity'];
        return tr?.kind === 'keys' ? (tr.keys ?? []) : [];
      };
      const kfBefore = kfHandles().length;
      const exprRows = count('#kfstrip .kf-track.kf-expr');
      const tBefore = opacityKeys().map((k) => k.t);
      /**
       * ★ 每次用之前【重新取】节点：面板每提交一次就重建整块 DOM，
       *   开头抓到的那一个在拖动提交之后就已经脱离文档了（点它虽然还会触发旧闭包，
       *   但闭包里那条轨道是拖动【之前】的 —— 插入会被判成"同一帧已经有了"）。
       *   这一轮在探针里踩了三次同一件事，所以写成函数而不是变量。
       */
      const kfTrackEl = (): HTMLElement | null =>
        document.querySelector('#kfstrip .kf-track[data-track="tf.opacity"]') as HTMLElement | null;

      // ① 拖动第一个手柄到 40% 处 —— 右边站着 1.2s 那一帧，所以它【应该被邻居夹住】
      const kfTrack0 = kfTrackEl();
      if (kfTrack0 !== null) {
        const rect = kfTrack0.getBoundingClientRect();
        const handle = kfHandles()[0];
        if (handle !== undefined) {
          const hr = handle.getBoundingClientRect();
          const y = hr.top + hr.height / 2;
          const x0 = hr.left + hr.width / 2;
          const x1 = rect.left + rect.width * 0.4;
          handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y }));
          window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x1, clientY: y }));
          window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x1, clientY: y }));
        }
      }
      const tAfterDrag = opacityKeys().map((k) => k.t);
      const vAfterDrag = opacityKeys().map((k) => k.v);

      // ② 双击轨道空白处（60% 处）插一个关键帧
      const kfTrack1 = kfTrackEl();
      if (kfTrack1 !== null) {
        const rect = kfTrack1.getBoundingClientRect();
        kfTrack1.dispatchEvent(
          new MouseEvent('dblclick', {
            bubbles: true,
            clientX: rect.left + rect.width * 0.6,
            clientY: rect.top + rect.height / 2,
          }),
        );
      }
      const kfAfterInsert = kfHandles().length;
      const tAfterInsert = opacityKeys().map((k) => k.t);

      // ③ 双击第 2 个手柄删掉它
      kfHandles()[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const kfAfterDelete = kfHandles().length;
      const tAfterDelete = opacityKeys().map((k) => k.t);

      /**
       * ★ §7 第 0.5 条的面板侧证据：改一个【已存在对象】的形状/文字参数。
       *
       *   这条路径此前完全不通 —— 面板画着控件，但没有任何命令能改它们
       *   （拖了只说一句"改不动"）。演示文档里正好有 text#1，
       *   所以走真控件：选中它 → 改"文字"那一行 → 派发 change。
       */
      const textBefore = String(panel.snapshot().objects['text#1']?.params?.['content']?.['v'] ?? '');
      const outlineRow = [...document.querySelectorAll('#outline .obj')].find(
        (r) => (r.textContent ?? '').includes('text#1'),
      );
      (outlineRow as HTMLElement | undefined)?.click();
      const contentRow = [...document.querySelectorAll('#inspector .row')].find(
        (r) => (r.querySelector('label')?.textContent ?? '') === '文字',
      );
      /**
       * ★ 取 input【或】textarea：文字内容的 maxChars 是 200 > 120，
       *   所以 controls.ts 给它造的是 textarea（那条阈值在 registry 驱动的 deriveControl 里）。
       *   只查 input 会拿到 null，然后"改不动"—— 探针自己写错，红得像产品 bug。
       */
      const contentInput = (contentRow?.querySelector('input, textarea') ?? null) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (contentInput !== null) {
        contentInput.value = '实测改过的标题';
        contentInput.dispatchEvent(new Event('change'));
      }
      const textAfter = String(panel.snapshot().objects['text#1']?.params?.['content']?.['v'] ?? '');
      /**
       * ★ 文字排版（P3 第一块）：对齐用的是【下拉框】，换行宽度是数字框。
       *   这里改一下对齐，确认那条路径也接上了（覆盖断言只能证明"能派发命令"，
       *   证明不了"控件真的发得出去"）。
       */
      const alignRow = [...document.querySelectorAll('#inspector .row')].find(
        (r) => (r.querySelector('label')?.textContent ?? '') === '对齐',
      );
      const alignSelect = (alignRow?.querySelector('select') ?? null) as HTMLSelectElement | null;
      if (alignSelect !== null) {
        alignSelect.value = 'left';
        alignSelect.dispatchEvent(new Event('change'));
      }
      const alignAfter = String(panel.snapshot().objects['text#1']?.style?.['align']?.['v'] ?? '');
      /** 粗体是【复选框】：点一下，文档里的 style.bold 必须变成 true。 */
      const boldRow = [...document.querySelectorAll('#inspector .row')].find(
        (r) => (r.querySelector('label')?.textContent ?? '') === '粗体',
      );
      (boldRow?.querySelector('input[type=checkbox]') as HTMLInputElement | null)?.click();
      const boldAfter = panel.snapshot().objects['text#1']?.style?.['bold']?.['v'] === true;
      /**
       * ★ 把选中恢复成 plot#1 —— 上面那次点击把 inspector 切到了 text#1，
       *   而后面那些检查读的是【inspector 的行数 / 锁标记】（它们与选中对象有关）。
       *   不恢复的话会出现 6 条莫名其妙的红：**探针自己的动作改掉了别人要读的状态**。
       *   （这一轮在探针里第三次栽在同一件事上：状态是会互相影响的。）
       */
      const backRow = [...document.querySelectorAll('#outline .obj')].find(
        (r) => (r.textContent ?? '').includes('plot#1'),
      );
      (backRow as HTMLElement | undefined)?.click();

      renderer.play(true);
      return new Promise<string>((resolve) => {
        setTimeout(() => {
          renderer.play(false);
          const stage = document.getElementById('stage') as HTMLCanvasElement | null;
          const transport = document.getElementById('transport');
          const last = $('#chat .msg:last-child');
          resolve(
            JSON.stringify({
              sections: ['#outline', '#preview', '#inspector', '#timeline', '#review', '#journal', '#chatwrap'].filter(
                (s) => $(s) !== null,
              ).length,
              objects: count('#outline .obj'),
              rows: count('#inspector .row'),
              sceneRows: count('#inspector .ctl'),
              exportBtn: document.getElementById('exportbtn') !== null,
              exportStat: document.getElementById('exportstat')?.textContent ?? '',
              worldNote: document.getElementById('worldnote')?.textContent ?? '',
              lanes: count('#timeline .tl-label'),
              pcards: count('#review .pcard'),
              badge: document.getElementById('pbadge')?.textContent ?? '',
              proposedRows: count('#inspector .row-proposed'),
              animDots: count('.dot-anim'),
              hardLocks: count('.lock-hard'),
              softLocks: count('.lock-soft'),
              /**
               * ★ 锁的【标签】而不只是条数：探针自己那次"改效果参数"是以 user 身份写的，
               *   引擎因此给 eff#1.params.duration 加了一把硬锁 —— 这是【正确行为】
               *   （用户写过的字段就该锁住）。记下标签，断言里就能说清"第二把锁是我自己弄出来的"，
               *   而不是把期望值从 1 改成 2 了事。
               */
              hardLockLabels: [...document.querySelectorAll('#inspector .row')]
                .filter((r) => r.querySelector('.lock-hard') !== null)
                .map((r) => r.querySelector('label')?.textContent ?? '')
                .join('|'),
              transportH: transport === null ? 0 : Math.round(transport.getBoundingClientRect().height),
              stageW: stage === null ? 0 : stage.width,
              stageH: stage === null ? 0 : stage.height,
              outlineTools: count('#outline .outline-tools .btn'),
              chatPresets: count('#chat .chip'),
              chatHasInput: document.getElementById('chatinput') !== null,
              chatLines0: lines0,
              chatLines1: count('#chat .msg'),
              chatToolLines: count('#chat .msg-tool'),
              chatErrorLines: count('#chat .msg-error'),
              // 聊天里那一条报错说了什么（400 那类接口错误必须留证据，不能只记个数）
              chatErrorText: (
                [...document.querySelectorAll('#chat .msg-error')].map((el) => el.textContent ?? '').join(' | ')
              ).slice(0, 300),
              chatLast: last === null ? '' : (last.textContent ?? ''),
              v0,
              vBeforeAgent,
              v1: panel.journal().currentVersion(),
              f0,
              h0,
              f1: renderer.frame(),
              h1: renderer.frameHash(),
              total: renderer.totalFrames(),
              // ── 镜头 ──────────────────────────────────────────
              totalShots,
              shotLabels: shotLabels.join('|'),
              currentShot: count('#timeline .tl-shot.cur'),
              scene1Hash,
              scene2Hash,
              // 每一镜内部换几帧都必须换画面（否则是"画面没动"）
              shot1Stable: shot1Hashes.size === 3,
              shot2Stable: shot2Hashes.size === 3,
              tc1,
              tc2,
              // ── 效果参数控件（§7 第 0 条）──────────────────────
              effectRowFound: durationRow !== undefined && durationInput !== null,
              effectDurationBefore: effBefore?.params['duration']?.['v'] ?? null,
              effectDurationAfter: effAfter?.params['duration']?.['v'] ?? null,
              vBeforeEdit,
              vAfterEdit,
              errBeforeEdit,
              errAfterEdit,
              // ── 镜头管理 + 用户手势可撤销 ────────────────────────
              sceneToolButtons,
              exportChat,
              userEditRevertEnabled,
              scenesBefore,
              durationBefore,
              scenesAfterAdd,
              durationAfterAdd,
              lanesAfterAdd,
              renamedInDoc,
              renamedInLane,
              scenesAfterUndo,
              durationAfterUndo,
              lanesAfterUndo,
              // ── 关键帧编辑（§7 第 4 条）──────────────────────────
              kfBefore,
              exprRows,
              tBefore,
              tAfterDrag,
              vAfterDrag,
              kfAfterInsert,
              tAfterInsert,
              kfAfterDelete,
              tAfterDelete,
              // ── 改已有对象的形状/文字参数（§7 第 0.5 条）──
              textBefore,
              textAfter,
              alignAfter,
              boldAfter,
            }),
          );
        }, 500);
      });
    });
  });
}

const result = await screenshotUrl({
  url,
  outPath: join(ROOT, 'out', 'panel-live.png'),
  width: 1440,
  height: 860,
  userDataDir: join(ROOT, 'out', 'chrome-profile-verify'),
  // 让"AI"提一条会撞上硬锁的改动 —— 审核队列、顶栏徽标、控件琥珀高亮
  // 三处呈现都会同时出现。提案永远来自引擎判定，不是界面凭空画的。
  prepare:
    'window.__PANEL__.applyAgentCommand(' +
    '{"op":"set_style","target":"plot#1","width":9},' +
    '"投影仪上要看得清，把曲线加粗");',
  probe: `(${probeFn.toString()})()`,
});

const probe = JSON.parse(String(result.probeResult)) as Record<string, number | string | boolean>;
console.log('截图    : out/panel-live.png (' + result.chromeVersion + ', sha256 ' + result.sha256.slice(0, 12) + ')');
console.log('结构    : ' + JSON.stringify(probe));
console.log('聊天末行: ' + String(probe['chatLast']).slice(0, 160));
const bad = result.consoleLines.filter(
  (l) => l.startsWith('[pageerror]') || l.startsWith('[http ') || l.startsWith('[requestfailed]'),
);
console.log('页面异常: ' + (bad.length === 0 ? '无' : JSON.stringify(bad)));
for (const line of result.consoleLines.slice(0, 12)) console.log('  [页面] ' + line);

/** 探针结果里的数组（JSON 往返之后类型信息丢了，统一在这里收口）。 */
const nums = (v: number | string | boolean | undefined): number[] =>
  Array.isArray(v) ? (v as unknown as number[]).map(Number) : [];

const checks: readonly (readonly [string, boolean])[] = [
  ['七个区都在（含聊天）', probe['sections'] === 7],
  ['大纲列出 4 个对象', probe['objects'] === 4],
  ['大纲有新建/删除按钮', Number(probe['outlineTools']) === 3],
  ['控件从 registry 生成（>10 行）', Number(probe['rows']) > 10],
  ['时间轴有轨道标签', Number(probe['lanes']) > 0],
  ['预览画布像素 = 导出像素', probe['stageW'] === 960 && probe['stageH'] === 540],
  ['播放条可见', Number(probe['transportH']) > 0],
  ['提案进入审核队列', probe['pcards'] === 1],
  ['顶栏徽标计数正确', String(probe['badge']) === '1'],
  ['控件上出现琥珀高亮', probe['proposedRows'] === 1],
  ['三态可视：动画蓝点', Number(probe['animDots']) > 0],
  /**
   * ★ 两把硬锁，而且断的是【标签集合】不是顺序：
   *   一把来自演示文档（plot#1.style.width = 线宽），
   *   另一把是探针自己改效果参数时由引擎给用户写加上的（eff#1.params.duration = 持续时长）。
   *   顺序由 DOM 里分区（section）的先后决定，跟"锁对不对"无关 —— 用顺序做判据是自找的脆弱。
   */
  [
    '三态可视：用户硬锁 = 演示文档那把 + 探针自己改出来的那把',
    probe['hardLocks'] === 2 &&
      ['线宽', '持续时长'].every((l) => String(probe['hardLockLabels']).split('|').includes(l)),
  ],
  ['三态可视：AI 软锁', probe['softLocks'] === 1],
  ['播放推进帧号', Number(probe['f1']) > Number(probe['f0'])],
  ['播放改变画面', probe['h0'] !== probe['h1']],
  // ── 聊天窗口：能命令 Agent，且结果真的落到文档上 ──────────────
  ['聊天有输入框', probe['chatHasInput'] === true],
  ['聊天有快捷入口', Number(probe['chatPresets']) > 0],
  ['聊天出现了新消息', Number(probe['chatLines1']) > Number(probe['chatLines0'])],
  ['聊天里能看到工具调用', Number(probe['chatToolLines']) > 0],
  [
    'Agent 跑完没有报错行',
    Number(probe['chatErrorLines']) === 0,
  ],
  ['Agent 的写入落到了文档上（版本前进）', Number(probe['v1']) > Number(probe['vBeforeAgent'])],
  // ── 场景设置：能改的能改、不能改的说清楚 ──────────────────────
  ['场景设置控件从 registry 生成', Number(probe['sceneRows']) >= 4],
  ['世界尺寸以只读文字说明为什么不能改', String(probe['worldNote']).includes('不可事后修改')],
  // ── 导出：真的导出一次并回读校验 ──────────────────────────────
  ['有导出按钮', probe['exportBtn'] === true],
  ['导出完成并报出字节数', String(probe['exportStat']).includes('已导出')],
  ['聊天里报出导出结果', String(probe['exportChat']).includes('导出完成')],
  // ── 镜头：泳道、按镜过滤、传输条报归属 ────────────────────────
  ['时间轴有两条镜头泳道', probe['totalShots'] === 2],
  ['镜头块显示名字', String(probe['shotLabels']).includes('第二镜')],
  ['当前播放头所在镜头被高亮', probe['currentShot'] === 1],
  ['★ 两个镜头的画面不同（预览真的按镜过滤）', probe['scene1Hash'] !== probe['scene2Hash']],
  ['每一镜内部换帧画面也在变', probe['shot1Stable'] === true && probe['shot2Stable'] === true],
  ['传输条报出当前镜头', String(probe['tc2']).includes('s#2')],
  ['第一镜的传输条报的是第一镜', String(probe['tc1']).includes('s#1')],
  // ── 效果参数控件：拖着有反应，而且真的落到文档上（§7 第 0 条）──
  ['效果参数控件存在（生长时长这一行）', probe['effectRowFound'] === true],
  ['★ 改效果参数真的改到了文档', probe['effectDurationAfter'] === 3.5],
  ['★ 改效果参数经 Journal 前进版本', Number(probe['vAfterEdit']) > Number(probe['vBeforeEdit'])],
  ['★ 能改动时不产生错误提示', Number(probe['errAfterEdit']) === Number(probe['errBeforeEdit'])],
  // ── 镜头管理（P4 #14）：引擎命令早就就绪，这一轮才给了人的入口 ──
  ['镜头管理控件在（＋镜头 / 改名 / 删除）', Number(probe['sceneToolButtons']) === 3],
  [
    '★ 加一镜：泳道 2 → 3 条，片长 8 → 12（落在片尾的镜头必须有长度）',
    probe['scenesBefore'] === 2 &&
      probe['scenesAfterAdd'] === 3 &&
      probe['durationBefore'] === 8 &&
      probe['durationAfterAdd'] === 12 &&
      probe['lanesAfterAdd'] === 3,
  ],
  ['★ 改名：文档与时间轴上的镜头名一起变', probe['renamedInDoc'] === true && probe['renamedInLane'] === true],
  /**
   * ★ 这条判据必须【先证明原状真的被改过】。
   *
   *   上一次它空过了：加镜头那一步失败（scenesAfterAdd 还是 2），
   *   于是"撤销后回到 2 镜 / 片长 8"自然成立 —— **空过比红危险**，
   *   它会一直假装在守。所以现在把"加成功了"写进同一条判据的前半截。
   */
  [
    '★ 一次手势一次撤销：add_scene + set_meta 一起回来（3 → 2 镜、片长 12 → 8）',
    probe['scenesAfterAdd'] === 3 &&
      probe['durationAfterAdd'] === 12 &&
      probe['scenesAfterUndo'] === 2 &&
      probe['durationAfterUndo'] === 8 &&
      probe['lanesAfterUndo'] === 2,
  ],
  ['★ 用户自己的编辑现在可撤销（以前按钮永远是灰的）', probe['userEditRevertEnabled'] === true],
  // ── 关键帧编辑（§7 第 4 条）：时间轴上的手柄 ────────────────────
  [
    '关键帧条在（2 个手柄 + 1 条只读的表达式轨道）',
    probe['kfBefore'] === 2 && probe['exprRows'] === 1,
  ],
  [
    '★ 拖动手柄：文档里那一刻真的变了，且被右边的邻居夹住（没越过它）',
    JSON.stringify(probe['tBefore']) === '[0,1.2]' &&
      JSON.stringify(probe['tAfterDrag']) !== JSON.stringify(probe['tBefore']) &&
      nums(probe['tAfterDrag'])[0]! > 0 &&
      nums(probe['tAfterDrag'])[0]! < 1.2 &&
      nums(probe['tAfterDrag'])[1] === 1.2,
  ],
  [
    '★ 拖动只改时刻：取值原样保留',
    JSON.stringify(probe['vAfterDrag']) === JSON.stringify([0, 1]),
  ],
  [
    '★ 双击空白插入：手柄 +1，文档里的关键帧也 +1',
    Number(probe['kfAfterInsert']) === Number(probe['kfBefore']) + 1 &&
      nums(probe['tAfterInsert']).length === nums(probe['tBefore']).length + 1,
  ],
  [
    '★ 双击手柄删除：手柄 -1，文档里的关键帧也 -1',
    Number(probe['kfAfterDelete']) === Number(probe['kfAfterInsert']) - 1 &&
      nums(probe['tAfterDelete']).length === nums(probe['tAfterInsert']).length - 1,
  ],
  // ── §7 第 0.5 条：面板终于改得动形状/文字参数 ────────────────
  [
    '★ 选中 text#1 后改“文字”控件：文档里的 content 真的变了',
    probe['textBefore'] === '正弦曲线 sin(x)' && probe['textAfter'] === '实测改过的标题',
  ],
  ['★ 文字对齐控件（下拉框）真的改到了文档', probe['alignAfter'] === 'left'],
  ['★ 粗体开关（复选框）真的改到了文档', probe['boldAfter'] === true],
  ['没有失败请求', bad.length === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label);
}
if (Number(probe['chatErrorLines']) > 0) {
  console.log('聊天里的报错原文: ' + String(probe['chatErrorText']));
}
console.log(failed === 0 ? '\n全部通过（' + checks.length + ' 项）' : '\n有 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
