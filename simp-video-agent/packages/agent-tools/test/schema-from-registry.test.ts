import { describe, expect, it } from 'vitest';
import { REGISTRY, VIEWPORT_MAX_PX, VIEWPORT_MIN_PX, generateObjectSchema, type JsonSchema } from '@sva/engine-core';
import { TOOLS } from '../src/tools';

/**
 * 规范 §6 的跨包断言：工具 schema 里的字段级约束必须【就是】FieldRegistry 里的那一份。
 *
 * 这条断言的意义是防止回归：以前 tools.ts 里的 min/max/enum 全是手写的，
 * 谁都可以悄悄改一个数，而校验器仍然认 registry —— 两边漂移没人会发现。
 * 现在任何一处手写都会让这个测试红。
 */

function tool(name: string): Record<string, unknown> {
  const hit = TOOLS.find((t) => t.name === name);
  if (hit === undefined) throw new Error('缺少工具 ' + name);
  return hit.parameters;
}

/** 在任意深度的 JSON Schema 里找所有 {minimum|maximum|multipleOf|enum} 出现的位置。 */
function collect(node: unknown, path: string, out: Map<string, JsonSchema>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collect(v, path + '[' + i + ']', out));
    return;
  }
  const rec = node as Record<string, unknown>;
  const picked: JsonSchema = {};
  for (const key of ['minimum', 'maximum', 'multipleOf', 'enum', 'type']) {
    if (rec[key] !== undefined) picked[key] = rec[key];
  }
  if (picked['minimum'] !== undefined || picked['maximum'] !== undefined || picked['multipleOf'] !== undefined || picked['enum'] !== undefined) {
    out.set(path, picked);
  }
  for (const [k, v] of Object.entries(rec)) collect(v, path === '' ? k : path + '.' + k, out);
}

function constraintsOf(schema: unknown): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  collect(schema, '', out);
  return out;
}

function registryProps(groupId: string, include?: readonly string[]): Record<string, JsonSchema> {
  // 与 tools.ts 的 fieldsOf 同一套查找规则：按 kind + 名字找分组，section 从分组上读。
  // 这里刻意不 import 生产代码的私有 helper —— 测试要能独立表达"registry 里那份约束是什么"。
  const dot = groupId.indexOf('.');
  const kind = groupId.slice(0, dot < 0 ? groupId.length : dot);
  const name = dot < 0 ? undefined : groupId.slice(dot + 1);
  const group = REGISTRY.groups.find(
    (g) => g.kind === kind && (name === undefined || g.owner === name || g.section === name || g.id === groupId),
  );
  if (group === undefined) throw new Error('registry 里找不到分组 ' + groupId);
  const schema = generateObjectSchema(
    group,
    include === undefined ? { mode: 'all-nullable' } : { mode: 'all-nullable', include },
  );
  return (schema['properties'] ?? {}) as Record<string, JsonSchema>;
}

function inner(schema: JsonSchema | undefined): JsonSchema {
  if (schema === undefined) throw new Error('schema 字段不存在');
  const anyOf = schema['anyOf'] as JsonSchema[] | undefined;
  return anyOf?.[0] ?? schema;
}

/** 与 tools.ts 里同名的小工具语义一致：可选字段写成 anyOf:[T, null]。 */
function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

/** 某个命令分支的属性集（本文件里读"某分支有没有某字段"的统一入口）。 */
function branchProps(op: string): Record<string, JsonSchema> {
  const commands = (tool('apply_commands')['properties'] as Record<string, JsonSchema>)['commands'];
  const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
  const branch = branches.find(
    (b) => (((b['properties'] as Record<string, JsonSchema>)?.['op']?.['enum'] ?? []) as string[])[0] === op,
  );
  return (branch?.['properties'] ?? {}) as Record<string, JsonSchema>;
}

/** 从工具 schema 的某个 branch 里取某字段的实际约束。 */
function fieldConstraints(toolName: string, op: string, field: string): JsonSchema {
  const commands = (tool(toolName)['properties'] as Record<string, JsonSchema>)['commands'];
  const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
  for (const branch of branches) {
    const props = (branch['properties'] ?? {}) as Record<string, JsonSchema>;
    const opConst = (props['op']?.['enum'] ?? []) as string[];
    if (opConst[0] !== op) continue;
    const hit = props[field];
    if (hit === undefined) throw new Error(op + ' 里没有字段 ' + field);
    return inner(hit);
  }
  throw new Error('找不到命令分支 ' + op);
}

describe('工具 schema 的字段约束来自 registry', () => {
  it('create_plot.samples 带上 registry 的 minimum/maximum/multipleOf（模型终于看得见下限）', () => {
    const samples = inner(fieldConstraints('apply_commands', 'create_plot', 'samples'));
    const spec = registryProps('shape.plot2d.params', ['samples'])['samples'];
    expect(samples).toEqual(inner(spec));
    expect(samples['minimum']).toBe(16);
  });

  it('create_plot 的 expr / domain 也来自 registry', () => {
    expect(inner(fieldConstraints('apply_commands', 'create_plot', 'expr'))).toEqual(
      inner(registryProps('shape.plot2d.params', ['expr'])['expr'] as JsonSchema),
    );
    expect(inner(fieldConstraints('apply_commands', 'create_plot', 'domain'))).toEqual(
      inner(registryProps('shape.plot2d.params', ['domain'])['domain'] as JsonSchema),
    );
  });

  it('set_style 的 width/glow 带上 registry 的范围与步长', () => {
    const width = inner(fieldConstraints('apply_commands', 'set_style', 'width'));
    const style = registryProps('shape.plot2d.style', ['width', 'glow']);
    expect(width).toEqual(inner(style['width'] as JsonSchema));
    expect(width['minimum']).toBe(0.5);
    expect(width['maximum']).toBe(10);
    expect(width['multipleOf']).toBe(0.5);
    expect(inner(fieldConstraints('apply_commands', 'set_style', 'glow'))).toEqual(
      inner(style['glow'] as JsonSchema),
    );
  });

  it('set_transform 的六个字段来自 object.tf', () => {
    const tf = registryProps('object.tf');
    for (const field of ['x', 'y', 'rotate', 'sx', 'sy', 'opacity']) {
      expect(inner(fieldConstraints('apply_commands', 'set_transform', field))).toEqual(
        inner(tf[field] as JsonSchema),
      );
    }
  });

  it('set_effect 的 mode 枚举来自 registry（domain/arc）', () => {
    const mode = inner(fieldConstraints('apply_commands', 'set_effect', 'mode'));
    expect(mode['enum']).toEqual(['domain', 'arc']);
    const registryMode = registryProps('effect.drawOn.params', ['mode'])['mode'] as JsonSchema;
    expect(mode).toEqual(inner(registryMode));
  });

  it('set_motion 的 ease 带白名单 enum（写错名字会被拒，不再静默变线性）', () => {
    const node = inner(fieldConstraints('apply_commands', 'set_motion', 'node'));
    const props = (node['properties'] ?? {}) as Record<string, JsonSchema>;
    // keys 是 nullable 数组：anyOf:[{type:'array',items:{...}}, {type:'null'}]
    const keys = inner(props['keys']);
    const keyItems = keys['items'] as JsonSchema;
    const keyProps = (keyItems['properties'] ?? {}) as Record<string, JsonSchema>;
    const ease = inner(keyProps['ease']);
    const registryEase = inner(registryProps('motion.key', ['ease'])['ease'] as JsonSchema);
    expect(ease).toEqual(registryEase);
    expect(ease['enum']).toEqual(['linear', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeOutBack']);
    // 模型实测写过的那个错名字不在白名单里
    expect(ease['enum']).not.toContain('easeOut');
    // 关键帧的三项都在 required 里（strict 模式的硬要求）
    expect(keyItems['required']).toEqual(['t', 'v', 'ease']);
  });

  /**
   * 从工具 schema 里取出内联 effect 的某个效果类型分支。
   *
   * ★ 注意：内联 effect 的 `anyOf` 是【类型联合】（drawOn / highlight），
   *   不是"可空"。所以这里读的是 `inner()` 之前的那一层 ——
   *   `inner()` 只取 anyOf[0]，套上去就永远只能看到第一支。
   */
  function inlineEffectBranch(toolName: string, op: string, effectType: string): JsonSchema {
    const commands = (tool(toolName)['properties'] as Record<string, JsonSchema>)['commands'];
    const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
    const branch = branches.find(
      (b) => ((b['properties'] as Record<string, JsonSchema>)?.['op']?.['enum'] as string[])?.[0] === op,
    );
    const props = (branch?.['properties'] ?? {}) as Record<string, JsonSchema>;
    const raw = props['effect'] as JsonSchema;
    /**
     * 拿到【类型联合】那一层。
     *
     * ★ 这里以前有一段递归（为了照顾 `nullable(联合)` 那种嵌套），现在不需要了：
     *   嵌套 anyOf 被 DeepSeek 的 strict 校验【拒收】（整个请求 400），
     *   所以 `create_*` 的 effect 也改成了展平形状 —— 联合的每一支与 null
     *   并列在同一个 `anyOf` 里（见 tools.ts 的 `nullableUnion`）。
     *   留一段"兼容两种形状"的代码 = 下一个读它的人以为两种形状都合法。
     */
    const variants = (raw['anyOf'] ?? []) as JsonSchema[];
    const hit = variants.find(
      (v) =>
        (((v['properties'] as Record<string, JsonSchema>)?.['type']?.['enum'] ?? []) as string[])[0] === effectType,
    );
    if (hit === undefined) throw new Error(op + ' 的内联 effect 里没有 ' + effectType + ' 分支');
    return hit;
  }

  it('add_effect 的内联参数与 set_effect 是同一份约束（嵌在 params 下、且必填）', () => {
    const drawOn = inlineEffectBranch('apply_commands', 'add_effect', 'drawOn');
    const props = (drawOn['properties'] ?? {}) as Record<string, JsonSchema>;
    const params = props['params'] as JsonSchema;
    const innerParams = (params['properties'] ?? {}) as Record<string, JsonSchema>;
    // 与 set_effect 的字段约束是同一份（只是这里是必填、那里可 null）
    expect(innerParams['mode']).toEqual(
      nullable(inner(registryProps('effect.drawOn.params', ['mode'])['mode'] as JsonSchema)),
    );
    expect(innerParams['start']).toEqual(
      nullable(inner(registryProps('effect.drawOn.params', ['start'])['start'] as JsonSchema)),
    );
    // ★ 参数必须嵌在 params 下：实测模型把它写在 effect 顶层，导致 duration 缺失
    expect(drawOn['required']).toEqual(['type', 'params']);
    expect(params['type']).toBe('object');
    expect(params['additionalProperties']).toBe(false);
    expect(params['required']).toEqual(['start', 'duration', 'mode', 'tip']);
    // 顶层不再直接暴露 start / duration（那正是模型写错的地方）
    expect(props['start']).toBeUndefined();
    expect(props['duration']).toBeUndefined();
  });

  it('★ add_effect 支持五种效果类型，各自一份完整形状（不是"type 用 enum、params 全可空"）', () => {
    const commands = (tool('apply_commands')['properties'] as Record<string, JsonSchema>)['commands'];
    const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
    const addEffect = branches.find(
      (b) => ((b['properties'] as Record<string, JsonSchema>)?.['op']?.['enum'] as string[])?.[0] === 'add_effect',
    );
    // ★ 注意读的是 inner() 之前的那一层：内联 effect 本身就是 anyOf（不是可空的 anyOf）
    const effect = ((addEffect?.['properties'] ?? {}) as Record<string, JsonSchema>)['effect'] as JsonSchema;
    const variants = (effect['anyOf'] ?? []) as JsonSchema[];
    const types = variants.map(
      (v) => (((v['properties'] as Record<string, JsonSchema>)?.['type']?.['enum'] ?? []) as string[])[0],
    );
    expect(types).toEqual(['drawOn', 'highlight', 'moveAlong', 'appear', 'disappear']);
    // 三边的 params 各自必填自己的字段 —— 这正是"不做可空大杂烩"的落地
    const hl = inlineEffectBranch('apply_commands', 'add_effect', 'highlight');
    const hlParams = (hl['properties'] as Record<string, JsonSchema>)['params'] as JsonSchema;
    expect(hlParams['required']).toEqual(['start', 'duration', 'color', 'intensity']);
    expect(((hlParams['properties'] ?? {}) as Record<string, JsonSchema>)['mode']).toBeUndefined();

    const ma = inlineEffectBranch('apply_commands', 'add_effect', 'moveAlong');
    const maParams = (ma['properties'] as Record<string, JsonSchema>)['params'] as JsonSchema;
    expect(maParams['required']).toEqual(['source', 'start', 'duration']);
    // 别的类型的字段不许漏进来
    expect(((maParams['properties'] ?? {}) as Record<string, JsonSchema>)['color']).toBeUndefined();
    expect(((maParams['properties'] ?? {}) as Record<string, JsonSchema>)['mode']).toBeUndefined();

    // 显隐：两种类型各只有一个 at，且不带上任何别的类型的字段
    for (const type of ['appear', 'disappear']) {
      const branch = inlineEffectBranch('apply_commands', 'add_effect', type);
      const params = (branch['properties'] as Record<string, JsonSchema>)['params'] as JsonSchema;
      expect(params['required'], type).toEqual(['at']);
      const props = (params['properties'] ?? {}) as Record<string, JsonSchema>;
      expect(Object.keys(props), type).toEqual(['at']);
      // fieldsOf 与 registryProps 一样是 all-nullable，取 inner 才是字段本身的约束
      expect(inner(props['at'] ?? {})['minimum'], type).toBe(0);
    }
  });

  it('★ set_visibility 的字段来自 registry（appear / disappear 共用一个 at）', () => {
    const appearAt = inner(registryProps('effect.appear.params')['at'] as JsonSchema);
    const field = inner(fieldConstraints('apply_commands', 'set_visibility', 'at'));
    // 约束逐字来自 registry（只是描述换成了对两种效果都成立的说法）
    expect(field['type']).toBe(appearAt['type']);
    expect(field['minimum']).toBe(appearAt['minimum']);
    expect(field['maximum']).toBe(appearAt['maximum']);
    expect(field['multipleOf']).toBe(appearAt['multipleOf']);
    expect(String(field['description'])).toContain('disappear');
  });

  /**
   * ★ 形状参数三条命令（§7 第 0.5 条补的）。
   *
   * 它们补的是一个人人都撞得到的缺口：registry 里登记了 rect 的宽高、line 的两个端点、
   * text 的内容，面板也画出了控件 —— 却【没有任何命令能改】。
   * 这一条守的是"约束只能来自 registry"（不许手写范围）与"不带别的形状的字段"。
   */
  it('★ 形状参数三条命令的字段只来自 registry，且不带别的形状的字段', () => {
    const cases: readonly (readonly [string, string, readonly string[]])[] = [
      ['set_rect', 'shape.rect.params', ['width', 'height', 'radius']],
      ['set_line', 'shape.line.params', ['from', 'to', 'head']],
      ['set_text', 'shape.text.params', ['content']],
    ];
    for (const [op, groupId, keys] of cases) {
      const registry = registryProps(groupId);
      for (const key of keys) {
        expect(inner(fieldConstraints('apply_commands', op, key)), op + '.' + key).toEqual(
          inner(registry[key] as JsonSchema),
        );
      }
      // ★ 别的形状的字段不许混进来：这是"每种形状一条 op"的全部价值
      const props = branchProps(op);
      const foreign = ['width', 'height', 'radius', 'from', 'to', 'head', 'content'].filter(
        (k) => !keys.includes(k),
      );
      for (const k of foreign) expect(props[k], op + ' 里混进了 ' + k).toBeUndefined();
    }
  });

  it('★ set_style 补的四个字段也来自各自的 registry 分组（fill / fillOpacity / headSize / size）', () => {
    const rect = registryProps('shape.rect.style', ['fill', 'fillOpacity']);
    const line = registryProps('shape.line.style', ['headSize']);
    const text = registryProps('shape.text.style', ['size']);
    expect(inner(fieldConstraints('apply_commands', 'set_style', 'fill'))).toEqual(inner(rect['fill'] as JsonSchema));
    expect(inner(fieldConstraints('apply_commands', 'set_style', 'fillOpacity'))).toEqual(
      inner(rect['fillOpacity'] as JsonSchema),
    );
    expect(inner(fieldConstraints('apply_commands', 'set_style', 'headSize'))).toEqual(inner(line['headSize'] as JsonSchema));
    expect(inner(fieldConstraints('apply_commands', 'set_style', 'size'))).toEqual(inner(text['size'] as JsonSchema));
  });

  it('★ moveAlong 的参数约束【只】来自 registry（source/start/duration 两边一致）', () => {
    const registry = registryProps('effect.moveAlong.params');
    const ma = inlineEffectBranch('apply_commands', 'add_effect', 'moveAlong');
    const params = ((ma['properties'] as Record<string, JsonSchema>)['params'] as JsonSchema)['properties'] as Record<
      string,
      JsonSchema
    >;
    for (const key of ['source', 'start', 'duration']) {
      expect(params[key]).toEqual(nullable(inner(registry[key] as JsonSchema)));
      // set_move_along 与内联是同一份（只是这里可 null）
      expect(inner(fieldConstraints('apply_commands', 'set_move_along', key))).toEqual(
        inner(registry[key] as JsonSchema),
      );
    }
    expect(inner(fieldConstraints('apply_commands', 'set_move_along', 'duration'))['minimum']).toBe(0.1);
  });

  /**
   * ★★ 内联 effect 从【四条 create 分支】里彻底拿掉了 —— 这是一次有意的结构取舍。
   *
   * 账（实测）：四条分支各带一份"drawOn + highlight"的完整形状（含 registry 生成的
   * 字段描述），合计约 **1200 token**，而它与 `add_effect` 里那份**逐字相同**。
   * 拿掉之后 apply_commands 从 5551 降到 4354。
   *
   * 它换来的能力并没有丢：引擎的批次支持符号 id ——
   *   `create_rect {localId:"$c1"}` + `add_effect {target:"$c1"}`（同一批）
   * 依赖由引擎自动推导（`batch.ts`），所以规范 §7 担心的"假依赖"（要等回执拿到
   * assignedId 才能挂效果）在这条路上不存在。**变的只是表达形式，不是能力。**
   *
   * 这条断言把"拿掉"变成【有意的结构】而不是"谁忘了加"：
   * 想加回来的人，改这里就知道要动哪几处（同时会看到 token 账）。
   */
  it('★ create_* 分支里【不再有】effect 字段（效果一律走 add_effect + 符号 id）', () => {
    for (const op of ['create_plot', 'create_rect', 'create_line', 'create_object']) {
      const props = branchProps(op);
      expect(props['effect'], op + ' 又出现了 effect 字段').toBeUndefined();
      // localId 必须在：它是"同一批里挂效果"的挂钩
      expect(props['localId'], op + ' 缺少 localId（符号引用就没有着力点了）').toBeDefined();
      /**
       * ★ 而且它的说明必须写出 `$` 前缀。
       *   这一条来自实测：拿掉内联 effect 之后，真调模型的第一轮就写了
       *   `localId:"c1"` 配 `target:"$c1"` —— 结构全对、只漏了前缀，
       *   整批报 unknown_local_id 白烧一轮（60k 输入 token）。
       *   **裸 str 等于没说明书。**
       */
      expect(JSON.stringify(props['localId']), op + ' 的 localId 没说清 $ 前缀').toContain('$');
    }
  });

  it('★ 五种效果类型【只】在 add_effect 里，且它的 target 说清了可以写 $c1', () => {
    const commands = (tool('apply_commands')['properties'] as Record<string, JsonSchema>)['commands'];
    const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
    const withEffect = branches.filter(
      (b) => ((b['properties'] ?? {}) as Record<string, JsonSchema>)['effect'] !== undefined,
    );
    const ops = withEffect.map(
      (b) => (((b['properties'] as Record<string, JsonSchema>)['op']?.['enum'] ?? []) as string[])[0],
    );
    expect(ops).toEqual(['add_effect']);
    // 符号 id 是新走法的关键，必须在模型看得到的地方写出来
    expect(JSON.stringify(branchProps('add_effect')['target'])).toContain('$c1');
    // 五种类型都在
    const variants = ((branchProps('add_effect')['effect']?.['anyOf'] ?? []) as JsonSchema[]).map(
      (v) => (((v['properties'] as Record<string, JsonSchema>)?.['type']?.['enum'] ?? []) as string[])[0],
    );
    expect(variants).toEqual(['drawOn', 'highlight', 'moveAlong', 'appear', 'disappear']);
  });
});

describe('工具 schema 仍然是 strict 形态', () => {
  it('每个工具的参数顶层都 required 全部属性 + additionalProperties:false', () => {
    for (const t of TOOLS) {
      const props = Object.keys((t.parameters['properties'] ?? {}) as Record<string, unknown>);
      expect(t.parameters['additionalProperties']).toBe(false);
      expect(t.parameters['required']).toEqual(props);
    }
  });

  it('命令分支也是 strict 的，且字段没有漂移到 required 之外', () => {
    const commands = (tool('apply_commands')['properties'] as Record<string, JsonSchema>)['commands'];
    const branches = ((commands?.['items'] as JsonSchema)?.['anyOf'] ?? []) as JsonSchema[];
    expect(branches.length).toBeGreaterThan(5);
    for (const branch of branches) {
      const props = Object.keys((branch['properties'] ?? {}) as Record<string, unknown>);
      expect(branch['additionalProperties']).toBe(false);
      expect(branch['required']).toEqual(props);
    }
  });

  it('schema 里不出现 strict 模式不接受的关键字', () => {
    const banned = ['minLength', 'maxLength', 'minItems', 'maxItems'];
    const text = JSON.stringify(TOOLS);
    for (const key of banned) expect(text).not.toContain('"' + key + '"');
  });

  /**
   * ★★ 这一条是"面板实机校验抓到真 bug"换来的。
   *
   * DeepSeek 的 strict 校验【拒收嵌套 anyOf】：
   *   `nullable({ anyOf: [A, B] })` → 400
   *   Invalid tool parameters schema : field `anyOf`: field `anyOf`: missing field `type`
   * 而它是**整个请求一起失败**：模型一次都调不到，不是"少一个效果类型"。
   * 这个形状从 P2 highlight（内联 effect 变成联合）起就在，一直活到第十五轮 ——
   * 因为所有真调模型的测试都是 opt-in（SVA_ACCEPTANCE / SVA_STRESS），没人跑。
   *
   * 这条断言把它变成【毫秒级的结构检查】：凡是对象里出现 `anyOf`，
   * 每一个分支都必须自己带 `type`（可选性用同层的 {type:'null'} 表达）。
   */
  it('★ 工具表里不许有嵌套 anyOf（接口会整表拒收，模型一次都调不到）', () => {
    const bad: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, path + '[' + i + ']'));
        return;
      }
      const rec = node as Record<string, unknown>;
      if (Array.isArray(rec['anyOf'])) {
        (rec['anyOf'] as unknown[]).forEach((v, i) => {
          const el = v as Record<string, unknown>;
          if (el['type'] === undefined) {
            bad.push(path + '.anyOf[' + i + '] 没有 type（嵌套联合？）');
          }
        });
      }
      for (const [k, v] of Object.entries(rec)) walk(v, path + '.' + k);
    };
    for (const t of TOOLS) walk(t.parameters, t.name);
    expect(bad, '这些位置用了嵌套 anyOf，接口会 400：\n' + bad.join('\n')).toEqual([]);
  });

  it('整个工具表里没有任何"手写数值范围"漏网（只能来自 registry 或具名常量）', () => {
    // 把所有 registry 里登记过的数值边界收集起来 —— 包括【分量级】约束
    // （range/vec2 的 item，例如 domain 的 [-1000,1000]）。
    const registryBounds = new Set<number>();
    const add = (bounds: { kind: string; min?: number; max?: number; step?: number }): void => {
      if (bounds.kind === 'bounded') {
        if (typeof bounds.min === 'number') registryBounds.add(bounds.min);
        if (typeof bounds.max === 'number') registryBounds.add(bounds.max);
      }
      if (typeof bounds.step === 'number') registryBounds.add(bounds.step);
    };
    for (const g of REGISTRY.groups) {
      for (const spec of Object.values(g.fields)) {
        if (spec.type === 'number' || spec.type === 'integer') add(spec.bounds);
        if (spec.type === 'vec2' || spec.type === 'int2' || spec.type === 'range') {
          if (spec.item !== undefined) add(spec.item);
        }
      }
    }
    // 不落在任何单个 FieldSpec 上的边界：必须是 engine-core 的【具名常量】，
    // 而不是这里放过一个数字。加一条就说明又有人手写了一个范围。
    const namedConstants = new Set<number>([VIEWPORT_MIN_PX, VIEWPORT_MAX_PX]);
    expect(registryBounds.size).toBeGreaterThan(0); // 防止测试本身空转

    const suspects: string[] = [];
    for (const [path, picked] of constraintsOf(TOOLS)) {
      for (const key of ['minimum', 'maximum', 'multipleOf']) {
        const v = picked[key];
        if (typeof v !== 'number') continue;
        if (registryBounds.has(v) || namedConstants.has(v)) continue;
        suspects.push(path + '.' + key + '=' + v);
      }
    }
    expect(suspects).toEqual([]);
  });
});
