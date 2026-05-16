# E2E Module Coverage Plan

Roadmap for landing first-class per-module E2E coverage across every
registered patchtogether.live module (audio + video + meta) in
Playwright. Mirrors the goal stated in the runbook for this work
session: every module gets at least a spawn test + an I/O contract
test, every logical group gets at least one cross-module integration,
and audio<->video routes get at least one cross-domain test.

This doc is the source of truth for what's done, what's in flight, and
what's left. Each group below maps to one PR.

## Existing coverage we build on

- `e2e/tests/modules.spec.ts` — per-module spawn + handle-count + label
  + bounding-box render check (already covers every type). This is the
  cheap-and-fast smoke layer. Stays as-is.
- `e2e/tests/io-spec-consistency.spec.ts` — strict equivalence between
  `AudioModuleDef.inputs/outputs` and the rendered Svelte Flow Handle
  ids. Stays as-is.
- `e2e/tests/voice-chain.spec.ts` — Sequencer -> AnalogVCO + ADSR ->
  VCA -> Scope -> Out, with a sounding-step assertion. Already covers
  the canonical signal-flow integration.

What's missing and what this plan adds:

1. An **I/O contract** test per module — every declared output emits a
   value of the declared cable type when given live input; every
   declared input accepts the declared type when wired without
   throwing or surfacing a console error.
2. A **meaningful musical / visual** integration per logical group —
   typically a sequencer driving a voice, a modulation source driving
   a target, or a video source feeding an effect into a sink.
3. **Cross-domain** integration (audio <-> video) — e.g., LFO CV
   modulating a video module's CV input, or an audio-domain SCOPE
   reading a `mono-video` ramp output.

## Shared harness

Lives in `e2e/tests/_module-coverage-helpers.ts` (new file added in
PR 2):

- `withModule(page, type, params?)` — single-module fixture. Wraps
  `spawnPatch` so common per-module tests don't repeat boilerplate.
  Returns `{ nodeId }`.
- `expectAudioFromOutput(page, nodeId, outputPortId, opts)` — wires
  the module's output into a `scope` node + reads `engine.read('snapshot')`
  to assert non-silence + provide a peak/rms readout in the failure
  message. Defaults to ~500 ms of capture.
- `expectCvFromOutput(page, nodeId, outputPortId, opts)` — wires the
  `cv` output into an `lfo`'s `shape` cv param via the same scope-based
  read trick (the engine's CV->AudioParam path lands a measurable
  signal). Cheaper for modules that only have cv-typed outputs.
- `expectVideoFrames(page, nodeId, opts)` — for video-domain modules:
  reads a `videoOut` node's preview canvas pixel buffer (already
  exposed via the dev hook for VRT tests) and asserts non-uniform
  output (variance > 0 across frames).

These get built lazily as PRs need them; we do **not** ship a "framework
PR" with no users.

## Logical groups + per-group PR plan

Sequenced from simplest (lowest blast radius, fastest to get green) to
most complex. Each group is one branch + one PR; admin-merged when CI
is green.

### Group 1 — Sinks + dev/utility (shakedown)

Module types: `audioOut`, `destroy`, `scope`, `sticky` (meta).

Tests:
- audioOut: spawn + verify the L/R inputs accept audio (no console
  errors when wired to a sine from analogVCO). Master fader sweep
  changes output peak (already implicit, but we'll lock it down).
- destroy: spawn + wire an `analogVco.sine` -> destroy.in, verify the
  outputs (corrupt + clean) deliver audio.
- scope: spawn + assert `engine.read(node,'snapshot')` returns a
  `Float32Array` of expected length, asserts ch1/ch2 segregation when
  only one channel is wired.
- sticky: spawn + render check (meta, zero ports; trivially
  re-asserted here).

PR: `test(e2e): sinks + utility module coverage`.

### Group 2 — Sources (audio VCOs + noise)

Module types: `analogVco`, `wavetableVco`, `noise`, `dx7`,
`macrooscillator`, `vizvco`, `wavviz`, `swolevco`, `wavecel`.

Tests per module:
- I/O contract: drive `pitch` (or `trig`+`pitch`) with a test tone,
  read the audio output(s) via scope, assert non-silence + verify the
  declared output is `audio` type (audio-rate, not subaudible flat).
- vizvco + wavviz + swolevco + wavecel: also have mono-video outputs
  (`scope_out`, `wave3d_out`); cross-domain test wires `scope_out` ->
  `videoOut.in` and verifies it routes (covered in Group 9).
- dx7: pure-TS (no worklet); spawn-and-emit pitch test.
- macrooscillator: model switching + emit-on-each-model smoke.

Integration: `sequencer -> {each VCO}.pitch -> scope` produces audio
that shifts with step pitch. One test per VCO type; parameterized.

PR: `test(e2e): audio-source module I/O coverage`.

### Group 3 — Modulation + utility (CV land)

Module types: `lfo`, `adsr`, `buggles`, `illogic`,
`unityscalemathematik`, `timelorde`.

Tests:
- lfo: spawn + assert all 4 phase outputs are `cv` and produce values
  in [-1, 1] with non-zero variance after wiring to a downstream
  `lfo.shape` (engine path).
- adsr: gate ping -> env rises then falls; env_inv is `1 - env`.
- buggles: chaotic CV; non-zero variance, non-constant.
- illogic: 4 cv inputs -> 10 outputs (att1..4 + sum + diff + and +
  nand + or + not). Test the logic outputs (and/nand/or/not) gate on
  inputs above threshold.
- unityscalemathematik: feed +0.5 into u_in, read u_out; cv-shape
  invariant (linear vs expo).
- timelorde: feed a clock from sequencer -> verify all 12 outputs
  emit (gate type), at the expected divisions (e.g. 4x fires 4 times
  per 1x).

Integration: `lfo -> filter.cutoff_cv` modulates an `analogVco -> filter
-> scope` chain audibly (cutoff sweep visible in peak vs over time).

PR: `test(e2e): modulation + utility module coverage`.

### Group 4 — Sequencers + transport

Module types: `sequencer`, `polyseqz`, `drumseqz`, `score`, `cartesian`.

Tests:
- Each sequencer: spawn + isPlaying=1 + lay down 4 known steps + read
  `currentStep` (or `currentNoteId` for score) advances over time.
- Each sequencer: pitch/gate outputs emit values that step through
  the configured pattern (verify with engine reads of scope ch1 fed
  from `seq.pitch` via a small vco).
- cartesian: feeds an LFO clock, verifies pitch/gate outputs as the
  pad CV moves through the four corners.
- Cross-cutting transport: queue1/2/3/4 CV inputs trigger pattern jumps
  on each transport-aware sequencer. (Existing `sequencer-clock.spec.ts`
  covers external clock; we don't duplicate it here.)

Integration: `sequencer -> drummergirl + meowbox + qbrt` — confirms
the gate->voice -> audioOut chain for 3 drum voices in parallel.

PR: `test(e2e): sequencer module + transport CV coverage`.

### Group 5 — VCAs + filters + simple effects

Module types: `vca`, `stereovca`, `filter`, `mixer`, `mixmstrs`.

Tests:
- vca: cv=0 silences audio, cv=1 passes through; audio_inv is
  phase-flipped (sum of audio + audio_inv ~= 0).
- stereovca: independent L/R strength CV; ring-mod mode (covered by
  existing ART, but a quick e2e smoke is cheap).
- filter: cutoff at 200 Hz attenuates a 4 kHz sine more than cutoff
  at 4 kHz does (peak comparison).
- mixer: each input contributes to the sum.
- mixmstrs: 4-channel + 2 sends; each channel's mute kills its
  contribution; the master fader scales output peak.

Integration: voice-chain.spec.ts already covers this group's core
patch; we extend to a stereo case (analogVco + analogVco -> stereovca
-> audioOut produces stereo separation).

PR: `test(e2e): VCA + filter + mixer module coverage`.

### Group 6 — Time-based effects (delay + reverb + shimmer)

Module types: `reverb`, `charlottesEchos`, `shimmershine`, `qbrt`,
`warrenspectrum`.

Tests:
- reverb: pulse in -> tail decays over time.
- charlottesEchos: delay-time CV changes echo period.
- shimmershine: stereo decay tail; shimmer band has high-freq energy
  octave above input fundamental.
- qbrt: comb-filter resonance; ping input -> tone at the cutoff
  frequency.
- warrenspectrum: 8-band level CV scales each band's contribution to
  out_l/out_r; viz_out emits a mono-video frame.

Integration: dry voice -> reverb + shimmer parallel sends -> mixer
-> audioOut produces a wider/longer tail than dry alone.

PR: `test(e2e): time-based-effect module coverage`.

### Group 7 — Drum voices

Module types: `drummergirl`, `meowbox`, `riotgirls`.

Tests:
- drummergirl: gate ping -> short audio burst, pitch CV shifts
  fundamental, decay CV changes envelope length.
- meowbox: gate -> stereo audio out, morph CV shifts timbre, decay
  changes length.
- riotgirls: per-voice trigger via `window.__riotgirlsTriggerVoice`
  (the test hook already exists); each of the N voices emits its
  signature on the master out.

Integration: `drumseqz -> {drummergirl, meowbox, riotgirls.gate}`
produces a polyrhythmic groove (peak activity on every step).

PR: `test(e2e): drum-voice module coverage`.

### Group 8 — Video sources + effects

Module types (video domain): `lines`, `inwards`, `shapes`,
`picturebox`, `cameraInput`, `feedback`, `vdelay`, `destructor`,
`chroma`, `luma`, `colorizer`, `videoMixer`, `monoglitch`, `ruttetra`,
`shapedramps`, `videoOut`.

Tests:
- Each video module: spawn + (where applicable) wire a source ->
  destination + verify the videoOut canvas has a non-uniform pixel
  buffer.
- shapedramps + ruttetra: the mono-video outputs work as coordinate
  fields (ramp from -1..+1 across the frame).
- vdelay: input change is delayed by the configured time before
  appearing at output (delta-detection between consecutive frames).
- feedback: feedback amount > 0 produces recursive frame state
  (frame N+1 differs from frame N).

Integration: `shapes -> destructor -> chroma -> videoOut` (a chain of
4 video modules) produces a non-uniform output frame.

PR: `test(e2e): video module coverage`.

### Group 9 — Cross-domain (audio <-> video)

Audio-domain modules with `mono-video` outputs: `scope`, `vizvco`,
`wavviz`, `swolevco`, `wavecel`, `warrenspectrum`. These emit video
frames that downstream video modules accept.

Tests:
- audio scope reads mono-video from `shapedramps.h_lin` (cross-domain
  in the other direction — a video coordinate field feeding an audio
  scope's CV input).
- `vizvco.scope_out` -> `videoOut.in` renders the waveform as video.
- `lfo.phase0` (cv) -> `lines.amp` (video-module cv input) modulates
  the lines pattern over time (CV crosses the domain boundary at
  edge construction time — already supported by the reconciler).

Integration: a sequencer drives an audio VCO; the VCO's scope_out
visualizes the waveform in a videoOut; the same sequencer's `clock`
output also drives a `timelorde` whose `1x` output gates a `feedback`
video effect's `decay` parameter, producing a rhythmic visual.

PR: `test(e2e): cross-domain audio<->video module coverage`.

## Test scope: local vs autotest

All of these tests run against the local SvelteKit dev server in CI
(the standard `task e2e` target), same as the existing per-module
tests. We do **not** add deploy-target tests here. The autotest live
checks (covered separately by `aut-*.spec.ts`) already validate the
deployed bundle.

## Stopping criteria

Per the runbook:
- Every module in the catalog has spawn + I/O-contract coverage.
- Every group has >=1 integration test.
- Cross-domain has >=1 integration test.
- All PRs merged, main green, autotest+dev deploys green on latest.

## Open questions

- **Audio capture latency**: the AudioContext sample rate may differ
  in CI vs local (44.1 vs 48 kHz). Tests that compare absolute timing
  must use ratios, not absolute sample counts. Helper functions will
  honor `snap.sampleRate` from the scope read.
- **Video-frame capture**: VRT already grabs canvas pixels; we'll
  reuse that path rather than re-implementing.
- **Deferred**: `livecode` module is mid-PR (#81) — skip from this
  pass; will be folded in once it lands on main.
