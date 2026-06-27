// packages/web/src/lib/video/vfpga/techmap.ts
//
// LUT technology-mapper (hardware-accuracy A5).
//
// A real FPGA toolchain derives a LUT's INIT bits by enumerating the truth table
// of the logic mapped into it. This is exactly that, for our `lut16` cell: parse a
// Boolean expression over the four inputs `a,b,c,d`, evaluate it for all 16 input
// combinations, and pack the results into the 16-bit INIT the lut16 kernel reads.
//
// The lut16 kernel indexes the table as `idx = bitOf(a) | bitOf(b)<<1 |
// bitOf(c)<<2 | bitOf(d)<<3` and outputs `(init >> idx) & 1` — so this compiler
// uses the SAME bit order, making the INIT it produces a drop-in for `uLutInit`.
// It turns magic constants into readable logic: `compileLut('a ^ b ^ c ^ d')`
// === 0x6996 (the 4-input parity / XOR mask databend-cvbs hardcodes today).
//
// Pure / GL-free / deterministic — unit-tested without WebGL. Scope is the lut16
// authoring sugar ONLY (NOT the DSP/BRAM video kernels — that is the §0 line we
// keep). Throws on a malformed expression so a fabric typo surfaces at build time.
//
// Grammar (lowest→highest precedence):
//   or   := xor ('|' xor)*
//   xor  := and ('^' and)*
//   and  := unary ('&' unary)*
//   unary:= ('~' | '!') unary | primary
//   primary := 'a'|'b'|'c'|'d' | '0' | '1' | '(' or ')'

/** Compile a Boolean expression over inputs a,b,c,d into a 16-bit LUT INIT
 *  (0..0xFFFF) matching the lut16 cell's bit order. Throws on a parse error. */
export function compileLut(expr: string): number {
  const ast = parse(expr);
  let init = 0;
  for (let idx = 0; idx < 16; idx++) {
    const env = {
      a: idx & 1,
      b: (idx >> 1) & 1,
      c: (idx >> 2) & 1,
      d: (idx >> 3) & 1,
    } as const;
    if (evalNode(ast, env)) init |= 1 << idx;
  }
  return init >>> 0;
}

/** The 16-entry truth table (output per input index 0..15) a LUT INIT encodes —
 *  the inverse view, handy for docs / inspecting a hand-written init. */
export function lutInitToTruthTable(init: number): boolean[] {
  const t = (init & 0xffff) >>> 0;
  const out: boolean[] = new Array(16);
  for (let i = 0; i < 16; i++) out[i] = ((t >> i) & 1) === 1;
  return out;
}

// ----------------------------------------------------------------------
// Tiny recursive-descent Boolean parser → AST.
// ----------------------------------------------------------------------
type Node =
  | { k: 'var'; v: 'a' | 'b' | 'c' | 'd' }
  | { k: 'const'; v: 0 | 1 }
  | { k: 'not'; x: Node }
  | { k: 'and' | 'or' | 'xor'; l: Node; r: Node };

function parse(expr: string): Node {
  const src = expr;
  let i = 0;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const peek = (): string => {
    skip();
    return i < src.length ? src[i]! : '';
  };
  const eat = (ch: string) => {
    skip();
    if (src[i] !== ch) throw new Error(`techmap: expected "${ch}" at ${i} in "${src}"`);
    i++;
  };

  const primary = (): Node => {
    const c = peek();
    if (c === '(') {
      eat('(');
      const n = or();
      eat(')');
      return n;
    }
    if (c === '~' || c === '!') {
      i++;
      return { k: 'not', x: unary() };
    }
    if (c === '0' || c === '1') {
      i++;
      return { k: 'const', v: c === '1' ? 1 : 0 };
    }
    if (c === 'a' || c === 'b' || c === 'c' || c === 'd') {
      i++;
      return { k: 'var', v: c };
    }
    throw new Error(`techmap: unexpected "${c || '<eof>'}" at ${i} in "${src}"`);
  };
  const unary = (): Node => {
    const c = peek();
    if (c === '~' || c === '!') {
      i++;
      return { k: 'not', x: unary() };
    }
    return primary();
  };
  const and = (): Node => {
    let n = unary();
    while (peek() === '&') { i++; n = { k: 'and', l: n, r: unary() }; }
    return n;
  };
  const xor = (): Node => {
    let n = and();
    while (peek() === '^') { i++; n = { k: 'xor', l: n, r: and() }; }
    return n;
  };
  const or = (): Node => {
    let n = xor();
    while (peek() === '|') { i++; n = { k: 'or', l: n, r: xor() }; }
    return n;
  };

  skip();
  if (i >= src.length) throw new Error(`techmap: empty expression`);
  const root = or();
  skip();
  if (i < src.length) throw new Error(`techmap: trailing "${src.slice(i)}" in "${src}"`);
  return root;
}

function evalNode(n: Node, env: { a: number; b: number; c: number; d: number }): boolean {
  switch (n.k) {
    case 'var':
      return env[n.v] === 1;
    case 'const':
      return n.v === 1;
    case 'not':
      return !evalNode(n.x, env);
    case 'and':
      return evalNode(n.l, env) && evalNode(n.r, env);
    case 'or':
      return evalNode(n.l, env) || evalNode(n.r, env);
    case 'xor':
      return evalNode(n.l, env) !== evalNode(n.r, env);
  }
}
