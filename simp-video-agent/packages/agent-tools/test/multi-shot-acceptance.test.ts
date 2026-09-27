/**
 * 多 Agent 端到端验收：两个场景 Agent 串行跑，各自在自己那一镜画出东西。
 *
 * 默认跳过（真调模型、要花钱）：
 *   SVA_ACCEPTANCE=1 pnpm test
 *
 * ★ 为什么必须有这一条：引擎侧的单测只能证明"scope 生效、归属落对、composite 分开"
 *   （见 test/multi-shot.test.ts）。它证明不了**模型在这个身份下真的能干活** ——
 *   而多 Agent 的全部风险恰恰在那里：模型可能
 *     · 不知道自己在哪一镜（提示词没给边界）→ 写成全片口径；
 *     · 试图改片长 / 镜头表（越权）→ 被引擎拒，然后卡住；
 *     · 把对象建成 shared / global（绕过归属兜底）。
 *   这三件事只有真跑一次才知道。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { objectTimeWindow, planShotFrames, validate, type SceneDoc, type SceneObject } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node';
import { runMultiShot } from '../src/multi-shot';

const ENABLED = process.env['SVA_ACCEPTANCE'] === '1';

function apiKey(): string {
  const raw = readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  if (line === undefined) throw new Error('缺少 DEEPSEEK_API_KEY');
  return line.slice('DEEPSEEK_API_KEY='.length).trim();
}

/**
 * 两镜空文档：s#1 [0,6) · s#2 [6,12)，两个空图层。
 *
 * ★ 刻意从**空**开始：多 Agent 要证明的是"每个镜头的 Agent 能自己把内容建出来
 *   并落在正确的镜里"，预置内容会让这件事变得不可判定。
 */
function twoEmptyShots(): SceneDoc {
  const plot = (): SceneObject => ({
    shape: 'plot2d',
    owner: { kind: 'global' },
    params: { expr: { v: '0' }, domain: { v: [-7, 7] }, samples: { v: 400 } },
    style: { stroke: { v: '#4ea1ff' }, width: { v: 3 }, glow: { v: 0.3 } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  });
  // 占位对象只为让图层非空；真正的验收看 Agent 新建的对象归到哪一镜
  void plot;
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [480, 270], worldWidth: 16, worldHeight: 9, duration: 12, seed: 1234 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }],
    objects: {},
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [{ id: 'intro', t: 0 }],
    scenes: [
      { id: 's#1', name: '第一镜', bornAt: 0 },
      { id: 's#2', name: '第二镜', bornAt: 6 },
    ],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

describe.skipIf(!ENABLED)('多 Agent 验收：逐镜串行', () => {
  it(
    '两个场景 Agent 各自把内容建在【自己那一镜】，且没有越权',
    async () => {
      const result = await runMultiShot({
        apiKey: apiKey(),
        doc: twoEmptyShots(),
        tasks: [
          { sceneId: 's#1', task: '画一条 y=sin(x) 的曲线，让它用 1.5 秒生长出来。' },
          { sceneId: 's#2', task: '画一条 y=cos(x) 的曲线，线宽 4。' },
        ],
        render: (d, ts) =>
          renderFrames(d, ts).map((f) => ({ t: f.t, pngBase64: f.png.toString('base64'), sha256: f.sha256 })),
        maxTurns: 12,
        onShotStart: (i) => console.log('[multi] 第 ' + i.index + '/' + i.total + ' 镜 ' + i.sceneId),
      });

      const doc = result.doc;
      for (const s of result.shots) {
        console.log(
          '[multi] ' + s.sceneId + ': 轮数=' + s.run.turns + ' 写入=' + s.agentOperations +
            ' 问题=' + s.issueCount + ' token=' + (s.run.usage.promptTokens + s.run.usage.completionTokens) +
            ' 收尾=' + (s.run.truncated ? '截断' : '正常'),
        );
      }
      console.log('[multi] 对象归属: ' + JSON.stringify(
        Object.entries(doc.objects).map(([id, o]) => [id, o.owner.kind === 'scene' ? o.owner.sceneId : o.owner.kind]),
      ));

      // 每个镜头都必须真的产出了内容
      expect(result.shots.length, '两个镜头都该跑过').toBe(2);
      for (const s of result.shots) {
        expect(s.agentOperations, s.sceneId + ' 一次写入都没有').toBeGreaterThan(0);
      }

      // ★ 归属：每个新建对象必须落在跑它的那一镜里
      const byScene = new Map<string, string[]>();
      for (const [id, o] of Object.entries(doc.objects)) {
        if (o.owner.kind !== 'scene') continue;
        const sid = o.owner.sceneId;
        const list = byScene.get(sid) ?? [];
        list.push(id);
        byScene.set(sid, list);
      }
      expect(byScene.get('s#1')?.length ?? 0, '第一镜没有对象').toBeGreaterThan(0);
      expect(byScene.get('s#2')?.length ?? 0, '第二镜没有对象').toBeGreaterThan(0);

      // ★ 对象的时间窗必须与它所属镜头对得上（不是游离到整片）
      for (const [id, o] of Object.entries(doc.objects)) {
        if (o.owner.kind !== 'scene') continue;
        const sid = o.owner.sceneId;
        const win = objectTimeWindow(doc, o);
        const shot = planShotFrames(doc).shots.find((x) => x.sceneId === sid);
        expect(shot, '对象 ' + id + ' 指向不存在的镜头').toBeDefined();
        expect(win[1], id + ' 的时间窗超出了它那一镜').toBeLessThanOrEqual(shot?.end ?? 0);
      }

      // ★ 没有越权：镜头表没被动过，片长没被改
      expect(doc.scenes.map((s) => s.id)).toEqual(['s#1', 's#2']);
      expect(doc.meta.duration).toBe(12);

      // 结束时不该有 error 级问题
      const errors = validate(doc).filter((i) => i.severity === 'error');
      expect(errors.map((e) => e.code)).toEqual([]);
    },
    900_000,
  );
});

describe.skipIf(ENABLED)('多 Agent 验收（未启用）', () => {
  it('默认跳过，需要 SVA_ACCEPTANCE=1', () => {
    expect(ENABLED).toBe(false);
  });
});
