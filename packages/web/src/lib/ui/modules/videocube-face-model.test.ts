// packages/web/src/lib/ui/modules/videocube-face-model.test.ts
//
// VIDEOCUBE — the permanent gates on the claims this face is built from.
//
// ⚠ THIS FACE IS THE OWNER'S CONTROL-HEAVY TABBED CASE (ruling 2026-08-18), and
// the first block below is what makes that a CHECKED claim rather than an
// assertion in a comment. The ruling's test is "lots of controls of DIFFERENT
// types", and its hard limit is that pages must never be padded to reach the
// rail — so both halves are asserted: the KIND-diversity that qualifies it, and
// the fact that the rail engages on the honest band count with no `face.tabbed`
// opt-in.
//
// The remaining blocks guard the same class of repair FRAMETABLE needed, which
// is the argument for having done the pair together: two `curve` corrections,
// FIVE missing `options` rosters, six card-only ingest affordances, and three
// card-only pictures. None was visible to any gate before a faceplate had to
// resolve a primitive from the declaration.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { videocubeDef } from '$lib/video/modules/videocube';
import {
  VIDEOCUBE_MODE_SMOOTH,
  VIDEOCUBE_MODE_MORPH,
  VIDEOCUBE_MODE_CHAOS,
} from '$lib/video/videocube-core';
import type { ParamDef } from '$lib/graph/types';
import {
  SEGMENTED_MAX_OPTIONS,
  declaredParamCells,
  foldedParamIds,
  momentaryParamIds,
  paramCellKind,
} from '$lib/ui/workflow/shell-control-kind';
import { curatedFace, dockFacePlan, laneOrder } from '$lib/ui/workflow/curated-face';
import { DOCK_TAB_MIN_BANDS, dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEF_SRC = resolve(HERE, '../../video/modules/videocube.ts');
const CELLS_SRC = resolve(HERE, '../workflow/shell-cells.ts');
const ACTIONS_SRC = resolve(HERE, './videocube-slot-actions.ts');
const BODY_SRC = resolve(HERE, './videocube/VideocubeOutputBody.svelte');
const read = (p: string): string => readFileSync(p, 'utf8');

function param(id: string): ParamDef {
  const p = (videocubeDef.params ?? []).find((q) => q.id === id);
  expect(p, `videocube declares a param '${id}'`).toBeTruthy();
  return p as ParamDef;
}

const MOMENTARY = momentaryParamIds(videocubeDef);
const AUTHORED_CELLS = declaredParamCells(videocubeDef);
const ORDER = videocubeDef.face?.order ?? [];
const famCell = (key: string) =>
  shellCellFor('videocube', { kind: 'family', key } as never);

// ───────────────────────────────────────────────────────────────────────────
describe('videocube face — the TABBED case, and why it qualifies', () => {
  it('SEVEN honest bands, and the rail engages on the count — no opt-in', () => {
    const bands = dockFacePlan(videocubeDef) ?? [];
    expect(bands.map((b) => b.id)).toEqual([
      'ingest', 'solid', 'slice', 'reader', 'view', 'render', 'audio',
    ]);
    expect(bands.length, 'at the rail threshold').toBeGreaterThanOrEqual(DOCK_TAB_MIN_BANDS);
    expect(dockTabPlan(bands), 'so the dock paints a RAIL').not.toBeNull();
    // ⚠ NO `face.tabbed`. That field is OWNER-INSTRUCTION-ONLY and requires a
    // named FACE_TAB_OPT_IN entry; this face must reach the rail on its honest
    // band count alone, which is the only route the ruling permits.
    expect(
      (videocubeDef.face as { tabbed?: true } | undefined)?.tabbed,
      'the rail is earned by the band count, never opted into',
    ).toBeUndefined();
  });

  it('⚠ the rail is NOT reached by padding — every page carries real controls', () => {
    // The ruling's hard limit: "never pad pages to force the rail". A page that
    // exists only to be a seventh header would show up here as a band with one
    // control that is not the module's identity.
    const bands = dockFacePlan(videocubeDef) ?? [];
    for (const b of bands) {
      expect(b.controls.length, `page '${b.id}' carries more than a token control`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('it qualifies on CONTROL-KIND DIVERSITY, which is the ruling\'s stated test', () => {
    // "Heavy means lots of controls of DIFFERENT types — not render weight."
    // DERIVED from the def, never listed: resolve every ranked control to the
    // primitive the dock will paint and count the distinct kinds.
    const kinds = new Set<string>();
    for (const key of ORDER) {
      const p = (videocubeDef.params ?? []).find((q) => q.id === key);
      kinds.add(p ? paramCellKind(p, MOMENTARY, 'dock', AUTHORED_CELLS) : famCell(key)?.kind ?? 'unknown');
    }
    expect(kinds.has('unknown'), 'every ranked key resolves to a real primitive').toBe(false);
    // knob · fader-or-xy · segmented · toggle · file · action — a genuinely
    // mixed surface, which is what separates this from a module with thirty
    // dials.
    expect(kinds.size, `distinct control kinds on one faceplate: ${[...kinds].sort().join(', ')}`)
      .toBeGreaterThanOrEqual(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('videocube face — the TWO switches that said `linear` (the repair)', () => {
  const SWITCHES = ['freeze', 'live'] as const;

  it('both carry the 0..1 DISCRETE switch shape and resolve to TOGGLES', () => {
    for (const id of SWITCHES) {
      const p = param(id);
      expect(p.min, `${id} min`).toBe(0);
      expect(p.max, `${id} max`).toBe(1);
      expect(p.defaultValue, `${id} rests at 0`).toBe(0);
      // The leg that would have failed before this face: `looksLikeToggle` is
      // `curve === 'discrete' && min === 0 && max === 1`, so `linear` here makes
      // each a rotary over a continuum.
      expect(p.curve, `${id} must be discrete, not linear`).toBe('discrete');
      expect(paramCellKind(p, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} @dock`).toBe('toggle');
    }
  });

  it('⚠ POSITIVE CONTROL: reverting `curve` to linear MOVES the answer to knob', () => {
    for (const id of SWITCHES) {
      const reverted: ParamDef = { ...param(id), curve: 'linear' };
      expect(paramCellKind(reverted, MOMENTARY, 'dock', AUTHORED_CELLS), `${id} reverted`).toBe('knob');
    }
  });

  it('NO param on this face is momentary — every switch here latches', () => {
    // Asserted rather than assumed: unlike frametable's CHAOS, videocube has no
    // pointer-capture press-pad anywhere. A momentary entry appearing later
    // would be a real classification change, not a tidy-up.
    //
    // ⚠ THE SECOND HALF READ THE CARD SOURCE for an `onpointerdown`, the
    // surface-side witness for "no press-pad". The surviving surfaces are the
    // body and the shell's own cells; the body is read instead, and the shell
    // renders a momentary cell only for a DECLARED momentary param, which the
    // line above denies.
    expect([...MOMENTARY], 'videocube declares no press-pads').toEqual([]);
    expect(read(BODY_SRC).includes('onpointerdown'), 'the body has no press-pad either')
      .toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('videocube face — FIVE rosters, all PROMOTED from shipped names', () => {
  /** (param, the exact labels, in order) — every one read back off the CARD. */
  const ROSTERS: readonly { id: string; labels: readonly string[] }[] = [
    { id: 'reader_mode', labels: ['SMOOTH', 'MORPH', 'CHAOS'] },
    { id: 'slice_view', labels: ['TEX', 'XRAY', 'WEIGHTS'] },
    { id: 'wrap', labels: ['CLAMP', 'FOLD'] },
    { id: 'material', labels: ['SMOOTH', 'HARD'] },
    { id: 'hue_mode', labels: ['MUSICAL', 'INSTR'] },
  ];

  it('every roster names EVERY reachable integer step (no unnameable state)', () => {
    for (const { id } of ROSTERS) {
      const p = param(id);
      const values = (p.options ?? []).map((o) => o.value);
      expect(values.length, `${id}: one name per integer step in [min,max]`).toBe(p.max - p.min + 1);
      for (const v of values) {
        expect(Number.isInteger(v), `${id}: ${v} is an integer step`).toBe(true);
        expect(v, `${id}: ${v} >= min`).toBeGreaterThanOrEqual(p.min);
        expect(v, `${id}: ${v} <= max`).toBeLessThanOrEqual(p.max);
      }
      expect(new Set(values).size, `${id}: no duplicate values`).toBe(values.length);
    }
  });

  it('the two MULTI-STATE rosters carry the SHADER\'s own constants, not retyped ordinals', () => {
    // ⚠ THIS USED TO BE ANCHORED TO THE CARD SOURCE, and what that bought is
    // worth stating because it is what is lost. The rule is "promote names that
    // exist in code, never invent them", and a test that re-typed the strings
    // would be asserting the invention against itself — so the leg derived the
    // labels from the card's own `MODES` and `SLICE_VIEWS` literals and
    // compared the def against THEM. The card was the second source; with it
    // gone the def is the only place these names exist, and no cross-check can
    // separate a promoted name from an invented one.
    //
    // NAMED, so it is not mistaken for a re-point: the LABEL cross-check is a
    // coverage loss. What survives is the half that was never circular — the
    // reader's option VALUES are the shader's own mode constants rather than
    // 0/1/2 retyped, which is the half that could actually mis-drive the shader.
    expect(param('reader_mode').options?.map((o) => o.label)).toEqual(['SMOOTH', 'MORPH', 'CHAOS']);
    expect(param('slice_view').options?.map((o) => o.label)).toEqual(['TEX', 'XRAY', 'WEIGHTS']);
    expect(param('reader_mode').options?.map((o) => o.value)).toEqual([
      VIDEOCUBE_MODE_SMOOTH, VIDEOCUBE_MODE_MORPH, VIDEOCUBE_MODE_CHAOS,
    ]);
  });

  it('every rostered param renders SEGMENTED at the dock and a NAMED knob in the lane', () => {
    for (const { id, labels } of ROSTERS) {
      expect(param(id).options?.map((o) => o.label), `${id} labels`).toEqual(labels);
      expect(labels.length, `${id} fits an inline row`).toBeLessThanOrEqual(SEGMENTED_MAX_OPTIONS);
      expect(paramCellKind(param(id), MOMENTARY, 'dock', AUTHORED_CELLS), `${id} @dock`).toBe('segmented');
      expect(paramCellKind(param(id), MOMENTARY, 'lane', AUTHORED_CELLS), `${id} @lane`).toBe('knob');
    }
  });

  it('⚠ POSITIVE CONTROL: stripping a roster loses the NAMES — in two distinct ways', () => {
    // The moog962 trap, made falsifiable five times over — and the two arities
    // degrade DIFFERENTLY, which the first draft of this test got wrong by
    // expecting 'knob' for all five.
    //
    //   3-state (`reader_mode`, `slice_view`) → a KNOB: a dial sweeping integers
    //     that name nothing, which is the trap in its classic form.
    //   2-state (`wrap`, `material`, `hue_mode`) → an anonymous TOGGLE, because
    //     `looksLikeToggle` still matches the 0..1-discrete-at-0 shape. That is
    //     the SUBTLER loss and the reason these three carry rosters at all: a
    //     bare switch announces PRESSED / UNPRESSED, which is a lie when the two
    //     states are CLAMP vs FOLD, SMOOTH vs HARD, MUSICAL vs INSTR — named
    //     alternatives where neither is the other's "off".
    //
    // Either way the ROSTER is what the player loses, which is the claim.
    for (const { id, labels } of ROSTERS) {
      const stripped: ParamDef = { ...param(id), options: undefined };
      const degraded = paramCellKind(stripped, MOMENTARY, 'dock', AUTHORED_CELLS);
      expect(degraded, `${id} stripped must stop being segmented`).not.toBe('segmented');
      expect(degraded, `${id} stripped`).toBe(labels.length > 2 ? 'knob' : 'toggle');
    }
  });

  it('⚠ `screen_on` keeps a PLAIN TOGGLE — it is a real on/off, not a named pair', () => {
    // The discrimination the rosters above encode: a bare Toggle announces
    // PRESSED / UNPRESSED, which is right only when one state genuinely IS the
    // other's "off". This one is a perf gate; the other five are named choices.
    const p = param('screen_on');
    expect(p.options, 'no roster').toBeUndefined();
    expect(paramCellKind(p, MOMENTARY, 'dock', AUTHORED_CELLS)).toBe('toggle');
    expect(p.defaultValue, 'and it rests ON').toBe(1);
  });

  it('⚠ `screen_on` is LABELLED `ray-march` — the SCREEN collision is resolved', () => {
    // THE FINDING THAT IS THIS MODULE'S OWN. The 2026-08-18 ruling's SCREEN
    // switch stops the BLIT and keeps the engine running; this param skips the
    // RAY-MARCH ITSELF. Both ship, because both are real — but two
    // differently-behaved controls captioned "screen" on one faceplate is a
    // defect, and the one that reads as the ruling's switch is the one that is
    // not it.
    expect(param('screen_on').label, 'the band cell says what it does').toBe('ray-march');
    const body = read(BODY_SRC);
    expect(body, 'and the BODY switch is the fleet key, not this param')
      .toContain('previewCollapsed');
    expect(body.includes('screen_on'), 'the body must not touch the ray-march param').toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('videocube face — the SIX ingest cells survive promotion', () => {
  const SLOTS = ['a', 'b', 'c'] as const;

  it('every slot has BOTH controls, ranked, and resolving to the right kind', () => {
    // STOP 2, as an assertion. These six decide WHAT IS IN THE CUBE; without
    // them the face is thirty knobs over a solid whose surfaces cannot be
    // chosen.
    for (const s of SLOTS) {
      const live = `videocube-${s}-live-{n}`;
      const file = `videocube-${s}-file-input-{n}`;
      expect(ORDER, `${live} is ranked`).toContain(live);
      expect(ORDER, `${file} is ranked`).toContain(file);
      expect(famCell(live)?.kind, `${live} is an action`).toBe('action');
      expect(famCell(file)?.kind, `${file} is a file cell`).toBe('file');
    }
  });

  // ⚠ 'every declared testidPrefix is a LITERAL the card emits' STOOD HERE, and
  // it is the clearest example in the tree of a leg whose question stopped
  // having an answer. `module-docs-lint` proved a prefix existed by GREPPING
  // card source, so this module had to spell six testids through a map rather
  // than as template literals — a change made ENTIRELY to satisfy the grep. The
  // shell stamps `shell-cell-<familyId>` from an interpolation, so there is no
  // per-family literal to grep for on any surviving surface, and that gate now
  // resolves each family to a live shell cell instead. The leg below already
  // asserts exactly that for all six of videocube's families.

  it('all six families are declared, and each resolves to a live cell', () => {
    expect((videocubeDef.controlFamilies ?? []).length, 'three slots x two controls').toBe(6);
    for (const f of videocubeDef.controlFamilies ?? []) {
      expect(famCell(`${f.id}-{n}`), `${f.id} has no shell cell`).toBeTruthy();
    }
  });

  it('⚠ all six probe an OUTCOME record, because all six are ENGINE-ONLY', () => {
    // Both actions hand a tagged element to `attachExternalSource` and write
    // NOTHING to the graph — v1 does not even persist a descriptor — so
    // readParam/readData are structurally blind. `videocubeSlot` is the record
    // every press writes, `ok: false` kept.
    for (const s of SLOTS) {
      const cell = famCell(`videocube-${s}-live-{n}`);
      const probe = (cell as { probe?: { effect?: { kind?: string; key?: string } } }).probe;
      expect(probe?.effect?.kind, `slot ${s}: a data probe`).toBe('data');
      expect(probe?.effect?.key, `slot ${s}: the outcome record`).toBe('videocubeSlot');
    }
  });

  it('⚠ EVERY exit of both actions records an outcome — failures included', () => {
    const src = read(ACTIONS_SRC);
    // `setVideocubeSlotLive` has three exits (no engine / success / throw) and
    // every one writes. `loadVideocubeSlotFile` funnels its failures through
    // `fail`, which writes, and its success writes directly.
    const writes = (src.match(/writeSlotOutcome\(/g) ?? []).length;
    // 1 definition + at least 5 call sites across the two functions.
    expect(writes, 'the outcome is written on every path, not just the happy one')
      .toBeGreaterThanOrEqual(6);
    expect(src, 'failures carry the reason').toContain("'video engine not ready'");
  });

  it('⚠ the surface calls ONE implementation, so a second copy cannot appear', () => {
    // ⚠ THIS READ THE CARD, because the card and the shell cells were the two
    // callers and "they cannot drift" needed both. The shell's registry is the
    // caller now, and it is the one that has to delegate rather than re-derive.
    const cells = read(CELLS_SRC);
    expect(cells, 'the shell cells delegate the LIVE reset').toContain('setVideocubeSlotLive(');
    expect(cells, 'and the atlas load').toContain('loadVideocubeSlotFile(');
    // …and the shared seam is where the dataset tagging the factory reads lives,
    // rather than being re-tagged by whichever surface happens to mount.
    expect(read(ACTIONS_SRC), 'the seam owns the element tagging')
      .toContain('dataset.videocubeClear');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('videocube face — the pictures, the pads and the tier ladder', () => {
  it('the picture arrives from the VIDEO seam, never from the glyph literal', () => {
    expect(videocubeDef.face?.glyph, 'the mandatory literal').toBe('none');
    expect(hasVideoSurface(videocubeDef), 'the lane tile paints a live thumb').toBe(true);
    expect(videocubeDef.face?.extension, 'and the dock paints the module body').toBe('videocube');
  });

  it('⚠ the body carries all THREE of the card\'s surfaces, not just the ray-march', () => {
    // The WAVE is the one a reader would drop as decoration. It must not be:
    // this module's whole claim is that the picture and the drone are two
    // readings of ONE field, and the wave beside the slice is where that claim
    // is checkable — it is the only place the SOUND is visible at all.
    const body = read(BODY_SRC);
    expect(body, 'the ray-march').toContain('videocube-face-canvas');
    expect(body, 'the slice cross-section').toContain('videocube-face-slice');
    expect(body, 'the derived wave').toContain('videocube-face-wave');
    expect(body, 'and the wave reads the same buffer audio_out plays').toContain("'lastWave'");
    // All three collapse together with the SCREEN switch.
    expect(body, 'one collapse gate for all three').toContain('{#if !previewCollapsed}');
  });

  it('all THREE pads bind CONTINUOUS pairs, rank both axes, and fold the y', () => {
    const pads = videocubeDef.face?.xyPads ?? [];
    expect(pads.length, 'slice tilt, reader window, orbit camera').toBe(3);
    const folded = foldedParamIds(videocubeDef);
    for (const pad of pads) {
      for (const axis of [pad.x, pad.y]) {
        expect(param(axis).curve, `${axis} is continuous — a pad over a discrete param is a stepper`)
          .not.toBe('discrete');
        expect(ORDER, `${axis} is ranked`).toContain(axis);
      }
      expect(folded.has(pad.y), `${pad.y} folds into the pad`).toBe(true);
      expect(folded.has(pad.x), `${pad.x} anchors the pad`).toBe(false);
    }
  });

  it('a pad costs NO lane rank — and it takes TWO composed exclusions', () => {
    // ⚠ MEASURED on the frametable lane and re-asserted here: `laneOrder` alone
    // drops only the pad's ANCHOR; `foldedOrder` (composed on top of it inside
    // `curatedFace`) is what removes the PARTNER. Asserting either half in
    // isolation would certify a face whose other half regressed.
    const laneOnly = laneOrder(videocubeDef.face!);
    const folded = foldedParamIds(videocubeDef);
    for (const pad of videocubeDef.face?.xyPads ?? []) {
      expect(laneOnly, `${pad.x}: the ANCHOR is what laneOrder drops`).not.toContain(pad.x);
      expect(folded.has(pad.y), `${pad.y}: the PARTNER is what folding drops`).toBe(true);
    }
    // THE COMPOSED OBSERVABLE, at the WIDEST lane tier.
    const wide = curatedFace(videocubeDef, 'full')?.controls.map((c) => c.key) ?? [];
    for (const pad of videocubeDef.face?.xyPads ?? []) {
      expect(wide, `${pad.x} never reaches a lane cell`).not.toContain(pad.x);
      expect(wide, `${pad.y} never reaches a lane cell`).not.toContain(pad.y);
    }
    // …and the DOCK is where each pad renders: anchor one cell, partner none.
    const dock = curatedFace(videocubeDef, 'dock')?.controls.map((c) => c.key) ?? [];
    for (const pad of videocubeDef.face?.xyPads ?? []) {
      expect(dock, `${pad.x} anchors the dock pad cell`).toContain(pad.x);
      expect(dock, `${pad.y} is inside it, not beside it`).not.toContain(pad.y);
    }
  });

  it('the TIER LADDER reads back as the comment claims: mini READER, compact +MORPH', () => {
    const mini = curatedFace(videocubeDef, 'mini');
    const compact = curatedFace(videocubeDef, 'compact');
    expect(mini?.controls.map((c) => c.key), 'mini: what the solid is built out of')
      .toEqual(['reader_mode']);
    expect(compact?.controls.map((c) => c.key), 'compact: and how the two ends blend through it')
      .toEqual(['reader_mode', 'morph_fc']);
  });

  it('face completeness: every param is ranked exactly once', () => {
    // No `noUserControl` on this def — every one of the thirty params has a real
    // control on the card, so all thirty must reach the face. Asserted DERIVED,
    // never as a count.
    expect(videocubeDef.noUserControl ?? [], 'nothing is hidden from the player').toEqual([]);
    for (const p of videocubeDef.params ?? []) {
      expect(ORDER.filter((k) => k === p.id).length, `${p.id} is ranked exactly once`).toBe(1);
    }
    // …and the def source still declares no time term, which is the FACES
    // roster's determinism leg. Kept here so the roster's claim has a unit-lane
    // anchor rather than living only in a spec comment.
    const def = read(DEF_SRC);
    for (const t of ['uTime', 'frame.time', 'Date.now', 'performance.now']) {
      expect(def.includes(t), `videocube declares no time term (${t})`).toBe(false);
    }
  });
});
