# patchtogether.es9 — the ES-9 ↔ patchtogether bridge

Native macOS app (**`es9-bridge`**) that opens the **Expert Sleepers ES-9**
(16-in / 16-out USB-C, DC-coupled ±10 V) full duplex via CoreAudio and
streams **audio AND CV both directions** to a browser over a localhost
WebSocket — so patchtogether can patch a hardware Maths LFO into a browser CV
input, and send a browser LFO out of a real ES-9 jack into the rack.

- **Design:** `docs/DESIGN.md` (architecture, protocol v1, clock/CV model,
  security, latency budget).
- **Browser module plan (inet.modular — plan only, not yet implemented):**
  `docs/inet-modular-es9-module-plan.md`.
- The original CoreAudio 16×16 spike (`es9-devices`, `es9-duplex`,
  `DuplexEngine`) is retained unchanged below — it remains the reference for
  the AUHAL pattern and was verified live on hardware.

## Quick start

**`swift build` only compiles — it does not start anything.** To actually run
the bridge you must invoke the built binary (or use `swift run`):

```sh
# No hardware needed — synthetic test signals on inputs 1-3:
swift run -c release es9-bridge --synthetic

# With an ES-9 attached:
swift run -c release es9-bridge
```

Then open **<http://127.0.0.1:9209/>** in Chrome and press **"start audio"**.
The embedded harness has per-channel meters, generators (sine/LFO/DC), a
CV-aware scope, and a loopback latency test (patch ES-9 out 1 → in 1 with a
cable). **Ctrl-C** stops the bridge.

You should see:

```
SYNTHETIC mode: inputs 1-3 carry 440 Hz sine / 0.5 Hz LFO / 1 Hz gate.

Bridge running:
  harness : http://127.0.0.1:9209/
  protocol: ws://127.0.0.1:9209/ws
Open the harness in Chrome, press "start audio", and patch away.
Ctrl-C to stop.
```

Equivalent two-step form, if you'd rather build once and run the binary
directly (faster startup, and what you'd ship):

```sh
swift build -c release          # compiles only — no server starts
.build/release/es9-bridge --synthetic
```

> **Gotchas**
> - Bare `swift run` fails with `error: multiple executable products
>   available: es9-duplex, es9-devices, es9-bridge` — this package has three
>   executables, so you must name `es9-bridge` explicitly.
> - **"Port already in use"** almost always means an earlier `es9-bridge` is
>   still running. Closing its terminal does *not* stop it — the process is
>   reparented to launchd and keeps holding both the port and the ES-9, so a
>   later run fails to bind *and* can't open the device. The bridge names the
>   culprit and the remedy:
>   ```
>   Port 9209 is already in use by PID 41558 (es9-bridge).
>   That's another es9-bridge — it also still holds the audio device.
>   Stop it with:  kill 41558
>   Or use a different port:  es9-bridge --port 9210
>   ```
>   To find a stray one yourself: `pgrep -fl es9-bridge`. Always stop the
>   bridge with **Ctrl-C** rather than just closing the window.
> - Piping the bridge's output to a file or another command makes stdout
>   block-buffered, so the startup banner won't appear until it exits. That's
>   normal shell buffering, not a hang — the server is up; check with
>   `curl -sI http://127.0.0.1:9209/`.
> - On first run macOS may prompt for **microphone permission** (CoreAudio
>   input counts as "mic"); grant it or inputs stay silent.

Flags (`es9-bridge --help`):

| Flag | Meaning |
| --- | --- |
| `--port N` | HTTP/WS port (default **9209**) |
| `--buffer N` | hardware I/O buffer frames (default **128**) |
| `--sr RATE` | hardware sample rate (default: device nominal) |
| `--device NAME` | match a device by name substring (default `ES-9`) |
| `--target-frames N` | jitter-buffer target, hw frames (default 3× buffer) |
| `--synthetic` | run without hardware: test signals on inputs 1-3 |
| `--list` | list devices and exit |

> Note: this repo previously stated the native integration would live in
> `patchtogether.native` and that no browser companion app would exist. The
> owner reversed that for the ES-9 on 2026-07-09 — this repo *is* the bridge
> product now; `patchtogether.native` remains a separate track. See
> `docs/DESIGN.md`.

---

# Original spike documentation (still accurate for the ES9Core AUHAL layer)

> Why native at all? The browser app (`../inet.modular`) can only reach the
> **first** stereo pair of the ES-9 (`getUserMedia` exposes a device's first two
> channels) and can only select a whole output **device** (`setSinkId`), never a
> channel range. There is no Web Audio API to bind an arbitrary hardware channel
> pair. Per-pair 16×16 is therefore a native-only capability. See the web plan:
> `../inet.modular/.myrobots/plans/es9-stereo-io.md` and the modules it grounds:
> `../inet.modular/packages/web/src/lib/audio/modules/audioin.ts`,
> `.../audio-out.ts`, `.../devices.ts`.

---

## TL;DR recommendation

- **API:** one **HAL Output AudioUnit** (`kAudioUnitSubType_HALOutput`, "AUHAL")
  configured for **full duplex** against the ES-9 — input enabled on bus 1,
  output on bus 0, both bound to the same device with
  `kAudioOutputUnitProperty_CurrentDevice`. One AUHAL = one I/O thread = one
  hardware clock for both directions ⇒ **no cross-device drift, no resampling.**
  This is the canonical low-latency single-interface duplex pattern (Apple TN2091).
- **Client format:** **non-interleaved Float32** so each of the 16 channels is its
  own buffer in the `AudioBufferList`. Per-pair / per-channel routing is then a
  straight `memcpy` of channel buffers — no de-interleave math on the RT thread.
- **Latency:** set `kAudioDevicePropertyBufferFrameSize` low (64–128 frames). On
  the real ES-9, measured round-trip estimate is **~6.3 ms @ 64 frames**,
  **~9.0 ms @ 128** (48 kHz). The ES-9's reported safety offsets are 74 in / 14
  out frames.
- **Addressing:** expose the 16×16 as 8 input pairs + 8 output pairs; each pair
  becomes one native "ES-9 IN" / "ES-9 OUT" module (mirroring the web AUDIO IN /
  AUDIO OUT cards, but for any pair).
- **Mode:** ship **shared mode** for the MVP (coexists with system audio,
  simplest). Hog/exclusive mode is an optional later toggle. **No aggregate
  device** needed — the ES-9 is a single duplex interface.

---

## What this repo contains

A SwiftPM package (no third-party deps; system frameworks only):

| Target | What it is |
| --- | --- |
| `ES9Core` | CoreAudio HAL helpers, device discovery, the pure pair-routing model, and the full-duplex AUHAL engine. |
| `es9-devices` (exe) | Enumerate devices, find the ES-9, dump its capabilities + per-pair map + a latency-vs-buffer table. Safe with no hardware. |
| `es9-duplex` (exe) | Open the low-latency duplex IOProc, do channel-addressable passthrough (input pair N → output pair M), with per-channel RMS metering. |
| `ES9CoreTests` | Hardware-free unit tests for the addressing math (pair↔channel mapping, route parsing/validation, RMS→dBFS, latency formula). |

### Status on this machine
Built with Swift 6.3.1 / Xcode CLT on macOS 26. **All 9 unit tests pass.** The
ES-9 happened to be attached, so the spike was verified **live**: `es9-devices`
correctly identified it (16×16, SR 32/44.1/48/88.2/96 kHz, buffer range 15–4096),
and `es9-duplex --buffer 128` **opened the duplex AUHAL and ran passthrough with
live metering** (idle inputs read ~-84 dBFS noise floor, as expected).

---

## How to run it (against your ES-9)

```sh
swift build -c release        # or: swift build  (debug)

# 1) Enumerate + identify the ES-9, print its pair map + latency table:
.build/release/es9-devices

# 2) Low-latency duplex passthrough. Patch a source into ES-9 input 1/2,
#    listen on ES-9 output 1/2; watch per-channel RMS:
.build/release/es9-duplex --buffer 128 --routes "1:1"

#    Other examples:
.build/release/es9-duplex --buffer 64  --routes "1:1,3:5"   # in1/2→out1/2, in3/4→out5/6, 64-frame buffer
.build/release/es9-duplex --all-pairs                       # every input pair → same output pair
.build/release/es9-duplex --buffer 256 --seconds 10         # run 10s then exit
.build/release/es9-duplex --list                            # list devices and quit
.build/release/es9-duplex --help
```

The ES-9 is **class-compliant** — no driver. Plug it in via USB-C and confirm it
appears in Audio MIDI Setup. `es9-duplex` exits non-zero with a clear message if
no ES-9 is found. On first run macOS may prompt for **microphone permission**
(CoreAudio input counts as "mic"); grant it.

> Tip for proving low latency by ear: feed a click/percussive source into an
> input pair and compare the direct monitored sound to the passed-through output
> at `--buffer 512` vs `--buffer 64` — the slap-back shortens audibly.

---

## Design — the CoreAudio approach in depth

### Why AUHAL over the alternatives

| Approach | Verdict |
| --- | --- |
| **HAL Output AudioUnit (AUHAL), single instance, full duplex** | **Chosen.** Both directions on one device, one clock, lowest practical latency, built-in `AudioConverter` if a client format differs, channel-map support, runs on CoreAudio's RT thread. Apple's recommended way to do device I/O above a raw IOProc. |
| Raw device **`AudioDeviceIOProc`** (`AudioDeviceCreateIOProcID`) | Lowest-level, marginally less overhead, but you hand-roll format handling and lose the AUHAL conveniences. Worth it only if profiling shows AUHAL overhead matters — it won't at our channel counts. Keep as a fallback. |
| **`AVAudioEngine`** | Higher-level/Swifty, great for effect graphs, but its multichannel device-I/O + arbitrary hardware-channel routing story is awkward and it adds a tap/format layer we don't want on the hot path. Not ideal for raw 16×16 per-pair I/O. |
| **Aggregate device** | Only needed to *combine* multiple physical interfaces under one clock. The ES-9 is already a single 16×16 duplex device, so **no aggregate is required** — and aggregates add a drift-correction/clock-master layer we'd rather avoid for a single interface. |

### Device discovery (find the ES-9)
Query `kAudioHardwarePropertyDevices` on the system object, then for each device
read `kAudioObjectPropertyName`, `kAudioDevicePropertyDeviceUID`,
`kAudioDevicePropertyStreamConfiguration` (per-scope channel counts),
`kAudioDevicePropertyTransportType` (= `…TransportTypeUSB` for the ES-9), and the
sample-rate/buffer/latency properties. Match the ES-9 by **name/UID** containing
`ES-9`/`ES9`/`Expert Sleepers` (`DeviceInfo.looksLikeES9`). Prefer matching by the
stable **UID** for persistence across reboots/ports; the observed UID looks like
`AppleUSBAudioEngine:Expert Sleepers Ltd:ES-9:<serial>:2,3`.

### Per-pair / per-channel routing (the Bitwig model)
The 16×16 device is exposed as **8 input pairs + 8 output pairs**
(`PairRouting.swift`): pair *p* = channels *2p, 2p+1*, UI-labelled 1-based
("1/2"…"15/16"). A `RoutingPlan` is a validated list of `PairRoute`
(inputPair→outputPair). The engine compiles it into a flat
`outputChannel → inputChannel` map; the non-interleaved client format makes
applying it a per-channel `memcpy`. Two ways to bind a specific hardware pair:
1. **Client-format full width + index** (what the spike does): use the full
   16-channel non-interleaved format and copy from/to the desired channel index.
   Simplest for an engine that owns all channels.
2. **`kAudioOutputUnitProperty_ChannelMap`**: tell the AUHAL to expose only a
   sub-range (e.g. device ch 4,5 → client ch 0,1). Useful if a single module
   wants a narrow 2-channel client view of one pair. Documented for the
   per-module case; the spike uses (1) for the whole-device engine.

In the native app each pair becomes a module: **ES-9 IN 3/4** has
`audio_l_out`/`audio_r_out` ports (exactly like the web `audioin.ts`), **ES-9 OUT
5/6** has `audio_l_in`/`audio_r_in` (like `audio-out.ts`). The engine's render
callback reads input-pair buffers into the module graph and writes module outputs
into the bound output-pair buffers.

### Buffer size / latency tuning
Latency is **1:1 with buffer size** (TN2091). Set
`kAudioDevicePropertyBufferFrameSize` (clamp to
`kAudioDevicePropertyBufferFrameSizeRange`, 15–4096 on the ES-9). Round-trip
frames ≈ `inputSafetyOffset + inputLatency + buffer + outputSafetyOffset +
outputLatency + buffer` (`DeviceDiscovery.roundTripFrames`); divide by sample
rate for ms. Measured on the real ES-9 @48 kHz: **64→~6.3 ms, 128→~9.0 ms,
256→~14.3 ms, 512→~25 ms.** Start the app at 128 and expose a buffer control;
go to 64 for live performance if the host CPU keeps up without dropouts.

### Safety / clock concerns
- **Sample-rate match:** input and output share the device's nominal rate on one
  AUHAL — set it once via `kAudioDevicePropertyNominalSampleRate`; no per-stream
  mismatch. The ES-9 supports 44.1/48/88.2/96 kHz.
- **Drift:** none within the ES-9 (single clock). Drift only appears if you mix
  the ES-9 with a *different* device — then you'd need an aggregate (with a clock
  master + drift correction) or async-SRC. The MVP stays on the ES-9 alone, so
  this is avoided entirely.
- **Exclusive / hog mode** (`kAudioDevicePropertyHogMode`): grabbing the device
  exclusively can shave a little latency and stop the OS mixer from touching it,
  but it blocks all other apps from the ES-9 and is underdocumented/fiddly.
  **Recommendation: shared mode for MVP**, hog mode as an opt-in "exclusive"
  toggle later.
- **DC-coupled outputs:** the ES-9 outputs are DC-coupled (±~10 V) so they can
  emit CV, not just audio. The render path must therefore **not** insert an
  HPF/DC-blocker or AGC/limiter on the hardware path the way the web `audio-out`
  does for speaker safety — a DC-blocker would destroy CV. Keep the native ES-9
  output path **bit-transparent** (optionally per-pair "audio (limited)" vs "CV
  (raw)" mode). This is a real difference from the browser sink.
- **Device hot-unplug:** production code should listen for
  `kAudioHardwarePropertyDevices` / device-`IsAlive` changes and stop/rebind
  gracefully (noted; the spike just runs while the device is present).

### Slotting into a native engine's RT render callback
The AUHAL input callback `AudioUnitRender`s the device input into preallocated
non-interleaved buffers; the output callback fills the device output buffers.
Between them sits the engine's per-block render: read bound input-pair buffers →
run the module graph (a DSP block at `bufferFrames`) → write bound output-pair
buffers. The hot path is **allocation-free / lock-free** (preallocated
`AudioBufferList`s, plain C accumulators for metering) — the discipline the
native engine must keep. The pair-routing types here (`PairRoute`,
`RoutingPlan`, `StereoPair`) are the contract the native "ES-9 I/O" modules bind
to. **This repo is the reference; the integration lives in
`patchtogether.native` (ES-9 tasks #38/#40) — not edited here.**

---

## Open decisions (for the native integration)

1. **Exclusive vs shared mode** — MVP = shared; add a hog-mode toggle later?
2. **MVP pair count** — ship all 8 in / 8 out pairs at once, or start with 1–2
   pairs and expand? (The model already handles all 8; it's a UI/UX call.)
3. **Per-pair output mode** — expose an "audio (safety-limited)" vs "CV (raw,
   bit-transparent)" switch per output pair, given DC-coupled outputs?
4. **Buffer-size UX** — fixed safe default (128) vs user-exposed slider; auto-fall
   back on dropout detection?
5. **S/PDIF pair** — the ES-9 also has S/PDIF I/O; include it as an extra
   addressable pair or analog-only for v1?

---

## References

- Apple **TN2091** — *Device input using the HAL Output Audio Unit* (the AUHAL
  full-duplex + channel-map pattern):
  https://developer.apple.com/library/archive/technotes/tn2091/_index.html
- `kAudioDevicePropertyBufferFrameSize` / `…Range`, `kAudioDevicePropertyLatency`,
  `kAudioDevicePropertySafetyOffset` — CoreAudio HAL property reference.
- ES-9 product page (class-compliant 16×16, DC-coupled, 44.1–96 kHz):
  https://www.expert-sleepers.co.uk/es9.html
- Web app references (read-only context):
  - `../inet.modular/.myrobots/plans/es9-stereo-io.md` — the browser-side plan +
    the explicit native boundary this repo crosses.
  - `../inet.modular/packages/web/src/lib/audio/modules/audioin.ts`,
    `.../audio-out.ts`, `.../devices.ts` — the AUDIO IN / AUDIO OUT modules whose
    per-pair native equivalents this enables.
