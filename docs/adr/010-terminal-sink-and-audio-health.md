# ADR-010: Make the terminal sink safe, and name every way audio dies

- Status: Accepted (three DSP audit items still open — see Consequences)
- Date: 2026-09-08 (records decisions of 2026-07-01 and 2026-08-08/09)
- Deciders: project owner; this ADR documents the decisions
- Tags: audio, dsp, observability, output

## Context

Two problems met at the same node.

**The sink was hurting the mix.** `audioOut`'s safety stage was a full-band,
stereo-linked `DynamicsCompressorNode` at threshold −6 dB / ratio 4 / attack
3 ms / release 50 ms. A 3 ms attack on a full-band detector is on the order of
the sub period (40 Hz = 25 ms), so on a −6 dBFS kick it modulated the sub
waveform itself and pulled the whole mix down on each strike — measured at up to
5.03 dB of sub-band gain ripple, and clipping anyway above −1 dBFS in.

**Nothing could see a dropout.** "It bogs down and then stops" was
indistinguishable from a throttled laptop, a dead worklet, or a backgrounded
tab. A `git grep` over `packages/web/src` + `packages/dsp/src` for
`renderCapacity`, `playoutStats`, `processorerror` and `PerformanceObserver`
returned **zero hits for all four**, so every dropout investigation argued from
inference. The failure that mattered most was also the quietest: per the Web
Audio spec, when an `AudioWorkletProcessor` throws, *"the processor (and thus
the node) will output silence throughout its lifetime"* — permanent, silent, and
invisible to `ctx.state`, which stays `'running'` so the click-to-resume overlay
never appears.

## Decision

**The terminal sink owns loudness safety and output continuity, and each way
audio can die gets its own named detector rather than one "health" number.**

1. **A look-ahead brickwall limiter, own code, replaces the compressor.**
   `packages/dsp/src/lib/master-limiter-dsp.ts`: −1 dBFS ceiling, 1.5 s release,
   no auto-makeup. Look-ahead is the whole point — it delays the audio and
   shapes the gain over the window, so **below the ceiling the gain is exactly
   1, sample for sample** (a normally-levelled mix is bit-transparent and there
   is no ducking to measure), and above it the reduction is the minimum that
   reaches the ceiling rather than a slope applied to everything. The pure core
   is worklet-global-free so every guarantee is unit-testable in node.
2. **Four diseases, four detectors** (`packages/web/src/lib/audio/
   audio-health.svelte.ts`): **A** device underruns →
   `AudioContext.playbackStats` (`playback-stats.ts`); **B** permanent worklet
   death → `worklet-guard.ts`; **C** context suspension → `audio-gate.svelte.ts`;
   **D** main-thread starvation → `tick-latency.ts`. They produce the same user
   report and have nothing else in common; a fifth instrument must say which of
   the four it is *not* (`continuity-probe.ts` does exactly that — it is a
   graph-continuity probe, not an underrun counter).
3. **One worklet construction seam.** `worklet-guard.ts` `createWorkletNode`
   registers a `processorerror` handler on every worklet the app builds, so a
   latched processor is loud instead of silent, and is negative-controlled in
   both directions.
4. **The terminal chain fails over at runtime.** `audio-out-failover.ts` moves
   the limiter's degraded tail out of `audio-out.ts` so it is covered by a pure
   unit test with no DSP build and no `AudioContext`. The factory's `try/catch`
   only covers load time; a throw inside the limiter's `process()` silences the
   **entire rack permanently**, and the hard-clip fallback was unreachable from
   that failure until this path existed.
5. **Buffer size is a per-machine preference, and the context is never
   live-rebuilt.** `latencyHint` can only be set at construction, so the choice
   persists in `localStorage` (audio hardware is a property of the machine, not
   the rack) and applies on the next reload. A graceful teardown/reboot that
   re-creates every worklet, re-wires the reconciler and re-acquires the ES-9
   duplex stream is riskier than a reload, and a half-rebuild leaving dangling
   nodes is the very click source being fixed.

**Per-module gain staging stays a convention, not a normalisation pass.** Three
owner calls are recorded rather than "fixed": REVERB keeps the Faust stdlib
`re.mono_freeverb` wet level unscaled (it is left hot on purpose; when to
revisit is open), DELAY's mix is an equal-power crossfade with its ends named
(`DRY` / `35% WET` / `WET`), and FILTER's two CV depths are engine-graph
**attenuverters** that are exact identities at the +1 default — behaviour-neutral
for every existing patch, and the fix for an envelope pinning the cutoff at the
ceiling.

## Consequences

**Good:**

- A mix that never touches the ceiling is now provably untouched, so "does the
  limiter colour my sound" is answerable rather than arguable.
- The instruments are cheap and they **rule a class in or out**. Nobody has
  shown that a latched processor is what happened to the owner — the value is
  that the question can now be asked at all, and "the processor never threw" and
  "the handler was never wired" no longer print identically.
- Naming the four modes stopped the fifth instrument from being mis-named. A
  min-RMS floor on a graph tap is not a device-starvation detector, and calling
  one the other convinces every downstream reader that starvation is covered.

**Bad / load-bearing:**

- **A headless browser cannot assert an underrun.** The null sink does not
  starve, so mode A has no e2e assertion — only unit coverage and the live
  readout. State that limit wherever the readout is cited.
- **The limiter is a hard dependency of the audio-out node**, which is itself a
  patch node; that coupling is what ADR-011's crossfade work runs into.
- Three items from the same DSP audit are **still open** and each needs owner
  ears, not an implementer's judgement:
  - `packages/dsp/src/analog-vco.dsp` is still naive `saw(p) = 2.0*p - 1.0`
    with no band-limiting; routing `analogVco`/`swolevco` through the
    polyBLEP oscillator core would change audible timbre.
  - Gain staging above unity is per-module convention only (e.g.
    `packages/dsp/src/drummergirl.dsp` volume max 2.0); a one-time staging pass
    versus leaving it as convention is unresolved.
  - `packages/dsp/src/lib/resofilter-dsp.ts` states it was ported from
    `gabrielsoule/resonarium` and asserts **no licence**. That is a genuine
    open legal item — either confirm the upstream is permissive or re-derive the
    filter clean-room, as the Moog family did (ADR-018).
- The audit's honest-negatives are part of the decision: several proposed
  changes were measured and **not** made, and the alias-measurement method it
  used (negative-control the measurement before believing the number) is the
  reusable part.

## References

- `packages/dsp/src/lib/master-limiter-dsp.ts`,
  `packages/web/src/lib/audio/modules/audio-out.ts`,
  `art/scenarios/audio-out/master-limiter-sub-pump.test.ts` — the limiter, its
  measured predecessor, and the harness.
- `packages/web/src/lib/audio/playback-stats.ts`, `worklet-guard.ts`,
  `audio-out-failover.ts`, `tick-latency.ts`, `audio-health.svelte.ts`,
  `continuity-probe.ts` — the detectors.
- `packages/web/src/lib/ui/audio-latency-store.svelte.ts` — the buffer
  preference and the never-live-rebuild rule.
- `packages/web/src/lib/audio/modules/{reverb,delay,filter}.ts` — the three
  per-module gain/CV rulings.
- `.claude/skills/audio-runtime/references/measuring-audio.md` — which lane can
  observe which layer.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `2026-08-08-buffer_exporation.md`,
  `plans/dsp-stack-bass-freq-audit-2026-07-01.md` and
  `plans/shell-ui-refactor-resume-2026-07-26.md` (paths relative to the
  retired agent-evidence tree in that snapshot, not to the worktree).
