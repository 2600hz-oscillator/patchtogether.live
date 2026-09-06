// packages/web/src/lib/ui/modules/milkdrop-face-model.test.ts
//
// MILKDROP — the permanent gates on the claims this face is built from.
//
// ⚠ THIS FILE CARRIES MORE WEIGHT THAN ITS SIBLINGS, and the reason is worth
// stating at the top. Every other faced module has two VRT scenes; this one has
// NONE, by a named exemption (`FACES_WITHOUT_SCENES`, #2083), because butterchurn
// is not pixel-reproducible even at a fixed frame count. So for this face there
// is no pixel gate at any tier — the structure asserted here, plus faces-parity
// and the faced monitor leg, IS the coverage.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { milkdropDef, MILKDROP_CURATED_NAMES } from '$lib/video/modules/milkdrop';
import { MILKDROP_MONITOR_BOX } from './milkdrop/monitor-box';
import type { ParamDef } from '$lib/graph/types';
import {
  declaredParamCells,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, dockFacePlan } from '$lib/ui/workflow/curated-face';
import { dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF_SRC = resolve(HERE, '../../video/modules/milkdrop.ts');

function param(id: string): ParamDef {
  const p = (milkdropDef.params ?? []).find((q) => q.id === id);
  expect(p, `milkdrop declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

const MOMENTARY = momentaryParamIds(milkdropDef);
const AUTHORED_CELLS = declaredParamCells(milkdropDef);
const ALL_PARAMS = (milkdropDef.params ?? []).map((p) => p.id);
/** The params a player can actually operate — derived, never listed. */
const NO_CONTROL = (milkdropDef.noUserControl ?? []).map((e) => e.param);
const PLAYABLE = ALL_PARAMS.filter((id) => !NO_CONTROL.includes(id));

describe('milkdrop face — the four params a player CANNOT operate', () => {
  it('every noUserControl entry names a live param and a REAL writing port', () => {
    // ⚠ ANCHORED TO THE DEF'S OWN PORTS. `writer: 'cv-port'` is a claim that
    // something on the patch surface targets the param; if a port stops doing
    // so, the entry has quietly become a lie about why the control is missing.
    for (const e of milkdropDef.noUserControl ?? []) {
      expect(ALL_PARAMS, `${e.param} is a live param`).toContain(e.param);
      expect(e.writer, `${e.param} is written from the patch surface`).toBe('cv-port');
      const port = (milkdropDef.inputs ?? []).find((p) => p.paramTarget === e.param);
      expect(port, `a port targets ${e.param}`).toBeTruthy();
      expect(e.why.trim().length, `${e.param} carries an argument`).toBeGreaterThan(40);
    }
  });

  it('⚠ they are ABSENT from the face, and the playable four are PRESENT', () => {
    // The #1726 defect this closes: face completeness ranks and paints every
    // ParamDef, so undeclared these four would render as continuous rotaries —
    // three band overrides a cable overwrites every frame, and a TRIGGER drawn
    // as "how much next".
    const order = milkdropDef.face?.order ?? [];
    for (const id of NO_CONTROL) {
      expect(order, `${id} must not be ranked`).not.toContain(id);
    }
    for (const id of PLAYABLE) {
      expect(order, `${id} is a real control and must be ranked`).toContain(id);
    }
    // NON-VACUITY, both ways: this proves nothing if either set is empty.
    expect(NO_CONTROL.length, 'some params are CV-only').toBeGreaterThan(0);
    expect(PLAYABLE.length, 'and some are playable').toBeGreaterThan(0);
  });

  it('the four playable params resolve to FADERS, and the declaration is what does it', () => {
    for (const id of PLAYABLE) {
      expect(paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS), `${id}`).toBe('fader');
    }
    // POSITIVE CONTROL: remove the declaration and the answer must MOVE.
    const NO_CELLS: ReturnType<typeof declaredParamCells> = new Map();
    const undeclared = PLAYABLE.map((id) => paramCellKind(param(id), MOMENTARY, 'dock', NO_CELLS));
    expect(undeclared.filter((k) => k === 'fader'), 'nothing stays a fader undeclared').toEqual([]);
  });
});

describe('milkdrop face — the preset picker, and why it is not an options roster', () => {
  it('presetSelect declares NO options — the names come from the FAMILY cell', () => {
    // ⚠ THE CHOICE THIS PINS. A static `options` roster on the param would name
    // only the CURATED presets, but the picker also lists in-session `.milk`
    // imports and the engine clamps to the LIVE list. A roster would therefore
    // be WRONG the moment anyone used the loader — and it would cost a re-attest,
    // since `params` is real code while `controlFamilies` is hash-transparent.
    expect(param('presetSelect').options, 'no static roster on the param').toBeUndefined();
    const families = (milkdropDef.controlFamilies ?? []).map((f) => f.id);
    expect(families, 'the picker is a family cell').toContain('milkdrop-preset-select');
    expect(families, 'and so is the .milk loader').toContain('milkdrop-milk-input');
  });

  it('both family cells are RANKED and PAGED — a declared family that is not is inert', () => {
    const order = milkdropDef.face?.order ?? [];
    const paged = (milkdropDef.face?.pages ?? []).flatMap((p) => p.controls);
    for (const key of ['milkdrop-preset-select-{n}', 'milkdrop-milk-input-{n}']) {
      expect(order, `${key} is ranked`).toContain(key);
      expect(paged, `${key} has a page`).toContain(key);
    }
  });

  it('the curated roster is non-empty and matches the param RANGE it indexes', () => {
    // The param addresses presets by index, so its max must be the last curated
    // index — otherwise the knob and the picker disagree about what exists.
    expect(MILKDROP_CURATED_NAMES.length, 'there are curated presets').toBeGreaterThan(0);
    expect(param('presetSelect').min, 'indexes from 0').toBe(0);
    expect(
      param('presetSelect').max,
      'the knob reaches exactly the last CURATED preset (in-session imports go past it, and are ' +
        'reachable through the picker, which is one reason the picker is not a static roster)',
    ).toBe(MILKDROP_CURATED_NAMES.length - 1);
  });

  it('every declared family resolves to a live shell cell', () => {
    // ⚠ THIS ASKED WHETHER THE CARD EMITTED EACH `testidPrefix`, which is how
    // `ControlFamily.testidPrefix` was documented as grep-verified. The shell
    // stamps `shell-cell-<familyId>` from an interpolation, so no surviving
    // surface carries a per-family literal; `module-docs-lint` resolves each
    // family to a live cell instead, and so does this leg, at the module — a
    // declaration pointing at nothing is still red, by a different route.
    for (const f of milkdropDef.controlFamilies ?? []) {
      expect(
        shellCellFor('milkdrop', { kind: 'family', key: `${f.id}-{n}` } as never),
        `${f.id} has no shell cell`,
      ).toBeTruthy();
    }
  });
});

describe('milkdrop face — the picture, and where it comes from', () => {
  it('the live picture arrives from hasVideoSurface, NOT from the glyph declaration', () => {
    expect(milkdropDef.face?.glyph, 'forced by primaryAudioOutPortId === null').toBe('none');
    expect(hasVideoSurface(milkdropDef), 'the lane tile still paints a VideoTileThumb').toBe(true);
  });

  it('MONITOR MODE is declared, and it is declared WITH the surface it needs', () => {
    expect(milkdropDef.face?.monitor, 'milkdrop declares monitor mode').toBeTruthy();
    expect(milkdropDef.face?.extension).toBe('milkdrop');
  });

  it('the monitor box is ONE constant, the surface reads it, and it is out of the basis', () => {
    expect(MILKDROP_MONITOR_BOX.defW).toBeGreaterThanOrEqual(MILKDROP_MONITOR_BOX.minW);
    expect(MILKDROP_MONITOR_BOX.defH).toBeGreaterThanOrEqual(MILKDROP_MONITOR_BOX.minH);
    // ⚠ THIS SAID 'BOTH surfaces', and the hazard it guarded was DIVERGENCE:
    // two writers of the same persisted `resizedWidth`/`resizedHeight` keys,
    // each self-consistent and invisible at runtime (the backdraft class). With
    // one writer that hazard is unspellable; the half that can still go wrong
    // is that the body READS the shared box rather than re-typing its floors.
    const body = readFileSync(resolve(HERE, 'milkdrop/MilkdropOutputBody.svelte'), 'utf8');
    expect(
      /import\s*\{\s*MILKDROP_MONITOR_BOX\s*\}\s*from\s*'\.\/monitor-box'/.test(body),
      'and so does the faced dock body',
    ).toBe(true);
    // #2081: layout geometry stays out of the WebGL attest basis.
    const def = readFileSync(DEF_SRC, 'utf8');
    expect(
      def.includes('MILKDROP_MONITOR_BOX = '),
      'the video def must NOT define the monitor box — lib/video/** is swept into the WebGL ' +
        'basis wholesale, so layout numbers there charge a real-GPU window for nothing.',
    ).toBe(false);
  });

  it('⚠ SCREEN OFF RENEWS THE WATCH MARK — and here that protects an ACCUMULATOR', () => {
    // ⚠ THE SIBLING ARGUMENT DOES NOT APPLY, which is why this is asserted
    // rather than left to the body's comment. `ruttetra` and `monoglitch` argue
    // from having NO accumulator. butterchurn's warp mesh samples the PREVIOUS
    // frame, so a stalled pull here loses the evolution the player was watching
    // — the `grainsOfVision` case. If this call ever disappears, SCREEN OFF
    // becomes a producer kill switch (#2015).
    const body = readFileSync(resolve(HERE, 'milkdrop/MilkdropOutputBody.svelte'), 'utf8');
    expect(body).toContain('markWatched');
    expect(
      /if\s*\(previewCollapsed\)\s*\{[\s\S]{0,200}markWatched/.test(body),
      'the collapsed branch must renew the mark before returning',
    ).toBe(true);
  });
});

describe('milkdrop face — two bands, and no VRT scene behind them', () => {
  const face = curatedFace(milkdropDef, 'dock');

  it('the face resolves, and covers exactly the playable params plus both families', () => {
    expect(face, 'milkdrop resolves a curated face at the dock tier').not.toBeNull();
    const paramKeys = face!.controls.filter((c) => c.kind === 'param').map((c) => c.paramId);
    expect([...paramKeys].sort(), 'every playable param renders one param cell')
      .toEqual([...PLAYABLE].sort());
    // And the CV-only four are genuinely not rendered anywhere on the plate.
    for (const id of NO_CONTROL) {
      expect(paramKeys, `${id} paints no cell`).not.toContain(id);
    }
  });

  it('two bands, untabbed', () => {
    const bands = dockFacePlan(milkdropDef);
    expect(bands?.map((b) => b.id)).toEqual(['preset', 'motion']);
    expect(milkdropDef.face?.tabbed, 'never opts into the rail').toBeUndefined();
    expect(dockTabPlan(bands, 'dock-full', milkdropDef), 'two bands render as a column').toBeNull();
  });

  it('NO hero, NO readout — the preset NAME is the picker\'s option label instead', () => {
    expect(milkdropDef.face?.hero).toBeUndefined();
    // ⚠ THE PREMISE HALF READ THE CARD. It printed a live name/index line
    // (`data-testid="milkdrop-preset"`), and asserting the card still HAD it was
    // what made this a real migration rather than a claim about nothing. The
    // faceplate's home for that name is the SELECTOR's option label, which is
    // what is asserted instead — a roster whose entries carry the preset names
    // is the readout, in a place the ruling permits.
    const select = shellCellFor(
      'milkdrop',
      { kind: 'family', key: 'milkdrop-preset-select-{n}' } as never,
    ) as { kind?: string } | null;
    expect(select?.kind, 'the preset picker is a selector cell').toBe('selector');
  });
});
