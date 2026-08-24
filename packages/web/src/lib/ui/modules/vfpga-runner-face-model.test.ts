// packages/web/src/lib/ui/modules/vfpga-runner-face-model.test.ts
//
// THE PERMANENT PINS for the VFPGA-RUNNER faceplate.
//
// Everything here is a claim the shipped face MAKES which no other gate can
// check, because every one of them depends on something OUTSIDE the def: the
// VFPGA catalog, the shared TOYBOX conditioning defaults, or the loaded
// bitstream's own role roster. `module-face-lint` reads the def; the dock VRT
// baseline reads pixels; neither can see any of the below.
//
// Each block says what it would look like if it were wrong.

import { describe, expect, it } from 'vitest';
import { vfpgaRunnerDef } from '$lib/video/modules/vfpga-runner';
import {
  VFPGA_PARAM_SLOTS,
  VFPGA_CV_PORTS,
  VFPGA_GATE_PORTS,
  gateEvtParam,
} from '$lib/video/vfpga/types';
import { getVfpgaSpec, listVfpgaSpecs, DEFAULT_VFPGA_ID } from '$lib/video/vfpga/registry';
import { DEFAULT_INPUT_SCALE, DEFAULT_INPUT_OFFSET } from '$lib/video/toybox-cv-routes';
import { shellCellFor, shellCellKeys } from '$lib/ui/workflow/shell-cells';
import { noUserControlIds } from '$lib/ui/workflow/no-user-control';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import { vfpgaPresetOptions, vfpgaPresetValue } from './vfpga-runner-face-actions';
import type { ModuleNode } from '$lib/graph/types';

const face = vfpgaRunnerDef.face!;
const PRESET_KEY = 'vfpga-preset-{n}';
const RACK_KEY = 'vfpga-cv-{n}';

describe('vfpga-runner face — promoted, and the tile shows the module', () => {
  it('is promoted and declares a face', () => {
    expect(STRICT_FACES.has('vfpgaRunner')).toBe(true);
    expect(face).toBeTruthy();
  });

  // ⚠ THE FALSIFIABLE FORM OF "glyph MUST be 'none' on a video def". The rule
  // is usually written as a comment; stated this way it can go red. If somebody
  // ever gives this module an `audio` output, `primaryAudioOutPortId` starts
  // resolving, a live glyph becomes bindable, and this assertion is what says
  // the declaration needs re-deriving rather than leaving a dead-glyph clause
  // to fail with a message about a literal.
  it("declares glyph 'none' BECAUSE it has no audio output — and the picture still arrives", () => {
    expect(vfpgaRunnerDef.outputs.some((o) => o.type === 'audio')).toBe(false);
    expect(face.glyph).toBe('none');
    // The two states `'none'` cannot distinguish are 'blank tile' and 'live
    // thumbnail'. This is the one that says which.
    expect(hasVideoSurface(vfpgaRunnerDef)).toBe(true);
  });
});

describe('vfpga-runner face — the roster is DERIVED, not transcribed', () => {
  // If a ninth generic slot is ever added to `VFPGA_PARAM_SLOTS`, this is what
  // fails — rather than the face silently ranking eight of nine and the ninth
  // never reaching a player. `module-face-lint`'s completeness would catch the
  // rank, but nothing else pins the ORDER or the page membership to the roster.
  it('every generic slot is ranked, in slot order, on the `slots` band', () => {
    const slotsPage = (face.pages ?? []).find((p) => p.id === 'slots');
    expect(slotsPage, 'the `slots` band exists').toBeTruthy();
    expect([...slotsPage!.controls]).toEqual([...VFPGA_PARAM_SLOTS]);
    // …and `order` carries them in the same sequence, between the picker and
    // the rack.
    expect([...face.order]).toEqual([PRESET_KEY, ...VFPGA_PARAM_SLOTS, RACK_KEY]);
  });

  it('the rack ranks past the six-cell lane plate, because a PANEL is dock-only', () => {
    // `module-face-lint` refuses a panel SELECTED at a lane tier, and the
    // `full` lane cap is LANE_PLATE_MAX_CELLS = 6, so a panel's first legal
    // rank is 7. Asserting the INDEX rather than the constant is deliberate:
    // this is the fact an author needs while re-ranking, and it fails the
    // moment somebody promotes the rack up the list.
    expect(face.order.indexOf(RACK_KEY)).toBeGreaterThanOrEqual(6);
  });

  it('no band is emptied, because no key is promoted out of one', () => {
    // Two of the three bands hold exactly one cell. `heroFacePlan` MOVES a
    // promoted key out of its band and DROPS an emptied band — taking its
    // authored hint with it, rendered nowhere. Declaring no hero is what makes
    // the three declared bands the three rendered bands, which is also what
    // `pages: 3` in the FACES roster is counting.
    expect(face.hero).toBeUndefined();
    expect((face.pages ?? []).length).toBe(3);
  });
});

describe('vfpga-runner face — noUserControl covers the bridge params, both directions', () => {
  it('names exactly the synthetic cv/gate params — no slot, nothing missing', () => {
    const declared = noUserControlIds(vfpgaRunnerDef);
    const expected = [
      ...VFPGA_CV_PORTS.map((_p, i) => `cv${i + 1}_val`),
      ...VFPGA_GATE_PORTS.map((_p, i) => gateEvtParam(i + 1)),
    ].sort();
    expect([...declared].sort()).toEqual(expected);
    // The direction that matters if somebody ever "tidies" the list: a generic
    // slot must NEVER be in it. A slot declared noUserControl would be dropped
    // from the face with every gate still green — a knob deleted by a
    // declaration.
    for (const slot of VFPGA_PARAM_SLOTS) {
      expect(declared.has(slot), `${slot} must stay a real control`).toBe(false);
    }
  });
});

describe('vfpga-runner face — the bitstream picker is the identity control', () => {
  it('lists the LIVE catalog by NAME, and the name is the only place it exists', () => {
    const opts = vfpgaPresetOptions();
    expect(opts.map((o) => o.value).sort()).toEqual(listVfpgaSpecs().map((s) => s.id).sort());
    // The LABELS are the point. A picker valued by id and labelled by id would
    // pass a naive length check and paint nothing a reader can use, so the
    // labels are asserted to be the specs' own names.
    for (const o of opts) {
      expect(o.label, `option ${o.value} labelled`).toBe(getVfpgaSpec(o.value)!.name);
    }
  });

  it('a fresh node resolves to the DEFAULT bitstream, not an empty selection', () => {
    // The factory falls back to `DEFAULT_VFPGA_ID` when `node.data.vfpga` is
    // unset. A picker that painted a blank chip there would disagree with the
    // picture on screen — the module IS running smpte-bars.
    expect(vfpgaPresetValue(undefined)).toBe(DEFAULT_VFPGA_ID);
    expect(vfpgaPresetValue({ id: 'n', data: {} } as unknown as ModuleNode)).toBe(DEFAULT_VFPGA_ID);
    // …and an id that no longer resolves falls back too, rather than painting
    // the name of a bitstream that was deleted from the catalog.
    expect(
      vfpgaPresetValue({ id: 'n', data: { vfpga: 'no-such-bitstream' } } as unknown as ModuleNode),
    ).toBe(DEFAULT_VFPGA_ID);
  });
});

describe('vfpga-runner face — the modulation panel probe, and WHY it drives OFFSET', () => {
  // ⚠ RESOLVED THROUGH `shellCellFor`, NOT off the record. The resolver refuses
  // a cell whose param-shaped-ness disagrees with the control's kind, and #2144
  // is the case that made that matter: a registry entry can exist and still be
  // unreachable by every control on the face. Reading the map directly would
  // pass on exactly that bug.
  const cell = shellCellFor('vfpgaRunner', {
    key: RACK_KEY,
    kind: 'family',
    familyId: 'vfpga-cv',
    label: 'Modulation rack',
  });

  it('the panel declares a probe that drives OFFSET', () => {
    expect(cell?.kind).toBe('panel');
    const probe = (cell as { probe: { testid: string; action: string } }).probe;
    expect(probe.testid).toBe('vfpga-offset-1');
    expect(probe.action).toBe('drag');
  });

  // ⚠ THE PERMANENT NEGATIVE CONTROL FOR THE PROBE'S SUBJECT, and the reason
  // this file exists. faces-parity's panel drag is `mouse.move(cx, cy - 24)` —
  // always UPWARD, i.e. always toward a knob's MAXIMUM. So a probe on a control
  // whose default IS its maximum drags a knob that cannot move, reads no change,
  // and fails on a perfectly live panel.
  //
  // `DEFAULT_INPUT_SCALE` is exactly that case: +1 on a -1..+1 attenuverter.
  // `DEFAULT_INPUT_OFFSET` is 0 on 0..1, which the same gesture always moves.
  //
  // Both legs are asserted, so this is a POSITIVE control and a negative one:
  // if the shared defaults ever change, whichever leg flips tells the next
  // author that the probe target must be re-derived rather than leaving them to
  // debug a "drag did nothing" failure in a browser.
  it('SCALE is pinned at its ceiling by default and OFFSET is not — so only OFFSET is drivable upward', () => {
    const SCALE_MAX = 1;
    const OFFSET_MAX = 1;
    expect(
      DEFAULT_INPUT_SCALE,
      'an upward drag on SCALE cannot move it — that is why the probe is not on SCALE',
    ).toBe(SCALE_MAX);
    expect(
      DEFAULT_INPUT_OFFSET,
      'OFFSET must default BELOW its maximum or the probe stops being drivable too',
    ).toBeLessThan(OFFSET_MAX);
  });

  // ⚠ AND THE PROBE'S TARGET MUST ACTUALLY RENDER ON A FRESH SPAWN. The panel
  // draws one strip per CV role the LOADED bitstream declares, and a fresh node
  // loads `DEFAULT_VFPGA_ID`. If smpte-bars ever stopped declaring a slot-1 CV
  // role the panel would render zero strips, `vfpga-offset-1` would not exist,
  // and faces-parity would fail with "the probe's target renders" — a message
  // that names the symptom and not the cause. This names the cause.
  it("the default bitstream declares the slot-1 CV role the probe's testid is built from", () => {
    const spec = getVfpgaSpec(DEFAULT_VFPGA_ID);
    expect(spec, `the default bitstream '${DEFAULT_VFPGA_ID}' resolves`).toBeTruthy();
    expect(
      (spec!.cvRoles ?? []).some((r) => r.slot === 1),
      'the panel renders a strip per CV ROLE, so slot 1 must exist for `vfpga-offset-1` to',
    ).toBe(true);
  });
});

describe('vfpga-runner face — the picker cell is the SHARED action, not a second one', () => {
  it('the selector resolves from the registry and is registered under the module', () => {
    const sel = shellCellFor('vfpgaRunner', {
      key: PRESET_KEY,
      kind: 'family',
      familyId: 'vfpga-preset',
      label: 'VFPGA picker',
    });
    expect(sel?.kind).toBe('selector');
    // Both family templates the def declares must have a cell, or the dock
    // renders an INERT label where a control should be. `module-face-lint`
    // proves the KEY resolves to a family; this proves the family has a cell.
    const registered = new Set(shellCellKeys('vfpgaRunner'));
    for (const fam of vfpgaRunnerDef.controlFamilies ?? []) {
      expect(registered.has(`${fam.id}-{n}`), `family '${fam.id}' has a shell cell`).toBe(true);
    }
    // …and the reverse: a registered key that no family (or param) claims would
    // be a cell nothing can ever render.
    expect([...registered].sort()).toEqual([PRESET_KEY, RACK_KEY].sort());
  });
});
