# Clip Player — Live Record + Overdub Redesign

**Status:** ~~DESIGN — for owner review before any build~~ **CORE BUILT AND MERGED (#1133); phase-2 items below are the remainder.**
**Date:** 2026-07-19

> **TRIAGE 2026-08-04.** **#1133** ("live-record + overdub redesign — CORE",
> merged 2026-07-20) shipped the §2.1 state machine, the §4 deterministic capture
> (killing the polled-integer race), the §3 stale-note fix, and additive overdub.
> The engine lives in
> `packages/web/src/lib/audio/modules/clip-record-machine.ts` +
> `clip-record-capture.ts` and this file is cited from source.
> **Still open:** the phase-2 follow-ups — re-read §2.2 (the RED/WHITE loop-length
> fork), §2.4 count-in, §2.6 held-note reconciliation at boundaries, §4.4
> atomic-pass undo and §5 Launchpad mapping against today's code before treating
> any of them as un-built; several were partially absorbed by the CORE PR.
**Scope:** The KEYS note-recorder on the clip player (live-playing notes into a step/note clip from the Launchpad + note editor). NOT the arranger launch-log (`recording`/`recordMode`) and NOT the per-lane automation recorder.

---

## 1. Summary + the three owner-reported problems (with confirmed root causes)

The clip player has a **KEYS note-recorder** that captures live-played notes (Launchpad audition pads / note editor) into a step/note clip (`NoteClipRecord` = sparse `steps: NoteEvent[]` + `lengthSteps`, `clip-types.ts:176/:193`). State lives in a synced Y.Doc field `noteRec: NoteRecState` (`clip-types.ts:740`). Playback is driven by a **200 ms lookahead** audio-thread scheduler (`clipplayer.ts`), a **25 ms main-thread poll** (`scheduler-clock.ts:42`), and a **polled integer playhead** the recorder reads back (`clip-playhead.ts:24`). These three clocks never agree, and that disagreement is the source of all three reported problems.

### Owner problem 1 — "Live recording just does NOT work reliably."
**Root cause: capture is racy against a 25 ms poll that skips steps, with no nearest-step quantize.**
- `serviceKeysRecord` runs only on the 25 ms tick and detects step changes by comparing to `keysPrevStep` (`launchpad-control.svelte.ts:1424-1457`). When step duration < ~25 ms (fast div + 2×/4× lane rate; e.g. 1/32 @ 180 BPM 2× ≈ 20 ms/step) the poll **skips steps**.
  - Wrap detection `wrapped = step===0 && keysPrevStep!==0` (`launchpad-control.svelte.ts:1429`) is **missed** if step 0 is skipped → the **arm→record punch-in never fires** (`:1430-1436`) and recording silently never starts.
- Live capture snaps to `getLanePlayhead` — the audible, lagging, up-to-25 ms-stale integer step (`launchpad-control.svelte.ts:1396`, `clip-playhead.ts:24`) — and **floors to the current sounding step** (`recordNoteAt(clip, step,…)`, `:1399`). There is **no nearest-step rounding anywhere**, so a musician anticipating the beat lands on the previous step. The event's own `timeStamp` is discarded even though `createMidiScheduler`/`eventTimeStampToAudioTime` (`midi-timing.ts:90/:146`) exists and the MIDI bridges already use it.

### Owner problem 2 — "Overdub is weird."
**Root cause: overdub is a single conditional skip of the erase — no buffer, no diff, no way to remove.**
- The **only** thing overdub changes is line `launchpad-control.svelte.ts:1441`: `if (!rec.overdub && !keysStopAtWrap) clearStep(...)`. Overdub ON simply skips the per-step clear. `recordNoteAt` is ADD-only (`clip-record.ts:70`), so overdub = unbounded additive accumulation onto the same `steps[]`; prior passes are never revisited and there is **no erase gesture within overdub at all**. The only exit is `keysStopAtWrap` (`:1318`, consumed `:1449-1453`), itself dependent on the poll catching the wrap.

### Owner problem 3 — "You HEAR notes from the last loop even though they're being CLEARED this loop."
**Root cause: sound and clear read the clip ~200 ms apart, and clearing never cancels already-scheduled audio.**
- SOUND: `emitLaneStep` reads the clip (`clipplayer.ts:1196`) and commits immutable WebAudio events (`poly.scheduleStep` / `gateSrc.setValueAtTime`, `:1226-1231`) up to `LOOKAHEAD_S = 0.2 s` in the future (`:261`, loop `:1780`), from a snapshot taken at `:1778`.
- CLEAR: `serviceKeysRecord` → `clearStep` (`launchpad-control.svelte.ts:1444`, `clip-record.ts:52`) mutates only the Y.Doc, and only when the **audible** playhead crosses the step — ~200 ms **after** the scheduler already committed that step's old note.
- **Nothing cancels in-flight scheduled voices on a record write.** The only `cancelScheduledValues` sites are `silenceLane` (`clipplayer.ts:1040-1044`), `serviceAudition` (`:1291-1295`), and re-anchor (`:1116`) — never a note edit/clear. So the clear always lags the schedule by a full lookahead and can never suppress the current pass. In **overdub** the effect is permanent: `clearStep` is guarded off, so prior-loop notes are never erased.

**One-line divergence:** `emitLaneStep` commits audio for step N at `currentTime + up to 0.2 s` from a snapshot; `clearStep`/`recordNoteAt` mutate that clip ~0.2 s later at the audible playhead, and nothing cancels the in-flight voices — so record/clear always lag what you hear, and overdub never erases.

---

## 2. Proposed RECORD + OVERDUB MODEL

Informed by the Synthstrom Deluge (+ community firmware) and confirmed against Ableton conventions. The Deluge is the right reference because its live-record discipline directly addresses all three failures: single source of truth, explicit erase, and a visible RED/WHITE loop-length mode.

### 2.1 State machine

```
        arm (KEYS button)                first wrap / punch            disarm (KEYS button) or
 IDLE ───────────────────►  ARMED  ─────────────────────────►  RECORDING ──────────────────────► IDLE
   ▲                          │  (count-in optional)               │  ▲                              │
   │                          │                                    │  │ toggle OVERDUB               │
   │                          └── cancel ──► IDLE                   ▼  │                              │
   │                                                          OVERDUBBING ───────────────────────────┘
   └──────────────────────────────── stop transport ────────────────────────────────────────────────┘
```

- **IDLE** — not armed. Note pads audition only (existing `pushAudition`).
- **ARMED** — record is enabled but capture has not begun. Deluge model §1: *recording is a mode active only while transport runs; arming is decoupled from the capture instant.* Cursor shows **armed** (red-blink). If transport is stopped, arming auto-starts it (existing `keysQueueRec:1306-1307`), optionally after a **count-in** (§2.4).
- **RECORDING** — capturing into the clip. On an **empty clip**, the first pass is **linear/extending** and **sets the loop length** (Deluge §3, RED cursor). On a **clip that already has notes**, recording runs the **fixed loop** (WHITE cursor) in the active overdub semantics (§2.5).
- **OVERDUBBING** — a sub-state of RECORDING on a fixed loop where new passes layer/replace per the chosen semantics. Toggled by the OVERDUB control.
- **STOP** — disarm, or transport stop. A held note at stop is closed cleanly (reconciled — see §3, §2.6), never left dangling.

**Adopted from Deluge (cite → why):**
- §1 *arm-then-capture, capture starts on the note* → fixes "recording doesn't start"; the punch-in is note/clock-driven, not a poll-observed wrap.
- §3 *empty clip first-pass sets length (RED) vs has-notes fixed loop (WHITE), with a visible cursor state* → removes loop-length ambiguity, the biggest "unreliable" driver.
- §5/§6 *overdub = additive layer; erase is a separate explicit gesture* → fixes "overdub is weird."
- §7 *single source of truth + reconcile the live voice on mutate* → fixes stale notes.
- §8 *whole record pass = one atomic undo* → trustworthy live takes.

### 2.2 Loop-length capture (the RED/WHITE fork)

- **Empty clip → linear/extending record (RED).** The clip length grows while recording until the user stops (disarm / launch another clip / stop transport). The captured span becomes `lengthSteps`. This replaces the current behavior where recording is always quantized to a pre-existing `lengthSteps` and silently fails if the wrap is missed.
- **Clip has notes OR a pre-set length → fixed loop (WHITE).** Recording locks to the existing `lengthSteps`; passes overlay per §2.5.
- **Owner may pre-set a length** on an empty clip (analogous to Deluge `SHIFT + ◄►`) and then record into that fixed frame.

Rationale: this is the single change that most directly answers "live recording doesn't work reliably" — the musician always knows how long the loop is and which mode they're in.

### 2.3 Quantization

- **Quantize-on-input to a settable grid** (Deluge §4, default fine e.g. 1/32 or 1/16), computed by projecting the pad event's `timeStamp` onto the audio clock and rounding to the **nearest** step (§4 of this plan). Default grid is an owner decision (§7).
- **Optional non-destructive post-hoc quantize/humanize** on the recorded pass (Deluge §4, `hold AUDITION + turn TEMPO`) — deferred to a later phase; `NoteEvent` already carries the timing needed.

### 2.4 Count-in

- **Configurable count-in bars** as an independent record setting (Deluge §2, community `SETTINGS > RECORDING > COUNT-IN BARS`). Default and whether it is on by default are owner decisions (§7). When ARMED with count-in > 0 and transport starts, capture begins after the count-in; the count-in is audible (metronome/click) but not recorded.

### 2.5 OVERDUB semantics (precise)

**Default = additive LAYER into the fixed-length loop** (Deluge §5, Ableton confirms: MIDI overdub is strictly additive; there is no play-over-to-replace). Concretely:
- Each pass **adds** NoteEvents onto the looping content. `recordNoteAt` stays add-only; poly cap applies.
- **Playing over a step does NOT implicitly replace or clear it.** Implicit replace-by-activity is exactly what makes the current overdub "weird" and is removed.

**REPLACE is a separate, explicit mode (not the overdub default).** When the user wants true-replace (the current default-record behavior), it is an explicit non-overdub RECORD pass, and the clear is done deterministically at schedule time with voice cancellation (§3) — not the lagging per-observed-step clear.

**Erase is an explicit, separate gesture** (Deluge §6 — the biggest reliability win):
- **Tap-a-step toggles it off** (Deluge toggle-delete) in the note editor / on the pad grid.
- **Hold-to-erase modifier** (owner decision §7): hold a CLEAR button; any step the playhead crosses — or any pad held — is deleted for that pass, with immediate voice cut (§3).
- **Clear-clip / clear-row** shortcut.

This cleanly separates the three gestures the current code conflates into one line: **layer** (overdub), **replace** (explicit record), **erase** (explicit clear).

### 2.6 Held-note reconciliation at boundaries

A note held across the loop wrap or through record-stop is treated as one object with its sounding voice (Deluge §7 community drone fix). On stop while a note sounds, `finishHeldOnsets` closes the note using the clock-projected position (not the polled integer) and the live voice is released in sync — no double-trigger, no dangling voice.

---

## 3. The STALE-NOTE FIX (owner problem 3)

**Principle (Deluge §7): the current note list is the single source of truth, and any mutation must reconcile the live scheduler — clearing a note must cut its sounding/queued voice NOW, not next loop.**

Three coordinated changes:

### 3.1 Cancel already-scheduled audio on a record-time edit
When a note is cleared/replaced for step N, immediately cancel the in-flight audio for that step's window on that lane:
- Call `cancelScheduledValues` / `cancelAndHold` on the lane's `gateSrc.offset`, velocity, and `poly` pitch params for the affected step-time window — mirroring the cancel set `silenceLane` already uses (`clipplayer.ts:1040-1044`, `:1120`). Force a note-off / voice-release for any voice currently sounding the cleared note.
- This is the missing side effect: `clearStep`/`recordNoteAt` today mutate only the Y.Doc; they must additionally publish a **reconcile** into the scheduler.

### 3.2 Decide the REPLACE clear at SCHEDULE time, inside the lookahead loop
Move the punch/clear decision so a step being (re)recorded is cleared **before or as** `emitLaneStep` schedules it (`clipplayer.ts:1174/:1780`), reading the freshest clip — instead of clearing ~200 ms later at the audible playhead. A clear this pass can then never be out-run by events queued from last pass.

### 3.3 Shrink the effective lookahead while a lane is recording
Bound the schedule-vs-clear phase gap to a few ms while recording (reduce `LOOKAHEAD_S` for a recording lane, or schedule only ~one step/one tick ahead per `createMidiScheduler`). Deluge §7: schedule a **short** look-ahead, re-reading the note list each pass, not a whole loop from a stale copy.

**Two sentences (the fix):** Make every clip mutation publish an immediate reconcile into the scheduler — cancel any already-queued note-on for the removed note and force a note-off on any voice currently sounding it — and decide the replace-clear at schedule time inside the lookahead loop rather than ~200 ms later at the audible playhead. Additionally shrink the recording lane's lookahead to a few ms so a clear this pass can never be out-run by audio committed from last pass.

---

## 4. RELIABILITY / deterministic-capture fix (owner problem 1)

### 4.1 Clock-aligned capture (kill the polled-integer race)
In `handleKeysNote` (`launchpad-control.svelte.ts:1369`):
- Project the pad event's `event.timeStamp` onto `ctx.currentTime` with the existing `createMidiScheduler` / `eventTimeStampToAudioTime` (`midi-timing.ts:146/:90`) — the same projection the MIDI bridges already use (memory: MIDI scheduling = timestamp-project, shared util).
- Convert that audio time to a **fractional step position** from the lane's known phase (`ln.nextStepTime`, `laneDur`, `divIndex`) and **round to the NEAREST step** (real record-quantize, §2.3). This removes the up-to-25 ms staleness and the floor-to-current-step bias in one move.

### 4.2 Never skip a step or a wrap
Drive record servicing from a **per-step boundary event**, not the 25 ms poll:
- Emit a step-crossing callback from the scheduler so no step/wrap is ever missed regardless of rate; OR
- Have `serviceKeysRecord` **iterate every step between `keysPrevStep` and the current step** (clearing each skipped step in replace mode, detecting a wrap that lands inside the skipped span). This closes both the missed-punch-in and the skipped-clear failures.
- Note: the note recorder does not (and need not) use `edge-detect` — its bug is under-sampling, not the double-count class `createEdgeCounter` guards (`edge-detect.ts:59-71`, correctly used only for `stop_all`/`reset` CV at `clipplayer.ts:1504/:1511`). The shared-seam discipline here is the **step-boundary callback / iterate-skipped-steps**, not `createEdgeCounter`.

### 4.3 Y.Doc write discipline — transient-first, not per-note storm
Today every note-on, note-off, and per-step replace-clear writes the **whole clip record** synchronously and undoably (`writeClip:951-965` → `editData` `ydoc.transact` `:884`; serializes all steps `:961`; `LAUNCHPAD_UNDO_ORIGIN`). A 16-step replace loop = ~16+ whole-clip broadcasts/loop plus an undo entry per cleared step — the write-storm class the project avoids elsewhere (playheads are kept off the Y.Doc for exactly this reason, `clip-playhead.ts:6-9`; cf. memory CV-modulation live-store write-storm).

Fix (matches the automation recorder's "commit once per wrap" discipline, `clipplayer.ts:876-882`, and `songNoteBuf` bar-flush `:1498-1501`):
- Accumulate the take in **local transient (non-Y.Doc) state** during the pass.
- **Commit per musical boundary** (loop wrap / disarm) in **one non-undoable transaction**, then a single **undoable** commit marking the whole pass (§4.4).
- This removes the per-step storm, the undo-stack flood, and the multiplayer rebroadcast latency that feeds back into 25 ms-tick jitter under load and in multiplayer.

### 4.4 Atomic-pass undo
Group all NoteEvents captured in a record/overdub pass into **one undo transaction** (Deluge §8, Ableton confirms). BACK/undo removes the whole take cleanly — a safe "oops" that makes live-record trustworthy.

---

## 5. UI / Launchpad + ClipplayerCard mapping

### 5.1 Launchpad
- **KEYS / arm** — existing entry (`keysQueueRec`). Now shows **ARMED (red-blink)** distinct from **RECORDING**.
- **RECORD cursor color = mode:** **RED** while linear-extending (empty clip, first pass sets length); **WHITE** on a fixed loop / overdub (Deluge §3). Cheap, high-value cue.
- **OVERDUB** — toggle (`keysToggleOverdub`), now = additive layer (§2.5), visibly distinct from replace-record.
- **CLEAR / erase** — new explicit gesture: **tap-a-step toggles off**; optional **hold-CLEAR-to-erase** modifier (owner decision §7); **clear-clip / clear-row** shortcut.
- **Count-in** indication during the count (§2.4).
- Respect single-vs-dual Launchpad service split (`launchpad-control.svelte.ts:2981/:3074`, mutually exclusive) and the Windows dual-port programmer-port binding (memory: launchpad-windows-dual-port).

### 5.2 ClipplayerCard
- Surface **arm / recording / overdub** state and the **RED/WHITE loop-length mode** visually.
- Add record-settings UI (independent, per Deluge): **count-in bars**, **quantize grid**, **overdub layer/replace default** — three independent settings.
- Expose the **erase** affordance (tap-to-toggle in the note editor already deletes; make hold-to-erase + clear-clip/row reachable).
- Any card look change → VRT (`task vrt:one -- clipplayer`) and owner preview before merge (memory: video-aspect/look-affecting PRs never auto-merge; card changes run `task vrt`).

Note-editor beat-guide + per-channel color work already landed (recent commits f4dcbc7f / 9b1fd2c8) — keep consistent.

---

## 6. PHASED BUILD PLAN (small, reviewable PRs) + tests + risks

Each phase is a separate PR. New behavior + new tests → run the specific new tests locally, **3× flake-check** (`REPEAT=3`), typecheck (`task typecheck`), before CI. Poly/MIDI paths **must** e2e the REAL default-mode source chain (MIDI LANE / POLYSEQZ → module → audible RMS) — an engine-direct or per-port "edge materializes" test does NOT count (memory: poly-modules-test-real-source-chain).

**Phase 0 — Instrumentation + characterization test (no behavior change).**
Add a deterministic harness that records a known note sequence at several rates/divs and asserts captured `steps[]` vs expected. This reproduces problems 1 & 3 as failing/asserting tests first.
- Tests: unit on `clip-record` helpers; an integration test driving the lane scheduler + capture. Risk: low.

**Phase 1 — Clock-aligned capture + nearest-step quantize (fixes problem 1a).**
`handleKeysNote` projects `event.timeStamp` via `createMidiScheduler`, computes fractional step, rounds to nearest, uses settable grid.
- Tests: integration asserting a note played just-before-boundary lands on the nearest (not previous) step; anticipation cases. e2e: real Launchpad → clip capture. Risk: phase math off-by-one at wrap; div/rate coverage needed.

**Phase 2 — Step-boundary servicing / iterate-skipped-steps (fixes problem 1b: missed wraps/clears).**
Replace poll-observed single-step servicing with a step-crossing callback or skipped-step iteration.
- Tests: fast-rate (1/32 @ 180 BPM, 2×/4×) integration proving punch-in fires and every skipped step is cleared; wrap-inside-skip detection. Risk: interaction with the 25 ms tick; ensure single/dual-Launchpad service paths both covered.

**Phase 3 — Stale-note reconcile (fixes problem 3).**
Clip mutation publishes reconcile into scheduler: cancel queued note-on + force note-off on the sounding voice for a cleared/replaced step; move replace-clear to schedule time; shrink recording-lane lookahead.
- Tests: integration asserting a step cleared this pass produces **no** audible voice for that step this pass (RMS/gate assertion, capability-gated per CI renderer guidance — memory: capability-dependent-e2e-local-vs-ci); loop-seam artifact test. Risk: over-aggressive cancel cutting legitimately-held notes — cover held-across-wrap; the `cancelScheduledValues` window must be scoped to the exact step.

**Phase 4 — Overdub = explicit layer; explicit erase gesture (fixes problem 2).**
Overdub becomes pure additive layer (remove the implicit clear-skip conflation); add tap-to-toggle erase + hold-to-erase + clear-clip/row.
- Tests: overdub layering integration; erase gesture cuts data AND voice (ties to Phase 3); no implicit replace on play-over. e2e real chain. Risk: gesture ergonomics — owner preview.

**Phase 5 — Y.Doc transient-first + atomic-pass undo (reliability under load / multiplayer).**
Buffer take locally; commit once per wrap in one non-undoable transact; one undoable pass commit; BACK undoes the whole take.
- Tests: assert write count per loop is O(1) not O(steps); undo removes the whole pass; real-Y.Doc/syncedStore test (memory: yjs-save-load-real-ydoc — never rebuild+reassign live Y maps); @collab with DATABASE_URL (memory: collab-tests-vacuous-without-db). Risk: multiplayer edit-during-record reconciliation; snapshot/persistence basis may re-attest (memory: collab-attest-persistence-basis).

**Phase 6 — RED/WHITE loop-length model + count-in + settings UI + card/Launchpad cues.**
Empty=linear-extend-sets-length (RED); has-notes=fixed (WHITE); configurable count-in bars + quantize grid + overdub default.
- Tests: length-capture integration (empty vs has-notes); VRT for card; e2e count-in timing. Risk: card look change → VRT diff + owner preview before merge.

**Phase 7 (deferred) — post-hoc quantize/humanize; take-lanes/comping.**
Non-destructive tighten/loosen of a recorded pass; later, non-destructive passes (Ableton comping).

**Cross-cutting risks:**
- CI wall-time: audio-RMS e2e on SwiftShader — gate on capability probes, scale timeouts by capture count, estimate the >2 min delta and flag for owner OK (memory: ci-walltime-2min-approval, ci-swiftshader-video-e2e-timeouts).
- Look-affecting card/Launchpad changes never auto-merge — owner preview first.
- Shared-registry conflict sweep after each merge (`task pr:conflict-sweep`).

---

## 7. Open questions / owner decisions

1. **Overdub default: layer vs replace.** Recommendation: **additive layer** (Deluge + Ableton), with replace as an explicit separate mode and erase as an explicit gesture. Confirm?
2. **Quantization default grid.** 1/32 (Deluge default, tightest musical) vs 1/16 (matches typical step grid) vs off. And should input-quantize be on by default?
3. **Count-in.** On or off by default? Default bars (Deluge community default is configurable; 1 bar typical). Is a click/metronome wanted during count-in and record?
4. **Hold-to-erase gesture.** Adopt the hold-CLEAR-to-erase-crossed-steps modifier, or rely solely on tap-to-toggle-off + clear-clip/row? Which Launchpad button hosts CLEAR?
5. **Loop length: first-pass-set (RED linear-extend) vs always-fixed.** Recommendation: adopt the RED/WHITE fork (empty extends & sets length; has-notes fixed). Confirm, and confirm whether pre-setting a length on an empty clip is wanted.
6. **Atomic-pass undo granularity.** Whole pass = one undo (recommended) vs per-note undo. Confirm whole-pass.
7. **Recording lookahead shrink.** Acceptable to reduce `LOOKAHEAD_S` for a recording lane (tighter reconcile) at the cost of a smaller scheduling safety margin under load? Or prefer schedule-time clear + cancel alone without changing lookahead?
