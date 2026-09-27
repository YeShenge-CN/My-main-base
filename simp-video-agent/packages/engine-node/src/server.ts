/**
 * 极小的静态文件服务。
 * 浏览器加载 ES 模块 / fetch 文档都不能走 file://（CORS），所以导出时必须起一个。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export interface StaticServer {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startStaticServer(root: string): Promise<StaticServer> {
  // 去掉尾部分隔符：留着的话 base + sep 会变成双分隔符，路径守卫会误判成越界
  const base = normalize(root).replace(/[\\/]+$/, '');
  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0] ?? '/';
    const rel = decodeURIComponent(raw);
    const target = normalize(join(base, rel));
    if (!target.startsWith(base + sep) && target !== base) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    readFile(target)
      .then((buf) => {
        res.setHeader('Content-Type', TYPES[extname(target)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
      })
      .catch(() => {
        res.statusCode = 404;
        res.end('not found: ' + rel);
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    origin: 'http://127.0.0.1:' + port,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
