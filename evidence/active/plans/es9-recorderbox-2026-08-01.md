# ES-9 RECORDERBOX — multitrack capture spec

**Date:** 2026-08-01 · **owner decisions answered 2026-08-02**
**Status:** SPEC ONLY. Nothing ships. Explicitly gated behind the new shell + Push 2.

> **RE-VERIFIED 2026-08-12 — STILL UN-BUILT, and every load-bearing claim still
> holds.** Nothing named `es9Recorderbox` exists anywhere in the tree. Spot-checked
> against the code: `recorderbox.ts` is still hard stereo (`dest.channelCount = 2`),
> `recorderbox-recorder.ts` still clocks the CFR grid off `performance.now()`,
> `bridge.worker.ts` still does `sampleTime += got` beside two counter-free
> `outRing.skip()` sites, `recorderbox-capture.ts` still documents the lossless
> MessagePort tap, `VITE_ES9_BRIDGE_URL` is still the seam nobody uses, and
> `../patchtogether.es9` still has **no git remote and no `.github/`** (§7 G3).
> **Line numbers throughout have drifted** (e.g. `channelCount = 2` is now :243,
> `sampleTime += got` now :218) — re-grep, don't trust the offsets.
> All **12 owner questions are answered in §6**, which is the reason this is kept
> verbatim: it is build-ready the moment the gate (new shell + Push 2) opens.
**Owner questions:** **all 12 ANSWERED** — see §6. Remaining unknowns are engineering, not owner
input; they are in §6.1.
**Repos:** `inet.modular` @ `77cd1bbc`, `../patchtogether.es9` @ `b22bf3c`
**Inputs:** 3 research facets + 2 adversarial critiques, synthesized. Contradictions between them are
resolved in §7 — never averaged.

Every file:line in this document was re-read and verified during synthesis. Numbers state their
derivation. Anything not verified is tagged **UNCONFIRMED**.

---

## 1. THE VERDICT UP FRONT

### Is this buildable as described?

**Yes — but NOT the way two of the three facets specced it.** The feature is buildable, and once the
capture point is corrected it becomes *easier* than the facets assumed: **100 % headless-testable,
with no ES-9 in the record path at all.** That is the single most important consequence of the
correction and it is worth reading twice.

Three things must change before anyone writes code:

1. **The capture point in facets 1 and 2 cannot hold the payload.** They spec a tap on the live ES-9
   output stream inside `BridgeService.handleBinary`. That stream is 16 USB channels wide, of which
   USB 1–8 are the ES-9's *internal blocks* (main mix, phones, S/PDIF, ES-5 header) and only USB 9–16
   are the 8 physical jacks — **4 stereo pairs, not 8.** Carrying 8 stems there consumes all 16 USB
   outs and puts stems on the main-mix and phones buses, i.e. **you cannot monitor while recording.**
   The master pair would need channels 17–18, which `outClientPlanes` (allocated at `outCh = 16`,
   `BridgeService.swift:127-128`) cannot hold and `guard c < outCh` (`:305`) silently discards.
   Verified in `Sources/es9-bridge/main.swift:84-98`.

2. **The "gap accounting is free" claim — the most-cited technical assertion in the whole pack — is
   FALSE against the code it cites.** `sampleTime` counts frames **SENT**, not frames **PRODUCED**
   (`bridge.worker.ts:198`, `sampleTime += got`), while the same function *discards* ring content at
   `:179` and `:183` without touching the counter. The stream is **gapless by construction across a
   drop.** A detector reading it can never fire. Both critiques found this independently. It is the
   repo's own VALIDATE-THE-INSTRUMENT failure, verbatim.

3. **The transport being reused is lossy by design.** The ES-9 bridge is a fixed 8192-frame ring with
   skip-on-full (`bridge-client.ts:44-47`) — correct for live monitoring, wrong for archival capture.
   The repo already contains the *right* policy and wrote down why:
   `packages/dsp/src/recorderbox-capture.ts:1-11` — "the MessagePort **BUFFERS** under main-thread
   load, so the audio thread **NEVER drops a sample** — the fix for recorderbox's recording
   clicks/pops". Routing a recording through the monitoring ring re-introduces a bug recorderbox
   already fixed once.

### THE ONE ASSUMPTION EVERYTHING RESTS ON

> **The record stream is a SEPARATE logical channel space on a SEPARATE session — not the live ES-9
> output stream.** The helper, for this feature, is a **pure file-writing service** that happens to
> live in the same process as the audio bridge. It does not touch `outClientPlanes`, the
> `StreamResampler`, or `engine.outputRing`, and the ES-9 need not be plugged in.

**Status: CONFIRMED BY THE OWNER (2026-08-02, OQ-1).** This was Owner Question 1 and it gated
everything else. Both readings of the brief agreed on *which signal* is recorded (the 8 stem pairs
feeding MIXMSTRS); they disagreed on *the mechanism*. The owner picked the **separate stream** — the
helper is a pure file-writing service and the ES-9 need not be plugged in (OQ-2: "no"). Everything
below is now built on a confirmed foundation rather than a recommended one.

Everything the design gains from this choice:

| gained | because |
|---|---|
| 8 pairs + master fit | channel space is decoupled from `engine.outputChannelCount` |
| monitoring survives a take | main mix / phones stay on USB 1–4 |
| **the ES-9 is not in the record path** | → the whole feature is testable with `swift test` + `SyntheticEngine`, no hardware |
| the 8 ms live-audio cushion is not at risk | each `NWConnection` gets **its own serial queue** (`WebSocketServer.swift:20-22`, `:207`) — a record-side write stall cannot starve the live output ring |
| the header can be fixed properly | a new record opcode means a clean v2 block header for `producedFrames`, not 2 scavenged reserved bytes |

### What this is NOT

- Not a deployed-site feature. `https://patchtogether.live` cannot open `ws://127.0.0.1:9209`
  (mixed content). See §4.8.
- Not a second install. It enhances the one pre-existing helper, per the standing exemption.
- Not shippable until `../patchtogether.es9` has a remote and CI. It currently has **neither** (§7 G3).

---

## 2. THE OWNER'S BRIEF (verbatim)

> we're going to spec out enhancing our es-9 helper in ../patchtogether.es9 such that it can talk
> multitrack to a new version of recorderbox we'll call ES-9 RECORDERBOX. this one will be
> up-to-16-channel-in and it will connect to our ES-9 widget's outs and record all the pre mixmasters
> audio, along with video as usual; we record each L/R pair to its own track. if its performance wise
> possible to record the mixmasters stereo output, as well, that's great. in this recording mode we
> record the video as well but to its own file. so this is going to be a bunch of file i/o and needs
> sniffing out, best practices, prior art. note that in this config we're going to enhance the native
> app as much as we need, so if it's helpful to do our recording there, we can do that and have
> whatever comms we need between our module and the native app. this is all intended to only work when
> the helper app and the web app are running on the same machine. this wont get built until we've
> nailed down more of our new shell as well as push2.

### What "16-channel-in" and "8 tracks" mean — they are the same number, arrived at twice

- **MIXMSTRS** takes `ch{1..8}L` / `ch{1..8}R` = 8 stereo channel inputs = **16 ports**, plus
  `masterL`/`masterR` outputs (`packages/web/src/lib/audio/modules/mixmstrs.ts:38-48`).
- **The ES-9 module's** output-direction ports are `out1..out8` (physical jacks) + `usb1..usb8`
  (internal blocks) = **exactly 16**.
- **"pre-mixmasters audio"** = the signal on the 16 edges terminating at `pinned-mixmstrs.ch{1..8}L/R`.
  Pre-fader, pre-EQ, pre-comp, pre-send. The mixer's own per-channel taps are internal VU taps, not
  module ports (`mixmstrs.ts:7-9`) — the raw stems are the correct thing to capture.

So the owner's model is exact: **8 stem pairs = 16 channels = 8 tracks**, + the master pair = 18.
**OQ-4, ANSWERED: yes, record the master as a 9th pair, default on** — the +11.1 % on wire and disk
(3.456 vs 3.072 MB/s) is accepted. `09-master.wav` is therefore **not optional**; treat 18 channels,
not 16, as the design width everywhere below.

---

## 3. WHAT EXISTS TODAY

### 3.1 The native helper — `../patchtogether.es9`

A SwiftPM package, `swift-tools-version:5.9`, `platforms: [.macOS("15.0")]`, **zero third-party
dependencies** (`Package.swift:32-44`). macOS 15 is required for `Synchronization`'s lock-free
`Atomic<>` on the RT path. Four targets: `ES9Core` (library) + `es9-devices`, `es9-duplex`,
`es9-bridge` (executables) + `ES9CoreTests`. **4 commits, no git remote, no `.github/workflows`** —
verified: `git remote -v` empty, `ls .github/workflows` → No such file or directory.

**RT layer — `BridgeAudioEngine.swift` (420 lines).** One full-duplex AUHAL
(`kAudioUnitSubType_HALOutput`) bound to the ES-9, input on bus 1 / output on bus 0, same device
(`:176-236`). One unit ⇒ one I/O thread ⇒ one hardware clock ⇒ no intra-device drift. Client format
is non-interleaved Float32 (`:379-391`) so per-channel work is `memcpy`. Callbacks are
allocation-free: `renderInput` (`:244-274`), `renderOutput` (`:276-333`) with a per-channel underrun
policy — `cv` holds last sample, `audio` linear-fades to zero over 64 frames, fade step carried
across callbacks (`:310-324`).

**Rings — `SPSCRing.swift` (121 lines).** Lock-free single-producer/single-consumer planar Float32.
Power-of-two capacity, monotonic `UInt64` head/tail with acquire/release atomics, ≤2 `memcpy` per
channel per op, no allocation after init. Default `ringFrames = 16384`
(`BridgeAudioEngine.Config`, `:40`, `:46`) = **341.3 ms @ 48 kHz** (16384 / 48000).

**Service — `BridgeService.swift` (420) + `WebSocketServer.swift` (337) + `WebSocketCodec.swift`
(235) + `StreamResampler.swift` (136).** Dependency-free HTTP/WebSocket on Network.framework with
hand-rolled RFC 6455, **bound to 127.0.0.1 only**, `noDelay = true`. A drain thread at
`usleep(2000)` (~2 ms) pumps rings ↔ socket (`BridgeService.swift:345-375`) at `.userInteractive`
QoS. `StreamResampler` is linear interpolation with a ±2 % trim steered by a PI controller on output
ring occupancy.

**Threading, and why it matters (§7 D4).** *"each NWConnection gets its own serial DispatchQueue.
Callbacks (onText/onBinary/onConnect/onDisconnect) fire on that queue"* —
`WebSocketServer.swift:20-22`, `:207`. `handleBinary` runs on that queue and is the **sole producer**
for `outputRing`.

**The protocol — `BridgeProtocol.swift` (the platform contract).** One WebSocket at
`ws://127.0.0.1:9209/ws`.
- TEXT = JSON control: `hello` → `deviceInfo` / `config` / `meters` (~8 Hz) / `status` / `ping`-`pong`.
- BINARY = audio blocks, little-endian, **20-byte header** (`:15-28`):

```
0   u8  type        0x01 = audio block
1   u8  flags       bit0 = planar float32
2   u16 seq         per-sender monotonic, wraps
4   u64 sampleTime  sender's running frame counter at block start
12  u32 channelMask bit c set => channel c's plane present
16  u16 frameCount  <= 4096  (BridgeWire.maxFrameCount, :38)
18  u16 reserved    0
20  ..  payload     frameCount * f32 per set bit, ascending
```

Direction implied by sender: bridge→client = ES-9 **inputs**; client→bridge = ES-9 **outputs**.
Message cap 4 MiB. Origin allowlist: no-Origin ✓, loopback ✓, `patchtogether.live` + subdomains ✓,
else 403 (`WebSocketServer.swift:107-114`, `:268-276`). Max 32 connections; **single active client**
— later ones get `status:busy` (`BridgeService.swift:186-191`).

**The ES-9 channel map — hardware-verified, and the thing most likely to be got wrong**
(`Sources/es9-bridge/main.swift:70-98`):

> **inputs:** USB 1–14 = the DC-coupled jacks, 15/16 = S/PDIF return.
> **outputs:** USB **1–8 feed the INTERNAL blocks** (1-2 main mix, 3-4 phones, 5-6 S/PDIF out,
> 7-8 ES-5 header); **the 8 physical DC-coupled jacks ride USB channels 9–16.**

An earlier revision had these halves swapped and "a browser LFO went nowhere" (`docs/DESIGN.md:167-168`;
fixed in commit `31d1185`). **This is the fact that kills the naive capture point.**

**Testing posture — the most valuable asset in this project.** 35 hardware-free tests.
`BridgeCoreTests` covers wire encode/decode, ring wrap/overflow/underflow + a threaded sequence test,
resampler DC-exactness, RFC 6455 (incl. the §1.3 vector and a fragment-flood stack test).
`BridgeServiceIntegrationTests` stands up a **real `BridgeService` on a real loopback port driven by
`URLSessionWebSocketTask`** against `SyntheticEngine` — full duplex, meters, busy, origin gate.
**Every line of the recording feature can be tested through this harness with no ES-9 and no audio
hardware.** Nothing currently runs it (§7 G3).

### 3.2 The web-side ES-9 bridge

```
packages/web/src/lib/audio/es9/{bridge-client.ts, bridge.worker.ts, es9-protocol.ts, es9-ring.ts}
packages/dsp/src/es9-bridge.ts, packages/dsp/src/lib/es9-bridge-core.ts
e2e/tests/es9-hardware.spec.ts
```

- Ring depth **8192 frames per side** = ~170 ms (`bridge-client.ts:44-47`), `HW_CHANNELS = 16`.
- `VITE_ES9_BRIDGE_URL` override exists (`bridge-client.ts:50-53`) — **the injectable seam nobody uses.**
- `protocolVersion` is a declared field with **zero comparison sites** — `grep -rn protocolVersion
  packages/web/src/lib/audio/es9/ packages/dsp/src/` returns exactly one hit, the type declaration
  at `es9-protocol.ts:34`.
- **Four silent-drop sites, every one with a discarded return value:**

| site | code | behaviour |
|---|---|---|
| worklet | `packages/dsp/src/es9-bridge.ts:168-172` | `if (this.outRing.free >= frames) { write }` — comment: *"Ring full … drop the block"*. No counter. |
| worker | `bridge.worker.ts:179`, `:183` | `outRing?.skip(outRing.occupancy)` — not connected / no channels |
| worker | `es9-ring.ts:59-63` | `write` truncates to `capacity - occupancy`, returns short count, **no drop counter** |
| service | `BridgeService.swift:298` | `let frames = min(block.frameCount, stagingCapacity)` — silent truncation |
| service | `BridgeService.swift:329-331` | `_ = …outputRing.write(…)` — short-on-overflow return explicitly thrown away |

- `ws.send(buf)` at `bridge.worker.ts:199` has **no `bufferedAmount` check**. No backpressure signal
  exists anywhere on the path.

### 3.3 Recorderbox today

`packages/web/src/lib/video/modules/recorderbox.ts` + `packages/web/src/lib/video/recorderbox-*.ts`
(15 modules, each with a unit test). Video + a **stereo** soundtrack → fragmented MP4 (H.264/HEVC +
AAC) → OPFS scratch → Save-As to a user-picked folder.

- `dest.channelCount = 2` — hard stereo (`recorderbox.ts:245`).
- `MAX_CHUNK_SECONDS = 600`, `OVERLAP_SECONDS = 5` (`recorderbox-recorder.ts:108`, `:111`).
- `DEFAULT_VIDEO_BITRATE = 14_000_000`, `DEFAULT_AUDIO_BITRATE = 192_000` (`:99`, `:101`).
- **Clock: `performance.now()`.** `this.t0 = performance.now()` (`:554`);
  `const elapsed = (performance.now() - this.t0) / 1000` (`:863`). CFR grid PTS is `index / fps`
  (`recorderbox-cfr.ts:68-70`).
- **The audio tap is LOSSLESS by deliberate design** — `packages/dsp/src/recorderbox-capture.ts:1-20`,
  `BATCH_FRAMES = 1024` (~21.3 ms, ~47 posts/s), armed only during a take.
- Crash recovery: fragmented MP4 + OPFS `FileSystemSyncAccessHandle` + IndexedDB manifest
  (`recorderbox-store.ts:1-32`). **Origin-local, this-machine-this-browser only.**
- `grep -rn "storage.estimate|QuotaExceeded" packages/web/src/lib/video/` → **zero hits in any
  recorderbox file.** Disk-full is unhandled.
- The `face`/`docs` fields **do exist** on `VideoModuleDef` and are **hash-transparent by
  construction** — `scripts/attest-code-basis.ts` strips `docs`/`controlFamilies`/`face` off a
  module-scope def before hashing, so authoring them on a video module costs no GPU re-attest
  and needs no markers (`packages/web/src/lib/video/module-registry.ts`). *(The
  `docs-hash-ignore` marker pairs this plan was written against were deleted repo-wide on
  2026-08-09.)*

### 3.4 The browser's 2-channel ceiling — reconfirmed

`packages/web/src/lib/audio/modules/audioin.ts:42-47` and `:78-86`, an **empirical DevTools probe
against a real ES-9 in Chrome**: `track.getCapabilities().channelCount` returns `{ max: 2, min: 1 }`
and `getUserMedia({ channelCount: { exact: 4 } })` throws `OverconstrainedError`. The file records
that the earlier `audio_3_out`/`audio_4_out` ports *"were a phantom feature (they could never carry
signal) and were removed."*

**This is the entire reason 16-channel capture cannot be a browser feature.** It is not a limitation
of our code.

---

## 4. THE DESIGN

### 4.1 Capture point — a `role:'record'` session, decoupled from the audio device

```
BROWSER                                          NATIVE (es9-bridge)
────────────────────────────────────────────    ──────────────────────────────────────
es9Recorderbox module
  18 GainNodes (audioInputs)
    → ChannelMerger(18)
      → AudioWorklet 'es9-recorderbox-capture'   ws://127.0.0.1:9209/ws  (2nd connection,
         · batches 1024 frames/ch                 own serial DispatchQueue)
         · counts producedFrames ALWAYS             → RecordSession.handleBinary
         · postMessage (transferred, lossless)        · decode v2 block
      → Gain(0) → ctx.destination  [keep-alive]      · reconcile producedFrames vs written
    ↓ main thread                                    · write into RecordRing (SPSC, 131072 fr)
  record.worker.ts                                        ↓
    · ws.send with bufferedAmount high-water        RecordWriter thread (.utility QoS)
    · v2 record block header                          · drains ring
                                                      · N x FileSink (WAV/BWF, <4 GiB)
video half: UNCHANGED except the CFR clock            · header refresh 1 Hz
  ctx.currentTime replaces performance.now()          · statfs pre-flight + low-water stop
  → fragmented MP4 → OPFS → Save-As
```

**What this deliberately does NOT touch:** `outClientPlanes`, `StreamResampler`, `engine.outputRing`,
`BridgeAudioEngine`. The record path never enters the RT audio graph. The ES-9 may be unplugged.

**Why not the `handleBinary` tap.** See §1 and §7 D1. Short version: 4 pairs available, 8 required.

**Why not a physical loopback.** The ES-9 has 14 DC-coupled inputs and 8 physical output jacks.
16-channel loopback is physically unrepresentable — you would cap at 8 pairs out / 7 pairs in, consume
every rack input, burn 14 patch cables, and add a full DAC→ADC round trip (2 conversions, no
bit-transparency) plus `(74 + 14) / 48000 = 1.83 ms` of safety-offset latency before buffers. Dead on
the channel count alone.

### 4.2 Session model — a second role on the same socket

`BridgeService` today accepts exactly ONE session; a second is bounced with `status:busy`
(`BridgeService.swift:186-191`). Add a **role** to `hello`:

```jsonc
// client -> bridge
{ "type": "hello", "role": "record", "protocolVersion": 2, "rate": 48000,
  "channels": 18, "bitDepth": "f32", "layout": "pairs",
  "take": { "name": "…", "startedAtEpochMs": 1754000000000 } }
```

- `role` absent ⇒ `"live"` ⇒ today's behaviour, byte-identical. Old clients unaffected.
- One `live` slot **and** one `record` slot may be active simultaneously; a second of either gets
  `busy`. Connection cap stays 32.
- Origin gate, codec, port, framing all reused unchanged. **No second install, no second port, no
  second transport.**

**Hard version gate (§7 G6).** Both sides compare `protocolVersion` at `hello`/`deviceInfo` and the
helper **refuses to arm** on mismatch, returning `status:{state:"version-mismatch", detail:"helper
speaks 2, client needs 3"}`. The card shows required-vs-actual. This is not optional: the web app
updates itself on every deploy and the helper binary does not, so mismatch is *guaranteed* to happen
(§7 G6).

**OQ-9, ANSWERED: refuse to arm, and the card names BOTH versions** — required and actual, as above.
Never silently degrade to the stereo browser path; a recording session that quietly becomes a
different recording session is the worst available outcome. **No per-block `crc32c`**: this is a
localhost loopback and TCP's checksum is sufficient, so the field is removed from the v2 header
(§4.3) rather than reserved-but-unused.

Note the two answers are load-bearing together: the layout above declares `"bitDepth": "f32"` and
`"layout": "pairs"` as the *only* legal values (OQ-5, OQ-7/11), so the handshake carries no
negotiation for formats that will not exist.

### 4.3 The record block — a v2 header that can actually account for gaps

The v1 header cannot carry `producedFrames`; the 2 reserved bytes at offset 18 are not enough for a
frame counter. A new opcode gives a clean 32-byte header:

```
0   u8  type          0x02 = RECORD audio block
1   u8  flags         bit0 = planar float32   (bit1 was 24-bit int packed — dropped, OQ-5)
2   u16 seq           per-sender monotonic, wraps
4   u64 sampleTime    frames SENT before this block   (as v1 — kept for continuity checks)
12  u64 producedFrames frames the WORKLET PRODUCED before this block   <-- the fix
20  u32 channelMask   bit c set => channel c's plane present (up to 32 record channels)
24  u16 frameCount    <= 4096
26  u16 reserved      0
28  u32 reserved      0   (was crc32c — DROPPED per OQ-9: loopback, TCP's checksum suffices)
32  ..  payload
```

**`producedFrames` is the whole point.** It is incremented in the worklet by the **full render
quantum on every `process()` call while armed, unconditionally** — before, and independent of, any
ring/queue acceptance. The writer's invariant is:

```
producedFrames(block N) - producedFrames(block 0) == framesWrittenToDisk + zeroFilledFrames
```

Any shortfall is a real, countable loss; the writer zero-fills exactly that many frames, logs it, and
surfaces it as `take.gapFrames` on the card. **File length then genuinely equals the browser
timeline** — which is what facet 1 claimed for `sampleTime` and did not get.

**The negative control is mandatory** (CLAUDE.md, VALIDATE-THE-INSTRUMENT): a test must force a drop —
close the socket for 200 ms mid-take, or wedge the writer — and **assert `gapFrames` moves**. If the
number does not move, the instrument is wrong regardless of what the code does. This test is the
acceptance criterion for the whole gap-accounting feature; without it the counter is decoration.

Add the same counter to the **existing live path** while you are there (§9 Phase 2). It is currently
possible for the live bridge to drop seconds of audio with no observable signal anywhere.

### 4.4 Backpressure — three layers, none of them "drop"

| layer | policy | number |
|---|---|---|
| worklet → main | `postMessage` transfer, **unbounded, never drops** | reuses the recorderbox-capture discipline verbatim (`recorderbox-capture.ts:1-11`) |
| main → socket | pause posting when `ws.bufferedAmount > 8 MiB`, count `stalledFrames`, resume under 2 MiB | 8 MiB ≈ 2.4 s at 3.456 MB/s (18 ch f32) |
| socket → disk | `RecordRing` SPSC, **131 072 frames** | 2 730 ms @ 48 kHz; 9.00 MiB at 18 ch f32 |

`handleBinary` on the record connection **copies into the ring and returns.** A dedicated
`RecordWriter` thread at `.utility` QoS drains it to disk. The connection queue and the writer thread
**never share a lock.**

**Ring sizing rationale.** The live ring is 16 384 frames because its consumer is a 2 ms poller. The
record ring's consumer is a *disk*, so it is sized for a write stall, not a scheduling jitter. 131 072
frames is a **budget, not a measurement** — the design ships a `ringPeak` (high-water occupancy)
telemetry field in `meters` from day one so it becomes a measurement in week one. Adjacent options,
so the tradeoff is visible when someone re-tunes it:

| frames | ms @ 48 kHz | MiB @ 18 ch f32 |
|---|---|---|
| 16 384 | 341.3 | 1.12 |
| 65 536 | 1 365.3 | 4.50 |
| **131 072** | **2 730.7** | **9.00** |
| 262 144 | 5 461.3 | 18.00 |
| 524 288 | 10 922.7 | 36.00 |

**On overflow the writer does NOT drop silently.** It zero-fills, increments `gapFrames`, and — per
**OQ-3, ANSWERED: hard-stop** — finalizes the take cleanly, so every file already on disk carries a
correct header and opens in a DAW. It does **not** continue with a logged gap: a take that plays but
is silently short is the exact failure this design exists to eliminate. ⚠ This policy is only
implementable **after** the §6.1(2) gap-accounting fix — today's counter cannot see the overflow at
all, so a hard-stop built on it would never fire.

### 4.5 File format — N discrete stereo BWF WAV files, 32-bit float, under 4 GiB, written natively

**8 files** `TAKE-<name>-<datetime>/01-ch01-02.wav` … `08-ch15-16.wav`, plus optional
`09-master.wav`. Video stays one MP4 (or N rolled MP4s) written by the browser as today.

```
WAVE_FORMAT_EXTENSIBLE / KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
2 ch · 48 000 Hz · 32-bit float · little-endian
+ bext (BWF v2, 602 B) with TimeReference = samples-since-midnight of the take's first sample
+ 36-byte JUNK placeholder immediately after RIFF, reserved for in-place ds64 promotion
```

**Why not one interleaved file** — the decisive row is the 4 GiB crossing (§5):
**16-ch interleaved = 23 min 18 s; a stereo pair = 3 h 06 min 25 s.** Independent of every other
argument, that alone settles it. On the other axes: one file means one extent map (a torn region
damages all 16 channels), one header (one failure), and inconsistent DAW behaviour (Reaper/PT/Nuendo
explode to tracks; Live/Logic downmix or import as one clip). Eight stereo files give per-pair damage
isolation and universal import.

**Why not the alternatives.** CAF has no size limit and `mChunkSize = -1` is purpose-built for
recording, but **Pro Tools and Ableton Live do not import CAF**. W64 solves size but Pro Tools does
not read it. FLAC is genuinely crash-resilient (decodable to the last complete frame) but is
**disqualified**: no 32-bit float (1.4.0 added 32-bit *integer*), 8-channel max, and 16-channel encode
CPU. A single MP4/MOV/MKV with N audio tracks is disqualified because AAC is lossy — unacceptable for
a multitrack master.

**Why 32-bit float, not 24-bit int:**
1. It is a `memcpy`. The wire is planar f32 (`BridgeProtocol.swift:24`), the ring is `Float`
   (`SPSCRing.swift:25`). 24-bit means a per-sample convert + a dither decision on 18 channels.
2. **DC-coupled CV can legitimately exceed ±1.0.** 24-bit int clips it; float does not. The bridge's
   whole CV contract is bit-transparency (`docs/DESIGN.md:105-108`).
3. Pro Tools' native session format *is* 32-bit float WAV — so the most conservative DAW argument
   points **at** float, not away from it.
4. The 33 % byte cost is irrelevant (§5).

**OQ-5, ANSWERED: 32-bit float, and the 24-bit switch is dropped from day one.** The owner's reasons
are 1 and 2 above — no clipping (CV exceeds ±1.0) and zero conversion on the write path. Ship one
format; a dither decision on 18 channels is not worth −25 % of a cost §5 already shows is irrelevant.

**RF64 by promotion — DEFERRED past day one (OQ-7).** The owner's DAW target is mainstream commercial
with takes kept **under 4 GiB**, so the promotion machinery below is **not day-one work**. Two things
survive into day one regardless: the **36-byte `JUNK` placeholder** (keeping a later promotion a
two-`pwrite` change), and the **enforced 4 GiB / 3 h 06 m 25 s per-pair ceiling** with a clean stop
before it. The rest of this subsection is the design for when RF64 lands — see §6.2.

EBU Tech 3306 prescribes exactly this: reserve a `JUNK` chunk
the same size as `ds64` at open, and switch `RIFF`→`RF64` / `JUNK`→`ds64` on the fly at the 4 GB limit
while recording continues. `ds64` is an 8-byte header + **28-byte payload** (`riffSize` u64,
`dataSize` u64, `sampleCount` u64, `tableLength` u32) = **36 bytes total**, and the promotion moves
**zero** audio bytes. A take under 3 h then reads as a bog-standard WAV everywhere.

**⚠ The promotion order is the opposite of the naive one (§7 G8).** Write `JUNK`→`ds64` **FIRST**,
then `RIFF`→`RF64`. A crash between the two leaves a `RIFF/WAVE` file containing an unknown `ds64`
chunk, which RIFF readers skip — a slightly-wrong plain WAV. The naive order leaves an `RF64` file
with no `ds64` chunk, which is valid as nothing.

**⚠ Never write `0xFFFFFFFF` placeholders (§7 G8).** A crash then leaves a file telling readers to
seek 4 GiB into a 300 MB file, which most tools refuse to open. Instead the 1 Hz header refresh writes
the **actual** sizes as of the last flushed sample. A crash then leaves a valid file that is short by
at most one refresh interval. Same single `pwrite`, strictly better failure mode.

**Header layout** — pad to 4096 B so audio data is page-aligned and the whole header is one `pwrite`:

```
0x0000  'RIFF' u32 riffSize   'WAVE'                12 B   <- riffSize @ 0x0004
0x000C  'JUNK' u32 28  <28 zero bytes>              36 B   <- becomes 'ds64'
0x0030  'fmt ' u32 40  WAVEFORMATEXTENSIBLE         48 B
0x0060  'fact' u32 4   sampleCount                  12 B   <- required for non-PCM; @ 0x0068
0x006C  'bext' u32 602 <BWF v2>                    610 B   <- TimeReference @ 0x006C+8+338
0x02D6  'JUNK' u32 <pad>                           ...
0x0FF8  'data' u32 dataSize                          8 B   <- dataSize @ 0x0FFC
0x1000  <interleaved L,R f32 samples>
```

(`bext` fixed part = 602 B: Description 256 + Originator 32 + OriginatorReference 32 +
OriginationDate 10 + OriginationTime 8 = 338 → `TimeReferenceLow` at offset 338; then +8 TimeRef,
+2 Version, +64 UMID, +10 loudness, +180 Reserved = 602. EBU Tech 3285.)

Header traffic: 9 files × 4 KiB × 1 Hz = **36 864 B/s.** Negligible.

**⚠ The 2 GiB signed-reader caveat.** The 4 GiB figure assumes readers treat the RIFF size as
*unsigned*. A long tail of tools treats it as signed and breaks at **2 GiB** = **1 h 33 min 12 s** for
a stereo f32 pair. Do not promote early (2 GiB is a reader bug, not a spec limit), but surface a card
warning past that mark.

**fsync policy.** The writer issues a plain `write(2)` per drain and a **`fsync(2)` (not
`F_FULLFSYNC`) once per second, immediately after the header refresh**, in that order: data first,
then header, then fsync. Worst-case loss on a hard crash is one second per file. `F_FULLFSYNC` is
deliberately avoided — it forces a device cache flush that can take tens of ms and buys durability
against power loss that a recording session does not need. **UNCONFIRMED:** the actual `fsync` latency
distribution on the owner's disks; measure it in Phase 3 and let it set the ring size.

### 4.6 Audio chunking — do NOT chunk the audio

The video keeps its existing 10-minute roll (`MAX_CHUNK_SECONDS = 600`, `OVERLAP_SECONDS = 5`). The
audio is **one continuous WAV per pair per take**, stopped cleanly before 4 GiB (RF64 promotion is
deferred — OQ-7).

Rationale: chunking the audio would introduce a *second* sync problem at every chunk boundary, for no
benefit — DAWs handle one long file fine, and the 4 GiB ceiling is 3 h 06 m away per pair. A 10-minute
chunk of a stereo f32 pair is only 230.4 MB, so chunking would also mean 8 × 6 = 48 files per hour.

**OQ-6, ANSWERED: one continuous WAV per pair.** The audio and video boundaries are therefore
deliberately **unaligned** — the video keeps rolling every ~10 min while the audio does not roll at
all — and **the manifest carries the alignment**. Nothing downstream may assume a shared boundary.

### 4.7 The video half — one seam changes

Everything in `recorderbox-recorder.ts` stays. **One line moves the CFR clock into the audio domain**
(`:554` and `:863`):

```ts
// today
this.t0 = performance.now();
const elapsed = (performance.now() - this.t0) / 1000;

// multitrack mode
this.t0Audio = ctx.currentTime;
const elapsed = ctx.currentTime - this.t0Audio;
```

**Why this makes drift structurally zero rather than tuned.** The audio file's length is a pure
function of worklet render quanta, which advance on the AudioContext sample clock. If the video PTS
grid is also indexed off `ctx.currentTime`, both files are in **one** clock domain and drift cannot
accumulate. If it stays on `performance.now()`, the two are different oscillators — see §5 for the
bound.

`ctx.currentTime` advances in render-quantum steps of 128 frames = **2.667 ms**, comfortably finer
than the 33.3 ms grid slot at 30 fps. Read from the main thread it is monotonic and non-decreasing.

Keep the existing `framesDue` / `DEFICIT_SLACK_FRAMES = 3` deficit logic unchanged
(`recorderbox-cfr.ts:63-79`) — it is a pace controller, not a clock, and works against either source.

**Take folder layout — OQ-10, ANSWERED: the helper owns it.** The browser writes the MP4 through its
existing OPFS → Save-As flow; the helper writes the WAVs directly to a native path. Two writers, one
folder. The user picks the root **once, natively**; the helper creates `TAKE-NNN/` (as
`TAKE-<name>-<YYYYMMDD-HHMMSS>/`) and **hands the absolute path back to the browser** in `status`.
The direction is pinned: path flows **helper → browser**, never the reverse. The card shows it and
offers "reveal in Finder". The browser's Save-As then defaults to the same folder — which the user
must confirm, because a browser cannot pre-seed a directory picker.

**OQ-11, ANSWERED: the deliverable is a folder of files** — one MP4 plus 9 WAVs, kept together. No
mux, no post-take remux pass. That is a deliberate durability choice, not a shortcut: a remux is a
second place for a take to die *after* the take is already over, so **a crashed take stays usable**
under this shape and would not under a muxed one. The container question stays closed.

### 4.8 Same-machine-only: what it buys and what it does not

The owner scoped this to one machine. Concretely:

**Buys:**
- `ws://127.0.0.1:9209` is reachable from `http://localhost:5173` (both non-secure contexts) — no
  transport work, no certificate, no `wss://`.
- The origin allowlist already covers it: no-Origin ✓, `localhost` ✓, `127.0.0.1` ✓
  (`WebSocketServer.swift:107-114`).
- Both halves share one disk, so "the take folder" is one place and free-space checks are meaningful.
- Both halves share the *machine's* clocks, which is what makes the §4.7 rebase possible.

**Does NOT buy:**
- **`https://patchtogether.live` cannot open `ws://127.0.0.1`.** Mixed-content blocking is absolute.
  The origin allowlist permits `patchtogether.live` at the *server* end, but the *browser* refuses to
  make the request. So on the deployed site the module is inert. Options considered: a `wss://`
  loopback bridge with a real certificate for a `*.localhost`-style name; a packaged app (Electron —
  already on the roadmap per `presentation-fullscreen-plan`).
  **OQ-12, ANSWERED: accept inert.** ES-9 RECORDERBOX works only from `http://localhost`; the
  `wss://` bridge and Electron packaging are out of scope. **Requirement that follows:** the card must
  **say why** on the deployed site — not merely disable itself. A dead control with no stated reason
  is indistinguishable from a bug, and will be reported as one. The copy has to name the actual cause
  (a secure page cannot open a plaintext localhost socket), not just "unavailable".
- It does not make the helper distributable — and **OQ-8 accepts that**: dev-only, built from source,
  no signing or notarization (§7 G3).
- It does not make the two processes' *failures* coordinated — they still have to agree to stop
  (§7 G7 / §4.9).

### 4.9 Disk-full and coordinated stop

Failure today would be: OPFS quota trips for the video at instant T₁, the native `pwrite` hits
`ENOSPC` at T₂ ≠ T₁, and you get 9 audio files truncated at one length and a video truncated at
another, neither side knowing the other stopped.

Required:
1. **Pre-flight at arm.** Native `statfs(2)` on the take folder AND browser
   `navigator.storage.estimate()`. Refuse to start below `expectedDuration × combinedRate × 1.2`.
2. **Live readout.** Add `freeBytes` and `recordSecondsRemaining` to the ~8 Hz `meters` message
   (`BridgeProtocol.swift`, meters section). Standard field-recorder UI, cheap, and it is what turns
   §5's "2 h 05 m runway" from a document into a number on the card.
3. **Low-water coordinated stop.** At **2 GiB free**, the helper sends `status:{state:"stopping",
   detail:"low-disk"}`, the browser stops the video encoder and finalizes, the helper finalizes all
   headers, and the take is marked complete-with-reason. Never discover this as a write error.
4. Same protocol for any hard failure on either side: whoever notices first sends `stopping` and the
   other finalizes.

### 4.10 The module

New file `packages/web/src/lib/video/modules/es9-recorderbox.ts`. `recorderbox` is **untouched** —
extending it in place would churn a shipped, heavily-tested module and its VRT/ART/docs pins.

```ts
export const es9RecorderboxDef: VideoModuleDef = {
  type: 'es9Recorderbox',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'es-9 recorderbox',        // lowercase per the label standard
  category: 'output',
  maxInstances: 1,                   // one record session in the helper
  inputs: [
    { id: 'in', type: 'video' },
    { id: 'p1L', type: 'audio' }, { id: 'p1R', type: 'audio' },  // … p2..p8 = 16 ports
    { id: 'mstL', type: 'audio' }, { id: 'mstR', type: 'audio' },
  ],
  outputs: [ { id: 'out', type: 'video' } ],   // passthrough, as recorderbox
  params: [ /* below */ ],
  docs: { … }, face: { … },
  factory(ctx, node) { … },
};
```

**16 discrete `audio` ports, not a multichannel cable.** `StandardCableType` is exactly
`audio | pitch | gate | cv | modsignal | polyPitchGate | keys | image | mono-video | video`
(`packages/web/src/lib/graph/types.ts:41-52`). Inventing a 16-wide type would touch every engine,
validator and cable-stripe path. **UNRESOLVED, MINOR:** facet 3 proposed a `stereoPairs` field on
`VideoModuleDef` to declare the pairing; `VideoModuleDef` has no such field today. It is a
nice-to-have for the rear-panel grouping, not load-bearing — the `face.rear.groups` already express
pairing. Defer.

**Factory — audio side.** Diverges from `recorderbox.ts:233-388` in one important way: **no
`MediaStreamAudioDestinationNode`, no per-pair merger, no 48 kHz resample bridge.** Those exist to
feed mediabunny's AAC encoder, which this path does not use.

```
18 x GainNode (one per audio input port, published via `audioInputs`)
   -> ChannelMergerNode(18)
   -> AudioWorkletNode 'es9-recorderbox-capture'  (18-in)
   -> GainNode(0) -> ctx.destination              (ORPHAN-SILENT keep-alive)
```

- The gains are the `audioInputs` map the cross-domain bridge connects into — the bridge does a plain
  `src.node.connect(dst.node, …)` against whatever `AudioNode` the video handle publishes, and
  recorderbox already publishes bare gains (`recorderbox.ts:384-387`).
- The **gain(0) keep-alive is load-bearing, not defensive.** An `AudioWorkletNode` with no path to
  `ctx.destination` is an orphan subgraph Chromium never pulls, so `process()` never runs
  (`recorderbox.ts:250-267`). Tap-only/inaudible contract preserved.
- The **ENCODABLE-RATE FIX is deliberately dropped.** It exists only because mediabunny's AAC profile
  picker chokes below 24 kHz (`recorderbox.ts:274-296`). This path writes PCM at whatever
  `ctx.sampleRate` is and the helper writes that number into the WAV header. A 16 kHz
  Bluetooth-pinned context produces a valid 16 kHz multitrack take, not a silent one.

**Params.**

| id | shape | default | notes |
|---|---|---|---|
| `mode` | discrete 0..1 | 0 | `0 = multitrack` (needs helper) / `1 = stereo` (today's browser path). **Never auto-switches.** |
| `pairs` | discrete 1..8 | 8 | armed pairs; unarmed are excluded from the channel mask, saving wire + disk |
| `master` | discrete 0..1 | 1 | also record `mstL/mstR` |
| ~~`bitDepth`~~ | — | — | **DROPPED (OQ-5)** — 32-bit float only; no 24-bit switch |
| ~~`fileLayout`~~ | — | — | **DROPPED (OQ-7/OQ-11)** — per-pair stereo WAVs only; no poly/RF64 layout day one |
| `quality` | discrete 0..2 | 0 | video tier — promotes `recorderbox-quality.ts` from card-only to a real param |
| `chunkMin` | discrete 0..2 | 1 | **video** roll interval 5 / 10 / 20 min (10 = today's 600 s) |

Static (card-only) control keys: `filename`, `record`, `helperStatus`, `takeRoot`, `recover`.

**The face.** Ranks 1–6 are the whole in-lane budget (`LANE_PLATE_MAX_CELLS = PLATE_COLS ×
PLATE_MAX_ROWS = 6`; `curated-face.ts:40-45` states outright that *"Ranks 7+ are DOCK-ONLY"*).

```ts
face: {
  order: [
    'record',      // 1  hero — RECORD/STOP
    'mode',        // 2  MULTITRACK | STEREO
    'master',      // 3
    'pairs',       // 4
    'quality',     // 5
    'bitDepth',    // 6  -- lane budget ends here --
    'fileLayout', 'chunkMin', 'filename', 'helperStatus', 'takeRoot', 'recover',  // 7+ dock-only
  ],
  glyph: 'meter',   // an 18-lane mini meter bridge
  pages: [
    { id:'record', label:'RECORD', controls:['record','mode','master','pairs','filename'] },
    { id:'audio',  label:'AUDIO',  controls:['bitDepth','fileLayout','chunkMin'] },
    { id:'video',  label:'VIDEO',  controls:['quality'] },
    { id:'helper', label:'HELPER', controls:['helperStatus','takeRoot','recover'] },
  ],
  rear: {
    groups: [
      { id:'signal', label:'picture',   ports:['in'] },
      { id:'pairs',  label:'pairs 1-8', ports:['p1L','p1R', /* … */ 'p8R'] },
      { id:'master', label:'master',    ports:['mstL','mstR'] },
    ],
    audioRate: ['p1L','p1R', /* … */ 'mstR'],
  },
}
```

`mini` (rank 1) shows RECORD + the meter glyph — what you want across a rack of 8 lanes mid-take. The
HELPER panel, take list and recovery prompt are rank-7+/page content, i.e. **dock-only**.

**⚠ This would be the FIRST video def carrying a `face`** (`video/module-registry.ts`: *"none
carry one yet"*). No marker discipline is needed: video defs are in the WebGL attest basis, but
a module-scope def's own `face`/`docs`/`controlFamilies` are stripped from the hash by
`scripts/attest-code-basis.ts`, so authoring them costs no GPU re-attest. ⚠ A **nested** `face:`
(e.g. on a geometry object) is *not* stripped — keep the face at the def's top level.

### 4.11 Patching it — two paths

**Path A (hand-patched).** The 18 ports are ordinary audio inputs; patch anything into them.

**Path B (workflow / automatic).** A janitor mirrors the column tails into the recorder. Precedent:
`cv-buddy-es9-reconcile.ts` — an independent graph-change reconciler with a pure planner and a
non-undo-tracked transaction.

```
packages/web/src/lib/graph/es9-recorderbox-reconcile.ts

planEs9Recorderbox(nodes, edges):
  for ch in 1..8:
    tail = source endpoint of the wcol- edge into pinned-mixmstrs.ch{ch}L / R
    if tail exists and ch <= pairs:
      desire e-es9rec-<recId>-p{ch}L : tail.left  -> p{ch}L  (audio)
      desire e-es9rec-<recId>-p{ch}R : tail.right -> p{ch}R  (audio)
  if master: desire pinned-mixmstrs.masterL/R -> mstL/mstR
  diff desired vs present `e-es9rec-` edges; write adds, delete stale.
```

Properties inherited from the precedent: deterministic edge ids ⇒ CRDT convergence; idempotent ⇒
empty plan on a converged graph ⇒ no transaction; its own `e-es9rec-` namespace ⇒ the stale-removal
pass structurally cannot touch a hand-drawn cable; lazy resolve ⇒ no `es9Recorderbox` node means the
janitor does nothing.

Relevant constants: `PINNED_MIXER_ID = 'pinned-mixmstrs'` (`column-reconcile.ts:67`),
`mixerChannelPorts(n) → { leftIn: 'ch{n}L', rightIn: 'ch{n}R' }` (`patch-convenience.ts:319-325`).

---

## 5. THE NUMBERS

All rates computed at 48 000 Hz. `f32` = 4 B/sample, `24-bit` = 3 B/sample. Video figure is the HIGH
tier, `DEFAULT_VIDEO_BITRATE = 14_000_000` bps (`recorderbox-recorder.ts:99`) ÷ 8 = 1 750 000 B/s.
GB/h is decimal (10⁹); the 4 GiB threshold is binary (4 294 967 296 B). Computed, not estimated.

| config | B/s | MB/s | GB/h | 4 GiB at |
|---|---:|---:|---:|---:|
| 1 ch f32 | 192 000 | 0.192 | 0.69 | 6 h 12 m 50 s |
| **stereo pair f32** | **384 000** | **0.384** | **1.38** | **3 h 06 m 25 s** |
| **16 ch f32** | **3 072 000** | **3.072** | **11.06** | **0 h 23 m 18 s** |
| 18 ch f32 (+master) | 3 456 000 | 3.456 | 12.44 | 0 h 20 m 43 s |
| 16 ch 24-bit | 2 304 000 | 2.304 | 8.29 | 0 h 31 m 04 s |
| 18 ch 24-bit | 2 592 000 | 2.592 | 9.33 | 0 h 27 m 37 s |
| video HIGH @14 Mbps | 1 750 000 | 1.750 | 6.30 | 0 h 40 m 54 s |
| **16 ch f32 + video** | **4 822 000** | **4.822** | **17.36** | — |
| **18 ch f32 + video** | **5 206 000** | **5.206** | **18.74** | — |

**The decisive row is the 4 GiB column: 23 m 18 s for a 16-ch interleaved file vs 3 h 06 m 25 s for a
stereo pair.** That is the whole argument for per-pair files, independent of every other axis.

**2 GiB signed-reader caveat:** a stereo f32 pair crosses 2 GiB at **1 h 33 m 12 s**.

**Recording the master costs +11.1 %** of wire and disk (3.456 vs 3.072 MB/s). The owner's *"if it's
performance wise possible"* is answered: **yes, trivially.**

### Bandwidth is a non-problem — say so and stop worrying about it

`dd` to the scratch volume (APFS, internal NVMe), 512 MiB, 1 MiB blocks — **measured**:

```
buffered:      536 870 912 B in 0.0896 s = 5 991 528 508 B/s  (5.99 GB/s)
conv=fsync:    536 870 912 B in 0.2406 s = 2 231 532 072 B/s  (2.23 GB/s)
```

Take the fsync'd **2.23 GB/s** as the honest sustained number. The combined A/V load of 4.822 MB/s is
**0.22 %** of it. Even a bus-powered USB 3.0 spinning drive at ~100 MB/s leaves **20×** headroom.

### Free space IS the ceiling

Bandwidth is 0.22 % of the disk; **free space is what actually stops a take.** On the
**33.68 GiB free this machine had on 2026-08-01** (92 % used) the runway is **2 h 05 m** at
16 ch f32 + video and **1 h 56 m** at 18 ch. Re-measure before quoting either — the durable
point is the ratio, not the snapshot. This is why §4.9's pre-flight + live
`recordSecondsRemaining` readout is a requirement, not a polish item.

### Ring, latency and clock figures

| quantity | value | derivation |
|---|---|---|
| live SPSC ring (existing) | 16 384 frames = **341.3 ms** | `BridgeAudioEngine.Config.ringFrames`, 16384/48000 |
| browser bridge ring (existing) | 8 192 frames = **170.7 ms** | `bridge-client.ts:44-47` |
| **live output cushion (the 8 ms fact)** | `min(bufferFrames×3, 4096)` = **384 frames = 8.0 ms** | `es9-bridge/main.swift:166` with default `--buffer 128` (`:56`) |
| **proposed record ring** | **131 072 frames = 2 730.7 ms**, 9.00 MiB @ 18 ch f32 | budget for a worst-case disk stall; **UNCONFIRMED** until `ringPeak` telemetry measures it |
| worklet quantum | 128 frames = **2.667 ms** | AudioWorklet render quantum |
| capture batch | 1 024 frames = **21.3 ms**, ~47 posts/s | `recorderbox-capture.ts:22-23`, reused |
| max wire block | 4 096 frames = **85.3 ms** | `BridgeWire.maxFrameCount:38` |
| WS message cap | 4 MiB | `WebSocketCodec.swift:98` |
| socket high-water | 8 MiB ≈ **2.4 s** @ 18 ch f32 | proposed; 8 388 608 / 3 456 000 |
| ES-9 hw safety offsets | 74 in / 14 out = **1.83 ms** | `README.md:118-126`; (74+14)/48000 |
| ES-9 round-trip | 6.3 ms @64, 9.0 @128, 14.3 @256, 25 @512 | `README.md:148-153`, recorded live probe |
| header refresh traffic | 9 × 4 KiB × 1 Hz = **36 864 B/s** | 4 KiB page-aligned header, 1 Hz |
| 10-min video chunk, stereo f32 equivalent | 230.4 MB | 600 × 384 000 |

### Drift bounds

| scenario | bound | derivation |
|---|---|---|
| video PTS on `ctx.currentTime` (**recommended**) | **structurally zero** | both files indexed off the same AudioContext sample clock |
| video PTS on `performance.now()` (today) | **≈0.36 s/hour worst case** | ±50 ppm crystal tolerance each side → 100 ppm relative × 3600 s. **UNCONFIRMED as a measurement** — this is the textbook part-tolerance bound, not something measured on this machine |
| ES-9 crystal, if the tap were post-resampler | ~108 ms/hour @ 30 ppm | why the tap must never be downstream of `StreamResampler` — moot under §4.1, retained as rationale |

---

## 6. OWNER DECISIONS — ALL 12 ANSWERED (2026-08-02)

**Nothing in this section is open.** The 12 questions this document originally posed were answered by
the owner in one pass on 2026-08-02. The decisions are recorded verbatim below; where a decision
settles a fork the body of the plan still describes both branches, the **consequence** column names
the section that is now single-branch.

Genuine engineering unknowns are **not** here — they are in §6.1, because they are things nobody
knows yet, not things the owner has to choose.

| OQ | decision | consequence |
|---|---|---|
| **1 MECHANISM** | **Separate record stream** on a `role:'record'` session, with its own logical channel space, decoupled from `engine.outputChannelCount`. The helper is a **pure file-writing service**. | §1's "ONE ASSUMPTION EVERYTHING RESTS ON" is now **CONFIRMED BY THE OWNER**, not merely resolved-by-design. §4.1 stands as written. |
| **2 ES-9 present?** | **No** — implied by 1. A take needs no hardware. | §8 in full: the record path is **100 % headless-testable**. This is the single biggest testing win in the plan and it is now load-bearing, not aspirational. |
| **3 Overflow** | **Hard-stop the take with a clean finalize.** Every file gets a correct header and opens in a DAW. | §4.4's fork collapses to (a). Never "continue with a logged gap": a short file that *plays* is the failure mode we are specifically buying our way out of. `gapFrames` is still counted — it is the **trigger** for the stop and the reason line in the take log. |
| **4 Master bus** | **Yes** — record it as a **9th pair**, 18 channels, default on. | +11.1 % wire and disk (3.456 vs 3.072 MB/s), accepted. `09-master.wav` is not optional. |
| **5 Bit depth** | **32-bit float.** No clipping (DC-coupled CV legitimately exceeds ±1.0) and zero conversion on the write path. | §4.5's four arguments stand. **The 24-bit switch is dropped from day one** — it buys −25 % disk in exchange for a dither decision and a clipping risk on CV, against a cost §5 already shows is irrelevant. |
| **6 Chunking** | **One continuous WAV per pair per take.** Video keeps rolling ~10 min; the **manifest carries the alignment**. | §4.6 stands. The audio and video chunk boundaries are deliberately **not** aligned; nothing may assume they are. |
| **7 DAW target** | **Mainstream commercial.** WAV float32 + **BWF `bext`**, kept **under 4 GiB**. **No RF64 on day one.** CAF and W64 are ruled out. | The largest change to the body. See §6.2 — the RF64 promotion machinery in §4.5 becomes **Phase-later**, and "under 4 GiB" becomes a **runtime obligation** (a 3 h 06 m per-pair ceiling that must be enforced, not just noted). |
| **8 Distribution** | **Dev-only.** Build from source. No signing, no notarization, no Homebrew tap yet. | §7 G3's Gatekeeper argument is **deferred, not answered**. The Phase-0 remote + CI for the native repo still stands (that is about the code existing at all, not about shipping it). "An exemption you cannot distribute is a demo" is **accepted as true** — this feature is explicitly a demo for now. |
| **9 Version skew** | **Refuse to arm**, and the card names **both** versions (required vs actual). **No per-block CRC** — it is a localhost loopback; TCP's checksum is sufficient. | §4.2 stands. The `crc32c` field at wire offset 28 (§4.3) is **removed**; do not spend the bytes or the CPU. |
| **10 Take folder** | **The helper owns it.** Picked once, natively; the helper creates `TAKE-NNN/` and **hands the path back to the browser** so the video lands in the same folder. | §4.10 stands, with the direction pinned: path flows **helper → browser**, never the reverse. The browser's File System Access picker does not cover the audio and must not pretend to. |
| **11 Deliverable** | **A folder of files.** No mux, no post-pass. | Deliberate: **a crashed take stays usable.** A remux step would be a second place for a take to die, after the take is already over. The container question stays closed. |
| **12 Deployed** | **Accept inert** on `https://patchtogether.live`. Works only from `http://localhost`. | §4.8 stands. **New requirement:** the card must *explain why* — not merely disable itself. A dead control with no reason is a bug report waiting to happen. |

### 6.1 ENGINEERING UNKNOWNS — not owner questions

These are open because **nobody knows the answer yet**, not because a decision is pending. No owner
input can close them; only measurement or code can. Recorded here so they are not mistaken for
settled design.

1. **The record ring size is a BUDGET, not a measurement.** 131 072 frames (2 730.7 ms, 9.00 MiB at
   18 ch f32) was *chosen* to survive a worst-case disk stall that has never been observed on the
   owner's machine. It is a guess with a table around it. **The design ships a `ringPeak` (high-water
   occupancy) telemetry field in `meters` from day one precisely so week one converts it into a
   measurement.** Until that number exists, treat the ring depth as unvalidated — and note the
   instrument only reads true if `ringPeak` is a high-water mark that is never reset mid-take.
2. **The `sampleTime += got` gap-accounting defect must be fixed BEFORE any drop detection can
   work.** `bridge.worker.ts:198` counts frames **SENT**; the same function discards ring content at
   `:179` and `:183` **without touching the counter**. The stream is therefore **gapless by
   construction across a drop**, so any detector reading `sampleTime` can never fire — it is not a
   weak detector, it is a *dead* one. This blocks OQ-3's hard-stop policy outright: you cannot
   hard-stop on an overflow you are structurally unable to see. Fix = a `producedFrames` counter
   incremented in the worklet on **every** `process()` regardless of ring acceptance, carried in the
   v2 header, **plus a mandatory negative-control test that forces a drop and asserts the number
   moves.** Per this repo's own VALIDATE-THE-INSTRUMENT rule, the negative control is not optional:
   without it the new counter can be exactly as blind as the old one and nothing would say so.
3. **The A/V drift bound is DERIVED, not measured.** The ≈0.36 s/hour worst case is
   ±50 ppm × 2 × 3600 s — the textbook part-tolerance arithmetic, not a number observed on this
   hardware. It is quoted as a bound to justify §4.7's rebase onto `ctx.currentTime` (which makes the
   drift *structurally* zero and therefore makes the bound moot). **Do not cite 0.36 s/hour as a
   measurement**, and do not use it to size anything.

Carried over from §7 and still unknown, in the same category: whether Apple's `kAudioFileBW64Type`
writer emits a correct `ds64` for a >4 GiB float file (now lower priority — OQ-7 defers RF64); the
real worst-case APFS write-stall (item 1 above); whether `kAUDefaultMaxFramesPerSlice` should be read
back from the AU at runtime rather than trusting the 1156 figure; whether MIXMSTRS's Faust DSP
reports internal latency; and the fact that **no ES-9 was attached during this synthesis**, so
channel counts come from the vendor page plus the repo's recorded live probe.

### 6.2 What OQ-7 changes in the body of this plan

The "no RF64 day one" decision is the only answer that contradicts text elsewhere in this document.
Reconciled here rather than by rewriting §4.5, so the reasoning survives if the decision is revisited:

- **§4.5's format line is now: discrete stereo BWF WAV, 32-bit float, under 4 GiB.** Not "BWF/RF64".
- **The `JUNK` placeholder at 0x000C stays.** It costs 36 bytes, it is invisible to every reader, and
  it is what makes a later RF64 promotion a two-`pwrite` change instead of a rewrite. Reserving it is
  not the same as implementing promotion.
- **The promotion logic, the torn-window ordering (`ds64` first, `RIFF` second), and its byte-exact
  test move to a later phase** — they are not day-one work.
- **"Under 4 GiB" becomes an enforced runtime limit, not a footnote.** A stereo f32 pair crosses
  4 GiB at **3 h 06 m 25 s**. Without RF64 that is a **hard ceiling**, so the take must stop cleanly
  before it — which is exactly OQ-3's policy, reached by a different route. A take that runs past it
  and silently produces an invalid header is precisely the "plays fine, dies in the DAW a week later"
  failure this plan exists to prevent.
- **Unchanged by OQ-7:** never write `0xFFFFFFFF` placeholders (§7 G8) — the 1 Hz real-size header
  refresh is day-one work regardless, because it is what makes a crashed take readable.

---

## 7. WHAT THE CRITIQUES FOUND

Not buried. The first three are in §1 because they change the design.

### RESOLVED — the design changed

**D1 — the capture point cannot hold 8 stereo stems.**
`Sources/es9-bridge/main.swift:84-98`: 16 USB output channels; USB 1–8 are the internal blocks (main
mix, phones, S/PDIF, ES-5); the 8 physical jacks ride USB 9–16 = **4 stereo pairs**. `outClientPlanes`
is allocated at `outCh = 16` (`BridgeService.swift:127-128`) and `guard c < outCh` (`:305`) silently
discards anything past it. **Resolution: §4.1** — the record stream is a separate logical channel
space on a `role:'record'` session, decoupled from `engine.outputChannelCount`. Facet 3 had
independently specced this; facets 1 and 2 had not.

**D2 / G1 — "gap accounting is free" is FALSE. Both critiques found it independently.**
`bridge.worker.ts:198`: `sampleTime += got` — `got` is frames **sent**. `:179` and `:183`:
`outRing?.skip(outRing.occupancy)` — frames **discarded**, counter untouched. `es9-ring.ts:59-63`:
`write` truncates and returns short **with no drop counter**. The stream is therefore **gapless by
construction across a drop** and the proposed detector can never fire. Concrete failure: the helper
restarts at minute 12, the worker backs off up to `RECONNECT_MAX_MS = 5000` (`bridge.worker.ts:53`)
and jumps straight to max on `busy` (`:155`); ~5 s of audio is discarded; the WAVs are 5 s short;
every event after minute 12 sits 5 s early against the video; the take *plays*, so nobody notices
until a DAW session a week later. **Resolution: §4.3** — a `producedFrames` counter incremented in the
worklet on **every** `process()` regardless of ring acceptance, carried in a v2 header, plus a
**mandatory negative-control test** that forces a drop and asserts the number moves.

**D3 — the wrong transport policy was selected, and the right one is already in the repo.**
`packages/dsp/src/recorderbox-capture.ts:1-11` documents the lossless MessagePort design and states it
was *"the fix for recorderbox's recording clicks/pops"*. The ES-9 bridge is a fixed 8192-frame
skip-on-full ring — right for monitoring, wrong for archival. **Resolution: §4.4** — three explicit
backpressure layers, none of which drop.

**D4 — file I/O on the connection queue would starve the live outputs; the cushion is 8 ms, not
341 ms.** `handleBinary` runs on the connection's **serial** queue (`WebSocketServer.swift:20-22`,
`:207`) and is the sole producer for `outputRing`; block it and `renderOutput` runs its underrun
policy (`BridgeAudioEngine.swift:300-324`). The cushion is not the 16 384-frame ring depth — the PI
controller servos occupancy to `outputTargetFrames = min(bufferFrames × 3, 4096)` =
**384 frames = 8.0 ms** at the default `--buffer 128` (`es9-bridge/main.swift:56`, `:166`). Any write
stall over 8 ms is a guaranteed underrun on all 16 outputs. **Resolution: partly free, partly
designed.** The role split gives the record connection *its own* serial queue, so it structurally
cannot block the live one — but §4.4 still mandates ring-and-writer-thread so that a stalled writer
becomes TCP backpressure rather than unbounded renderer memory.

**D5 — A/V drift is not bounded.** **Resolution: §4.7** — rebase the video CFR clock onto
`ctx.currentTime`. Structurally zero rather than tuned. Bound if not done: §5.

**G8 — a half-written WAV is garbage, and the RF64 promotion has a torn window.** `0xFFFFFFFF`
placeholders make a crashed file tell readers to seek 4 GiB into a 300 MB file. The EBU promotion is
two edits (`RIFF`→`RF64` at 0x0000 and `JUNK`→`ds64` at 0x000C); crashing between them yields an
`RF64` file with no `ds64` chunk. **Resolution: §4.5** — write real sizes at every 1 Hz refresh, never
placeholders; and promote **ds64 first, RIFF second**, so a torn promotion degrades to a plain WAV
with an unknown skippable chunk.

**G7 — disk-full is unhandled on both sides and fails at two different instants.**
`grep -rn "storage.estimate|QuotaExceeded" packages/web/src/lib/video/` → zero hits in any recorderbox
file; the native side has no `statfs`. **Resolution: §4.9** — pre-flight both sides, live
`recordSecondsRemaining`, coordinated stop at a 2 GiB low-water mark.

**G6 — no version negotiation, and the update cadences are asymmetric.** `protocolVersion` has
**zero comparison sites** (verified: one grep hit, the declaration at `es9-protocol.ts:34`). The
helper silently ignores unknown JSON types and unknown binary frames
(`guard let block = try? BridgeWire.decode(data) else { return }`, `BridgeService.swift:289`). The
browser updates on every deploy; the helper binary does not. Failure mode: RECORD lights, meters move,
the video appears, **zero audio files are written, no error anywhere.** **Resolution: §4.2** — hard
version gate at `hello`, refuse to arm, show required-vs-actual on the card.

### BLOCKING PREREQUISITES — not design flaws, but nothing ships without them

**G3 — the one native component the whole feature depends on has no remote, no CI, no signing.**
Verified: `git remote -v` → empty; `ls .github/workflows` → No such file or directory; 4 commits, local
disk only. The 35 hardware-free tests are the best asset in this project and **nothing runs them**.
There is no `codesign`/notarization story anywhere. If the machine dies, the feature's native half
ceases to exist. **→ Phase 0.**

**G4 — the re-enable path already written into the code does not work.**
`per-module-per-port-behavioral.spec.ts:109` has promised *"Re-enable path: a mock es9-bridge WebSocket
fixture"* for months. The obvious implementation is blocked: the socket is opened inside a module
Worker (`bridge.worker.ts`), and Playwright's `routeWebSocket` is page-scoped. **UNCONFIRMED — flagged
as a high-confidence blocker, not verified by experiment; worth a 30-minute spike.** The seam that
*does* exist and nobody uses is `VITE_ES9_BRIDGE_URL` (`bridge-client.ts:50-53`), so the fixture is a
**real Node WS server on a test port** speaking the protocol — not route interception. That one fixture
unblocks `es9`, `cvBuddy` **and** `es9Recorderbox` simultaneously. **→ Phase 1.**

**G5 — the new module auto-enrols in three sweeps it can only fail, and ratchets the ledger the wrong
way.** `es9` is already whole-module exempt from per-port (`per-module-per-port.spec.ts:102`),
behavioral (`per-module-per-port-behavioral.spec.ts:113`) and VRT (`vrt-exemptions.ts:309`). The
behavioral exemption cap is **frozen at 77** and its comment says it can only shrink
(`per-module-per-port-behavioral.spec.ts:1570`). Adding `es9Recorderbox` without the fixture means a
third permanent hardware exemption **plus a cap raise** — directly against `reconcile-means-fix-or-delete`.
**Sequencing the fixture first turns that into a cap REDUCTION.** This is the single strongest argument
for the phase order in §9.

### STILL OPEN — now ENGINEERING unknowns only (§6.1)

Every owner-facing item that used to live here has been answered — the DAW question is closed
(**OQ-7: mainstream commercial, WAV+`bext`, under 4 GiB, no RF64 day one**), which also closes the
CAF/W64 exclusion. What remains needs measurement, not a decision:

- Whether Apple's `kAudioFileBW64Type` writer emits a correct `ds64` for a >4 GiB float file
  (**UNCONFIRMED** — must be tested by writing 5 GiB and opening it in a DAW; this is why §4.5 specs a
  hand-rolled writer rather than `AudioFile`).
- Real worst-case APFS write-stall on the owner's machine (**UNCONFIRMED** — the 131 072-frame ring is
  a budget; `ringPeak` telemetry converts it to a measurement in Phase 3).
- `kAUDefaultMaxFramesPerSlice` (the 1156 figure) is **not present in the current public SDK headers** —
  only the selector at `AudioUnitProperties.h:904`. Read it back from the AU at runtime rather than
  trusting the constant.
- Whether MIXMSTRS's Faust DSP reports internal latency (matters for a stems↔master null test).
- No ES-9 was attached during this synthesis — `system_profiler SPAudioDataType` listed only built-in
  devices — so channel counts come from the vendor page and the repo's recorded live probe
  (`README.md:148-153`), not a fresh probe. Minor discrepancy: the vendor page says 44.1/48/88.2/96 kHz;
  the recorded probe says 32/44.1/48/88.2/96. Immaterial — everything here is pinned at 48 kHz, and the
  browser AudioContext is hard-pinned to 48 000 Hz anyway (`Canvas.svelte:6960-6963`).

---

## 8. TESTABILITY

**The headline: under the §4.1 design, the record path contains no hardware, so it is entirely
coverable headless.** This is a direct consequence of decoupling the record stream from the audio
device, and it is the strongest practical argument for that choice.

### Coverable headless — native (`swift test`)

`BridgeServiceIntegrationTests` already stands up a real `BridgeService` on a real loopback port
driven by `URLSessionWebSocketTask` against `SyntheticEngine`. Everything below runs there:

- record-session handshake, role arbitration, `busy` on a second record client, version-mismatch refusal
- v2 block encode/decode, channel-mask expansion (no 24-bit packing — dropped, OQ-5)
- `RecordRing` wrap / overflow / underflow / threaded sequence (mirrors the existing `SPSCRing` tests)
- **the gap-accounting negative control** — force a drop, assert `gapFrames` moves (§4.3). **This one
  is mandatory, not optional**: it is what proves the new counter is not as blind as the old one
  (§6.1(2)). Without it, "gap accounting works" is an untested claim about an instrument.
- **the hard-stop on overflow** (OQ-3) — force the overflow, assert the take finalizes and every file
  on disk has a correct header
- **the 4 GiB ceiling** (OQ-7) — assert the take stops cleanly *before* the crossing rather than
  writing a header it cannot express
- WAV byte-exactness: header layout, `fmt ` extensible, `bext` offsets, `fact`, `data`
- *(deferred with RF64 — OQ-7)* the promotion and its torn-window ordering: write 4 GiB+1 through a
  fake sink, assert `ds64` lands before `RIFF`→`RF64`
- **crash truncation** — kill the writer mid-take, assert the last-written header describes a valid,
  openable file (not `0xFFFFFFFF`)
- **ENOSPC** — `throw ENOSPC` from the fake sink rather than actually filling a disk
- 45-minute drift behaviour in ~4 seconds, via an injectable clock

**Seams that MUST be injectable, or none of the above is possible:**

| # | seam | status |
|---|---|---|
| 1 | `VITE_ES9_BRIDGE_URL` — point the client at a mock | **exists**, `bridge-client.ts:50-53` |
| 2 | `BridgeEngineProtocol` / `SyntheticEngine` | **exists** — the record path must sit behind this, never behind `BridgeAudioEngine` |
| 3 | **`FileSink` protocol** — write to memory, assert bytes, throw ENOSPC | **does not exist; must be built** |
| 4 | **injectable clock** — run a 45-min drift test in 4 s | **does not exist; must be built** |
| 5 | `makeWriter` / `remuxToFlatMp4` (`recorderbox-recorder.ts:354`, `:378`) | **exists** — the browser half already has this discipline; the native half has none |

### Coverable headless — web (vitest)

Module def shape, param ranges, face ordering vs `LANE_PLATE_MAX_CELLS`, the capture worklet's
batching and `producedFrames` arithmetic, the CFR rebase math, the reconciler's pure planner
(idempotence, deterministic ids, stale removal scoped to `e-es9rec-`), disk pre-flight arithmetic.

Registry-driven sweeps the new module auto-enrols in and must be run locally before pushing:
`per-module-per-port --grep es9Recorderbox`, `per-module-per-port-behavioral`, `vrt --grep es9Recorderbox`.

### Coverable e2e — but only after the fixture

A real Node WS server on a test port speaking the record protocol, injected via
`VITE_ES9_BRIDGE_URL`. Then: arm → record → stop → assert N files with expected byte lengths; version
mismatch refuses to arm; helper disappears mid-take → coordinated stop. **This fixture is Phase 1 and
it retires three existing exemptions rather than adding a fourth (§7 G5).**

### Needs real hardware

Under the §4.1 design: **nothing in the record path.** The ES-9 is only needed for the pre-existing
live monitoring path, which is already covered by `e2e/tests/es9-hardware.spec.ts` and owner
hardware-verification.

### Permanently uncovered — accept and document

- **The DAW import matrix.** Whether Pro Tools / Live / Logic / Reaper / Nuendo actually open these
  files. This is a manual checklist, run once per format change. OQ-7 set the target
  (**mainstream commercial, WAV float32 + `bext`, under 4 GiB**) but a target is not a verification —
  the checklist still has to be run. "Past 4 GiB" drops off it until RF64 lands.
- **Real sustained-write behaviour on the owner's actual disks**, including external and network
  volumes. `ringPeak` telemetry makes it observable in the field; it cannot be asserted in CI.
- **Gatekeeper / notarization UX** on a machine that has never seen the binary.
- **Long-take thermal/throttling behaviour** over multi-hour sessions.

---

## 9. PHASING

Gated behind the new shell + Push 2, per the brief. Ordered so the first increments are small,
provable, and **independently valuable even if ES-9 RECORDERBOX is never built**.

### Phase 0 — make the native half exist as a real project *(blocks everything; no feature code)*

- Push `../patchtogether.es9` to a remote. It currently has **none**.
- Add `.github/workflows/ci.yml` running `swift test` — 35 hardware-free tests that nothing runs today.
- **OQ-8, ANSWERED: dev-only.** Build from source; no signing, no notarization, no Homebrew tap.
  Document that decision (and that it makes this a demo, not a distributable feature) rather than
  building a distribution pipeline now. The remote + CI above are still required — they are about the
  code existing at all, not about shipping it.

*Provable by:* a green `swift test` badge on a remote.
*Value if abandoned here:* the existing helper stops being one disk failure away from nonexistence.

### Phase 1 — the mock-bridge fixture *(the highest-leverage single piece of work in this plan)*

A real Node WS server on a test port speaking protocol v1, injected through the existing
`VITE_ES9_BRIDGE_URL` seam. **Not** Playwright `routeWebSocket` — the socket lives in a Worker
(§7 G4, UNCONFIRMED, spike it first for 30 minutes).

- Retire the `es9` whole-module exemptions in `per-module-per-port.spec.ts:102`,
  `per-module-per-port-behavioral.spec.ts:113`, and eventually `vrt-exemptions.ts:309`.
- **Lower** the behavioral cap from 77 (`:1570`) — the ledger moves the right way for once.

*Provable by:* `es9` passing the registry sweeps with no exemption.
*Value if abandoned here:* two long-standing exemptions retired, `cvBuddy` unblocked too.

### Phase 2 — `producedFrames` on the EXISTING live path *(fixes a live bug, no new feature)*

- Worklet counter incremented on every `process()` regardless of ring acceptance.
- Carried on the wire; counters on all four silent-drop sites (§3.2 table).
- Surfaced in `meters`; **the negative-control test is the acceptance criterion.**

*Provable by:* forcing a drop and asserting the number moves — headless, via Phase 1's fixture.
*Value if abandoned here:* the live ES-9 bridge stops being able to lose seconds of audio invisibly.

### Phase 3 — the native record service, headless, zero UI *(the first "feature" increment)*

- `role:'record'` session + arbitration + version gate.
- v2 record block header.
- `RecordRing` (131 072 frames) + `RecordWriter` thread at `.utility`.
- `FileSink` protocol; WAV/BWF writer; the enforced 4 GiB ceiling with a clean stop before it (RF64
  promotion **deferred** — OQ-7; keep the 36-byte `JUNK` reservation); 1 Hz real-size header
  refresh; `fsync` policy; `statfs` pre-flight; ENOSPC; `ringPeak` + `freeBytes` telemetry.
- **The browser is not modified at all** — the client is a test harness.

*Provable by:* `swift test` alone. Write 5 GiB through a memory sink, assert bytes; force ENOSPC;
kill the writer and assert the file opens.
*Value if abandoned here:* a tested, standalone multitrack file-writing service.

### Phase 4 — the browser module

- `es9-recorderbox.ts` def, 18-port factory, `es9-recorderbox-capture` worklet, `record.worker.ts`
  with the `bufferedAmount` high-water mark.
- The `face` (first video def to carry one — hash-transparent, no markers needed).
- `DESCRIPTIONS` entry in `module-manifest.ts`, `STRICT_DOCS` entry, `EXPECTED_NODE_TYPES` entry,
  `docs:accept`.
- Run the registry sweeps locally, 3× per the flake standard, before pushing.

*Provable by:* vitest + Phase 1's fixture driving a full arm→record→stop through the real module.

### Phase 5 — the marriage

- CFR clock rebase onto `ctx.currentTime` (§4.7) — behind the `mode` param so the stereo path is
  byte-identical to today.
- Take-folder coordination, coordinated low-disk stop, browser-side `navigator.storage.estimate()`
  pre-flight, recovery across both halves.

*Provable by:* a headless A/V sync assertion — record a click at a known audio frame and a known video
frame, assert their offset is under one grid slot. **Wait on frame counts via rAF, never wall-clock**
(CLAUDE.md).

### Phase 6 — the workflow janitor

`es9-recorderbox-reconcile.ts` mirroring column tails into the recorder, modelled on
`cv-buddy-es9-reconcile.ts`.

*Provable by:* pure-planner unit tests — idempotence, deterministic ids, namespace isolation.

### Estimated CI wall-time delta

Phases 0–3 add **zero** to `inet.modular` CI (they are native-repo or fixture work; the native tests
run in their own repo). Phase 1's fixture is a Node process on a test port — a few seconds, and it
*removes* skipped-module overhead. Phase 4 adds one module to the registry sweeps, which is the normal
per-module cost. Phase 5's sync assertion is the only item with meaningful risk; keep it frame-counted
and under 200 frames. **Nothing here is expected to exceed the ~2-minute sign-off threshold, but
re-estimate at Phase 5.**

---

## 10. QUICK REFERENCE — every file:line this plan depends on

**Native (`../patchtogether.es9` @ `b22bf3c`)**
```
Package.swift:29-44                     macOS 15, zero third-party deps
Sources/ES9Core/BridgeProtocol.swift:15-38   v1 wire header, maxFrameCount 4096
Sources/ES9Core/BridgeService.swift:127-128  outClientPlanes allocated at outCh
Sources/ES9Core/BridgeService.swift:186-191  single-client 'busy'
Sources/ES9Core/BridgeService.swift:288-336  handleBinary (the rejected tap point)
Sources/ES9Core/BridgeService.swift:298      silent min(frameCount, stagingCapacity)
Sources/ES9Core/BridgeService.swift:305      guard c < outCh  (silent discard)
Sources/ES9Core/BridgeService.swift:329-331  discarded outputRing.write return
Sources/ES9Core/BridgeService.swift:345-375  drain loop, usleep(2000)
Sources/ES9Core/BridgeAudioEngine.swift:40-53  ringFrames = 16384
Sources/ES9Core/BridgeAudioEngine.swift:300-324 underrun policy (cv hold / audio 64-frame fade)
Sources/ES9Core/SPSCRing.swift:20-41,55-85    lock-free planar SPSC
Sources/ES9Core/WebSocketServer.swift:20-22   per-connection serial DispatchQueue
Sources/ES9Core/WebSocketServer.swift:107-114 origin allowlist
Sources/ES9Core/WebSocketServer.swift:207     queue creation
Sources/es9-bridge/main.swift:56              default --buffer 128
Sources/es9-bridge/main.swift:70-98           THE ES-9 CHANNEL MAP (jacks = USB 9-16)
Sources/es9-bridge/main.swift:166             outputTargetFrames = min(buffer*3, 4096) = 8.0 ms
docs/DESIGN.md:105-108,167-168                CV bit-transparency; the swapped-halves bug
README.md:118-126,148-153                     live probe: 16x16, offsets 74/14, RTT ladder
```

**Web (`inet.modular` @ `77cd1bbc`)**
```
packages/web/src/lib/audio/modules/audioin.ts:42-47,78-86   Chrome 2-ch ES-9 ceiling (empirical)
packages/web/src/lib/audio/modules/mixmstrs.ts:38-48         ch{1..8}L/R + masterL/R
packages/web/src/lib/audio/es9/bridge-client.ts:44-53        RING_FRAMES 8192, VITE_ES9_BRIDGE_URL
packages/web/src/lib/audio/es9/bridge.worker.ts:53,155       RECONNECT_MAX_MS, busy -> max backoff
packages/web/src/lib/audio/es9/bridge.worker.ts:175-200      drain: skip sites + sampleTime += got
packages/web/src/lib/audio/es9/es9-ring.ts:51-63             write truncates, no drop counter
packages/web/src/lib/audio/es9/es9-protocol.ts:34            protocolVersion (zero comparison sites)
packages/dsp/src/es9-bridge.ts:167-172                       "Ring full ... drop the block"
packages/dsp/src/recorderbox-capture.ts:1-23                 LOSSLESS MessagePort tap, BATCH_FRAMES 1024
packages/web/src/lib/video/modules/recorderbox.ts:245        dest.channelCount = 2
packages/web/src/lib/video/modules/recorderbox.ts:250-296    orphan-silent guard; encodable-rate fix
packages/web/src/lib/video/recorderbox-recorder.ts:99-111    bitrates, MAX_CHUNK_SECONDS 600, OVERLAP 5
packages/web/src/lib/video/recorderbox-recorder.ts:554,863   performance.now() clock (the rebase seam)
packages/web/src/lib/video/recorderbox-cfr.ts:63-79          framesDue, ptsForFrame, DEFICIT_SLACK 3
packages/web/src/lib/video/recorderbox-store.ts:1-32         OPFS + IndexedDB, origin-local
packages/web/src/lib/video/module-registry.ts:29-41          face/docs on VideoModuleDef, none carry one
packages/web/src/lib/graph/types.ts:41-52                    StandardCableType (no multichannel)
packages/web/src/lib/graph/column-reconcile.ts:67            PINNED_MIXER_ID
packages/web/src/lib/graph/patch-convenience.ts:319-325      mixerChannelPorts
packages/web/src/lib/ui/Canvas.svelte:6960-6963              AudioContext pinned to 48000 Hz
e2e/tests/per-module-per-port.spec.ts:102                    es9 whole-module exemption
e2e/tests/per-module-per-port-behavioral.spec.ts:109,113,1570 re-enable promise; exemption; cap 77
e2e/vrt/vrt-exemptions.ts:309                                es9 VRT exemption
```

---

*Synthesized 2026-08-01 from three research facets and two adversarial critiques. Where the facets
disagreed, §7 records the resolution and which facet was wrong; nothing was averaged.*

*Owner decisions on all 12 questions recorded 2026-08-02 (§6). Every downstream contradiction they
created was reconciled in place rather than left for a reader to notice — §6.2 lists the OQ-7 ones
explicitly, because deferring RF64 turns "4 GiB" from a footnote into an enforced runtime limit. The
remaining unknowns (§6.1) are engineering, not owner input: the record ring size is a **budget**
awaiting `ringPeak` telemetry, the `sampleTime += got` gap-accounting defect **blocks** any drop
detection and must be fixed first, and the A/V drift bound is **derived, not measured**.*
