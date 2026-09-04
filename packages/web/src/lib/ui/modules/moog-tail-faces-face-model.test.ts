// packages/web/src/lib/ui/modules/moog-tail-faces-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the MOOG TAIL faceplates — the
// two-and-three-control Moog System modules faced in batch 18.
//
// THREE THINGS HERE ARE NOT VISIBLE TO ANY OTHER GATE:
//
//   1. `moog904b`'s RANGE roster is what makes its cell a SEGMENTED pair rather
//      than an anonymous two-position dial. The cell kind is DERIVED from
//      `options`, so deleting the roster silently downgrades the control and
//      nothing goes red — the gatemaiden failure mode exactly.
//   2. NO SURFACE MAY RE-TYPE THAT ROSTER. This is the backdraft class: a
//      surface can silently disagree with its def, and every def-reading gate
//      is blind to it. So the check here is at the SOURCE level, over the whole
//      module-surface tree, because no runtime gate sees a literal in a
//      `.svelte` file.
//   3. `moog904c`'s `mode` deliberately has NO landmarks. An omission and a
//      decision look identical in a def; this makes the decision falsifiable.
//
// ⚠ THESE ARE MODEL ASSERTIONS, NOT PIXEL ONES. What renders is proven by the
// VRT scenes; what this file proves is that the declarations the renderer reads
// still say what these faces were built on.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { moog904bDef, MOOG904B_RANGE_OPTIONS } from '$lib/audio/modules/moog904b';
import { moog904cDef } from '$lib/audio/modules/moog904c';
import { moog905Def } from '$lib/audio/modules/moog905';
import { moog961Def } from '$lib/audio/modules/moog961';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_MOMENTARY: ReadonlySet<string> = new Set();

/** ANCHORED TO THE ARTIFACT: each row carries the def, so a renamed or deleted
 *  module is a compile error rather than a silently skipped row. */
const MOOG_TAIL = [
  { type: 'moog904b', def: moog904bDef, order: ['cutoff', 'range'], glyph: 'meter' },
  { type: 'moog904c', def: moog904cDef, order: ['cutoff', 'width', 'mode'], glyph: 'meter' },
  { type: 'moog905', def: moog905Def, order: ['mix', 'decay', 'size'], glyph: 'meter' },
  { type: 'moog961', def: moog961Def, order: ['sensitivity', 'switchOnTime'], glyph: 'none' },
] as const;

function param(def: { params: readonly ParamDef[] }, id: string): ParamDef {
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`no param '${id}'`);
  return p;
}

describe('moog tail faces — promotion, ranking and honest bands', () => {
  it('each is PROMOTED, ranks every param it declares, and plans exactly ONE band', () => {
    for (const { type, def, order } of MOOG_TAIL) {
      expect(STRICT_FACES.has(type), `${type} promoted`).toBe(true);
      expect(def.face?.order, `${type} order`).toEqual(order);
      // Completeness both directions — the face ranks the def's whole roster.
      expect([...def.params.map((p) => p.id)].sort(), `${type} params`).toEqual([...order].sort());
      // The band count the VRT roster copies as `pages`, which nothing else
      // checks (`shell-faces-roster.test.ts` cross-checks only `tabbedOptIn`).
      const plan = dockFacePlan(def as never);
      expect(plan, `${type}: planned as UN-FACED`).not.toBeNull();
      expect(plan!.length, `${type}: dock bands (the roster's \`pages\`)`).toBe(1);
    }
  });

  it('NO face in this batch declares paramCells, pages, a hero or a title', () => {
    // Note `moog904b` especially: its segmented RANGE cell is DERIVED from the
    // options roster, never declared as a cell.
    const problems: string[] = [];
    for (const { type, def } of MOOG_TAIL) {
      const f = def.face as Record<string, unknown> | undefined;
      for (const field of ['paramCells', 'momentary', 'pages', 'hero', 'title', 'hint', 'xyPads', 'bareCells', 'extension', 'tabbed']) {
        if (f && f[field] !== undefined) problems.push(`${type}: declares face.${field}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the defaults these faces were authored against still ship', () => {
    expect(param(moog904bDef, 'cutoff').defaultValue).toBe(1000);
    expect(param(moog904bDef, 'range').defaultValue).toBe(1); // LOW
    expect(param(moog904cDef, 'cutoff').defaultValue).toBe(800);
    expect(param(moog904cDef, 'mode').defaultValue).toBe(0); // band-pass
    expect(param(moog905Def, 'mix').defaultValue).toBe(0.35);
    expect(param(moog961Def, 'sensitivity').defaultValue).toBe(0.5);
  });
});

describe('moog904b — the RANGE roster, and the surfaces that must not re-type it', () => {
  it('the roster is the def’s own export, and RESOLVES to a segmented pair at the dock', () => {
    const range = param(moog904bDef, 'range');
    expect(range.options, 'moog904b RANGE must declare its positions').toBeDefined();
    expect(range.options!.map((o) => o.label)).toEqual(['LOW', 'HIGH']);

    // TOTAL over the param's own range — never a typed length.
    expect(range.options!.map((o) => o.value)).toEqual(
      Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i),
    );

    // The clause that proves the roster changed what RENDERS. Short enough for
    // buttons rather than a dropdown, which is what this control has always been.
    expect(range.options!.length).toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(range, NO_MOMENTARY, 'dock')).toBe('segmented');
  });

  it('NEGATIVE CONTROL: without the roster the same param is an ANONYMOUS dial', () => {
    // The failure mode is silent — delete `options` and the control still
    // works, still writes the same values, and simply stops having names.
    const range = param(moog904bDef, 'range');
    const stripped: ParamDef = { ...range };
    delete (stripped as { options?: unknown }).options;
    expect(paramCellKind(stripped, NO_MOMENTARY, 'dock')).toBe('knob');
  });

  it('SOURCE GATE: NO surface re-types the position names — the def is their one home', () => {
    // ⚠ THE BACKDRAFT CLASS. A surface can silently disagree with its def and
    // every def-reading gate is blind to it, so this reads SOURCE. The names
    // used to live in the card as a literal array, which meant two places could
    // disagree about what the two states are called.
    //
    // ⚠ THE SUBJECT WIDENED WHEN THE CARD LEFT. This read one file and asserted
    // it imported `MOOG904B_RANGE_OPTIONS`; the honest successor is that NO
    // module surface re-types the literal, which is the invariant the import was
    // standing in for. The walk is flat plus one level of module subdirectory —
    // the depth a `fullViewBody` lives at — so a re-typed roster in a face body
    // reddens exactly as a re-typed roster in a card did.
    //
    // Matching raw SOURCE means a comment that merely spells the literal out
    // also fails, deliberately and exactly as `card-range-source` does for
    // backdraft: the gate greps text and cannot tell code from prose, and that
    // is the safe direction to err.
    const RE_TYPED = /label:\s*'(LOW|HIGH)'/;
    const offenders: string[] = [];
    let scanned = 0;
    for (const entry of readdirSync(HERE, { withFileTypes: true })) {
      const visit = (rel: string, abs: string): void => {
        scanned++;
        if (RE_TYPED.test(readFileSync(abs, 'utf8'))) offenders.push(rel);
      };
      if (entry.isDirectory()) {
        for (const inner of readdirSync(join(HERE, entry.name))) {
          if (inner.endsWith('.svelte')) visit(`${entry.name}/${inner}`, join(HERE, entry.name, inner));
        }
        continue;
      }
      if (entry.name.endsWith('.svelte')) visit(entry.name, join(HERE, entry.name));
    }
    expect(scanned, 'the surface walk resolved no .svelte files').toBeGreaterThan(0);
    expect(
      offenders,
      'a surface re-types a RANGE position name — read MOOG904B_RANGE_OPTIONS off the def instead',
    ).toEqual([]);

    // …and the def really is where they live, so this is one home rather than
    // none: a deleted roster would empty the offender list too.
    expect(param(moog904bDef, 'range').options?.map((o) => o.label)).toEqual(['LOW', 'HIGH']);
  });
});

describe('moog tail faces — the GLYPH decision, run through the real resolver', () => {
  it('each face resolves to the binding it declares', () => {
    for (const { type, def, glyph } of MOOG_TAIL) {
      expect(def.face?.glyph, `${type} declared glyph`).toBe(glyph);
      expect(glyphBinding(def as never).kind, `${type} binding`).toBe(
        glyph === 'none' ? 'none' : 'live-audio',
      );
    }
  });

  it('moog961: the `none` is FORCED, and "it is an audio module" is the wrong inference', () => {
    // The trap this clause exists for: moog961 has an audio INPUT and an audio
    // DOMAIN, so reasoning from the module's description says "meter". The
    // resolver matches audio OUTPUTS, and all four of this module's outputs are
    // gates — so a meter would be the DEAD `static` binding marbles shipped.
    expect(primaryAudioOutPortId(moog961Def as never)).toBeNull();
    expect(moog961Def.inputs.some((i) => i.type === 'audio')).toBe(true);
    expect(moog961Def.outputs.every((o) => o.type === 'gate')).toBe(true);

    const withMeter = { ...moog961Def, face: { ...moog961Def.face!, glyph: 'meter' } };
    expect(glyphBinding(withMeter as never).kind).toBe('static');
  });

  it('the three meters are TOTAL — each module has exactly one audio output', () => {
    // What separates these from `moog994`, which refused a meter that would
    // have bound live: a one-port meter is dishonest only when the ports are
    // INDEPENDENT. With a single audio out there is no second path to misread.
    for (const def of [moog904bDef, moog904cDef, moog905Def]) {
      expect(def.outputs.filter((o) => o.type === 'audio')).toHaveLength(1);
      expect(primaryAudioOutPortId(def as never)).toBe('audio');
    }
  });
});

describe('moog904c — the landmarks NOT declared', () => {
  it('`mode` is a CONTINUOUS morph that declares neither options nor landmarks', () => {
    // Pinning a DECISION, not an omission — the two are indistinguishable in a
    // def. `mode` crossfades band-pass → notch and is exactly the PF-10 shape,
    // but its state names have never appeared in the UI (the card renders a
    // bare `<Knob label="Mode">`), so naming them here would be INVENTING a
    // vocabulary during a face migration. If landmarks are added later that is
    // a deliberate change and this clause is where it gets re-decided.
    const mode = param(moog904cDef, 'mode');
    expect(mode.curve).toBe('linear');
    expect(mode.min).toBe(0);
    expect(mode.max).toBe(1);
    expect(mode.options).toBeUndefined();
    expect((mode as { landmarks?: unknown }).landmarks).toBeUndefined();
    // …and with no roster it renders as the plain knob the card draws.
    expect(paramCellKind(mode, NO_MOMENTARY, 'dock')).toBe('knob');
  });
});
