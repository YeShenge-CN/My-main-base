/**
 * 演示文档：让交互界面上【六区都有东西可看】。
 *
 * 刻意让面板的几种状态同时出现，否则打开就是一片空，看不出界面到底有什么：
 *   - plot#1  有 drawOn（生长）+ tf.opacity / style.width 动画 → 控件上的蓝色"动画驱动"点
 *   - plot#1.style.width 被【用户】锁        → 实心锁（hard：AI 必须问）
 *   - plot#1.style.glow  被【AI】锁          → 空心锁（soft：可改但会覆盖动画）
 *   - 两个文字对象                            → 第二图层、屏幕空间文字
 *   - 相机三个关键帧、两个 marker              → 时间轴上多条轨道
 *   - 【两个镜头】+ plot#2 只属于第二镜        → 时间轴上的镜头泳道
 *
 * ★ plot#2 的存在是为了让"按镜头过滤"这件事【看得见】：
 *   第一镜 [0,4) 看不到它，第二镜 [4,8) 看得到。
 *   如果预览不过滤，两个镜头的内容会叠在一起（那正是修掉的那个 bug）。
 *
 * 待批准提案【不】写进文档：提案是引擎判定锁冲突的产物，由面板里的一次
 * applyAgentCommand 现场产生（见 README 的"看一眼提案"）。
 *
 * 纯 JSON 写出，不 import 任何 TS —— 这个脚本要能直接 node 跑。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(from) {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

const ROOT = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
const OUT = join(ROOT, 'out', 'panel-demo.json');

const doc = {
  schemaVersion: 3,
  docVersion: 0,
  meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 8, seed: 1234 },
  theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
  layers: [
    { id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1', 'plot#2'] },
    { id: 'annot', depth: 0.5, order: 2, parallax: 1, objects: ['text#1', 'text#2'] },
  ],
  objects: {
    'plot#1': {
      shape: 'plot2d',
      owner: { kind: 'global' },
      params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
      style: {
        stroke: { v: '#4ea1ff' },
        width: { v: 4, min: 0.5, max: 10, step: 0.5 },
        glow: { v: 0.6, min: 0, max: 1, step: 0.05 },
      },
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {
        'tf.opacity': { kind: 'keys', keys: [{ t: 0, v: 0 }, { t: 1.2, v: 1, ease: 'easeOutCubic' }] },
        'style.width': { kind: 'expr', expr: '3+clamp(t,0,2)' },
      },
      effects: ['eff#1'],
    },
    'text#1': {
      shape: 'text',
      owner: { kind: 'global' },
      params: { content: { v: '正弦曲线 sin(x)' } },
      style: { size: { v: 36 }, fill: { v: '#e8eef8' } },
      tf: { x: 0, y: 3.4, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {},
      effects: [],
    },
    'text#2': {
      shape: 'text',
      owner: { kind: 'global' },
      params: { content: { v: 'Simp Video Agent · 编辑器' } },
      style: { size: { v: 18 }, fill: { v: '#7fb2ff' } },
      tf: { x: 0, y: -3.6, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {},
      effects: [],
    },
    // 只属于第二镜：用来在实机上证明"预览按镜头过滤"
    'plot#2': {
      shape: 'plot2d',
      owner: { kind: 'scene', sceneId: 's#2', bornAt: 4 },
      params: { expr: { v: '2*cos(x)*exp(-x*x/9)' }, domain: { v: [-7, 7] }, samples: { v: 2400 } },
      style: {
        stroke: { v: '#ffb454' },
        width: { v: 3, min: 0.5, max: 10, step: 0.5 },
        glow: { v: 0.4, min: 0, max: 1, step: 0.05 },
      },
      tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
      anim: {
        'tf.opacity': { kind: 'keys', keys: [{ t: 4, v: 0 }, { t: 5.2, v: 1, ease: 'easeOutCubic' }] },
      },
      effects: [],
    },
  },
  effects: {
    'eff#1': {
      type: 'drawOn',
      target: 'plot#1',
      params: { start: { v: 0.2 }, duration: { v: 2.5 }, mode: { v: 'arc' }, tip: { v: true } },
    },
  },
  camera: {
    keys: [
      { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0], ease: 'easeInOutCubic' },
      { t: 4, tx: 0.8, ty: 0, scale: 1.5, rotate: 0, pivot: [0, 0] },
      { t: 8, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] },
    ],
  },
  markers: [{ id: 'intro', t: 0 }, { id: 'peak', t: 2.7 }],
  /**
   * 两个镜头。[0,4) 与 [4,8) —— 首尾相接（A1：某镜结束 = 下一镜起点）。
   * ★ 没有镜头表的话面板就不画镜头泳道，而且预览不过滤 ——
   *   这份演示文档存在的意义之一就是让那条路径也被实机看到。
   */
  scenes: [
    { id: 's#1', name: '第一镜 · 正弦', bornAt: 0 },
    { id: 's#2', name: '第二镜 · 波包', bornAt: 4 },
  ],
  locks: {
    'plot#1.style.width': { by: 'user', at: 1 },
    'plot#1.style.glow': { by: 'ai', at: 2 },
  },
  audioTracks: [],
  captionTracks: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2));
console.log('已写出 ' + OUT);
console.log('对象 ' + Object.keys(doc.objects).length + '，效果 ' + Object.keys(doc.effects).length + '，锁 ' + Object.keys(doc.locks).length);
