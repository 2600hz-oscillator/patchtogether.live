# CLIP PLAYER — full SONG MODE / arranger (design) — 2026-07-18

> **TRIAGE 2026-08-04 — PARTIALLY BUILT; the rest is live backlog.**
> **Phase 1 shipped as #1099** ("ARRANGER / SONG MODE phase 1 — record → print →
> play core", merged 2026-07-18) — i.e. the §0 recommendation was accepted: the
> launch-event-log was thrown out as the song source of truth and replaced by
> printed layers. The §3.4 dependency also shipped: the per-clip sibling `auto`
> map is live (`packages/web/src/lib/audio/modules/clip-types.ts:237` — "PER-CLIP
> AUTOMATION — the sibling `auto` map (automation redesign Phase 1)").
> **Still un-built:** the §5 SONG view rebuild, the arranger-automation lane, and
> §7's later phases. Read §7 for what remains, not the doc's "DESIGN ONLY" header.
> This file is cited from source — do not delete it without fixing the citation.

DESIGN ONLY. No code in this pass. Supersedes
`.myrobots/plans/song-mode-arranger-2026-06-16.md` (the launch-event-log skeleton
that shipped as the "experimental red ● arranger record").

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

## 0. TL;DR / recommendation

- **Throw out the launch-event-log as the SONG source of truth** (`ArrangeData` /
  `ArrangeEvent` / block-derivation / reference-playback). It models a fundamentally
  different thing (a *reference* to clips that re-derive notes at play time) than
  what the owner wants (a *printed, concrete* note + automation performance). It
  cannot represent "8 channels of note+timing + 8 channels of automation + an
  arranger-automation lane" without being bent past recognition.
- **Keep and refactor the surrounding scaffolding** — the `songBeat` clock, the
  half-open `eventsInRange` windowing *pattern*, the full-window editor overlay
  shell + timeline geometry + drag/playhead, the CRDT-safe `writeArrange`
  transactional discipline, and the Launchpad SES/ARR + REC bindings. These are
  generic and correct; only the *model they carry* changes.
- **New SONG model = three printed layers**, all reusing the clip-automation
  storage disciplines (sibling-keyed maps, per-key writes, coerce boundary,
  0..1-normalized automation events, single-driver ownership, single-writer
  recorderId, transient-scrub, container-init-at-load-seam):
  1. `song.notes[lane]` — concrete `SongNoteEvent[]` per lane (absolute song-beat).
  2. `song.auto[lane]` — concrete captured clip-automation per lane (absolute
     song-beat, `targetKey → SongAutoTrack`).
  3. `song.arrangerAuto` — the arranger-automation lane (`targetKey →
     SongAutoTrack`), fed by controls assigned to the arranger lane; **overrides**
     both clip playback automation and `song.auto[lane]` for the same param.
- **Keep the launch log ONLY as an optional, non-authoritative "structure track"**
  (`song.launches[]`, exactly today's `ArrangeEvent[]`) captured alongside the
  print, so the note ribbons remain re-bakeable and block-editable. It never
  drives audio. Owner question Q1 decides whether we keep it at all or go
  pure-printed.
- **Recording flow = perform in Session under a SONG-REC arm; the concrete result
  prints to the song channels** (Deluge "hold Record → press Song → perform →
  press Play"). **Playback flow = song time drives the printed channels straight
  out the existing 8 lane pitch/gate/vel outputs**; clips do not launch live.
- **Editing + visualization live on the CARD** (Deluge Automation-View idiom on a
  screen we actually have); the **Launchpad shows STATE only** (SES/ARR, REC,
  per-channel arm, playhead) — per the automation-redesign owner decision.
- Effort: **~5–7 phased weeks** for the full thing; a usable "record→print→play"
  core is ~2 weeks. Biggest risk is **durable size / write-storm** of a
  multi-minute concrete note+automation print — mitigated by commit-at-boundary +
  decimation caps, the same discipline clip automation already uses.

---

## 1. What exists today (assessed against the owner's model)

Grounded in the code, not memory:

**`packages/web/src/lib/audio/modules/clip-arrange.ts`** — the model + pure
helpers. `ArrangeEvent{beat,lane,slot|'stop',immediate?}`, `ArrangeData{events,
lengthBeats,loop}`, `recordEvent` (stable beat-sorted insert), `eventsInRange`
(half-open window), `arrangeLengthBeats`, plus a Phase-2 block layer
(`arrangeBlocks`, `moveBlock`, `setBlockSlot`, `deleteBlock`, `snapBeat`). Engine-
free, fully unit-tested. **This is a launch-reference log**: the source of truth is
*"lane L launched slot S at beat B"*, and the notes are re-derived from the live
clip at playback. Model is elegant for its purpose and wrong for the owner's.

**`packages/web/src/lib/audio/modules/clipplayer.ts`** (engine) — carries:
- a self-contained song-position clock: `songBeat`, `lastBeatAt`, `arrangeCursor`
  (lines ~434–443), advanced by real elapsed beats each tick (~1226–1232);
- a record hook: `appendArrangeEvent` fires inside `applyLaneQueued` when
  `isRecording() && clipMode()==='session'` (~966–971), capturing at APPLY time;
- origin resets on record-arm / entering arrangement / play (~1168–1190);
- a replay cursor: in `clipMode==='arrangement'`, `eventsInRange` fires launches
  as `songBeat` advances, wrapping at `arrangeLengthBeats` (~1369–1381);
- engine `read()` taps: `songBeat`, `clipMode`, `recording`, `arrangeEvents`
  (~1725–1729).

**`packages/web/src/lib/ui/modules/ClipArrangeEditor.svelte`** — a full-window
overlay (mirrors MAPPY): 8 lane rows × song-time bars, colored blocks derived from
the log, drag-to-move (local preview → one `commitMove` on drop), SES/ARR, ● REC,
REPLACE/OVERDUB, SNAP bar/beat, loop ±, cycle-clip, delete, live playhead read off
the engine `songBeat`. **`clipplayer-arrange-edit.ts`** — the shared `writeArrange`
transactional (ydoc.transact, coerce, in-place) discipline + `commitMove`.

**`launchpad-map.ts`** — `CC_REC = CC_UP (91)` = arranger record-arm
(`node.data.recording`); `CC_SONG = CC_DOWN (92)` = SESSION⇄ARRANGEMENT
(`node.data.clipMode`); `RGB_SONG_SESSION`/`RGB_SONG_ARRANGE`/`RGB_RECORDING`
LEDs; `SingleView` includes `'arranger'`.

**`ClipPlayerData`** (clip-types.ts) already reserves: `arrangement?: ArrangeData`,
`clipMode?: 'session'|'arrangement'`, `recording?: boolean`, `recordMode?:
'replace'|'overdub'`. Doc copy already tells users the arranger is "experimental"
and "records session launches of scenes 1–8… recording launches of scene 9+ is a
follow-up."

### Verdict: THROW OUT the log-as-song; KEEP the plumbing

**Throw out** (model mismatch — these encode a *reference* performance):
- `ArrangeData`/`ArrangeEvent` **as the song's authoritative content**, and the
  arrangement-mode replay path that re-launches clips (`applyArrangeEvent` →
  `setLaneActive`). The owner wants concrete printed channels, not re-launched
  references. A launch log cannot hold 8 note channels + 8 automation channels + a
  song-level automation lane; it holds *pointers*.
- The block-derivation editor semantics (a block = a clip reference spanning
  launch→next-event). The SONG editor edits *notes* and *automation ribbons*, not
  clip-reference blocks.

**Keep / refactor** (generic, correct, reusable — no reason to rewrite):
- the `songBeat` / `lastBeatAt` song clock + origin-reset seam (Phase-1 recommend
  stays self-contained; owner Q on shared TIMELORDE position);
- the **half-open windowing pattern** (`from`/`to`, fire-once, loop-wrap split) —
  reused verbatim to *print* per tick and to *play back* per tick;
- the editor overlay shell + timeline geometry (viewBox, lane rows, bar lines,
  drag-to-move → single commit, engine-read playhead) — the container is right;
  the layer content changes;
- the `writeArrange` **one-transact, coerce, in-place** CRDT discipline — becomes
  `writeSong`;
- the Launchpad SES/ARR + REC scaffolding (renamed to SONG semantics; LEDs and
  view routing already exist).

**Migration:** the skeleton is shipped-but-experimental and self-described as such.
Recommend a **clean break** ([[schema-cleanup-campaign-complete]] precedent):
on load, `coerceSong` ignores any legacy `arrangement`/`clipMode`/`recording`
fields (they coerce away), and the old launch log is dropped — OR, if Q1 says keep
the structure track, it is re-homed under `song.launches` read-only. No user has a
song they can't trivially re-record.

**Rename for clarity:** the "arranger" view becomes the **SONG** view everywhere
(card button, Launchpad view, docs). `clipMode` value `'arrangement'` → `'song'`.

---

## 2. Prior art (short — full appendix in §8)

Deluge's Arranger View: rows = tracks (instruments), horizontal = time; you place
*clip instances* along each row, arm tracks for arrangement-recording (hold RECORD,
tap a track's mute pad), then **hold Record → press Song → perform clip launches →
press Play** to capture a live session performance into the timeline. Automation is
a separate layer: **Automation Arranger View** (Shift+Song) records/edits param
automation *on a song-arrangement basis*, distinct from **Automation Clip View**
(per-clip). Deluge keeps notes/clips and automations as **independent scopes** —
clearing one leaves the other. "White" (arranger-only) clip instances let you
record automation that affects only the arrangement, not the source clip. The
Automation grid is columns=time / rows=value(0–128); hold-pad-A + press-pad-B draws
a linear ramp; an interpolation toggle switches smooth vs stepped.

We adopt: the record-a-live-performance gesture; per-track arrangement-record
arming; the notes/automation-are-independent-scopes rule; the Automation-View grid
idiom (col=time, row=value, hold-A+press-B ramp, interp toggle). We **simplify**
(§8.2): concrete *printed* channels instead of clip-instance references as the
authoritative playback; an explicit **arranger-automation LANE** instead of
white-vs-colored-clip semantics; no sections/12-color grouping (we already have
scenes + scene-repeats + per-lane color); one song scoped to this clip player's 8
lanes (not a rack-global arranger); editing on the card, Launchpad state-only.

---

## 3. Data model — the Song

New file **`clip-song.ts`** (engine-free, pure, unit-testable — mirrors
`clip-arrange.ts`'s posture but with the new model). Reuses types from
`clip-types.ts` (`NoteEvent`, `AutomationEvent`, `AutoTrack`, `automationTargetKey`,
`parseAutomationTargetKey`).

### 3.1 Top-level

```ts
/** The recorded Song — a concrete, PRINTED performance over song time. */
interface SongData {
  /** schema marker for this sub-model (independent of ClipPlayerData.sv). */
  v: number;
  /** Song length in beats. 0 = OPEN (derive from the furthest event, bar-ceil). */
  lengthBeats: number;
  /** Loop the song (true) or play once then stop (false). */
  loop: boolean;
  /** NOTE + TIMING channels — per instrument lane, sparse. Keyed by lane digit
   *  '0'..'7' (per-key write discipline, like auto[]/autoAssign). Absent = the
   *  lane has no recorded notes. */
  notes?: Record<string, SongNoteChannel | null>;
  /** AUTOMATION channels captured from CLIP automation as it fired — per lane,
   *  keyed by lane digit. Each is a targetKey→track map (the printed, flattened
   *  clip envelopes at absolute song time). */
  auto?: Record<string, SongAutoChannel | null>;
  /** The single ARRANGER-AUTOMATION LANE: targetKey → track, captured from live
   *  tweaks of controls ASSIGNED to the arranger lane. OVERRIDES clip + channel
   *  automation for the same param (§4.4). */
  arrangerAuto?: SongAutoChannel;
  /** Which MODULES feed the arranger-automation lane: module nodeId → true.
   *  MODULE-level assignment (owner-locked model, same as autoAssign), a SEPARATE
   *  map from the per-clip autoAssign — a module may feed a clip lane AND/OR the
   *  arranger lane. Per-key writes. */
  arrangerAssign?: Record<string, true>;
  /** OPTIONAL non-authoritative STRUCTURE track: the launch log (today's
   *  ArrangeEvent[]) captured alongside the print, for re-bake + block edit.
   *  Never drives audio. Present only if owner Q1 keeps it. */
  launches?: ArrangeEvent[];
}
```

### 3.2 Note channels (up to 8 × note+timing)

```ts
interface SongNoteChannel {
  /** step-ordered notes at ABSOLUTE song position, in the SAME step grid the
   *  lane emitted at. `beat` is fractional song-beats (drift-proof); `step` is
   *  derived for the editor. Poly: multiple events may share a beat. */
  events: SongNoteEvent[];
}
interface SongNoteEvent {
  beat: number;        // absolute song-beat of the note ONSET
  midi: number;        // MIDI note int (same convention as NoteEvent)
  velocity?: number;   // 0..127
  lengthBeats?: number;// gate width in song-beats (captured on note-off)
}
```

Rationale: reuse `NoteEvent`'s shape but key on **absolute song-beat**, not
clip-step, because the printed timeline is not clip-relative. `lengthBeats`
replaces `lengthSteps` for the same reason. Playback and the editor derive
integer steps from `beat × stepsPerBeat` on the fly.

### 3.3 Automation channels (up to 8 × automation)

```ts
interface SongAutoChannel { tracks: Record<string, SongAutoTrack>; }
interface SongAutoTrack {
  events: SongAutoEvent[];          // step-ordered by beat
  interp?: 'linear' | 'hold';       // same semantics as AutoTrack.interp
}
interface SongAutoEvent { beat: number; value: number; } // value normalized 0..1
```

Identical in spirit to `AutoTrack`/`AutomationEvent` (0..1 normalized param space,
optional interp), but positioned in **absolute song-beat** instead of clip-step.
`tracks` keyed by `automationTargetKey` (`nodeId::paramId`) — the exact key format
clip automation already uses, so `parseAutomationTargetKey` / target UI / the
single-driver ownership all carry over.

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

### 3.5 Where it lives on `ClipPlayerData` + transient scrub

- Replace the reserved `arrangement?: ArrangeData` with `song?: SongData`.
- `clipMode?: 'session'|'song'` (renamed value); `songRec?: SongRecState` (below).
- **Container-init at the factory load seam** (like `auto`/`autoAssign`/
  `automation`): create `song`, `song.notes`, `song.auto`, `song.arrangerAssign`
  empty so per-key writes never LWW a peer's subtree.
- **Transient scrub:** add `songRec` (live record-arm + recorderId) to
  `CLIP_PLAYER_TRANSIENT_DATA_FIELDS`. `song` itself is CONTENT (copied on
  duplicate); `song.arrangerAssign` is a global module claim like `autoAssign` →
  scrub it on duplicate (or keep — owner Q7). A duplicated player is born in
  Session, not recording.

### 3.6 Record-arm state (per-channel, single-writer)

```ts
interface SongRecState {
  /** master arm: song is armed to record on next/continued play. */
  armed?: boolean;
  mode?: 'replace' | 'overdub';
  /** the arming client's ydoc.clientID — single-writer for the PRINT commit. */
  recorderId?: number;
  /** per-channel note-record enable, keyed by lane digit '0'..'7'. Absent = the
   *  channel captures nothing this take (Deluge per-track arrangement arm). */
  noteEnable?: Record<string, true>;
  /** per-channel automation-record enable (captures that lane's clip automation
   *  into song.auto[lane]). */
  autoEnable?: Record<string, true>;
  /** arranger-automation-lane record enable (captures assigned-module tweaks). */
  arrangerEnable?: boolean;
}
```

Per-key enables mirror `automation.lanes` (concurrent per-channel toggles merge
key-by-key). `recorderId` = the single client that commits the print (avoids
double-print in multiplayer — one writer, others watch/play), exactly like
`isLaneAutomationRecorder`. (Owner Q6: is SONG record single-recorder-per-song, or
per-channel like clip automation? Recommend single-recorder-per-song for v1 — the
print is one coherent take — with per-channel *enable* flags.)

---

## 4. Flows

### 4.1 Model — two transports (as today, renamed)

- **SESSION** (unchanged): launch clips per lane; they loop; QNT-quantized or
  immediate switching.
- **SONG** (new authoritative): song time drives the *printed* concrete channels
  straight out the 8 lane outputs; clips do not launch live.

### 4.2 RECORD flow (arm → perform in session → print)

1. **Arm.** Card SONG-REC button (and Launchpad `CC_REC`). Sets
   `songRec.armed=true`, stamps `recorderId=ydoc.clientID`, defaults all note +
   auto channel enables on (owner can disable channels per Deluge per-track arm).
   Optionally arm the arranger lane (`arrangerEnable`). Player stays in SESSION.
2. **Play + perform.** On transport start with `armed`:
   - `mode==='replace'` → clear `song.*` + reset song origin (`songBeat=0`).
   - `mode==='overdub'` → keep `song.*` + keep song time (merge by beat).
   You now *perform*: launch clips (card / Launchpad / scenes / scene-repeats),
   and twist controls of modules **assigned to the arranger lane**.
3. **Print, per tick, on the recorder client only** (single-writer):
   - **NOTES:** the emit path (`emitLaneStep`) already computes each lane's
     sounding notes per step (poly pitch/gate/vel). Tee those into
     `song.notes[lane]` at `beat = songBeat` for enabled channels: append a
     `SongNoteEvent` per onset; capture `lengthBeats` on the note-off (reuse the
     `extendRecordedNote` idea from `clip-record.ts`, in song-beats). This is the
     literal "sequence of notes that results from launching clips over time."
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
   - **STRUCTURE (optional):** the existing `appendArrangeEvent` still runs into
     `song.launches` for re-bake/edit if Q1 keeps it.
   - **Write discipline:** buffer in engine-local arrays during the take; commit to
     the Y.Doc **at song-loop boundaries and on punch-out**, never per tick
     ([[cv-modulation-live-store-write-storm]]). Per-key writes only. Cap +
     decimate on commit (§6 risks).
4. **Stop / disarm.** Press Play (stop) or toggle REC off → commit the in-flight
   partial print, clear `songRec` (transient), keep the printed `song`.

The gesture is Deluge's: arm → perform in session → the concrete result prints.

### 4.3 PLAYBACK flow (SONG mode)

`clipMode==='song'` + transport running:
- advance `songBeat` by real elapsed beats (existing clock);
- **notes:** for each lane, fire `song.notes[lane]` events in the half-open window
  `[arrangeCursor, songBeat)` (reuse the `eventsInRange` pattern) straight into the
  SAME poly pitch/gate/vel emit path clips use — the *source* is a long concrete
  timeline instead of a looping clip; the emit is shared;
- **automation:** drive params from `song.auto[lane]` + `song.arrangerAuto` with
  the override precedence (§3.4). Transient param drive only (never rewrite the
  store); reuse the clip-automation seam-glide / hold-last-value / no-jump policy
  wholesale (loop-wrap, entering/leaving = de-zipper glide; live grab suspends;
  release glides back — all already built in the clip model);
- **loop / one-shot:** at `lengthBeats`, wrap (split the window, reset
  `arrangeCursor`, re-anchor held automation) or stop, per `song.loop`;
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
- **Optional STRUCTURE overlay** (if Q1 keeps `song.launches`): faint clip-launch
  block markers behind the note ribbons, with a "re-bake notes from structure"
  action. Off by default.
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

## 6. CRDT / storage — reuse vs extend

**Reuse verbatim (no new invention):**
- sibling-keyed sparse maps + **per-key set/delete** writes (concurrent per-channel
  / per-target edits merge, never whole-array LWW) — `song.notes`, `song.auto`,
  `song.arrangerAuto.tracks`, `song.arrangerAssign`;
- **coerce-at-boundary** (`coerceSong` / `coerceSongNoteChannel` /
  `coerceSongAutoChannel`) — SyncedStore/patch-load safe, drops garbage, caps
  sizes, plain-object-severs live Y children ([[yjs-save-load-real-ydoc]]);
- **container-init at the factory load seam** (LWW-race hardening);
- **single-writer `recorderId`** for the print commit (no double-print);
- **transient-field scrub** on duplicate (`songRec` transient; `song` content);
- `automationTargetKey` / `parseAutomationTargetKey`, `AutomationEvent` 0..1
  normalization, `interp`, the `RecordGate` / `QuantizedRecordWindow` /
  `mergeAutomationOverdub` record cores, the no-jump seam-glide/hold-last policy,
  the single-driver ownership pattern (`autoPlaybackOwners` → `songPlaybackOwners`);
- the `writeArrange` transactional pattern → `writeSong`.

**Extend (genuinely new):**
- **absolute song-beat positioning** (`SongNoteEvent.beat`, `SongAutoEvent.beat`)
  vs clip-step — the model's defining difference;
- **note-print tee** off `emitLaneStep` + song-beat `lengthBeats` capture on
  note-off (adapt `extendRecordedNote`);
- **clip-automation → channel capture** (sampling the effective envelope value into
  a song channel — the "automation that fires during playback" print);
- **higher size caps + decimation** for multi-minute prints (see risks);
- **arranger-lane assignment** as a second, separate module→lane map.

Storage is intentionally a **parallel structure**, not a reinterpretation of
`auto[]`, so the two automations stay disjoint CRDT scopes and neither clobbers the
other.

---

## 7. Phased build plan + effort + risks + owner questions

### Phases

- **Phase 0 — model + throw-out (0.5 wk).** New `clip-song.ts` (types + pure
  coerce/query/edit helpers, fully unit-tested). Rip out `ArrangeData` as the song
  source of truth; rename `clipMode` value → `'song'`; clean-break coerce of legacy
  fields; add `song`/`songRec` to `ClipPlayerData` + transient scrub + container
  init. Docs + contract-lock accept (audio def is NOT in the WebGL basis — no
  re-attest). **Adversarial-verify before close** (the memory's discipline caught
  7–8 majors/phase on the clip work).
- **Phase 1 — note print + play (1.5 wk).** Song clock refactor; note-print tee off
  `emitLaneStep` (per-channel enable, replace/overdub, commit-at-boundary); SONG
  playback of `song.notes[lane]` out the existing outputs; compact card readout +
  SES/SONG/REC. **e2e: real TIMELORDE → clip player, perform launches under
  SONG-REC, assert the printed note channel replays audible RMS out the lane
  outputs** (mirrors the poly-real-source-chain rule — engine-direct tests are not
  enough).
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
- **Phase 5 (deferred / owner-gated) —** structure track re-bake UI (if Q1),
  live-overdub-over-song (Q3), export/bounce, shared TIMELORDE song position (Q2).

Total: **~5–7 weeks** phased with per-phase owner review + adversarial-verify. A
usable "record → print → play" core (Phases 0–1) is ~2 weeks.

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

1. **Structure track:** keep the launch log as an editable non-authoritative
   `song.launches` (re-bake notes, block-edit), or go **pure printed channels** and
   drop it entirely? (Recommend: keep it, cheap, and it makes the note ribbons
   re-bakeable — but it is not the source of truth.)
2. **Song clock:** self-contained `songBeat` (v1, simple) vs a shared TIMELORDE
   song position (tighter long-form, bigger cross-module change)? (Recommend v1
   self-contained, Q re-open for long songs.)
3. **Live over song:** in SONG playback, allow live clip-launch / knob punch-in
   *over* the song (Deluge session↔arranger jumping), or is song playback strictly
   authoritative and entering Session stops it? (Recommend authoritative for v1.)
4. **Note capture fidelity:** print the *emitted* notes (post per-lane rate/div,
   swing, mute, S&H, mono/poly — literally what sounded) vs the *nominal* clip
   notes? (Recommend emitted = what you heard, matching capture-at-apply-time.)
5. **Arranger-lane scope:** one arranger-automation lane (owner's phrasing) with
   many targets — confirm it is a single song-wide lane, not per-channel arranger
   automation.
6. **Record arming:** single-recorder-per-song (one coherent take, recommended) vs
   per-channel single-writer like clip automation (different peers print different
   channels concurrently)?
7. **Duplicate:** does duplicating a clip player copy the `song` (content — yes) and
   the `arrangerAssign` (a global module claim — scrub like `autoAssign`, or keep)?
8. **Override granularity:** arranger automation overrides clip/channel automation
   *per-param* (recommended) — confirm it is not an all-or-nothing song-wide mode.
9. **Replace vs overdub default** for SONG-REC (recommend replace, matching the
   clip skeleton).

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

## 9. Files touched (anticipated; DESIGN only — no changes made)

- NEW `packages/web/src/lib/audio/modules/clip-song.ts` — the SongData model + pure
  helpers (mirrors `clip-arrange.ts`; that file's song-authoritative parts retire).
- `clip-types.ts` — `song?`/`songRec?` on `ClipPlayerData`, `clipMode` value rename,
  transient-scrub additions, `songPlaybackOwners` (or in clip-song.ts), reuse of
  `NoteEvent`/`AutomationEvent`/`automationTargetKey`.
- `clipplayer.ts` (engine) — note-print tee, channel-automation capture, arranger-
  lane capture, SONG playback drive + override precedence, song-clock refactor,
  container init, `read()` taps (`songBeat`, `songNoteCount`, …).
- `clip-automation-controller.ts` / `clip-automation-engine.ts` — reuse
  `RecordGate`/`QuantizedRecordWindow`/`mergeAutomationOverdub` for arranger-lane +
  channel capture (may extend, not fork).
- NEW `clipplayer-song-edit.ts` — `writeSong` CRDT edit helpers (rename/rebuild of
  `clipplayer-arrange-edit.ts`).
- `ClipArrangeEditor.svelte` → rebuilt as the SONG editor overlay (note ribbons +
  Automation-View ribbons + arranger lane); `ClipplayerCard.svelte` compact SONG
  readout.
- `launchpad-map.ts` / `launchpad-control.svelte.ts` — rename arranger→SONG
  semantics, state-only LEDs.
- Docs: co-located `docs`/`controlFamilies`, `STRICT_DOCS`, `module-manifest.ts`,
  `contract-lock` accept; LaunchpadDocs.
- Tests: `clip-song.test.ts` (pure), per-module-per-port + behavioral + vrt sweeps,
  a real-source-chain e2e (record→print→replay audible RMS), 3× flake-check on new
  tests before MR.

---

*Design doc. Read/research/spec only — no source changes, no PR, no build.*
