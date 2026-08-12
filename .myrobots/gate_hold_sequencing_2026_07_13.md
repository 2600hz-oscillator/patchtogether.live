# Gate-faithful recording — build sequencing (2026-07-13)

> **RE-VERIFIED 2026-08-12: still UNSTARTED, still LIVE backlog, owner GO
> standing on all 3 phases.** No `gateLen` on `NoteEvent` anywhere in
> `packages/web/src` (the only `gateLen` in the tree is GATEMAIDEN's unrelated
> min-gate-width param). `emitLaneStep` still derives the gate from the *global*
> `gateLength` duty knob. Note #990 ("held/tied notes hold the POLY gate across
> the span") is the **predecessor** research phase, not this work.

This doc reconstructs the plan (the original `gate-recording-proposal-2026-07-13.md`
was saved into a worktree that has since been removed — it was gitignored, so it's
gone). Research predecessor: `.myrobots/plans/gate-heldnote-model-2026-07-01.md`.

## The complaint (owner, verbatim intent)
Recording a track live off the KEYS keyboard sounds fine live, but **playback of
the recorded clip sounds different** — because live holds one continuous gate for
the real key-down time, whereas recording throws that duration away and playback
re-gates per step at the global GATE duty. Fix: record the gate-high event and
replay it the same way. Must work for **both mono and poly** tracks.

## Root cause (grounded in the code, as of the proposal)
Live and playback use **two different gate models**:
- **Live (right):** `handleKeysNote` (launchpad-control) `pushAudition(on:true)` on
  press / `on:false` on release → `serviceAudition` (clipplayer.ts) holds a stable
  per-voice allocator; a voice's gate opens on note-on and closes only on that
  note's note-off. Gate-high == real key-down time, sub-step, arbitrary length.
- **Record (lossy):** onset = the **integer** playhead step (`getLanePlayhead` →
  `clip-playhead`, floored); `recordNoteAt` (clip-record) stamps `lengthSteps:1`;
  note-off `extendRecordedNote` sets an **integer** span. `NoteEvent` has no finer
  field.
- **Playback (re-gates):** `emitLaneStep` (clipplayer) computes `gateOff` from the
  **global GATE knob duty** (default 0.9), not what was played.
- **Divergences:** (1) gate duration integer-only; (2) staccato floored to 1 step;
  (3) onset floored not rounded; (4) re-gate-per-step vs one held gate; (5) **mono**
  — live is always poly (allocator ignores the `mono` flag) but record is
  first-note-priority; (6) **poly overlap** — live overlaps voices continuously,
  record flattens to per-step chords and cross-step overlaps collide on lane 0.

## Chosen approach
**Record the real gate-high duration as a fractional-step `gateLen` on each note,
and HOLD each note's gate for that duration on playback instead of re-gating per
step.** Quantize the ONSET, preserve the DURATION (the DAW/hardware standard).
Strict superset: `gateLen` absent ⇒ byte-for-byte legacy behaviour. This is the
`gateLen`-on-note variant of the owner's "record the gate event" idea — chosen over
a raw event-log because it still composes with clip length / DOUBLE / REVERSE and
stays editable/quantizable in the one note model.

---

## PHASE 1 — core (record gateLen + hold-the-gate playback + onset quantize)
**Independently shippable — resolves the owner's stated complaint. Do this first.**
Est ~1–1.5 days.

- **Model:** add optional `gateLen?: number` to `NoteEvent` (gate-high length in
  **fractional steps**, tempo/grid-relative so it survives BPM/rate/div/swing).
  Authoritative for playback when present; absent ⇒ legacy. On record set
  `lengthSteps = max(1, round(gateLen))` (the piano-roll bar width stays integer).
- **Capture:** stash `performance.now()` at the KEYS press; on release convert
  `elapsedMs → fractional steps` via a shared `laneStepDur`/`clip-clock` helper and
  stamp `gateLen` in the **existing** note-off `writeClip` transaction (zero new
  writes — respects the in-place Y.Doc + CV-write-storm rules). Press/release
  latencies cancel in the delta. Switch onset **floor → round**.
- **Reproduce:** in `emitLaneStep`, `noteGateSteps(ev) = ev.gateLen ?? (legacy duty/
  tie rule)`; schedule each **poly voice's** close independently (extend
  `poly.ts scheduleStep` for a per-lane gate-off); mono gate closes at the **max**.
  No `gateLen` ⇒ identical to today.
- **Files:** `clip-types.ts` (field + coerceNoteEvent clamp + `noteGateSteps` +
  DOUBLE/REVERSE/COPY carry it), `clip-record.ts` (capture fractional length),
  `launchpad-control.svelte.ts` (`handleKeysNote`/`finishHeldOnsets` timestamp +
  stamp; onset round), `clipplayer.ts` `emitLaneStep` (per-note/per-voice closes),
  `poly.ts` `scheduleStep` (per-lane gate-off).
- **Tests:** `clip-record.test.ts` (held 1.4 steps → `gateLen≈1.4`; stab → sub-step;
  EPS/loop-wrap clamps; **absent → byte-for-byte legacy**). `clip-types.test.ts`
  (coerce + `noteGateSteps` + transforms carry it). `clipplayer.test.ts` (poly voice
  close at `onset+gateLen*stepDur`, mono close at max, legacy fallback identical).
- **E2E (poly rule — real source → audible):** extend `launchpad-keys-record.spec.ts`
  — record a long held note vs a short stab, then **measure the SCOPE gate-high
  window on playback** and assert `long > short` AND both ≈ played durations (proves
  playback reproduces what was played, not the 0.9 duty). Poll windows, not one-shot.

## PHASE 2 — mono parity (~1 day)
Make `serviceAudition` honor the `mono` flag → 1-voice **last-note priority +
legato (no re-attack) + optional glide**, so **live matches recorded** for mono
lanes. Record mono as one melodic line (trim prior note's `gateLen` on overlap);
playback holds the gate across legato boundaries. + mono record/playback e2e.

## PHASE 3 — poly overlap (~1.5–2 days, highest risk)
Replace the per-step chord voicing in `emitLaneStep` with a **scheduling-time voice
allocator** (reuse `createVoiceAllocator` from `poly-alloc.ts`) so overlapping notes
across steps each keep their own voice until their own note-off — fixes the lane-0
collision (#6). + poly-overlap e2e (both voices sound, no collision) + allocator unit
tests. Guard emit-core regression with `clipplayer.test.ts`.

**Total ~3.5–4.5 days for full mono+poly.**

---

## Build discipline (learned this session — do not skip)
- **Adding fields/ports → run the FULL web unit suite** (`npm run -w packages/web
  test`), not just the touched files. `gateLen` on NoteEvent is a data field (no
  PortDef/ParamDef change → no contract-lock churn), but frozen-contract tests +
  coerce tests will notice. See memory `adding-cv-ports-run-full-web-unit-suite`.
- **ART**: clip playback scheduling is main-thread (not a Faust worklet), so likely
  no `.f32`/`.sha` change — but if any DSP core is touched, prove `.f32` byte-identity
  and re-pin `.sha` last (memory `art-sha-pin-regenerate-last`).
- **Collab persistence**: verify the schema re-pin map doesn't pin `NoteEvent`'s
  exact shape before merge (adding an optional field should be transparent — confirm).
- **Hold for owner ears** — this is an audio-FEEL change; do NOT auto-merge. Ship
  Phase 1 green, owner hears it, then Phase 2, then Phase 3 (proposal's ordering).

## Prior art (for the record)
DAW standard = quantize onset, preserve duration (Ableton/OBEDIA/LANDR); hardware
step seqs store per-trig LEN + micro-timing (Elektron); mono = note-priority +
legato + glide; poly = time-domain voice allocator (= our `poly-alloc.ts`). We
already do all of this LIVE — the fix is persisting the gate length and reusing the
held-gate reproduction on playback.
