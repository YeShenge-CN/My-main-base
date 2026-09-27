/**
 * 工程文件（保存 / 打开）的纯规则。
 *
 * ★ 这一份的重点在【坏输入】：工程文件是要在人与人之间传的，
 *   拿到的可能是别的软件的 json、上一版的格式、或者被编辑器改坏的文件。
 *   每一种都要说清哪一步不对 —— 「打不开」是最没用的错误信息。
 */
import { describe, expect, it } from 'vitest';
import type { SceneDoc } from '@sva/engine-core';
import {
  PROJECT_CHAT_CAP,
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  PROJECT_HISTORY_CAP,
  buildProject,
  emptyContext,
  guessTitle,
  parseProject,
  projectFilename,
  projectToJson,
} from '../src/project';

function makeDoc(over: Partial<SceneDoc> = {}): SceneDoc {
  return {
    schemaVersion: 3,
    docVersion: 0,
    meta: { fps: 60, viewport: [960, 540], worldWidth: 16, worldHeight: 9, duration: 8, seed: 1 },
    theme: { bg: '#0b0e14', fg: '#e8eef8', accent: '#4ea1ff', glow: 0.6 },
    layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: ['text#1'] }],
    objects: {
      'text#1': {
        shape: 'text',
        owner: { kind: 'global' },
        params: { content: { v: '正弦曲线' } },
        style: { size: { v: 32 }, fill: { v: '#e8eef8' } },
        tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
        anim: {},
        effects: [],
      },
    },
    effects: {},
    camera: { keys: [{ t: 0, tx: 0, ty: 0, scale: 1, rotate: 0, pivot: [0, 0] }] },
    markers: [],
    scenes: [{ id: 's#1', name: '第一镜', bornAt: 0 }],
    locks: {},
    audioTracks: [],
    captionTracks: [],
    ...over,
  } as SceneDoc;
}

const NOW = new Date('2026-09-25T14:30:00Z');

describe('保存 → 打开：一份工程要能原样回来', () => {
  it('★ 存了文档【和】上下文，两边都不许丢', () => {
    const project = buildProject({
      doc: makeDoc(),
      now: NOW,
      context: {
        chatHistory: ['用户说「加一行标题」。结果：1 次写入。'],
        chat: [
          { role: 'user', text: '加一行标题' },
          { role: 'tool', text: '提交 [create_object] → 成功 1', name: 'apply_commands', turn: 1 },
        ],
        reasoning: 'max',
        filmMode: true,
      },
    });
    const back = parseProject(projectToJson(project));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.project.doc.objects['text#1']).toBeDefined();
    expect(back.project.context.reasoning).toBe('max');
    expect(back.project.context.filmMode).toBe(true);
    expect(back.project.context.chat).toHaveLength(2);
    expect(back.project.context.chat[1]?.name).toBe('apply_commands');
    expect(back.project.context.chatHistory[0]).toContain('加一行标题');
    expect(back.project.savedAt).toBe(NOW.toISOString());
  });

  it('上下文超量会被夹到上限（工程文件不该无限大）', () => {
    const project = buildProject({
      doc: makeDoc(),
      now: NOW,
      context: {
        chatHistory: Array.from({ length: 20 }, (_, i) => 'h' + i),
        chat: Array.from({ length: PROJECT_CHAT_CAP + 50 }, (_, i) => ({ role: 'note', text: 'l' + i })),
        reasoning: 'high',
        filmMode: false,
      },
    });
    expect(project.context.chatHistory).toHaveLength(PROJECT_HISTORY_CAP);
    expect(project.context.chat).toHaveLength(PROJECT_CHAT_CAP);
    // 留的是【最近】的那些
    expect(project.context.chatHistory[PROJECT_HISTORY_CAP - 1]).toBe('h19');
  });
});

describe('★ 坏输入：每一种都要说清哪一步不对', () => {
  it('不是 JSON', () => {
    const r = parseProject('这不是 json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON');
  });

  it('是 JSON，但不是本项目的工程（缺 format 标记）', () => {
    const r = parseProject(JSON.stringify({ doc: makeDoc() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('format');
  });

  it('★ 来自更新的版本 → 拒收并说清版本号（不装作能读）', () => {
    const r = parseProject(
      JSON.stringify({ format: PROJECT_FORMAT, formatVersion: PROJECT_FORMAT_VERSION + 1, doc: makeDoc() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('v' + String(PROJECT_FORMAT_VERSION + 1));
      expect(r.error).toContain('v' + String(PROJECT_FORMAT_VERSION));
    }
  });

  it('文档不像 Scene Doc → 说清缺什么', () => {
    const r = parseProject(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 1, doc: { hello: 1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Scene Doc');
  });

  it('文档在、上下文缺 → 能打开，但如实提示「没有上下文」', () => {
    const r = parseProject(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 1, savedAt: NOW.toISOString(), doc: makeDoc() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.context).toEqual(emptyContext());
    expect(r.warnings.join('')).toContain('没有上下文');
  });

  it('上下文里塞了垃圾行 → 逐条过滤，不整份失败', () => {
    const r = parseProject(
      JSON.stringify({
        format: PROJECT_FORMAT,
        formatVersion: 1,
        doc: makeDoc(),
        context: {
          chatHistory: ['ok', 42, '', null],
          chat: [{ role: 'note', text: '好的' }, { role: 'note' }, 'x', { text: '缺 role' }],
          reasoning: '',
          filmMode: 'yes',
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.context.chatHistory).toEqual(['ok']);
    expect(r.project.context.chat).toEqual([{ role: 'note', text: '好的' }]);
    expect(r.project.context.reasoning).toBe('high'); // 空的档位退回默认
    expect(r.project.context.filmMode).toBe(false); // 只认真正的 true
  });
});

describe('文件名与标题', () => {
  it('标题取自第一个文字对象，非法字符被洗掉', () => {
    const doc = makeDoc({
      objects: {
        'text#1': {
          shape: 'text',
          owner: { kind: 'global' },
          params: { content: { v: 'a/b:c?d*e' } },
          style: { size: { v: 32 } },
          tf: { x: 0, y: 0, rotate: 0, sx: 1, sy: 1, opacity: 1 },
          anim: {},
          effects: [],
        },
      },
    } as unknown as Partial<SceneDoc>);
    expect(guessTitle(doc)).toBe('a/b:c?d*e');
    const name = projectFilename(buildProject({ doc, context: emptyContext(), now: NOW }));
    expect(name.startsWith('sva-a-b-c-d-e-')).toBe(true);
    expect(name.endsWith('.json')).toBe(true);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('没有文字对象也能起个名字', () => {
    const doc = makeDoc({ objects: {}, layers: [{ id: 'main', depth: 1, order: 1, parallax: 1, objects: [] }] } as Partial<SceneDoc>);
    expect(projectFilename(buildProject({ doc, context: emptyContext(), now: NOW })).startsWith('sva-project-')).toBe(true);
  });
});
