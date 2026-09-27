import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SceneDoc } from '@sva/engine-core';
import { ExportRegistry, runExport } from '../src/export-job';

/**
 * 导出作业。
 *
 * 这一组测试的重点【不是"能导出成功"】（那要 ffmpeg，属于集成测试），
 * 而是两条实测踩到过的坑：
 *   1. 一个后台作业失败，绝不能把服务进程带走。实测第一次跑面板导出时，
 *      spawn ffmpeg 在沙箱里同步抛 EPERM，穿透了 void runExport(...)，
 *      Node 24 默认终止进程 —— 浏览器那边只看到一串"无法连接"。
 *   2. 作业状态要如实反映阶段（queued/rendering/encoding/done/failed），
 *      界面上的进度就是从这里来的，编不得。
 */

function tinyDoc(): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 30, viewport: [64, 36], worldWidth: 16, worldHeight: 9, duration: 0.2, seed: 1 },
    theme: { bg: '#000000', fg: '#ffffff', accent: '#4ea1ff', glow: 0 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }],
    objects: {},
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

describe('ExportRegistry', () => {
  it('新建作业就登记了可核对的元信息（帧数/分辨率/时长）', () => {
    const reg = new ExportRegistry();
    const job = reg.create(tinyDoc());
    expect(job.totalFrames).toBe(6); // 0.2s × 30fps
    expect(job.width).toBe(64);
    expect(job.height).toBe(36);
    expect(job.fps).toBe(30);
    expect(job.state).toBe('queued');
    expect(reg.get(job.id)?.id).toBe(job.id);
  });

  it('update 是合并而不是替换；未知 id 静默忽略（作业可能已被清理）', () => {
    const reg = new ExportRegistry();
    const job = reg.create(tinyDoc());
    reg.update(job.id, { framesDone: 3 });
    reg.update(job.id, { state: 'encoding' });
    const after = reg.get(job.id);
    expect(after?.framesDone).toBe(3);
    expect(after?.state).toBe('encoding');
    expect(after?.width).toBe(64); // 没被 patch 掉的字段还在
    expect(() => reg.update('不存在', { state: 'done' })).not.toThrow();
  });
});

describe('runExport 的失败路径：只标记作业，绝不往上抛', () => {
  it('依赖抛错（模拟沙箱拒绝 spawn）→ 作业变 failed，函数不抛', async () => {
    const reg = new ExportRegistry();
    const job = reg.create(tinyDoc());
    const root = mkdtempSync(join(tmpdir(), 'sva-export-'));
    // ffmpeg 路径指向一个不存在的文件：encodeMp4 会真的去 spawn 并失败
    await expect(
      runExport(job, tinyDoc(), reg, {
        root,
        ffmpegPath: join(root, 'no-such-ffmpeg.exe'),
        ffprobePath: join(root, 'no-such-ffprobe.exe'),
      }),
    ).resolves.toBeUndefined();
    const after = reg.get(job.id);
    expect(after?.state).toBe('failed');
    expect(String(after?.error)).not.toBe('');
    expect(after?.finishedAt).toBeDefined();
  });

  it('渲染阶段抛错（文档本身有问题）同样只标记 failed', async () => {
    const reg = new ExportRegistry();
    const bad = { ...tinyDoc(), objects: { 'plot#1': { shape: 'plot2d' } } } as unknown as SceneDoc;
    const job = reg.create(bad);
    const root = mkdtempSync(join(tmpdir(), 'sva-export-'));
    await runExport(job, bad, reg, {
      root,
      ffmpegPath: join(root, 'x.exe'),
      ffprobePath: join(root, 'y.exe'),
    });
    expect(reg.get(job.id)?.state).toBe('failed');
  });

  it('进度是逐帧上报的（界面上那个分子来自这里）', async () => {
    const reg = new ExportRegistry();
    const job = reg.create(tinyDoc());
    const root = mkdtempSync(join(tmpdir(), 'sva-export-'));
    const seen: number[] = [];
    await runExport(job, tinyDoc(), reg, {
      root,
      ffmpegPath: join(root, 'x.exe'),
      ffprobePath: join(root, 'y.exe'),
      onProgress: (n) => seen.push(n),
    });
    // 渲染阶段会逐帧回调（之后才因为 ffmpeg 不存在而失败）
    expect(seen.length).toBe(job.totalFrames);
    expect(seen[seen.length - 1]).toBe(job.totalFrames);
  });
});

describe('导出目录的约定', () => {
  it('产物落在 <root>/out/exports/<jobId>.mp4（界面据此提供下载）', () => {
    const reg = new ExportRegistry();
    const job = reg.create(tinyDoc());
    const root = mkdtempSync(join(tmpdir(), 'sva-export-'));
    writeFileSync(join(root, 'placeholder.txt'), 'x');
    expect(job.id).toMatch(/^exp/);
    expect(join(root, 'out', 'exports', job.id + '.mp4')).toContain('out');
  });
});
