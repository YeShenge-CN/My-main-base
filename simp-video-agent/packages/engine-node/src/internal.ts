/**
 * engine-node 的【无 DOM 工具半边】：静态服务 + 打包器。
 *
 * 三档边界，依赖写在 import 语句上：
 *   ./headless   只要 canvas（渲染帧）
 *   ./internal   静态服务、打包器 —— 无 DOM 类型
 *   ./screenshot 浏览器截图 —— page.evaluate 回调签名带 window/document，
 *                所以 import 它的程序必须开 DOM lib
 *
 * 分成这样是因为 agent-tools 的 src 刻意【没有 DOM】：serve-panel 只需要
 * 前两样，如果它们和 screenshot 混在一起导出，src 就会被 DOM 类型污染。
 */
export { startStaticServer, type StaticServer } from './server';
export { buildPreviewBundle } from './bundle';
