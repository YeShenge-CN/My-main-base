/**
 * 镜头表的编辑入口（面板侧）：加一镜 / 改名 / 删一镜。
 *
 * ★ 为什么单独成模块：与 `command-path.ts` 同一条理由 ——
 *   这三条命令的参数完全由【文档现状】推导（现在有几镜、最后一镜到哪、片长够不够），
 *   而推导一旦内联在渲染闭包里，就只能靠真开浏览器点一下才能测 ——
 *   上一轮"面板改不动效果参数"就是这么静默坏了三轮的。
 *
 * ★ 它只产出【意图的形状】（Command）；合法性仍然由引擎判（不变量 4）：
 *   空名字、删最后一镜、镜头不存在，引擎都会拒，这里只是【提前】把
 *   "根本没有意义" 的操作变成 null，让界面能说话。
 *
 * ★ 三条命令的语义边界（引擎侧定的，这里不重新发明）：
 *   `set_scene` 只挪边界、`set_scene.name` 只改名；**内容永不跟着走**。
 *   所以面板的"改名"是纯改名，"加一镜"是纯加一镜（不动任何已有镜头的内容）。
 */
import { findScene, lastScene, sceneEnd, sceneOrder, type Command, type SceneDoc } from '@sva/engine-core';

/** 新镜头的默认名字（用户改得动；给个默认值是为了"空名字"不成为默认结果）。 */
export const NEW_SCENE_NAME = '新镜头';

/**
 * 新镜头默认占多长时间。
 *
 * ★ 为什么必须有这个数：`sceneEnd(最后一镜)` 就是 `meta.duration` 本身，
 *   所以"接在最后一镜之后"= 接在**片尾**，而落在片尾的镜头是**零长度**的
 *   （`[duration, duration)`）—— 加了等于没加，而且从画面与时间轴上都看不出来。
 *   4 秒是"能放一句话"的量级，与 `shotWithDiagram` 等预设的默认镜长一致。
 */
export const NEW_SCENE_SECONDS = 4;

/** 当前有几镜（场景顺序，bornAt 升序）。 */
export function sceneCount(doc: SceneDoc): number {
  return sceneOrder(doc).length;
}

/**
 * 加一镜：**永远接在最后一镜之后**，并且必要时把片长一起延出去。
 *
 * ★ 为什么不是"插在当前播放头那一镜之后"：
 *   中间的镜头后面已经站着另一镜，而 `sceneEnd` 是【下一镜的起点】——
 *   在同一时刻塞进一镜，会让原本那一镜的窗口塌成零长度（`[4,4)`）。
 *   要真的"插一镜进去"，得把它们后面的边界整体推后，那是 retime 的语义
 *   （还要问"镜头里的内容跟不跟着走"）。一个按钮不该悄悄做这件事。
 *   所以按钮的语义就是它字面上的意思：**在最后加一镜**。
 *
 * ★ 返回的是【命令数组】而不是一条命令：追加一镜必然需要两条 ——
 *   先 `add_scene`（此时 sceneEnd 还是旧片长，新镜落在旧片尾），
 *   再 `set_meta` 把片长延到"新镜起点 + 默认镜长"。
 *   **顺序不能反**：先延长片长的话，`at` 会解析到新的片尾，新镜就跑到了更后面。
 *   两条命令在同一个 batch 里提交 → 一次撤销。
 *
 * 空表（还没有镜头表）时退化成"建第一镜"，起点 0，不动片长。
 */
export function addSceneCommands(doc: SceneDoc): readonly Command[] {
  const ordered = sceneOrder(doc);
  if (ordered.length === 0) {
    return [{ op: 'add_scene', name: NEW_SCENE_NAME, bornAt: 0 }];
  }
  const anchor = ordered[ordered.length - 1];
  if (anchor === undefined) return [];
  const start = sceneEnd(doc, anchor.id);
  const cmds: Command[] = [
    { op: 'add_scene', name: nextSceneName(ordered.length + 1), at: anchor.id },
  ];
  // 落在片尾 = 零长度：把片长延到"新镜起点 + 默认镜长"，否则这一镜什么都放不下。
  if (start >= doc.meta.duration) {
    cmds.push({ op: 'set_meta', duration: start + NEW_SCENE_SECONDS });
  }
  return cmds;
}

/** 默认名字：`新镜头 3`。（不叫"第 3 镜"—— 序号会随删除变化，"第几镜"是派生量。） */
export function nextSceneName(n: number): string {
  return NEW_SCENE_NAME + ' ' + n;
}

/** 改名。空名字（或只有空白）返回 null —— 引擎也会拒，但没必要让用户白点一次。 */
export function renameSceneCommand(sceneId: string, rawName: string): Command | null {
  const name = rawName.trim();
  if (sceneId === '' || name === '') return null;
  return { op: 'set_scene', target: sceneId, name };
}

/**
 * 删一镜。
 *
 * ★ 最后一镜不许删（引擎侧的硬规则）：删掉它，"整片时长"就没有归属了。
 *   在这里提前返回 null，界面就能把按钮置灰并说明原因，而不是让用户点了看报错。
 */
export function removeSceneCommand(doc: SceneDoc, sceneId: string): Command | null {
  if (sceneId === '') return null;
  if (findScene(doc, sceneId) === undefined) return null;
  if (sceneOrder(doc).length <= 1) return null;
  return { op: 'remove_scene', target: sceneId };
}

/**
 * 面板上"当前这一镜"该算谁：播放头所在的那一镜；播放头落在空档（或空表）时退回最后一镜。
 *
 * ★ 空档不是一个镜头，所以"改名/删除"必须有一个确定的落点 ——
 *   退回"最后一镜"比"什么都不做"更符合人的预期（人看着时间轴，光标在片尾附近）。
 */
export function sceneUnderCaret(doc: SceneDoc, currentSceneId: string | null): string | null {
  if (currentSceneId !== null && findScene(doc, currentSceneId) !== undefined) return currentSceneId;
  return lastScene(doc)?.id ?? null;
}

/* ── 时间轴拖动：拉长 / 缩短镜头（像 PR 那样拖接缝）─────────────
 *
 * ★ 这一组规则以前不存在 —— 面板只能通过"加一镜 / 删一镜 / 改名"改镜头表，
 *   而"这一镜太长/太短"这件事只能靠 set_scene 的数值框（还得自己算秒数）。
 *   拖动是它的自然入口，而**规则必须与 UI 分开**（同一条理由：内联在渲染闭包里就测不了）。
 */

/**
 * 一个镜头最短多长（秒）。
 *
 * ★ 为什么必须有下限：拖到 0 会得到一个【零长度的镜头】—— 它在时间轴上不可见、
 *   内容永远不出现，而用户以为自己只是"拉到底"。0.2 秒≈6 帧，是"还能看见"的量级。
 */
export const MIN_SCENE_SECONDS = 0.2;

/** 时间轴拖动的目标：某两镜之间的边界，或整片的片尾。 */
export type TrimTarget =
  | { readonly kind: 'boundary'; readonly sceneId: string }
  | { readonly kind: 'end' };

function snapToFrame(t: number, fps: number): number {
  return fps > 0 ? Math.round(t * fps) / fps : t;
}

/**
 * 拖动【两镜之间的边界】。
 *
 * ★ A1 的推论：镜头不存 end，所以"边界"就是**后一镜的 bornAt**。
 *   拖它 = 前镜变长、后镜变短（内容都不动）—— 这正是 PR 里拖两个片段接缝的手感。
 * ★ 第一镜的起点【不给拖】：那是整片的开头，挪它只会留下一段黑场。
 */
export function trimBoundaryCommand(doc: SceneDoc, sceneId: string, t: number): Command | null {
  const ordered = sceneOrder(doc);
  const i = ordered.findIndex((s) => s.id === sceneId);
  if (i <= 0) return null;
  const self = ordered[i];
  const prev = ordered[i - 1];
  if (self === undefined || prev === undefined) return null;
  const next = ordered[i + 1];
  const lo = prev.bornAt + MIN_SCENE_SECONDS;
  const hi = (next?.bornAt ?? doc.meta.duration) - MIN_SCENE_SECONDS;
  if (hi < lo) return null; // 已经挤不下了：不给拖，免得把邻居压成零长度
  const at = Math.min(hi, Math.max(lo, snapToFrame(t, doc.meta.fps)));
  if (Math.abs(at - self.bornAt) < 1e-9) return null;
  return { op: 'set_scene', target: sceneId, bornAt: at };
}

/**
 * 拖动【片尾】（最后一镜的右边界）= 改 meta.duration。
 *
 * ★ 这就是"拉长 / 缩短整片"：与 PR 里拖时间线末端一样。
 *   下限是最后一镜的起点 + 最短时长（否则最后一镜会被压成零长度）。
 * ★ 没有镜头表时同样可用 —— 那时整片就是"一镜"，片尾就是片尾。
 */
export function trimEndCommand(doc: SceneDoc, t: number): Command | null {
  const last = lastScene(doc);
  const lo = (last?.bornAt ?? 0) + MIN_SCENE_SECONDS;
  const at = Math.max(lo, snapToFrame(t, doc.meta.fps));
  if (Math.abs(at - doc.meta.duration) < 1e-9) return null;
  return { op: 'set_meta', duration: at };
}

/**
 * 拖动过程中的【预览文档】：只改被拖的那一处，别的原样。
 *
 * ★ 为什么不直接提交：拖一次会产生几十上百个中间值，每个都提交会往 Journal 里
 *   灌一串没人想撤销的中间态。提交只在松手时发生一次（与关键帧手柄同一条口径）。
 */
export function withTrimPreview(doc: SceneDoc, target: TrimTarget, t: number, fps: number): SceneDoc {
  if (target.kind === 'end') {
    const last = lastScene(doc);
    const lo = (last?.bornAt ?? 0) + MIN_SCENE_SECONDS;
    return { ...doc, meta: { ...doc.meta, duration: Math.max(lo, snapToFrame(t, fps)) } };
  }
  const ordered = sceneOrder(doc);
  const i = ordered.findIndex((s) => s.id === target.sceneId);
  if (i <= 0) return doc;
  const self = ordered[i];
  const prev = ordered[i - 1];
  if (self === undefined || prev === undefined) return doc;
  const next = ordered[i + 1];
  const lo = prev.bornAt + MIN_SCENE_SECONDS;
  const hi = (next?.bornAt ?? doc.meta.duration) - MIN_SCENE_SECONDS;
  const at = Math.min(hi, Math.max(lo, snapToFrame(t, fps)));
  return { ...doc, scenes: doc.scenes.map((s) => (s.id === target.sceneId ? { ...s, bornAt: at } : s)) };
}
