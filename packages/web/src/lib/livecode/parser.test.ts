// Unit tests for the LIVECODE DSL tokenizer + parser.

import { describe, it, expect } from 'vitest';
import { tokenize, parse, DslError } from './parser';

describe('livecode tokenizer', () => {
  it('tokenizes numbers, idents, punctuation', () => {
    const t = tokenize('drumctl = drumseqz.new()');
    const kinds = t.map((tok) => tok.kind);
    expect(kinds).toEqual([
      'ident', 'punct', 'ident', 'punct', 'ident', 'punct', 'punct', 'eof',
    ]);
  });

  it('tokenizes notes (c3, d4#, gb2, C5)', () => {
    const t = tokenize('c3 d4# gb2 C5');
    const notes = t.filter((tk) => tk.kind === 'note').map((tk) => (tk as { value: string }).value);
    expect(notes).toEqual(['c3', 'd4#', 'gb2', 'c5']);
  });

  it('tokenizes the `-` empty marker as `dash`, not as a number', () => {
    const t = tokenize('[c3, -, c4]');
    expect(t.find((tk) => tk.kind === 'dash')).toBeDefined();
  });

  it('tokenizes negative numbers (e.g. -3.5)', () => {
    const t = tokenize('x = -3.5');
    const num = t.find((tk) => tk.kind === 'number');
    expect((num as { value: number }).value).toBe(-3.5);
  });

  it('tokenizes the `->` operator distinctly from `-`', () => {
    const t = tokenize('a.b -> c.d');
    expect(t.find((tk) => tk.kind === 'punct' && (tk as { value: string }).value === '->')).toBeDefined();
  });

  it('skips // line comments', () => {
    const t = tokenize('// hello\nx = 1');
    const kinds = t.map((tk) => tk.kind);
    expect(kinds).toContain('newline');
    expect(t.filter((tk) => tk.kind === 'ident').map((tk) => (tk as { value: string }).value)).toEqual(['x']);
  });

  it('reports lexical errors with line:col', () => {
    expect(() => tokenize('x = @')).toThrow(DslError);
    try {
      tokenize('\n  @');
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).line).toBe(2);
      expect((e as DslError).col).toBe(3);
    }
  });
});

describe('livecode parser', () => {
  it('parses a spawn assignment', () => {
    const p = parse('drumctl = drumseqz.new()');
    expect(p.statements).toHaveLength(1);
    const s = p.statements[0]!;
    expect(s.kind).toBe('assign');
    if (s.kind === 'assign') {
      expect(s.target.kind).toBe('ident');
      expect(s.value.kind).toBe('spawn');
    }
  });

  it('parses a patch statement', () => {
    const p = parse('clock.out_1x -> drumctl.gate1');
    expect(p.statements).toHaveLength(1);
    const s = p.statements[0]!;
    expect(s.kind).toBe('patch');
    if (s.kind === 'patch') {
      expect(s.from.object).toBe('clock');
      expect(s.from.member).toBe('out_1x');
      expect(s.to.object).toBe('drumctl');
      expect(s.to.member).toBe('gate1');
    }
  });

  it('parses a param assignment to a number', () => {
    const p = parse('drumctl.length = 6');
    const s = p.statements[0]!;
    expect(s.kind).toBe('assign');
    if (s.kind === 'assign') {
      expect(s.target.kind).toBe('member');
      expect(s.value.kind).toBe('number');
    }
  });

  it('parses an array of notes (with empty markers)', () => {
    const p = parse('drumctl.track1 = [c3, -, -, d4, c3, -, -]');
    const s = p.statements[0]!;
    expect(s.kind).toBe('assign');
    if (s.kind === 'assign') {
      expect(s.value.kind).toBe('array');
      if (s.value.kind === 'array') {
        expect(s.value.items).toHaveLength(7);
        expect(s.value.items[0]!.kind).toBe('note');
        expect(s.value.items[1]!.kind).toBe('empty');
      }
    }
  });

  it('parses multi-line programs (newlines as separators)', () => {
    const src = `
      drumctl = drumseqz.new()
      clock = timelorde.new()
      clock.out_1x -> drumctl.gate1
      drumctl.length = 6
    `;
    const p = parse(src);
    expect(p.statements).toHaveLength(4);
  });

  it('accepts `;` as an explicit terminator (multiple stmts on one line)', () => {
    const p = parse('x = vca.new(); y = vca.new()');
    expect(p.statements).toHaveLength(2);
  });

  it('accepts blank lines + interior whitespace', () => {
    const p = parse(`

      x = vca.new()


      y = vca.new()

    `);
    expect(p.statements).toHaveLength(2);
  });

  it('accepts arrays spanning multiple lines', () => {
    const p = parse(`
      x.steps = [
        c3,
        d3,
        e3
      ]
    `);
    expect(p.statements).toHaveLength(1);
  });

  it('reports parse errors with line:col', () => {
    try {
      parse('x = ');
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      const err = e as DslError;
      expect(err.line).toBe(1);
    }
  });

  it('rejects a stray punctuation', () => {
    expect(() => parse('= 1')).toThrow(DslError);
  });

  it('rejects a member on the wrong side of `=`', () => {
    // `1 = x` → first token is a number, not an ident → parse error.
    expect(() => parse('1 = x')).toThrow(DslError);
  });

  it('rejects a malformed patch (missing target member)', () => {
    expect(() => parse('a.b -> c')).toThrow(DslError);
  });

  it('parses bare ident as a value (variable reference inside an expr)', () => {
    // `foo` is not a note (note pattern is [a-g][b#]?\d+), so it falls
    // through as a plain ident — useful for e.g. referencing a previously
    // declared variable inside an array of notes.
    const p = parse('x.steps = [c3, foo, c4]');
    const s = p.statements[0]!;
    if (s.kind === 'assign' && s.value.kind === 'array') {
      expect(s.value.items[1]!.kind).toBe('ident');
      expect(s.value.items[0]!.kind).toBe('note');
      expect(s.value.items[2]!.kind).toBe('note');
    }
  });
});
