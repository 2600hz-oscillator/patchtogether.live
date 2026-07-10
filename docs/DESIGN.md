# ES-9 ↔ patchtogether bridge — design

**Date:** 2026-07-10 · **Status:** native side BUILT in this repo; browser side
PLAN ONLY (see `docs/inet-modular-es9-module-plan.md`) because other
inet.modular work is in flight.

## Goal

Full 16×16 audio **and CV** between a Eurorack system (via the DC-coupled
Expert Sleepers ES-9) and patchtogether running in the browser — both
directions, e.g. a hardware Maths LFO modulating a patchtogether CV input,
and a patchtogether LFO driving a hardware VCA through an ES-9 output jack.

The browser cannot do this alone (verified in
`../inet.modular/.myrobots/plans/es9-stereo-io.md`): `getUserMedia` caps the
ES-9 at its first stereo pair and `setSinkId` selects whole devices, never
channel ranges. So the system is three parts:

```
┌─────────────────────┐   CoreAudio AUHAL    ┌──────────────────────┐
│  ES-9 (USB, 16×16,  │◄────full duplex─────►│  es9-bridge (this    │
│  DC-coupled ±10 V)  │   one clock, 48 kHz  │  repo, Swift, native)│
└─────────────────────┘                      └──────────┬───────────┘
                                                        │ ws://127.0.0.1:9209
                                             JSON control + binary Float32
                                                        │
                                             ┌──────────▼───────────┐
                                             │  browser: harness    │
                                             │  (today) / es9 module│
                                             │  in inet.modular     │
                                             │  (planned)           │
                                             └──────────────────────┘
```

### Decision-of-record note

`inet.modular/.myrobots/plans/es9-stereo-io.md` records an earlier decision
(`feedback_no_native_helper_apps`) rejecting native companion apps for the
web build. **The owner explicitly reversed that for the ES-9 use case on
2026-07-09** ("build an ES-9 app … build a module inside inet.modular which
has all the I/O jacks for ES-9"). This repo is that app. It is an
arm's-length separate process speaking a documented protocol and imports no
inet.modular (AGPL) source — the shape the license-split plan calls "the
cleanest boundary". `patchtogether.native` (macOS-only, no web tech, in-process
engine) is a different product on a different track; nothing here goes there.

## Native app: `es9-bridge`

One process, three layers, all in `Sources/ES9Core` + `Sources/es9-bridge`:

1. **RT audio** — `BridgeAudioEngine`: one full-duplex AUHAL bound to the
   ES-9 (the pattern `DuplexEngine` proved live: one unit ⇒ one I/O thread ⇒
   one hardware clock ⇒ no intra-device drift). Non-interleaved Float32, so
   per-channel work is memcpy. The render callbacks are allocation-free and
   lock-free; they only move blocks through two SPSC rings and update plain-C
   RMS accumulators.
2. **Rings** — `SPSCRing`: lock-free single-producer/single-consumer planar
   Float32 rings (Synchronization-framework atomics, power-of-two capacity).
   `input ring` = RT → drain; `output ring` = network → RT. The output ring
   doubles as the jitter buffer (primed with `outputTargetFrames` of silence,
   default 3× the hardware buffer).
3. **Service** — `BridgeService` + `WebSocketServer`: a dependency-free
   HTTP/WebSocket server (Network.framework + hand-rolled RFC 6455, loopback
   bind only) serving the embedded test harness on `/` and protocol v1 on
   `/ws`, plus a drain thread (~2 ms cadence) that pumps rings ↔ socket
   through `StreamResampler`.

### Why a plain WebSocket (and not WebRTC / WebTransport)

On loopback, TCP has no loss, so WebSocket's head-of-line blocking — the only
real argument against it for audio — doesn't materialize; with `noDelay` a
block crosses in well under a millisecond. `ws://127.0.0.1` is a
potentially-trustworthy origin, so the HTTPS-served patchtogether page can
open it (Chromium — which the app already requires for `setSinkId`;
inet.modular sets **no CSP**, and COEP does not gate WebSockets — verified).
WebRTC data channels or WebTransport would each drag a large dependency and
handshake apparatus into the native app to solve packet-loss problems
loopback doesn't have. A future Windows bridge speaks the same protocol; the
transport is the portable contract, the audio backend (CoreAudio → WASAPI) is
the per-OS part.

### Clock model

Two independent crystals: the ES-9's and whatever clock drives the browser's
`AudioContext`. Drift is inevitable; the bridge absorbs it, the RT path never
blocks:

- **client → hardware**: `StreamResampler` (linear interpolation, all
  channels phase-locked) converts client rate → hardware rate, with a
  multiplicative trim (clamped ±2%) steered by `BufferFillController`, a
  gentle PI controller on output-ring occupancy. Buffer sits at target ⇒ trim
  = 1 + drift ppm.
- **hardware → client**: sent at nominal ratio; the client's worklet ring
  does standard jitter-buffer sample-slip (the harness implements this; the
  planned module mirrors it).

Linear interpolation is deliberate for v1: it is *exact* for held DC — the CV
guarantee — clean at LFO rates, acceptable for audio; a windowed-sinc can
slot behind the same interface later. With both sides at 48 kHz (inet.modular
hard-pins its AudioContext to 48 kHz; the bridge defaults the ES-9 to 48 kHz)
the resampler idles at ratio ≈ 1 ± drift.

### CV correctness rules

- **Bit-transparent hardware path.** No DC blocker, no limiter, no AGC
  anywhere between socket and DAC/ADC (the web app's `audio-out` safety chain
  must NOT be replicated for ES-9 jacks). Float ±1.0 ↔ ES-9 full scale
  (±10 V nominal).
- **Underrun policy is per-channel** (`outputModes` in the config message):
  - `cv` → **hold last sample**. A CV snapping to 0 V on a hiccup would yank
    every patched parameter.
  - `audio` → linear fade to silence over 64 frames, with fade state carried
    across render callbacks so a ring that runs dry near a callback boundary
    still gets the full click-free fade.
- **Disconnect** flips all channels to `audio` so the fade releases held CVs
  (a stuck +5 V into a rack after the browser tab closes is worse than a
  released LFO).
- **Volts↔float scaling lives in the browser module, not here.** The bridge
  moves raw full-scale floats; the module knows patchtogether's conventions
  (cv ±1 full-depth, pitch 1.0/oct with 0 V = C4, gate 0/1 @ 0.5 threshold)
  and applies per-jack class scaling. Keeping the native path raw keeps the
  protocol product-agnostic and the calibration in one place.

### Security

Loopback bind alone is insufficient — any web page in any browser tab may
attempt `ws://127.0.0.1:9209`. WebSocket upgrades are therefore gated on the
**Origin** header: no Origin (local non-browser processes) ✓, loopback
origins ✓, `patchtogether.live` + subdomains ✓, everything else → 403.
Browsers cannot forge Origin. A pairing token can be layered into `hello`
later if needed. Robustness hardening: concurrent connections are capped
(32), messages are capped (4 MB, ≤4096 frames/block), client frames must be
masked, and the frame decoder is iterative (a fragment flood cannot blow the
stack — regression-tested).

### Session policy (v1)

One active client; later connections get `{"type":"status","state":"busy"}`
and are closed. Meters/status go to the active client at ~8 Hz. Multi-client
mixing/arbitration is explicitly deferred.

### Port

Default **9209** (`--port` to change). Avoids inet.modular's reserved 1234
(Bitwig OSC), 1235 (Hocuspocus), 5173/4173 (Vite).

## Protocol v1 (the platform contract)

Full details in `Sources/ES9Core/BridgeProtocol.swift` (the file is the
spec). Summary:

- **Text frames** — JSON control: `hello{rate,name?}` →
  `deviceInfo{protocolVersion,name,uid,rate,inputChannels,outputChannels,bufferFrames,inputLabels,outputLabels}`;
  `config{inputMask,outputMask,outputModes{ch:"audio"|"cv"}}`;
  `meters{inputRMS,outputRMS,underruns,overruns,outputBufferFrames}` (~8 Hz);
  `status{state,detail?}`; `ping{t}`/`pong{t}`.
- **Binary frames** — audio/CV blocks, little-endian, 20-byte header
  `{u8 type=0x01, u8 flags=planar-f32, u16 seq, u64 sampleTime, u32 channelMask,
  u16 frameCount≤4096, u16 rsvd}` + one `frameCount×f32` plane per set mask
  bit, ascending. Bridge→client = ES-9 input channels; client→bridge = ES-9
  output channels. Masks make bandwidth proportional to use (all 16 both ways
  is still only ~3 MB/s per direction — trivial on loopback).
- Channel labels come from `deviceInfo` — ES-9 defaults: inputs 1–14 = the
  DC-coupled jacks, 15/16 = S/PDIF return; outputs 1–8 = the DC-coupled
  jacks, 9–16 = internal mixer buses.

## Latency budget (48 kHz, 128-frame hardware buffer, defaults)

| segment | ≈ |
| --- | --- |
| ES-9 ADC→bridge (safety offset + buffer) | 4–5 ms |
| ring + drain cadence + WS + decode | 2–3 ms |
| browser worklet jitter buffer (~2048 samples harness / ~384 planned module) | 8–43 ms |
| **hardware → browser one-way** | **~14 ms (module target) / ~50 ms (harness monitor)** |
| browser → hardware (jitter target 384 frames + buffer + DAC) | ~14 ms |

CV/LFO use is insensitive to this; for audio it's comfortable jam range. Knobs:
`--buffer`, `--target-frames`, and the module-side ring target.

## Testing

- 35 hardware-free tests: pair-routing math (original 9), wire-protocol
  encode/decode, SPSC ring (incl. threaded sequence test), resampler (incl.
  the DC-exactness CV guarantee), RFC 6455 codec (incl. the RFC §1.3 vector),
  and **full-stack integration tests** driving a real socket against
  `SyntheticEngine` (hello/config/audio both ways/meters/busy/origin-gate).
- With hardware: `es9-bridge`, open `http://127.0.0.1:9209/`, patch a cable
  ES-9 out 1 → ES-9 in 1, press **measure** — the harness reports true
  browser→rack→browser round trip.

## Windows path (later)

Implement the same protocol over WASAPI (the ES-9 is class-compliant; USB
Audio 2.0 works on Win10 1703+, or Expert Sleepers' ASIO driver via an ASIO
host layer). `BridgeProtocol`, the resampler strategy, and the browser module
carry over unchanged; only the `BridgeAudioEngine` equivalent is new. Keep
the Swift code's layering (engine / rings / service) as the reference
architecture.

## Open items

1. **Volt calibration constants** — ±10 V nominal full scale is assumed;
   measure the real ADC/DAC full scale (they can differ) and expose a
   per-device calibration in `deviceInfo` later. Until then the module's
   scaling classes use the nominal figure.
2. **Device hot-unplug** — the bridge should watch
   `kAudioHardwarePropertyDevices`/`IsAlive` and emit
   `status{state:"device_lost"}` + rebind on return. Not yet implemented.
3. **ES-9 expanders** (more channels over the same USB device) — protocol
   already carries dynamic channel counts + labels; the module plan reserves
   UI space. Explicitly out of scope for v1.
4. **Hog mode / exclusive access** — shared mode ships; hog is a possible
   later toggle (README's open decision list).
5. **Licensing of this repo** — intentionally unset; the bridge imports no
   AGPL source, so the owner may choose. Decide before shipping binaries.
