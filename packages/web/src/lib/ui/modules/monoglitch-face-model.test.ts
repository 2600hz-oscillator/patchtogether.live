// packages/web/src/lib/ui/modules/monoglitch-face-model.test.ts
//
// MONOGLITCH — the permanent gates on the claims this face is built from. Each
// reads the LIVE def through the SAME pure resolvers the shell renders from, so
// an assertion here cannot drift from what actually paints.
//
// ⚠ WHY A FILE AT ALL — the blind-gate question, asked before writing it.
// Delete `face.paramCells` tomorrow and ask what goes red: NOTHING. `paramCells`
// is not projected into `contract-lock`, it is stripped from the WebGL attest
// hash with the rest of `face`, and `module-face-lint` checks the SHAPE of the
// declaration rather than whether removing it changes anything. The face would
// still render — as eight DIALS, on a module whose every control the player has
// only ever met as a throw.
//
// ⚠ AND THE OBVIOUS TEST FOR THAT IS VACUOUS, which is the reason this file
// spells out its controls. "Assert all eight resolve to `fader`" passes just as
// happily if `paramCellKind` returned 'fader' for everything in the fleet — the
// ruttetra sibling could lean on an ASYMMETRY for its negative control (two
// shape dials among ten throws) and this face has none, because nothing here
// declares `landmarks` or `options`. So the control below is POSITIVE: it runs
// the same resolver with the declaration REMOVED and asserts the answer MOVES.
// A negative control proves the probe can move; a positive one proves it is
// reading the thing under test (`passing-negative-control-is-not-enough`).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monoglitchDef } from '$lib/video/modules/monoglitch';
import { MONOGLITCH_MONITOR_BOX } from './monoglitch/monitor-box';
import type { ParamDef } from '$lib/graph/types';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, dockFacePlan } from '$lib/ui/workflow/curated-face';
import { dockRowPlan } from '$lib/ui/workflow/dock-row-plan';
import { dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF_SRC = resolve(HERE, '../../video/modules/monoglitch.ts');

function param(id: string): ParamDef {
  const p = (monoglitchDef.params ?? []).find((q) => q.id === id);
  expect(p, `monoglitch declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

/** Derived from the LIVE def rather than hand-built as empties, so declaring
 *  either field later changes what this file asserts instead of leaving it
 *  quietly stale. */
const MOMENTARY = momentaryParamIds(monoglitchDef);
const AUTHORED_CELLS = declaredParamCells(monoglitchDef);

/** Every declared param id, read off the def — never a typed roster. */
const ALL_PARAMS = (monoglitchDef.params ?? []).map((p) => p.id);

describe('monoglitch face — the card\'s THROWS survive promotion as throws', () => {
  it('every param resolves to a FADER at the dock tier', () => {
    for (const id of ALL_PARAMS) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS),
        `${id} keeps the card's throw — MonoglitchCard draws all eight as <NeonFader>`,
      ).toBe('fader');
    }
  });

  it('⚠ POSITIVE CONTROL: removing the declaration CHANGES the answer', () => {
    // The leg above is the claim; this is the one that makes it mean something.
    // Run the identical resolver with NO authored cells and assert every one of
    // them comes back as something else — so "fader" is demonstrably produced by
    // `face.paramCells` and is not simply what this resolver says about a plain
    // continuous scalar. If a platform change ever made `fader` the default for
    // this param shape, THIS goes red and the declaration should be re-argued
    // rather than left as decoration nobody can tell is inert.
    const NO_CELLS: ReturnType<typeof declaredParamCells> = new Map();
    const undeclared = ALL_PARAMS.map((id) => paramCellKind(param(id), MOMENTARY, 'dock', NO_CELLS));
    expect(
      undeclared.filter((k) => k === 'fader'),
      'with the declaration removed, NOTHING should still resolve to a fader',
    ).toEqual([]);
    expect(new Set(undeclared).size, 'and they all land on one other kind').toBe(1);
    expect(undeclared[0], 'which is the dial the face would otherwise paint').toBe('knob');
  });

  it('no param declares landmarks or options, which is WHY there is no exception here', () => {
    // ⚠ The asymmetry ruttetra documents does not exist on this module, and this
    // asserts that rather than leaving its absence to look like an oversight.
    // `landmarks` is read by `KnobConic` ALONE, so a param declaring one MUST
    // stay a dial; declaring `fader` for it would silently delete every name
    // while the declaration still looked honoured. The blanket `fader` here is
    // safe only while this holds — if a later edit gives one of these a roster,
    // this leg reddens and `paramCells` must carve it out.
    for (const id of ALL_PARAMS) {
      const p = param(id);
      expect(p.landmarks, `${id} declares no landmarks`).toBeUndefined();
      expect(p.options, `${id} declares no options`).toBeUndefined();
    }
  });
});

describe('monoglitch face — the RANK-1 claim is a property of the SHADER', () => {
  // ⚠ READ OFF THE ARTIFACT, NOT RE-TYPED. The ranking argument is "Z is the
  // only control whose zero turns the module into a no-op", and the sibling
  // face proves its equivalent by evaluating an exported DSP mirror. This def
  // exports none, and adding one would be real code inside the WebGL attest
  // basis AND a second spelling of the shader — so the honest anchor is the
  // shader SOURCE itself. A rewrite that moved the displacement onto a different
  // uniform reddens this instead of leaving the ladder quietly wrong.
  const src = readFileSync(DEF_SRC, 'utf8');

  function shaderLine(startsWith: string): string {
    const line = src.split('\n').map((l) => l.trim()).find((l) => l.startsWith(startsWith));
    expect(line, `the shader still declares \`${startsWith}\``).toBeTruthy();
    return line as string;
  }

  it('the DISPLACEMENT term is driven by uIntensity and by nothing else', () => {
    const displaced = shaderLine('float displacedY');
    expect(displaced, 'Z scales the luma displacement').toContain('uIntensity');
    // The other seven uniforms are absent from the term, which is what makes Z
    // — and only Z — able to flatten the picture.
    for (const u of ['uLines', 'uSpacing', 'uHRamp', 'uVRamp', 'uTintR', 'uTintG', 'uTintB']) {
      expect(displaced, `${u} has no say in how far a line moves`).not.toContain(u);
    }
    expect(monoglitchDef.face?.order?.[0], 'so Z leads the ladder').toBe('intensity');
  });

  it('and Z is the only param whose range REACHES the no-op', () => {
    // The claim is "at 0 the effect is off", so 0 has to be reachable. It is the
    // floor of Z's declared range and of no other geometry control's — `lines`
    // bottoms out at 8 and `spacing` at 0 but neither zeroes the displacement.
    expect(param('intensity').min, 'Z reaches the flat-stack no-op').toBe(0);
    expect(param('lines').min, 'the raster never has zero lines').toBeGreaterThan(0);
  });

  it('THE FINDING THAT LOST ITS SURFACE: band height depends on BOTH dials', () => {
    // ⚠ The 2026-08-19 rulings deleted the readout strip, so this derivation has
    // no renderer. Per the ruling it survives here and in `docs.controls` —
    // named rather than allowed to lapse. Band height is
    // `(1 / lines) * (1 - spacing) * 0.5`, which is why neither dial can report
    // it and why the docs entry for GAP has to mention LINES.
    const band = shaderLine('float bandHeight');
    expect(band).toContain('1.0 / n');
    expect(band).toContain('uSpacing');
    // `n` is the line count, so the two controls really are both in the term.
    expect(shaderLine('float n ='), 'n is the LINES count').toContain('uLines');
  });
});

describe('monoglitch face — the picture, and where it comes from', () => {
  it('the live picture arrives from hasVideoSurface, NOT from the glyph declaration', () => {
    // ⚠ ASSERT THE CAPABILITY, NOT THE LITERAL. `glyph: 'none'` is MANDATORY
    // here (no `type: 'audio'` output, so every other literal falls through to
    // `{kind:'static'}` and reddens module-face-lint's dead-glyph clause) — but
    // 'none' + blank tile and 'none' + live thumb are indistinguishable from the
    // declaration alone, which is why the declaration is the weaker check.
    expect(monoglitchDef.face?.glyph, 'forced by primaryAudioOutPortId === null').toBe('none');
    expect(hasVideoSurface(monoglitchDef), 'the lane tile still paints a VideoTileThumb').toBe(true);
  });

  it('MONITOR MODE is declared, and it is declared WITH the surface it needs', () => {
    // `face-monitor-source.test.ts` owns the fleet-wide rule in both directions;
    // this is the module-local pin, so dropping either half of the pair on THIS
    // def is red here too.
    expect(monoglitchDef.face?.monitor, 'monoglitch declares monitor mode').toBeTruthy();
    expect(monoglitchDef.face?.extension, 'and the extension that carries its toggle')
      .toBe('monoglitch');
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
    // The two surfaces share `node.data.resizedWidth`/`resizedHeight`, so a
    // drifted floor is a divergence nothing at runtime can see — each surface
    // would be self-consistent and they would disagree (the backdraft class).
    expect(MONOGLITCH_MONITOR_BOX.defW).toBeGreaterThanOrEqual(MONOGLITCH_MONITOR_BOX.minW);
    expect(MONOGLITCH_MONITOR_BOX.defH).toBeGreaterThanOrEqual(MONOGLITCH_MONITOR_BOX.minH);
    const body = readFileSync(resolve(HERE, 'monoglitch/MonoglitchOutputBody.svelte'), 'utf8');
    expect(
      /import\s*\{\s*MONOGLITCH_MONITOR_BOX\s*\}\s*from\s*'\.\/monitor-box'/.test(body),
      'the faced dock body must READ the shared box, never re-type its floors',
    ).toBe(true);
  });

  it('⚠ THE BOX STAYS OUT OF THE WEBGL ATTEST BASIS — anchored, not remembered', () => {
    // ⚠ THIS IS THE ASSERTION THAT DEFENDS THE RELOCATION. The box lived on the
    // def until 2026-08-21. `scripts/webgl-attest-lib.ts` sweeps ALL of
    // `packages/web/src/lib/video` into the basis, and a probe on this branch
    // showed those eight lines were the ONLY hash contribution of this entire
    // face — `face` and `docs` are stripped by `attest-code-basis.ts`. So the
    // def home charged a real-GPU re-attest on a shared machine for six numbers
    // that cannot change a rendered GL pixel.
    //
    // Moving it BACK would be silent: nothing else in the tree would go red, the
    // face would render identically, and the cost would only show up as an
    // unexplained hash move on somebody else's branch weeks later. So the def is
    // asserted CLEAN of the symbol, in both directions with the import above.
    const def = readFileSync(resolve(HERE, '../../video/modules/monoglitch.ts'), 'utf8');
    expect(
      def.includes('MONOGLITCH_MONITOR_BOX = '),
      'the video def must NOT define the monitor box — `lib/video/**` is swept into the WebGL ' +
        'attest basis wholesale, so layout geometry there costs a GPU window for nothing. It ' +
        'belongs at $lib/ui/modules/monoglitch/monitor-box.ts, which the basis skips because it ' +
        'is a .ts file (webgl-attest-lib.ts: `if (!f.endsWith(".svelte")) continue`).',
    ).toBe(false);
    // POSITIVE CONTROL for the reader above: the file it names really does hold
    // the definition, so this pair cannot both pass against a deleted constant.
    const boxSrc = readFileSync(resolve(HERE, 'monoglitch/monitor-box.ts'), 'utf8');
    expect(boxSrc.includes('export const MONOGLITCH_MONITOR_BOX = {')).toBe(true);
  });
});

describe('monoglitch face — four bands, one per TERM of the shader', () => {
  const face = curatedFace(monoglitchDef, 'dock');

  it('every declared param has a home, and nothing is invented', () => {
    const pages = monoglitchDef.face?.pages ?? [];
    const inPages = pages.flatMap((p) => p.controls);
    // Both directions: nothing orphaned, nothing invented.
    expect([...inPages].sort(), 'pages cover exactly the declared params')
      .toEqual([...ALL_PARAMS].sort());
    expect([...(monoglitchDef.face?.order ?? [])].sort(), 'order does too')
      .toEqual([...ALL_PARAMS].sort());
    // ⚠ `curatedFace` returns NULL for a def with no `face`, so this is also the
    // assertion that the face EXISTS at all — without it the leg below would be
    // reading an optional-chained undefined and passing on a def that had lost
    // its whole `face` block.
    expect(face, 'monoglitch resolves a curated face at the dock tier').not.toBeNull();
    expect(
      face!.controls.filter((c) => c.kind === 'param').length,
      'every ranked key resolves to a real param at the dock tier',
    ).toBe(ALL_PARAMS.length);
  });

  it('four bands, untabbed, sized as the DSP grouping says', () => {
    const bands = dockFacePlan(monoglitchDef);
    expect(bands?.map((b) => b.id), 'in signal order').toEqual(['lift', 'raster', 'pan', 'tint']);
    expect(bands?.map((b) => b.controls.length), 'lift/raster/pan/tint').toEqual([1, 2, 2, 3]);
    expect(monoglitchDef.face?.tabbed, 'never opts into the rail').toBeUndefined();
    // ⚠ AND THE THRESHOLD IT SITS UNDER, asserted rather than recited: four is
    // below DOCK_TAB_MIN_BANDS, so the rail is off for the ORDINARY reason and
    // no `tabbed` opt-in is being relied on to keep it off.
    expect(
      dockTabPlan(bands, 'dock-full', monoglitchDef),
      'four honest bands render as a column, not a rail',
    ).toBeNull();
  });

  it('⚠ THE ONE-CONTROL PAGE IS DELIBERATE, and it costs no height', () => {
    // The platform permits a single-control page only when that control IS the
    // module's identity, and `lift` is the one page that qualifies — so this
    // asserts the exception is used ONCE and by the rank-1 key, rather than
    // becoming a habit that spreads down the face.
    const pages = monoglitchDef.face?.pages ?? [];
    const stubs = pages.filter((p) => p.controls.length < 2).map((p) => p.id);
    expect(stubs, 'exactly one page carries a single control').toEqual(['lift']);
    expect(pages.find((p) => p.id === 'lift')?.controls, 'and it is the identity term')
      .toEqual([monoglitchDef.face?.order?.[0]]);

    // ⚠ THE COST ARGUMENT, MEASURED THROUGH THE REAL PLANNER rather than
    // asserted in a comment. A page normally costs an ~81 px band, which is what
    // makes "do not add a page just to get a header" a real rule. Here all eight
    // controls fit under `DOCK_ROW_MAX_CONTROLS`, so PF-21 packs all four bands
    // into ONE ROW and the fourth band adds no height at all. If a later edit
    // pushes this face over the cap, the split becomes real and this reddens.
    const bands = dockFacePlan(monoglitchDef);
    const rows = dockRowPlan(bands ?? [], monoglitchDef);
    expect(rows?.length, 'all four bands share a single packed row').toBe(1);
    expect(rows?.[0]?.bands.map((b) => b.id)).toEqual(['lift', 'raster', 'pan', 'tint']);
  });

  it('NO hero, NO bareCells — the 2026-08-19 rulings, and the tint captions that must stay', () => {
    expect(monoglitchDef.face?.hero, 'no hero rail, so no readout strip could hang off one')
      .toBeUndefined();
    // ⚠ `bareCells` for the tints would leave THREE IDENTICAL FADERS with no
    // visible distinction. The `tint` heading says what they are; it does NOT
    // say which is which — the tidyVco side of that ruling, not the mixmstrs
    // side, where a heading genuinely repeated the caption.
    expect(monoglitchDef.face?.bareCells, 'no captions are hidden on this face').toBeUndefined();
    for (const [id, label] of [['tintR', 'Tint R'], ['tintG', 'Tint G'], ['tintB', 'Tint B']] as const) {
      expect(param(id).label, `${id} is captioned distinctly`).toBe(label);
    }
  });
});
