# A coherent GATE / HELD-NOTE model for patchtogether.live

Date: 2026-07-01
Status: **PHASES 1 + 2a SHIPPED (#990, #991). 2b, 3, 4 and 6 are OPEN; 5 is PARTIALLY DONE.**
Author perspective: CV-instrument correctness first. We are not a MIDI instrument.

> **TRIAGE (re-verified 2026-08-12).**
> - **Phase 1** — the clipplayer tied/held note releasing early on the POLY bus —
>   **FIXED** by #990 (`writeGate` flag on `poly.ts scheduleStep`). The old §1.4
>   bug narration is deleted; do not read this file as describing a live bug.
> - **Phase 2a** — the stable LRU voice allocator — **SHIPPED** as #991;
>   `packages/web/src/lib/audio/poly-alloc.ts` exists.
> - **Phase 2b — per-lane gate-off: OPEN.** `poly.ts scheduleStep` still takes a
>   single `gateOffSec` for the whole call; there is no per-lane off-time plumbing.
> - **Phase 3 — explicit legato/mono/poly PER LANE: OPEN.** No `voiceMode` anywhere
>   in `clipplayer.ts`. (`poly.ts` `ChordQuality = 'mono' | 'maj' | 'min'` is chord
>   *shape*, not voice mode — do not mistake one for the other.)
> - **Phase 4 — unify pulse-width constants + gate-length ceilings: OPEN.**
> - **Phase 5 — PARTIALLY DONE.** The edge lint + backfill is **DONE** (see below);
>   the generic glyph is done on the REAR card and still hand-authored on the front.
> - **Phase 6 / §1.9 — step-sequencer length/tie: OPEN**, and the owner put it
>   explicitly IN scope. Zero `tie` / `lengthSteps` occurrences in `sequencer.ts`,
>   `polyseqz.ts`, `drumseqz.ts`.
>
> Context that moved underneath §1.5: the polyphony ceiling went 5 → **16**
> (#1086) — `POLY_CHANNEL_PAIRS = 16`, `MAX_POLY_VOICES = 16`. Every "5 voices"
> figure in the original text has been corrected.
>
> This file is cited from source — do not delete without fixing the citation.

---

## 1. Verified findings

`$lib` = `packages/web/src/lib`. `$dsp` = `packages/dsp/src`. Line numbers were
accurate at authoring; treat them as hints and grep the symbol.

### 1.1 The source-of-truth util — and the invariant everything rests on
`$lib/audio/gate-trigger.ts`
- `GATE_HI = 0.5`, `GATE_LO = 0.5` (single-threshold today).
- `TRIGGER_PULSE_S = 0.005`, `DEFAULT_GATE_LEN_S = 0.05`.
- `EdgeSemantic = 'trigger' | 'gate'`.
- `fireTrigger` (emits a triangle or square pulse of `widthSec` on a
  `ConstantSource.offset`), `openGate` (`setValueAtTime(1)`), `closeGate`
  (`setValueAtTime(0)`).

**These schedule clean square edges — no ramps through 0.5. This is the invariant
the whole model rests on**, and it is still true.

### 1.2 Main-thread windowed edge detector
`$lib/audio/edge-detect.ts` — `createEdgeCounter` taps an `AnalyserNode`;
`poll(now)` returns rising edges since the last poll, **windowed to
`elapsed * sampleRate` new samples** so an overlapping ring-buffer rescan cannot
double-count. This is the correct main-thread building block; `clipplayer` uses it
for `stop_all`.

### 1.3 The poly cable
`$lib/audio/poly.ts`
- `POLY_CHANNEL_PAIRS = 16` → a 32-channel `(p0,g0,…,p15,g15)` layout.
- `scheduleStep` writes every lane's gate unless `writeGate: false` (the #990 flag);
  `lanes[i] ?? {pitch:0, gate:0}` means a **missing lane is written as gate=0**.
  `opts.writePitch` skips the *pitch* write (S&H hold).
- **The gate-off is still ONE `gateOffSec` for the whole call** — that is Phase 2b.
- `poly → mono gate` = **OR-sum** of the gate channels via a discrete merger (each
  lane 0/1, thresholded 0.5).
- `silence(now)` cancels + zeroes every lane gate.

### 1.4 Poly "middle way" — what is still missing
- **Positional packing in the clip model.** `clip-types.ts lanesForStep` packs the
  notes that *start* on a step into lanes 0..n-1 and returns **one shared
  `gateSteps` = the longest starting note**. A chord whose notes have different
  lengths therefore shares a single gate-off — they cannot each release at their own
  time. And a note that starts on a *later* step while an earlier note is still held
  is invisible to this function (it only looks at `notesStartingAt`). **This is the
  data-shape reason Phase 2b is not just a signature change.**
- **THE DSP SIDE IS ALREADY LANE-STABLE — which is why every remaining fix is
  main-thread.** `polyhelm.ts` and `dx7.ts` do per-lane edge detection keyed on lane
  index and hold the note's stored pitch through the release tail; `polyhelm.ts`
  even tracks live pitch while the gate stays high (glide, no retrigger). All five
  poly consumers (polyhelm / dx7 / cube / wavecel / pentemelodica) behave this way.
  **If a sender keeps a note on the SAME lane for its life and only edges that
  lane's gate, the DSP consumers already do the right thing.**

### 1.5 Legato vs retrigger already exists in fragments
- `midi-lane.ts` mono mode with `retrig` dips the mono gate for ~3 ms so a
  downstream ADSR re-fires; `mode: 'mono' | 'poly'` governs only the MONO outputs.
  **There is no `legato` mode.**
- `polyhelm.ts`: gate-held → pitch glide, **no re-attack** = legato at the DSP layer.

So legato/retrigger is purely a **main-thread scheduling policy**: legato = change a
held lane's pitch without dipping its gate; retrigger = dip (or fall+rise) the gate.
Both keep clean 0/1 edges. **This is why Phase 3 is cheap in principle.**

### 1.6 Scattered pulse constants + inconsistent ceilings (Phase 4's evidence)
`gate-trigger.ts` claims to be the single source of truth, but as of 2026-08-12 the
same numbers are still re-declared locally:

| file | symbol | value |
|---|---|---|
| `$lib/video/modules/gibribbon.ts:87` | `GATE_PULSE_S` | 0.01 |
| `$lib/video/modules/nibbles.ts:79` | `GATE_PULSE_S` | 0.01 |
| `$lib/video/modules/doom.ts:724` | `EVT_PULSE_S` | 0.01 |
| `$lib/audio/modules/frogger.ts:68` | `GATE_PULSE_S` | 0.005 |
| `$lib/audio/modules/pong.ts:57` | `GATE_PULSE_S` | 0.005 |
| `$lib/audio/modules/skifree.ts:47` | `SKIFREE_GATE_PULSE_S` (exported) | 0.01 |
| `$lib/audio/modules/midiclock.ts:67` | `GATE_PULSE_S` (exported) | 0.005 |

plus `midi-lane.ts NOTE_GATE_PULSE_S = 0.006` and `slewswitch.ts EOC_PULSE_S`.
Grep before assuming this list is complete.

**The package firewall is a real constraint, not an oversight.** `$dsp` cannot
import `$lib`, so `$dsp/lib/gatemaiden-dsp.ts` and `$dsp/lib/featurecv-dsp.ts`
*re-declare* `TRIGGER_PULSE_S = 0.005` with a comment saying they mirror the web
constant. A shared source must live where both can import it — prefer a `$dsp`
primitive re-exported by `gate-trigger.ts`.

**Gate-length ceilings disagree three ways:** `sequencer.ts` / `polyseqz.ts` /
`drumseqz.ts` `gateLength` is `min 0.1, max 0.95` and "always closes just before the
next step"; `clipplayer.ts gateLength` is `min 0.1, max 1.0` applied as
`span * gateFrac` (can reach the full step, bumping the next onset); held notes use
`span - 0.002`. **There is no named epsilon constant for that 0.002.**

### 1.7 `edge` semantic — the lint is DONE, the front-card glyph is not
- `graph/types.ts PortDef.edge` explicitly "does NOT restrict connections"; the
  unified gate cable stays cross-patchable. `canConnect` and the engine's `addEdge`
  do **not** branch on it, by design.
- ✅ **The backfill + lint shipped 2026-08-09.** `module-docs-lint.test.ts:236`:
  *"The demand below is now UNCONDITIONAL: a gate-cable port with no `edge` is RED,
  full stop. There is no ledger, no exemption list"* — and deliberately no
  replacement counter.
- ✅ **The generic glyph exists on the REAR card**, driven off the port def:
  `ui/workflow/RearCard.svelte:292` renders `{hole.edge === 'trigger' ? '▲' : '▬'}`,
  fed by `rear-card-model.ts:189` (`edge: port.edge`).
- ❌ **The FRONT-card labels are still hand-authored** in `GatemaidenCard.svelte`
  and `TimelordeCard.svelte`. That is the remainder of Phase 5.

### 1.8 Step sequencers cannot express held/tied notes
`sequencer.ts` emits `chordVoicing` per step with `gateOff = stepDurForGate *
gateLengthFrac` into both the mono gate and `polyPitch.scheduleStep`. `polyseqz.ts`
and `drumseqz.ts` are the same duty-cycle-within-the-step model. **None has a
per-step `length`/tie/legato concept, so a note can never exceed one step.**

### 1.9 Block-rate gate sampling in DSP consumers — the reason Phase 6 exists
`polyhelm.ts` reads `gateCh?.[0]` (first sample of the block) and decides at block
rate; `dx7.ts` and `cube.ts` do the same. **A 128-sample block is ~2.67 ms @ 48 kHz,
so a gate that opens and closes within one block is LOST.** For the current
`setValueAtTime` senders (edges land on block boundaries) this is exact; it only
bites for sub-block gates (fast trigger conversion).

---

## 2. THE STATED MODEL (the contract we are committing to)

1. **A note = `(pitch CV, gate)`.** The gate carries note-on/off **timing only**.
   Note duration = the time the gate is HIGH. Nothing about amplitude shape is
   encoded in the gate.
2. **The downstream module shapes the sound.** Whatever the gate is patched to
   (`dx7`/`cube`/`polyhelm` per-voice ADSR, an `adsr`→`vca`, a raw VCA hold) owns
   attack/decay/sustain/release. We respect its envelope settings.
3. **The gate is shape-agnostic and edge-clean.** It is a 0/1 square. We only ever
   emit clean crossings of `GATE_HI = 0.5` via `setValueAtTime`. We never smooth or
   ramp the gate CV through the threshold (no `setTargetAtTime`/`linearRamp` across
   0.5, except the deliberate short strike shape inside `fireTrigger`, which crosses
   cleanly once).
4. **The only levers are gate length + whether/when the gate re-edges:**
   - **staccato** — short gate within the step (duty cycle < 1).
   - **legato / tie** — the gate stays HIGH across a span; pitch may change under a
     held gate with **no** falling edge → the downstream envelope does NOT re-attack.
   - **retrigger / mono** — a falling+rising edge (or a brief dip) forces the
     downstream envelope to re-attack.
   - **tie-through-slide (303 style)** — a legato pitch change while the gate stays
     high (distinct from retrigger).
5. **Everything stays CV.** No mode converts a gate consumer to edge-only, and no
   path bakes an amplitude envelope into the gate. `trigger` vs `gate` is a consumer
   *interpretation* of the same cable, made explicit by `PortDef.edge`, never a
   routing restriction.

---

## 3. THE POLY MIDDLE-WAY — what is left of it

### 3.1 Per-lane gates (Phase 2b — OPEN)
- A chord whose notes have different lengths must schedule an **independent gate-off
  per lane**, not one shared `gateSteps`.
- `scheduleStep` today supports a per-lane gate + a **single** `gateOffSec`; extend
  the data path so each lane carries its **own** off time.
- Invariant: each lane's gate is still a clean 0/1 square with an explicit close.

### 3.2 Stable LRU voice allocator — SHIPPED (#991)
`$lib/audio/poly-alloc.ts` exists: a note-on is assigned a free lane and keeps it
until its own note-off; a note-off frees only that lane; overflow steals the LRU
sounding voice with a clean fall+rise; dedupe is by **note identity**, not pitch.
Kept here only because 3.1 and 3.3 build on it.

### 3.3 Legato / mono / poly as an explicit mode (Phase 3 — OPEN)
- **poly** — each note its own lane + its own gate (3.1 + 3.2).
- **legato** — the gate **stays HIGH**, pitch glides, **no re-attack** (polyhelm
  already does this when the gate never falls). Mode = "do not dip the gate on a new
  note while one is held; just move the pitch."
- **mono** — collapse to one voice **and retrigger**: dip/fall+rise the gate so the
  envelope re-fires (midi-lane's existing retrigger shape).
- This mode lives on the SENDER (clipplayer lane / MIDI LANE), expressed purely as
  *when we edge the gate*. It never changes the cable or the consumer.

Invariants for all of 3.1–3.3: stay CV, emit clean 0/1 edges only, never bake an
envelope, never convert a consumer to edge-only, never smooth the gate.

---

## 4. THE REMAINING PHASES

### PHASE 2b — per-lane gate-off
Scope: make overlap correct — notes starting on different steps while others still
sound, and chords whose notes have different lengths.

Design:
- Extend `scheduleStep` (or add `scheduleLanes`) so each lane carries its own
  `gateOffSec` (per-note release), replacing the single shared `gateOff`.
- `clip-types.ts`: add a resolver that, for a given step, returns the set of notes
  **sounding** (covering the step), not just starting — feeding the allocator so a
  note that starts mid-chord takes a free lane and independent releases work. Keep
  `lanesForStep` for back-compat or refactor its callers.

Files: `poly.ts`; `clip-types.ts`; `clipplayer.ts` (`serviceAudition` +
`emitLaneStep`); `midi-lane.ts`; `midi-cv-buddy.ts`.

Proving test: extend `clipplayer.test.ts` — a chord with notes of lengths {1,2,4}
produces three independent gate-off times on three stable lanes. e2e: hold a 3-note
chord on the KEYS keyboard into POLYHELM, release the bottom note; the top two
voices must not re-attack (RMS continuity / no new onset) while the released voice
falls.

Invariants: a note never changes lane while sounding; a freed lane's gate falls
cleanly; a stolen voice retriggers via real edges (never a silent pitch swap under a
held gate).

### PHASE 3 — Legato / mono / poly mode (explicit, PER LANE)
Design:
- Add a `voiceMode: 'poly' | 'legato' | 'mono'` control. In clipplayer this extends
  the existing per-lane mono/poly toggle (`clipplayer-mono` family, `laneMono` in
  `clip-types.ts`); in MIDI LANE it extends `LaneMode` with `legato`.
- legato: a new note arriving while one is held keeps the (single) lane's gate HIGH
  and moves its pitch — no dip. mono: dip/fall+rise the gate. poly: the allocator.

Files: `clipplayer.ts`, `clip-types.ts` (data/flag), the clipplayer card,
`midi-lane.ts`, `midi-cv-buddy.ts`, their cards.

Proving test: unit — in legato, a second overlapping note produces NO gate falling
edge (only a pitch change) on the sender's captured events; in mono, a fall+rise; in
poly, a second lane opens. e2e — a legato clip into DX7 shows a single sustained
envelope with a pitch change (no re-attack); mono shows a re-attack.

### PHASE 4 — Unify pulse-width constants + gate-length ceilings
Design:
- Put the shared numeric constants in a package both `$lib` and `$dsp` can import (a
  tiny `$dsp` primitive re-exported by `gate-trigger.ts`), then delete every local
  re-declaration listed in §1.6, including the two dsp mirror copies.
- **Decide ONE gate-length ceiling.** Recommendation: keep the sequencer family's
  "always closes just before the next step" (never overlap the next onset) as the
  canonical duty-cycle rule, and align clipplayer's `gateLength` max from 1.0 to
  that rule (or document 1.0 as "legato-to-the-edge, minus epsilon"). Held/tied
  notes keep the `span - epsilon` rule; **make the epsilon a named constant** — it
  is currently a bare `0.002` literal.

Proving test: a grep-guard unit test asserting every module imports the shared
constant (mirroring the existing docs `testidPrefix` guard pattern); a test pinning
the single ceiling rule (gate close < next onset for every step sequencer +
clipplayer non-legato).

Invariants: purely a refactor; no audible behavior change except the deliberate
ceiling reconciliation, which must still never overlap the next onset.

### PHASE 5 — remainder: the FRONT-card glyph
The lint and the rear-card glyph are done (§1.7). What is left: replace the
hand-authored ▷/▭ labels in `GatemaidenCard.svelte` and `TimelordeCard.svelte` with
a generic renderer keyed on `PortDef.edge`, the same way `rear-card-model.ts` feeds
`RearCard.svelte`. Cosmetic only. `edge` must never restrict a connection.

### PHASE 6 — Step-seq length model + per-sample edge detect
Owner put the first half explicitly IN scope (see OWNER DECISIONS).
- **Sequencer length model:** extend `sequencer.ts` / `polyseqz.ts` / `drumseqz.ts`
  steps with a per-step length + tie, routed through the Phase 2b gate model.
  ⚠ **`polyseqz` writes voice gates DIRECTLY** (`polyVoice.gateSrc.offset.setValueAtTime(...)`),
  **not** via `scheduleStep` — so its tie work is a direct-write change, not a
  signature change. (Real `scheduleStep` callers, from the review's caller audit:
  `cartesian.ts`, `numpad-plus.ts`, `sequencer.ts`, `clipplayer.ts` ×2,
  `midi-lane.ts`.)
- **Per-sample edge detect:** a shared DSP helper so `dx7`/`cube`/`polyhelm` can
  detect a gate edge anywhere in the block (§1.9). Deferred because current senders
  edge on block boundaries — **explicitly deferred, not forgotten.**

Proving test: a sequencer tied note sustains across steps into a poly synth; an
offline DSP test that a sub-block gate produces exactly one note-on.

---

## 5. Risks

- **Ceiling change is behavioral.** Aligning clipplayer's 1.0 ceiling changes
  existing patches subtly; gate it behind the reconciliation test and call it out in
  the changelog.
- **DSP/web constant home.** The shared-constant move must respect the package
  firewall (`$dsp` can't import `$lib`); getting this wrong breaks the DSP build.
  Prefer a `$dsp` primitive re-exported by `gate-trigger.ts`.
- **Block-rate detach.** Do **not** "fix" block-rate sampling by ramping gates; that
  would violate the clean-edge invariant. The only correct fix is per-sample
  detection (Phase 6).
- **Allocator state must stay unsynced.** clipplayer state is Yjs-synced; the
  allocator is per-engine-instance render state — keep it that way or two peers will
  fight over lane assignments.

## 6. Explicitly OUT of scope

- MIDI polyphonic expression (MPE), per-note pressure/Z as a separate CV lane.
- Voicing intelligence beyond LRU-steal / round-robin (unison/sorted are stubs; no
  auto-voice-leading).
- Any baked-in amplitude envelope, "note velocity → fixed VCA curve", or gate
  smoothing — forbidden by the model.
- Rewriting the DSP voice allocators (they already cooperate); the remaining work is
  main-thread only.
- Changing `canConnect`/cable typing so gate stops cross-patching with cv/pitch.

## 7. Still-open questions for the owner

1. **Gate-length ceiling:** adopt the sequencers' "always close before next onset"
   as the single rule and lower clipplayer's 1.0 to match, or keep 1.0 as an
   explicit "legato to the edge"? This changes existing clipplayer patches.
2. **303-style slide:** do we want an explicit tie-with-glide gesture distinct from
   legato (glide time control), or is legato-with-portamento enough?
3. **Should `edge` ever gate UI affordances** (e.g. auto-suggesting GATEMAIDEN when
   a trigger output meets a gate input), or stay purely cosmetic + lint?

---

## OWNER DECISIONS (2026-07-01) — all still load-bearing, all still unimplemented

- **Phase 1 (the bug fix): APPROVED + shipped** as PR #990.
- **Default voice mode = LEGATO** (Phase 3). Overlapping notes on a lane keep the
  gate HIGH + glide the pitch, no envelope re-attack — the connected default.
- **Mode is PER-LANE** (not a single KEYS-global toggle) — each of the 8 lanes
  chooses poly / legato / mono independently.
- **Extend the length/tie model to the STEP SEQUENCERS = YES** (was a deferred
  optional phase; now in scope). `sequencer` / `polyseqz` / `drumseqz` gain a
  per-step note-length / tie so a note can span >1 step, feeding the same held-gate
  model. NB the adversarial review's caller-audit correction: **`polyseqz` writes
  voice gates DIRECTLY (not via `scheduleStep`), so its tie work is a direct-write
  change, not a `scheduleStep` signature change.**

---

## Appendix — critical files

- `$lib/audio/poly.ts` — `scheduleStep`; the single `gateOffSec` that Phase 2b
  replaces.
- `$lib/audio/poly-alloc.ts` — the shipped LRU allocator (Phase 2a).
- `$lib/audio/modules/clipplayer.ts` — `emitLaneStep`, `serviceAudition`.
- `$lib/audio/modules/clip-types.ts` — `lanesForStep` single shared `gateSteps`;
  `NoteEvent.lengthSteps`; `setNoteSpan` (tie).
- `$lib/audio/gate-trigger.ts` — the constants + emit helpers to unify against.
- `$lib/audio/edge-detect.ts` — `createEdgeCounter`, the main-thread building block.
- `$lib/audio/modules/midi-lane.ts` — `buildPolyLanes`, `NOTE_GATE_PULSE_S`, the
  mono retrigger shape.
- `$lib/graph/types.ts` — `PortDef.edge`, declared and deliberately non-restricting.
- `$lib/ui/workflow/RearCard.svelte` + `rear-card-model.ts` — the generic edge glyph
  that the front cards should copy.
- `$lib/docs/module-docs-lint.test.ts` — the now-unconditional edge demand.
- `$dsp/polyhelm.ts`, `$dsp/dx7.ts` — lane-stable, block-rate gate consumers; the
  proof that the remaining fixes are main-thread.
- `$lib/audio/modules/clipplayer.test.ts` — the fake-AudioContext harness;
  `e2e/tests/polyhelm-poly-chain.spec.ts` for the audible proof.
