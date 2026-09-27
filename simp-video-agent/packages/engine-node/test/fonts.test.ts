/**
 * headless 渲染的字体注册 + 后端一致性守卫。
 *
 * 这两件事放在同一个文件里，因为它们回答的是同一个问题的一半：
 *   "同一帧在两条后端上渲染出来，到底是不是同一个东西？"
 * 字体那一半是 **必须逐字节相同** 的（度量、字形、位置）；
 * 栅格化那一半允许有抗锯齿级别的差异（实测数据见 docs/backend-parity.md）。
 */
import { describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { SceneDoc, SceneObject } from '@sva/engine-core';
import {
  HEADLESS_FONT_STACK,
  assertFontsRegistered,
  defaultFontsDir,
  registerHeadlessFonts,
  renderFrames,
} from '../src/render';

const meta: SceneDoc['meta'] = {
  fps: 30,
  viewport: [320, 180],
  worldWidth: 16,
  worldHeight: 9,
  duration: 0.2,
  seed: 1,
};

function textDoc(content: string, size = 48): SceneDoc {
  const obj: SceneObject = {
    shape: 'text',
    owner: { kind: 'global' },
    params: { content: { v: content } },
    style: { size: { v: size }, fill: { v: '#ffffff' } },
    tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
    anim: {},
    effects: [],
  };
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta,
    theme: { bg: '#000000', fg: '#ffffff', accent: '#ffffff', glow: 0 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['text#1'] }],
    objects: { 'text#1': obj },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [],
    locks: {},
    audioTracks: [],
    captionTracks: [],
  };
}

describe('headless 的字体注册', () => {
  it('字体目录能自动找到，且三个字体文件都在', () => {
    const dir = defaultFontsDir();
    expect(dir).toContain('engine-render');
    const r = registerHeadlessFonts(dir);
    expect(r.missing).toEqual([]);
    expect(r.registered).toContain('SvaInter');
    expect(r.registered).toContain('SvaNotoCJK');
    // 希腊字母与数学符号：实测 2π 曾经画成豆腐块（前两个子集都不含希腊字母）
    expect(r.registered).toContain('SvaMath');
  });

  it('注册之后 GlobalFonts 里真的能查到这两个族（否则注册了也不会被用上）', () => {
    registerHeadlessFonts();
    const families = GlobalFonts.families.map((f) => f.family);
    expect(families).toContain('SvaInter');
    expect(families).toContain('SvaNotoCJK');
    expect(families).toContain('SvaMath');
  });

  it('assertFontsRegistered 在注册过之后不抛', () => {
    registerHeadlessFonts();
    expect(() => assertFontsRegistered()).not.toThrow();
  });

  it('★ 中文用的是真字形，不是系统回退字体', () => {
    // 这是那个"确定性地基缺口"的回归断言。
    // 实测：48px 字号下"正弦"的宽度，注册后 96px（每字 48），
    // 未注册（回退字体）48px（每字 24）—— 差一倍。
    registerHeadlessFonts();
    const ctx = createCanvas(600, 120).getContext('2d');
    ctx.font = '48px SvaNotoCJK';
    const cjkWidth = ctx.measureText('正弦').width;
    expect(cjkWidth).toBeCloseTo(96, 0);
    // 拉丁也要走自己的族，而不是任何系统的 sans-serif
    ctx.font = '48px SvaInter';
    const latin = ctx.measureText('sin').width;
    expect(latin).toBeGreaterThan(50);
  });

  it('★ 数学字体真的覆盖希腊字母（π 不是豆腐块）', () => {
    // 判据取度量而不是「像素看起来像不像」：豆腐块也有宽度，
    // 但真正的 π 在 48px 下宽度落在合理的窄区间里（希腊字母不是全角）。
    registerHeadlessFonts();
    const ctx = createCanvas(600, 120).getContext('2d');
    ctx.font = '48px SvaMath';
    const pi = ctx.measureText('π').width;
    expect(pi, 'π 量不出宽度，说明字体没覆盖').toBeGreaterThan(10);
    expect(pi).toBeLessThan(48);
    expect(ctx.measureText('∑').width).toBeGreaterThan(10);
  });

  it('★ 粗体用的是【真的 700 字面】而不是栅格化器合成', () => {
    // 判据取"注册表里这个族有哪些字重"，而不是"量出来宽不宽"：
    // CJK 的 400 与 700 字宽【一样】（都是全角），合成粗体的宽度也一样 ——
    // 靠度量分不出真假。而 families[].styles 直接告诉你哪些字重真的被注册了。
    registerHeadlessFonts();
    const cjk = GlobalFonts.families.find((f) => f.family === 'SvaNotoCJK');
    const latin = GlobalFonts.families.find((f) => f.family === 'SvaInter');
    expect(cjk?.styles.some((s) => s.weight === 700), 'SvaNotoCJK 缺 700 字重').toBe(true);
    expect(latin?.styles.some((s) => s.weight === 700), 'SvaInter 缺 700 字重').toBe(true);
  });

  it('★ 字体栈里必须有 SvaMath（栈与注册表分叉 = 缺字静默回到系统字体）', () => {
    expect(HEADLESS_FONT_STACK).toContain('SvaMath');
  });

  it('renderFrames 会自动注册字体（调用方不该需要记得这件事）', () => {
    const frames = renderFrames(textDoc('正弦'), [0]);
    expect(frames.length).toBe(1);
    // 有真字形时，白字会占掉相当数量的像素；回退字形会明显不同
    expect(frames[0]?.png.length).toBeGreaterThan(1000);
  });

  it('同一份文档渲染两次逐字节相同（确定性没有因为字体注册而变差）', () => {
    const a = renderFrames(textDoc('正弦 sin(x)'), [0])[0]?.sha256;
    const b = renderFrames(textDoc('正弦 sin(x)'), [0])[0]?.sha256;
    expect(a).toBe(b);
  });

  it('同一族名在同一进程里拿到的是同一套度量（幂等注册）', () => {
    registerHeadlessFonts();
    registerHeadlessFonts();
    const ctx = createCanvas(400, 100).getContext('2d');
    ctx.font = '32px SvaNotoCJK';
    expect(ctx.measureText('信号采样').width).toBeCloseTo(128, 0);
  });
});
