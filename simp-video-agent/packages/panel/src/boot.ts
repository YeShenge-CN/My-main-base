/** 面板启动入口：取文档 → 建面板。 */
import type { SceneDoc } from '@sva/engine-core';
import { createPanel } from './app';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const docUrl = params.get('doc') ?? '/out/panel-doc.json';
  const res = await fetch(docUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('取文档失败 HTTP ' + res.status);
  const doc = (await res.json()) as SceneDoc;

  const root = document.getElementById('app');
  if (root === null) throw new Error('缺少 #app');

  let clock = 1_700_000_000_000;
  // 聊天接口用【相对路径】：页面本身就是那个服务发出来的，同源。
  // ?api=off 可以显式关掉聊天（纯本地预览、没有服务端时用）。
  const api = params.get('api');
  const chatEndpoint = api === 'off' ? undefined : (api ?? '/api/chat');
  const exportEndpoint = api === 'off' ? undefined : '/api/export';

  const panel = createPanel({
    root,
    doc,
    now: () => (clock += 1000),
    ...(chatEndpoint === undefined ? {} : { chatEndpoint }),
    ...(exportEndpoint === undefined ? {} : { exportEndpoint }),
  });

  // 供截图/自动化断言用
  (window as unknown as { __PANEL__?: unknown }).__PANEL__ = panel;
  (window as unknown as { __PANEL_READY__?: boolean }).__PANEL_READY__ = true;
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  document.body.append(document.createTextNode('面板启动失败: ' + msg));
  (window as unknown as { __PANEL_READY__?: boolean }).__PANEL_READY__ = false;
  (window as unknown as { __PANEL_ERROR__?: string }).__PANEL_ERROR__ = msg;
});
