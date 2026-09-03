# vst-bridge — design

**Date:** 2026-08-19 · **Status:** native side BUILT in this repo (v0.1,
local build/run only); browser side (inet.modular VST BRIDGE card) not yet
started. Grounded in the feasibility research at
`~/.myrobots/vst-plan/vst-bridge-feasibility-2026-08-19.md`.

## Goal

Mount the user's installed plugins ("VSTs") from their Mac into
patchtogether running in the browser: the card sees the installed plugins,
mounts one, sends audio and MIDI to it, and gets audio back — live. A
browser cannot `dlopen` a plugin binary (structural, not a missing API), so
the plugin runs in this native helper and the browser talks to it over the
same localhost-WebSocket shape the ES-9 bridge proved in production.

```
┌──────────────────────┐  AUAudioUnit render   ┌──────────────────────┐
│  the user's plugins  │◄─────(in-process, ───►│  vst-bridge (this    │
│  (AU builds: Serum,  │      v3 out-of-proc)  │  repo, Swift, native)│
│  Arturia, Apple, …)  │                       └──────────┬───────────┘
└──────────────────────┘                                  │ ws://127.0.0.1:9309
     editor UI = native NSWindow on the same Mac          │
     (no UI streaming — the huge win over     JSON control + binary blocks
      AudioGridder-style remote hosting)                  │
                                               ┌──────────▼───────────┐
                                               │  browser: harness    │
                                               │  (today) / VST BRIDGE│
                                               │  card in inet.modular│
                                               │  (planned)           │
                                               └──────────────────────┘
```

## The clock model — client-clocked pull-through

The ES-9 bridge bridges **two clocks** (hardware crystal ↔ AudioContext) and
pays for it with SPSC rings, a linear-interp resampler, and a PI controller
on buffer occupancy. The VST bridge has **no clock of its own**:

- The AU is configured and allocated at the client's `hello.rate`.
- Every inbound audio block renders exactly `frameCount` frames through the
  plugin, synchronously on a serial render queue, and the output block goes
  back carrying the **same `sampleTime`** — so the client can place returned
  audio on its own timeline and fold in the plugin's reported
  `latencySamples`.
- Instruments are pulled by **clock-only blocks** (mask 0, no planes, legal
  in the shared wire format).
- If the client reconnects at a different rate, the bridge remounts the
  plugin at the new rate, carrying `fullState` across.

Consequences: no resampling, no drift correction, no underrun policy on the
native side (the browser worklet owns its own jitter buffer, exactly like
the es9 card's), and zero work when no client is pulling.

Backpressure: at most 64 blocks may be queued behind a slow plugin; beyond
that inbound blocks are dropped at the door and counted (`droppedBlocks` in
meters) rather than accumulating unbounded latency.

## Protocol v1

`Sources/VSTBridgeCore/VSTProtocol.swift` **is the spec** (message-by-message
flow chart in its header). Summary:

- **Shared with the es9 bridge** (BridgeKit): the 0x01 planar-f32 audio
  block (20-byte header, ≤4096 frames, channel mask), `hello`,
  `status{busy|stopped}`, `ping/pong`, the Origin allowlist.
- **Session model (v0.2): one connection = one plugin instance.** Unlike
  the es9 bridge (exclusive hardware ⇒ single active client + takeover),
  plugins aren't exclusive: each card opens its own socket and mounts its
  own plugin (cap 16). `hello.clientId` (the card's stable node id) makes
  an instance survive reconnects: on disconnect it parks for a 90 s grace
  (plugin + state intact, notes silenced) and a reconnect with that
  clientId adopts it — the bridge replays `mounted`. A hello whose
  clientId is held by a live session evicts it (crashed-tab reclaim).
  Anonymous sessions tear down with their socket.
- **New 0x02 MIDI frame** (BridgeKit `MidiWire`): batches of 12-byte events
  `{u64 sampleTime, u8 len, 3B data}` on the client's sample clock.
  Channel-voice/realtime only; SysEx deliberately out of scope.
- **VST control plane**: `helperInfo`, `pluginList`, `mount`/`mounted`/
  `mountError`, `unmount(ed)`, `openEditor`/`closeEditor`/`editor`,
  `getState`/`state`, `setState`/`stateSet`, `rescanPlugins`, `meters`
  (~8 Hz: per-channel dBFS in/out, renderErrors, droppedBlocks, midiQueued,
  loadPct).

Plugin state is the AU `fullState` dictionary, binary-plist-serialized,
base64 on the wire — opaque to the client, sized for patch persistence
(the card should cap what it stores in the Y.Doc; large sample-based
instruments can produce big blobs).

### MIDI timing

Events are timestamped on the client's sample clock (the card will reuse
`midi-timing.ts`'s projection; the harness stamps at its send head). The
`MidiQueue` orders them (ties keep arrival order — note-off after note-on at
the same stamp), each render takes events with `sampleTime < blockEnd`, and
delivery uses the AU immediate-plus-offset convention, so intra-block
placement is sample-accurate. Late events clamp to offset 0. Plugin-emitted
MIDI (arps out) is explicitly phase-2.

## Decisions of record

1. **Audio Units, not the VST3 SDK, for v1.** The owner asked for a Swift
   project buildable today; AU hosting is system-framework-only and covers
   the practical plugin folder (every major vendor ships AU on macOS). The
   registry's `id` scheme (`au:type:subtype:manu`) leaves room for
   `vst3:…` behind the same `PluginDescriptor` seam. The card name stays
   **VST BRIDGE** (user-facing "VST" means "my plugins").
2. **Crash isolation, v1 posture:** v3 plugins load out-of-process (free,
   `.loadOutOfProcess`); v2 plugins load in-process, so a crashing v2
   plugin can take the bridge down. Accepted for a local dev build; the
   Bitwig-style child-process-per-v2-instance is future work and the reason
   `PluginHost` is already an isolated object behind a narrow API.
3. **One repo for all native apps** (owner, 2026-08-19): this repo is the
   end-state home; `../patchtogether.es9` stays untouched and shipping
   until its build here is worth regression-testing. Shared code was
   **copied** out of it (headers say so), not imported across repos.
4. **Port 9309**; the port is the only thing distinguishing the two bridges'
   servers today. If the helpers ever merge into one menu-bar app, each
   service keeps its port and the protocol survives unchanged.
5. **Same security posture as the es9 bridge:** loopback bind + Origin
   allowlist (403 otherwise), 32-session cap, 4 MB message cap, masked
   frames required, iterative frame decoder. `--allow-origin` covers PR
   previews. Chrome's Local Network Access rollout may add a one-click
   permission prompt on top; that's card-UX, not architecture.
6. **Licensing:** BridgeKit/VSTBridgeCore host *proprietary* plugins via
   Apple's public AU API — no SDK obligations (no VST3 SDK, no JUCE). The
   repo is MIT-licensed (see LICENSE; owner ruling 2026-09-03, same as
   patchtogether.es9), which is clean for hosting proprietary plugins and
   for distributing binaries.

## Latency budget (expected, unmeasured)

Reusing the es9 numbers: ~5 ms mean outbound batching (10 ms harness/worker
drain cadence) + sub-ms loopback + plugin render + the browser-side jitter
buffer (~10.7 ms at the es9 card's 512-frame steady-state target) ≈
**15–25 ms added** for an insert, ~10–15 ms for an instrument — "playing
through external hardware on a send", same as patching out through the
ES-9. The harness `rtt` readout plus `loadPct` are the measuring tools; the
card should display both. Tightening (per-quantum sends, lower worklet
target) is browser-side work.

## The browser card (planned, inet.modular)

Clone of the es9 seam: `bridge-client` / `bridge-owner` / `bridge.worker` /
SAB rings / worklet, with (a) a stereo in/out worklet variant instead of
16×16 jack classes, (b) the 0x02 MIDI encoder fed by the
`midi-timing.ts` projection, (c) card UI = connection state, plugin list
with filter, mount/unmount, **open editor** button, latency readout, and
the multiplayer caveat the es9 card already carries (audio renders only on
the machine that has the helper + plugin; the patch must say so).
Persist plugin state (capped) + mounted plugin id in the patch.

## Open items

1. **Measure the real added latency** with the rtt plumbing once the card
   exists (feasibility doc's estimates are INFERRED).
2. **`fullState` size policy** for patch persistence (cap? compress? store
   preset-reference-only for sample libraries?).
3. **Multibus/sidechain effects** — v1 is bus 0, stereo (mono fallback).
4. **Plugin-emitted MIDI** back to the browser (phase 2).
5. **Editor window UX** — one window at a time today; fine for one mounted
   plugin per bridge, revisit if the card grows multi-instance.
6. **Out-of-process scanning** — scan is currently in-process via the
   component registrar (fast, metadata-only, does not load plugin code, so
   the es9-style crash risk doesn't apply); actual instantiation is where
   v2 risk lives (see decision 2).
7. ~~Multi-instance~~ — resolved in v0.2: one socket per instance (see
   §Protocol). All instances share ONE serial render queue; revisit
   per-instance queues if many heavy plugins run at once.
