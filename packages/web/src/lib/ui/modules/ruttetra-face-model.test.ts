// packages/web/src/lib/ui/modules/ruttetra-face-model.test.ts
//
// RUTTETRA — the permanent gates on the claims this face is built from. Each
// reads the LIVE def through the SAME pure resolvers the shell renders from, so
// an assertion here cannot drift from what actually paints.
//
// ⚠ WHY A FILE AT ALL — the blind-gate question, asked before writing it.
// Revert the `landmarks` roster tomorrow and ask what goes red: NOTHING.
// `landmarks` is not projected into `contract-lock` (the param line is
// `param <id> <min>..<max> <curve> default=<v>`), it is not in the WebGL attest
// basis in any way a hash diff would explain, and `module-face-lint` never
// looks at it. Delete `paramCells` for a shape param and the same is true — the
// face still renders, the gate set stays green, and the four morph NAMES are
// silently gone from the only surface that shows them.
//
// ⚠ AND THAT PAIRING IS THE POINT OF THIS FILE. `landmarks` is read by exactly
// ONE primitive — `KnobConic` — while `NeonFader` is passed `options` and NOT
// `landmarks`. So `landmarks: [...]` + `paramCells: 'fader'` is a declaration
// that LOOKS honoured and paints nothing: a green gate over a live regression,
// which is precisely the class CLAUDE.md names ("before 'fixing' a declaration
// to satisfy a gate, check the consumer reads it"). The card fidelity argument
// pushes toward `fader` for all twelve — the legacy card draws twelve throws —
// so this is a trap the NEXT author of this face will walk into unless a test
// stands in front of it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruttetraDef, shapedRamp } from '$lib/video/modules/ruttetra';
import { RUTTETRA_MONITOR_BOX } from './ruttetra/monitor-box';
import type { ParamDef } from '$lib/graph/types';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, dockFacePlan } from '$lib/ui/workflow/curated-face';
import { dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { knobNameReadout, paintsReadout } from '$lib/ui/controls/knob-vocabulary-model';

const HERE = dirname(fileURLToPath(import.meta.url));

function param(id: string): ParamDef {
  const p = (ruttetraDef.params ?? []).find((q) => q.id === id);
  expect(p, `ruttetra declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

/** Derived from the LIVE def rather than hand-built as empties, so declaring
 *  either field later changes what this file asserts instead of leaving it
 *  quietly stale. */
const MOMENTARY = momentaryParamIds(ruttetraDef);
const AUTHORED_CELLS = declaredParamCells(ruttetraDef);

const SHAPE_PARAMS = ['xShape', 'yShape'] as const;

describe('ruttetra face — the SHAPE morph keeps its NAME, and only a dial can paint it', () => {
  it('both shape params declare landmarks at the shader\'s own morph arms', () => {
    for (const id of SHAPE_PARAMS) {
      const p = param(id);
      expect(p.landmarks?.map((l) => l.value), `${id} anchors`).toEqual([0, 0.333, 0.666, 1]);
      expect(p.landmarks?.map((l) => l.label), `${id} names`).toEqual([
        'linear', 'triangle', 'soft', 'radial',
      ]);
    }
  });

  it('⚠ THE PAIRING: a shape param resolves to a KNOB, because only a knob is passed landmarks', () => {
    // The claim under test, through the real resolver at the real tier.
    for (const id of SHAPE_PARAMS) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS),
        `${id} must render as a dial — KnobConic is the ONLY primitive ModuleShell ` +
          'passes `landmarks` to, so a fader here silently deletes the morph name',
      ).toBe('knob');
    }
    // NEGATIVE CONTROL, and it is the one that makes the assertion mean
    // something: the other ten ARE faders, so "knob" is not simply what this
    // face returns for everything.
    for (const id of ['yDisp', 'xDisp', 'yFreq', 'xFreq', 'yPhase', 'xPhase',
                      'intensity', 'tintR', 'tintG', 'tintB']) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS),
        `${id} keeps the card's throw`,
      ).toBe('fader');
    }
  });

  it('ANCHORED TO THE RENDERER: the fader branch is passed options, the knob branch landmarks', () => {
    // ⚠ The two assertions above are about the DEF; this one is about the file
    // that consumes it, and without it they prove only that a declaration was
    // written down. If ModuleShell's fader branch ever starts forwarding
    // `landmarks`, the `paramCells` asymmetry above stops being load-bearing
    // and this file should be re-argued rather than silently over-constraining.
    const shell = readFileSync(resolve(HERE, 'ModuleShell.svelte'), 'utf8');
    const faderBranch = shell.slice(shell.indexOf('<NeonFader'), shell.indexOf('</div>', shell.indexOf('<NeonFader')));
    const knobBranch = shell.slice(shell.indexOf('<KnobConic'), shell.indexOf('</div>', shell.indexOf('<KnobConic')));
    expect(faderBranch.length, 'found the NeonFader branch').toBeGreaterThan(50);
    expect(knobBranch.length, 'found the KnobConic branch').toBeGreaterThan(50);
    expect(
      /landmarks=/.test(knobBranch),
      'the KnobConic branch must forward `landmarks` — it is the whole reason the shape params stay dials',
    ).toBe(true);
    expect(
      /landmarks=/.test(faderBranch),
      'the NeonFader branch does NOT forward `landmarks`. If this fails, the asymmetry this face ' +
        'is built on has gone away and `paramCells` for xShape/yShape can be reconsidered.',
    ).toBe(false);
  });

  it('the NAME actually paints, and it is a NAME rather than a number', () => {
    // `paintsReadout` is false the moment a param declares a `format`, which is
    // what keeps this on the right side of the no-resting-decimals ruling: a
    // state name disambiguates the dial's position, a decimal restates it.
    for (const id of SHAPE_PARAMS) {
      const p = param(id);
      expect(p.format, `${id} must declare no format`).toBeUndefined();
      expect(paintsReadout({ landmarks: p.landmarks, format: p.format }), `${id} paints a name`).toBe(true);
    }
  });

  it('the four names JOIN THE DSP — each anchor really is the shape it is named for', () => {
    // ⚠ NOT a table check. The roster would be equally "green" naming the arms
    // in any order, so this evaluates the module's OWN `shapedRamp` mirror at
    // each anchor and asserts the value matches that shape's closed form. That
    // is what makes these anchors derived from the shader rather than re-typed
    // the way `RuttetraCard.svelte`'s seven thresholds are.
    const t = 0.37;          // an ordinary, non-special ramp position…
    const uv: [number, number] = [0.31, 0.62]; // …and an off-centre sample point.
    const lin = t - Math.floor(t);
    const tri = Math.abs(2 * lin - 1);
    const sf = 0.5 - 0.5 * Math.cos(2 * Math.PI * lin);
    const dx = uv[0] - 0.5;
    const dy = uv[1] - 0.5;
    const radial = Math.min(Math.max(Math.hypot(dx, dy) * 1.41421356, 0), 1);

    expect(shapedRamp(t, uv[0], uv[1], 0), 'anchor 0 IS the linear ramp').toBeCloseTo(lin, 6);
    expect(shapedRamp(t, uv[0], uv[1], 0.333), 'anchor 0.333 IS the triangle').toBeCloseTo(tri, 6);
    expect(shapedRamp(t, uv[0], uv[1], 0.666), 'anchor 0.666 IS the soft fold').toBeCloseTo(sf, 6);
    // ⚠ 1.0 IS THE DECLARED INTENT AND THE SHADER OVERSHOOTS IT BY 0.2 %
    // (#1863, OPEN, and `ruttetra.test.ts` pins the residue DELIBERATELY as
    // bit-faithful). So this leg asserts the intent to within that known
    // residue rather than exactly — and states the residue, so a future fix to
    // #1863 tightens this instead of surprising someone.
    expect(shapedRamp(t, uv[0], uv[1], 1), 'anchor 1 IS radial to within #1863\'s 0.2% overshoot')
      .toBeCloseTo(radial, 2);

    // NEGATIVE CONTROL for the whole leg: the four closed forms are genuinely
    // DIFFERENT at this sample, so the four assertions above are not all
    // passing against one number.
    expect(new Set([lin, tri, sf, radial].map((v) => v.toFixed(4))).size, 'four distinct shapes').toBe(4);
  });

  it('nearest-match DERIVES the display boundaries instead of re-typing them', () => {
    // The card re-types 0.083 / 0.25 / 0.416 / 0.583 / 0.75 / 0.916, none of
    // which appear in the def. Nearest-match over the four anchors puts the
    // switch points at their midpoints (0.1665 / 0.4995 / 0.833) for free.
    const vocab = { landmarks: param('xShape').landmarks };
    expect(knobNameReadout(0.0, vocab)).toBe('linear');
    expect(knobNameReadout(0.166, vocab)).toBe('linear');
    expect(knobNameReadout(0.167, vocab)).toBe('triangle');
    expect(knobNameReadout(0.499, vocab)).toBe('triangle');
    expect(knobNameReadout(0.5, vocab)).toBe('soft');
    expect(knobNameReadout(0.833, vocab)).toBe('soft');
    expect(knobNameReadout(0.834, vocab)).toBe('radial');
    expect(knobNameReadout(1.0, vocab)).toBe('radial');
  });
});

describe('ruttetra face — the picture, and where it comes from', () => {
  it('the live picture arrives from hasVideoSurface, NOT from the glyph declaration', () => {
    // ⚠ ASSERT THE CAPABILITY, NOT THE LITERAL. `glyph: 'none'` is MANDATORY
    // here (no `type: 'audio'` output, so every other literal falls through to
    // `{kind:'static'}` and reddens module-face-lint's dead-glyph clause) — but
    // 'none' + blank tile and 'none' + live thumb are indistinguishable from
    // the declaration alone, which is why the declaration is the weaker check.
    expect(ruttetraDef.face?.glyph, 'forced by primaryAudioOutPortId === null').toBe('none');
    expect(hasVideoSurface(ruttetraDef), 'the lane tile still paints a VideoTileThumb').toBe(true);
  });

  it('MONITOR MODE is declared, and it is declared WITH the surface it needs', () => {
    // The seam this face exists to prove. `face-monitor-source.test.ts` owns
    // the fleet-wide rule in both directions; this is the module-local pin, so
    // dropping either half of the pair on THIS def is red here too.
    expect(ruttetraDef.face?.monitor, 'ruttetra declares monitor mode').toBeTruthy();
    expect(ruttetraDef.face?.extension, 'and the extension that carries its toggle').toBe('ruttetra');
  });

  it('the monitor box is ONE constant, and the surface that writes those keys reads it', () => {
    // ⚠ THIS LEG USED TO SAY 'BOTH surfaces', AND THE SECOND ONE IS GONE. The
    // legacy card was the other writer of `node.data.resizedWidth`/`resizedHeight`,
    // and the hazard it created was DIVERGENCE: two self-consistent surfaces
    // disagreeing about the same persisted keys, which nothing at runtime can
    // see (the backdraft class). With one writer left that hazard does not
    // exist to be caught — it is unspellable rather than untested. What remains
    // is the half that still can go wrong: the surviving body must READ the
    // shared box instead of re-typing its floors, and the floors must be
    // internally coherent.
    // A floor above the default would open every monitor at the wrong size.
    expect(RUTTETRA_MONITOR_BOX.defW).toBeGreaterThanOrEqual(RUTTETRA_MONITOR_BOX.minW);
    expect(RUTTETRA_MONITOR_BOX.defH).toBeGreaterThanOrEqual(RUTTETRA_MONITOR_BOX.minH);
    const body = readFileSync(resolve(HERE, 'ruttetra/RuttetraOutputBody.svelte'), 'utf8');
    expect(
      /import\s*\{\s*RUTTETRA_MONITOR_BOX\s*\}\s*from\s*'\.\/monitor-box'/.test(body),
      'the faced dock body must READ the shared box, never re-type its floors',
    ).toBe(true);
  });

  it('⚠ THE BOX STAYS OUT OF THE WEBGL ATTEST BASIS — anchored, not remembered', () => {
    // ⚠ RELOCATED 2026-08-21, and this is what keeps it relocated. It shipped on
    // `ruttetra.ts` with #2053 for the right reason (ONE source, the backdraft
    // rule) but in the wrong PLACE: `scripts/webgl-attest-lib.ts` sweeps ALL of
    // `packages/web/src/lib/video` into the attest basis, so six layout numbers
    // there charged a real-GPU re-attest on a shared machine — measured on the
    // monoglitch branch, where normalising that def showed the monitor box was
    // the ONLY hash contribution of an entire face (`face` and `docs` are
    // stripped by `attest-code-basis.ts`).
    //
    // Moving it back would be SILENT — nothing else reddens, the face renders
    // identically, and the cost surfaces weeks later as an unexplained hash move
    // on somebody else's branch. Hence an assertion rather than a comment.
    const def = readFileSync(resolve(HERE, '../../video/modules/ruttetra.ts'), 'utf8');
    expect(
      def.includes('RUTTETRA_MONITOR_BOX = '),
      'the video def must NOT define the monitor box — it belongs at ' +
        '$lib/ui/modules/ruttetra/monitor-box.ts, which the basis skips because it is a .ts ' +
        'file (webgl-attest-lib.ts: `if (!f.endsWith(".svelte")) continue`).',
    ).toBe(false);
    // POSITIVE CONTROL: the file named above really does hold the definition, so
    // this pair cannot both pass against a constant that was simply deleted.
    const boxSrc = readFileSync(resolve(HERE, 'ruttetra/monitor-box.ts'), 'utf8');
    expect(boxSrc.includes('export const RUTTETRA_MONITOR_BOX = {')).toBe(true);
  });
});

describe('ruttetra face — the four bands are the four expressions of the shader', () => {
  // The dock tier resolves EVERY ranked key (no tier cap), so this is the full
  // control set the faceplate paints — the subject the two legs below split
  // between them.
  const face = curatedFace(ruttetraDef, 'dock');

  it('every declared param has a home, and no page is a stub', () => {
    const pages = ruttetraDef.face?.pages ?? [];
    const inPages = pages.flatMap((p) => p.controls);
    const declared = (ruttetraDef.params ?? []).map((p) => p.id);
    // Both directions: nothing orphaned, nothing invented.
    expect([...inPages].sort(), 'pages cover exactly the declared params').toEqual([...declared].sort());
    expect([...(ruttetraDef.face?.order ?? [])].sort(), 'order does too').toEqual([...declared].sort());
    // And the RESOLVED face agrees — a key that resolved to a `static` (a
    // card-only button with no param behind it) would be counted above and
    // missing here.
    // ⚠ `curatedFace` returns NULL for a def with no `face`, so this is also
    // the assertion that the face EXISTS at all — without it the leg below
    // would be reading an optional-chained undefined and passing on a def that
    // had lost its whole `face` block.
    expect(face, 'ruttetra resolves a curated face at the dock tier').not.toBeNull();
    expect(
      face!.controls.filter((c) => c.kind === 'param').length,
      'every ranked key resolves to a real param at the dock tier',
    ).toBe(declared.length);
    for (const p of pages) {
      expect(p.controls.length, `page '${p.id}' is not a one-control stub`).toBeGreaterThanOrEqual(2);
    }
  });

  it('the RANKING argument holds: yDisp is the only param shipped off its neutral value', () => {
    // ⚠ THE PROOF THE HERO CLAIM RESTS ON, and it is derived rather than
    // asserted. `yDisp` leads `face.order` because the def spends its ONE
    // non-neutral default on it. Identity for this module means "changes
    // nothing about the picture": 0 for the displacements, shapes and phases,
    // 1 for the ramp frequencies and the tints. `intensity` ships at 1.5 and is
    // named here as the second exception, deliberately — it is a BRIGHTNESS
    // scalar, disjoint from `gl_Position` entirely, so it cannot be the relief
    // hero whatever its default.
    const IDENTITY: Record<string, number> = {
      xShape: 0, yShape: 0, xDisp: 0, xPhase: 0, yPhase: 0,
      xFreq: 1, yFreq: 1, tintR: 1, tintG: 1, tintB: 1,
    };
    const offCentre = (ruttetraDef.params ?? [])
      .filter((p) => p.id in IDENTITY && p.defaultValue !== IDENTITY[p.id])
      .map((p) => p.id);
    expect(offCentre, 'every geometry/colour param but yDisp ships at identity').toEqual([]);
    expect(param('yDisp').defaultValue, 'and yDisp does not').toBe(-0.3);
    expect(ruttetraDef.face?.order?.[0], 'so it leads the ladder').toBe('yDisp');
  });

  it('four bands, untabbed, and each is the size the DSP grouping says', () => {
    // The owner ruling ("2 - a") and the arithmetic agree. Read through the
    // REAL plan the dock renders from, so a page emptied by a hero promotion or
    // a key that resolves to nothing would show up here rather than in a VRT
    // diff 25 minutes later.
    const bands = dockFacePlan(ruttetraDef);
    expect(bands?.length, 'four rendered bands').toBe(4);
    expect(bands?.map((b) => b.id), 'in DSP order').toEqual(['relief', 'shape', 'scan', 'beam']);
    expect(bands?.map((b) => b.controls.length), 'relief/shape/scan/beam').toEqual([2, 2, 4, 4]);
    expect(ruttetraDef.face?.tabbed, 'never opts into the rail').toBeUndefined();
    // ⚠ AND THE THRESHOLD IT SITS UNDER, asserted rather than recited: four is
    // below DOCK_TAB_MIN_BANDS, so the rail is off for the ORDINARY reason and
    // no `tabbed` opt-in is being relied on to keep it off.
    expect(
      dockTabPlan(bands, 'dock-full', ruttetraDef),
      'four honest bands render as a column, not a rail',
    ).toBeNull();
  });

  it('NO hero, NO bareCells — the 2026-08-19 rulings, and the tint captions that must stay', () => {
    expect(ruttetraDef.face?.hero, 'no hero rail, so no readout strip could hang off one').toBeUndefined();
    // ⚠ `bareCells` for the tints would leave THREE IDENTICAL KNOBS with no
    // visible distinction — tidyVco's A/D/S/R case, which the owner ruled KEEPS
    // its labels. The redundancy was the word "Tint", fixed in the labels.
    expect(ruttetraDef.face?.bareCells, 'no captions are hidden on this face').toBeUndefined();
    for (const [id, label] of [['tintR', 'R'], ['tintG', 'G'], ['tintB', 'B']] as const) {
      expect(param(id).label, `${id} is captioned by its channel letter alone`).toBe(label);
    }
  });
});
