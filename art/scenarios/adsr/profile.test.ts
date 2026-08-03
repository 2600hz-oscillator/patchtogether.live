// art/scenarios/adsr/profile.test.ts
//
// AUDIO PROFILE for ADSR (backfill Phase-0 pilot — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: ENVELOPE — driven by the canonical held-square gate (spec §4.2:
// gate high then released, ≥1.0 s so attack→decay→sustain→release are all
// visible in the gallery). Gate: high for 0.6 s of a 1.2 s render.
//
// SIGNATURE outputs only (owner decision §6b.2): `env` is captured;
// `env_inv` is skipped as a non-distinct inverse (1 − env carries no
// independent information).
//
// ⚠ THIS PROFILE USED TO RENDER A DIFFERENT SYNTH.
//
// It drove `packages/dsp/src/lib/adsr-env.ts` `Envelope` — the shared per-voice
// state machine used by the POLY modules — and pinned that as "the ADSR audio
// profile". The module the rack actually ships is Faust `en.adsr`
// (packages/dsp/src/adsr.dsp), and the two are different envelopes:
//
//   adsr-env.ts   EXPONENTIAL, time-CONSTANT   release never reaches 0
//   en.adsr       LINEAR,      exact-DURATION  release reaches exactly 0 at +R
//
// The substitution was documented and deliberate ("the live module's Faust
// en.adsr worklet cannot run under node-web-audio-api"), and it was true when
// written — but batch 6 added the FAUST-IN-NODE harness
// (art/setup/faust-offline.ts, already used by vca/reverb/mixmstrs), which runs
// the real compiled `.wasm` headlessly. The justification was stale, and the
// lane was green about a synth nobody plays.
//
// It was not a harmless stand-in: this file's own
// `expect(buf[last]).toBeGreaterThan(0)` — at gate-off + 2× release — is FALSE
// of the shipped module. Measured through the real wasm, `en.adsr` is at
// EXACTLY 0.000000 by then, because a linear release of duration R is finished
// at +R. A test asserting the opposite of the shipping behaviour is worse than
// no test.
//
// Rendering path is now `renderFaustOffline` against the committed
// dist/adsr.{wasm,json} — the exact bytes the browser ships. The `.sha` pins
// `adsr.dsp` ALONE now; `lib/adsr-env.ts` is no longer part of this profile
// and a change to it must no longer invalidate this baseline.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { heldGate } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.2;
const GATE_ON_S = 0.6;

// packages/dsp/src/adsr.dsp slider defaults.
const ATTACK_S = 0.005;
const DECAY_S = 0.1;
const SUSTAIN = 0.7;
const RELEASE_S = 0.3;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'adsr',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [heldGate({ totalS: DURATION_S, onS: GATE_ON_S })],
    params: { attack: ATTACK_S, decay: DECAY_S, sustain: SUSTAIN, release: RELEASE_S },
    outputs: ['env'], // Faust output 0 = the `env` port
  });
}

describe('ART adsr / audio profile (canonical held gate, the REAL Faust en.adsr)', () => {
  it('renders the full A-D-S-R shape, bounded and deterministic', async () => {
    const buf = (await renderProfile()).env!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    // ATTACK: reaches the top within ~2× the 5 ms attack time.
    let peak = 0;
    for (let i = 0; i < Math.round(0.01 * SR); i++) peak = Math.max(peak, buf[i]!);
    expect(peak).toBeGreaterThan(0.99);
    // SUSTAIN: settled at the 0.7 plateau well after the 100 ms decay.
    expect(buf[Math.round(0.5 * SR)]!).toBeCloseTo(SUSTAIN, 2);

    // RELEASE — LINEAR and exact-duration, which is what makes this module
    // different from adsr-env.ts and is the reason this file was rewritten.
    // From SUSTAIN 0.7 over 0.3 s, measured through the real wasm:
    //   +100 ms → 0.4666  (0.7 × 2/3)
    //   +150 ms → 0.3500  (0.7 × 1/2)
    //   +300 ms → 0.0000  (finished, exactly)
    const at = (s: number): number => buf[Math.round(s * SR)]!;
    expect(at(0.7), 'release +100 ms').toBeCloseTo(SUSTAIN * (2 / 3), 2);
    expect(at(0.75), 'release +150 ms').toBeCloseTo(SUSTAIN * 0.5, 2);
    expect(
      at(GATE_ON_S + RELEASE_S),
      'a LINEAR release of duration R is at exactly 0 at +R — the previous ' +
        'version of this file asserted the opposite (> 0), which is true of ' +
        'the exponential adsr-env.ts core it was rendering instead',
    ).toBe(0);
    expect(buf[buf.length - 1]!).toBe(0);

    // Byte-deterministic re-render (headless Faust compute is pure).
    const again = (await renderProfile()).env!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the env profile baseline (SHA-gated on adsr.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('adsr.dsp');
    await pinAll('adsr', srcSha, await renderProfile());
  });
});
