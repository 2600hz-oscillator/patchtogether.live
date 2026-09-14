# patchtogether.nativeapps

The umbrella repo for patchtogether's **native companion apps** ("bridges"):
local helpers that give the browser app capabilities the web platform
structurally cannot provide, each an arm's-length process speaking a
documented localhost protocol.

| Target | What it is |
| --- | --- |
| `BridgeKit` (lib) | The shared bridge platform: dependency-free RFC 6455 WebSocket server (Network.framework, loopback-only, Origin-gated), the binary wire format (planar-f32 audio blocks + MIDI event blocks), shared control messages. Extracted from `../patchtogether.es9`. |
| `vst-bridge` (exe) | Hosts the user's installed **Audio Unit** plugins (the AU builds of their "VSTs") and bridges audio+MIDI to the browser. This is the native half of the planned inet.modular **VST BRIDGE** card. |
| `VSTBridgeCore` (lib) | The vst-bridge internals: plugin discovery/registry, the AU host, the MIDI queue, the bridge service, editor windows. |
| `es9-bridge` | **Not here yet.** `../patchtogether.es9` remains the shipping ES-9 bridge, untouched; its app migrates onto BridgeKit only when the owner wants to regression-test that move. Nothing in this repo edits that one. |

## Quick start (vst-bridge)

**`swift build` only compiles — it does not start anything.**

```sh
swift run -c release vst-bridge
```

Then open **<http://127.0.0.1:9309/>** in Chrome and press **"start audio"**.
The embedded harness shows every installed plugin (with a filter box) —
mount one, feed it the built-in tone/noise generators, play it from the
on-screen MIDI keyboard (or the `awsedftgyhuj…` computer-key rows), watch
meters/scope, and click **open editor** to get the plugin's real UI as a
native macOS window. **Ctrl-C** stops the bridge.

Other invocations:

```sh
swift build -c release             # compile only
.build/release/vst-bridge --list   # print every installed AU plugin and exit
.build/release/vst-bridge --port 9310
.build/release/vst-bridge --allow-origin '*.pages.dev'   # PR previews
swift test                         # 34 hardware-free tests (see below)
```

Flags (`vst-bridge --help`):

| Flag | Meaning |
| --- | --- |
| `--port N` | HTTP/WS port (default **9309** — 9209 is the es9 bridge, 9210 is its documented port-busy fallback) |
| `--allow-origin HOST` | allow an extra browser Origin (repeatable; `*.suffix` works). Loopback + `patchtogether.live` are always allowed |
| `--dock` | show a Dock icon (default: accessory app; editor windows still open and focus) |
| `--list` | list installed plugins and exit |

> **Gotchas**
> - Bare `swift run` fails once this package has more than one executable —
>   name `vst-bridge` explicitly (habit from the es9 repo, where this bites).
> - **"Port already in use"** usually means an earlier `vst-bridge` outlived
>   its terminal. The error names the PID and the `kill` to run.
> - Piping stdout to a file block-buffers the startup banner — the server is
>   up anyway; check `curl -sI http://127.0.0.1:9309/`.
> - Unlike the es9 bridge there is **no microphone-permission prompt**: the
>   bridge opens no audio hardware at all. The browser is the clock and the
>   speaker; the helper just renders plugins.

## What "client-clocked" means (vs the ES-9 bridge)

The es9 bridge sits between two independent crystals (ES-9 hardware vs the
browser's AudioContext) and therefore needs SPSC rings, a resampler, and a
PI controller on buffer occupancy. **This bridge has no hardware clock.**
The browser's audio blocks ARE the clock: each inbound block renders exactly
that many frames through the plugin at the browser's sample rate,
synchronously, and the result goes straight back carrying the *same*
`sampleTime`. No rings, no resampling, no drift — and a mounted-but-idle
bridge does zero work.

- Effects: browser sends stereo audio blocks → plugin output comes back.
- Instruments: browser sends **clock-only blocks** (mask 0, no planes) plus
  timestamped MIDI (0x02 frames) → audio comes back. MIDI lands
  sample-accurately inside the render span (`MidiQueue` + the
  immediate-plus-offset AU scheduling convention).
- Nothing mounted: bit-transparent bypass (input echoes back), so the path
  is provable and latency measurable before any plugin is involved.
- **One WebSocket connection = one plugin instance** (cap 16): an
  instrument card and an effect card each hold their own plugin over their
  own socket. `hello.clientId` parks an instance across reconnects (page
  refresh keeps the mounted plugin + state for 90 s).

Protocol spec: `Sources/VSTBridgeCore/VSTProtocol.swift` (the file is the
contract; the future card duplicates its shapes per the cross-repo
convention). Design + decisions: `docs/vst-bridge-design.md`.

## Why Audio Units (and not the VST3 SDK) for v1

Practically every commercial macOS plugin ships an AU build alongside its
VST3 — hosting AUs covers the user's plugin folder with pure Swift and
system frameworks, zero third-party dependencies, and gets v3 plugins
out-of-process crash isolation for free. The host sits behind
`PluginDescriptor`/`PluginHost` so a VST3 backend (C++ SDK, MIT since
Nov 2025) can slot in later with an `id` scheme of `vst3:…`. See
`docs/vst-bridge-design.md` §Decisions, and the feasibility research at
`~/.myrobots/vst-plan/vst-bridge-feasibility-2026-08-19.md`.

## Tests

`swift test` — 34 tests, all hardware-free and third-party-plugin-free:

- wire codecs (audio + MIDI blocks, malformed-input rejection),
- the RFC 6455 layer (including the RFC §1.3 handshake vector,
  fragmentation, mask enforcement) and the Origin policy,
- the MIDI queue (ordering, tie-breaking, overflow),
- **real plugin hosting** using Apple's built-ins, present on every Mac:
  AUDelay renders audio, DLSMusicDevice plays a MIDI note, state
  round-trips,
- **full-stack integration**: a real `VSTBridgeService` on an ephemeral
  port driven through a real WebSocket — handshake, bypass, wire-level
  mount + render, MIDI→instrument audio, busy/takeover.

## Status on this machine (2026-08-19)

Built with Swift 6.3.1 on macOS 26. All 34 tests pass. `--list` finds 189
installed plugins (Apple built-ins + the Arturia collection). Harness
serves; Origin gate verified (403 for foreign origins, 101 for
`dev.patchtogether.live`).

## Scope / roadmap

- **Now (this repo, v0.1):** build-and-run-locally vst-bridge, harness
  proof, protocol spec for the card.
- **Next:** the inet.modular VST BRIDGE card (browser side — clone of the
  es9 card seam: `bridge-client` / worker / SAB rings / worklet, plus the
  `midi-timing.ts` clock projection for MIDI).
- **Later:** es9-bridge migrates here onto BridgeKit (regression-tested
  against real hardware when the owner is ready); signing/notarization/
  distribution (deliberately out of scope for v1 — see the feasibility doc);
  VST3 backend; per-instance child processes for v2 plugins.
