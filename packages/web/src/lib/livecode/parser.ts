// packages/web/src/lib/livecode/parser.ts
//
// Live-coding DSL — tokenizer + parser. The grammar is small enough that
// a hand-written recursive-descent parser is faster to read than a
// generator. Every error carries `line` and `col` so the LIVECODE card
// can highlight the failing position.
//
// Grammar (informal, line-terminated; statements separated by `;` or NL):
//
//   stmt        := assign | patch | spawn-stmt
//   assign      := MemberOrIdent '=' expr
//   patch       := Member '->' Member
//   spawn-stmt  := Ident '=' Ident '.new' '(' ')'   (special-case of assign)
//
//   expr        := number | note | empty | array | spawn | Member | Ident
//   spawn       := Ident '.new' '(' ')'
//   array       := '[' (expr (',' expr)*)? ']'
//   number      := /-?\d+(\.\d+)?/
//   note        := /[a-g][b#]?\d+/   (case-insensitive; `c3`, `d4#`, `gb2`)
//   empty       := '-'
//   Member      := Ident '.' Ident
//   Ident       := /[A-Za-z_][A-Za-z0-9_]*/
//
// Comments: `//` to end of line.

export type Token =
  | { kind: 'ident'; value: string; line: number; col: number }
  | { kind: 'number'; value: number; line: number; col: number }
  | { kind: 'note'; value: string; line: number; col: number }
  | { kind: 'dash'; line: number; col: number }
  | { kind: 'punct'; value: '=' | '->' | '.' | '(' | ')' | '[' | ']' | ',' | ';'; line: number; col: number }
  | { kind: 'newline'; line: number; col: number }
  | { kind: 'eof'; line: number; col: number };

export class DslError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`${line}:${col}: ${message}`);
    this.name = 'DslError';
  }
}

/** Tokenize a source string. Throws DslError on lexical errors. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  function makePos() {
    return { line, col };
  }
  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  }

  while (i < src.length) {
    const ch = src[i]!;
    // Comments
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance();
      continue;
    }
    // Newlines (statement terminators)
    if (ch === '\n') {
      tokens.push({ kind: 'newline', ...makePos() });
      advance();
      continue;
    }
    // Whitespace (other than newline)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    // ';' — statement terminator
    if (ch === ';') {
      tokens.push({ kind: 'punct', value: ';', ...makePos() });
      advance();
      continue;
    }
    // '->' — patch operator
    if (ch === '-' && src[i + 1] === '>') {
      tokens.push({ kind: 'punct', value: '->', ...makePos() });
      advance(2);
      continue;
    }
    // '-' alone — empty marker for sequencer steps
    if (ch === '-' && !isDigit(src[i + 1] ?? '')) {
      // Disambiguate: a bare `-` is the empty marker. A `-` followed by a
      // digit (and not preceded by a non-arithmetic context) is a negative
      // number — we only support negatives when introduced as a unary
      // prefix outside of identifier context. v1 keeps it simple: bare `-`
      // is always the dash marker; negative numbers can be written with
      // explicit unary later if we need them.
      tokens.push({ kind: 'dash', ...makePos() });
      advance();
      continue;
    }
    // Numbers (including negatives via leading -)
    if (isDigit(ch) || (ch === '-' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      const startPos = makePos();
      if (ch === '-') advance();
      while (i < src.length && isDigit(src[i] ?? '')) advance();
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        advance();
        while (i < src.length && isDigit(src[i] ?? '')) advance();
      }
      const text = src.slice(start, i);
      const num = Number(text);
      if (!Number.isFinite(num)) {
        throw new DslError(`Invalid number: ${text}`, startPos.line, startPos.col);
      }
      tokens.push({ kind: 'number', value: num, ...startPos });
      continue;
    }
    // Punctuation
    if (ch === '=' || ch === '.' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',') {
      tokens.push({ kind: 'punct', value: ch as '=' | '.' | '(' | ')' | '[' | ']' | ',', ...makePos() });
      advance();
      continue;
    }
    // Identifiers / notes / keywords
    if (isIdentStart(ch)) {
      const startPos = makePos();
      const start = i;
      while (i < src.length && isIdentCont(src[i] ?? '')) advance();
      // Notes-with-trailing-accidental form: `d4#`, `gb2#` (the user spec
      // uses `d4#` not `d#4`). After consuming the ident chars, peek for
      // a `#` or `b` IF the consumed text matches `[a-g]\d+`. Otherwise
      // leave the cursor where it is — `#` followed by an identifier
      // would be a tokenizer error elsewhere, which we want.
      const textSoFar = src.slice(start, i);
      if (
        /^[a-gA-G]\d+$/.test(textSoFar) &&
        (src[i] === '#' || src[i] === 'b' || src[i] === 'B')
      ) {
        advance();
      }
      const text = src.slice(start, i);
      // Note literal? Single letter [a-g] optionally followed by # or b,
      // then digits, with NO trailing identifier chars. The tokenizer
      // doesn't know about the `.` access pattern — we emit a `note`
      // token only when the shape matches strictly and there's no
      // continuing ident character (which never happens here because
      // the loop above already broke out, but the form-match itself is
      // what gates note vs ident).
      if (isNoteShape(text)) {
        tokens.push({ kind: 'note', value: text.toLowerCase(), ...startPos });
      } else {
        tokens.push({ kind: 'ident', value: text, ...startPos });
      }
      continue;
    }
    throw new DslError(`Unexpected character '${ch}'`, line, col);
  }
  tokens.push({ kind: 'eof', line, col });
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}
function isNoteShape(text: string): boolean {
  // c3, d#4, gb2 (case-insensitive). At most ONE accidental, REQUIRED
  // octave digit. We intentionally accept both `d#4` and `d4#` orders
  // since the user spec uses the latter (`d4#`). The semantic mapper
  // (in evaluator) normalizes both to the same MIDI number.
  return /^[a-gA-G][b#]?\d+$/i.test(text) || /^[a-gA-G]\d+[b#]$/.test(text);
}

// ---------------- AST ----------------

export type Expr =
  | { kind: 'number'; value: number; pos: Pos }
  | { kind: 'note'; value: string; pos: Pos }     // raw note text e.g. 'c3', 'd4#'
  | { kind: 'empty'; pos: Pos }                    // the bare `-` placeholder
  | { kind: 'array'; items: Expr[]; pos: Pos }
  | { kind: 'spawn'; moduleType: string; pos: Pos } // <ident>.new()
  | { kind: 'ident'; name: string; pos: Pos }      // bare variable / module-name reference
  | { kind: 'member'; object: string; member: string; pos: Pos }; // <ident>.<ident>

export type Stmt =
  | { kind: 'assign'; target: AssignTarget; value: Expr; pos: Pos }
  | { kind: 'patch'; from: MemberRef; to: MemberRef; pos: Pos };

export type AssignTarget =
  | { kind: 'ident'; name: string; pos: Pos }      // x = expr
  | { kind: 'member'; object: string; member: string; pos: Pos }; // x.frequency = expr

export interface MemberRef {
  object: string;
  member: string;
  pos: Pos;
}

export interface Pos {
  line: number;
  col: number;
}

export interface Program {
  statements: Stmt[];
}

// ---------------- Parser ----------------

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Program {
    const statements: Stmt[] = [];
    while (!this.atEof()) {
      this.skipTerminators();
      if (this.atEof()) break;
      const stmt = this.parseStmt();
      if (stmt) statements.push(stmt);
      // After a statement, expect a newline / `;` / EOF.
      if (!this.atEof()) this.expectTerminator();
    }
    return { statements };
  }

  private parseStmt(): Stmt {
    const startTok = this.peek();
    // Statement starts with an Ident. Look ahead: `.` => member-form, then
    // either `=` (assign-member) or `->` (patch). Bare ident => `=` only.
    const first = this.expectIdent();
    if (this.match('punct', '.')) {
      const member = this.expectIdent();
      // Member followed by '=' or '->' or '.new(' (spawn — only valid as
      // a value, but we accept `x.new()` followed by terminator only as
      // "discarded spawn result"; rare but harmless).
      if (member.value === 'new' && this.match('punct', '(')) {
        // `<type>.new()` as a statement → spawn discarded. Permit but
        // require the closing `)`; spawn-discarded becomes an assign to a
        // synthetic anonymous slot the evaluator understands. v1: just
        // make it an assign to the type name itself (so user can refer
        // back to it implicitly via the auto-name later).
        this.expect('punct', ')');
        // Treat it like `<first> = <first>.new()` so the spawned module
        // is bound to a variable matching its declared type. Cheap, easy.
        return {
          kind: 'assign',
          target: { kind: 'ident', name: first.value, pos: { line: first.line, col: first.col } },
          value: { kind: 'spawn', moduleType: first.value, pos: { line: first.line, col: first.col } },
          pos: { line: first.line, col: first.col },
        };
      }
      if (this.match('punct', '=')) {
        const value = this.parseExpr();
        return {
          kind: 'assign',
          target: {
            kind: 'member',
            object: first.value,
            member: member.value,
            pos: { line: first.line, col: first.col },
          },
          value,
          pos: { line: first.line, col: first.col },
        };
      }
      if (this.match('punct', '->')) {
        const toObj = this.expectIdent();
        this.expect('punct', '.');
        const toMember = this.expectIdent();
        return {
          kind: 'patch',
          from: {
            object: first.value,
            member: member.value,
            pos: { line: first.line, col: first.col },
          },
          to: {
            object: toObj.value,
            member: toMember.value,
            pos: { line: toObj.line, col: toObj.col },
          },
          pos: { line: first.line, col: first.col },
        };
      }
      throw new DslError(
        `After '${first.value}.${member.value}', expected '=' or '->'`,
        this.peek().line,
        this.peek().col,
      );
    }
    if (this.match('punct', '=')) {
      const value = this.parseExpr();
      return {
        kind: 'assign',
        target: { kind: 'ident', name: first.value, pos: { line: first.line, col: first.col } },
        value,
        pos: { line: first.line, col: first.col },
      };
    }
    throw new DslError(
      `Expected '.', '=', or '->' after '${first.value}'`,
      this.peek().line,
      this.peek().col,
    );
  }

  private parseExpr(): Expr {
    const tok = this.peek();
    if (tok.kind === 'number') {
      this.pos++;
      return { kind: 'number', value: tok.value, pos: { line: tok.line, col: tok.col } };
    }
    if (tok.kind === 'note') {
      this.pos++;
      return { kind: 'note', value: tok.value, pos: { line: tok.line, col: tok.col } };
    }
    if (tok.kind === 'dash') {
      this.pos++;
      return { kind: 'empty', pos: { line: tok.line, col: tok.col } };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.pos++;
      const items: Expr[] = [];
      // Accept optional newlines inside arrays so users can format them.
      this.skipNewlines();
      if (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseExpr());
        this.skipNewlines();
        while (this.match('punct', ',')) {
          this.skipNewlines();
          items.push(this.parseExpr());
          this.skipNewlines();
        }
      }
      this.expect('punct', ']');
      return { kind: 'array', items, pos: { line: tok.line, col: tok.col } };
    }
    if (tok.kind === 'ident') {
      this.pos++;
      // .member or .new()?
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '.') {
        this.pos++;
        const member = this.expectIdent();
        if (member.value === 'new' && this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.pos++;
          this.expect('punct', ')');
          return { kind: 'spawn', moduleType: tok.value, pos: { line: tok.line, col: tok.col } };
        }
        return {
          kind: 'member',
          object: tok.value,
          member: member.value,
          pos: { line: tok.line, col: tok.col },
        };
      }
      return { kind: 'ident', name: tok.value, pos: { line: tok.line, col: tok.col } };
    }
    throw new DslError(
      `Expected expression, got '${describeToken(tok)}'`,
      tok.line,
      tok.col,
    );
  }

  // ---------------- Token helpers ----------------

  private peek(off = 0): Token {
    return this.tokens[this.pos + off]!;
  }
  private atEof(): boolean {
    return this.peek().kind === 'eof';
  }
  private expectIdent(): { value: string; line: number; col: number } {
    const t = this.peek();
    if (t.kind !== 'ident') {
      throw new DslError(
        `Expected identifier, got '${describeToken(t)}'`,
        t.line,
        t.col,
      );
    }
    this.pos++;
    return { value: t.value, line: t.line, col: t.col };
  }
  private expect(kind: 'punct', value: string): void {
    const t = this.peek();
    if (t.kind !== kind || (t as { value: string }).value !== value) {
      throw new DslError(
        `Expected '${value}', got '${describeToken(t)}'`,
        t.line,
        t.col,
      );
    }
    this.pos++;
  }
  private match(kind: 'punct', value: string): boolean {
    const t = this.peek();
    if (t.kind === kind && (t as { value: string }).value === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectTerminator(): void {
    // Newline or `;` or EOF.
    const t = this.peek();
    if (t.kind === 'newline' || (t.kind === 'punct' && t.value === ';')) {
      this.pos++;
      return;
    }
    if (t.kind === 'eof') return;
    throw new DslError(
      `Expected end of statement (newline or ';'), got '${describeToken(t)}'`,
      t.line,
      t.col,
    );
  }
  private skipTerminators(): void {
    while (true) {
      const t = this.peek();
      if (t.kind === 'newline') {
        this.pos++;
        continue;
      }
      if (t.kind === 'punct' && t.value === ';') {
        this.pos++;
        continue;
      }
      break;
    }
  }
  private skipNewlines(): void {
    while (this.peek().kind === 'newline') this.pos++;
  }
}

function describeToken(t: Token): string {
  if (t.kind === 'eof') return 'end of input';
  if (t.kind === 'newline') return 'newline';
  if (t.kind === 'ident') return t.value;
  if (t.kind === 'number') return String(t.value);
  if (t.kind === 'note') return t.value;
  if (t.kind === 'dash') return '-';
  return t.value;
}

/** Top-level entry: tokenize + parse. */
export function parse(src: string): Program {
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  return parser.parse();
}
