/**
 * Scene Doc 里字段值的读写。整个仓库只在这里定义一次。
 *
 * 文档里的字段有两种落盘形态：
 *   裸值          expr: "sin(x)"
 *   带约束包装     width: { v: 3.0, min: 0.5, max: 10, step: 0.5 }
 * 规范 §5 的示例两种都存在，而"内联约束到底是引擎物化的副本还是实例级可覆盖"
 * 这个问题还没定（见 registry/types.ts 的 DocValue 注释）。
 *
 * 所以本模块采取【两种读法都成立】的策略：
 *   读：一律解包成裸值
 *   写：若已有包装则只替换 v，保留 min/max/step/enum；没有包装才新建 { v }
 * 这样无论最终答案是哪一种，都不会把已有的约束元数据弄丢。
 */
import type { FieldAtom, FieldRecord } from './types';

function isWrapper(value: unknown): value is { readonly v: FieldAtom } & Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'v')
  );
}

/** 解包成裸值。undefined / null 原样返回 undefined。 */
export function unwrapField(value: unknown): FieldAtom | undefined {
  if (value === null || value === undefined) return undefined;
  if (isWrapper(value)) return value.v;
  return value as FieldAtom;
}

/** 整个字段记录解包成 名称 → 裸值。 */
export function fieldValues(record: FieldRecord): Readonly<Record<string, FieldAtom>> {
  const out: Record<string, FieldAtom> = {};
  for (const key of Object.keys(record)) {
    const v = unwrapField(record[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** 写入一个字段，保留已有包装上的约束元数据。 */
export function setFieldValue(record: FieldRecord, key: string, value: FieldAtom): FieldRecord {
  const existing = record[key];
  const next = isWrapper(existing) ? { ...existing, v: value } : { v: value };
  return { ...record, [key]: next };
}

/** 删掉一个字段。 */
export function removeField(record: FieldRecord, key: string): FieldRecord {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(record)) {
    if (k !== key) out[k] = record[k];
  }
  return out as FieldRecord;
}

/** 把一组裸值装成字段记录（create_* 的内联 style 用）。 */
export function wrapFields(values: Readonly<Record<string, unknown>>): FieldRecord {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    const v = values[key];
    if (v === undefined || v === null) continue;
    out[key] = { v: v as FieldAtom };
  }
  return out as FieldRecord;
}
