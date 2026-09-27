/**
 * 效果控件渲染器（P9 第 2 条）。
 *
 * ★ 这里【不认识】任何一个具体字段。它只认识 ControlModel：
 *   kind 决定画什么控件，min/max/step/options/unit 全部来自 FieldRegistry。
 *   想在这个文件里找到 "width" 或者 "0.5" 是找不到的 —— 这是刻意的。
 *
 * 三态可视（P9 第 3 条）也在这里落地：每个字段左边一颗状态点，
 * 锁定字段额外带一枚图标，hard/soft 用不同图标。
 */
import type { ControlModel, FieldState } from '@sva/engine-core';
import { compileExpr } from '@sva/engine-core';
import { clear, h } from './dom';

export interface ControlHost {
  readonly onChange: (path: string, value: unknown) => void;
  readonly stateOf: (path: string) => FieldState | undefined;
  /** 该字段上是否有未决提案。有的话行要琥珀高亮，并显示 建议值 → 目标值 的 diff。 */
  readonly proposedFor?: (path: string) => { readonly after: unknown } | undefined;
  /**
   * 该字段上是否存在动画轨道。
   *
   * ★ 以前这里只看 FieldState.animationDriven（只读展示）。要让用户能【建】动画，
   *   面板必须能区分"有轨道"和"没有轨道"，并给出一个明确的开关。
   */
  readonly animatedFor?: (path: string) => boolean;
  /**
   * 切换该字段的动画轨道。给了这个回调，可动画字段旁边才会出现菱形按钮。
   * 传 null 表示删掉这条轨道。
   */
  readonly onToggleAnim?: (path: string, on: boolean) => void;
}

const UNIT_SUFFIX: Readonly<Record<string, string>> = {
  s: ' 秒',
  ms: ' 毫秒',
  world: ' wu',
  px: ' px',
  deg: '°',
  rad: ' rad',
  ratio: '',
  count: '',
  perSecond: ' fps',
};

function stateBadge(state: FieldState | undefined): HTMLElement {
  const classes = ['dot'];
  if (state?.animationDriven === true) classes.push('dot-anim');
  if (state?.state === 'animated') classes.push('dot-anim');
  const dot = h('span', { class: classes.join(' '), title: state?.animationDriven ? '动画驱动' : '静态值' });
  const wrap = h('span', { class: 'badges' }, dot);

  if (state?.locked === true) {
    const hard = state.lockClass === 'hard';
    wrap.append(
      h('span', {
        class: hard ? 'lock lock-hard' : 'lock lock-soft',
        title: hard ? '用户锁定：改动需 request_patch 并经用户同意' : 'AI 拥有：可直接改，但会覆盖动画',
      }, hard ? '🔒' : '🔓'),
    );
  }
  return wrap;
}

function numberInput(value: number, min: number | undefined, max: number | undefined, step: number | undefined, onChange: (v: number) => void): HTMLInputElement {
  const input = h('input', { type: 'number', class: 'num' });
  input.value = String(value);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return input;
}

function buildControl(model: ControlModel, host: ControlHost): HTMLElement {
  const emit = (v: unknown): void => host.onChange(model.path, v);

  switch (model.kind) {
    case 'slider':
    case 'percent':
    case 'angle': {
      const min = model.min ?? 0;
      const max = model.max ?? 1;
      const step = model.step ?? (model.kind === 'percent' ? 0.01 : (max - min) / 100);
      const range = h('input', { type: 'range', class: 'range' });
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(typeof model.value === 'number' ? model.value : min);
      const num = numberInput(typeof model.value === 'number' ? model.value : min, min, max, step, emit);
      range.addEventListener('input', () => {
        const v = Number(range.value);
        num.value = String(v);
        emit(v);
      });
      const suffix = model.unit === undefined ? '' : (UNIT_SUFFIX[model.unit] ?? '');
      return h('div', { class: 'ctl ctl-slider' }, range, num, h('span', { class: 'unit' }, suffix));
    }

    case 'color': {
      const input = h('input', { type: 'color', class: 'color' });
      input.value = typeof model.value === 'string' ? model.value : '#000000';
      input.addEventListener('input', () => emit(input.value));
      return h('div', { class: 'ctl' }, input, h('code', { class: 'hex' }, input.value));
    }

    case 'select': {
      const sel = h('select', { class: 'select' });
      for (const opt of model.options ?? []) {
        const o = h('option', { value: opt.value }, opt.label);
        if (opt.value === model.value) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => emit(sel.value));
      return h('div', { class: 'ctl' }, sel);
    }

    case 'toggle': {
      const box = h('input', { type: 'checkbox', class: 'toggle' });
      box.checked = model.value === true;
      box.addEventListener('change', () => emit(box.checked));
      return h('div', { class: 'ctl' }, box);
    }

    case 'expr': {
      const input = h('input', { type: 'text', class: 'expr' });
      input.value = typeof model.value === 'string' ? model.value : '';
      const verdict = h('span', { class: 'verdict' }, '');
      // ★ 构造时【只显示校验结果，不 emit】。
      //   构造时 emit 会触发 onChange → 提交命令 → 重建控件 → 再校验 → 再 emit……
      //   一个同步的无限递归，只有真的把面板渲染出来才会暴露。
      const validate = (emitValue: boolean): void => {
        const r = compileExpr(input.value, ['x', 't']);
        verdict.textContent = r.ok ? '✓' : '✗ ' + r.error.message;
        verdict.className = r.ok ? 'verdict ok' : 'verdict bad';
        if (emitValue && r.ok) emit(input.value);
      };
      input.addEventListener('change', () => validate(true));
      validate(false);
      return h('div', { class: 'ctl ctl-expr' }, input, verdict);
    }

    case 'textarea': {
      const ta = h('textarea', { class: 'textarea', rows: '3' });
      ta.value = typeof model.value === 'string' ? model.value : '';
      ta.addEventListener('change', () => emit(ta.value));
      return h('div', { class: 'ctl' }, ta);
    }

    case 'vec2':
    case 'range': {
      const v = Array.isArray(model.value) ? (model.value as number[]) : [0, 0];
      const a = numberInput(v[0] ?? 0, model.min, model.max, model.step, (x) => emit([x, v[1] ?? 0]));
      const b = numberInput(v[1] ?? 0, model.min, model.max, model.step, (y) => emit([v[0] ?? 0, y]));
      return h('div', { class: 'ctl ctl-vec2' }, a, h('span', { class: 'sep' }, '~'), b);
    }

    default: {
      const input = h('input', { type: 'text', class: 'text' });
      input.value = typeof model.value === 'string' ? model.value : String(model.value ?? '');
      input.addEventListener('change', () => emit(input.value));
      return h('div', { class: 'ctl' }, input);
    }
  }
}

export function renderControls(
  container: HTMLElement,
  models: readonly ControlModel[],
  host: ControlHost,
): void {
  clear(container);
  const bySection = new Map<string, ControlModel[]>();
  for (const m of models) {
    const list = bySection.get(m.section) ?? [];
    list.push(m);
    bySection.set(m.section, list);
  }

  for (const [section, list] of bySection) {
    container.append(h('h4', { class: 'grp' }, section));
    for (const model of list) {
      const state = host.stateOf(model.path);
      const proposal = host.proposedFor?.(model.path);
      const classes = ['row'];
      if (model.engineOnly) classes.push('readonly');
      if (proposal !== undefined) classes.push('row-proposed');
      const row = h('div', { class: classes.join(' ') });
      row.append(stateBadge(state));
      row.append(
        h('label', { class: 'lbl', title: model.description ?? '' }, model.label),
      );
      row.append(buildControl(model, host));

      /**
       * 动画开关。只有 registry 标了 animatable 的字段才有。
       *
       * 图标语义：◇ 未加动画 / ◆ 已有动画。
       * 面板不自己造轨道内容 —— 它只发一条 set_motion 命令，具体关键帧由 app.ts 决定，
       * 这样"用户加的动画"和"AI 加的动画"在文档里长得一模一样。
       */
      if (model.animatable && host.onToggleAnim !== undefined) {
        const on = host.animatedFor?.(model.path) === true;
        const animBtn = h(
          'button',
          {
            class: on ? 'animb on' : 'animb',
            type: 'button',
            title: on ? '已有动画轨道，点一下删除' : '给这个字段加一条动画轨道（淡入式的两帧关键帧）',
          },
          on ? '◆' : '◇',
        );
        animBtn.addEventListener('click', () => host.onToggleAnim?.(model.path, !on));
        row.append(animBtn);
      }

      if (proposal !== undefined) {
        row.append(
          h('div', { class: 'diff' },
            h('span', { class: 'diff-from' }, String(typeof model.value === 'number' ? model.value : model.value ?? '—')),
            h('span', { class: 'diff-arrow' }, '→'),
            h('span', { class: 'diff-to' }, String(proposal.after ?? '—')),
          ),
        );
      }
      container.append(row);
    }
  }
}
