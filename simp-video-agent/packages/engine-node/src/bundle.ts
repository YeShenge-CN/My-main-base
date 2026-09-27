/**
 * 浏览器端打包。
 *
 * ★ 打包必须是【导出流程的一部分】，不能是一次性的手工步骤。
 *   否则改了 engine-core 却忘了重新打包，导出出来的还是旧引擎的画面 ——
 *   而且它看起来一切正常（PNG 有、MP4 有、帧数对），只是内容是错的。
 *   这个坑我实际踩到了：加了 text shape 之后 Level A 的 sha256 与"没有文字"时一模一样。
 *
 * 用 rolldown 的编程式 API，不走配置文件 —— 本环境下配置文件加载会触发
 * vite 的 windowsSafeRealPathSync，那里有一个沙箱一拦就崩的 exec("net use")。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rolldown } from 'rolldown';

export async function buildPreviewBundle(entryPath: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true });
  const bundle = await rolldown({ input: entryPath });
  try {
    await bundle.write({ file: outFile, format: 'iife', name: 'SvaPreview' });
  } finally {
    await bundle.close();
  }
}
