/**
 * 三层图像预算（规范 §10）。缺一层都是纸糊的。
 *
 *   L1 调用层   单次 render_frames 的 timestamps.length ≤ 6，超出在【渲染前】拒绝
 *   L2 累计层   每镜 imageCount ≤ 16、renderCallCount ≤ 6，按 sceneId 记账
 *   L3 上下文层 消息历史同时保留的图片 ≤ 16 张，更早的替换为文字摘要
 *
 * ★ 关键点：超预算必须【报错】，不能静默继续。渲染前的拒绝尤其重要 ——
 *   等图渲染出来再拒绝，既烧了算力又让模型以为成功。
 *
 * ══════════════════ 第二十九轮：上限按实测【放开】══════════════════
 *
 * ★★ 实测（§0.28 二）：**一帧 960×540 的画面固定 323 prompt token，与画面复杂度无关**
 *   （纯色与 427KB 随机噪点都是 323 —— 说明是按 tile 计费，不是按字节）。
 *   也就是说：一次固定开销（系统提示 2940 + 工具表 6099 = 9039）能换 **28 帧画面**，
 *   而旧的规则是每镜 6 张、同屏只留 3 张 —— **省的是最不该省的那笔**。
 *   用户拍板：「比起节省 token，我更想要画面效果」。
 *
 * ★ 旧值 → 新值：L1 4→6、L2 6→16 张 / 3→6 次、L3 3→16 张。
 *   为什么不是更多（比如 50）：「8–16 帧」是【注意力】的上限而不是成本的上限 ——
 *   图太多，模型会开始忽略文字回执。所以配套要求：回执与提示词里都要说清看哪几帧。
 */
import type { BudgetState } from '@sva/engine-core';

export const L1_MAX_FRAMES = 6;
export const L2_MAX_IMAGES = 16;
export const L2_MAX_RENDER_CALLS = 6;
export const L3_MAX_IMAGES_IN_CONTEXT = 16;

export interface BudgetLimits {
  readonly maxFramesPerCall: number;
  readonly maxImages: number;
  readonly maxRenderCalls: number;
  readonly maxImagesInContext: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxFramesPerCall: L1_MAX_FRAMES,
  maxImages: L2_MAX_IMAGES,
  maxRenderCalls: L2_MAX_RENDER_CALLS,
  maxImagesInContext: L3_MAX_IMAGES_IN_CONTEXT,
};

export type BudgetRejection =
  | { readonly code: 'L1_too_many_frames'; readonly message: string }
  | { readonly code: 'L2_images_exhausted'; readonly message: string }
  | { readonly code: 'L2_calls_exhausted'; readonly message: string };

export type BudgetCheck = { readonly ok: true } | { readonly ok: false; readonly rejection: BudgetRejection };

/* ══════════════════ 「看过画面」的证据（第二十九轮，§0.28 作业 1c）══════════════════
 *
 * ★★ 为什么它属于这个账本：预算管的是「模型能用多少画面」，
 *   而这一段管的是「模型到底用了没有」—— 同一件事的两端。
 *
 *   动机是实测出来的：Agent 会在一次都没看过画面的情况下调 finish_shot 收尾，
 *   而收尾之后它【再没有机会修改】。于是用户拿到的是「自信地交了一份没校对过的稿」。
 *
 * ★★★ 一条只有【真调模型】才能发现的事（本轮实测）：
 *
 *   第一版把 render_frames 与 get_render_state **都**算作"看过"（照 §0.28 作业 1c 的字面），
 *   结果真机跑出来的是：工具序列 = [get_scene_summary, get_render_state, apply_commands,
 *   apply_commands, validate, get_render_state] —— **render_frames 一次都没调，0 张图**，
 *   而它照样通过了关卡、干净收尾了。也就是说：**只要有一条便宜的路能过关，
 *   模型一定走便宜的那条。** 而"闭着眼睛画"正是这一轮要治的病。
 *
 *   所以关卡收紧成：**必须真的渲染过至少一帧**（像素）。get_render_state 仍然
 *   有用（判重叠/越界它更划算），但它不再能替代"看一眼画面"这件事。
 *   代价是每镜至少 323 token —— 用户已经拍板「比起节省 token，我更想要画面效果」。
 */
export type LookKind = 'render_frames' | 'get_render_state';

export interface LookRecord {
  /** render_frames 成功过几次（★ 关卡只看这个数）。 */
  readonly frames: number;
  /** get_render_state 调过几次（便宜的自查，不算"看过画面"）。 */
  readonly states: number;
}

export const NOT_LOOKED_MESSAGE =
  '你还没有【渲染过】这一镜的画面，不能收尾。' +
  'get_render_state(t) 给的是文字版的屏幕状态（判重叠/越界很划算，但它不是画面）；' +
  '收尾前必须用 render_frames([...]) 至少看一帧真的像素 —— 一帧约 323 token，很便宜。' +
  '看过之后再调 finish_shot。';

export class BudgetTracker {
  readonly sceneId: string;
  private readonly limits: BudgetLimits;
  private images = 0;
  private calls = 0;
  private lookedFrames = 0;
  private lookedStates = 0;

  constructor(sceneId: string, limits: BudgetLimits = DEFAULT_LIMITS) {
    this.sceneId = sceneId;
    this.limits = limits;
  }

  /** 渲染【之前】的检查。L1 与 L2 都在这里拦。 */
  checkRender(timestamps: readonly number[]): BudgetCheck {
    if (timestamps.length > this.limits.maxFramesPerCall) {
      return {
        ok: false,
        rejection: {
          code: 'L1_too_many_frames',
          message:
            '单次最多 ' + this.limits.maxFramesPerCall + ' 帧，请求了 ' + timestamps.length +
            ' 帧。请拆成多次，或先用 get_render_state 的文字信息判断。',
        },
      };
    }
    if (this.calls + 1 > this.limits.maxRenderCalls) {
      return {
        ok: false,
        rejection: {
          code: 'L2_calls_exhausted',
          message: '本镜渲染次数已用尽（' + this.calls + '/' + this.limits.maxRenderCalls + '）。',
        },
      };
    }
    if (this.images + timestamps.length > this.limits.maxImages) {
      return {
        ok: false,
        rejection: {
          code: 'L2_images_exhausted',
          message:
            '本镜图片额度不足：已用 ' + this.images + '/' + this.limits.maxImages +
            '，本次还要 ' + timestamps.length + ' 张。',
        },
      };
    }
    return { ok: true };
  }

  chargeRender(frameCount: number): void {
    this.images += frameCount;
    this.calls += 1;
  }

  /** 记一次「看过画面」。★ 只该由 get_render_state 与 render_frames 的成功路径调用。 */
  markLooked(kind: LookKind): void {
    if (kind === 'render_frames') this.lookedFrames += 1;
    else this.lookedStates += 1;
  }

  /**
   * 这一镜里模型有没有**真的渲染过**一帧。finish_shot 的关卡读它。
   *
   * ★ 只看 frames，不看 states —— 理由见文件头那条实测（模型一定走便宜的路）。
   */
  hasRenderedFrame(): boolean {
    return this.lookedFrames > 0;
  }

  /** 自查过（get_render_state）。它【不】解锁收尾，但要如实报出来。 */
  hasCheckedState(): boolean {
    return this.lookedStates > 0;
  }

  lookRecord(): LookRecord {
    return { frames: this.lookedFrames, states: this.lookedStates };
  }

  remaining(): BudgetState {
    return {
      imagesUsed: this.images,
      imagesLeft: Math.max(0, this.limits.maxImages - this.images),
      renderCallsLeft: Math.max(0, this.limits.maxRenderCalls - this.calls),
    };
  }
}

/**
 * L3：消息历史里同时保留的图片不超过 max 张。
 * 超出的旧图【替换成一行文字摘要】而不是直接删掉 ——
 * 删掉会让模型完全忘记看过什么，摘要至少留下"我在 t=2.4 看过一帧，曲线正常"。
 */
export function enforceContextBudget<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  max: number,
): { readonly messages: readonly T[]; readonly summarized: number } {
  // 按【图片张数】计数，不是按"含图的消息条数" ——
  // 一条消息里塞了 2 张图时，后者会漏判。
  const slotKeys: string[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    (m.content as unknown[]).forEach((part, j) => {
      if (isImagePart(part)) slotKeys.push(i + ':' + j);
    });
  });
  if (slotKeys.length <= max) return { messages, summarized: 0 };

  const dropped = new Set(slotKeys.slice(0, slotKeys.length - max));
  const out = messages.map((m, i) => {
    if (!Array.isArray(m.content)) return m;
    const parts = m.content as unknown[];
    let removed = 0;
    const kept: unknown[] = [];
    parts.forEach((part, j) => {
      if (isImagePart(part) && dropped.has(i + ':' + j)) {
        removed += 1;
        return;
      }
      kept.push(part);
    });
    if (removed === 0) return m;
    return {
      ...m,
      content: [
        ...kept,
        { type: 'text', text: '[历史图片已折叠：此处原有 ' + removed + ' 帧渲染结果]' },
      ],
    } as T;
  });
  return { messages: out, summarized: dropped.size };
}

function isImagePart(part: unknown): boolean {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: string }).type === 'image_url'
  );
}
