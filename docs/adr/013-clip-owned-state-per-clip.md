# ADR-013: Keep clip-owned state per clip, and media out of the Y.Doc

- Status: Accepted (arranger song-mode phases 2–6 unbuilt — see Consequences)
- Date: 2026-09-08 (records owner decisions of 2026-06-15 through 2026-09-04)
- Deciders: project owner; this ADR documents the decisions
- Tags: clips, persistence, multiplayer, audio, automation

## Context

The clip launcher accumulated four kinds of state that all want to live "with
the clip": the note pattern, per-parameter automation, a recorded audio take,
and an arrangement of how clips played over time. Each arrived in its own PR,
and each had an obvious wrong answer:

- **Notes and automation on the same record.** A peer's note edit and an
  automation commit would then last-writer-wins each other.
- **Audio samples in `node.data`.** The launcher holds 64 clips; one 4-bar take
  is ~3 MB in base64 against a relay that warns at 16 MB.
- **An arrangement as a launch log.** Re-deriving what sounded, at play time,
  from a log of launch events.
- **Recording armed from the mixer.** A per-channel arm/monitor band on
  `mixmstrs`, with the recorder reading the mixer's own controls.

## Decision

**Every clip-owned quantity is stored per clip, keyed by the same flat clip
index, written per key — and bytes never enter the Y.Doc.**

1. **One key space.** A clip is addressed by `lane × SCENE_STRIDE + slot` with
   the stride **fixed at 64**, independent of how many slots the surface shows,
   so growing the grid is not a re-key (`clip-types.ts`).
2. **Automation is a sibling map, never a field.** A note clip's automation is
   `data.auto[clipIndex]` — a separate sparse record at the same key. Notes and
   automation stay **disjoint CRDT / merge / undo scopes**, and a record commit
   writes only the touched track keys (`auto[k].tracks[target]`), never the
   whole object. Targets are a canonical `nodeId::paramId` string shared by the
   record, the assignment map and the UI. Values are 0..1 normalised, with caps
   on tracks and breakpoints as durable-size guards. Automation is custom
   parameter-envelope data, not MIDI CC, so it is not limited to 16 channels.
3. **Audio media lives in OPFS; the doc holds a `mediaId` and a dozen
   integers** (`packages/web/src/lib/audio/clip-media-store.ts`). The id is
   generated and written down **before the first byte**, so it survives a crash
   and the storage path is a pure function of it. The store adds a garbage
   collector the single-take video recorder does not need: a clip's media is
   referenced by exactly one `mediaId` in one `node.data`, so the live set is
   derivable and deleting a clip frees its bytes.
4. **Every recording boundary is a frame count from the context clock.**
   `unitFrames` / `startFrame` / `stopFrame` are resolved once, from
   `ctx.currentTime × ctx.sampleRate`; a later loop boundary is always
   `startFrame + n × unitFrames` in integer arithmetic, never seconds
   accumulated loop by loop. One worklet with eight stereo inputs slices every
   armed lane against **one** `currentFrame`, so a multitrack pass is
   sample-aligned by construction — the lanes do not agree about time, they
   share it. The arm/stop machine is a pure reducer; the worklet is deliberately
   dumb.
5. **The tap is upstream of the duck.** `mixmstrs` keeps two nodes where one
   would do: `boardIn` is the record tap (the raw patched input, before the
   monitor duck, before EQ/comp/fader) and `duck` sits downstream of it. Folding
   them would duck the tap, so a take recorded while a previous take plays would
   capture the ducking.
6. **Recording is a clipplayer feature, per clip** (owner, 2026-09-04). The
   whole `ch{N}_rec` / `ch{N}_mon` / `recTap` / `recQuality` band was removed
   from `mixmstrs` — eighteen params, their CV ports and their shadow rig. What
   stayed is the audio: the pre-board insert heads and the three published tap
   rosters. The recorder still captures the mixer's per-lane pre-board input; it
   is simply no longer armed from there.
7. **An arrangement is a printed performance, not a launch log**
   (`clip-song.ts`). Song recording captures what actually **sounded** — up to 8
   channels of note+timing at apply time (post rate/div/swing/mono/S&H), 8
   channels of automation, and one song-wide arranger-automation lane that
   **overrides** clip and channel automation per parameter. Playback drives the
   lane outputs directly; clips do not re-launch live. Storage is deliberately
   parallel to the per-clip model — sibling-keyed sparse maps, per-key writes,
   coerce at the boundary — with one defining difference: song positions are
   absolute song-beat, not clip-relative.
8. **Live capture rounds to the nearest step from the event's own time.** The
   recorder projects the pad event's timestamp onto the audio clock using the
   same projection the MIDI bridges use and rounds to the nearest grid step,
   instead of flooring onto the audible, up-to-25 ms-stale integer step — which
   dropped a player's anticipation onto the previous step and skipped steps at
   fast tempo. Overdub is an additive layer with an explicit erase, and a
   schedule-time replace clears with voice cancellation.

## Consequences

**Good:**

- Two peers can edit notes and automation on the same clip without either
  losing the other's write, because they are different keys in different maps.
- Deleting a clip actually frees its bytes, and a partial PCM file is a valid
  shorter take — recovery truncates to the last whole loop rather than
  discarding.
- A take is the requested number of samples or it is cancelled; there is no
  third outcome, and the closed-form loop boundary is held to zero drift over
  1000 loops with a positive control proving the accumulating spelling fails.
- Moving the arm surface off the mixer removed a whole shadow control rig
  rather than relocating it.

**Bad / load-bearing:**

- **The clip media store must stay under `lib/audio/**`.** `lib/video/**` is
  hashed wholesale for the real-GPU WebGL attest, so any slice of clip recording
  placed there costs an attest window per edit.
- The recorder's arm state is per-lane CRDT state written per key, precisely so
  two peers arming different lanes do not clobber a shared array. A future
  "record everything" gesture must keep that shape.
- **Arranger song mode is Phase 0+1 only.** `songPlaybackOwners` and the data
  model exist; capture from the engine, the arranger's own editor surface, and
  the clean break from the older `'arrangement'` play mode are unbuilt, and
  `clip-arrange.ts` still carries the legacy `ClipPlayMode` union. Four owner
  questions are open (the song clock's relationship to the shared transport,
  live punch-in over song playback, duplicate semantics, and per-parameter vs
  song-wide override granularity).
- Several banked layers remain deliberately unbuilt: a surface envelope editor,
  arranger automation capture, clip repeats, a count-in, and the postmix capture
  toggle (the seam is named, not built).
- Two automation defaults were never settled and should be decided before the
  envelope editor lands: absolute versus bipolar-offset mapping (which also
  governs CV-cable precedence), and the soft-takeover default.

## References

- `packages/web/src/lib/audio/modules/clip-types.ts` — the clip key space, the
  sibling `auto` map, the CRDT reasoning.
- `packages/web/src/lib/audio/clip-media-store.ts`, `clip-audio-rec-machine.ts`,
  `packages/dsp/src/clip-recorder.ts` — media, the arm reducer, the worklet.
- `packages/web/src/lib/audio/modules/mixmstrs.ts` — the board-in tap rosters
  and the removed arm band.
- `packages/web/src/lib/audio/modules/clip-song.ts`,
  `clip-record-capture.ts`, `clip-record-machine.ts` — printed song layers and
  live capture.
- [docs/design/clip-launcher.md](../design/clip-launcher.md) — the surface
  design these decisions sit under.
- ADR-001 / ADR-005 — the CRDT and persistence envelope this stays inside.
- Provenance: preserved in the `myrobots-preserved-2026-09` tag snapshot, as
  `2026-09-02-mixmstrs-multitrack-clip-recording/`,
  `plans/automation-redesign-2026-07-16.md`,
  `plans/arranger-song-mode-2026-07-18.md` and
  `plans/clipplayer-live-record-overdub-redesign-2026-07-19.md` (paths
  relative to the retired agent-evidence tree in that snapshot, not to the
  worktree).
