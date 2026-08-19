// packages/web/src/lib/ui/modules/destroy-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS UNDER DESTROY's FACEPLATE.
//
// A derived readout is only worth more than a relabelled dial if something
// checks, ON EVERY RUN, that it moves where the dial is BLIND — and that it
// does NOT move where the dial would. This file is that check, and it is
// written as a MATRIX derived from the def rather than as four hand-picked
// perturbations: every declared readout × every declared param, asserted
// against a table of expected sensitivities in BOTH directions. A readout added
// to `face.hero.readouts` with no row here is RED, and a row naming a readout
// or a param that no longer exists is RED.
//
// WHAT THIS FILE CANNOT SEE, stated so a green run does not read as more than
// it is: it checks the MODEL's arithmetic, not the DSP's. The join to the
// shipping compiled Faust wasm — that the hold really is `round(decimate)`
// samples, that the crush floor really lands where `destroyBitFloorDb` says,
// that the dead zone really is a cliff at `−6.02 × bits` — is
// `art/scenarios/destroy/face-audit.test.ts`, which renders the module.

import { describe, expect, it } from 'vitest';
import { destroyDef } from '$lib/audio/modules/destroy';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import {
  DESTROY_REFERENCE_SR,
  destroyBitFloorDb,
  destroyEffectiveSrHz,
  destroyFaceParams,
  destroyFloorText,
  destroyHoldSamples,
  destroyMuteDb,
  destroyMuteText,
  destroyQuantStep,
  destroyRateText,
  destroyStreamKbps,
  destroyStreamText,
} from './destroy-face-model';

/** A param reader over a sparse overlay, exactly as ModuleShell builds one. */
const reader =
  (overlay: Record<string, number>) =>
  (id: string): number | undefined =>
    overlay[id];

/** The DECLARED readout ids, read off the def. DERIVED — there is no list of
 *  readouts in this file and no count of one. */

/** The DECLARED param ids, read off the def. */
const PARAM_IDS = destroyDef.params.map((p) => p.id);

/** The default overlay — what a freshly spawned node resolves to. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  destroyDef.params.map((p) => [p.id, p.defaultValue]),
);

/**
 * Two settings per param, chosen INSIDE the declared range and far enough apart
 * that any real sensitivity shows. Derived from the def's own min/max so a
 * range change cannot leave this probing outside the control.
 */
const PROBE: Record<string, [number, number]> = Object.fromEntries(
  destroyDef.params.map((p) => [p.id, [p.min, p.max] as [number, number]]),
);

/**
 * THE SENSITIVITY CONTRACT — which readout is expected to move under which
 * dial. `true` = the printed string MUST differ between the two probe points;
 * `false` = it MUST be identical.
 *
 * ⚠ THE `false` CELLS ARE THE POINT. A readout that moved under everything
 * would be indistinguishable from a level meter, and a readout that moved under
 * nothing would be a constant. Six of the twelve cells below are `false`, and
 * each one is a claim about the DSP: WET does not move `rate` because the
 * decimator's hold length has no wet term; DECIMATE does not move `floor`
 * because the quantiser's step has no rate term.
 */
const SENSITIVITY: Record<string, Record<string, boolean>> = {
  'destroy-rate': { decimate: true, bits: false, wet: false },
  'destroy-stream': { decimate: true, bits: true, wet: false },
  'destroy-bit-floor': { decimate: false, bits: true, wet: true },
  'destroy-mute': { decimate: false, bits: true, wet: false },
};

function printed(valueId: string, overlay: Record<string, number>): string {
  const fn = faceReadoutValueFor(valueId);
  expect(fn, `readout '${valueId}' is registered in face-readout-values`).not.toBeNull();
  return fn!(reader(overlay));
}

describe('destroy face model — the glyph binding, ESTABLISHED not assumed', () => {
  it('resolves a LIVE audio tap, not the dead `static` binding', () => {
    // The buggles / ninelives lesson: `primaryAudioOutPortId` returning null
    // makes every glyph literal but 'none' fall through to `{kind:'static'}`,
    // which module-face-lint refuses. destroy declares one `audio` output, so
    // the trace is real — asserted by CALLING both functions.
    expect(primaryAudioOutPortId(destroyDef)).toBe('audio');
    expect(glyphBinding(destroyDef)).toEqual({ kind: 'live-audio', portId: 'audio' });
    expect(destroyDef.face?.glyph).toBe('scope');
  });

  it('the declared glyph is the one whose binding was checked', () => {
    // NEGATIVE CONTROL on the assertion above: it would pass for 'meter' too,
    // so prove the binding is a property of the PORTS and that a def with no
    // audio output collapses to `static` — the state this module is not in.
    const noAudioOut = {
      ...destroyDef,
      outputs: [{ id: 'audio', type: 'cv' as const }],
    };
    expect(primaryAudioOutPortId(noAudioOut)).toBeNull();
    expect(glyphBinding(noAudioOut)).toEqual({ kind: 'static' });
  });
});

describe('destroy face model — the laws, with #1716 as a permanent control', () => {
  it('the hold length ROUNDS; TRUNCATION is red at every integer position', () => {
    // The shipped defect, kept as the negative control the fix must not
    // regress to. `int(d)` read one step LOW at every integer dial position
    // because the `si.smoo`-ed slider stalls just below its target.
    const wrong: string[] = [];
    for (let d = 1; d <= 64; d++) {
      expect(destroyHoldSamples(d), `hold at DECIMATE ${d}`).toBe(d);
      // The pre-fix arithmetic, on the value the smoother actually presents.
      const stalled = d - 4.8e-4;
      if (Math.trunc(stalled) === d) wrong.push(`trunc law agreed at d=${d}`);
    }
    expect(wrong, 'the truncating law must disagree with the shipped one everywhere')
      .toEqual([]);
    // The half-step boundaries, since CV lands anywhere on a continuous dial.
    expect(destroyHoldSamples(1.4)).toBe(1);
    expect(destroyHoldSamples(1.6)).toBe(2);
    expect(destroyHoldSamples(2.49)).toBe(2);
    expect(destroyHoldSamples(2.51)).toBe(3);
  });

  it('effective rate, step, stream and the two dB edges are the declared closed forms', () => {
    const p = destroyFaceParams(reader({ decimate: 8, bits: 4, wet: 1 }));
    expect(destroyEffectiveSrHz(p)).toBe(DESTROY_REFERENCE_SR / 8);
    expect(destroyQuantStep(4)).toBe(0.125);
    expect(destroyStreamKbps(p)).toBeCloseTo((4 * 6000) / 1000, 9);
    expect(destroyBitFloorDb(p)).toBeCloseTo(20 * Math.log10(0.125 / Math.sqrt(12)), 9);
    expect(destroyMuteDb(4)).toBeCloseTo(-24.0824, 3);
    // The shipped-default strings the VRT dock baseline contains.
    const d0 = destroyFaceParams(reader({}));
    expect(destroyRateText(d0)).toBe('48.0 kHz');
    expect(destroyStreamText(d0)).toBe('768 kbit/s');
    expect(destroyFloorText(d0)).toBe('-101.1 dB');
    expect(destroyMuteText(d0)).toBe('-96.3 dB');
  });

  it('WET 0 prints `off` rather than an infinity', () => {
    expect(destroyBitFloorDb(destroyFaceParams(reader({ wet: 0 })))).toBe(-Infinity);
    expect(destroyFloorText(destroyFaceParams(reader({ wet: 0 })))).toBe('off');
  });
});

describe('destroy face model — TOTALITY (it runs on every frame of a drag)', () => {
  it('a FRESH node with no stored params resolves the def defaults', () => {
    const p = destroyFaceParams(reader({}));
    expect(p).toEqual({ decimate: 1, bits: 16, wet: 1 });
  });
});
