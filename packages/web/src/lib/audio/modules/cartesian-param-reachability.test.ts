// packages/web/src/lib/audio/modules/cartesian-param-reachability.test.ts
//
// CARTESIAN MUST NOT DECLARE A CONTROL NOTHING CONSUMES, AND ITS CARD MUST NOT
// WRITE A CONTROL THE DEF DOES NOT DECLARE.
//
// `mode` was declared here as `discrete 0..1, "0 = freeform, 1 = clocked"`,
// documented in `docs.controls`, given a LIN/X-Y button on the card — and never
// read by the factory. The tick has always branched on whether a cable is
// patched into `clock`, so the CABLE was the mode selector and the knob was
// decoration. Both of its states rendered bit-identical audio.
//
// Nothing could have caught it. contract-lock, module-docs-lint and every range
// assertion read the DEF; the e2e never presses the button. A gate that reads
// one side of a two-sided contract proves nothing about the other, so this file
// checks BOTH sides at the source level, which is the only level either is
// visible at.
//
// ── SCOPE, STATED INSIDE THE GATE ───────────────────────────────────────────
// This covers CARTESIAN only, and deliberately so. Sweeping every module that
// live-reads its params was tried and rejected on measurement: several reach
// their params by routes a literal-string probe cannot see — drumseqz builds
// its per-track keys with a template literal, and score forwards A/D/S/R
// straight into an embedded Faust worklet's AudioParam map without ever calling
// `readParam`. A repo-wide version of this check would therefore need an
// exemption list per module, which is the shape that goes stale and stops being
// read. What it cannot see, then: every module that is not cartesian.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cartesianDef } from './cartesian';

function cartesianSource(): string {
  return readFileSync(fileURLToPath(new URL('./cartesian.ts', import.meta.url)), 'utf8');
}
function cardSource(): string {
  return readFileSync(
    fileURLToPath(new URL('../../ui/modules/CartesianCard.svelte', import.meta.url)),
    'utf8',
  );
}

/** Declared param ids whose value the factory never fetches. Cartesian's
 *  factory live-reads every param through `readParam('<id>', fallback)` on each
 *  tick — there is no AudioParam map and no setParam body — so a param that
 *  never appears in such a call is a param nothing consumes.
 *
 *  A named function so the self-test can feed it hostile inputs directly
 *  instead of re-typing the pattern. */
export function unreadParams(src: string, ids: readonly string[]): string[] {
  return ids.filter((id) => !new RegExp(`readParam\\(\\s*'${id}'`).test(src));
}

/** Param ids the CARD writes, via card-kit's `set('<id>')(…)`. */
export function paramsWrittenByCard(src: string): string[] {
  return [...src.matchAll(/\bset\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]!);
}

describe('cartesian: declared controls and consumed controls are the same set', () => {
  const declared = cartesianDef.params.map((p) => p.id);

  it('declares no param the factory never reads', () => {
    // Guard against a vacuous pass if the def is ever emptied.
    expect(declared.length, 'cartesian declares params at all').toBeGreaterThan(0);
    expect(
      unreadParams(cartesianSource(), declared),
      'declared-but-never-read params — a control that lies about itself',
    ).toEqual([]);
  });

  it('no longer declares `mode`, whose selector is the CLOCK CABLE', () => {
    expect(declared).not.toContain('mode');
    // …and the docs must not describe it either, or the doc page would offer a
    // control the module does not have.
    expect(Object.keys(cartesianDef.docs?.controls ?? {})).not.toContain('mode');
  });

  it('the card writes only params the def declares', () => {
    const written = paramsWrittenByCard(cardSource());
    expect(written.length, 'the card writes params at all').toBeGreaterThan(0);
    const undeclared = written.filter((id) => !declared.includes(id));
    expect(
      undeclared,
      'params the CARD writes that the DEF does not declare — the other half ' +
        'of the same contract, and how a deleted param leaves a live button behind',
    ).toEqual([]);
  });

  // PERMANENT NEGATIVE CONTROLS, calling the SAME predicates the checks call.
  it('the unread-param probe catches a dead param and spares a live one', () => {
    const live = "const v = readParam('octave', 0);";
    expect(unreadParams(live, ['octave']), 'spares a param that IS read').toEqual([]);
    expect(unreadParams(live, ['mode']), 'catches a param that is not').toEqual(['mode']);
    // The real defect's exact shape: declared and documented, never fetched.
    const defectShape = "{ id: 'mode', label: 'Mode' }\nconst o = readParam('octave', 0);";
    expect(unreadParams(defectShape, ['mode', 'octave'])).toEqual(['mode']);
  });

  it('the card-write probe finds a set() call and ignores other calls', () => {
    expect(paramsWrittenByCard("set('snh')(1)")).toEqual(['snh']);
    expect(paramsWrittenByCard("offset('snh')(1)")).toEqual([]);
  });
});
