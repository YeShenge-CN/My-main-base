// ESLint 扁平配置（ESLint 9）。
//
// 这个文件的核心职责只有一个：把"engine-core 必须宿主无关"（规范 §2 不变量 1）
// 从一条口头约定变成一条机器可执行的规则。任何人（包括 AI）在 engine-core 里
// 访问 DOM 或 Node 能力，lint 必须红。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** engine-core 禁止访问的宿主全局。 */
const BANNED_HOST_GLOBALS = [
  // DOM
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'CanvasRenderingContext2D',
  'OffscreenCanvas',
  'ImageBitmap',
  'ImageData',
  'Image',
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
  'screen',
  'fetch',
  // 非确定性时钟 / 随机源
  'performance',
  'Date',
];

/** engine-core 禁止 import 的模块（Node 能力、渲染框架、渲染后端）。 */
const BANNED_HOST_IMPORTS = [
  'node:*',
  'fs',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'canvas',
  'skia-canvas',
  'puppeteer',
  'jsdom',
  'sharp',
  'react',
  'react-dom',
  'zustand',
];

const HOST_FREE_MESSAGE =
  'engine-core 必须宿主无关：禁止访问 DOM / Node / 渲染框架（规范 §2 不变量 1）。' +
  '这类能力只能出现在 engine-render / engine-node / panel 里。';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.pnpm-store/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 类型检查交给 tsc；no-undef 在 TS 里会误报类型名与全局类型
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
    },
  },

  {
    // 构建/工具脚本：Node ESM，需要一组宿主全局
    files: ['**/*.mjs', '**/*.cjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },

  {
    // ★ 不变量 1 的执行机构
    files: ['packages/engine-core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...BANNED_HOST_GLOBALS.map((name) => ({ name, message: HOST_FREE_MESSAGE })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: HOST_FREE_MESSAGE },
        { object: 'Date', property: 'now', message: HOST_FREE_MESSAGE },
        { object: 'performance', property: 'now', message: HOST_FREE_MESSAGE },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'NewExpression[callee.name="Date"]', message: HOST_FREE_MESSAGE },
        { selector: 'MemberExpression[object.name="globalThis"]', message: HOST_FREE_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: BANNED_HOST_IMPORTS, message: HOST_FREE_MESSAGE }],
        },
      ],
    },
  },
);
