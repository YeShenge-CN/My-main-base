/**
 * 导出作业：把一份 Scene Doc 渲成 MP4。
 *
 * ★ 为什么放在服务端而且必须是【异步作业】：
 *   一次导出要几十秒到几分钟（逐帧渲染 + 编码），HTTP 请求扛不住这么久。
 *   所以 API 只做两件事：提交作业（立刻返回 id）、查作业状态。
 *   进度是【真的帧计数】，不是假动画 —— 界面上的百分比来自这里。
 *
 * ★ 渲染后端用的是 @napi-rs/canvas，与浏览器预览同一份 evaluate + paintScene。
 *   （engine-node 还有一条走 Chrome 截图的导出路径，那条保真度更高但要拉浏览器；
 *     导出精度/一致性的取舍见 docs 里的 Level A/B 测试。这里选无浏览器那条：
 *     面板里点一下就能出片，不该要求用户先起 Chrome。）
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SceneDoc } from '@sva/engine-core';
import { planShotFrames, type ShotFrame, type ShotTimeline } from '@sva/engine-core';
import { renderFrames } from '@sva/engine-node/headless';
import { encodeMp4, probeVideo } from '@sva/engine-node/encode';

export type ExportState = 'queued' | 'rendering' | 'encoding' | 'done' | 'failed';

/**
 * 渲染后端。
 *
 *   canvas  @napi-rs/canvas 逐帧画（默认）。快、不需要浏览器。
 *   chrome  逐帧拉 Chrome 截图（engine-node 的 preview.html）。慢得多，
 *           但走的是真正的浏览器：自托管字体、真实的文字栅格化。
 *
 * ★ 两条路共用同一份 evaluate + paintScene，所以"画什么"是一样的；
 *   差异只在栅格化。选 chrome 的理由是保真，选 canvas 的理由是省事。
 */
export type ExportBackend = 'canvas' | 'chrome';

export interface ExportJob {
  readonly id: string;
  readonly state: ExportState;
  readonly totalFrames: number;
  readonly framesDone: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration: number;
  readonly backend: ExportBackend;
  /** 出错时的原因（state=failed 才有）。 */
  readonly error?: string;
  /** 成功后：文件路径与字节数。 */
  readonly outPath?: string;
  readonly bytes?: number;
  /** ffprobe 回读的真实帧数/时长 —— 用它验证"导出的确实是这一镜"，而不是假定。 */
  readonly verified?: { readonly nbFrames: number; readonly duration: number; readonly fps: number };
  /** 编码走的哪条路（pipe / files）。沙箱拒绝管道时会是 files。 */
  readonly encodeMode?: 'pipe' | 'files';
  readonly startedAt: number;
  readonly finishedAt?: number;
}

/** 一次 Chrome 渲染的结果（只取我们要的部分，避免把 Chrome 类型带进这个模块）。 */
export interface ChromeFrames {
  readonly pngs: ReadonlyMap<number, Buffer>;
  readonly chromeVersion: string;
}

export interface ExporterDeps {
  readonly root: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /**
   * Chrome 渲染器，由宿主注入（服务端那一层）。
   *
   * ★ 注入而不是直接 import：这条路径会拉起浏览器、需要 puppeteer 与 DOM 类型，
   *   而"导出作业"这个模块只该管状态机与编码。谁有能力提供浏览器，谁注入。
   */
  readonly chromeRender?: (
    doc: SceneDoc,
    frames: readonly ShotFrame[],
  ) => Promise<ChromeFrames>;
  /** 每帧渲染完之后回调一次（进度上报）。 */
  readonly onProgress?: (framesDone: number) => void;
}

/** ffmpeg / ffprobe 的默认位置（out/tools 下那份静态构建）。 */
export function defaultFfmpegPaths(root: string): { ffmpeg: string; ffprobe: string } {
  const bin = join(root, 'out', 'tools', 'ffmpeg-9.0.2-essentials_build', 'bin');
  return { ffmpeg: join(bin, 'ffmpeg.exe'), ffprobe: join(bin, 'ffprobe.exe') };
}

/**
 * 一帧一帧地渲，边渲边报进度。
 *
 * ★ 帧网格与"这一帧属于哪一镜"全部来自 engine-core 的 planShotFrames ——
 *   这里【不再】自己算 frameCount / t。以前那两处各算一遍，
 *   加多镜头时"成片帧数"和"渲染帧数"就有分叉的风险。
 *
 * 刻意【不】一次性渲染全部帧再编码：那样内存里会同时躺几百张 PNG
 * （1080p 一帧就几 MB），而且中途没有任何进度可报。
 */
export function renderAllFrames(
  doc: SceneDoc,
  onFrame: (index: number, total: number, png: Buffer) => void,
  plan: ShotTimeline = planShotFrames(doc),
): { readonly total: number } {
  const total = plan.frameCount;
  /**
   * ★ 没有镜头表时【不下传】sceneId：那是单镜头旧行为，全片就一镜，
   *   过滤没有任何信息可依据。不下传能让像素与加多镜头之前**逐字节相同** ——
   *   这是"多镜头是能力、不是对既有管线改造"的可执行证据。
   */
  const useScenes = plan.shots.length > 0;
  for (const shotFrame of plan.frames) {
    const opts = useScenes ? { sceneId: shotFrame.sceneId } : {};
    const frames = renderFrames(doc, [shotFrame.t], opts);
    const png = frames[0]?.png;
    if (png === undefined) throw new Error('第 ' + shotFrame.frame + ' 帧渲染失败');
    onFrame(shotFrame.frame, total, png);
  }
  return { total };
}

/** 作业登记表：内存里，进程重启即清空（导出产物本身留在磁盘上）。 */
export class ExportRegistry {
  private readonly jobs = new Map<string, ExportJob>();
  private seq = 0;

  create(doc: SceneDoc, backend: ExportBackend = 'canvas'): ExportJob {
    const id = 'exp' + Date.now().toString(36) + '-' + (this.seq += 1);
    const plan = planShotFrames(doc);
    const job: ExportJob = {
      id,
      state: 'queued',
      totalFrames: plan.frameCount,
      framesDone: 0,
      width: doc.meta.viewport[0],
      height: doc.meta.viewport[1],
      fps: doc.meta.fps,
      duration: doc.meta.duration,
      backend,
      startedAt: Date.now(),
    };
    this.jobs.set(id, job);
    return job;
  }

  update(id: string, patch: Partial<ExportJob>): void {
    const cur = this.jobs.get(id);
    if (cur === undefined) return;
    this.jobs.set(id, { ...cur, ...patch });
  }

  get(id: string): ExportJob | undefined {
    return this.jobs.get(id);
  }

  list(): readonly ExportJob[] {
    return [...this.jobs.values()];
  }
}

/**
 * 跑一个导出作业（调用方不 await，交给它自己跑完）。
 *
 * 全程把状态写回 registry，所以界面能看到"正在渲染第 N/M 帧"
 * 与"正在编码"这两个阶段 —— 它们耗时占比差别很大，混成一句"导出中"
 * 会让人以为卡住了。
 */
export async function runExport(
  job: ExportJob,
  doc: SceneDoc,
  registry: ExportRegistry,
  deps: ExporterDeps,
): Promise<void> {
  const outDir = join(deps.root, 'out', 'exports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, job.id + '.mp4');
  const workDir = join(deps.root, 'out', 'exports', job.id + '-work');

  try {
    registry.update(job.id, { state: 'rendering' });
    /**
     * ★ 帧计划在这里算【一次】，两条后端共用。
     *   它同时决定了"总帧数""每帧的时刻""每帧属于哪一镜"。
     */
    const plan = planShotFrames(doc);
    let pngs: readonly Buffer[];

    if (job.backend === 'chrome') {
      if (deps.chromeRender === undefined) {
        throw new Error('这个服务没有配置浏览器渲染（chromeRender 未注入）');
      }
      const result = await deps.chromeRender(doc, plan.frames);
      let done = 0;
      pngs = plan.frames.map((f) => {
        const png = result.pngs.get(f.frame);
        if (png === undefined) throw new Error('第 ' + f.frame + ' 帧没有回来');
        done += 1;
        registry.update(job.id, { framesDone: done });
        deps.onProgress?.(done);
        return png;
      });
    } else {
      const collected: Buffer[] = [];
      renderAllFrames(
        doc,
        (index, _total, png) => {
          collected.push(png);
          registry.update(job.id, { framesDone: index + 1 });
          deps.onProgress?.(index + 1);
        },
        plan,
      );
      pngs = collected;
    }

    registry.update(job.id, { state: 'encoding' });
    const encoded = await encodeMp4({
      frames: pngs,
      fps: doc.meta.fps,
      outPath,
      ffmpegPath: deps.ffmpegPath,
      workDir,
    });

    // 回读真实结果：帧数与时长必须与文档一致，否则"导出成功"是假的
    const probed = await probeVideo(deps.ffprobePath, outPath);
    const bytes = statSync(outPath).size;
    registry.update(job.id, {
      state: 'done',
      outPath,
      bytes,
      encodeMode: encoded.mode,
      verified: { nbFrames: probed.nbFrames, duration: probed.duration, fps: probed.fps },
      finishedAt: Date.now(),
    });
  } catch (err) {
    registry.update(job.id, {
      state: 'failed',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
  }
}

/** 兜底：把某一帧的 PNG 落盘（失败排查时想看第 N 帧长什么样）。 */
export function dumpFrame(dir: string, index: number, png: Buffer): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'frame-' + String(index).padStart(5, '0') + '.png');
  writeFileSync(path, png);
  return path;
}
