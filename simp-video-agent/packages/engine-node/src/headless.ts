/**
 * engine-node 的【无浏览器】半边：纯 @napi-rs/canvas 渲染。
 *
 * ★ 为什么要把这一份单独暴露出来：
 *   包根 index.ts 会把浏览器那条链（chrome.ts → puppeteer-core → screenshot /
 *   export）一起拖进来。于是任何"只想渲染一帧"的宿主 —— 比如 Agent 的
 *   render_frames、CLI 跑一个镜头 —— 都会连带依赖 puppeteer-core，
 *   在没有它的环境里连 import 都失败（哪怕一行浏览器代码都不会执行）。
 *
 *   这里只暴露渲染，不涉及 Chrome、ffmpeg、静态服务。
 *   要导出成片请用 @sva/engine-node/export（那条路确实需要浏览器）。
 *
 * 与导出管线共用同一份 evaluate + paintScene，所以"预览=成片"不受影响。
 */
export {
  renderFrames,
  registerHeadlessFonts,
  assertFontsRegistered,
  defaultFontsDir,
  HEADLESS_FONT_STACK,
  type RenderedFrame,
  type FontRegisterResult,
} from './render';
