/**
 * engine-node 的【纯编码半边】：帧时序 + ffmpeg 编码 + ffprobe 回读。
 *
 * ★ 与 export.ts 分开的理由和 headless/screenshot/internal 一样：
 *   export.ts 里还有"逐帧拉 Chrome 截图"那条腿（renderFramesWithChrome），
 *   它的 page.evaluate 回调需要 DOM 类型。于是任何只想用 ffmpeg 的宿主
 *   （面板的导出按钮、CLI）都会被 DOM 类型连坐 —— 实测就是这样：
 *   从 agent-tools 的 src（刻意无 DOM）import '/export' 立刻报 window 找不到。
 *
 * 这里只依赖 node 与 ffmpeg，不碰浏览器。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** t = frame / fps。这是导出里唯一产生时间的公式。 */
export function frameTime(frame: number, fps: number): number {
  return frame / fps;
}

/** 总帧数：四舍五入成整数，保证 MP4 的帧数与时长都精确。 */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}

export function allFrames(duration: number, fps: number): readonly number[] {
  const n = frameCount(duration, fps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

export function ffmpegPipeArgs(outPath: string, fps: number, frames: number): readonly string[] {
  return [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-frames:v', String(frames),
    outPath,
  ];
}

export function ffmpegFileArgs(pattern: string, outPath: string, fps: number, frames: number): readonly string[] {
  return [
    '-y',
    '-framerate', String(fps),
    '-i', pattern,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-frames:v', String(frames),
    outPath,
  ];
}

/**
 * 跑一个子进程。
 *
 * ★ 必须 try/catch 包住 spawn：在受限沙箱里，**带管道 stdio 的 spawn 是
 *   【同步抛】** EPERM，而不是走 'error' 事件。实测（本机）：
 *     stdio:['pipe','ignore','pipe']  → SYNC_THROW EPERM
 *     stdio:'ignore'                  → 正常，exit=0
 *   不包的话异常会穿透 Promise executor 变成调用方看不见的抛出，
 *   最终把整个服务进程带走（第一次跑面板导出就是这么死的）。
 *
 * ★ 诊断信息落文件而不是管道：管道正是被禁的东西。出问题时去读 stderrFile。
 */
async function run(
  cmd: string,
  args: readonly string[],
  feed: readonly Buffer[] | null,
  opts: { readonly pipeStdin: boolean; readonly stderrFile?: string },
): Promise<void> {
  const stdio: ('pipe' | 'ignore' | number)[] = [
    opts.pipeStdin ? 'pipe' : 'ignore',
    'ignore',
    opts.stderrFile === undefined ? 'ignore' : openSync(opts.stderrFile, 'w'),
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, [...args], { stdio: stdio as never });
      } catch (err) {
        reject(err as Error);
        return;
      }
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          let detail = '';
          if (opts.stderrFile !== undefined) {
            try {
              detail = readFileSync(opts.stderrFile, 'utf8').slice(-2000);
            } catch {
              detail = '(读不到 stderr 文件)';
            }
          }
          reject(new Error(cmd + ' 退出码 ' + String(code) + '\n' + detail));
        }
      });
      if (opts.pipeStdin && feed !== null) {
        for (const buf of feed) child.stdin?.write(buf);
        child.stdin?.end();
      }
    });
  } finally {
    const errFd = stdio[2];
    if (typeof errFd === 'number') closeSync(errFd);
  }
}

export interface EncodeResult {
  readonly mode: 'pipe' | 'files';
  readonly bytes: number;
}

/**
 * 编码 MP4。
 *
 * 优先走 image2pipe（stdin 灌 PNG）。但受限沙箱里【带管道 stdio 的 spawn 同步抛 EPERM】，
 * 所以失败就退回到"写 PNG 序列 + -i pattern"的文件模式（结果一样，只是慢一点，
 * 而且把 stderr 导到文件以便出错时能看到原因）。两条路的仲裁就在这里，调用方不用管。
 */
export async function encodeMp4(opts: {
  readonly frames: readonly Buffer[];
  readonly fps: number;
  readonly outPath: string;
  readonly ffmpegPath: string;
  readonly workDir: string;
  readonly mode?: 'pipe' | 'files';
}): Promise<EncodeResult> {
  mkdirSync(opts.workDir, { recursive: true });
  const wanted = opts.mode ?? 'pipe';

  if (wanted === 'pipe') {
    try {
      await run(opts.ffmpegPath, ffmpegPipeArgs(opts.outPath, opts.fps, opts.frames.length), opts.frames, {
        pipeStdin: true,
      });
      return { mode: 'pipe', bytes: opts.frames.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // EPERM（沙箱禁管道）与 ENOENT（没有 ffmpeg）都要能退，退不动就往上抛
      if (!msg.includes('EPERM') && !msg.includes('ENOENT')) throw err;
    }
  }

  const dir = join(opts.workDir, 'png');
  mkdirSync(dir, { recursive: true });
  opts.frames.forEach((buf, i) => {
    writeFileSync(join(dir, 'frame-' + String(i).padStart(5, '0') + '.png'), buf);
  });
  const pattern = join(dir, 'frame-%05d.png');
  await run(opts.ffmpegPath, ffmpegFileArgs(pattern, opts.outPath, opts.fps, opts.frames.length), null, {
    pipeStdin: false,
    stderrFile: join(opts.workDir, 'ffmpeg-stderr.txt'),
  });
  return { mode: 'files', bytes: opts.frames.length };
}

/** 用 ffprobe 读回真实结果，用来验证"帧数与时长精确"。 */
/**
 * 用 ffprobe 读回真实结果，用来验证"帧数与时长精确"。
 *
 * ★ 结果让它【直接写文件】（ffprobe 支持 `-o <file>`），不走 stdout：
 *   沙箱里带管道 stdio 的 spawn 同步抛 EPERM，而 stdout 管道正是最常用的那种。
 */
export async function probeVideo(
  ffprobePath: string,
  file: string,
): Promise<{ nbFrames: number; duration: number; width: number; height: number; fps: number }> {
  const outFile = file + '.probe.json';
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        ffprobePath,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=nb_frames,duration,width,height,r_frame_rate',
          '-of', 'json',
          '-o', outFile,
          file,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] },
      );
    } catch (err) {
      reject(err as Error);
      return;
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('ffprobe 退出码 ' + String(code)));
        return;
      }
      try {
        resolve(parseProbeJson(readFileSync(outFile, 'utf8')));
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

function parseProbeJson(out: string): { nbFrames: number; duration: number; width: number; height: number; fps: number } {
  const parsed = JSON.parse(out) as {
    streams?: { nb_frames?: string; duration?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const s = parsed.streams?.[0] ?? {};
  const rate = (s.r_frame_rate ?? '0/1').split('/');
  const num = Number(rate[0] ?? 0);
  const den = Number(rate[1] ?? 1) || 1;
  return {
    nbFrames: Number(s.nb_frames ?? 0),
    duration: Number(s.duration ?? 0),
    width: s.width ?? 0,
    height: s.height ?? 0,
    fps: num / den,
  };
}
