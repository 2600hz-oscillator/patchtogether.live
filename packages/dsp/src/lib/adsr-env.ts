// packages/dsp/src/lib/adsr-env.ts
//
// Shared ADSR Envelope for the per-voice amplitude envelopes on CUBE / WAVECEL
// / DX7 (the per-voice-ADSR feature). Lives in lib/ so esbuild inlines it into
// each worklet entry at build time; lib/ files may `export` freely (the worklet
// entries under src/*.ts must NOT top-level-export — see the
// dsp-worklet-no-top-level-export rule).
//
// The state machine + `tick` body are a VERBATIM copy of the Helm synth's Envelope
// (mopo/envelope.cpp algorithm port: linear attack ramp, single-pole-exp
// decay/release, times in SECONDS, sustain 0..1). pentemelodica-dsp.ts is
// NOT migrated onto this lib — it is shipped + baselined and stays
// byte-identical with its own `value = 0` envelope.
//
// What's NEW here vs the Helm synth's Envelope: the trigger is split into two methods.
//   * triggerHard(on) — the VERBATIM Helm-synth behavior (rising edge resets value
//     to 0). Kept so a future opt-in migration of pentemelodica onto this
//     lib stays bit-identical.
//   * triggerSoft(on) — a CLICK-SAFE retrigger that attacks from the CURRENT
//     value (no value=0). The attack RATE is unchanged — `tick` always ramps
//     at 1/(sr·attack) regardless of the start value — so soft-retrigger only
//     shortens the attack DURATION, never the slope. This is what the 3 new
//     modules call on a rising gate edge, so retriggering a still-releasing
//     voice never produces a sample-to-sample discontinuity.

export enum EnvState {
  Idle = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
  Release = 4,
}

export class Envelope {
  state: EnvState = EnvState.Idle;
  value = 0;

  /** VERBATIM Helm-synth behavior — rising edge HARD-resets the value to 0; falling
   *  edge → Release. For Helm-synth / pentemelodica parity (opt-in; the 3 new modules
   *  use triggerSoft instead). */
  triggerHard(on: boolean): void {
    if (on) {
      this.state = EnvState.Attack;
      this.value = 0;
    } else if (this.state !== EnvState.Idle) {
      this.state = EnvState.Release;
    }
  }

  /** Click-safe SOFT retrigger — rising edge attacks from the CURRENT value
   *  (no value=0); falling edge → Release from wherever the value is. The 3
   *  new ADSR modules use this. The attack RATE is unchanged (1/(sr·a) in
   *  `tick`); only the attack DURATION is value-dependent. */
  triggerSoft(on: boolean): void {
    if (on) {
      this.state = EnvState.Attack;
      // NOTE: deliberately NO `this.value = 0` — that's the whole point.
    } else if (this.state !== EnvState.Idle) {
      this.state = EnvState.Release;
    }
  }

  /** Advance one sample. attack/decay/release are in SECONDS, sustain 0..1.
   *  Body copied verbatim from the Helm synth's envelope.cpp. */
  tick(attack: number, decay: number, sustain: number, release: number, sr: number): number {
    if (this.state === EnvState.Attack) {
      const a = Math.max(1e-6, attack);
      const inc = 1 / (sr * a);
      this.value += inc;
      if (this.value >= 0.999) {
        this.value = 1.0;
        this.state = EnvState.Decay;
      }
    } else if (this.state === EnvState.Decay) {
      const d = Math.max(1e-6, decay);
      const susTarget = Math.max(0, Math.min(1, sustain));
      // Single-pole exp approach toward sustain. Time-constant d so 99% in
      // approximately 5d.
      const coef = Math.exp(-1 / (sr * d));
      this.value = susTarget + (this.value - susTarget) * coef;
      if (Math.abs(this.value - susTarget) < 1e-4) {
        this.value = susTarget;
        this.state = EnvState.Sustain;
      }
    } else if (this.state === EnvState.Sustain) {
      this.value = Math.max(0, Math.min(1, sustain));
    } else if (this.state === EnvState.Release) {
      const r = Math.max(1e-6, release);
      const coef = Math.exp(-1 / (sr * r));
      this.value *= coef;
      if (this.value < 1e-5) {
        this.value = 0;
        this.state = EnvState.Idle;
      }
    }
    return this.value;
  }
}
