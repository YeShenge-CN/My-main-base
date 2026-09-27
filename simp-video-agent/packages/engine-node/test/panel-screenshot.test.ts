import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '@sva/engine-core';
import { buildPreviewBundle } from '../src/bundle';
import { startStaticServer } from '../src/server';
import { screenshotUrl } from '../src/screenshot';

const ENABLED = process.env['SVA_EXPORT'] === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = join(ROOT, 'out');

/**
 * 演示文档：刻意让面板的三种状态【同时】出现。
 *   - plot#1.style.width 有动画轨道 → 蓝点
 *   - plot#1.style.glow  被用户锁   → 实心锁
 *   - plot#1.tf.opacity  被 AI 锁   → 空心锁
 *   - 其余字段                       → 白点
 */
function demoDoc(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 7,
    meta: { fps: 60, viewport: [640, 360], worldWidth: 16, worldHeight: 9, duration: 4, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [
      { id: 'main', depth: 1, order: 1, parallax: 0.5, objects: ['plot#1'] },
      { id: 'annot', depth: 0.5, order: 2, parallax: 1, objects: ['text#1', 'text#2'] },
    ],
    objects: {
      'plot#1': {
        shape: 'plot2d',
        owner: { kind: 'global' },
        params: { expr: { v: 'sin(x)' }, domain: { v: [-7, 7] }, samples: { v: 1200 } },
        style: {
          stroke: { v: '#4ea1ff' },
          width: { v: 3, min: 0.5, max: 10, step: 0.5 },
          glow: { v: 0.6 },
        },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: { 'style.width': { kind: 'expr', expr: '2 + 2.2*t*sin(2*t)' } },
        effects: ['eff#1'],
      },
      'text#1': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: '正弦曲线 sin(x)' } },
        style: { size: { v: 34 }, fill: { v: '#e8eef8' } },
        tf: { x: 0, y: 3.2, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
      'text#2': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: 'Simp Video Agent' } },
        style: { size: { v: 18 }, fill: { v: '#7fb2ff' } },
        tf: { x: 0, y: -3.6, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
    },
    effects: {
      'eff#1': {
        type: 'drawOn',
        target: 'plot#1',
        params: { start: { v: 0.2 }, duration: { v: 1.6 }, mode: { v: 'arc' }, tip: { v: true } },
      },
    },
    camera: {
      keys: [
        { t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0], ease: 'easeInOutCubic' },
        { t: 4, tx: 0.6, ty: 0, scale: 1.6, rotate: 0, pivot: [0, 0] },
      ],
    },
    markers: [{ id: 'intro', t: 0 }, { id: 'peak', t: 2 }],
    // 单镜头：空表 = 旧行为（全片一镜）
    scenes: [],
    locks: {
      'plot#1.style.glow': { by: 'user', at: 1 },
      'plot#1.tf.opacity': { by: 'ai', at: 2 },
    },
    audioTracks: [],
    captionTracks: [],
  };
}

describe.skipIf(!ENABLED)('P9 面板视觉验证', () => {
  it(
    '面板能真的渲染出来，并且六区都在',
    async () => {
      writeFileSync(join(OUT, 'panel-doc.json'), JSON.stringify(demoDoc(), null, 2));
      await buildPreviewBundle(
        join(ROOT, 'packages', 'panel', 'src', 'boot.ts'),
        join(OUT, 'panel-bundle.js'),
      );

      const server = await startStaticServer(ROOT);
      try {
        const result = await screenshotUrl({
          // 截图前做三件事：
          //   1. 让"AI"提一条会撞上 hard 锁的改动 —— 提案永远是引擎判定锁冲突的产物，
          //      不是面板凭空画的
          //   2. 从 t=1.8s 截屏：那个时刻 drawOn 已经画完，曲线是完整的；
          //      停在 t=0 只会截到一张几乎空白的图，看起来像面板坏了
          //   3. 记下画面指纹 —— "时间在走"和"画面在变"是两件事，动画必须证明后者
          //     （真正的推进由下面第二个页面用 500ms 计时器验证）
          prepare:
            'window.__PANEL__.applyAgentCommand(' +
            '{"op":"set_style","target":"plot#1","glow":0.1},' +
            '"投影仪上要看得清，把发光压下来");' +
            'window.__PLAY__ = window.__PANEL__.renderer();' +
            'window.__PLAY__.seek(1.8);',
          url: server.origin + '/packages/panel/index.html?doc=/out/panel-doc.json',
          outPath: join(OUT, 'panel.png'),
          width: 1280,
          height: 820,
          userDataDir: join(OUT, 'chrome-profile-panel'),
          probe: 'JSON.stringify({' +
            'rows: document.querySelectorAll("#inspector .row").length,' +
            'objects: document.querySelectorAll("#outline .obj").length,' +
            'lanes: document.querySelectorAll("#timeline .tl-label").length,' +
            'jcards: document.querySelectorAll("#journal .jcard").length,' +
            'pcards: document.querySelectorAll("#review .pcard").length,' +
            'badge: document.getElementById("pbadge").textContent,' +
            'proposedRows: document.querySelectorAll("#inspector .row-proposed").length,' +
            'diffs: document.querySelectorAll("#inspector .diff").length,' +
            'reasonDts: document.querySelectorAll("#review .preason dt").length,' +
            'animDots: document.querySelectorAll(".dot-anim").length,' +
            'hardLocks: document.querySelectorAll(".lock-hard").length,' +
            'softLocks: document.querySelectorAll(".lock-soft").length,' +
            'sections: ["#outline","#preview","#inspector","#timeline","#review","#journal"].filter(s=>document.querySelector(s)!==null).length,' +
            'stageW: document.getElementById("stage").width,' +
            'stageH: document.getElementById("stage").height,' +
            // 播放条必须真的在可视区域内：它被放进了一个 overflow:hidden 的容器，
            // "存在"和"看得见"是两件事，所以这里量的是几何。
            'transportH: document.getElementById("transport").getBoundingClientRect().height,' +
            'transportBottom: document.getElementById("transport").getBoundingClientRect().bottom,' +
            'viewportH: window.innerHeight,' +
            // 截图停在一个完整帧上（t=1.8s，drawOn 已完成）
            'frameA: window.__PLAY__.frame(),' +
            'playLabel: document.getElementById("play").textContent,' +
            'hashA: window.__PLAY__.frameHash(),' +
            'playBtn: document.getElementById("play").textContent' +
            '})',
        });

        // 播放中：再等一会儿，看帧号是否继续前进、画面是否继续变化
        const later = await (async () => {
          const after = await screenshotUrl({
            prepare: 'window.__PLAY__ = window.__PANEL__.renderer(); window.__PLAY__.seek(0); window.__PLAY__.play(true);',
            url: server.origin + '/packages/panel/index.html?doc=/out/panel-doc.json',
            outPath: join(OUT, 'panel-play.png'),
            width: 640,
            height: 480,
            userDataDir: join(OUT, 'chrome-profile-panel-play'),
            probe:
              'new Promise((resolve) => {' +
              '  const r = window.__PANEL__.renderer();' +
              '  r.seek(0);' +
              '  const f0 = r.frame(); const h0 = r.frameHash();' +
              '  r.play(true);' +
              '  setTimeout(() => {' +
              '    r.play(false);' +
              '    resolve(JSON.stringify({ f0, h0, f1: r.frame(), h1: r.frameHash(), playing: r.isPlaying(), total: r.totalFrames() }));' +
              '  }, 500);' +
              '})',
          });
          return after;
        })();

        const png = statSync(join(OUT, 'panel.png')).size;
        const probe = JSON.parse(String(result.probeResult)) as Record<string, number>;
        const play = JSON.parse(String(later.probeResult)) as Record<string, number | string | boolean>;
        console.log('[P9] 截图 ' + png + ' 字节，sha256=' + result.sha256.slice(0, 16) + '，chrome=' + result.chromeVersion);
        console.log('[P9] 面板结构=' + JSON.stringify(probe));
        console.log('[P9] 播放=' + JSON.stringify(play));
        for (const line of result.consoleLines) console.log('[P9][页面] ' + line);
        for (const line of later.consoleLines) console.log('[P9][页面·播放] ' + line);

        // 六个区都在
        expect(probe['sections']).toBe(6);
        // 大纲列出了三个对象
        expect(probe['objects']).toBe(3);
        // 控件确实从 registry 生成出来了
        expect(probe['rows']).toBeGreaterThan(10);
        // 时间轴有轨道标签
        expect(probe['lanes']).toBeGreaterThan(0);
        // ★ 预览画布的像素尺寸 == 导出像素（未乘 devicePixelRatio）
        expect(probe['stageW']).toBe(640);
        expect(probe['stageH']).toBe(360);
        // ★ 三态都在：动画蓝点、hard 锁、soft 锁
        expect(probe['animDots']).toBeGreaterThan(0);
        expect(probe['hardLocks']).toBe(1);
        expect(probe['softLocks']).toBe(1);
        // ★ P10 第 2 条：提案的三处呈现
        expect(probe['pcards']).toBe(1); // 审核队列里的审批卡
        expect(probe['badge']).toBe('1'); // 顶栏徽标计数
        expect(probe['proposedRows']).toBe(1); // 该字段琥珀高亮
        expect(probe['diffs']).toBe(1); // 且带 建议值 → 目标值 的 diff
        // ★ P10 第 3 条：四项理由全在卡上（当前值/目标值/画面变化/理由）
        expect(probe['reasonDts']).toBe(4);
        // ★ 播放控制条在
        expect(String(probe['playLabel'])).toContain('播放');
        expect(probe['frameA']).toBe(108); // t=1.8s × 60fps
        // ★ 它还必须【看得见】：高度非零、底边在视口内（容器是 overflow:hidden）
        expect(probe['transportH']).toBeGreaterThan(0);
        expect(probe['transportBottom']).toBeLessThanOrEqual(probe['viewportH'] as number);
        expect(probe['transportBottom']).toBeGreaterThan(0);

        // ★ 动画真的在动：500ms 内帧号前进，且两个时刻的【画面指纹不同】
        //   这条是"动画影响画面"在浏览器侧的端到端证据 ——
        //   单看帧号只能说明时间在走。
        const f0 = Number(play['f0']);
        const f1 = Number(play['f1']);
        expect(play['playing']).toBe(false); // 探针里已经暂停
        expect(f1).toBeGreaterThan(f0);
        expect(Number(play['total'])).toBe(240); // 4s × 60fps
        expect(String(play['h0'])).not.toBe('');
        expect(String(play['h0'])).not.toBe(String(play['h1']));

        // 页面里不能有未捕获异常，也不能有失败请求。
        // ★ 抓"任何一条 http 4xx/5xx 或 requestfailed"：少了这条，
        //   一个 404 的字体或资源会让画布静默退回替代字体，
        //   而截图看起来照样正常 —— 那正是确定性最容易被偷走的地方。
        expect(result.consoleLines.filter((l) => l.startsWith('[pageerror]'))).toEqual([]);
        expect(later.consoleLines.filter((l) => l.startsWith('[pageerror]'))).toEqual([]);
        expect(result.consoleLines.filter((l) => l.startsWith('[http ') || l.startsWith('[requestfailed]'))).toEqual([]);
        expect(png).toBeGreaterThan(20_000);
      } finally {
        await server.close();
      }
    },
    600_000,
  );
});

describe.skipIf(ENABLED)('P9 面板视觉验证（未启用）', () => {
  it('默认跳过，需要 SVA_EXPORT=1', () => {
    expect(ENABLED).toBe(false);
  });
});
