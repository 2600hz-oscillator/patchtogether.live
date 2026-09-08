# CLIP PLAYER — full SONG MODE / arranger (design) — 2026-07-18

> **PARTIALLY BUILT — phases 0+1 shipped as #1099, the rest is live backlog.**
> Trimmed 2026-08-12: the sections describing the pre-#1099 tree and the data
> model that landed verbatim in `clip-song.ts` were deleted, because the code is
> now the better copy of both. §0 states what remains.
> **This file is cited from source** (`clip-song.ts:5`) — do not delete it
> without fixing the citation.

Supersedes `.myrobots/plans/song-mode-arranger-2026-06-16.md` (the
launch-event-log skeleton that shipped as the "experimental red ● arranger
record").

Owner's model (verbatim intent):
- The **arranger view BECOMES a SONG view.**
- **RECORDING in arranger captures**, over song time:
  - up to **8 channels of NOTE + TIMING** — the *concrete sequence of notes* that
    results from queuing/launching clips over time, one channel per instrument
    lane; PLUS
  - up to **8 channels of AUTOMATION** — the per-clip automation that *fires
    during playback*, captured as it plays, one channel per lane; PLUS
  - an **ARRANGER AUTOMATION LANE** — controls can be *assigned to it*, and
    real-time tweaks of those controls during arranger recording are captured
    song-level (distinct from clip-level automation).
- The resulting **Song** is the recorded arrangement — a concrete note timeline +
  automation timeline. Per [[automation-redesign-per-clip]], the arranger was
  always the planned "long-form automation" layer, and **clip automation is
  OVERRIDDEN by arrangement (song) automation.**
- Deluge's arranger is the north star; "we may want to simplify it a little."

---

## 0. What shipped, and what this document is now for

Phase 0 + Phase 1 shipped as **#1099**. The §7 recommendation was accepted: the
launch-event-log was **thrown out as the song source of truth** and replaced by
printed layers, and the whole §3 data model landed verbatim in
`packages/web/src/lib/audio/modules/clip-song.ts` — which cites this file. Read
the code for the model; read this document for the **parts still un-built** and
for the reasoning that is nowhere else.

Still un-built, and why they are here:

- **Phase 2** — automation capture + playback. `song.auto[lane]` and
  `song.arrangerAuto` exist as types and coerce paths; **nothing captures into
  them** (`clipplayer.ts` only container-inits and clears them). The override
  precedence that makes them safe is §3.4 / §4.4.
- **Phase 3** — the card SONG editor (§5). `ClipArrangeEditor.svelte` still edits
  the *legacy launch log*, not song notes/automation ribbons.
- **The clean break.** `clipMode` now has THREE values —
  `'session' | 'arrangement' | 'song'` (`clip-arrange.ts:50`) — and
  `ClipPlayerData` still carries `arrangement?: ArrangeData` beside `song?`. The
  legacy skeleton was deliberately kept intact; retiring it is still owed.
- **Q1 is answered by the shipped code**: `SongData` has **no `launches` field**,
  so the structure track was dropped rather than re-homed. The launch log survives
  only as the separate legacy `'arrangement'` mode.

Design constants that shipped with the model: `MAX_SONG_NOTE_EVENTS = 8000`,
`MAX_SONG_AUTO_TRACKS = 32`, `MAX_SONG_AUTO_EVENTS = 8000` — the durable-size
guards against the write-storm risk in §7.

---

## 3. Data model — the parts Phase 2 still has to honour

The types, coerce boundary, caps and `SongRecState` are all live in
`clip-song.ts`; do not re-derive them from this document. What remains
un-implemented is the *relationship* below.

### 3.4 Relationship to the existing per-clip `auto[]` model

- **Storage shape is deliberately parallel** to `data.auto[clipIndex].tracks[key]`:
  same sibling-map + per-key-write + coerce discipline, so all the CRDT reasoning
  ([[yjs-save-load-real-ydoc]], [[cv-modulation-live-store-write-storm]],
  container-LWW hardening) transfers with zero new invention.
- **Clip automation is the SOURCE that is captured** into `song.auto[lane]` during
  recording (the per-clip envelopes that fire → flattened to absolute song time).
- **Arranger automation OVERRIDES clip automation** (owner + memory). At SONG
  playback the precedence for any param `key` is:
  `live hand-grab (soft-takeover) > song.arrangerAuto[key] > song.auto[lane][key]`.
  This is the song analogue of `autoPlaybackOwners`: the arranger lane always wins
  the tie for a param, else the channel that carries it. We extend/rename that pure
  function to `songPlaybackOwners(arrangerKeys, channelCarriers)` — arranger set
  wins, else lowest carrying channel.
- **`song.arrangerAssign` is a separate map from `data.autoAssign`.** A module can
  drive a clip lane's per-clip automation AND feed the arranger lane; the two
  captures are independent scopes. (Card UI: right-click a module → "Assign to
  automation lane" [clip, 1–8] and "Feed arranger automation" [song] as two
  distinct menu items; a module fed to the arranger lane gets a second border
  accent / badge.)

### 3.5 Where it lives on `ClipPlayerData` (SHIPPED — one item still owed)

`song?: SongData` + `songRec?: SongRecState` are on `ClipPlayerData`, container-
init and transient scrub are live. **Still owed:** the reserved
`arrangement?: ArrangeData` was *added beside* `song?` rather than replaced, and
`clipMode` kept `'arrangement'` alongside `'song'`. The clean break — coerce the
legacy fields away on load — has not happened.

---

## 4. Flows — the Phase-2 half

Phase 1's gesture is shipped: arm → perform in session → the concrete result
prints → SONG time plays the printed notes out the 8 lane outputs. Read
`clipplayer.ts` for it. What is specified here and NOT built is the automation
capture and its playback precedence.

### 4.2 What the RECORD tee still has to add

Per tick, on the recorder client only (`songRec.recorderId` — single-writer,
already enforced for the note print):

   - **AUTOMATION (clip → channel):** as each lane's per-clip envelopes drive
     params (the existing playback drive), sample the *effective normalized value*
     per enabled channel per tick and append to `song.auto[lane].tracks[key]`
     (decimated ~30 pts/s via the existing `RecordGate` gate — same density guard
     as clip automation). This captures "the automation that fires during
     playback."
   - **ARRANGER-AUTOMATION lane:** while `arrangerEnable`, a *touched* control
     (screen / MIDI / Electra — never CV, per the locked rule) of a module in
     `song.arrangerAssign` records to `song.arrangerAuto.tracks[key]`. Reuse
     `clip-automation-controller.ts`'s `RecordGate` + touch-gate cores verbatim;
     only the destination + positioning (absolute song-beat) differ.
   - **Write discipline:** buffer in engine-local arrays during the take; commit to
     the Y.Doc **at song-loop boundaries and on punch-out**, never per tick
     ([[cv-modulation-live-store-write-storm]]). Per-key writes only. Cap +
     decimate on commit (§7 risks).

### 4.3 PLAYBACK — the automation half

In `clipMode==='song'` with the transport running (the note half is shipped):
- **automation:** drive params from `song.auto[lane]` + `song.arrangerAuto` with
  the override precedence (§3.4). Transient param drive only (never rewrite the
  store); reuse the clip-automation seam-glide / hold-last-value / no-jump policy
  wholesale (loop-wrap, entering/leaving = de-zipper glide; live grab suspends;
  release glides back — all already built in the clip model);
- at the `lengthBeats` wrap, **re-anchor held automation** as well as resetting
  the cursor;
- clips do **not** launch live in SONG mode; the printed channels are the
  performance. (Owner Q3: allow live clip-launch *punch-in over* the song? Deluge
  lets you jump session↔arranger while playing. Recommend v1: entering Session
  stops song playback; live overdub-over-song is a follow-up.)

### 4.4 Automation override, concretely

Per param `key` at a given song tick, exactly one source drives (no fights):
1. a live hand on the control → soft-takeover (live wins, existing policy);
2. else `song.arrangerAuto.tracks[key]` if present → **arranger overrides**;
3. else the lowest enabled `song.auto[lane].tracks[key]` that carries it;
4. else nothing (param holds its last value — never snaps to 0/default).
Implemented by the renamed pure `songPlaybackOwners`, the direct analogue of
`autoPlaybackOwners`.

---

## 5. The SONG view (card-side; Launchpad = state only)

Per [[automation-redesign-per-clip]] "visualization/editor belongs on the CARD;
launchpad keeps arm/state only." The existing `ClipArrangeEditor.svelte` overlay
shell is the right container; its *content* is rebuilt.

### 5.1 Card — full-window SONG editor (rebuild of ClipArrangeEditor)

- **Transport bar:** SES ⇄ SONG, ● SONG-REC, REPLACE/OVERDUB, SNAP bar/beat, loop
  length ±, song length readout, live playhead. (Reuse today's bar almost verbatim,
  renamed.)
- **8 lane rows**, each with two stacked ribbons:
  - **NOTE ribbon** — a horizontal mini piano-roll of `song.notes[lane]` across
    song time (pitch = vertical, time = horizontal), tinted the lane color
    (`laneColorEff`). Edit: drag a note to retime/repitch, drag its right edge for
    length, click empty to add, delete. (Mirrors the existing note-editor row math
    in `clip-types.ts`, at song scale.)
  - **AUTOMATION ribbon** — expandable; the **Deluge Automation-View idiom**:
    columns = time, height = value; drag to draw; **hold point A + click point B =
    linear ramp**; interp toggle (smooth/stepped). One selectable track at a time
    (dropdown of the channel's `targetKey`s). This is the same editor we want for
    per-clip automation (the memory's demoted pad-grid editor, promoted to the
    screen).
- **ARRANGER-AUTOMATION lane row** (visually distinct, full song width): the same
  Automation-View ribbon, one track per assigned target, labeled by module/param.
  A chip row shows modules feeding the arranger lane (like `autoAssignCounts`).
- **Editing = CRDT-safe** via a new `writeSong` (the `writeArrange` discipline,
  renamed): one transact, coerce, in-place, per-key; drag = local preview → one
  commit on drop.

### 5.2 Card — compact in-card readout

The card face keeps a small SONG block: SES/SONG state, REC state, song length,
per-channel armed dots, an "OPEN SONG ⤢" button. No editing on the small face
(that's the overlay's job) — matches how the clip grid + auto arms already sit.

### 5.3 Launchpad — STATE ONLY

- `CC_SONG (92)`: SES ⇄ SONG (LED white in SONG). `CC_REC (91)`: SONG-REC arm (red
  pulse while recording). Already wired — just renamed semantics.
- Per-channel note/auto arm reflected on the top row (reuse the SHIFT+top-row
  per-lane arm gesture the clip automation already ships).
- Playhead position + which channels carry content shown as LED state.
- **No song editing on the Launchpad** (Mini has no encoders; the screen owns it).

---

## 6. CRDT / storage — what Phase 2 must reuse rather than reinvent

The storage disciplines below are already load-bearing for the shipped note
print; the automation channels are deliberately a **parallel structure**, not a
reinterpretation of `auto[]`, so the two automations stay disjoint CRDT scopes
and neither clobbers the other.

- sibling-keyed sparse maps + **per-key set/delete** writes (concurrent
  per-channel / per-target edits merge, never whole-array LWW);
- **coerce-at-boundary**, **container-init at the factory load seam**,
  **single-writer `recorderId`**, **transient-field scrub** on duplicate;
- `automationTargetKey` / `parseAutomationTargetKey`, `AutomationEvent` 0..1
  normalization, `interp`, the `RecordGate` / `QuantizedRecordWindow` /
  `mergeAutomationOverdub` record cores, the no-jump seam-glide/hold-last policy,
  the single-driver ownership pattern (`autoPlaybackOwners` → `songPlaybackOwners`);
- the `writeArrange` transactional pattern → `writeSong`.

Genuinely new for Phase 2: **clip-automation → channel capture** (sampling the
effective envelope value into a song channel — the "automation that fires during
playback" print), and **arranger-lane assignment** as a second, separate
module→lane map.

---

## 7. Remaining phases + risks + owner questions

### Phases (0 and 1 shipped as #1099)

- **Phase 2 — automation channels + arranger lane (1.5 wk).** Capture clip
  automation → `song.auto[lane]`; arranger-lane assignment + capture →
  `song.arrangerAuto`; playback drive with the override precedence + no-jump seams;
  reuse the record cores. e2e: assign a module to the arranger lane, tweak under
  SONG-REC, replay, assert the param follows the printed song automation and
  overrides a competing clip envelope.
- **Phase 3 — card SONG editor (1.5 wk).** Rebuild the overlay: note ribbons
  (drag/edit) + Automation-View ribbons (hold-A+press-B ramp, interp) + arranger-
  lane row + chips; `writeSong` CRDT edits; live playhead. VRT the card face +
  overlay.
- **Phase 4 — Launchpad state + polish (0.5–1 wk).** State-only LEDs (SES/SONG,
  REC, per-channel arm, playhead, content presence); docs pass (co-located
  `docs`/`controlFamilies`, `STRICT_DOCS`), living-docs accept; scene-repeats
  interplay verified; duplicate/scrub tests.
- **Phase 5 (deferred / owner-gated) —** live-overdub-over-song (Q3),
  export/bounce, shared TIMELORDE song position (Q2).
- **Phase 6 (owed, unscheduled) —** the clean break: retire the legacy
  `'arrangement'` `clipMode` + `ClipPlayerData.arrangement`, coercing them away on
  load. They were kept intact through Phase 1 and never removed.

Remaining effort: **~3.5–4 weeks** across phases 2–4, with per-phase owner review
+ adversarial-verify.

### Risks

1. **Durable size / write-storm (highest).** A multi-minute concrete note +
   8-automation-channel + arranger-lane print is far larger than a clip. Mitigate
   with the exact clip-automation discipline: **commit at loop-boundary/punch-out
   only**, **per-track decimation (~30 pts/s)**, **hard caps** (a `MAX_SONG_*`
   analogue of `MAX_AUTOMATION_EVENTS`/`MAX_AUTOMATION_TRACKS`), per-key writes.
   Verify ydoc payload growth in a soak test. Flag any CI wall-time delta >2 min
   ([[ci-walltime-2min-approval]]).
2. **Song-clock drift** on long songs / tempo changes (self-contained `songBeat`
   from `stepDur` can drift from TIMELORDE's worklet phase). Fine for v1; Q2 —
   long-form tightness wants a shared TIMELORDE song position.
3. **Multiplayer double-print.** Single-writer `recorderId` for the commit; others
   watch + play. Same gate as `isLaneAutomationRecorder`.
4. **Param jump at seams** (the owner's standing fear). Fully reuse the clip
   model's layered no-jump policy (hold-last-value, `cancelAndHoldAtTime` +
   Firefox fallback, de-zipper glides, physical-release touch). Do NOT re-derive.
5. **Note-length capture edge cases** (notes held across the song loop / punch-out;
   wrap-clamp). Reuse `extendRecordedNote`'s clamp logic in song-beats; test the
   wrap.
6. **Scope creep vs Deluge.** Keep it scoped to this clip player's 8 lanes; resist
   sections / rack-global arranger / audio bounce in v1.

### Owner questions

Q1 (structure track), Q4 (capture the *emitted* notes), Q5 (one song-wide
arranger lane), Q6 (single-recorder-per-song) and Q9 (REPLACE default) were all
**settled by what Phase 1 shipped** — read `clip-song.ts`. Still open:

2. **Song clock:** self-contained `songBeat` (v1, simple) vs a shared TIMELORDE
   song position (tighter long-form, bigger cross-module change)? (Recommend v1
   self-contained, Q re-open for long songs.)
3. **Live over song:** in SONG playback, allow live clip-launch / knob punch-in
   *over* the song (Deluge session↔arranger jumping), or is song playback strictly
   authoritative and entering Session stops it? (Recommend authoritative for v1.)
7. **Duplicate:** does duplicating a clip player copy the `song` (content — yes) and
   the `arrangerAssign` (a global module claim — scrub like `autoAssign`, or keep)?
8. **Override granularity:** arranger automation overrides clip/channel automation
   *per-param* (recommended) — confirm it is not an all-or-nothing song-wide mode.

---

## 8. Appendix — Deluge prior art + where we simplify

### 8.1 Deluge Arranger + Automation View (as researched)

- **Arranger View layout:** rows = tracks (synth/kit/MIDI/CV/audio), horizontal =
  time in *sections* (12 section colors). You **place clip instances** by pressing
  pads on a track's row; instances are moved by holding the clip pad + scrolling
  horizontally. Colored instances reference the Song-View pattern; **white
  instances** are independent arranger-only variants.
- **Live-performance recording into the arrangement:** set up Session, **hold
  Record → press Song** (flashing blue LED) → **perform clip launches** → **press
  Play** to stop. Per-track arrangement-record arming: hold Record in arranger,
  tap a track's mute pad (blinks red = armed); with record active, launching
  creates a clip-instance at the playhead if none exists.
- **Playback:** begins from the scroll position (hold the scroll knob + Play); you
  can jump between Song and Arranger while playing.
- **Automation:** **Automation Arranger View** (Shift+Song) edits/records param
  automation *on a song-arrangement basis*; **Automation Clip View** (per-clip).
  Grid = columns(time) × rows(value 0–128); **hold pad A + press pad B → linear
  ramp**; interpolation toggle = smooth vs stepped; hold a pad + turn gold knob =
  fine value.
- **Independent scopes:** clips/notes and automations are separate — clearing a
  clip/note leaves its automation, and clearing automation leaves the clip/note. A
  **white instance** records automation to the *arrangement only*, not the source
  clip. Clip automation performed in Song View **can be recorded into the
  arranger**.
- **Community extras:** hold a clip + Record in Song View to loop-record a clip;
  start/restart arrangement playback from a held clip pad; **Export Mixdown** of all
  unmuted arranger tracks to a stereo file; max-zoom = whole timeline in one cell;
  hold clip + turn Select to scroll clip names (OLED).

### 8.2 Where we SIMPLIFY (and why)

| Deluge | Us | Why |
|---|---|---|
| Clip-*instances* (references) on the arranger timeline; notes re-derived | **Concrete printed** note+automation channels are authoritative | Owner's model ("the sequence of notes that results"); simpler playback engine (no re-derive); a launch log can't hold 8 note + 8 automation + a song lane |
| Sections (12 colors) as a launch/quantize grouping | No sections | We already have scenes + scene-repeats + per-lane color |
| White vs colored instances to route arranger-only automation | An explicit **ARRANGER-AUTOMATION LANE** (module→song-lane assignment) | Cleaner, owner's stated model; no dual-clip-identity concept |
| Rack-global arranger across all tracks | One song scoped to **this clip player's 8 lanes** | Matches the module boundary; avoids a cross-module transport rewrite |
| Everything edited on the pad grid | **Editing on the card**, Launchpad state-only | We have a screen; matches the automation-redesign owner decision |
| Export Mixdown / audio bounce | Deferred (audio clip kind is future) | Out of scope for a note/CV instrument v1 |
| Automation grid IS the primary editor | Same **Automation-View idiom on the card** (col=time, row=value, hold-A+press-B ramp) | Adopt the good UX; promote the memory's demoted pad-grid editor to the screen |

We **adopt from Deluge**: the arm→perform→print gesture; per-track arrangement-
record arming; notes/automation-as-independent-scopes; the Automation-View ramp
editor; arranger-automation overriding clip automation.

---

## 9. Files phases 2–4 still have to touch

- `clipplayer.ts` (engine) — channel-automation capture, arranger-lane capture,
  automation playback drive + override precedence.
- `clip-automation-controller.ts` / `clip-automation-engine.ts` — reuse
  `RecordGate`/`QuantizedRecordWindow`/`mergeAutomationOverdub` for arranger-lane +
  channel capture (may extend, not fork).
- NEW `clipplayer-song-edit.ts` — `writeSong` CRDT edit helpers (rename/rebuild of
  the existing `clipplayer-arrange-edit.ts`, which still serves the legacy log).
- `ClipArrangeEditor.svelte` → rebuilt as the SONG editor overlay (note ribbons +
  Automation-View ribbons + arranger lane).
- `launchpad-map.ts` / `launchpad-control.svelte.ts` — rename arranger→SONG
  semantics, state-only LEDs.
- Docs: co-located `docs`/`controlFamilies`, `STRICT_DOCS`, `module-manifest.ts`,
  `contract-lock` accept; LaunchpadDocs.
- Tests: per-module-per-port + behavioral + vrt sweeps, a real-source-chain e2e
  for the automation half, 3× flake-check on new tests before MR.
