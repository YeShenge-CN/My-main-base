import { describe, expect, it } from 'vitest';
import { effectsTargeting, getObject, listObjects } from '../src/projection/objects';
import { makeDoc } from './fixtures';

/**
 * P3 验收 2：get_object 只返回该对象及其效果，不泄漏其他对象。
 */
describe('P3 验收 2：get_object 的隔离性', () => {
  const doc = makeDoc(4, { effectsPerObject: 1 });

  it('brief 视图里不含任何其他对象的痕迹', () => {
    const view = getObject(doc, 'plot#1', 'brief');
    expect(view).not.toBeNull();
    const text = JSON.stringify(view);
    for (const other of ['plot#2', 'plot#3', 'plot#4']) {
      expect(text).not.toContain(other);
    }
    for (const otherEffect of ['eff#2', 'eff#3', 'eff#4']) {
      expect(text).not.toContain(otherEffect);
    }
  });

  it('full 视图同样不泄漏（含效果详情与锁）', () => {
    const patched = {
      ...doc,
      locks: {
        'plot#1.style.width': { by: 'user' as const, at: 1 },
        'plot#2.style.width': { by: 'user' as const, at: 2 },
      },
    };
    const view = getObject(patched, 'plot#1', 'full');
    const text = JSON.stringify(view);
    expect(text).toContain('eff#1');
    expect(text).toContain('plot#1.style.width');
    expect(text).not.toContain('plot#2');
    expect(text).not.toContain('eff#2');
  });

  it('只带 target 指向自己的效果', () => {
    const withStray = {
      ...doc,
      effects: {
        ...doc.effects,
        'eff#99': {
          type: 'drawOn',
          target: 'plot#2',
          params: { start: { v: 0 }, duration: { v: 1 } },
        },
      },
    };
    expect(effectsTargeting(withStray, 'plot#1')).toEqual(['eff#1']);
    const view = getObject(withStray, 'plot#1', 'full');
    expect(JSON.stringify(view)).not.toContain('eff#99');
  });

  it('未知 id 返回 null，而不是抛异常或空视图', () => {
    expect(getObject(doc, 'nope#1')).toBeNull();
    expect(getObject(doc, 'nope#1', 'full')).toBeNull();
  });

  it('brief 与 full 的差别：anim / effectDetails / locks 只在 full 出现', () => {
    const p1 = doc.objects['plot#1'];
    if (p1 === undefined) throw new Error('fixture 缺 plot#1');
    const withAnim = {
      ...doc,
      objects: {
        ...doc.objects,
        'plot#1': {
          ...p1,
          anim: { 'tf.opacity': { kind: 'keys' as const, keys: [{ t: 0, v: 0 }, { t: 0.6, v: 1 }] } },
        },
      },
      locks: { 'plot#1.style.width': { by: 'user' as const, at: 1 } },
    };
    const brief = getObject(withAnim, 'plot#1', 'brief');
    const full = getObject(withAnim, 'plot#1', 'full');
    expect(brief?.anim).toBeUndefined();
    expect(brief?.effectDetails).toBeUndefined();
    expect(brief?.locks).toBeUndefined();
    expect(full?.anim?.['tf.opacity']).toBeDefined();
    expect(full?.effectDetails?.[0]?.id).toBe('eff#1');
    expect(full?.locks).toEqual(['plot#1.style.width']);
  });

  it('参数值与样式值都被解包成裸值（模型不用再看 {v:...}）', () => {
    const view = getObject(doc, 'plot#1', 'brief');
    expect(view?.params['expr']).toBe('sin(x)');
    expect(view?.params['samples']).toBe(2400);
    expect(view?.params['domain']).toEqual([-7, 7]);
    expect(view?.style['stroke']).toBe('#4ea1ff');
    expect(view?.style['width']).toBe(3);
  });
});

describe('list_objects', () => {
  const doc = makeDoc(6, { layerCount: 3 });

  it('无过滤时返回全部', () => {
    expect(listObjects(doc).length).toBe(6);
  });

  it('按图层过滤', () => {
    const main = listObjects(doc, { layerId: 'main' });
    expect(main.length).toBe(2);
    for (const o of main) expect(o.layerId).toBe('main');
  });

  it('按类型过滤', () => {
    expect(listObjects(doc, { type: 'plot2d' }).length).toBe(6);
    expect(listObjects(doc, { type: 'contour' }).length).toBe(0);
  });

  it('列表同样不含参数值', () => {
    const text = JSON.stringify(listObjects(doc));
    expect(text).not.toContain('sin(x)');
    for (const o of listObjects(doc)) {
      expect(Object.keys(o).sort()).toEqual(['id', 'layerId', 't', 'type']);
    }
  });
});
