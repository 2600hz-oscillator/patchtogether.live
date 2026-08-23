// packages/web/src/lib/ui/workflow/warped-fader-source.test.ts
//
// THE WARPED-FADER CELL'S ONE-SOURCE RULE, AT THE SOURCE LEVEL — because no
// runtime gate can see the defect.
//
// ⚠ WHAT IS STRUCTURALLY INVISIBLE HERE, stated so the gate's scope is not
// mistaken for its strength. A `warped-fader` cell that RE-TYPES its module's
// conversion instead of importing it produces a fader that renders correctly,
// writes correct param values, and passes every runtime assertion — right up
// until someone corrects the map in one place. Then the CARD and the FACE
// disagree about where unity sits, both are internally consistent, and nothing
// fails. That is the backdraft class (a card silently disagreeing with its def),
// applied to a function instead of a number, and the only place to catch it is
// the text of the declaration.
//
// So this gate greps. It is deny-by-default over the cell registry: every
// `warped-fader` cell must take its `toKnob`/`fromKnob` from an IMPORTED
// identifier, never from a function literal written at the call site.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELLS_SRC = resolve(HERE, './shell-cells.ts');
const SHELL_SRC = resolve(HERE, '../modules/ModuleShell.svelte');

/**
 * ⚠ THE REGISTRY ONLY, NOT THE INTERFACE — and this slice is a fix for a real
 * false positive, kept as a comment because the mistake is so easy to repeat.
 * `ShellWarpedFaderCell` declares `kind: 'warped-fader'` too, and its own doc
 * comment spells the converter SIGNATURES (`toKnob: (value: number) => number`).
 * A scanner over the whole file therefore "finds" two inline arrows and reports
 * the TYPE as an offending cell — a confident, plausible, false finding, on a
 * file with no declared cells at all. Scope to the registry const.
 */
const cellsText = (): string => {
  const src = readFileSync(CELLS_SRC, 'utf8');
  const i = src.indexOf('const SHELL_CELLS');
  expect(i, 'shell-cells.ts still declares SHELL_CELLS — the gate reads nothing otherwise')
    .toBeGreaterThan(-1);
  return src.slice(i);
};

/**
 * Every `kind: 'warped-fader'` literal in the registry, with the text of the
 * object it opens — sliced to the next `kind:` or the end, which is coarse but
 * cannot MISS a declaration (it can only over-include, and over-including makes
 * the gate stricter rather than blinder).
 */
function warpedCellBlocks(src: string): string[] {
  const out: string[] = [];
  const re = /kind:\s*'warped-fader'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(m.index);
    const next = rest.slice(1).search(/\n\s*kind:\s*'/);
    out.push(next === -1 ? rest : rest.slice(0, next + 1));
  }
  return out;
}

describe('warped-fader cells import their map — they never re-type it', () => {
  it('no declared cell writes a conversion INLINE', () => {
    // An arrow body or a `function` on either converter is the re-typed map.
    // A bare identifier (`toKnob: knobToRate`) is what this requires.
    const offenders: string[] = [];
    for (const block of warpedCellBlocks(cellsText())) {
      for (const key of ['toKnob', 'fromKnob']) {
        const decl = new RegExp(`${key}\\s*:\\s*([^,\\n]+)`).exec(block);
        if (!decl) continue;
        const rhs = decl[1]!.trim();
        if (/=>|function\b/.test(rhs)) {
          offenders.push(
            `${key}: ${rhs} — inline conversion. Import the module's own map instead ` +
              '(the card and this cell must convert IDENTICALLY, and nothing at runtime ' +
              'can tell you when they stop).',
          );
        }
      }
    }
    expect(offenders, 'warped-fader cells with a re-typed conversion').toEqual([]);
  });

  it('⚠ NEGATIVE CONTROL: the predicate CATCHES a re-typed map', () => {
    // Without this the test above passes just as happily on a registry with no
    // warped cells at all, or on a scanner whose regex silently matches nothing
    // — "found no offenders" and "looked at nothing" are the same output.
    const fake = `
      rate: {
        kind: 'warped-fader',
        label: 'Rate',
        paramId: 'rate',
        toKnob: (v) => (v + 2) / 6,
        fromKnob: rateFromKnob,
      },
    `;
    const blocks = warpedCellBlocks(fake);
    expect(blocks.length, 'the scanner finds a declaration at all').toBe(1);
    expect(/toKnob\s*:\s*[^,\n]*=>/.test(blocks[0]!), 'and sees the inline arrow').toBe(true);
  });

  it('⚠ NEGATIVE CONTROL: an IMPORTED map is accepted', () => {
    // The other direction: a gate that rejected everything would also show zero
    // offenders on an empty registry and look identical from the output.
    const good = `
      rate: {
        kind: 'warped-fader',
        toKnob: rateToKnob,
        fromKnob: knobToRate,
      },
    `;
    const block = warpedCellBlocks(good)[0]!;
    for (const key of ['toKnob', 'fromKnob']) {
      const rhs = new RegExp(`${key}\\s*:\\s*([^,\\n]+)`).exec(block)![1]!.trim();
      expect(/=>|function\b/.test(rhs), `${key} is a bare identifier`).toBe(false);
    }
  });
});

// ⚠ THE ANCHOR IS `paramCell`, NOT `cell`, AND THE RENAME IS THE STORY. This
// branch used to live in ModuleShell's FAMILY/STATIC cell chain, where a `param`
// control can never go — so it was unreachable from the day #2144 merged and
// these assertions were guarding dead code. Both halves had to move: the
// resolver had to stop refusing param controls, and the render had to move into
// the `ctl.kind === 'param'` arm. Nothing here went red during any of that,
// because a source gate can only see the code it is pointed at — the VRT dock
// baseline is what finally showed a KNOB where a fader was declared.
describe('the renderer draws KNOB SPACE, not the param range', () => {
  it('the warped branch passes 0..1, never pd.min/pd.max', () => {
    // ⚠ THE ONE-LINE REGRESSION THIS FILE EXISTS FOR. Someone "fixing" the
    // fader to use the param's own bounds restores the exact linear rendering
    // the cell was built to prevent — and it typechecks, renders, and writes
    // correct values. Only the GEOMETRY is wrong, and no runtime gate reads
    // geometry.
    const shell = readFileSync(SHELL_SRC, 'utf8');
    const i = shell.indexOf("paramCell?.kind === 'warped-fader'");
    expect(i, 'the renderer still has a warped-fader branch').toBeGreaterThan(-1);
    const branch = shell.slice(i, shell.indexOf("{:else if", i + 10));
    expect(/min=\{0\}/.test(branch), 'min is knob-space 0').toBe(true);
    expect(/max=\{1\}/.test(branch), 'max is knob-space 1').toBe(true);
    expect(
      /min=\{(?:wpd|pd)[?.]/.test(branch) || /max=\{(?:wpd|pd)[?.]/.test(branch),
      'the branch must NOT bind the fader to the ParamDef range — that is the linear break',
    ).toBe(false);
  });

  it('landmarks reach the primitive through toKnob, not raw', () => {
    const shell = readFileSync(SHELL_SRC, 'utf8');
    const i = shell.indexOf("paramCell?.kind === 'warped-fader'");
    const branch = shell.slice(i, shell.indexOf("{:else if", i + 10));
    const flat = branch.replace(/\s+/g, ' ');
    // ⚠ NOT `[^)]*` between the two — the arrow's own parameter list `((lm) =>`
    // contains a `)`, so that form can never match and the gate would be
    // vacuously red. Anchor on the two facts instead: the ticks come from
    // `landmarks`, and `frac` is computed by `toKnob`.
    expect(/ticks=\{ ?paramCell\.landmarks\.map\(/.test(flat), 'ticks derive from the landmarks').toBe(true);
    expect(
      /frac: ?paramCell\.toKnob\(/.test(flat),
      'each landmark is PLACED at toKnob(value) — a raw value would place it linearly',
    ).toBe(true);
  });
});
