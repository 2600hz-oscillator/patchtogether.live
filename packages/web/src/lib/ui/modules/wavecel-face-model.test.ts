// packages/web/src/lib/ui/modules/wavecel-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the WAVECEL faceplate.
//
// This face rests on four claims that no shared gate checks, and each is the
// kind that reads as true whether or not it is:
//
//   1. "`'envelope'` was AVAILABLE and was declined." Every other glyph
//      decision in the pool is forced — the arm resolves `static` and the
//      dead-glyph clause refuses it. Here the arm genuinely resolves, so
//      "declined" is a real choice and something has to prove the option
//      existed.
//   2. "The viz toggle is NOT a data-backed shell cell." That conclusion came
//      from reading one line of the card, and one line is exactly what drifts.
//   3. "The three acquisition actions survive promotion." Promotion deletes the
//      card from both surfaces, so anything that lived only there is gone —
//      the `samsloop` failure, which is the reason STOP 2 exists.
//   4. The RANK, which encodes measured defects (#1999) rather than taste.
//
// ⚠ THERE IS NO DERIVED READOUT TO NEGATIVE-CONTROL, and one finding lost its
// surface to that. The spec proposed a `wavecel-pitch` readout (oscillator Hz
// from tune + fine, 261.63 Hz at the defaults) whose whole point was that a
// KNOB READBACK cannot express it: move FINE with TUNE fixed and a readback on
// TUNE prints the same semitone count and is blind to the cents. The
// 2026-08-19 resting-text ruling removed every readout mechanism, so that
// derivation has no home on the plate. It is recorded here so the coverage
// lapse is visible rather than silent.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { wavecelDef } from '$lib/audio/modules/wavecel';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { STRICT_FACES, migrated } from '$lib/ui/workflow/strict-faces';
import {
  panelCellKeys,
  shellCellFor,
  shellCellKeys,
  shellPanelProbes,
} from '$lib/ui/workflow/shell-cells';

const FACE = wavecelDef.face!;

/** Read a registered cell through the PUBLIC accessor the shell itself uses,
 *  rather than the private registry object — so these assertions exercise the
 *  same lookup ModuleShell performs, not a shape beside it. */
const cell = (key: string) => shellCellFor('wavecel', { kind: 'family', key } as never);
/** The card source — the control-loss ground truth STOP 2 reads. */
const CARD = readFileSync(
  new URL('./WavecelCard.svelte', import.meta.url),
  'utf8',
);

describe('wavecel — promoted, complete, and three honest pages', () => {
  it('is in STRICT_FACES, which is what actually swaps the surfaces', () => {
    expect(STRICT_FACES.has('wavecel')).toBe(true);
    expect(migrated('wavecel')).toBe(true);
  });

  it('ranks every param AND every declared control family', () => {
    const params = wavecelDef.params.map((p) => p.id);
    const families = (wavecelDef.controlFamilies ?? []).map((f) => `${f.id}-{n}`);
    expect([...FACE.order].sort()).toEqual([...params, ...families].sort());
  });

  it('declares THREE pages and stays off the tab rail', () => {
    // DOCK_TAB_MIN_BANDS is 7. Recorded so that adding a fourth page is a
    // deliberate act, and so "not control-heavy" is asserted rather than said.
    expect(FACE.pages?.map((p) => p.id)).toEqual(['tone', 'env', 'table']);
    expect(FACE.pages!.length).toBeLessThan(7);
  });

  it('the hero promotes the PICTURE out of `table`, leaving that band populated', () => {
    // A hero.cell MOVES a key; if it emptied its band the post-split page count
    // would be 2 and the VRT roster entry (pages: 3) would be a lie.
    expect(FACE.hero?.cell).toBe('wavecel-viz-toggle-{n}');
    const table = FACE.pages!.find((p) => p.id === 'table')!;
    expect(table.controls).toContain('wavecel-viz-toggle-{n}');
    expect(table.controls.filter((c) => c !== 'wavecel-viz-toggle-{n}')).toHaveLength(3);
  });
});

describe('wavecel — CLAIM 1: `envelope` was available and was DECLINED', () => {
  it('POSITIVE CONTROL: the envelope arm genuinely resolves on this def', () => {
    // The whole point. `glyphBinding` checks the envelope arm BEFORE the
    // audio-out short-circuit and needs literal attack/decay/sustain/release —
    // this def has all four, so the option was real. Every other glyph refusal
    // in the pool is forced (`static` + the dead-glyph clause); this one is a
    // choice, and without this leg "declined" is unfalsifiable.
    const asEnvelope = glyphBinding({ ...wavecelDef, face: { ...FACE, glyph: 'envelope' } });
    expect(asEnvelope.kind).toBe('env-params');
  });

  it('and the face declares `waveform`, which binds a LIVE trace on out_l', () => {
    // Declined because the env contour would picture a control set that is
    // bit-exactly INERT in the module's default ungated state — a picture of
    // nothing happening, on the module's most prominent surface.
    expect(FACE.glyph).toBe('waveform');
    expect(primaryAudioOutPortId(wavecelDef)).toBe('out_l');
    expect(glyphBinding(wavecelDef).kind).toBe('live-audio');
  });

  it('is NOT a video-surface def, so the picture could never have been generic', () => {
    expect(hasVideoSurface(wavecelDef)).toBe(false);
    expect(hasVideoSurface({ domain: 'video' })).toBe(true);
  });
});

describe('wavecel — CLAIM 2: the viz toggle is a VIEW preference, not module state', () => {
  it('the CARD holds it in component $state — the line the estimate turned on', () => {
    // ⚠ ANCHORED TO THE CARD SOURCE. The inventory said "viz toggle → toggle",
    // which would have made this module the first adopter of the data-backed
    // `toggle` shell cell. That reading came from the "persists across page
    // reloads + multiplayer" comment sitting two lines below — which is about
    // `wavetableSource`. If this assertion ever fails, the premise moved and
    // the cell choice must be re-decided rather than inherited.
    expect(CARD).toMatch(/let vizMode = \$state<'scope' \| '3d'>\('3d'\)/);
  });

  it('NEGATIVE CONTROL: the card does NOT persist the view mode anywhere', () => {
    // The other half of the same claim: if the card ever starts writing a view
    // key to node.data, the "private preference" argument is gone.
    expect(CARD).not.toMatch(/vizMode\s*=\s*[^;]*node\.data/);
    expect(CARD).not.toMatch(/data\.vizMode/);
  });

  it('so it is NOT a `toggle` shell cell — wavecel adopts none', () => {
    const kinds = shellCellKeys('wavecel').map((k) => cell(k)?.kind);
    expect(kinds).not.toContain('toggle');
  });

  it('and the panel probe watches STATE, not the button it drives', () => {
    // The gate refused a `text` probe whose witness was the toggle's own
    // caption: "a control that only relabels itself is indistinguishable from
    // a dead one". Pinned so a future edit cannot quietly weaken it back.
    expect(panelCellKeys('wavecel')).toEqual(['wavecel-viz-toggle-{n}']);
    const probe = shellPanelProbes().wavecel?.['wavecel-viz-toggle-{n}'];
    expect(probe?.effect?.kind).toBe('data');
    expect((probe?.effect as { key?: string } | undefined)?.key).toBe('vizMode');
  });
});

describe('wavecel — CLAIM 3: every way of ACQUIRING a wavetable survives promotion', () => {
  // THE `samsloop` CHECK. Promotion makes `migrated()` true and neither
  // surface renders the card, so an acquisition path that lives only there is
  // deleted by the promotion itself. wavecel has THREE.
  it('all three acquisition affordances have a shell cell', () => {
    expect(cell('wavecel-source-select-{n}')?.kind).toBe('selector');
    expect(cell('wavecel-preset-select-{n}')?.kind).toBe('selector');
    expect(cell('wavecel-wav-input-{n}')?.kind).toBe('file');
  });

  it('ANCHORED: each maps to a testid the CARD actually carries', () => {
    // Deny-by-default in the honest direction — the cells are named after
    // declared families, and a family whose testid left the card would mean
    // the face is modelled on a control that no longer exists.
    for (const f of wavecelDef.controlFamilies ?? []) {
      expect(CARD, `${f.id} testid missing from the card`).toContain(f.testidPrefix);
    }
  });

  it('and every declared family is BACKED by a registered cell', () => {
    for (const f of wavecelDef.controlFamilies ?? []) {
      expect(cell(`${f.id}-{n}`), `${f.id} has no shell cell`).not.toBeNull();
    }
  });
});

describe('wavecel — CLAIM 4: the rank encodes measured defects (#1999)', () => {
  it('MORPH first, SPREAD second — the compact pair', () => {
    // A glyph binds, so compact caps at 2. MORPH is the only control that
    // changes the timbre AND the level (rms spans 4.552 dB across its range);
    // SPREAD is the headline gesture and ships bit-exactly MONO.
    expect(FACE.order.slice(0, 2)).toEqual(['morph', 'spread']);
  });

  it('FOLD ranks BELOW the control that gives it authority', () => {
    // fold 0 → 1 moves rms by -0.0017 dB at the shipped morph = 0, against
    // -4.5244 dB at morph = 0.25. Its authority is a function of MORPH, so it
    // cannot outrank it.
    expect(FACE.order.indexOf('fold')).toBeGreaterThan(FACE.order.indexOf('morph'));
  });

  it('the amp ENV ranks last — all five are inert at spawn', () => {
    // With nothing in POLY or TRIGGER there is no note to shape. ⚠ NOT "five
    // dead controls": gated, attack/sustain/base_vol move, while decay and
    // release correctly do not under a HELD gate. Ranked last for inertness at
    // spawn, which is a statement about the DEFAULT STATE, not about the DSP.
    const env = ['attack', 'decay', 'sustain', 'release', 'base_vol'];
    const firstEnv = Math.min(...env.map((id) => FACE.order.indexOf(id)));
    for (const tone of ['morph', 'spread', 'fold', 'tune', 'fine']) {
      expect(FACE.order.indexOf(tone)).toBeLessThan(firstEnv);
    }
  });

  it('SPREAD still ships at its floor — the face did not "fix" #1999', () => {
    // ⚠ A face ranks; it does not change audio. If this default ever moves it
    // must be an owner decision on #1999, and this leg is what makes that
    // visible instead of incidental.
    const spread = wavecelDef.params.find((p) => p.id === 'spread')!;
    expect(spread.defaultValue).toBe(spread.min);
    expect(spread.defaultValue).toBe(1);
  });
});
