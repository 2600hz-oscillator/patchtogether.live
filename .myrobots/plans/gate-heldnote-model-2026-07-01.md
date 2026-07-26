# A coherent GATE / HELD-NOTE model for patchtogether.live

Date: 2026-07-01
Status: PLAN (design + phased implementation). No code changed here.
Author perspective: CV-instrument correctness first. We are not a MIDI instrument.

---

## 0. TL;DR

We are a browser-native modular **CV** synth. A note is a `(pitch CV, gate)`
pair on the unified `gate` cable. The gate carries **note-on/off timing only**;
its **length** is how long it stays HIGH; the **downstream** module's ADSR/VCA
shapes amplitude. We never bake an envelope into the gate.

Today the model is *mostly* right but has a real, shipping bug and several
inconsistencies:

- **Bug #1 (highest priority, real):** a clipplayer tied/held note keeps its
  MONO `gate` HIGH across its span, but on the **poly** output the held note's
  gate is clobbered to 0 on the very next step → the note releases **one step
  early** on `dx7`/`cube`/`wavecel`/`pentemelodica`/`polyhelm`. The module's two
  gate outputs disagree. Verified below at exact file:line.
- The **poly "middle way"** (stable per-voice allocation + per-note gate-off +
  legato/mono/poly modes) is not yet expressible: the poly senders **repack**
  voices on every edge and there is only **one shared** gate-off per chord.
- Pulse-width constants are **scattered** and gate-length ceilings are
  **inconsistent** (0.95 vs 1.0 vs span-0.002).
- The `edge: 'trigger' | 'gate'` port semantic is **declared but not enforced**
  and only consumed by docs; the ▷/▭ glyph is hand-authored per card.
- Step sequencers **cannot express a note longer than one step**.
- DSP poly consumers sample the gate at **block rate** (edges finer than
  ~2.7 ms are lost).

The plan fixes the bug first (with a regression test that proves a held/tied
note keeps the POLY gate HIGH across its span into a real poly synth), then
lands the poly middle-way, then unifies constants, then enforces `edge`, and
defers the step-seq length model.

---

## 1. Verified findings (re-checked against the code)

All paths are absolute-from-repo-root. `$lib` = `packages/web/src/lib`.
`$dsp` = `packages/dsp/src`.

### 1.1 The source-of-truth util
`packages/web/src/lib/audio/gate-trigger.ts`
- `GATE_HI = 0.5` (L24), `GATE_LO = 0.5` (L31, single-threshold today).
- `TRIGGER_PULSE_S = 0.005` (L35), `DEFAULT_GATE_LEN_S = 0.05` (L40).
- `EdgeSemantic = 'trigger' | 'gate'` (L47).
- `fireTrigger` (L53, emits a triangle or square pulse of `widthSec` on a
  `ConstantSource.offset`), `openGate` (L72, `setValueAtTime(1)`), `closeGate`
  (L77, `setValueAtTime(0)`). These schedule **clean square edges** — no ramps
  through 0.5. This is the invariant the whole model rests on.

### 1.2 Main-thread windowed edge detector
`packages/web/src/lib/audio/edge-detect.ts`
- `createEdgeCounter` (L51): taps an `AnalyserNode`, `poll(now)` returns rising
  edges since the last poll, windowed to `elapsed * sampleRate` new samples
  (L59-71) so an overlapping ring-buffer rescan cannot double-count. This is the
  correct main-thread building block; `clipplayer` uses it for `stop_all`.

### 1.3 The poly cable
`packages/web/src/lib/audio/poly.ts`
- `POLY_CHANNEL_PAIRS = 5` (L30); 10-channel `(p0,g0,...,p4,g4)` layout.
- **`scheduleStep` ALWAYS writes every lane's gate** (L198-206): for each of the
  5 lanes it does `v.gateSrc.offset.setValueAtTime(lane.gate, at)` (L202), and
  when `lane.gate === 1 && gateOffSec > 0` also schedules the close at
  `at + gateOffSec` (L203-205). `lanes[i] ?? {pitch:0, gate:0}` (L200) means a
  **missing lane is written as gate=0**. `opts.writePitch` (L197) already lets a
  caller skip the *pitch* write (S&H hold) — but there is **no** equivalent for
  the *gate*.
- `poly → mono gate` = **OR-sum** of the 5 gate channels via a discrete merger
  (`resolveConnection`, L351-364; each lane 0/1, sum ∈ [0,5], thresholded 0.5).
- `silence(now)` (L209) cancels + zeroes every lane gate.

### 1.4 THE BUG — clipplayer held/tied note releases early on the poly bus
`packages/web/src/lib/audio/modules/clipplayer.ts` `emitLaneStep` (L395-448):
- `r = lanesForStep(clip, idx)` (L410). For a held/tied note `r.gateSteps > 1`;
  the intended gate-off is `gateOff = span - 0.002` where `span = r.gateSteps *
  stepDur` (L416-418). A single-step note uses `span * gateFrac`.
- The **MONO** gate is written **only inside `if (r.any)`** (L434-447): on a
  rest step (the else branch, L441-447) it sets `ln.lastGate = 0` for display
  but **never touches `ln.gateSrc`** — so across a held note's rest-steps the
  mono gate is left HIGH until its scheduled close at start+span. Correct.
- The **POLY** gate is written **unconditionally**: `ln.poly.scheduleStep(
  atTime, voiced, gateOff, { writePitch })` is called on **every** step (L431),
  including the held note's rest steps. On a rest step `lanesForStep` returns an
  empty `lanes` array (no note *starts* there), so `scheduleStep` writes gate=0
  to every lane at that rest step's time (poly.ts L200-202). Because the rest
  step's time (`start + stepDur`) is **earlier** than the held note's scheduled
  close (`start + span - 0.002`, span ≥ 2 steps), the poly gate falls after ONE
  step. **The two outputs disagree.**
- Net: `clipplayer.pitchN` (polyPitchGate) into `dx7`/`cube`/`wavecel`/
  `pentemelodica`/`polyhelm` releases a tied note one step early; the same
  clip's `gateN` (mono) sustains correctly. Consumers listed at L15/L105-120.

Root cause is a single asymmetry: the mono gate is guarded by `if (r.any)`;
the poly gate write is not.

### 1.5 Poly "middle way" gaps
- **Positional packing, not allocation.** `clip-types.ts lanesForStep`
  (L330-343) packs the notes that *start* on a step into lanes 0..n-1 and
  returns **one shared `gateSteps` = the longest starting note** (L339-342). A
  chord whose notes have different lengths therefore shares a single gate-off —
  they cannot each release at their own time. And a note that starts on a *later*
  step while an earlier note is still held is invisible to this function (it only
  looks at `notesStartingAt`).
- **Live-keyboard (KEYS) repack.** `clipplayer.ts serviceAudition` (L459-504)
  keeps held MIDI notes in a plain array `ln.audHeld`; note-off `splice`s it
  (L473); every drain rebuilds the voicing positionally `ln.audHeld[i]`
  (L489-497) and rewrites each lane's pitch. Releasing a low note **shifts the
  others down a lane**, rewriting pitch on a still-sounding voice → glitch /
  retrigger. It also cancels + repaints all voices at `now` on every edge
  (L483-497).
- **Same repack in MIDI LANE / MIDI-CV-BUDDY.** `midi-lane.ts buildPolyLanes`
  (L167-183) takes `heldKeysInPressOrder.slice(-MAX_POLY_VOICES)` and writes
  each voice from the recent stack — so a release reshuffles voices and rewrites
  pitch. `applyPoly` (L439-442) repaints from that every event. `MAX_POLY_VOICES
  = 5` (L160). Steal is "keep newest 5" (steal-oldest), not LRU.
- **The DSP side is already lane-stable.** `polyhelm.ts` (L143-166) and `dx7.ts`
  (L486-496) do per-lane edge detection keyed on lane index and hold the note's
  stored pitch through the release tail; `polyhelm.ts` L160-162 even tracks live
  pitch while the gate stays high (glide, no retrigger). So **the fix is
  entirely main-thread**: if a sender keeps a note on the SAME lane for its life
  and only edges that lane's gate, the DSP consumers already do the right thing.

### 1.6 Legato vs retrigger already exists in fragments
- `midi-lane.ts` mono mode with `retrig` dips the mono gate for ~3 ms so a
  downstream ADSR re-fires (L516-527); `mode: 'mono' | 'poly'` governs only the
  MONO outputs (L187, L514-539, header L40-53). There is no `legato` mode.
- `polyhelm.ts` L160-162: gate-held → pitch glide, **no re-attack** = legato at
  the DSP layer. So legato/retrigger is purely a **main-thread scheduling
  policy**: legato = change a held lane's pitch without dipping its gate;
  retrigger = dip (or fall+rise) the gate. Both keep clean 0/1 edges.

### 1.7 Scattered pulse constants + inconsistent ceilings
`gate-trigger.ts` claims to be the single source of truth (header L3-6), but:
- Local re-declarations of the same numbers: `midi-lane.ts NOTE_GATE_PULSE_S =
  0.006` (L240); `pong.ts`/`frogger.ts`/`midiclock.ts`/`modtris.ts GATE_PULSE_S
  = 0.005`; `skifree.ts SKIFREE_GATE_PULSE_S = 0.01`; video modules
  `GATE_PULSE_S`/`EVT_PULSE_S = 0.01` (`gibribbon`, `nibbles`, `qbert`, `doom`,
  `snes9x`); `slewswitch.ts EOC_PULSE_S = 0.005`.
- The DSP package **cannot import `$lib`**, so `$dsp/lib/gatemaiden-dsp.ts` (L32)
  and `$dsp/lib/featurecv-dsp.ts` (L80) *re-declare* `TRIGGER_PULSE_S = 0.005`
  with a comment saying they mirror the web constant. This is a real constraint
  (GPL/package firewall) — a shared source must live where both can import it.
- Gate-length ceilings disagree: `sequencer.ts`/`polyseqz.ts`/`drumseqz.ts`
  `gateLength` is `min 0.1, max 0.95` (L182 / L183 / L228) and "always closes
  just before the next step"; `clipplayer.ts gateLength` is `min 0.1, max 1.0`
  (L83) applied as `span * gateFrac` (can reach the full step, bumping the next
  onset); held notes use `span - 0.002` (L418). Three different rules.

### 1.8 `edge` semantic declared but unenforced; glyph unimplemented
- `graph/types.ts PortDef.edge` (L257-276): explicitly "does NOT restrict
  connections"; the unified gate cable stays cross-patchable. Its only reader is
  `$lib/docs/io-explain.ts explainEdge` (L105, called L135/L173) — **docs
  prose**. `canConnect` (types.ts L96-134) and the engine's `addEdge` do **not**
  branch on it.
- Sparse adoption: ~11 modules declare it (`dx7` L82, `timelorde` L121,
  `gatemaiden` L33/36/37, `kria` L66-67, `ninelives` L47, `featurecv` L71,
  plus video `tv-librarian`/`peertube`/`archivist`/`milkdrop`/`camera-input`).
  Most gate ports carry no `edge`.
- ▷/▭ glyph: only **hand-authored labels** in `GatemaidenCard.svelte` (L41-42)
  and `TimelordeCard.svelte` (L483). No generic port renderer reads
  `PortDef.edge`.

### 1.9 Step sequencers cannot express held/tied notes
`sequencer.ts` emits `chordVoicing` per step with `gateOff = stepDurForGate *
gateLengthFrac` (L438) into both the mono gate (L474-475) and
`polyPitch.scheduleStep` (L449). `polyseqz.ts` (L423/462/477) and `drumseqz.ts`
(L455) are the same duty-cycle-within-the-step model. None has a per-step
`length`/tie/legato concept, so a note can never exceed one step.

### 1.10 Block-rate gate sampling in DSP consumers
`polyhelm.ts` reads `gateCh?.[0]` (first sample of the block) and decides at
block rate (L143-166, comment L138-142). `dx7.ts` L487/495-496 and `cube.ts`
L615-616 do the same. A 128-sample block is ~2.67 ms @ 48 kHz, so a gate that
opens and closes within one block is lost. For the current `setValueAtTime`
senders (edges land on block boundaries) this is exact; it only bites for
sub-block gates (fast trigger conversion).

---

## 2. THE STATED MODEL (the contract we are committing to)

1. **A note = `(pitch CV, gate)`.** The gate carries note-on/off **timing
   only**. Note duration = the time the gate is HIGH. Nothing about amplitude
   shape is encoded in the gate.
2. **The downstream module shapes the sound.** Whatever the gate is patched to
   (`dx7`/`cube`/`polyhelm` per-voice ADSR, an `adsr`→`vca`, a raw VCA hold)
   owns attack/decay/sustain/release. We respect its envelope settings.
3. **The gate is shape-agnostic and edge-clean.** It is a 0/1 square. We only
   ever emit clean crossings of `GATE_HI = 0.5` via `setValueAtTime`
   (`openGate`/`closeGate`/`fireTrigger`). We never smooth or ramp the gate CV
   through the threshold (no `setTargetAtTime`/`linearRamp` across 0.5, except
   the deliberate short strike shape inside `fireTrigger`, which crosses cleanly
   once).
4. **The only levers are gate length + whether/when the gate re-edges:**
   - **staccato** — short gate within the step (duty cycle < 1).
   - **legato / tie** — the gate stays HIGH across a span; pitch may change
     under a held gate with **no** falling edge → the downstream envelope does
     NOT re-attack (DSP glides, per polyhelm L160-162).
   - **retrigger / mono** — a falling+rising edge (or a brief dip) forces the
     downstream envelope to re-attack.
   - **tie-through-slide (303 style)** — a legato pitch change while the gate
     stays high (a legato with a pitch glide; distinct from retrigger).
5. **Everything stays CV.** No mode converts a gate consumer to edge-only, and
   no path bakes an amplitude envelope into the gate. `trigger` vs `gate` is a
   consumer *interpretation* of the same cable (gate-trigger.ts header L8-19),
   made explicit by `PortDef.edge`, never a routing restriction.

---

## 3. THE POLY MIDDLE-WAY SPEC

Goal: keep CV honesty while giving polyphonic modules musical voice behavior.
Three orthogonal pieces, all main-thread (the DSP consumers already cooperate).

### 3.1 Per-lane gates (each voice releases at its own time)
- A chord whose notes have different lengths must schedule an **independent
  gate-off per lane**, not one shared `gateSteps`.
- `scheduleStep` already supports a per-lane gate + a single `gateOffSec`; extend
  the data path so each lane carries its **own** off time (see Phase 2).
- Invariant: each lane's gate is still a clean 0/1 square with an explicit close.

### 3.2 Stable LRU voice allocator (a note keeps its lane for its life)
- Introduce a pure, testable **main-thread allocator** (new `$lib/audio/
  poly-alloc.ts`) with the vocabulary the research converged on:
  - **LRU-steal** (default, musical): on overflow past `POLY_CHANNEL_PAIRS`,
    steal the least-recently-used *sounding* voice.
  - **round-robin / cyclic**, **unison**, **sorted** as selectable strategies
    (start with LRU-steal + round-robin; unison/sorted later).
- Contract:
  - A note-on is assigned a **free** lane; it keeps that lane until its own
    note-off. A note-off frees only that lane; **no other lane is rewritten**
    (fixes the serviceAudition/buildPolyLanes repack glitch).
  - On overflow the stolen lane gets a clean fall+rise (retrigger of the stolen
    voice at the new note's pitch) — never a silent pitch swap under a held gate.
  - Dedupe by **note identity** (touch/lane), not by pitch (LinnStrument
    lesson), so two of the same pitch can coexist and pressure stays separate.
- Because it is pure (held-set in → per-lane {pitch, gate, gateOff, edge-action}
  out), it is unit-testable with zero engine and reused by BOTH the clipplayer
  audition path and MIDI LANE / MIDI-CV-BUDDY.

### 3.3 Legato / mono / poly as an explicit mode (per-lane or KEYS-global)
- **poly** — each note its own lane + its own gate (3.1 + 3.2).
- **legato** — steal/hold a single voice: the gate **stays HIGH**, pitch glides,
  **no re-attack** (Deluge legato; polyhelm L160-162 already does this when the
  gate never falls). Mode = "do not dip the gate on a new note while one is
  held; just move the pitch."
- **mono** — collapse to one voice **and retrigger**: dip/fall+rise the gate so
  the envelope re-fires (midi-lane L516-527 is the existing shape).
- This mode lives on the SENDER (clipplayer lane / MIDI LANE), expressed purely
  as *when we edge the gate*. It never changes the cable or the consumer.

Invariants for all of 3.1-3.3: stay CV, emit clean 0/1 edges only, never bake an
envelope, never convert a consumer to edge-only, never smooth the gate.

---

## 4. PHASED IMPLEMENTATION PLAN

Each phase: scope, files, the proving test, and the CV invariants it must not
violate. Phases are independently shippable in order.

### PHASE 1 — Fix the real bug: held/tied note keeps the POLY gate HIGH
Scope: the smallest change that makes clipplayer's poly gate agree with its mono
gate for the tie/legato gesture (the common "hold a pad + tap another" case and
recorded held notes). Does **not** yet handle notes that overlap by starting on
different steps (that is Phase 2).

Fix shape (design, not code):
- Add an optional `writeGate?: boolean` (default `true`) to `poly.ts
  scheduleStep`, mirroring the existing `writePitch`. When `false`, do not write
  or close any lane gate this call (pitch may still be written per `writePitch`).
- In `clipplayer.ts emitLaneStep`, pass `writeGate: r.any` — i.e. only write the
  poly gate on a step where a note actually starts, exactly mirroring the mono
  gate's `if (r.any)` guard (L434-447). On a rest step the poly gate is left
  untouched, so a held note's gate-off (scheduled at start+span-0.002 on its
  start step) is the ONLY close, and the held note sustains across its span.
- `sequencer.ts` / `polyseqz.ts` callers keep the default (`writeGate: true`) →
  byte-identical behavior (they always gate within the step).

Files touched: `packages/web/src/lib/audio/poly.ts`,
`packages/web/src/lib/audio/modules/clipplayer.ts`.
(Read-only-verified callers to leave unchanged: `sequencer.ts` L449,
`polyseqz.ts` L462/477, `midi-lane.ts` L441 — they pass gates every call by
design.)

Proving test (this is the acceptance gate for the whole plan):
- **Unit (fast, deterministic)** — extend
  `packages/web/src/lib/audio/modules/clipplayer.test.ts` (its fake
  `AudioContext` records every `setValueAtTime` in `FakeParam.events`). Build an
  8-step clip with a tied note `lengthSteps = 4` at step 0, launch the lane,
  advance the mocked scheduler across steps 0..4, then assert on
  `lanes[0].poly.voices[0].gateSrc.offset.events`: value `1` at `t0`, and the
  next value `0` at `≈ t0 + 4*stepDur` (span), NOT at `t0 + stepDur`. Assert the
  MONO `gateSrc.offset` close time EQUALS the poly lane close time (the two
  outputs agree). Add the symmetric single-step (staccato) case to prove no
  regression.
- **Audible e2e** — mirror `e2e/tests/polyhelm-poly-chain.spec.ts`
  (`spawnPatch` + `readScopePeakOverWindow`): CLIP PLAYER (a clip with one tied
  note across N steps) → POLYHELM (or DX7) → SCOPE. Assert the SCOPE RMS stays
  up across the whole span and only falls after it — proving the fix into a
  **real poly synth worklet**, not just the sender's scheduled params.

Invariants: only clean 0/1 gate edges via `setValueAtTime`; the held gate has a
single explicit close (no "held forever" without a scheduled fall); do not touch
the S&H pitch semantics; do not change the mono gate.

### PHASE 2 — Stable LRU allocator + per-lane gate-off
Scope: introduce the pure allocator (3.2) and per-lane gate-off (3.1); route the
clipplayer audition path and MIDI LANE / MIDI-CV-BUDDY through it; make overlap
(notes starting on different steps while others still sound) correct.

Design:
- New pure module `packages/web/src/lib/audio/poly-alloc.ts`: an allocator that
  maps a set of active note identities → stable lane assignments with LRU-steal,
  emitting per-lane actions {assign pitch, open, hold, close-at, retrigger}.
  Unit-tested with no engine (like `poly-osc-sum.test.ts`).
- Extend `scheduleStep` (or add `scheduleLanes`) so each lane carries its own
  `gateOffSec` (per-note release), replacing the single shared `gateOff`.
- `clip-types.ts`: add a resolver that, for a given step, returns the set of
  notes **sounding** (covering the step), not just starting — feeding the
  allocator so a note that starts mid-chord takes a free lane and independent
  releases work. Keep `lanesForStep` for back-compat or refactor its callers.
- Replace `serviceAudition`'s positional rebuild (clipplayer L489-497) and
  `midi-lane.ts buildPolyLanes` (L167-183) with allocator calls.

Files: new `poly-alloc.ts`; `poly.ts`; `clip-types.ts`;
`clipplayer.ts` (serviceAudition + emitLaneStep); `midi-lane.ts`;
`midi-cv-buddy.ts`.

Proving test:
- `poly-alloc.test.ts`: releasing a low note leaves the other lanes' pitch and
  gate untouched (no repack); overflow steals the LRU lane with a clean
  fall+rise; dedupe is by identity not pitch.
- Extend `clipplayer.test.ts`: a chord with notes of lengths {1,2,4} produces
  three independent gate-off times on three stable lanes.
- e2e: hold a 3-note chord on the KEYS keyboard into POLYHELM, release the
  bottom note; assert the top two voices do not re-attack (RMS continuity / no
  new onset), while the released voice falls.

Invariants: a note never changes lane while sounding; a freed lane's gate falls
cleanly; a stolen voice retriggers via real edges (never a silent pitch swap
under a held gate); still CV, no baked envelope.

### PHASE 3 — Legato / mono / poly mode (explicit)
Scope: expose the three modes (3.3) on the senders, implemented purely as
gate-edging policy.

Design:
- Add a `voiceMode: 'poly' | 'legato' | 'mono'` control. In clipplayer this can
  extend the existing per-lane mono/poly toggle (`clipplayer-mono` family,
  `laneMono` clip-types L215); in MIDI LANE it extends `LaneMode` (L187) with
  `legato`.
- legato: when a new note arrives while one is held, keep the (single) lane's
  gate HIGH and move its pitch — no dip. mono: dip/fall+rise the gate (reuse the
  midi-lane retrigger shape L516-527). poly: Phase 2 allocator.

Files: `clipplayer.ts`, `clip-types.ts` (data/flag), the clipplayer card,
`midi-lane.ts`, `midi-cv-buddy.ts`, their cards.

Proving test:
- Unit: in legato, a second overlapping note produces NO gate falling edge
  (only a pitch change) on the sender's captured events; in mono, it produces a
  fall+rise; in poly, a second lane opens.
- e2e: legato clip into DX7 shows a single sustained envelope with a pitch
  change (no re-attack); mono shows a re-attack.

Invariants: modes only change WHEN we edge the gate; clean edges only; never
edge-only; never bake an envelope.

### PHASE 4 — Unify pulse-width constants + gate-length ceilings
Scope: make `gate-trigger.ts` genuinely the source of truth and pick one gate
ceiling rule.

Design:
- Because `$dsp` cannot import `$lib`, put the shared numeric constants in a
  package both can import (a tiny `$dsp` primitive re-exported by
  `gate-trigger.ts`, or a shared `packages/*/constants`), then delete the local
  re-declarations (`midi-lane NOTE_GATE_PULSE_S`, the per-module `GATE_PULSE_S`/
  `EVT_PULSE_S`, `SKIFREE_GATE_PULSE_S`, and the dsp mirror copies in
  `gatemaiden-dsp.ts`/`featurecv-dsp.ts`).
- Decide ONE gate-length ceiling. Recommendation: keep the sequencer family's
  "always closes just before the next step" (never overlap the next onset) as
  the canonical duty-cycle rule, and align clipplayer's `gateLength` max from
  1.0 to that rule (or document 1.0 as "legato-to-the-edge, minus epsilon").
  Held/tied notes keep the `span - epsilon` rule; make the epsilon a named
  constant.

Files: `gate-trigger.ts` (+ the shared-constant home); `midi-lane.ts`,
`skifree.ts`, `pong.ts`, `frogger.ts`, `midiclock.ts`, `modtris.ts`,
`gibribbon.ts`, `nibbles.ts`, `qbert.ts`, `doom.ts`, `snes9x.ts`,
`slewswitch.ts`; `sequencer.ts`/`polyseqz.ts`/`drumseqz.ts`/`clipplayer.ts`
(ceiling); dsp `gatemaiden-dsp.ts`/`featurecv-dsp.ts`.

Proving test: a unit test asserting every module imports the shared constant
(grep-guard, mirroring the existing docs `testidPrefix` guard pattern); a test
pinning the single ceiling rule (gate close < next onset for every step
sequencer + clipplayer non-legato).

Invariants: purely a refactor; no audible behavior change except the deliberate
ceiling reconciliation, which must still never overlap the next onset.

### PHASE 5 — Enforce + surface the `edge` semantic
Scope: turn the declared `edge` into something real and visible without
restricting connections.

Design:
- Add a generic ▷/▭ port glyph in the shared port renderer keyed on
  `PortDef.edge` (replacing the hand-authored labels in GatemaidenCard /
  TimelordeCard). Cosmetic only.
- A lint/unit guard: every `gate`-typed input consumed as a one-shot should
  declare `edge: 'trigger'` and go through `createEdgeCounter` (or a per-sample
  worklet detector); every sustain consumer declares `edge: 'gate'`. The guard
  greps the module set the same way the docs contract guard does. Do NOT change
  `canConnect` — the cable stays cross-patchable.
- Backfill `edge` on the gate ports that still lack it.

Files: the port-rendering component (`Canvas.svelte` / a Port component),
`graph/types.ts` (docs only), `io-explain.ts` (already consumes it), a new lint
test, and the modules being backfilled.

Proving test: a unit guard that fails if a `gate` input used as a trigger lacks
`edge: 'trigger'`; a VRT/DOM check that the glyph renders from `PortDef.edge`.

Invariants: `edge` never restricts a connection; never converts a gate consumer
to edge-only.

### PHASE 6 (OPTIONAL, LATER) — Step-seq length model + per-sample edge detect
Scope: give the step sequencers a `lengthSteps`/tie/legato concept (reusing the
clip model), and add a shared per-sample worklet edge detector for the DSP
consumers so sub-block gates aren't lost.
- Sequencer length model: extend `sequencer.ts`/`polyseqz.ts`/`drumseqz.ts`
  steps with a per-step length + tie, routed through the Phase 1/2 gate model.
- Per-sample edge detect: a shared DSP helper so `dx7`/`cube`/`polyhelm` can
  detect a gate edge anywhere in the block (matters only for very short
  externally-generated gates). Deferred because current senders edge on block
  boundaries.

Proving test: a sequencer tied note sustains across steps into a poly synth
(Phase-1-style); an offline DSP test that a sub-block gate produces exactly one
note-on.

---

## 5. Risks

- **Phase 1 minimal fix vs overlap.** Passing `writeGate: r.any` fixes the
  tie/rest case but does NOT fix two notes that overlap by starting on different
  steps in the same lane slot (positional packing in `lanesForStep`). That is
  explicitly Phase 2. Document the Phase 1 scope so it isn't mistaken for full
  poly overlap support.
- **S&H interaction.** `writeGate` must be independent of `writePitch`; on a
  rest with S&H OFF we still (legacy) rewrite pitch=0 while leaving the gate
  alone. Verify both S&H states in the Phase 1 test.
- **Allocator churn on peer sync.** clipplayer state is Yjs-synced; the
  allocator is per-engine-instance render state (not synced) — keep it that way
  or two peers will fight over lane assignments.
- **Ceiling change is behavioral.** Aligning clipplayer's 1.0 ceiling changes
  existing patches subtly; gate it behind the reconciliation test and call it
  out in the changelog.
- **DSP/web constant home.** The shared-constant move must respect the package
  firewall (`$dsp` can't import `$lib`); getting this wrong breaks the DSP
  build. Prefer a `$dsp` primitive re-exported by `gate-trigger.ts`.
- **Block-rate detach.** Do not "fix" block-rate sampling by ramping gates;
  that would violate the clean-edge invariant. The only correct fix is
  per-sample detection (Phase 6).

## 6. Explicitly OUT of scope

- MIDI polyphonic expression (MPE), per-note pressure/Z as a separate CV lane
  (research-noted but not built here).
- Voicing intelligence beyond LRU-steal / round-robin (unison/sorted are stubs
  for later; no auto-voice-leading).
- Any baked-in amplitude envelope, "note velocity → fixed VCA curve", or gate
  smoothing — forbidden by the model.
- Rewriting the DSP voice allocators (they already cooperate); Phase 2 is
  main-thread only.
- Changing `canConnect`/cable typing so gate stops cross-patching with cv/pitch.
- Full step-seq length model + per-sample worklet edge detector (Phase 6, only
  if prioritized).

## 7. Open questions for the owner

1. **Legato scope:** is `legato` a per-lane setting on clipplayer, a KEYS-global
   mode, or both? (Deluge is per-mode; MIDI LANE is per-lane.)
2. **Default steal strategy:** confirm LRU-steal as the musical default (vs the
   current "keep newest 5" in midi-lane and "reuse oldest" in clip editing).
3. **Gate-length ceiling:** adopt the sequencers' "always close before next
   onset" as the single rule and lower clipplayer's 1.0 to match, or keep 1.0 as
   an explicit "legato to the edge"? This changes existing clipplayer patches.
4. **Per-note gate-off granularity:** for a chord with mixed lengths, do we want
   each voice to release exactly at its own length (Phase 2), or is "whole chord
   uses the longest" acceptable for v1? (Owner framing suggests per-note.)
5. **303-style slide:** do we want an explicit tie-with-glide gesture distinct
   from legato (glide time control), or is legato-with-portamento enough?
6. **Should `edge` ever gate UI affordances** (e.g. auto-suggesting GATEMAIDEN
   when a trigger output meets a gate input), or stay purely cosmetic + lint?

---

## Appendix A — Critical files (with the load-bearing lines)

- `packages/web/src/lib/audio/poly.ts` — `scheduleStep` always writes the gate
  (L198-206); add `writeGate`; per-lane gate-off (Phase 2).
- `packages/web/src/lib/audio/modules/clipplayer.ts` — `emitLaneStep`
  poly/mono asymmetry (L431 vs L434-447); `serviceAudition` repack (L459-504).
- `packages/web/src/lib/audio/modules/clip-types.ts` — `lanesForStep` single
  shared `gateSteps` (L330-343); `NoteEvent.lengthSteps` (L74); `setNoteSpan`
  tie (L554-568).
- `packages/web/src/lib/audio/gate-trigger.ts` — the constants + emit helpers to
  unify against (L24-79).
- `packages/web/src/lib/audio/modules/midi-lane.ts` — `buildPolyLanes` repack
  (L167-183); `NOTE_GATE_PULSE_S` (L240); mono retrigger shape (L516-527).
- `packages/web/src/lib/graph/types.ts` — `PortDef.edge` declared, unenforced
  (L257-276).
- `packages/dsp/src/polyhelm.ts` / `packages/dsp/src/dx7.ts` — lane-stable,
  block-rate gate consumers (polyhelm L143-166; dx7 L486-496) proving the fix is
  main-thread.
- `packages/web/src/lib/audio/modules/clipplayer.test.ts` — the fake-AudioContext
  harness for the Phase 1 regression test; `e2e/tests/polyhelm-poly-chain.spec.ts`
  for the audible proof.

---

## ADVERSARIAL REVIEW + RESOLUTIONS (2026-07-01)

An independent skeptic re-verified every load-bearing claim against the source.
**Verdict: design is sound; NOT buildable exactly as written — three mechanical
gaps, none in the fix logic.**

CONFIRMED by the reviewer: Bug #1 is real + precisely diagnosed (poly gate falls
at `t0+stepDur`, before the intended close at `t0+span−0.002`; no existing guard —
audition early-return, S&H `writePitch`, active/kind checks — mitigates it, fires
S&H on **or** off). The Phase-1 `writeGate` fix is correct AND sufficient for its
scope (all paths traced: rest/staccato/leading-rest/launch-stop/audition/back-compat).
CV invariants intact in every phase (Phase 1 only *removes* a redundant
`setValueAtTime(0)`; no ramps, no baked envelope, no edge-double-count). All **five**
DSP consumers (polyhelm/dx7/cube/wavecel/pentemelodica) are lane-stable + hold/glide
pitch under a held gate → the fix is genuinely main-thread.

Three required changes before Phase 1 starts:

1. **The headline Phase-1 unit assertion is NOT constructible as written** (blocker).
   The plan asserts on `lanes[0].poly.voices[0].gateSrc.offset.events`, but that is
   unreachable through the test handle — `FakeConstantSource.connect()` is a no-op
   (clipplayer.test.ts:51), the only exposed poly handle is the ChannelMerger, and
   `read('gateValue:L')` returns the **mono** display mirror (`ln.lastGate`), not a
   poly-lane param. `poly.test.ts` has no fake AudioContext. **RESOLUTION — pick one
   (recommend a):** (a) add a debug read-key `gateValue:poly:<lane>` on the handle
   mirroring the existing `gateValue:L`, assert its event schedule equals the mono
   gate's across the span; (b) `vi.mock('$lib/audio/poly')` spy capturing each
   sender's `.voices`; (c) move the primitive equality assertion into a new fake-ctx
   `poly.test.ts` and keep clipplayer's proof as the `polyhelm-poly-chain.spec.ts`
   e2e (which DOES exist + `readScopePeakOverWindow`/`spawnPatch` are available).

2. **Caller audit was inaccurate** (doesn't endanger Phase 1 — default-`true`
   protects all callers — but correct it now). Real `scheduleStep` callers:
   `cartesian.ts:387`, `numpad-plus.ts:519`, `sequencer.ts:449`,
   `clipplayer.ts:431`+`:497`, `midi-lane.ts:441`. **`polyseqz` is NOT a
   `scheduleStep` caller** — it writes `polyVoice.gateSrc.offset.setValueAtTime(...)`
   **directly** (polyseqz.ts:441-477). Knock-on: any Phase-2 per-lane-gate-off /
   Phase-4 ceiling work touching polyseqz must handle its direct-write path, not a
   `scheduleStep` signature change.

3. **Phase-2 allocator: add the release-after-steal contract.** "note-off frees only
   that lane" is underspecified. If A owns lane 2, overflow steals lane 2 for F, then
   A's note-off arrives — release must resolve by **note-identity → CURRENT owner**;
   A's stale note-off is a **no-op** on lane 2 (now F's), else it kills the stealer.
   Add this as an explicit `poly-alloc.test.ts` case. Also cover an **immediate
   (QNT-off / NOW) mid-tied-note clip switch** in the Phase-1 test — the old note's
   scheduled poly close is latent parity with the mono gate (not a new bug), pin it.

Minor: the TL;DR "releases one step early" undersells it — the gate falls *after*
one step, i.e. up to **gateSteps−1** steps early (a 4-step tie releases 3 early).

---

## OWNER DECISIONS (2026-07-01) — resolves the open questions

- **Phase 1 (the bug fix): APPROVED + shipped** as PR #990 (writeGate flag +
  poly/mono parity test + poly.ts primitive test; typecheck clean, 3× flake-checked).
  Test observability resolved via the harness merger-input tracking (a variant of
  resolution 1 — the poly-lane gate is now reachable in clipplayer.test.ts).
- **Default voice mode = LEGATO** (Phase 3). Overlapping notes on a lane keep the
  gate HIGH + glide the pitch, no envelope re-attack — the connected default.
- **Mode is PER-LANE** (not a single KEYS-global toggle) — each of the 8 lanes
  chooses poly / legato / mono independently.
- **Extend the length/tie model to the STEP SEQUENCERS = YES** (was a deferred
  optional phase; now in scope). `sequencer` / `polyseqz` / `drumseqz` gain a
  per-step note-length / tie so a note can span >1 step, feeding the same held-gate
  model. NB the adversarial review's caller-audit correction: `polyseqz` writes
  voice gates DIRECTLY (not via `scheduleStep`), so its tie work is a direct-write
  change, not a `scheduleStep` signature change.
