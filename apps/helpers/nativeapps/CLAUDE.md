# patchtogether.nativeapps — agent notes

Umbrella SwiftPM package for patchtogether's native companion apps.
Currently: `vst-bridge` (AU plugin host bridged to the browser) on top of
`BridgeKit` (shared WebSocket server + wire protocol). The es9 bridge will
migrate here later — see the hard rule below.

## Commands

```sh
swift build                      # compile only (never starts anything)
swift test                       # 34 hardware-free tests, ~5 s
swift run -c release vst-bridge  # run; harness at http://127.0.0.1:9309/
.build/release/vst-bridge --list # enumerate installed AU plugins
```

Always name the executable (`vst-bridge`) — bare `swift run` breaks once a
second executable exists. Stop a running bridge with Ctrl-C; a stray one
holds the port (the error message names the PID to kill).

## Hard rules

- **Never edit `../patchtogether.es9`.** It is the shipping ES-9 bridge.
  Code was COPIED from it into `Sources/BridgeKit` (provenance headers say
  so); if you fix a bug in a copied file, fix it in BOTH repos and say so.
- **Wire-format changes are cross-repo contracts.** The browser twins in
  `../inet.modular` (es9-protocol.ts today, the VST card later) DUPLICATE
  constants rather than importing. Changing `BridgeWire`/`MidiWire`/
  `VSTProtocol` means updating the duplicates and the spec comments.
- `Sources/VSTBridgeCore/VSTProtocol.swift` is the protocol SPEC — keep its
  header's message-flow chart truthful.

## Architecture in one breath

Client-clocked pull-through: the browser's audio blocks are the clock; each
inbound 0x01 block renders that many frames through the mounted AU at the
client's hello rate on one serial render queue, and returns with the same
sampleTime. Instruments are pulled by mask-0 "clock blocks" + 0x02 MIDI
frames (sample-accurate via MidiQueue + immediate-plus-offset scheduling).
No plugin mounted = bit-transparent bypass. One WebSocket connection = one
plugin instance (cap 16); `hello.clientId` parks/reattaches an instance
across reconnects — NOT the es9 single-client/takeover model (plugins
aren't exclusive hardware). Design: docs/vst-bridge-design.md.

## Hard-won AU hosting facts (the first two are test-guarded)

- `inputBusses[0].isEnabled = true` before `allocateRenderResources`, or
  render returns -10876 (NoConnection). Default is disabled.
- `AVAudioPCMBuffer.mutableAudioBufferList` re-syncs `mDataByteSize` from
  `frameLength` on ACCESS — set `frameLength` first, then fix `mData` on
  the captured pointer and pass that exact pointer to the render block
  (manual byte sizes set before a later property access get wiped → -50).
- **NEVER free an in-process v2 plugin instance.** Arturia (Acid V, CZ V)
  registers main-run-loop sources that outlive
  AudioComponentInstanceDispose; the next source0 fire after dispose is a
  use-after-free segfault (three crash reports 2026-08-19, all
  `__CFRunLoopDoSource0 → plugin code`). Hence `VSTBridgeService.retire()`
  parks retired v2 hosts in a permanent graveyard (silenced,
  deallocateRenderResources'd, alive). Real fix = child-process-per-plugin
  (roadmap).
- **Open v2 plugins ON THE MAIN THREAD — the `instantiate` CALL itself.**
  `AUAudioUnit.instantiate` runs a v2 component's constructor
  synchronously on the CALLING thread; Arturia constructors register a
  main-run-loop source that then fires concurrently with the still-running
  constructor → segfault (crash dump: renderQueue inside the Acid V
  constructor, main faulting in its source0 handler at NULL+0x20). auval
  survives because it opens components on main — a source can't preempt
  the thread it's queued behind. Both instantiate and configure now hop to
  `PluginLifecycle.queue` (= main in the app). Beware chasing this as
  "wedged machine state": a mid-diagnosis theory blamed leaked shared
  mutexes and recommended reboots — the auval control disproved it. The
  race's win/lose odds shift with timing (a dead Arturia Software Center
  agent makes their init post its source immediately, turning a sometimes
  race into an always-crash — `launchctl kickstart
  gui/$UID/com.Arturia.ArturiaSoftwareCenterAgent` if it shows "-" in
  `launchctl list`). Child-process-per-plugin hosting remains the robust
  end-state (next helper work).
- **v2 editors:** `AUAudioUnitV2Bridge.requestViewController` never calls
  back for some plugins (Arturia) — a dead "open editor" button. PluginHost
  queries `kAudioUnitProperty_CocoaUI` directly (bundle + view factory via
  IMP call; `AUCocoaUIBase` isn't exposed to Swift), falling back to
  `AUGenericView`. Verified live against AUDelay's Cocoa UI.
- Processes spawned from the agent's sandboxed shell have flaky
  WindowServer access: Arturia plugins sometimes crash in their OWN init
  there, and plugin view creation may stall. Judge editor/UI behavior only
  from a normal terminal launch.

## Testing conventions

Tests use Apple's built-in AUs so they run on any Mac with no third-party
plugins, no audio hardware, no permissions: AUDelay = `au:aufx:dely:appl`,
DLSMusicDevice = `au:aumu:dls :appl` (subtype has a trailing space).
Integration tests bind port 0 and read `service.boundPort`.
