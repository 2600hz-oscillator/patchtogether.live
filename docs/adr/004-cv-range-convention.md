# ADR-004: CV range convention

- Status: Accepted
- Date: 2026-05-30
- Deciders: project owner
- Tags: dsp, semantics, modules
- Supersedes: pre-cv-scale ad-hoc per-module mapping

## Context

CV (control voltage) signals flow between modules in both domains
(audio and video). For multi-module patches to behave musically,
every CV producer and every CV consumer must agree on what numeric
range corresponds to what semantic intensity.

Eurorack hardware standardizes around ±5V LFOs / 1V-per-octave pitch /
gate at 5V or 0V. We're not hardware; we're an in-process signal graph.
We chose a *normalized* convention instead of imitating eurorack
volts, because (a) Web Audio's natural numeric range is unit-less and
(b) a port-level scaling hint lets us drive every target param
edge-to-edge without each module reinventing its own knee.

A naive choice would be "every CV is whatever the source wants and
each consumer scales". That produces the classic eurorack frustration
where an LFO patched into a target moves the dial by ~10% of its
travel because the target's natural range is wider than the LFO's
amplitude.

## Decision

**The `cv` cable type carries a bipolar `-1..+1` modulation signal**
where ±1 sweeps the target parameter through its full natural range,
centered on the user-set knob position.

Each input `PortDef` of type `cv` carries an optional `cvScale` hint
(`packages/web/src/lib/graph/types.ts:CvScaleHint`) telling
`AudioEngine.addEdge` how to interpose a scaling node between source
and target AudioParam:

- `linear` — additive modulation around the knob. Used for params
  whose natural perceptual axis is linear (volume, pan, mix, EQ band
  gain). Effective param =
  `clamp( knob + cv * depth * (max-min)/2, min, max )`.
- `log` — exponential modulation around the knob. Used for params
  whose natural perceptual axis is logarithmic (frequency in Hz, time
  in seconds). Effective param =
  `clamp( knob * pow(max/min, cv * depth / 2), min, max )`.
- `discrete` — integer bucketing. Used for mode toggles, range
  selectors. `floor((cv+1)/2 * (max-min+1))` mapped to `[min, max]`.
- `passthrough` — no scaling. Web Audio sums the source directly into
  the AudioParam. Use when the destination DSP already implements its
  own CV scaling (e.g. `filter.dsp`'s built-in ±5oct map).

**`depth` is reserved** for a future per-param "modulation depth" knob;
default 1.0 = full sweep.

For **gate** signals (the `gate` port type), the convention is:

- 0 / 1 audio-rate signals (transient excursion to 1 then back to 0).
- A pulse is **10ms wide**, chosen so a 60fps polling tap can't miss it
  (16ms sample window comfortably brackets the excursion).
- Sources that emit truly transient events (DOOM's `evt_kill`, etc.)
  expose an opt-in `subscribePulse(portId, cb)` callback so the engine
  can install a discrete dispatch path in addition to the analyser
  tap — guaranteeing zero missed pulses even under 30fps tab
  throttling.

Pitch CV (1V-per-octave mapping) was an earlier candidate but is **not**
the current convention; pitch is delivered via the `linear` cvScale hint
on frequency params with `log` curve, OR via direct param wiring for
note-entry sequencers using `midiToHz()`
(`packages/web/src/lib/audio/note-entry.ts:129`).

## Consequences

**Good:**

- An LFO patched into *anything* sweeps the slider edge-to-edge —
  the "obvious" behavior matches reality.
- Module authors don't reinvent scaling per param; they pick a
  `cvScale` mode and the engine handles it.
- Same convention covers audio↔video CV bridges, so an audio LFO
  driving DOOM's render param behaves the same as one driving a VCA.

**Bad / load-bearing:**

- **Sources MUST clip to ±1.** A source that emits ±2 will overshoot
  the destination's natural range. Modules whose DSP can naturally
  exceed ±1 (envelope-follower `env_out`, sidechain compressor's
  unclamped envelope) document this explicitly as a contract — see
  the `sidecar` module's `env_out` note in `graph/types.ts`.
- **Pulse-on-gate sources MUST implement `subscribePulse`** if the
  pulse is shorter than ~16ms. Otherwise frame-throttled tabs miss
  gates and downstream sequencing skips.
- **Pitch is by-convention shape, not a fixed unit.** A pitch CV
  driving a frequency param with `log` knob curve + `linear`
  cvScale + depth=1 spans the param's full octave range — but it's
  not 1V/oct in any literal sense.
- **`passthrough` is the legacy default** when `cvScale` is unset.
  This means new modules that forget to declare `cvScale` get the
  unscaled summation behavior. The e2e gate
  `e2e/tests/cv-range-uniformity.spec.ts` catches the bulk class of
  oversights.

## References

- `packages/web/src/lib/graph/types.ts:498-540` — `CvScaleHint`
  interface + the per-mode formulas.
- `packages/web/src/lib/audio/engine.ts:1160-1220` — pulse-aware
  bridge wiring (`subscribePulse`).
- `packages/web/src/lib/audio/note-entry.ts:129` — `midiToHz()`.
- `packages/web/src/lib/video/modules/doom.ts:240-340` — gate port
  declarations + 10ms pulse contract.
- `e2e/tests/cv-range-uniformity.spec.ts` — invariant test.
- `.myrobots/plans/cv-range-standard.md` — full design rationale.
- README "CV range convention" section.
- ADR-003 — bridge wiring picks up pulses via the same convention.
