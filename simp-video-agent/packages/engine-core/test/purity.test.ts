import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 不变量 1 的可执行验收：engine-core 必须宿主无关。
 *
 * P0 验收标准原文：「engine-core 里 grep 不到 document/window/HTMLElement」。
 * 这里把它升级成一个测试：扫描 src 下所有源码（先剥掉注释与字符串之外的部分），
 * 命中任何宿主全局或非确定性 API 就失败。
 *
 * 注：tsc 层面已经挡住了绝大部分（src 的 tsconfig 不加载 DOM lib、types 为空），
 * 本测试是第二道闸，防止有人把 DOM lib 加回来。
 */

const SRC_DIR = new URL('../src/', import.meta.url);

/** 禁止出现的标识符（按完整单词匹配）。 */
const FORBIDDEN_IDENTIFIERS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'CanvasRenderingContext2D',
  'OffscreenCanvas',
  'ImageBitmap',
  'ImageData',
  'devicePixelRatio',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'DOMParser',
  'XMLHttpRequest',
  'ResizeObserver',
  'MutationObserver',
  'localStorage',
  'sessionStorage',
  'process',
  'require',
  '__dirname',
];

/** 禁止出现的成员访问表达式。 */
const FORBIDDEN_MEMBERS = ['Math.random', 'Date.now', 'performance.now', 'new Date'];

/** 剥掉注释，避免注释里提到 DOM 就误报。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function listSourceFiles(): string[] {
  const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
  return entries.filter((name) => name.endsWith('.ts')).map((name) => name.split('\\').join('/'));
}

describe('engine-core 宿主无关性（不变量 1）', () => {
  const files = listSourceFiles();

  it('至少扫到了源码文件（防止测试本身空转）', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('index.ts');
  });

  it.each(files)('%s 不含宿主全局', (rel) => {
    const code = stripComments(readFileSync(new URL(rel, SRC_DIR), 'utf8'));
    const hits: string[] = [];
    for (const id of FORBIDDEN_IDENTIFIERS) {
      // ★ 前面不能是点或单词字符。
      //   "cmd.window" 是【属性名】，不是 DOM 全局 window；
      //   而 "window.innerWidth" 这种才是真正要拦的东西。
      //   不这么收紧的话，任何叫 window 的字段名都会误报，
      //   最后一定会有人把规则整条注释掉 —— 那才是真正的损失。
      if (new RegExp('(?<![.\\w])' + id + '\\b').test(code)) hits.push(id);
    }
    for (const member of FORBIDDEN_MEMBERS) {
      if (code.includes(member)) hits.push(member);
    }
    expect(hits, rel + ' 命中禁止的宿主符号: ' + hits.join(', ')).toEqual([]);
  });

  it.each(files)('%s 不 import Node / 渲染框架模块', (rel) => {
    const code = stripComments(readFileSync(new URL(rel, SRC_DIR), 'utf8'));
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    const bad = specifiers.filter(
      (s) =>
        s.startsWith('node:') ||
        /^(fs|path|os|child_process|worker_threads|canvas|skia-canvas|puppeteer|sharp|jsdom|react|react-dom|zustand)$/.test(
          s,
        ),
    );
    expect(bad, rel + ' 引入了宿主模块: ' + bad.join(', ')).toEqual([]);
  });

  it('src 的 tsconfig 不加载 DOM lib，且不引入任何宿主 types', () => {
    const core = stripComments(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
    const base = stripComments(
      readFileSync(new URL('../../../tsconfig.base.json', import.meta.url), 'utf8'),
    );
    expect(core).not.toMatch(/"DOM"/);
    expect(base).not.toMatch(/"DOM"/);
    expect(core).toMatch(/"types"\s*:\s*\[\s*\]/);
  });
});
