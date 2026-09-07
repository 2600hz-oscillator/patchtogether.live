# MIXMSTRS multitrack clip recording — audio clips in the launcher

Owner-commissioned design, 2026-09-02. **Research + design only.** No product
code, no PRs, no issues.

> **The ask, in the owner's words.** Give mixmstrs good MULTITRACK RECORDING
> based on prior-art and industry-standards research. Add AUDIO CLIPS to the
> clip launcher, and give mixmstrs the ability to RECORD AUDIO INTO A CLIP. A
> clip can be ARMED for audio recording with two options: **Arm–Single**
> (record for exactly 1 loop, then stop) and **Arm–Endless** (keep recording
> until STOP is hit; and in the Endless case, stop does not stop immediately —
> it stops at the END of the current iteration of the looping clip). The
> recorded audio is mixmstrs' PRE-BOARD audio on the channel (switchable to
> post-mix later — design the seam now, ship pre-board first). Quality: the
> highest reasonable that isn't overkill and won't cripple resources — study
> what recorderbox provides and give mixmstrs a similar recording-quality
> control. FOLLOW-UP (design the tie-in now, build later): VIDEO clips recorded
> in the same fashion — any clip can have an associated video clip saved from a
> connected output.

---

## 0. Measurement provenance

The local checkout is on `fix/inventory-regen-2` at `6748e4db4` and is **behind
`origin/main`** (`4b0cae442`). Two facts change between them and both matter:

- `packages/web/src/lib/blood/blood-pcm-schedule.ts` exists **only on
  `origin/main`** (`6e8dda99e`, #2312). The rate-exact pump lesson cited in §4.8
  is quoted from there, not from the local tree's superseded
  `blood.ts:344-349`.
- `recorderbox` **has a face** as of `34d2df04f` (#2314). Its quality control is
  therefore a face-extension selector over `node.data`, not a card `<select>`.

`mixmstrs` is byte-identical on both: 91 params, 4 face pages, no `pan{N}`.

Everything below is stated against `origin/main` unless a line number is
labelled otherwise. Paths are absolute-from-repo-root.

---

## 1. Survey — what is actually in the tree

### 1.1 mixmstrs

`packages/web/src/lib/audio/modules/mixmstrs.ts` (976 lines) +
`packages/dsp/src/mixmstrs.dsp` (357 lines).

**The channel strip is `EQ → comp → fader`, and every tap point is already
named in the DSP.** `mixmstrs.dsp:189-221` (`channelChain`):

```faust
eqL = eq3band(low, mid, high, lIn);           // ← POST-EQ
cIn = compStereo(rat, thr, en, eqL, eqR);     // ← POST-COMP  == the "PRE" of send1Pre
finalL = cL * vol;                            // ← POST-FADER == the meter tap
s1L = (finalL + s1pre * (cL - finalL)) * s1;  // the crossfade between them
```

- The signal **before** `eq3band` — the raw patched channel input — has **no
  tap and no name in the DSP**. It is the only place the audio exists untouched.
- `send{R}Pre` = 1 already means "PRE-fader", and `mixmstrs.dsp:81-84` states
  explicitly that PRE is *deliberately POST-EQ/COMP*: *"a pre-EQ tap would be a
  THIRD mode, not a redefinition of this one."* **So "pre-board" and "pre-fader"
  are already two different things on this module.** §4.2 defines pre-board as
  the third one; §7 Q1 asks the owner to confirm.
- Worklet I/O: 20 audio in (`mixmstrs.ts:206-209`), 14 audio out —
  0-5 = masterL/R + send1 L/R + send2 L/R, 6-13 = **mono `(L+R)/2`
  post-fader meter taps** (`mixmstrs.dsp:279-281`, `:344-356`). The `.dsp`
  itself flags the extension: *"a stereo VU would split these into 16 outputs
  (future option)"* (`:277`). That is the post-fader half of §4.2's seam.
- The per-channel meter tap is **measurably phase-blind** — an anti-phase
  channel reads RMS `0.0000e+0` while masterL/R each carry `0.184216`
  (`mixmstrs.ts:286-290`). It is not usable as a recording source.
- Inputs are published as `{ node: merger, input: i }`
  (`mixmstrs.ts:898-900`), so the engine connects each cable straight into a
  `ChannelMerger`. There is currently **no per-port node to tap.**
- Face: 4 pages (`channels` / `dynamics` / `aux sends` / `returns`,
  `mixmstrs.ts:384-451`), `glyph: 'meter'` on `masterL`, hero = `master_volume`,
  **no panel and no `hero.cell` by explicit argument** (`:275-290`,
  `:571-572`): *"every affordance on `MixmstrsCard.svelte` is a `ParamDef`."*
- `mixmstrsChannelIndex` (`mixmstrs.ts:182-187`) claims a param for channel *N*
  by **naming rule** — `/^ch(\d+)_/` or `/^comp(\d+)$/` — and three derived
  lists read it: `channelAccent` (lane colour), `bareCells`, and the face
  model's `isChannelScoped`. A new per-channel control that matches the naming
  is claimed with **zero edits**; one that does not is silently mis-classified
  as bus-scoped. This is load-bearing for §4.9.
- `mixmstrs-face-model.ts:114` + its test assert the SCOPE partition in both
  directions and that the bus-scoped block stays **longer than the largest lane
  tier**, so no lane tier ever paints a channel control.
- `mixmstrs-sections.ts:84-128` **hand-picks** patch-panel port ids and
  *silently drops* an id the def does not declare (`:8-13`). A new CV input that
  is not added to the pick list is a jack that never renders and nothing goes
  red.
- ART scenarios (`art/scenarios/mixmstrs/*.test.ts`) render through
  `renderFaustOffline` — **the JS factory is not in that path**, so a
  JS-side graph change moves no ART baseline. (`prefader-sends.test.ts:9-17` is
  the template for an assertion-shaped, negative-controlled routing scenario.)

### 1.2 The clip system

- **`AudioClipRecord` already exists and is a dead forward declaration.**
  `clip-types.ts:222-231`, commented *"LATER — audio-loop clip (reuses
  SAMSLOOP's bytes discipline)"*: `{ kind:'audio', fileBytesB64, fileSize,
  fileMime?, fileName?, sampleRate?, sampleLength? }`. It is **never
  constructed, validated, decoded or played anywhere in production code**, and
  `coerceClipRecord` passes it through unvalidated at `clip-types.ts:1021`. §4.1
  supersedes it; because nothing ever wrote it, there is **no migration**.
- `CLIP_LANES = 8` (`clip-types.ts:47`) **equals** `MIXMSTRS_CHANNELS.length`,
  and the mapping is already a shipped product concept —
  `mixmstrs.ts:536-548`: *"A mixmstrs channel is not an anonymous strip — it is
  the SAME index that names a rack lane everywhere else: the automation lane,
  the clip row, the 'assign to channel N' action, the assigned card's border,
  the Launchpad pad."* **mixmstrs channel N ↔ clip lane N is the binding, and it
  needs no new plumbing.**
- Storage: everything is plain JSON on `node.data`. `clips` keyed by
  `clipIndex(slot, lane) = lane * SCENE_STRIDE(64) + slot`; `auto` is a
  **sibling map on the identical key** so notes and automation stay disjoint
  CRDT scopes (`clip-types.ts:239-259`). Transient field list at
  `clip-types.ts:745-756`, scrubbed on duplicate by
  `scrubClipPlayerTransientData`.
- Transport: **no internal BPM and no clock input.** clipplayer locks to the
  first `timelorde` node in the patch (`clipplayer.ts:1093-1109`), free-running
  at 120 bpm if there is none. Loop maths:
  `baseStepDur = 60/bpm/STEP_DIV_SPB[stepDiv]` (`clipplayer.ts:1951`,
  `STEP_DIV_SPB = [1,2,4,8]` at `:128`), `laneStepDur = baseStepDur /
  RATE_MULTS[div]` (`clip-clock.ts:58`), `loopSeconds = lenSteps × laneStepDur`.
- **Launch quantization is the Deluge shared-reference-bar model**, and
  `clip-launch-quantize.ts:67` `nextLaunchBoundary(playing, now)` returns the
  ctx-seconds wrap of the currently-playing clip with the **strictly greatest**
  loop duration (ties → lowest lane), or `null` when nothing plays. Membership
  is decided *purely from the synced `playing[]`*, never a local audio probe
  (`:104`) — that is the collab-convergence guarantee. **This function is the
  recording start seam** (§4.4).
- Three immediacy escapes live in the caller (`clipplayer.ts:1855-1886`): QNT
  off, per-lane NOW, or nothing playing. A queued **STOP** uses the lane's OWN
  wrap, not the reference bar.
- Existing record machinery to parallel, not to reuse:
  `clip-record-machine.ts:25` `RecPhase = 'idle'|'armed'|'recording'|'overdubbing'`
  (KEYS notes); `clip-automation-engine.ts:241` `RecordPhase =
  'idle'|'armed'|'recording'` + `QuantizedRecordWindow` (`:243`) and
  `RecordGate` (`:178`).
- **Four places assume a non-note clip has no length**, and every one is a bug
  the moment an audio clip exists:
  `clipplayer.ts:2065` (`len = clip.kind === 'note' ? … : 1`),
  `clip-scene-repeats.ts:230` (same),
  `clipplayer.ts:1374` (`emitLaneStep` returns `[]` for non-note),
  `clipplayer.ts:2219` (capture phase publishes `null` for non-note).
- clipplayer has **no face** and is not getting one: it is in
  `NON_SHELL_LANE_TYPES` (`legacy-fallback.ts:196-202`) with disposition
  `bespoke-surface`. Its card is tabbed card-locally
  (`ClipplayerCard.svelte:270`, `'grid'|'clip'|'arranger'|'control'`), and the
  pad state enum is `padState()` at `:415-423`
  (`'empty'|'loaded'|'queued'|'playing'`, queued wins over playing). Hardware
  LED vocabulary: `clip-surface-map.ts:54-83`.
- clipplayer's ports: 2 gate inputs, 24 outputs (`pitch/gate/vel` × 8). **No
  audio port in either direction.**

### 1.3 recorderbox (the quality-control and video precedent)

- Quality ladder — `packages/web/src/lib/video/recorderbox-quality.ts`:
  `type RecorderboxQuality = 'high'|'balanced'|'small'` (`:68`),
  `QUALITY_VALUES` (`:78`), `DEFAULT_QUALITY = 'balanced'` (`:76`),
  `coerceQuality` (`:86`), `qualityLabel → 'HIGH'/'BALANCED'/'SMALL'` (`:231`).
  Tiers are knob sets, not codec strings: `{videoBitrateFactor,
  keyFrameInterval, audioBitrate, codecPreference}` (`:107-136`) against
  `BASELINE_H264_BITRATE = 14_000_000` (`:81`).
  **`pickEncodeProfile` never throws and never returns null** (`:191`, `:221`).
  There is **no per-minute or per-take size maths anywhere in recorderbox** —
  that precedent lives in samsloop (§1.4).
- Capture: an **audio-thread AudioWorklet**, not `MediaStreamDestination`
  polling. `packages/dsp/src/recorderbox-capture.ts` — `BATCH_FRAMES = 1024`
  (`:22`), arm/disarm so it never buffers between takes (`:34-45`), mono-safe
  `r = input?.[1] ?? l` (`:53`), posts planar `[L…,R…]` **transferred** (`:65`).
  The reason is written out at `recorderbox-recorder.ts:7-27`: the old
  `MediaStreamAudioTrackSource` path hard-drops at `queueSize >= 8` and
  mediabunny silence-pads the hole — *that discontinuity is the click.*
- Backpressure: `recorderbox-capture-drain.ts` **never drops** (`:74`); the
  queue grows and drains later. Video does the opposite (`addInFlight` drops the
  tick rather than stall rAF, `recorder.ts:462`).
- Ring vs buffer — `recorderbox-audio-ring.ts:20-24` says it plainly: the
  `AudioRingBuffer` **rolls** (discards oldest) and is therefore **wrong for a
  fixed-length take**; the head-anchored twin is `SamsloopCaptureBuffer`.
- Encoder probing: **no `MediaRecorder`, no raw `AudioEncoder`, no
  `isTypeSupported` anywhere in the repo.** Everything is mediabunny
  (`canEncodeVideo`/`canEncodeAudio`) plus a real **encode-and-flush smoke
  test** (`recorder.ts:151-233`), because headless CI reports avc supported and
  then emits zero chunks. Audio codec is **AAC only** (`:113`). **No FLAC and no
  Opus encoder or decoder path exists** — the only `flac`/`opus` hits are
  file-picker `accept` lists relying on the browser's `decodeAudioData`.
- OPFS — `recorderbox-store.ts`: `OPFS_DIR = 'recorderbox'` (`:77`), path
  `recorderbox/<nameSlug>-<nodeSlug>-<epoch>[-cNNN].partial.mp4` (`:98-114`),
  manifest sidecar in IndexedDB keyed by `opfsPath` (`:73-75`) and **written
  before the first byte** (`recorder.ts:616-629`) *"so a crash 100 ms in still
  leaves a recover candidate."* Writes go through `WorkerOpfsWriter`
  (`recorder.ts:1278`), an inline Blob-URL module Worker owning a
  `FileSystemSyncAccessHandle` (worker-only API), positioned + flushed per
  fragment, with a 2 s close timeout. Recovery: `listRecoverable(nodeId?)`
  (`store.ts:250`) filtered to `status:'recording'`, surfaced as an **absolute
  overlay** because the rack tier hard-pins card height. GC only on successful
  delivery (`retireScratch`, `:1136`); **no orphan sweeper exists.**
- Node-keyed registry (#1574) —
  `packages/web/src/lib/ui/modules/node-recorder-registry.svelte.ts`. Its design
  rule, quoted because §4.6 adopts it verbatim (`:46-53`):
  > *"This registry deliberately exposes NO per-card teardown: no `dispose()`,
  > no `release()`, no `detach()`. Its ABSENCE is the guard… a future card
  > cannot re-introduce this bug in an onDestroy, because there is no method to
  > call and `tsc` refuses the attempt before any test runs."*
  `StartRecordingArgs` (`:117`) omits `canvas` **by type** so a caller cannot
  re-open the bug. `sweep(liveNodeIds)` (`:341`) is graph-lifetime.
- **File placement is a gate, not a preference.** `lib/video/**` is hashed
  wholesale for the real-GPU WebGL attest, so #2314 moved the recorderbox
  transport to `packages/web/src/lib/ui/modules/recorderbox-transport.ts` and
  `recorderbox-present-policy.ts:14-17` states the rule. Clip-recording code
  goes in `lib/audio/**` and `lib/ui/**`, **never `lib/video/**`**.

### 1.4 samsloop + twotracks (the audio precedents)

- `packages/web/src/lib/audio/modules/samsloop-record.ts` is **the repo's only
  per-second recording-size maths**: option ladder `[22050, 44100, 48000]` ×
  `[8, 16]` × `[1, 2]` (`:135-137`), defaults **mono / 16-bit / 48 kHz**
  (`:158-162`), `SAMSLOOP_RECORD_BUDGET_BYTES = 3_000_000` (`:63`),
  `SAMSLOOP_RECORD_MAX_SECONDS = 60` (`:80`, *"an ARCHITECTURE BOUNDARY, NOT A
  COMFORT LIMIT"*), `SAMSLOOP_RACK_RECORD_BUDGET_BYTES = 12_000_000` counted **in
  base64 characters** because that is what the relay accounts (`:83-116`),
  `samsloopMaxSecondsExact` (`:403`), `samsloopBindingCap` (`:424`).
- Its enforcement rule is the one §4.5 adopts (`:108-114`): the budget may only
  **shrink the on-screen max** or **refuse to arm with the numbers in the error
  line**. It never truncates a take after the fact.
- `samsloopAchievedRate` (`:250-253`) — *"THE RATE THE BYTES ACTUALLY ARE —
  which is NOT the rate the user picked."* Tagging a take with the requested
  rate made everything play **−148 cents and 8.8 % long**. Generalised in §4.5:
  never store a rate you merely requested.
- `SamsloopCaptureBuffer` (`:764-814`) — head-anchored, fixed capacity, `append`
  is the one hot path at 375 msg/s and replaced an O(n²) grow-copy (8543 ms →
  1.7 ms for a 60 s take).
- `node-samsloop-registry.svelte.ts:62-91` explains **field by field why the two
  registries were not merged** (six of six contract elements differ). It ends
  with an instruction: read it before writing a third one. §4.6 does, and
  writes a third one, with the reasons.
- `twotracks` is the only shipped **overdub-capable** audio recorder:
  `packages/dsp/src/lib/twotracks-engine.ts:16` `TapeState =
  'idle'|'play'|'armed'|'rec'|'overdub'`, a worklet-owned
  `TWOTRACKS_TAPE_LEN = 960_000` frames (≈20 s @ 48 k), carried **out of band**
  in the `.ptperf.zip`. `samsloop-record.ts:68-74` names that as the model that
  takes over past ~60 s *"which does NOT sync the audio to peers."*
- `packages/web/src/lib/graph/performance-zip.ts:43-66` **already has the
  extension point**: `PerformanceMedia.role: 'video' | 'audio'` with a
  `handleId` the restore side routes by. Clip media needs no new plumbing.

### 1.5 The transport / clock lesson

`packages/web/src/lib/blood/blood-pcm-schedule.ts` (`origin/main`, #2312):

> **1. RATE-EXACT.** Frames owed are derived from the CONTEXT CLOCK
> (`ac.currentTime × ac.sampleRate`), not from a constant. A tick that arrives
> late owes the whole gap…
> **2. A CUSHION THAT COVERS THE OBSERVED STALL.**

The measured failure it fixed: a 44.1 kHz-shaped budget spent on a
`setInterval(16)` against a 48 kHz drain produced **29,846 frames/s against
48,000 demanded = 62 % of demand**, so 38 % of every output sample was a hard
zero, and the SCOPE read `0.0000`. The second rule at `:160-174`: *"A NEGATIVE
DEPTH IS NOT A DEBT TO REPAY."*

Both rules are load-bearing here even though our producer is a push worklet
(§4.8).

---

## 2. Prior art

| System | Arm / record semantics | Length semantics | What we adopt | What we reject and why |
|---|---|---|---|---|
| **Ableton Live** (session view) | Per-track arm, then click a slot's record button. Global **Launch Quantization** (default 1 Bar) decides when it starts. Push adds a **Fixed Length** setting (record exactly N bars). Second press ends the take at the next boundary and the clip loops. | Fixed-length = N bars set globally, ahead of time. Free record = press-to-press, rounded to the launch quantum. | **The two-mode split itself.** Fixed Length is Arm–Single; free-record-then-stop is Arm–Endless. Also: arm is per-track, and a track's arm is what makes a slot recordable. | Live's **global** launch quantum. This product already quantizes to the *longest playing clip's* wrap (`nextLaunchBoundary`), a strictly better answer for mixed-length clips, and having two quantum concepts would be two truths. |
| **Bitwig** (clip launcher) | Arm the track, click a blank slot's record button; the transport auto-starts if it was stopped. Separate **Launch Quantization** and **Record Quantization** preferences. | Same as Live in shape. | **Auto-start the transport on arm when it is stopped** (also the Deluge behaviour and already what the KEYS recorder does at `launchpad-control.svelte.ts:1306-1307`). | Bitwig's per-slot record button as a *second* affordance next to the launch button. Our pads are already 31 px in a 352 px dock scrollport; a second hit target per cell is not affordable. Arm is a lane/channel-level control, the pad shows the state. |
| **Synthstrom Deluge** (audio clips / resample) | `REC + audition pad` starts loop recording at the clip's **pre-set length**. Resample = `hold RECORD then PLAY`; repeat the gesture before the loop end and it **auto-stops at the end of the loop**. Count-in is a settings toggle (`SHIFT + TAP TEMPO`). | *"Set any length you want before recording."* Free recording *"will be a multiple of that first loop."* | **All three core behaviours.** Pre-set length → Arm–Single. Stop-resolves-at-the-end-of-the-loop → Arm–Endless. Whole multiples of the unit loop → Endless length quantization. Count-in as an option. The repo already models clipplayer on the Deluge, so this is continuity, not import. | Deluge's automatic **warping** of audio clips to tempo. We have no time-stretcher and writing one is a separate project; §7 Q9 puts the choice to the owner rather than faking it. |
| **Boss RC-505 / loopers** | First pass **defines** the loop length; subsequent passes overdub into it. `1SHOT` stops playback at the end of the phrase rather than looping. | The first take *is* the measure. | **The end-of-phrase stop**, which is exactly the owner's Endless requirement, and the idea that the first take can *define* a length. | The looper convention that the first pass is *always* free-length. Here the launcher already has a musical grid and a reference bar; a free-length first take would sit off-grid against every other clip. Arm–Single with a pre-set length is the grid-native form. |
| **DAW multitrack norms** | Per-track arm; input monitoring; **pre-fader** (post-EQ, pre-fader) vs **post-fader** send taps; punch-in/out at markers. | N/A | **Per-channel arm**, and the **pre/post tap being a named, switchable point** — which mixmstrs already ships for its aux sends (`send{R}Pre`). | **Input monitoring** as a feature. mixmstrs already passes the channel to the master bus; a monitor path would be a second, level-inconsistent copy. **Punch-in/out ranges**: the loop boundary is the only punch point a launcher needs. |
| **recorderbox** (in-repo) | Boolean `node.data.recording`, Y.Doc-synced so a rack-mate can start a take. Node-keyed registry survives card unmount. | Wall-clock; auto-rolls a chunk every ~10 min. | **The quality-selector control shape**, the **node-keyed registry with no teardown method**, the **manifest-before-first-byte** crash model, the **worker `FileSystemSyncAccessHandle`** writer, and the **10-minute architecture boundary**. | Its **wall-clock frame budget**. A video CFR grid can absorb a jittery producer; a loop whose length must be an exact number of samples cannot. |

**The synthesis.** Ableton/Bitwig give the *arm* vocabulary, the Deluge gives the
*length* vocabulary, the RC-505 gives the *stop* vocabulary, and the DAW
convention gives the *tap* vocabulary. All four already have a shipped analogue
in this repo, which is why the design below adds one new worklet and one new
store and otherwise re-points existing seams.

---

## 3. Design overview

```
mixmstrs ch{N} L/R  ──unity insert──►  ChannelMerger ──► Faust worklet ──► master
        (PRE-BOARD)      │
                         └──►  clip-recorder AudioWorklet  (8 stereo inputs, one node)
                                    │  frame-exact, currentFrame-anchored
                                    ▼  planar f32 chunks, transferred
                              node-clip-recorder registry  (lib/ui, node-keyed)
                                    │
                                    ├─► encoder (PCM passthrough | i16 | Opus-in-Worker)
                                    ▼
                              clip media store  (OPFS + IDB manifest)
                                    │  mediaId
                                    ▼
                    clipplayer  node.data.clips[k] = AudioClipRecord{ mediaId, … }
                                    │
                                    └─► AudioBufferSource, loop, started on the boundary
                                             ──► clipplayer audio{N}L / audio{N}R
```

Six decisions carry the design:

1. **The clip owns the arm; mixmstrs owns the tap.** Channel *N* ↔ lane *N* is
   already a shipped product concept, so the binding needs no new state.
2. **One worklet node with eight stereo inputs, not eight recorders.** Sample
   alignment across a multitrack pass is then true *by construction*, not by
   agreement between eight clocks.
3. **Every boundary is a FRAME COUNT**, derived once from `ctx.currentTime`
   and compared against the worklet's own `currentFrame`. No `setInterval`
   budget anywhere.
4. **Media never enters the Y.Doc.** The Y.Doc carries a `mediaId` and a dozen
   integers. Bytes live in OPFS and travel in the `.ptperf.zip`.
5. **PCM is the default** because the multitrack case is eight simultaneous
   streams and PCM is the only tier whose cost is provably a memcpy.
6. **The video tie-in is an interface, not a promise.** `RecordingSession` and
   `ClipMedia` are defined now with two implementations in mind; the audio one
   ships, the video one slots into the same lifecycle later.

---

## 4. The design

### 4.1 Data model

**Supersede `AudioClipRecord`.** It has zero constructors and zero readers
(`clip-types.ts:222-231`, pass-through at `:1021`), so this is a replacement,
not a migration.

```ts
/** An AUDIO clip. Media lives in the clip media store (OPFS); the Y.Doc
 *  carries only the reference and the integers needed to schedule it. */
export interface AudioClipRecord extends ClipBase {
  kind: 'audio';
  /** Content key in the clip media store. NEVER bytes. */
  mediaId: string;
  /** Loop length in STEPS — the same unit a note clip uses, so every piece of
   *  launch/scene/repeat maths that reads `lengthSteps` works unchanged. */
  lengthSteps: number;
  /** Exact recorded frame count. The sample-accurate truth; `lengthSteps` is
   *  the musical intent and the two are reconciled at playback (§4.8). */
  frames: number;
  /** The rate the frames ACTUALLY are (samsloop `achievedRate` lesson) —
   *  the capture context's rate, never a requested one. */
  sampleRate: number;
  channels: 1 | 2;
  format: 'pcm-f32' | 'pcm-i16' | 'opus';
  /** `Date.now()` at commit — the change signature. Two takes of the same
   *  length at the same settings are otherwise byte-identical in metadata and
   *  a player keyed on the rest would keep playing the first (samsloop #1353). */
  takeAt: number;
  /** Provenance, for the pad tooltip and for a later re-record. */
  src?: { nodeId: string; channel: number; tap: ClipRecordTap };
  /** Peak |sample| over the take. A picture input, never painted as a number. */
  peak?: number;
  /** OPTIONAL associated video take — the tie-in seam, unused in v1. */
  videoMediaId?: string;
}

export type ClipRecordTap = 'board-in' | 'post-fader' | 'master';
```

`coerceClipRecord` gains a real `'audio'` branch: require `mediaId`,
`lengthSteps ≥ 1`, `frames ≥ 1`, a finite `sampleRate`, `channels ∈ {1,2}`, a
known `format`; drop the clip otherwise. Today it returns the raw object
unvalidated, which is a hole regardless of this feature.

**Fix the four `len = 1` assumptions.** The single change is to read
`lengthSteps` off *any* clip kind that has one:

| site | today | becomes |
|---|---|---|
| `clipplayer.ts:2065` | `clip.kind === 'note' ? max(1, lengthSteps) : 1` | `clipLengthSteps(clip)` — one shared helper in `clip-types.ts` |
| `clip-scene-repeats.ts:230` | same expression, restated | the same helper |
| `clipplayer.ts:1374` `emitLaneStep` | `return []` for non-note | note events for `'note'`, `[]` for `'audio'` (audio does not emit steps — it is scheduled once at launch, §4.9) |
| `clipplayer.ts:2219` capture phase | `null` for non-note | publish for any clip with a length; the audio recorder needs the phase too |

**Automation on audio clips — closing the open seam.** The automation redesign
(`.myrobots/plans/automation-redesign-2026-07-16.md:262-265`) explicitly leaves
this unspecified. **Answer: yes, and it costs nothing.** `data.auto[k]` is keyed
by `clipIndex`, not by clip kind, and its length is *linked to the clip's*
`lengthSteps` — which an audio clip now has. Relaxing the four kind checks
(`clipplayer.ts:2051`, `:2192-2195`, `:480`, `:2261`) to "any clip with a
length" is the whole change. **v1 does not build the UI for it**; the data model
just refuses to foreclose it, which is what that plan asked for.

**New transient field.** `data.audioRec` joins
`CLIP_PLAYER_TRANSIENT_DATA_FIELDS` (`clip-types.ts:745`) or a duplicated
clipplayer is born recording:

```ts
export interface AudioRecState {
  lane: number;          // 0..CLIP_LANES-1
  slot: number;          // 0..SCENE_STRIDE-1
  mode: 'single' | 'endless';
  phase: 'armed' | 'recording' | 'stopping';
  /** Frame the take starts on; null while armed and not yet resolved. */
  startFrame: number | null;
  /** Frame the take ends on; set at arm time for `single`, at STOP for
   *  `endless`, null while an endless take is open. */
  stopFrame: number | null;
  /** The unit loop in frames — what `endless` takes a whole multiple of. */
  unitFrames: number;
  /** Single-writer lease, like `automation.recorderId`. */
  recorderId: string;
}
```
Stored as an **array of length `CLIP_LANES`** (`(AudioRecState|null)[]`), so
eight lanes arm independently and eight peers can each own one lane.

### 4.2 Where the audio is tapped

**"Pre-board" = the raw patched channel input, before `eq3band`.** It is the
only point on the module where the audio is what the player patched in. Note
that `send{R}Pre = 1` already means *post-EQ, post-comp, pre-fader*
(`mixmstrs.dsp:81-84`), so the two terms are not synonyms on this module —
§7 Q1 asks the owner to confirm the reading before anything is built.

**How.** A unity `GainNode` per audio input port, inserted in the factory:

```ts
// mixmstrs factory, replacing mixmstrs.ts:898-900
const boardIn: GainNode[] = AUDIO_IN_PORTS.map((_, i) => {
  const g = ctx.createGain();
  g.gain.value = 1;
  g.connect(merger, 0, i);
  return g;
});
AUDIO_IN_PORTS.forEach((id, i) => inputsMap.set(id, { node: boardIn[i]!, input: 0 }));
```

The recorder taps `boardIn[2*(N-1)]` / `boardIn[2*(N-1)+1]` for channel *N*.

Three properties that make this the cheap option:

- **ART is not in this path.** `art/scenarios/mixmstrs/*` render through
  `renderFaustOffline`, which instantiates the Faust wasm directly and never
  calls the JS factory. **No ART baseline moves.**
- **The DSP is untouched**, so `packages/dsp/dist/mixmstrs.{wasm,sha}` do not
  move and there is no dsp re-pin.
- **`x * 1.0` is identity for every finite IEEE-754 float.** But this repo has
  been bitten by exactly this kind of claim: `mixmstrs.dsp:205-216` records that
  the algebraically-identical pre/post crossfade moved the send baselines by
  1-2 ULP on ~35 % of samples. **So the identity is asserted, not assumed** —
  §6 slice 3 pins a negative-controlled `OfflineAudioContext` leg comparing
  `masterL`/`masterR` with and without the insert, and the PR reports the max
  |Δsample| rather than claiming zero.

**The post-mix seam, defined now, dark in v1.** A module-level `recTap` param
with three declared options:

| value | label | source | status |
|---|---|---|---|
| 0 | `BOARD IN` | `boardIn[2i]` / `boardIn[2i+1]` | **ships** |
| 1 | `POST FADER` | requires the DSP's own noted future option — 8 stereo taps in place of the 8 mono ones (`mixmstrs.dsp:277`), outputs 6-21 | declared, disabled |
| 2 | `MASTER` | the existing `masterL`/`masterR` splitter outputs | **cheap** — no DSP change; enable in the same slice if the owner wants it |

`MASTER` costs nothing today and is genuinely useful (record the whole mix into
a clip). Whether to ship it in v1 is §7 Q1b. `POST FADER` is the one that
carries a DSP change and a full ART re-pin, and it is deliberately the one
deferred — the `.dsp` already names it as its own future option, and the
existing mono taps cannot serve because they are phase-blind
(`mixmstrs.ts:286-290`).

**Dual-mono interaction.** mixmstrs is natively stereo per channel, so it is not
in the `dual-mono.ts` wrapped set. But the shipped auto-wire policy
double-patches a mono source into **both** legs of a stereo target
(`stereo-autowire.ts`, owner-locked 2026-08-07), and the same file bans
detection by name. **So the recorder always captures 2 channels and always
stores `channels: 2` unless the user *declared* a mono tier.** There is no
"is it really stereo?" check anywhere in this design.

### 4.3 The recorder

**One `AudioWorkletProcessor`, `clip-recorder`, per mixmstrs node**, with
`numberOfInputs: 8` and `channelCount: 2, channelCountMode: 'explicit'` per
input. It lives at `packages/dsp/src/clip-recorder.ts`, alongside
`recorderbox-capture.ts` and `samsloop-tap.ts`, and follows their shape: no
top-level export, `registerProcessor` at the bottom, captured in tests via the
shim (`dsp-worklet-no-top-level-export`).

```ts
interface ArmMsg   { type: 'arm';    lane: number; startFrame: number; stopFrame: number | null; }
interface StopMsg  { type: 'stopAt'; lane: number; stopFrame: number; }
interface CancelMsg{ type: 'cancel'; lane: number; }
// out:
interface ChunkMsg { type: 'chunk'; lane: number; firstFrame: number; frames: number; data: Float32Array; }
interface DoneMsg  { type: 'done';  lane: number; frames: number; }
```

`process()` is the whole design:

```ts
process(inputs: Float32Array[][]): boolean {
  const q0 = currentFrame;              // AudioWorkletGlobalScope, per spec
  for (let lane = 0; lane < 8; lane++) {
    const s = this.state[lane];
    if (!s) continue;
    const l = inputs[lane]?.[0]; if (!l) continue;
    const r = inputs[lane]?.[1] ?? l;   // mono-safe, recorderbox-capture.ts:53
    const q1 = q0 + l.length;
    // slice the quantum against the take window — sample offsets, not seconds
    const from = Math.max(0, s.startFrame - q0);
    const to   = Math.min(l.length, (s.stopFrame ?? Infinity) - q0);
    for (let i = from; i < to; i++) { … append …; s.written++; }
    if (s.stopFrame !== null && q1 >= s.stopFrame) this.finish(lane);
  }
  return true;
}
```

`currentFrame` is already used in this repo for exactly this reason —
`packages/dsp/src/lfo.ts:207-208`: *"derive it from `currentFrame` /
`sampleRate`"* — and is declared at `packages/dsp/src/worklet-globals.d.ts:36`.

Why this shape:

- **Exactness.** `to - from` summed over the take is `stopFrame - startFrame`
  exactly, whatever the main thread is doing. A take is the requested number of
  samples or it is cancelled; there is no third outcome.
- **Alignment.** All eight lanes are sliced inside one `process()` call against
  one `currentFrame`, so two channels armed together are aligned to the sample
  by construction. §6 slice 7 asserts it by cross-correlating two takes of the
  same source recorded on two channels and requiring a **0-sample** lag.
- **Push, so rate-exactness is free.** The blood lesson (§1.5) bites a *timer*
  producer feeding a context-rate consumer. Here the audio thread produces and
  the main thread consumes, which is recorderbox's arrangement, and the
  main-thread side is **backpressured and never drops**
  (`recorderbox-capture-drain.ts:74`). The blood rules still apply to two
  places: the boundary maths must come from `ctx.currentTime × ctx.sampleRate`,
  never from a tick count; and an OPFS write that falls behind must **stall the
  drain, never skip a chunk** — a skipped chunk is a hole exactly like the
  silence-padded one that made recorderbox click.
- Chunk size **4096 frames** (~85 ms at 48 k, ~12 posts/s/lane, ~94 posts/s at
  full multitrack), planar `[L…,R…]`, `postMessage(data, [data.buffer])`. Larger
  than recorderbox's 1024 because there is no muxer deadline to feed, and eight
  lanes at 1024 would be 375 posts/s.

**Fixed-length takes use a head-anchored accumulator, not a ring.** For
`single`, the frame count is known at arm time, so the main thread pre-allocates
one `Float32Array(frames × channels)` and each chunk writes at its own
`firstFrame` offset — `SamsloopCaptureBuffer`'s model
(`samsloop-record.ts:764-814`), and explicitly **not** `AudioRingBuffer`, which
rolls (`recorderbox-audio-ring.ts:20-24`). For `endless` the length is unknown,
so chunks stream straight to OPFS and memory stays at one chunk plus the
encoder's window.

### 4.4 The arm state machine

```
                 ┌──────────────────────── disarm / re-arm (cancel) ───────────┐
                 │                                                             │
   ┌────────┐  arm(single|endless)   ┌────────┐   startFrame reached  ┌───────────┐
   │  IDLE  │ ─────────────────────► │ ARMED  │ ────────────────────► │ RECORDING │
   └────────┘                        └────────┘                       └───────────┘
        ▲                                 │                              │      │
        │                     transport stop / cancel                    │      │  mode = single
        │                                 │                    STOP      │      │  stopFrame reached
        │                                 ▼               (mode=endless) │      │
        │                             (discard)                          ▼      ▼
        │                                                        ┌──────────┐  ┌───────────┐
        └───────────────── commit ◄──────────────────────────────│ STOPPING │  │ COMMITTING│
                                                                 └──────────┘  └───────────┘
                                                                  stopFrame = next whole
                                                                  multiple of unitFrames
```

**Resolving the boundaries.** All three quantities are computed **once**, on the
main thread, at the moment the phase changes, and are then frames:

```
unitFrames  = round(lengthSteps × laneStepDur(baseStepDur, divIndex) × ctx.sampleRate)
startFrame  = round(boundaryTime × ctx.sampleRate)
stopFrame   = startFrame + unitFrames                                    // single
            = startFrame + ceil((stopReq − startFrame) / unitFrames) × unitFrames   // endless
```

`boundaryTime` comes from **`nextLaunchBoundary(collectPlayingClocks(), now)`**
(`clip-launch-quantize.ts:67`) — the same shared reference bar a launch uses, so
a recorded take is phase-locked to the rest of the rack by construction and
every peer names the same musical wrap.

**What "1 loop" means, case by case:**

| situation | `lengthSteps` for the take | `boundaryTime` |
|---|---|---|
| target slot already holds a clip | that clip's `lengthSteps` | `nextLaunchBoundary(...)` |
| target slot empty, **something else is playing** | the **reference bar** — the longest playing clip's `lenSteps × its rate`, re-expressed in this lane's steps, so the new clip is exactly one reference bar | `nextLaunchBoundary(...)` |
| target slot empty, **nothing playing at all** | `DEFAULT_CLIP_STEPS = 16` at the lane's rate = **one bar** at the default 1/16 grid | transport start, or `now + countIn` |
| transport stopped | as above; arming **starts the transport** (Bitwig/Deluge, and already what `keysQueueRec` does at `launchpad-control.svelte.ts:1306-1307`) | first step of the restarted transport |

The empty-launcher case is the one the owner flagged and it has a clean answer
because clipplayer already has a tempo without a clock cable: **TIMELORDE's
`bpm` param, or 120 when there is no TIMELORDE in the rack**
(`clipplayer.ts:1105-1109`). *"One loop"* is therefore always defined, even on
an empty rack. **Count-in** is offered as an option (`0` / `1 bar`), default
**off**, matching the Deluge's default and §2.4 of the KEYS record plan which
left count-in open; §7 Q4.

**Transitions, exhaustively:**

| from | event | to | effect |
|---|---|---|---|
| idle | arm(single) | armed | resolve `unitFrames` + `startFrame` + `stopFrame`; start transport if stopped; refuse with a reason if the budget check fails (§4.5) |
| idle | arm(endless) | armed | as above, `stopFrame = null` |
| armed | arm(same mode) | idle | **cancel** — re-tap disarms, matching `armTransition` (`clip-record-machine.ts:59`) |
| armed | arm(other mode) | armed | switch mode in place; re-resolve `stopFrame` |
| armed | `currentFrame ≥ startFrame` | recording | worklet punches in mid-quantum at the exact sample |
| armed | transport stop | idle | discard; nothing was captured |
| recording | `stopFrame` reached (single) | committing | worklet emits `done`, main thread encodes + commits |
| recording | STOP (endless) | stopping | resolve `stopFrame` to the next whole `unitFrames`; pad shows the countdown |
| recording | CANCEL (endless or single) | idle | discard the whole take, free the OPFS scratch |
| stopping | STOP again | stopping | **no-op**, deliberately. A second STOP meaning "stop sooner" would produce a partial loop — the one outcome this mode exists to prevent. CANCEL is the escape. |
| stopping | `stopFrame` reached | committing | commit `n × unitFrames` |
| recording/stopping | transport stop | committing (endless, ≥1 whole unit) / idle (single, or endless with <1 unit) | never commit a partial loop |
| recording/stopping | budget ceiling reached | committing | auto-stop at the **previous** whole `unitFrames`, announced on the pad; samsloop's cap-stop, which announces itself (`samsloop-record.ts:108-114`) |
| committing | encode+write ok | idle | `clipUndoTransact` writes the `AudioClipRecord`; the take is one undo unit |
| committing | encode or write fails | idle | scratch + manifest **kept** as a recover candidate (recorderbox `:1064`); pad shows the recover affordance |
| any | node removed / `sweep()` | — | registry abandons; scratch survives for recovery |

**Overdub.** v1 is **replace-only**: recording into a slot that holds an audio
clip replaces it, inside one `clipUndoTransact` so undo restores the old take.
Audio sound-on-sound is a real feature with a shipped in-repo engine
(`twotracks-engine.ts` `recordSpan(..., overdub)`), and it deserves its own
design rather than being smuggled in — §7 Q7. Interplay with the **note**
overdub model is nil by construction: the KEYS recorder's `data.noteRec` targets
note clips and `data.audioRec` targets audio clips, and a slot holds exactly one
kind. The two arm states are separate fields for the same reason the plan kept
`noteRec`, `automation` and `recording` separate — three record surfaces that
look alike and are not.

### 4.5 Quality

**The control shape is recorderbox's** — a named roster with three ordered
values, a `coerce*` that can never fail, and labels that are the only permitted
resting text (`recorderbox-quality.ts:68-86`, `:231`; and the face spec's ruling
that `HIGH`/`BALANCED`/`SMALL` are legal because they are **option names**).

```ts
export type ClipRecordQuality = 'studio' | 'standard' | 'compact';
export const CLIP_QUALITY_VALUES = ['studio', 'standard', 'compact'] as const;
export const DEFAULT_CLIP_QUALITY: ClipRecordQuality = 'studio';
export function coerceClipQuality(v: unknown): ClipRecordQuality; // → default on anything invalid
export function clipQualityLabel(q): 'STUDIO' | 'STANDARD' | 'COMPACT';
```

**The ladder, at a 48 kHz context, stereo.** `B/s = rate × bytesPerSample ×
channels`; MB = 10⁶ B.

| tier | format | bytes/s | MB/min | 4 bars @120bpm (8 s) | 8 lanes × 4 bars | encode cost | clips above 0 dBFS? |
|---|---|---|---|---|---|---|---|
| **`studio` (default)** | PCM f32, context rate, stereo | 384 000 | **23.0** | 3.07 MB | 24.6 MB | **zero** — the samples are already f32 | **no** |
| `standard` | PCM i16, context rate, stereo | 192 000 | **11.5** | 1.54 MB | 12.3 MB | 1 multiply + round per sample (~0.2 % of one core at 8×) | yes, at ±1.0 |
| `compact` | Opus 128 kb/s, 48 kHz, stereo | 16 000 | **0.96** | 0.128 MB | 1.02 MB | **a Worker encoder per lane** | n/a (float domain preserved to the encoder) |

**Why `studio` is the default and not overkill.**

- The tap is **pre-board**, and `mixmstrs.ts:580-585` records that the fully
  correlated worst case into this module's master is `6.7187×` at the shipped
  defaults — *"TWO hot channels already clip and nothing here limits."* A hot
  module patched into a channel can exceed ±1.0 **before** the board sees it.
  i16 would clip it permanently and silently; f32 cannot.
- It costs **no conversion at all**. The worklet already holds f32; `studio` is
  a memcpy from the audio thread to OPFS. That is the cheapest tier by CPU,
  which is the resource that actually matters when eight lanes record at once.
- The size is not the constraint it looks like: the real unit is a **loop**, and
  a 4-bar loop is 3 MB. A full 8×8 grid of 4-bar takes is ~197 MB in OPFS, which
  is well inside a Chromium origin quota. Endless takes are what need a ceiling,
  and they have one.

**What is deliberately NOT on the ladder, and why.**

- **No 96/192 kHz.** The AudioContext runs at 48 kHz (44.1 on some hosts).
  Storing a higher number would be tagging a buffer with a rate it merely
  requested — the exact failure `samsloopAchievedRate` exists to prevent
  (`samsloop-record.ts:250-253`, measured at −148 cents and 8.8 % long). The
  stored `sampleRate` is always `ctx.sampleRate`, full stop.
- **No FLAC.** There is no FLAC encoder in the browser and none in the repo
  (§1.3). Shipping one means shipping a wasm codec for ~40 % over i16.
- **No 24-bit.** JS has no i24; it is three `DataView` writes per sample for
  25 % over i16, and `studio` already covers the "don't lose anything" case.
- **No AAC**, even though recorderbox uses it, because AAC is lossy *and* has a
  encoder-imposed frame delay that has to be trimmed to keep a loop exact. Opus
  has the same issue and its pre-skip is at least a declared constant — see
  below.

**The `compact` tier's two conditions.** It is the only tier that is not a
memcpy, and it carries two facts the design must state rather than discover:

1. **Encoding runs in a Worker, one per recording lane, never on the main
   thread.** `recorderbox-quality.ts:12-38` already records the measured
   consequence of the alternative: a software encode starves the realtime audio
   thread into clicks. Eight simultaneous Opus encoders is the resource risk
   that argues for PCM as the multitrack default.
2. **Opus has a 6.5 ms pre-skip**, so a decoded Opus take is *longer* than the
   frames that went in. The store records `frames` (the true recorded count) and
   the playback path trims the pre-skip on decode. If that cannot be made exact
   the honest fallback is to **cap `compact` to endless takes only** and refuse
   it for Arm–Single, where the length promise is the whole feature. §7 Q2.
3. Availability is **probed, never assumed** — recorderbox's smoke-test lesson
   (`recorder.ts:151-233`, "headless CI reports supported and emits zero
   chunks"). If `AudioEncoder` with `{codec:'opus'}` fails a real
   encode-and-flush, `compact` is **absent from the roster**, not selectable and
   broken.

**Budgets, and the samsloop enforcement rule.**

```ts
export const CLIP_TAKE_BUDGET_BYTES = 192_000_000;  // one take
export const CLIP_TAKE_MAX_SECONDS  = 600;          // architecture boundary, = recorderbox's chunk roll
export const CLIP_MIN_RECORD_SECONDS = 0.25;
```

| tier | budget-bound max | seconds-bound max | binding |
|---|---|---|---|
| `studio` | 500 s | 600 s | **budget** — 8 min 20 s |
| `standard` | 1000 s | 600 s | **seconds** — 10 min |
| `compact` | 12 000 s | 600 s | **seconds** — 10 min |

Plus a **live OPFS headroom check** via `navigator.storage.estimate()` before
arming, and the rule from `samsloop-record.ts:108-114` adopted verbatim: the
budget may only (a) **shrink the max shown before you arm**, or (b) **refuse to
arm with the numbers in the message**. It never shortens a take in progress
beyond the cap-stop, which announces itself, and it never drops bytes after the
fact.

⚠ **The samsloop rack ledger does not apply and must not be copied.** That
budget exists because samsloop's bytes ride the **Yjs envelope** and the relay
accounts them (warn 16 MB / crit 24 MB per rack). Clip media never enters the
Y.Doc, so the relay never sees it. The governing limit here is the **OPFS origin
quota** and the `.ptperf.zip` size, which are different quantities and must be
measured as themselves.

### 4.6 Storage, sync, and recovery

**Three tiers, and only the first is shared automatically.**

| what | where | who sees it |
|---|---|---|
| `AudioClipRecord` metadata (~120 bytes) | `node.data.clips[k]`, Y.Doc | every peer, immediately |
| the samples | OPFS, `clipmedia/<mediaId>.<ext>` | **this browser only** |
| a manifest per in-flight take | IndexedDB `patchtogether-clipmedia`, keyed by opfs path | this browser; the recovery scan |
| a saved performance | `.ptperf.zip` `media/` with `role: 'audio'` | whoever the file is given to |

A peer without the media renders the pad as **"clip present, media absent"** —
the same shape `video-file-store.ts:23-30` already ships for VIDEOBOX (*"a peer
that doesn't have the handle simply gets a `null` back and shows the re-link
prompt"*). It is a known, named state, not a silent failure. §7 Q3 asks whether
v1 should also upload takes so collaborators hear them live; the answer changes
the relay's byte accounting and is not a decision to make inside this design.

**`packages/web/src/lib/audio/clip-media-store.ts`** — modelled on
`recorderbox-store.ts`, in `lib/audio` (never `lib/video`, §1.3):

```ts
const OPFS_DIR = 'clipmedia';
const DB_NAME = 'patchtogether-clipmedia', STORE = 'manifests'; // keyPath: 'opfsPath'

interface ClipMediaManifest {
  mediaId: string; nodeId: string; lane: number; slot: number;
  startedAt: number; status: 'recording' | 'done';
  format: AudioClipRecord['format']; sampleRate: number; channels: 1 | 2;
  frames: number;           // updated as chunks land; the recovery length
  unitFrames: number;       // so a recovered endless take truncates to whole loops
  lengthSteps: number;
}

putChunk(mediaId, position, bytes): Promise<void>   // worker sync-access-handle write
finish(mediaId, frames): Promise<void>
read(mediaId): Promise<File>
listRecoverable(nodeId?): Promise<ClipMediaManifest[]>
remove(mediaId): Promise<void>
gc(liveMediaIds): Promise<number>                   // ← recorderbox has none; we ship one
```

- **The manifest is written before the first byte**, so a crash 100 ms in leaves
  a recover candidate (`recorder.ts:616-629`).
- Writes go through an **inline Blob-URL module Worker** owning a
  `FileSystemSyncAccessHandle`, positioned + flushed per chunk, with a close
  timeout so a wedged worker never hangs a commit
  (`recorder.ts:1278-1401`). PCM is trivially resumable — a partial file is a
  valid shorter take truncated to the last whole `unitFrames`.
- **A GC exists**, unlike recorderbox's (`store.ts:1136-1145` retires only on
  successful delivery and *"there is no background GC / orphan sweeper"*). A
  clip media file is referenced by exactly one `mediaId` in one `node.data`, so
  the live set is derivable, and `gc(liveMediaIds)` runs on the same
  graph-lifetime `$effect` in `Canvas.svelte` that already calls
  `nodeRecorder.sweep` / `nodeSamsloop.sweep` (`Canvas.svelte:2575-2576`).
  Deleting a clip therefore actually frees the bytes, which a launcher needs and
  a single-take video sink did not.

**`packages/web/src/lib/ui/modules/node-clip-recorder-registry.svelte.ts`** —
the third node-keyed registry, written after reading
`node-samsloop-registry.svelte.ts:62-91`, which explains field by field why the
first two were not merged. This one differs from **both**:

| | node-recorder (video) | node-samsloop (audio) | **node-clip-recorder** |
|---|---|---|---|
| pump | rAF PULL from a GL engine | port PUSH | **port PUSH** |
| render lease | yes | no | no |
| concurrency | one take per node | one take per node | **up to 8 takes per node** |
| on stop | filename + on-disk artifact | encode → `node.data.sample` | **encode → OPFS → `clips[k]` on a *different node*** |
| boundary | wall clock | byte cap | **audio frames from the transport** |
| sweep leaves | a recover candidate | nothing | **a recover candidate** |

The last row is the reason it cannot be either of the others: the recorder lives
on **mixmstrs** and the commit lands on **clipplayer**. And the #1574 guard is
adopted verbatim — **no `dispose()`, no `release()`, no `detach()`**; the only
ways a take ends are `stop()`, the frame boundary, and `sweep()`. The type of
the start argument omits any surface handle so a card cannot re-open the bug.

### 4.7 Multitrack

**Eight channels into eight clips in one pass.** Arming *k* lanes and hitting
launch produces *k* clips that start on the same sample.

The guarantee is structural and rests on three facts already established:
one worklet node slices all eight lanes inside one `process()` against one
`currentFrame` (§4.3); one `startFrame` is broadcast to all armed lanes; and
`nextLaunchBoundary` derives that frame from the **synced** `playing[]` array,
never a local probe (`clip-launch-quantize.ts:104`), so every peer names the
same wrap.

Per-lane `stopFrame` may differ — lane 3 at rate `2x` with a 16-step clip and
lane 5 at `1x` with 32 steps have different `unitFrames`, and each stops at its
own whole multiple. That is correct: the takes are polyrhythmic in exactly the
way the lanes already are.

Cost at full multitrack, `studio`: 8 × 384 kB/s = **3.07 MB/s** of memcpy plus
OPFS writes, ~94 `postMessage`/s of transferred buffers, zero encode. A worker
`FileSystemSyncAccessHandle` sustains two orders of magnitude more than that.

### 4.8 Alignment, latency, and the clock

**Rule 1 — every budget comes from the context clock.**
`blood-pcm-schedule.ts:49-67`: *"Frames owed are derived from the CONTEXT CLOCK
(`ac.currentTime × ac.sampleRate`), not from a constant. A tick that arrives late
owes the whole gap."* The measured cost of the alternative was 62 % of demand
and a SCOPE reading `0.0000`. Here: `startFrame`/`stopFrame`/`unitFrames` are
computed from `ctx.currentTime` and `ctx.sampleRate` once, and the worklet
compares against `currentFrame`. **There is no `setInterval` in the capture
path and no frame count derived from a tick count anywhere.**

**Rule 2 — an underrun is not a debt.** `blood-pcm-schedule.ts:160-174`: *"If
the ring ran dry the audio thread did not wait for us… those frames are GONE,
not pending."* The analogue here is the drain: if OPFS falls behind, the drain
**stalls** (recorderbox's awaited `add()`,
`recorderbox-capture-drain.ts:74`) — it never skips a chunk to catch up. A
skipped chunk is a hole in the middle of a loop, which is the silence-padded
discontinuity that made recorderbox click (`recorder.ts:7-27`).

**Loop-boundary alignment.** `unitFrames` is `round(loopSeconds × sampleRate)`,
so the take is an integer number of samples that is *within half a sample* of
the musical loop. At 120 bpm / 1 bar / 48 kHz that is 96 000 frames exactly. At a
tempo that does not divide evenly the rounding error is ≤ 0.5 sample per loop
and **does not accumulate**, because `stopFrame` for an endless take is
`startFrame + n × unitFrames` — computed from the anchor, never by repeated
addition. (The automation plan already requires closed-form wrap times for the
same reason.)

**Monitoring latency, stated honestly.** The clip is aligned to the **clock**,
not to the player's ears. A performer hearing the master bus is hearing the
signal `ctx.outputLatency` late (typically 10-50 ms) and will play that late.
Three positions were considered:

- Auto-subtract `ctx.outputLatency` from `startFrame`. **Rejected** — it is
  wrong for the dominant case. Recording another *module* in the rack is
  resampling: the source is clock-driven, so offset 0 is exactly right, and an
  automatic shift would misalign it by up to 50 ms.
- Detect whether the source is "played". **Rejected by policy** — the stereo
  plan bans runtime "is it really X?" heuristics by name.
- **Ship a declared offset.** A `recOffset` control in **milliseconds, signed,
  default 0**, applied to `startFrame` only. A player compensating for their own
  monitoring sets it once; a resampler leaves it alone. §7 Q6 asks whether the
  default should instead be `−ctx.outputLatency`.

**Strip latency does not apply**, and that is a real argument for pre-board as
the v1 tap: the EQ and compressor are minimum-phase IIR sections whose group
delay would have to be compensated at a post-fader tap. Tapping before them
means there is nothing to compensate and nothing to get wrong.

### 4.9 UX surfaces

#### mixmstrs face — one new band, three control families

The module's rule is *every affordance is a `ParamDef`* — the argument for
having no panel (`mixmstrs.ts:275-290`). Honouring it means the record controls
are **real params**:

```ts
// per channel, inside the buildParams() loop — the NAME is load-bearing
params.push({ id: `ch${ch}_rec`, label: `${ch}Rc`, defaultValue: 0, min: 0, max: 2,
  curve: 'discrete', options: [
    { value: 0, label: 'off' },
    { value: 1, label: '1×',  title: 'Arm — record exactly one loop, then stop' },
    { value: 2, label: '∞',   title: 'Arm — record until STOP, ending at the loop end' },
  ] });

// bus-scoped
params.push({ id: 'recQuality', label: 'Qual', defaultValue: 0, min: 0, max: 2,
  curve: 'discrete', options: [ …STUDIO / STANDARD / COMPACT… ] });
params.push({ id: 'recTap', label: 'Tap', defaultValue: 0, min: 0, max: 2,
  curve: 'discrete', options: [ …BOARD IN / POST FADER / MASTER… ] });
```

Five things fall out **with no further edits**, and that is the whole reason for
the naming:

- `mixmstrsChannelIndex` (`mixmstrs.ts:182-187`) matches `/^ch(\d+)_/`, so
  `ch{N}_rec` is **claimed as channel-scoped automatically** → it gets lane
  colour *N* via `channelAccent`, it lands in `bareCells`, and the SCOPE
  partition asserted by `mixmstrs-face-model.test.ts` still holds. A param named
  `rec{N}` would be silently mis-classified as bus-scoped and would take lane
  ranks it must not have.
- Every param gets a CV input from `buildInputs()`, so **a gate can arm a
  channel**. That is a genuinely modular affordance and it is free.
- The bus-scoped block grows 11 → 13, still longer than the largest lane tier,
  so the "no lane tier paints a channel control" invariant is unchanged.

Two things do **not** fall out and must be done by hand:

- `mixmstrsSectionPlan` (`mixmstrs-sections.ts:84-128`) must add `ch${ch}_rec`
  to each channel's pick list and `recQuality`/`recTap` to Master, or those
  jacks silently do not render — the exact failure that file exists to make
  testable (`:8-13`).
- `ch{N}_rec` / `recQuality` / `recTap` have **no backing Faust param**, so each
  needs the comp-macro treatment: a shadow `GainNode` with a DC-1 source and an
  observation analyser, plus `markJsConsumedParam` (`mixmstrs.ts:802-837`), or
  `art/scenarios/cv-terminal` flags them as dead terminals.

**Layout: a 5th page `record`, 10 controls, no tab rail.**

```
{ id: 'record', label: 'record',
  controls: [ ...CHANNELS.map(c => `ch${c}_rec`), 'recTap', 'recQuality' ],
  clusters: [
    { label: 'arm',     controls: CHANNELS.map(c => `ch${c}_rec`) },  // column N = channel N
    { label: 'source',  controls: ['recTap'] },
    { label: 'quality', controls: ['recQuality'] },
  ] }
```

- **5 bands < `DOCK_TAB_MIN_BANDS = 7`**, so the dock does not become a tab rail
  and the fader bank survives. The face spec's own budget: *"a sixth is
  affordable; a SEVENTH destroys the only thing this face exists for."* This is
  the fifth. It also means the record band and the deferred `pan{N}` band cannot
  both be new pages — **§8 sequencing.**
- **10 cells = `DOCK_ROW_MAX_CONTROLS` exactly**, so the arm cluster packs as one
  row of eight under the same column alignment every other cluster uses: column
  *N* is channel *N*, all the way down.
- **Resting text is three option names per cell** (`off` / `1×` / `∞`), which is
  the permitted "option/landmark NAMES" role. No elapsed time, no take size, no
  sample count anywhere on the faceplate. The numbers go to `title`/`aria`, per
  the recorderbox face spec's treatment of its own `mm:ss`.
- Cost: +10 cells on a face already at 92, i.e. `85.2 s → 91.2 s` under the
  spec's `30 000 + 600 × cells` formula (`210.6 s → 228.6 s` under
  `SLOW_RENDER`). A **+6 s** delta, under the 2-minute sign-off threshold — but
  the face is already over it, so the PR names the number rather than leaving it
  to be found.

#### The clip grid — three new pad states

`padState()` (`ClipplayerCard.svelte:415-423`) gains three, in priority order
above `queued`:

| state | picture | why this picture |
|---|---|---|
| `rec-armed` | hollow ring in the lane colour, slow pulse | matches the shipped "armed = flashing yellow" for `noteRec` and the Launchpad `LED_QUEUED_LO/HI` blink; an outline reads as "reserved, not yet content" |
| `rec-active` | filled red, with a **fill arc** sweeping 0→1 across `unitFrames` | the fill is the take's own progress — a *picture* of a number, which is the permitted form. Red is already this product's record colour (`RecorderboxCard.svelte` `#ff3b30`, the arranger `●`) |
| `rec-stopping` | red, plus the existing `cd-yellow` / `cd-red` four-beat countdown classes | **reuse, not invention**: `automationCountdownColor` (`clip-automation-render.ts:91`) and the `cd-*` classes already flash 🟡🟡🔴🔴 over the last four beats before a wrap. Endless-stop is exactly that event |

`data-state` carries the same string, so an e2e asserts a *state*, not a colour.
Hardware LEDs extend `clip-surface-map.ts:54-83` with
`LED_REC_ARMED` / `LED_REC_ACTIVE` / `LED_REC_STOPPING`, keeping the placement
helpers pure.

Where the arm gesture lives on the card, given a 352 px dock scrollport and
31 px pads: **not a second button per cell.** The lane already has a control
column — the per-lane RATE select over the teal automation-arm `◉`
(`ClipplayerCard.svelte:2157-2202`). A **red `⏺` three-state control** joins it,
so a lane's record arm sits with its other lane-level controls, and a specific
*slot* is chosen by right-clicking a pad → "Record into this slot". Arming from
mixmstrs targets the lane's **first empty slot** (Live's session-record / Push
"New" behaviour). Both write the same `data.audioRec[lane]`.

⚠ **This changes `ClipplayerCard.svelte`**, which the batch-7 face spec froze
with a standing "do not change the card" instruction *for face-migration
purposes*. That instruction is about not promoting it in a face batch, not about
never shipping a feature — but it means every slice touching the card needs
`task vrt:one -- clipplayer`, an owner preview, and **no auto-merge**. §7 Q10
asks the owner to confirm the reading.

### 4.10 The video tie-in

The interfaces below are defined **now**, in v1, with only the audio
implementation built. Nothing about them is audio-specific.

```ts
// packages/web/src/lib/audio/clip-media.ts   ← media is kind-agnostic
export type ClipMediaKind = 'audio' | 'video';
export interface ClipMedia {
  mediaId: string;
  kind: ClipMediaKind;
  /** Container/codec, e.g. 'pcm-f32' | 'pcm-i16' | 'opus' | 'video/mp4;codecs=avc1'. */
  format: string;
  bytes: number;
  /** THE MUSICAL LENGTH, in transport frames. Both kinds carry it, so an
   *  audio take and its video take are the same length by construction. */
  frames: number;
  /** Kind-specific truth. */
  audio?: { sampleRate: number; channels: 1 | 2; peak?: number };
  video?: { width: number; height: number; fps: number };
  takeAt: number;
}

// A take, from arm to commit. ONE lifecycle, two implementations.
export interface RecordingSession {
  readonly mediaId: string;
  /** Resolve the window. Frames are TRANSPORT frames at ctx.sampleRate — the
   *  video implementation converts to its own CFR grid, the audio clock stays
   *  authoritative. */
  arm(w: { startFrame: number; stopFrame: number | null; unitFrames: number }): void;
  /** Endless STOP. Implementations round UP to a whole unit. */
  stopAt(stopFrame: number): void;
  cancel(): void;
  /** Resolves when the media is durable in the store. */
  committed(): Promise<ClipMedia>;
}
```

and the clip gains one optional field (§4.1): `videoMediaId?: string`.

**What the video implementation reuses, by name:**

| seam | file | what it gives |
|---|---|---|
| CFR grid + deficit ramp | `recorderbox-cfr.ts` (`framesDue`, `ptsForFrame`, `planCfrEmit`) | even grid PTS instead of jittery wall-clock PTS — the fix for the macOS slow-motion bug |
| encoder probe + tier table | `recorderbox-quality.ts` (`pickEncodeProfile`, `CODEC_EFFICIENCY`) | the same 3-tier control shape as the audio ladder, so one selector idiom covers both |
| chunked OPFS write | the `WorkerOpfsWriter` pattern (`recorder.ts:1278-1401`) | a `FileSystemSyncAccessHandle` in a worker; the clip media store is already that shape |
| crash recovery | manifest-before-first-byte + `listRecoverable` | identical model, one store |
| node-keyed lifetime | `node-recorder-registry` (`acquireRenderLease`, `sweep`) | the video take needs a **render lease** — the one field the audio registry does not have, and the reason `RecordingSession` does not put the surface in its type |
| perf-zip | `performance-zip.ts` `role: 'video'` | already exists; the clip's `videoMediaId` becomes the `handleId` |

**Where the video comes from.** "Saved from a connected output" = a
video-domain output port, so the clip carries `videoSrc?: { nodeId, portId }`
and the recorder resolves it the way the cross-domain bridge already does. The
natural product shape is a **`recTap`-equivalent on the video side** — arm a
clip for video and it records whatever that clip's chosen output is showing.

**The one thing that must be true now for this to slot in later:** the musical
window must be expressed in **transport frames**, not in seconds or in video
frames. That is why `RecordingSession.arm` takes frames, and why `ClipMedia`
carries `frames` for both kinds. A video take then ends on the same musical
boundary as its audio sibling, to within one video frame, and A/V sync is the
audio clock's problem — exactly the arrangement `recorder.ts:723-727` already
argues for (*"both tracks share the zero epoch… both clocks are sample/frame
accurate"*).

---

## 5. Edge cases

| # | case | behaviour | why |
|---|---|---|---|
| 1 | Arm with **nothing playing and transport stopped** | arm starts the transport; `unitFrames` from `DEFAULT_CLIP_STEPS` × lane rate at TIMELORDE's bpm (or 120) | tempo exists without a clock cable (`clipplayer.ts:1105-1109`); Bitwig and the Deluge both auto-start |
| 2 | Arm with **no TIMELORDE in the rack** | 120 bpm, free-run | already the shipped fallback |
| 3 | **Tempo changes mid-take** | the take keeps the `unitFrames` latched at arm; the *clip* keeps `lengthSteps`, so at the new tempo the recorded audio no longer fills its grid slot | latching mirrors `sceneRepeatAnchor`, which freezes its unit at launch so mid-count edits never move scheduled boundaries. §7 Q9 covers whether playback should warp |
| 4 | **Re-tap the same arm** | disarms (cancel) | `armTransition` (`clip-record-machine.ts:59`) already means this |
| 5 | **Switch Single → Endless while armed** | mode switches in place, `stopFrame` cleared | no reason to force a disarm |
| 6 | **STOP pressed twice** during Endless | second is a no-op | stopping sooner would produce a partial loop, the one thing the mode forbids. CANCEL is the escape |
| 7 | **Transport stops** mid-Endless with ≥1 whole loop | commit the whole loops, discard the tail | Deluge: *"a multiple of that first loop"* |
| 8 | **Transport stops** mid-Single | discard | Single's contract is exactly one loop; a partial is not a shorter version of it |
| 9 | **Budget ceiling** reached mid-Endless | auto-stop at the previous whole unit; the pad announces it | samsloop's cap-stop, which *announces itself* (`samsloop-record.ts:108-114`) |
| 10 | **Not enough OPFS headroom** at arm | refuse to arm, with the numbers | samsloop's "refusing up front is honest" rule |
| 11 | **Target slot already holds an audio clip** | replace, inside one `clipUndoTransact` | the whole take is one undo unit, matching the note recorder's atomic-pass rule |
| 12 | **Target slot holds a NOTE clip** | refuse; a slot is one kind | a silent kind-change would destroy authored notes |
| 13 | **Nothing patched** into the channel | records digital silence, exactly `unitFrames` long | a silent loop is a valid, diagnosable result; refusing would need an "is anything there?" probe, and probes of that shape are banned |
| 14 | **Channel muted** (fader at 0) during a pre-board take | records normally | pre-board is before the fader — the same property `send{R}Pre` exists to give |
| 15 | **A mono source auto-wired** into `ch{N}L/R` | records 2 identical channels; stores `channels: 2` | the double-patch policy is owner-locked and detection is banned by name |
| 16 | **Two peers arm the same lane** | `recorderId` lease; second peer's arm is refused | the automation recorder's single-writer model |
| 17 | **A peer opens a rack whose clips reference media it lacks** | pad shows "media absent"; launch is a no-op with a reason | VIDEOBOX's re-link prompt, already shipped |
| 18 | **Crash mid-take** | manifest survives; on load the lane offers recovery, truncated to the last whole `unitFrames` | recorderbox's model; PCM is trivially truncatable |
| 19 | **The clipplayer node is deleted** mid-take | registry `sweep()` abandons; scratch survives as a recover candidate | `node-recorder-registry.sweep` (`:341`, `:348`) |
| 20 | **The mixmstrs node is deleted** mid-take | same | the recorder is node-keyed on mixmstrs |
| 21 | **The card is unmounted / dock collapsed** mid-take | recording continues | there is no teardown method to call — the #1574 guard |
| 22 | **Clip deleted** while its media is on disk | `gc(liveMediaIds)` frees it on the next graph pass | recorderbox has no GC; a launcher needs one |
| 23 | **A clip is duplicated** (copy/paste, scene paste) | the copy shares the `mediaId` — media is immutable and content-keyed | copying 3 MB per paste would be absurd; immutability makes sharing safe |
| 24 | **`recTap` changed mid-take** | latched at arm; takes effect next take | changing the source mid-loop is a splice |
| 25 | **`recQuality` changed mid-take** | latched at arm; the selector is disabled while any lane records | recorderbox disables its selector the same way |
| 26 | **Context sample rate ≠ 48 kHz** | store `ctx.sampleRate`; playback compares against the live rate | `samsloopAchievedRate` — never store a rate you requested |
| 27 | **Audio context suspended** (autoplay policy) at arm | arm is queued; `currentFrame` does not advance, so nothing punches in early | the comp-macro readiness rule: *"readiness is a property of the clock, never of the value"* (`mixmstrs.ts:839-862`) |
| 28 | **`compact` selected on a runtime with no Opus encoder** | the tier is absent from the roster | recorderbox's probe-with-a-smoke-test |
| 29 | **A clip is launched while still recording into it** | the launch is queued and lands after commit | the take is not playable until it exists |
| 30 | **CV arms a channel** (a gate into `ch{N}_rec`) | same state machine; the CV is a control input like any other | free from `buildInputs()`; the risk is an LFO on the arm input, which is the user's business |

---

## 6. Phased plan

Nine slices, each a PR. Every slice runs `flox activate -- task typecheck` and
its focused tests with `REPEAT=3` before CI. **No new gates and no new kinds of
test** — every check below runs in an existing lane.

| # | slice | what lands | tests |
|---|---|---|---|
| **1** | **Clip length is kind-agnostic** | `clipLengthSteps(clip)` helper; the four `len = 1` sites re-pointed; real `'audio'` validation in `coerceClipRecord`; `AudioClipRecord` replaced (§4.1); `data.audioRec` added to the transient list | unit: `clip-types` coerce (accept/reject matrix), `clipIndex` round-trip, `sceneRepeatAnchor` with an audio clip present, `scrubClipPlayerTransientData` drops `audioRec`. No behaviour change — an audio clip cannot exist yet |
| **2** | **Clip media store** | `clip-media-store.ts` + the worker writer + `gc()` | unit against an OPFS fake: chunked write/read round-trip, manifest-before-first-byte, truncate-to-whole-unit recovery, `gc` frees only unreferenced ids (**negative control: a referenced id survives**). e2e: seed IDB directly and assert the recovery affordance is reachable — `recorderbox-recover-reachable.spec.ts` is the template, including its `elementFromPoint` lesson that `toBeVisible()` would not have caught the bug |
| **3** | **The pre-board tap** | the unity insert; `ch{N}_rec` / `recTap` / `recQuality` params + shadows + `markJsConsumedParam`; `mixmstrsSectionPlan` picks; the `record` face page | **FULL web unit suite** (CV ports added — `cv-scale-registry` lives only in `unit`); `mixmstrs-face-model.test.ts` scope-partition both directions; `mixmstrs-sections.test.ts` zero `missing`; `art/scenarios/cv-terminal` clean via the declaration, not an exemption; **new ART leg**: `OfflineAudioContext` render of the real factory with and without the insert, reporting max \|Δsample\| on `masterL`/`masterR` (§4.2) — this is the leg that must not be assumed; `task vrt:one -- mixmstrs` with `GREP=mixmstrs`; owner preview, no auto-merge |
| **4** | **The recorder worklet** | `packages/dsp/src/clip-recorder.ts`; a pure `clip-audio-rec-machine.ts` for the frame maths | unit on the pure machine: `unitFrames` rounding, `stopFrame` = anchor + n×unit (**never repeated addition** — assert no drift over 1000 loops), the endless round-up, every §4.4 transition. Worklet via the `registerProcessor` shim: exact frame counts across quantum boundaries, a punch-in mid-quantum, an 8-lane pass sharing one `currentFrame` |
| **5** | **Arm–Single, end to end** | `node-clip-recorder-registry`; wire `data.audioRec`; commit via `clipUndoTransact`; playback path — clipplayer `audio{N}L/R` outputs, lazy decode with a byte-capped LRU, `AudioBufferSourceNode` started on the boundary | **e2e wiring the real source chain**: a real VCO → mixmstrs `ch1` → arm Single → one loop → launch the clip → **assert audible RMS on clipplayer `audio1L`**. Per the standing rule, driving the engine class directly or asserting only that a file appeared does not count. Plus: recorded length == `unitFrames` exactly |
| **6** | **Arm–Endless** | the `stopping` phase; whole-multiple rounding; pad countdown reusing `cd-*` | e2e: arm Endless, run ~2.5 loops, STOP, assert the committed length is **exactly 3 × unitFrames** (**negative control**: an immediate-stop implementation yields 2.5 and fails). Unit: transport-stop-mid-take commits whole loops only |
| **7** | **Multitrack** | simultaneous arm across lanes; the mixmstrs `⏺` control column on the card | e2e: one source split to `ch1` and `ch5`, both armed, one pass; **cross-correlate the two takes and require a 0-sample lag** (negative control: a deliberate 1-quantum offset must fail). Unit: per-lane `unitFrames` at different rates |
| **8** | **Quality ladder + budgets** | the three tiers, the Opus worker + probe, `clipQualityMaxSeconds`, the refuse-to-arm path | unit: the per-second table pinned like samsloop's 12-cell table; binding-cap selection; `coerceClipQuality` never fails; probe failure removes `compact` from the roster (not "selects and breaks"). e2e: arm with the budget exhausted → refusal message carries the numbers |
| **9** | **Perf-zip round-trip** | clip media in/out of `.ptperf.zip` via the existing `role: 'audio'` | unit: build → parse → media restored under the same `mediaId`, determinism preserved (`zipEntryMtime`). e2e: save, clear, load, launch, assert audible |
| **10** | *(later)* **Video clips** | `VideoTakeRecorder` against the same `RecordingSession`; `videoMediaId` populated | out of scope for this plan; the interfaces exist so this is additive |

**Blind spots this plan does not close, named rather than left to be found:**

- ART cannot see any of the graph work — the mixmstrs scenarios go through
  `renderFaustOffline` and never touch the JS factory. Slice 3's insert-identity
  leg has to be a *new* offline-context render, or the claim is untested.
- Web unit tests run in `node`, so **no per-channel audio assertion is possible
  there**; the stereo plan records that an AnalyserNode analyses a mono downmix
  (measured: mono `0.15507`, L `0.31015`, R `0`). Every L/R claim must use
  `outputSnapshotL`/`outputSnapshotR` in ART or e2e.
- A green e2e that never actually recorded looks identical to one that did
  unless it asserts **audible output from the recorded clip**, which is why
  slice 5 is shaped the way it is.

---

## 7. Open owner questions

1. **Is "pre-board" the raw channel input** (pre-EQ, pre-comp, pre-fader), as
   this spec assumes? On this module `send{R}Pre = PRE` already means
   *post-EQ/comp, pre-fader*, and `mixmstrs.dsp:81-84` says a pre-EQ tap would be
   *"a THIRD mode."* Confirming which one you mean decides §4.2.
   **1b.** `MASTER` (record the whole mix bus) costs nothing today — ship it in
   v1 alongside `BOARD IN`, or keep the roster to one live option?
2. **Default quality: `studio` (PCM f32, 23 MB/min, cannot clip a hot
   pre-board tap) or `standard` (PCM i16, 11.5 MB/min, clips at ±1.0)?** And is
   `compact` (Opus) acceptable for **Endless only**, given its pre-skip makes an
   exact single-loop length harder to guarantee?
3. **Do recorded clips reach collaborators live?** Today's proposal is
   OPFS-local + `.ptperf.zip`, matching VIDEOBOX. Live sharing needs an upload
   path and changes the relay's byte accounting — a separate project, or part of
   this one?
4. **Count-in**: default off (Deluge's default), or 1 bar when arming with the
   transport stopped?
5. **Per-take ceiling**: 192 MB / 10 minutes as proposed, or different? This is
   the "won't cripple resources" number and it is yours to set.
6. **Monitoring latency**: keep `recOffset` at 0 by default (right for
   resampling, late for a human playing along), or default it to
   `−ctx.outputLatency`?
7. **Audio overdub (sound-on-sound)** — in scope, or replace-only for v1?
   `twotracks-engine.ts` has a working `recordSpan(..., overdub)` to build on,
   but it is a design of its own.
8. **Does clipplayer get 16 new audio output jacks** (`audio{N}L/R`, one stereo
   pair per lane), or a single stereo sum? Per-lane preserves the lane↔channel
   identity and lets a take return to its own mixmstrs channel; a sum is 14
   fewer jacks on an already-24-output module.
9. **Does an audio clip warp with tempo?** Proposal: **no** — it plays at its
   recorded rate and loops at its recorded length, and when the tempo moves the
   clip visibly no longer fills its slot. The Deluge warps; we have no
   time-stretcher and writing one is its own project.
10. **The batch-7 clipplayer face spec carries a standing "do not change the
    card."** Read as scoped to face migration, this feature may change it with
    an owner preview and `task vrt:one -- clipplayer`. Confirm?

---

## 8. Supersessions, conflicts, and sequencing

**Superseded by this design:**

- `AudioClipRecord`'s `fileBytesB64` field (`clip-types.ts:222-231`) and its
  *"reuses SAMSLOOP's bytes discipline"* premise. Recorded audio in the Y.Doc
  cannot work at this scale: samsloop's own budget is **3 MB per take / 12 MB
  per rack in base64**, against a relay that warns at 16 MB and crits at 24 MB
  (`samsloop-record.ts:41-116`). A single 4-bar `studio` take is 3 MB, and a
  launcher holds 64 clips. Media goes to OPFS; the Y.Doc keeps ~120 bytes.
  **No migration** — nothing ever wrote the field.
- The automation plan's open item (`automation-redesign-2026-07-16.md:262-265`),
  *"decide whether audio clips can carry automation."* **They can**, and the
  `auto[k]` sibling map already supports it kind-agnostically once an audio clip
  has a `lengthSteps`. v1 builds no UI for it.

**Consistent with, and building on:**

- The **Deluge model** throughout: the shared reference bar
  (`clip-launch-quantize.ts`), arm-decoupled-from-capture
  (`clip-record-machine.ts`), whole-multiple lengths, count-in as an option.
- The **KEYS record redesign**'s §4.3 *transient-first write discipline* — the
  take accumulates outside the Y.Doc and commits once, as one undo unit.
- The **stereo dual-mono** policy: two channels always, **no detection**.
- The **automation** ownership shape: a per-lane arm, a single-writer
  `recorderId` lease, and commits kept out of the undo origin except the final
  atomic one.

**Conflicts that must be sequenced, not parallelised:**

1. **Stereo plan PR-6 adds `pan1..pan8` to mixmstrs** and the batch-6 face spec
   already warns the two pieces *"must be sequenced, not parallel"* — it
   re-ranks the face and re-pins ART. Both this record band and a pan row want
   to be new pages, and **five plus two is seven**, which trips
   `DOCK_TAB_MIN_BANDS` and turns the mixer into a tab rail. Whichever lands
   second must fold into an existing band, most naturally `channels`.
2. **Slices 3 and 7 both touch `ClipplayerCard.svelte`** and the mixmstrs face —
   both are look-affecting, both need `GREP=<module>` VRT and an owner preview,
   and neither auto-merges.
3. **Nothing in this plan may go in `packages/web/src/lib/video/**`**, which is
   hashed wholesale for the real-GPU WebGL attest (#2314's own reason for
   creating `lib/ui/modules/recorderbox-transport.ts`). Audio recording code
   lives in `lib/audio/**` and `lib/ui/**`. This becomes load-bearing at slice
   10, where the video recorder genuinely does need `lib/video` seams — that
   PR should expect an attest window.

**DOOM is untouched by every slice here.** No DOOM code, spec, wait, budget,
ledger entry or sweep behaviour is read or modified; the `blood-pcm` citations
in §1.5 and §4.8 are to `packages/web/src/lib/blood/**`, which is Blood, not
DOOM, and they are quotations, not changes.

## Owner ruling 2026-09-03: preview cadence
Slices 5-6 merge on green WITHOUT per-slice owner preview; the ONE owner preview
happens at slice 7 (multitrack) when the full launcher record picture exists.
