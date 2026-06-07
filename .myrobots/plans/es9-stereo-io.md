# ES-9 stereo I/O — findings + plan

**Goal (first step):** Patch a STEREO L/R pair IN from the Expert Sleepers
ES-9 (a 16×16 USB audio interface) into patchtogether.live, WHILE
simultaneously playing AUDIO OUT (to the ES-9 or another device).

**Long-term:** Bitwig-style individually-addressable input/output PAIRS
(1/2, 3/4, …). That is the `patchtogether.native` track (ES-9 tasks
#38/#40) — **not** this PR.

---

## VERDICT

**Browser-feasible TODAY**, with one small enhancement (already made in
this PR). No native helper is required for the first step.

- **Audio OUT to the ES-9** — already shipped. `AudioOutCard.svelte` has a
  full output-device dropdown backed by `AudioContext.setSinkId(deviceId)`
  (Chromium 110+), with feature-detect + graceful "requires Chromium"
  notice + saved-pick restore. Nothing to add.
- **Stereo pair IN from the ES-9** — needed a one-line-ish fix: the
  AUDIO IN card was calling `getUserMedia` **without** asking for stereo,
  so Chromium was free to (and commonly does) downmix a multichannel
  interface to MONO — both `audio_l_out` and `audio_r_out` then carried
  the same signal. This PR makes AUDIO IN **request a 2-channel capture**
  (`channelCount: 2`). (We intentionally leave echo-cancel / noise-
  suppress / auto-gain at the browser default — forcing AGC off drops
  built-in-mic level for every existing user; a future "music mode" toggle
  can expose these. Chromium already leaves them off for a USB interface.)
- **Both at once (full duplex on the same device)** — the app already
  supports this architecturally. AUDIO IN owns its own `MediaStream`
  (`getUserMedia` → `MediaStreamAudioSourceNode`), and AUDIO OUT routes
  the single shared `AudioContext` to a sink via `setSinkId`. These are
  independent Web Audio objects; nothing in the engine couples capture to
  playback, so input-from-ES-9 + output-to-ES-9 simultaneously is just
  "pick ES-9 in AUDIO IN" + "pick ES-9 in AUDIO OUT". (Clock caveat
  below — but that's the OS/driver's job on a single hardware interface,
  not ours.)

---

## How the app's audio I/O actually works (grounding)

### One shared AudioContext

`packages/web/src/lib/ui/Canvas.svelte` (`ensureEngine`, ~L3519) creates a
single `new AudioContext()` and hands it to `AudioEngine`
(`packages/web/src/lib/audio/engine.ts`). Every module factory builds its
nodes on that one context. So there is exactly ONE playback graph and ONE
destination/sink for the whole patch.

### AUDIO OUT — `setSinkId` already implemented

`packages/web/src/lib/audio/modules/audio-out.ts` is the terminal sink:
`L`/`R` gains → DC-blocker → merger → limiter → `ctx.destination`.

`packages/web/src/lib/ui/modules/AudioOutCard.svelte` already:
- enumerates `audiooutput` devices,
- feature-detects `ctx.setSinkId`,
- applies the user's pick via `await ctx.setSinkId(deviceId)`,
- persists the choice to `node.data.outputDeviceId` (Yjs) + re-applies on
  engine boot,
- shows an inline "Device selection requires Chromium-based browsers"
  notice when `setSinkId` is absent (Firefox), and surfaces setSinkId
  rejections inline.

So routing OUT to the ES-9 is a solved problem in-browser. **No change.**

### AUDIO IN — captures via getUserMedia, exposes L/R

`packages/web/src/lib/audio/modules/audioin.ts` builds a DOM-free graph:
`sourceNode → (splitter when stereo | fan-out when mono) → gainL / gainR →
audio_l_out / audio_r_out`. The card hands a live `MediaStream` in via the
`__audioInAttach` hook; the factory keys mono-vs-stereo wiring off the
`channelCount` the card passes.

`packages/web/src/lib/ui/modules/AudioinCard.svelte` owns the permission
flow, device dropdown, and `MediaStream` lifecycle. **The gap:** its
`getUserMedia` constraints requested only `{ deviceId: { exact } }` — never
`channelCount: 2` — so the browser decided the channel count and could
hand back mono.

---

## The fix in this PR (minimal)

1. **`packages/web/src/lib/audio/devices.ts`** — new pure helper
   `buildAudioInConstraints(targetId)`:
   - always requests `channelCount: 2` (IDEAL, not `exact` — a mono device
     still streams),
   - leaves browser DSP (echo-cancel / noise-suppress / auto-gain) at the
     browser default (no forced toggles — see the AGC note above),
   - pins `deviceId: { exact }` for a real pick, omits it for
     null / `'default'`,
   - `video: false`.
2. **`AudioinCard.svelte`** — call the helper instead of the inline
   constraints; and when `track.getSettings().channelCount` is unreported
   (Chromium frequently omits it even for a genuine stereo capture),
   default to **2** (splitter path) rather than 1 — since we explicitly
   asked for stereo, taking the splitter path preserves true L/R; a real
   mono device reports `channelCount: 1` and still fans L→R.
3. Doc comments in `audioin.ts` updated to describe the stereo-request
   architecture + the per-pair native boundary.

No ports / params / card layout changed → per-module-per-port,
behavioral, and VRT baselines are unaffected.

---

## Web Audio constraints (the reality check)

- **Stereo capture** — `getUserMedia({ audio: { channelCount: 2 } })` is
  the supported way to ask for a stereo pair on Chromium. It exposes the
  device's FIRST two channels as a stereo `MediaStreamTrack`. A
  `MediaStreamAudioSourceNode` for a stereo track has 2 output channels,
  which `ChannelSplitter(2)` separates into L/R. ✅ in-browser.
- **`setSinkId`** — Chromium 110+ (and recent Safari). Firefox does not
  implement it → AUDIO OUT shows the existing graceful notice and uses the
  OS-default sink. ✅ in-browser (Chromium).
- **Same-device duplex (input = ES-9 AND output = ES-9 at once)** —
  supported in-browser: the capture stream and the playback context are
  independent objects. The caveat is a HARDWARE/OS one, not an app one: a
  USB interface runs input + output on a single clock, so when both
  directions go through the same ES-9 there is no cross-device sample-rate
  drift to resample. If the user instead captures from the ES-9 but plays
  out to a DIFFERENT device on a different clock, the OS/driver handles
  resampling; the app doesn't need to. Either way the app's architecture
  already supports it.
- **What is NOT reachable in-browser:** addressing an arbitrary input or
  output PAIR (3/4, 5/6, …) of the 16×16 device. `getUserMedia` only ever
  exposes the device's first stereo pair, and `setSinkId` selects a whole
  output DEVICE, not a channel pair within it. There is no Web Audio API
  to bind a specific hardware channel range. **This is the native boundary
  (below).**

---

## Per-pair addressing — the native boundary (long-term, NOT this PR)

Browser-side, one ES-9 = one input device (first pair only) and one output
device. To expose all 8 stereo input pairs and 8 output pairs as
individually patchable modules — the Bitwig-style goal — requires reading/
writing arbitrary hardware channel ranges, which the Web Audio /
getUserMedia API cannot do.

That belongs to `patchtogether.native` (ES-9 tasks #38/#40): a native
audio backend (e.g. CoreAudio aggregate device access) that surfaces
per-pair I/O to the app. **Do not build this in the web repo.** The user
has firmly rejected native COMPANION apps for the web build
(`feedback_no_native_helper_apps`); per-pair addressing is therefore a
separate native PRODUCT, not a helper bolted onto the browser app.

---

## What the user must verify ON-DEVICE (cannot be tested in CI)

CI has no physical ES-9; `--use-fake-device-for-media-stream` injects a
synthetic mono-ish sine and a fake speaker, so it can prove the constraint
plumbing and dropdowns but **not** real stereo separation or duplex on the
hardware. The user should, in **Chrome**, on the preview build:

1. Spawn AUDIO IN, pick the ES-9 in its dropdown, click enable → status
   LED `active`.
2. Patch `audio_l_out` → SCOPE.ch1 and `audio_r_out` → SCOPE.ch2 (or two
   scopes) and confirm L and R show **different** signals when you feed
   different sources into ES-9 inputs 1 and 2 (true stereo, not duplicated
   mono).
3. Spawn AUDIO OUT, pick the ES-9 in its `out` dropdown, patch a sound
   source → L/R, and confirm audio comes out the ES-9.
4. Confirm steps 2 and 3 work **simultaneously** (capture from ES-9 while
   playing back to ES-9) with no dropouts/glitches.

---

## Next steps

- **This PR:** stereo-request enhancement + unit coverage. Merge after the
  user's on-device check. (Opened, NOT auto-merged.)
- **Follow-up (web, optional):** a per-card "music mode" toggle exposing
  echoCancellation / noiseSuppression / autoGainControl (and maybe a
  "force mono" fallback) for users routing line-level gear who want the
  browser DSP off. Low priority — the stereo `channelCount: 2` request is
  what the ES-9 needs; the default DSP should be fine for most.
- **Native (separate repo):** per-pair addressing — ES-9 tasks #38/#40 in
  `patchtogether.native`.
