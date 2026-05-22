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

Lives in `e2e/tests/_module-coverage-helpers.ts`:

- `expectAudioFromOutput(page, sourceNodeId, outputPortId, opts)` —
  spawns a scope + audioOut on top of the existing patch, wires the
  source's output into scope.ch1, runs for ~500 ms, reads the
  scope's `snapshot` via `engine.read`, asserts non-silence + emits a
  peak/rms readout in the failure message.
- `readScopeSnapshot(page, scopeNodeId)` — convenience read for any
  scope already wired into a patch.
- `runFor(page, ms)` — Promise wrapper for `page.waitForTimeout`.

These get built lazily as PRs need them; we do **not** ship a "framework
PR" with no users.

## Logical groups + per-group PR plan

Sequenced from simplest (lowest blast radius, fastest to get green) to
most complex. Each group is one branch + one PR; admin-merged when CI
is green.

### Group 1 — Sinks + dev/utility (shakedown) — this PR

Module types: `audioOut`, `destroy`, `scope`, `sticky` (meta).

Tests:
- audioOut: wires `analogVco.sine -> audioOut.L`; verifies the audio
  graph builds without console errors. Master fader scale: a smaller
  master value reduces the destination's downstream gain (snapshot
  via a parallel scope tap).
- destroy: wires `analogVco.sine -> destroy.audio`; verifies bit-crush
  / decimate active state passes audio through (`destroy.audio`
  output is non-silent).
- scope: wires `analogVco.sine -> scope.ch1`; verifies
  `engine.read(node, 'snapshot')` returns a `Float32Array` (ch1) with
  non-silence + ch2 is silent (only ch1 wired); verifies `ch1_out`
  passthrough also carries audio.
- sticky: spawn + render check (meta, zero ports; covered by
  modules.spec.ts already — we still emit a "no-engine binding"
  invariant here so the meta domain has a dedicated test of its own).

### Group 2 — Sources (audio VCOs + noise)

Module types: `analogVco`, `wavetableVco`, `noise`, `dx7`,
`macrooscillator`, `wavviz`, `swolevco`.

Each: drive `pitch` (or `trig`+`pitch`) with a test pitch, read the
audio output(s) via scope, assert non-silence + verify the declared
output is audio-rate. Integration: sequencer drives each VCO type;
pitch steps audibly shift the frequency.

### Group 3 — Modulation + utility (CV land)

Module types: `lfo`, `adsr`, `buggles`, `illogic`,
`unityscalemathematik`, `timelorde`.

LFO outputs have non-zero variance and stay within [-1, 1]. ADSR
gate-ping produces an attack-then-decay envelope. Buggles outputs are
non-constant. illogic logic outputs gate correctly. Timelorde
divides an input clock. Integration: LFO modulates filter cutoff.

### Group 4 — Sequencers + transport

Module types: `sequencer`, `polyseqz`, `drumseqz`, `score`,
`cartesian`. Each: lay 4 steps, advance currentStep, verify pitch/gate
emit values stepping through the pattern. Transport CV (queue1..4)
triggers pattern jumps. Integration: sequencer drives 3 drum voices
in parallel.

### Group 5 — VCAs + filters + simple effects

Module types: `vca`, `stereovca`, `filter`, `mixer`, `mixmstrs`.
cv=0 silences vca; audio_inv is phase-flipped. filter cutoff at 200 Hz
attenuates a 4 kHz sine more than cutoff at 4 kHz. mixer sums; mixmstrs
per-channel mute + master fader.

### Group 6 — Time-based effects (delay + reverb + shimmer)

Module types: `reverb`, `charlottesEchos`, `shimmershine`, `qbrt`,
`warrenspectrum`. Tail-decay tests; resonant comb; viz_out emits.

### Group 7 — Drum voices

Module types: `drummergirl`, `meowbox`, `riotgirls`. Gate ping ->
audio burst.

### Group 8 — Video sources + effects

All 16 video modules. Each: spawn + verify the videoOut canvas has a
non-uniform pixel buffer when its source chain is wired up.

### Group 9 — Cross-domain (audio <-> video)

audio-domain modules with mono-video outputs (scope, wavviz, swolevco,
warrenspectrum) feed video sinks. LFO cv modulates video-module cv
inputs.

## Test scope: local vs autotest

All tests run against the local SvelteKit dev server in CI (the
standard `task e2e` target), same as the existing per-module tests.
The autotest live checks (covered separately by `aut-*.spec.ts`)
already validate the deployed bundle.

## Stopping criteria

Per the runbook:
- Every module in the catalog has spawn + I/O-contract coverage.
- Every group has >=1 integration test.
- Cross-domain has >=1 integration test.
- All PRs merged, main green, autotest+dev deploys green on latest.

## Status (auto-updated per PR)

- [x] Group 1 — sinks + utility (PR #154)
- [x] Group 2 — audio sources (PR #159)
- [x] Group 3 — modulation (PR #161, batched)
- [x] Group 4 — sequencers (PR #161, batched)
- [x] Group 5 — VCAs / filters / mixers (PR #161, batched)
- [x] Group 6 — time effects (this PR)
- [x] Group 7 — drum voices (this PR)
- [x] Group 8 — video (this PR)
- [x] Group 9 — cross-domain (this PR)

Groups 3+4+5 were batched and 6+7+8+9 batched here to reduce the
rebase storm we hit shipping single-group PRs (the repo's strict
required-checks policy means each main commit during our CI window
invalidates the pass, forcing rebase + re-run).

## Open questions / notes

- AudioContext sample rate may differ in CI vs local. Tests that
  compare absolute timing must use ratios, not absolute sample counts.
- Video-frame capture path reuses the existing VRT canvas-pixel hook.
- `livecode` module (mid-PR #81) — skip from this pass; will be
  folded in once it lands on main.
