/**
 * 预览 / 导出的页面入口。
 *
 * 铁律：
 *   - canvas.width/height 就是导出像素，永不使用 devicePixelRatio
 *   - t 从【整数帧】推导：t = frame / fps（规范 P8 清单第 3 条）
 *   - 不读 performance.now()、不读 Date.now()、不取随机数
 *   - mode=export 时画布容器必须是 scale(1)
 *   - 绘完 + document.fonts.ready 之后才置 window.__READY__
 */
import {
  evaluate,
  filterRenderStateByScene,
  frameSceneId,
  planShotFrames,
  resolveItemStyle,
  type ResolvedItemStyle,
  type SceneDoc,
  type SceneId,
} from '@sva/engine-core';
import { paintScene, SVA_FONT_STACK, type Ctx2D } from '../src/paint';

declare global {
  interface Window {
    __READY__: boolean;
    __EXPORT_ERROR__: string | null;
    __FRAME_INFO__: { frame: number; t: number; docHash: string; sceneId: SceneId | null } | null;
    __FONT_STATUS__: {
      inter400: boolean;
      inter700: boolean;
      notoCJK: boolean;
      facesLoaded: number;
    } | null;
  }
}

function hex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  return hex(await crypto.subtle.digest('SHA-256', data));
}

function styleOfFactory(doc: SceneDoc) {
  return (item: { id: string }): ResolvedItemStyle => {
    const obj = doc.objects[item.id];
    if (obj === undefined) return {};
    // 求值层已把动画叠加后的样式放进 RenderItem.style，这里是退回路径。
    return resolveItemStyle(obj);
  };
}

async function main(): Promise<void> {
  window.__READY__ = false;
  window.__EXPORT_ERROR__ = null;
  window.__FRAME_INFO__ = null;

  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') ?? 'preview';
  if (mode === 'export') document.documentElement.setAttribute('data-mode', 'export');

  const docUrl = params.get('doc');
  if (docUrl === null) throw new Error('缺少 doc 参数');

  const res = await fetch(docUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('取文档失败 HTTP ' + res.status);
  const doc = (await res.json()) as SceneDoc;

  const docHash = await sha256Hex(JSON.stringify(doc));
  const expected = params.get('docHash');
  if (expected !== null && expected !== docHash) {
    throw new Error('docHash 不匹配：期望 ' + expected + '，实际 ' + docHash);
  }

  const frame = Math.trunc(Number(params.get('frame') ?? '0'));
  if (!Number.isFinite(frame) || frame < 0) throw new Error('frame 非法: ' + params.get('frame'));

  /**
   * ★ 帧 → 时刻 → 镜头，全部走 engine-core 的同一份帧计划。
   *
   *   刻意【不】在这里自己算"这一帧属于哪一镜"：只要页面和导出各自算一遍，
   *   它们迟早会算出不同的答案，而症状是"预览看起来对、成片少了一段"。
   *   页面里算的都是纯函数，不引入任何时钟或随机源。
   *
   *   scene 参数：导出会显式带上（含空串 = 空档帧，只画背景）；
   *   面板手翻帧时不带，这时按帧号查计划。
   */
  const timeline = planShotFrames(doc);
  const requested = params.get('scene');
  const sceneId: SceneId | null =
    requested === null ? frameSceneId(timeline, frame) : requested === '' ? null : requested;
  const t = frame / doc.meta.fps;

  const stage = document.getElementById('stage');
  if (stage === null) throw new Error('缺少 #stage');

  const canvas = document.createElement('canvas');
  canvas.width = doc.meta.viewport[0];
  canvas.height = doc.meta.viewport[1];
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  stage.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('取不到 2d 上下文');

  // ★ 必须【先显式加载】再绘制。
  //   只等 document.fonts.ready 是不够的：字体是"用到才加载"，
  //   不主动 load 的话，第一次绘制可能用替代字体完成，而 fonts.ready
  //   此时早已 resolve —— 那正是"同一帧两次不一样"的经典成因。
  await Promise.all([
    document.fonts.load('400 20px SvaInter'),
    document.fonts.load('700 20px SvaInter'),
    document.fonts.load('400 20px SvaNotoCJK'),
    document.fonts.load('400 20px SvaMath'),
  ]);

  const state = filterRenderStateByScene(evaluate(doc, t), doc, sceneId);
  paintScene(ctx as unknown as Ctx2D, state, {
    theme: doc.theme,
    styleOf: styleOfFactory(doc),
    fontFamily: SVA_FONT_STACK,
  });

  // 再等一次，确保没有任何字体还在加载
  await document.fonts.ready;

  // ★ 显式校验自托管字体【真的加载了】。
  //   漏掉这一步的话，@font-face 的 URL 404 会静默回退到系统字体，
  //   而 Level A 在同一台机器上照样通过 —— 看起来一切正常，
  //   实际上确定性已经被交回给机器了。
  window.__FONT_STATUS__ = {
    inter400: document.fonts.check('400 20px SvaInter'),
    inter700: document.fonts.check('700 20px SvaInter'),
    notoCJK: document.fonts.check('400 20px SvaNotoCJK'),
    math: document.fonts.check('400 20px SvaMath'),
    facesLoaded: document.fonts.size,
  };

  window.__FRAME_INFO__ = { frame, t, docHash, sceneId };
  window.__READY__ = true;
}

void main().catch((err: unknown) => {
  window.__EXPORT_ERROR__ = err instanceof Error ? err.message : String(err);
  window.__READY__ = false;
});
