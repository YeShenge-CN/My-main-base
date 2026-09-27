/**
 * 表达式编译器：白名单 token → AST → 闭包。
 *
 * 禁止 eval / new Function（规范 §3）。不是"不推荐"，是根本没有这条路径。
 *
 * 白名单（规范 §4 给出）：
 *   sin cos tan exp log sqrt abs pow min max floor ceil
 * 常量：PI / E；自由变量由调用方声明（如 'x'、't'）。
 */
export type ExprError = { readonly code: string; readonly message: string; readonly at: number };

type Node =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] }
  | { readonly kind: 'unary'; readonly op: '-' | '+'; readonly arg: Node }
  | { readonly kind: 'binary'; readonly op: string; readonly left: Node; readonly right: Node };

export type Env = Readonly<Record<string, number>>;
export type CompiledExpr = (env: Env) => number;

export type CompileResult =
  | { readonly ok: true; readonly eval: CompiledExpr; readonly variables: readonly string[] }
  | { readonly ok: false; readonly error: ExprError };

/**
 * 函数白名单：名字 → 参数个数。到这里为止，多一个都不认。
 *
 * 实现表（FUNCTION_IMPLS）的键类型就是从它推出来的，所以
 * "登记了却忘了实现"是编译错误，而不是运行时静默失效。
 */
const FUNCTIONS = {
  sin: 1, cos: 1, tan: 1, exp: 1, log: 1, sqrt: 1, abs: 1,
  floor: 1, ceil: 1, round: 1, sign: 1,
  pow: 2, min: 2, max: 2, atan2: 2, mod: 2,
  clamp: 3,
} as const satisfies Readonly<Record<string, number>>;

type FuncName = keyof typeof FUNCTIONS;

const CONSTANTS: Readonly<Record<string, number>> = {
  PI: Math.PI,
  E: Math.E,
};

function fail(code: string, message: string, at: number): CompileResult {
  return { ok: false, error: { code, message, at } };
}

interface Token {
  readonly kind: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  readonly text: string;
  readonly at: number;
}

function tokenize(src: string): Token[] | ExprError {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] ?? '')) j++;
      const text = src.slice(i, j);
      if (Number.isNaN(Number(text))) return { code: 'bad_number', message: '非法数字: ' + text, at: i };
      out.push({ kind: 'num', text, at: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] ?? '')) j++;
      out.push({ kind: 'ident', text: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    if (ch === '(') { out.push({ kind: 'lparen', text: ch, at: i }); i++; continue; }
    if (ch === ')') { out.push({ kind: 'rparen', text: ch, at: i }); i++; continue; }
    if (ch === ',') { out.push({ kind: 'comma', text: ch, at: i }); i++; continue; }
    if ('+-*/%^'.includes(ch)) { out.push({ kind: 'op', text: ch, at: i }); i++; continue; }
    return { code: 'bad_char', message: '非法字符: ' + ch, at: i };
  }
  return out;
}

/** 递归下降解析器。^ 右结合，其余二元运算左结合。 */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: readonly Token[], private readonly allowed: ReadonlySet<string>) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private eat(): Token | undefined { const t = this.tokens[this.pos]; this.pos++; return t; }

  parse(): Node | ExprError {
    const node = this.parseAdd();
    if ('code' in node) return node;
    if (this.pos !== this.tokens.length) {
      const t = this.peek();
      return { code: 'trailing', message: '表达式结尾有多余内容', at: t?.at ?? 0 };
    }
    return node;
  }

  private parseAdd(): Node | ExprError {
    let left = this.parseMul();
    if ('code' in left) return left;
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== 'op' || (t.text !== '+' && t.text !== '-')) break;
      this.eat();
      const right = this.parseMul();
      if ('code' in right) return right;
      left = { kind: 'binary', op: t.text, left, right };
    }
    return left;
  }

  private parseMul(): Node | ExprError {
    let left = this.parseUnary();
    if ('code' in left) return left;
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== 'op' || !'*/%'.includes(t.text)) break;
      this.eat();
      const right = this.parseUnary();
      if ('code' in right) return right;
      left = { kind: 'binary', op: t.text, left, right };
    }
    return left;
  }

  private parseUnary(): Node | ExprError {
    const t = this.peek();
    if (t !== undefined && t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      this.eat();
      const arg = this.parseUnary();
      if ('code' in arg) return arg;
      return { kind: 'unary', op: t.text as '-' | '+', arg };
    }
    return this.parsePow();
  }

  private parsePow(): Node | ExprError {
    const left = this.parseAtom();
    if ('code' in left) return left;
    const t = this.peek();
    if (t !== undefined && t.kind === 'op' && t.text === '^') {
      this.eat();
      const right = this.parseUnary(); // 右结合
      if ('code' in right) return right;
      return { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseAtom(): Node | ExprError {
    const t = this.eat();
    if (t === undefined) return { code: 'unexpected_end', message: '表达式意外结束', at: 0 };
    if (t.kind === 'num') return { kind: 'num', value: Number(t.text) };
    if (t.kind === 'lparen') {
      const inner = this.parseAdd();
      if ('code' in inner) return inner;
      const close = this.eat();
      if (close === undefined || close.kind !== 'rparen') {
        return { code: 'unbalanced', message: '括号不匹配', at: t.at };
      }
      return inner;
    }
    if (t.kind === 'ident') {
      const next = this.peek();
      if (next !== undefined && next.kind === 'lparen') {
        this.eat();
        const args: Node[] = [];
        if (this.peek()?.kind !== 'rparen') {
          for (;;) {
            const arg = this.parseAdd();
            if ('code' in arg) return arg;
            args.push(arg);
            const sep = this.peek();
            if (sep !== undefined && sep.kind === 'comma') { this.eat(); continue; }
            break;
          }
        }
        const close = this.eat();
        if (close === undefined || close.kind !== 'rparen') {
          return { code: 'unbalanced', message: '函数调用括号不匹配', at: t.at };
        }
        const arity: number | undefined = Object.prototype.hasOwnProperty.call(FUNCTIONS, t.text)
          ? FUNCTIONS[t.text as FuncName]
          : undefined;
        if (arity === undefined) {
          // 未知函数必须【拒绝】，而不是当成 0 元函数放行 ——
          // 放行会让 'foo()' 一路编译到一个没有实现的闭包上。
          return { code: 'unknown_function', message: '白名单外的函数: ' + t.text, at: t.at };
        }
        if (args.length !== arity) {
          return { code: 'bad_arity', message: t.text + ' 需要 ' + arity + ' 个参数，给了 ' + args.length, at: t.at };
        }
        return { kind: 'call', name: t.text, args };
      }
      if (CONSTANTS[t.text] !== undefined) return { kind: 'num', value: CONSTANTS[t.text] as number };
      if (this.allowed.has(t.text)) return { kind: 'var', name: t.text };
      return { code: 'unknown_variable', message: '未声明的变量: ' + t.text, at: t.at };
    }
    return { code: 'unexpected_token', message: '意外的符号: ' + t.text, at: t.at };
  }
}

function collectVars(node: Node, out: Set<string>): void {
  switch (node.kind) {
    case 'var': out.add(node.name); return;
    case 'call': for (const a of node.args) collectVars(a, out); return;
    case 'unary': collectVars(node.arg, out); return;
    case 'binary': collectVars(node.left, out); collectVars(node.right, out); return;
    default: return;
  }
}

/**
 * 函数白名单的【实现表】。
 *
 * 键类型就是白名单的键联合（FuncName），所以"登记了却忘了实现"是编译错误。
 * 反过来，"实现了却没登记"也不可能发生 —— 多出来的键通不过类型检查。
 *
 * 为什么不像原来那样在 toClosure 里写一整排 case：那种写法删掉一个 default
 * 就会让 case 穿透到下一个分支（实测踩到过），而且漏实现一个函数只在运行时
 * 表现为"返回了个奇怪的值"。
 */
const FUNCTION_IMPLS: Readonly<Record<FuncName, (args: readonly CompiledExpr[]) => CompiledExpr>> = {
  sin: (a) => (e) => Math.sin((a[0] as CompiledExpr)(e)),
  cos: (a) => (e) => Math.cos((a[0] as CompiledExpr)(e)),
  tan: (a) => (e) => Math.tan((a[0] as CompiledExpr)(e)),
  exp: (a) => (e) => Math.exp((a[0] as CompiledExpr)(e)),
  log: (a) => (e) => Math.log((a[0] as CompiledExpr)(e)),
  sqrt: (a) => (e) => Math.sqrt((a[0] as CompiledExpr)(e)),
  abs: (a) => (e) => Math.abs((a[0] as CompiledExpr)(e)),
  floor: (a) => (e) => Math.floor((a[0] as CompiledExpr)(e)),
  ceil: (a) => (e) => Math.ceil((a[0] as CompiledExpr)(e)),
  round: (a) => (e) => Math.round((a[0] as CompiledExpr)(e)),
  sign: (a) => (e) => Math.sign((a[0] as CompiledExpr)(e)),
  pow: (a) => (e) => Math.pow((a[0] as CompiledExpr)(e), (a[1] as CompiledExpr)(e)),
  min: (a) => (e) => Math.min((a[0] as CompiledExpr)(e), (a[1] as CompiledExpr)(e)),
  max: (a) => (e) => Math.max((a[0] as CompiledExpr)(e), (a[1] as CompiledExpr)(e)),
  mod: (a) => (e) => (a[0] as CompiledExpr)(e) % (a[1] as CompiledExpr)(e),
  atan2: (a) => (e) => Math.atan2((a[0] as CompiledExpr)(e), (a[1] as CompiledExpr)(e)),
  /**
   * ★ 参数序是【被夹值, 下界, 上界】—— clamp(v, lo, hi)。
   *
   * 原来的实现是 clamp(lo, v, hi)，与规范 §7 给的例子 `clamp(t/2.2,0,1)` 直接冲突。
   * 实测后果很隐蔽：clamp(t/2.2, 0, 1) 按旧语义 = lo=t/2.2 → 恒等于 t/2.2，
   * 完全不夹，而且算出来的值超出 [0,1] 也算"合法"，一路流进渲染层。
   * 规范是锁定契约、模型也会照 §7 写，所以改实现而不是改规范。
   */
  clamp: (a) => {
    const v = a[0] as CompiledExpr;
    const lo = a[1] as CompiledExpr;
    const hi = a[2] as CompiledExpr;
    return (e) => {
      const value = v(e);
      if (Number.isNaN(value)) return value;
      const low = lo(e);
      const high = hi(e);
      return value < low ? low : value > high ? high : value;
    };
  },
};

function toClosure(node: Node): CompiledExpr {
  switch (node.kind) {
    case 'num': { const v = node.value; return () => v; }
    case 'var': { const n = node.name; return (env) => env[n] ?? Number.NaN; }
    case 'unary': {
      const arg = toClosure(node.arg);
      return node.op === '-' ? (env) => -arg(env) : (env) => arg(env);
    }
    case 'call': {
      const impl = FUNCTION_IMPLS[node.name as FuncName];
      const args = node.args.map(toClosure);
      return impl(args);
    }
    case 'binary': {
      const l = toClosure(node.left);
      const r = toClosure(node.right);
      switch (node.op) {
        case '+': return (e) => l(e) + r(e);
        case '-': return (e) => l(e) - r(e);
        case '*': return (e) => l(e) * r(e);
        case '/': return (e) => l(e) / r(e);
        case '%': return (e) => l(e) % r(e);
        default: return (e) => Math.pow(l(e), r(e));
      }
    }
  }
}

/** 编译一个表达式。variables 是允许出现的自由变量名。 */
export function compileExpr(source: string, variables: readonly string[] = ['x', 't']): CompileResult {
  const tokens = tokenize(source);
  if (!Array.isArray(tokens)) return { ok: false, error: tokens };
  if (tokens.length === 0) return fail('empty', '表达式为空', 0);
  const parser = new Parser(tokens, new Set(variables));
  const ast = parser.parse();
  if ('code' in ast) return { ok: false, error: ast };
  const used = new Set<string>();
  collectVars(ast, used);
  return { ok: true, eval: toClosure(ast), variables: [...used].sort() };
}
