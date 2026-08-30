// packages/web/src/lib/ui/modules/one-knob-faces-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS behind the ONE-KNOB faceplates — audio
// utilities whose entire control surface is a single param.
//
// WHY ONE FILE. The reason to read these four together is a CONTRAST that no
// single-module file could state. `moog962` and `sampleHold` each have exactly
// one DISCRETE param, and the pair separates TWO questions that look like one:
//
//   · WHAT ARE THE STATES CALLED? sampleHold's ten scale NAMES already existed
//     — the legacy card renders them in its own element above the knob — and
//     the shell could not reach them, so they are PROMOTED into `options`.
//     moog962's two states have no semantic names, so they are labelled with
//     their own values ('2', '3'), which invents nothing.
//   · CAN A PLAYER REACH EACH STATE? Both get a roster, because the roster is
//     also the ONLY mechanism that yields a segmented cell — `face.paramCells`
//     has no segmented kind to declare.
//
// ⚠ THE SECOND QUESTION WAS MISSED ON THE FIRST PASS AND CI CAUGHT IT. moog962
// originally shipped with NO roster, on the reasoning that its values are their
// own labels; `faces-parity` then failed both attempts with *"moog962 cell
// 'stages' (param/knob): dragging the knob commits a param change into the
// graph"*. A `2..3 discrete` param has exactly two reachable positions across
// the dial's whole travel, so a drag quantises back to where it started and the
// control is INERT — a real usability defect the legacy card shares.
//
// So the rule is: a roster makes states SELECTABLE, and its labels must be the
// module's real names where it has them and never fabricated semantics. That is
// the clause most likely to erode in a later pass, in either direction.
//
// The same contrast runs through the glyphs: two of these modules take a live
// meter and two refuse one, for reasons that are properties of their PORTS.
//
// ⚠ THESE ARE MODEL ASSERTIONS, NOT PIXEL ONES. What renders is proven by the
// VRT scenes; what this file proves is that the declarations the renderer reads
// still say what these faces were built on.

import { describe, expect, it } from 'vitest';

import { moog903aDef } from '$lib/audio/modules/moog903a';
import { moog962Def } from '$lib/audio/modules/moog962';
import { sampleHoldDef } from '$lib/audio/modules/sample-hold';
import { scalerDef } from '$lib/audio/modules/scaler';
import {
  SAMPLE_HOLD_SCALES,
  SAMPLE_HOLD_MAX_SCALE,
} from '../../../../../dsp/src/lib/sample-hold-dsp';
import { dockFacePlan } from '$lib/ui/workflow/curated-face';
import { paramCellKind, SEGMENTED_MAX_OPTIONS } from '$lib/ui/workflow/shell-control-kind';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import type { ParamDef } from '$lib/graph/types';

const NO_MOMENTARY: ReadonlySet<string> = new Set();

/** ANCHORED TO THE ARTIFACT: each row carries the def itself, so a renamed or
 *  deleted module is a compile error, never a silently skipped row. */
const ONE_KNOB = [
  { type: 'moog903a', def: moog903aDef, only: 'level', glyph: 'meter' },
  { type: 'moog962', def: moog962Def, only: 'stages', glyph: 'none' },
  { type: 'sampleHold', def: sampleHoldDef, only: 'scale', glyph: 'none' },
  { type: 'scaler', def: scalerDef, only: 'amount', glyph: 'meter' },
] as const;

function param(def: { params: readonly ParamDef[] }, id: string): ParamDef {
  const p = def.params.find((q) => q.id === id);
  if (!p) throw new Error(`no param '${id}'`);
  return p;
}

describe('one-knob faces — promotion, ranking and the defaults they were built on', () => {
  it('each is PROMOTED and ranks exactly its one param, in exactly one band', () => {
    const problems: string[] = [];
    for (const { type, def, only } of ONE_KNOB) {
      if (!STRICT_FACES.has(type)) problems.push(`${type}: not in STRICT_FACES`);
      expect(def.face?.order, `${type} order`).toEqual([only]);
      // The band count the VRT roster copies as `pages`. Nothing else checks
      // that copy — `shell-faces-roster.test.ts` cross-checks only
      // `tabbedOptIn` — so a wrong number there fails as a Playwright timeout
      // on a capture job, the slowest possible place to learn it.
      const plan = dockFacePlan(def as never);
      expect(plan, `${type}: planned as UN-FACED — the legacy card would return`).not.toBeNull();
      expect(plan!.length, `${type}: dock band count (the roster's \`pages\`)`).toBe(1);
      // The face's completeness claim, both directions.
      expect(def.params.map((p) => p.id), `${type} param roster`).toEqual([only]);
    }
    expect(problems).toEqual([]);
  });

  it('the defaults these faces were authored against still ship', () => {
    expect(param(moog903aDef, 'level').defaultValue).toBe(0.8);
    expect(param(moog962Def, 'stages').defaultValue).toBe(3);
    expect(param(moog962Def, 'stages').min).toBe(2);
    expect(param(moog962Def, 'stages').max).toBe(3);
    expect(param(sampleHoldDef, 'scale').defaultValue).toBe(1); // Major
    expect(param(scalerDef, 'amount').defaultValue).toBe(1); // unity — a transparent patch
    expect(param(scalerDef, 'amount').curve).toBe('log');
  });

  it('NO face in this batch declares paramCells, momentary, pages, a hero or a title', () => {
    // The thin-face discipline, asserted rather than trusted. Every one of these
    // fields is a reason to be WIDER or to paint MORE TEXT, and none of these
    // modules has earned one. Note `sampleHold` in particular: its picker is
    // DERIVED from `options`, never declared as a cell.
    const problems: string[] = [];
    for (const { type, def } of ONE_KNOB) {
      const f = def.face as Record<string, unknown> | undefined;
      for (const field of ['paramCells', 'momentary', 'pages', 'hero', 'title', 'hint', 'xyPads', 'bareCells', 'extension', 'tabbed']) {
        if (f && f[field] !== undefined) problems.push(`${type}: declares face.${field}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('one-knob faces — rosters make states SELECTABLE; labels are never invented', () => {
  it('sampleHold: the scale roster is TOTAL and DERIVED from the quantiser table', () => {
    const opts = param(sampleHoldDef, 'scale').options;
    expect(opts, 'sampleHold must declare its scale names').toBeDefined();

    // TOTAL — one entry per reachable index. `param-vocabulary`'s stated reason:
    // a roster that skips a value leaves a state the dial can reach and the
    // picker cannot name. Asserted against the RANGE, never a typed count.
    const scale = param(sampleHoldDef, 'scale');
    expect(opts!.map((o) => o.value)).toEqual(
      Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i),
    );

    // DERIVED — the labels ARE the DSP table's names, in its order. If someone
    // re-types them, or the table gains a scale the roster does not, this fails.
    expect(opts!.map((o) => o.label)).toEqual(SAMPLE_HOLD_SCALES.map((s) => s.name));
    expect(scale.max).toBe(SAMPLE_HOLD_MAX_SCALE);
  });

  it('sampleHold: the roster RESOLVES to a named picker at the dock and a KNOB in the lane', () => {
    // The cell kind is derived from the roster, not declared — so this is the
    // clause that proves promoting the names actually changed what renders.
    const scale = param(sampleHoldDef, 'scale');
    expect(scale.options!.length).toBeGreaterThan(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(scale, NO_MOMENTARY, 'dock')).toBe('selector');
    // The 192x180 lane tile has no room for a ten-row list, and the platform
    // knows it: every non-dock tier keeps the stepped dial the card draws.
    expect(paramCellKind(scale, NO_MOMENTARY, 'lane')).toBe('knob');
  });

  it('moog962: STAGES is SELECTABLE — a two-state param gets a two-state control', () => {
    // ⚠ THIS CLAUSE IS INVERTED FROM ITS FIRST VERSION, AND THE INVERSION IS
    // THE LESSON. It originally asserted moog962 declared NO roster, on the
    // reasoning that its values are their own labels so a roster would only
    // restate the dial. `faces-parity` refuted that on CI: *"moog962 cell
    // 'stages' (param/knob): dragging the knob commits a param change into the
    // graph"*, failed on both attempts.
    //
    // A `2..3 discrete` param has exactly TWO reachable positions across the
    // dial's whole travel, so an ordinary drag quantises back to where it
    // started and the control is INERT. Naming and SELECTABILITY are different
    // questions, and only the first one was being answered.
    const stages = param(moog962Def, 'stages');
    expect(stages.options, 'moog962 STAGES must declare its two positions').toBeDefined();
    expect(stages.options!.map((o) => o.label)).toEqual(['2', '3']);
    expect(stages.options!.map((o) => o.value)).toEqual(
      Array.from({ length: stages.max - stages.min + 1 }, (_, i) => stages.min + i),
    );
    expect(stages.options!.length).toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
    expect(paramCellKind(stages, NO_MOMENTARY, 'dock')).toBe('segmented');
  });

  it('NEGATIVE CONTROL: without the roster it degrades to the inert knob CI caught', () => {
    // Both directions, so the clause above cannot pass vacuously — and so the
    // regression has a name if anyone removes the roster as "redundant".
    const stripped: ParamDef = { ...param(moog962Def, 'stages') };
    delete (stripped as { options?: unknown }).options;
    expect(paramCellKind(stripped, NO_MOMENTARY, 'dock')).toBe('knob');
  });
});

describe('one-knob faces — the GLYPH decision, run through the real resolver', () => {
  it('each face resolves to the binding it declares', () => {
    for (const { type, def, glyph } of ONE_KNOB) {
      expect(def.face?.glyph, `${type} declared glyph`).toBe(glyph);
      const kind = glyphBinding(def as never).kind;
      expect(kind, `${type} glyph binding`).toBe(glyph === 'none' ? 'none' : 'live-audio');
    }
  });

  it('FORCED vs EARNED: the two refusals have no audio port, the two meters do', () => {
    // The distinction the declaration cannot carry — all four are one word.

    // FORCED — every output is `cv`, so any glyph resolves to the DEAD `static`
    // binding that shipped on marbles through three passes.
    for (const def of [moog962Def, sampleHoldDef]) {
      expect(primaryAudioOutPortId(def as never)).toBeNull();
      const withMeter = { ...def, face: { ...(def.face ?? { order: [] }), glyph: 'meter' } };
      expect(glyphBinding(withMeter as never).kind).toBe('static');
    }

    // EARNED — and for two different reasons.
    //
    // scaler's meter is TOTAL: `out` is its only audio output, so there is no
    // second signal path for the meter to misrepresent.
    expect(primaryAudioOutPortId(scalerDef as never)).toBe('out');
    expect(scalerDef.outputs.filter((o) => o.type === 'audio')).toHaveLength(1);

    // moog903a's meter reads ONE of two audio taps, and is still honest,
    // because white and pink are the SAME generator at different filter slopes
    // and BOTH are scaled by the single LEVEL knob. That is the property that
    // makes a one-port meter representative — and the property `moog994` lacks,
    // which is why that module refused a meter that would have bound live.
    expect(primaryAudioOutPortId(moog903aDef as never)).toBe('white');
    expect(moog903aDef.outputs.map((o) => o.id)).toEqual(['white', 'pink']);
    expect(moog903aDef.params.map((p) => p.id)).toEqual(['level']);
  });
});
