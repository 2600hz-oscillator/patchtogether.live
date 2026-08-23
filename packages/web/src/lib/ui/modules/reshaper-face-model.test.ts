// packages/web/src/lib/ui/modules/reshaper-face-model.test.ts
//
// RESHAPER — the permanent gates on the claims this face is built from. Each
// reads the LIVE def through the SAME pure resolvers the shell renders from, so
// an assertion here cannot drift from what actually paints.
//
// ⚠ WHY A FILE AT ALL — the blind-gate question, asked before writing it.
// Delete `face.paramCells` tomorrow and ask what goes red: NOTHING. It is not
// projected into `contract-lock`, it is stripped from the WebGL attest hash with
// the rest of `face`, and `module-face-lint` checks the SHAPE of the declaration
// rather than whether removing it changes anything. The face would still render
// — as six DIALS, on a module whose every control the player has only ever met
// as a throw. The positive control below runs the same resolver with the
// declaration REMOVED and asserts the answer MOVES.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reshaperDef } from '$lib/video/modules/reshaper';
import { RESHAPER_MONITOR_BOX } from './reshaper/monitor-box';
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
const DEF_SRC = resolve(HERE, '../../video/modules/reshaper.ts');

function param(id: string): ParamDef {
  const p = (reshaperDef.params ?? []).find((q) => q.id === id);
  expect(p, `reshaper declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

const MOMENTARY = momentaryParamIds(reshaperDef);
const AUTHORED_CELLS = declaredParamCells(reshaperDef);
/** Every declared param id, read off the def — never a typed roster. */
const ALL_PARAMS = (reshaperDef.params ?? []).map((p) => p.id);

describe('reshaper face — the card\'s THROWS survive promotion as throws', () => {
  it('every param resolves to a FADER at the dock tier', () => {
    for (const id of ALL_PARAMS) {
      expect(
        paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS),
        `${id} keeps the card's throw — ReshaperCard draws all six as <NeonFader>`,
      ).toBe('fader');
    }
  });

  it('⚠ POSITIVE CONTROL: removing the declaration CHANGES the answer', () => {
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
    // The `ruttetra` asymmetry (two shape params kept as dials because
    // `landmarks` is read by `KnobConic` ALONE) does not exist on this module.
    // The blanket `fader` is safe only while this holds.
    for (const id of ALL_PARAMS) {
      expect(param(id).landmarks, `${id} declares no landmarks`).toBeUndefined();
      expect(param(id).options, `${id} declares no options`).toBeUndefined();
    }
  });
});

describe('reshaper face — the RANK and the PASS-THROUGH claim come from the shader', () => {
  const src = readFileSync(DEF_SRC, 'utf8');

  function shaderLine(startsWith: string): string {
    const line = src.split('\n').map((l) => l.trim()).find((l) => l.startsWith(startsWith));
    expect(line, `the shader still declares \`${startsWith}\``).toBeTruthy();
    return line as string;
  }

  it('⚠ THE RANK-1 TIE-BREAK IS EVALUATION ORDER, and the shader still has that order', () => {
    // `xDisp` and `yDisp` are symmetric in everything the def can express, so
    // the ladder cannot be defended from a default the way ruttetra's is. It is
    // defended from the ORDER the shader computes them in — asserted here so a
    // rewrite that swapped them makes the ladder's argument go red instead of
    // quietly wrong.
    const u = src.indexOf('float finalU');
    const v = src.indexOf('float finalV');
    expect(u, 'finalU exists').toBeGreaterThan(-1);
    expect(v, 'finalV exists').toBeGreaterThan(-1);
    expect(u, 'finalU is computed BEFORE finalV').toBeLessThan(v);
    expect(shaderLine('float finalU'), 'and finalU is the one xDisp drives').toContain('uXDisp');
    expect(reshaperDef.face?.order?.[0], 'so xDisp leads the ladder').toBe('xDisp');
    expect(reshaperDef.face?.order?.[1]).toBe('yDisp');

    // The symmetry itself, asserted — it is the reason the tie-break is needed.
    for (const k of ['min', 'max', 'defaultValue'] as const) {
      expect(param('xDisp')[k], `xDisp/yDisp share ${k}`).toBe(param('yDisp')[k]);
    }
  });

  it('EVERY param ships at IDENTITY — the pass-through claim, and the scenes rest on it', () => {
    // ⚠ THIS IS THE FINDING THAT LOST ITS SURFACE (2026-08-19 rulings): "this
    // module is currently doing nothing to the picture" is a real derived state
    // with no renderer any more. It is also what makes the VRT face scenes
    // deterministic at rest, so it is pinned rather than left as prose.
    const IDENTITY: Record<string, number> = {
      xDisp: 0, yDisp: 0, intensity: 1, tintR: 1, tintG: 1, tintB: 1,
    };
    const offCentre = (reshaperDef.params ?? [])
      .filter((p) => p.defaultValue !== IDENTITY[p.id])
      .map((p) => p.id);
    expect(offCentre, 'every param ships at its identity value').toEqual([]);
    // TOTALITY: the table above covers the live param set, so a NEW param cannot
    // slip past by simply not being listed (it would read `undefined` and fail).
    expect(Object.keys(IDENTITY).sort()).toEqual([...ALL_PARAMS].sort());
  });

  it('⚠ NO TIME, NO FEEDBACK, NO RNG — why this face needs no freeze and no simPin', () => {
    // The VRT roster entry claims the render is a pure function of
    // (X, Y, Z, params). That claim is load-bearing — it is the reason there is
    // no `simPin` on the scene — so it is asserted against the shader rather
    // than believed. `milkdrop` is the module where the equivalent claim is
    // FALSE (#2083), which is why it is not faced.
    const frag = src.slice(src.indexOf('const FRAG_SRC'), src.indexOf('interface ReshaperParams'));
    for (const banned of ['uTime', 'iTime', 'uFrame', 'random', 'rand(']) {
      expect(frag.includes(banned), `the fragment shader must not reference ${banned}`).toBe(false);
    }
    // POSITIVE CONTROL: the slice really is the shader, not an empty string that
    // would pass every absence check above.
    expect(frag).toContain('uniform sampler2D uZ');
    expect(frag.length).toBeGreaterThan(400);
  });

  it('UNPATCHED it paints a flat field — the identity ramps and the mid-grey branch', () => {
    // The other half of the determinism claim: what the scene actually shows.
    expect(shaderLine('float rampX'), 'X falls back to the identity ramp').toContain('vUv.x');
    expect(shaderLine('float rampY'), 'Y falls back to the identity ramp').toContain('vUv.y');
    expect(shaderLine('vec3 srcHere'), 'and Z to a constant mid-grey').toContain('vec3(0.5)');
  });
});

describe('reshaper face — the picture, and where it comes from', () => {
  it('the live picture arrives from hasVideoSurface, NOT from the glyph declaration', () => {
    expect(reshaperDef.face?.glyph, 'forced by primaryAudioOutPortId === null').toBe('none');
    expect(hasVideoSurface(reshaperDef), 'the lane tile still paints a VideoTileThumb').toBe(true);
  });

  it('MONITOR MODE is declared, and it is declared WITH the surface it needs', () => {
    expect(reshaperDef.face?.monitor, 'reshaper declares monitor mode').toBeTruthy();
    expect(reshaperDef.face?.extension, 'and the extension that carries its toggle').toBe('reshaper');
  });

  it('the monitor box is ONE constant, and BOTH surfaces read it', () => {
    expect(RESHAPER_MONITOR_BOX.defW).toBeGreaterThanOrEqual(RESHAPER_MONITOR_BOX.minW);
    expect(RESHAPER_MONITOR_BOX.defH).toBeGreaterThanOrEqual(RESHAPER_MONITOR_BOX.minH);
    const card = readFileSync(resolve(HERE, 'ReshaperCard.svelte'), 'utf8');
    const body = readFileSync(resolve(HERE, 'reshaper/ReshaperOutputBody.svelte'), 'utf8');
    expect(
      /import\s*\{\s*RESHAPER_MONITOR_BOX\s*\}\s*from\s*'\.\/reshaper\/monitor-box'/.test(card),
      'the legacy card READS the shared box rather than re-typing its floors',
    ).toBe(true);
    expect(
      /import\s*\{\s*RESHAPER_MONITOR_BOX\s*\}\s*from\s*'\.\/monitor-box'/.test(body),
      'and so does the faced dock body — the OTHER surface that writes the same keys',
    ).toBe(true);
  });

  it('⚠ THE BOX STAYS OUT OF THE WEBGL ATTEST BASIS — anchored, not remembered', () => {
    // The #2081 convention: `lib/video/**` is swept into the basis wholesale, so
    // layout geometry on a video def charges a real-GPU window for numbers that
    // cannot change a rendered pixel. Moving it back would be SILENT — nothing
    // else reddens and the face renders identically — so it is asserted.
    const def = readFileSync(DEF_SRC, 'utf8');
    expect(
      def.includes('RESHAPER_MONITOR_BOX = '),
      'the video def must NOT define the monitor box — it belongs at ' +
        '$lib/ui/modules/reshaper/monitor-box.ts, which the basis skips because it is a .ts file ' +
        '(webgl-attest-lib.ts: `if (!f.endsWith(".svelte")) continue`).',
    ).toBe(false);
    const boxSrc = readFileSync(resolve(HERE, 'reshaper/monitor-box.ts'), 'utf8');
    expect(boxSrc.includes('export const RESHAPER_MONITOR_BOX = {')).toBe(true);
  });
});

describe('reshaper face — two bands, one per shader stage that HAS params', () => {
  const face = curatedFace(reshaperDef, 'dock');

  it('every declared param has a home, and nothing is invented', () => {
    const pages = reshaperDef.face?.pages ?? [];
    const inPages = pages.flatMap((p) => p.controls);
    expect([...inPages].sort(), 'pages cover exactly the declared params')
      .toEqual([...ALL_PARAMS].sort());
    expect([...(reshaperDef.face?.order ?? [])].sort(), 'order does too')
      .toEqual([...ALL_PARAMS].sort());
    expect(face, 'reshaper resolves a curated face at the dock tier').not.toBeNull();
    expect(
      face!.controls.filter((c) => c.kind === 'param').length,
      'every ranked key resolves to a real param at the dock tier',
    ).toBe(ALL_PARAMS.length);
  });

  it('⚠ THE RAMP STAGE HAS NO PARAMS — the module\'s headline feature is REAR-ONLY', () => {
    // The thing only this module does — sampling ramps that come from CABLES —
    // is unrankable, because X and Y are ports with no ParamDef behind them.
    // Asserted so that if a later edit ever gives them params, the face comment
    // claiming "no control on this face" goes red instead of quietly lying.
    const portIds = (reshaperDef.inputs ?? []).map((p) => p.id);
    expect(portIds, 'X and Y are real input ports').toEqual(expect.arrayContaining(['x', 'y']));
    expect(ALL_PARAMS, 'and neither has a param').not.toEqual(expect.arrayContaining(['x', 'y']));
    for (const id of ['x', 'y']) {
      const port = (reshaperDef.inputs ?? []).find((p) => p.id === id);
      expect(port?.type, `${id} is a mono-video field, not a cv target`).toBe('mono-video');
      expect(port?.paramTarget, `${id} targets no param`).toBeUndefined();
    }
  });

  it('two bands, untabbed, packing into ONE row', () => {
    const bands = dockFacePlan(reshaperDef);
    expect(bands?.map((b) => b.id), 'in shader order').toEqual(['warp', 'colour']);
    expect(bands?.map((b) => b.controls.length), 'warp/colour').toEqual([2, 4]);
    expect(reshaperDef.face?.tabbed, 'never opts into the rail').toBeUndefined();
    expect(
      dockTabPlan(bands, 'dock-full', reshaperDef),
      'two honest bands render as a column, not a rail',
    ).toBeNull();
    const rows = dockRowPlan(bands ?? [], reshaperDef);
    expect(rows?.length, 'both bands share a single packed row').toBe(1);
  });

  it('⚠ THE PLATE TIER IS THE SAME TWO AS COMPACT — geometry, not the cap constant', () => {
    // ⚠ THE ASSERTION THAT CAUGHT A WRONG COMMENT IN TWO MERGED FACES (#2085).
    // The obvious reading of `FACE_TIER_CAPS.full = LANE_PLATE_MAX_CELLS = 6` is
    // "the plate shows six controls", and both this face and `monoglitch`
    // shipped ladder prose saying so. It is false: `faceTierCap` runs
    // `laneBodyPlan`, which fits CELLS INTO GEOMETRY, and a `fader` is a TALL
    // cell — so with the video surface taking its share the plate holds TWO.
    //
    // Asserted as a RELATIONSHIP (plate === compact, dock === everything) rather
    // than as literals, so it states the property without pinning numbers that
    // are the layout's to choose.
    const keysAt = (tier: 'mini' | 'compact' | 'full' | 'dock'): string[] =>
      (curatedFace(reshaperDef, tier)?.controls ?? [])
        .filter((c) => c.kind === 'param')
        .map((c) => c.paramId as string);

    const compact = keysAt('compact');
    const plate = keysAt('full');
    expect(plate, 'the plate tier resolves exactly what compact does').toEqual(compact);
    expect(plate, 'namely the displacement pair').toEqual(['xDisp', 'yDisp']);
    expect(keysAt('mini'), 'and mini is the rank-1 key alone').toEqual(['xDisp']);
    expect([...keysAt('dock')].sort(), 'only the DOCK shows the whole set')
      .toEqual([...ALL_PARAMS].sort());

    // ⚠ SO NO TINT REACHES ANY LANE TIER. The face comment used to argue about
    // where the tint triple gets split across tiers; it never does, because it
    // never appears outside the dock.
    for (const t of ['tintR', 'tintG', 'tintB']) {
      expect(plate, `${t} is dock-only`).not.toContain(t);
    }
  });

  it('NO hero, NO bareCells — the 2026-08-19 rulings, and the tint captions that must stay', () => {
    expect(reshaperDef.face?.hero, 'no hero rail, so no readout strip could hang off one')
      .toBeUndefined();
    // The `colour` heading says what they are; it does NOT say which is which.
    expect(reshaperDef.face?.bareCells, 'no captions are hidden on this face').toBeUndefined();
    for (const [id, label] of [['tintR', 'Tint R'], ['tintG', 'Tint G'], ['tintB', 'Tint B']] as const) {
      expect(param(id).label, `${id} is captioned distinctly`).toBe(label);
    }
  });
});
