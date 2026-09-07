# VST BRIDGE cards — helper handoff + card build plan

**Date:** 2026-08-19
**Status:** helper BUILT and tested (sibling repo `../patchtogether.nativeapps`); browser side NOT STARTED — this document is the build plan for it.
**Owner request (verbatim):** *"i ought to be able to set up a vst in the card and drop the card into one of my channel lanes and have the audio autowire through, and the channel cv data from its clip player go to the VST as midi, and we need to be sure that our c3 c4 etc (all notes) are mapping correctly to midi notes and that our poly gates match to midi gates. idea is i can drop a card connected to an instrument vst in a lane, drop another card wired to a DSP vst in the lane, and all that stuff wires up and works the same way our internal instruments do."*
**Repos:** `../patchtogether.nativeapps` (helper, v0.2, no commits yet — built + 36/36 tests green on the owner's machine 2026-08-19) · this repo (card, to build).
**Inputs:** `~/.myrobots/vst-plan/vst-bridge-feasibility-2026-08-19.md` (feasibility research); `../patchtogether.nativeapps/docs/vst-bridge-design.md` + `Sources/VSTBridgeCore/VSTProtocol.swift` (protocol spec).

> Every `file:line` in this document was read and verified 2026-08-19 during
> a read-only research pass over this repo, or (for helper-side claims)
> verified by building and running the helper's test suite. Anything not
> verified is tagged **UNCONFIRMED**.

---

## 1. THE VERDICT UP FRONT

The native half is done and running: **`vst-bridge`** (Swift, in
`../patchtogether.nativeapps`) hosts the user's installed Audio Unit
plugins (the AU builds of their "VSTs" — 189 found on the owner's machine,
Apple + the full Arturia collection) and bridges audio + MIDI over
`ws://127.0.0.1:9309/ws`, using the same wire-format family and security
posture as the es9 bridge. It is **client-clocked**: the browser's audio
blocks pull the plugin render synchronously at the browser's sample rate —
no rings/resampler/drift machinery on the native side. **One WebSocket
connection = one plugin instance** (cap 16), so an instrument card and an
FX card in the same lane each mount their own plugin concurrently — this
exact scenario is covered by the helper's integration tests.

What this repo needs to build: **two thin cards over one shared transport
seam** (a clone of the es9 seam):

- **`vstInstrument`** — a chain SOURCE, shaped like `tidyVco`: takes the
  clip player's `polyPitchGate` cable, converts gate edges + pitch CV to
  MIDI **in its AudioWorklet** (sample-accurate), sends MIDI + clock
  blocks to the bridge, returns the plugin's audio into the lane.
- **`vstFx`** — a chain INSERT, shaped like `clouds`: stereo in → bridge →
  plugin → stereo back.

Lane membership, audio autowiring, and clip-CV delivery all come **free**
from declaring the right port shapes — no wiring code (§4). The one piece
of genuinely new DSP is the poly-CV→MIDI edge detector (§5), and the repo
already contains its two halves: the exact note conversion
(`pitchCvToMidiNote`, `midi-out-buddy.ts:86-91`) and the poly cable layout
(`poly.ts:9-37`).

## 2. WHAT THE HELPER PROVIDES (the contract you code against)

Run it: `cd ../patchtogether.nativeapps && swift run -c release vst-bridge`
→ harness at `http://127.0.0.1:9309/` (the harness is a complete reference
client — its `encodeBlock`/`decodeBlock`/`encodeMidi` JS functions can be
lifted verbatim: `Sources/vst-bridge/Resources/harness.html`).
`--list` prints every plugin id. `--allow-origin '*.pages.dev'` for
previews; loopback + `patchtogether.live` + subdomains always allowed
(same policy as es9; foreign origins get 403).

### 2a. Session model

- One socket per card instance. First message is
  `hello {rate, name?, clientId?}`; reply is `helperInfo` then
  `pluginList`.
- **`clientId` = your graph node id.** On disconnect the instance is
  PARKED for 90 s (plugin mounted, state intact, notes silenced); a
  reconnect with the same clientId adopts it and the bridge **replays
  `mounted`** — page refresh keeps the plugin without re-mounting. A hello
  whose clientId is held by a live socket evicts that socket
  (`status:"stopped"`) — crashed-tab reclaim. Anonymous sessions tear down
  on close.
- Above 16 instances: `status:"busy"` + close. There is **no takeover
  message** (that was the es9 single-client policy; it does not apply).

### 2b. Binary frames (little-endian; dispatch on byte 0)

**0x01 audio block** — byte-identical to `es9-protocol.ts:12-23` (reuse
that codec):
`u8 type=0x01 · u8 flags=0x01(planar f32) · u16 seq · u64 sampleTime ·
u32 channelMask · u16 frameCount≤4096 · u16 rsvd · one frameCount×f32
plane per set mask bit, ascending`.
- Card→bridge = plugin input. Stereo = mask `0b11`. **mask 0 is legal**: a
  "clock block" (frames advance, no planes) — how the instrument card
  pulls rendering without sending audio.
- Bridge→card = plugin output, always stereo mask `0b11`, **same
  `sampleTime` as the input block that pulled it** (this is your alignment
  guarantee; `mounted.latencySamples` is the plugin's own reported latency
  for future compensation).
- Nothing mounted ⇒ **bit-transparent bypass** (input echoes back) — lane
  audio keeps flowing through an empty FX card, and the path is testable
  before any mount.

**0x02 MIDI block** (new):
`u8 type=0x02 · u8 flags=0 · u16 seq · u16 count≤1024 · u16 rsvd ·
count × 12-byte events { u64 sampleTime · u8 len(1-3) · 3B data,
zero-padded }`.
`sampleTime` is on the SAME clock as your outgoing audio `sampleTime`
counter. The bridge queues events and delivers each at its exact
intra-block sample offset (late events clamp to offset 0 of the next
block). Channel-voice/realtime only, 1-3 bytes; no SysEx.

### 2c. Control messages (JSON text frames)

Card→bridge: `mount {pluginId}` · `unmount` · `openEditor` ·
`closeEditor` · `getState` · `setState {data}` · `rescanPlugins` ·
`ping {t}`.
Bridge→card:
- `helperInfo {protocolVersion:1, name:"vst-bridge", version, rate,
  maxBlockFrames:4096, formats:["au"]}`
- `pluginList {plugins:[{id, name, manufacturer, version,
  kind:"instrument"|"effect"|"musicEffect"|"generator", format:"au"}]}`
  (ids look like `au:aumu:Alav:Artu`; note ids can contain spaces, e.g.
  `au:aumu:dls :appl` — treat as opaque strings)
- `mounted {plugin, latencySamples, tailSeconds, audioInputChannels
  (0=instrument → send clock blocks), audioOutputChannels, acceptsMidi}`
- `mountError {pluginId, message}` · `unmounted` ·
  `editor {open, custom?}` (also sent when the user closes the native
  window themselves) · `state {pluginId, data:base64}` ·
  `stateSet {ok, detail?}` · `pong {t}` · `status {state, detail?}`
- `meters {inputRMS:[2], outputRMS:[2] (dBFS), renderErrors,
  droppedBlocks, midiQueued, loadPct}` at ~8 Hz.

Plugin editors open as **native macOS windows on the helper's machine** —
the card's "open editor" button just sends `openEditor`.

## 3. FILES TO CREATE (mirror of the es9 seam)

```
packages/web/src/lib/audio/vst/
  vst-protocol.ts       # 0x01 codec (copy es9-protocol.ts) + 0x02 encoder
                        #   + control-message types from §2c. DUPLICATE
                        #   constants per repo convention; header cites
                        #   ../patchtogether.nativeapps VSTProtocol.swift
                        #   as the spec.
  bridge-client.ts      # clone of es9/bridge-client.ts:55-147; THREE ring
                        #   specs (audio in, audio out, midi out — §5c);
                        #   VITE_VST_BRIDGE_URL || 'ws://127.0.0.1:9309/ws'
  bridge.worker.ts      # clone of es9/bridge.worker.ts; deltas in §6
  bridge-owner.ts       # clone of es9/bridge-owner.ts keyed by nodeId —
                        #   same lifetime-decoupling job (survives card
                        #   unmount/dock collapse; subscribe-before-connect;
                        #   pagehide teardown, bridge-owner.ts:285-296) but
                        #   PER-CARD connections: every acquire creates its
                        #   own client/worker/rings; no single-client logic.
  vst-ring.ts           # copy es9-ring.ts (RingSpec/RingIO SAB rings) +
                        #   the MIDI event ring (§5c)
packages/web/src/lib/audio/modules/
  vst-instrument.ts     # export const vstInstrumentDef (auto-registered
  vst-fx.ts             #   by the glob in modules/index.ts:29-49 — any
                        #   export named *Def with type/domain/factory)
packages/web/src/lib/ui/modules/
  VstInstrumentCard.svelte   # names are auto-mapped:
  VstFxCard.svelte           #   PascalCase(type)+'Card' (modules-card-map.ts:30-32)
packages/dsp/src/
  vst-bridge.ts         # the shared AudioWorklet processor (both cards),
  lib/vst-bridge-core.ts#   built to dist/ like es9-bridge.ts; core =
                        #   pure, unit-tested poly→MIDI conversion + slip
```

Load the worklet through the mandatory `createWorkletNode` seam
(`audio/worklet-guard.ts:30-37`) with
`import workletUrl from '@patchtogether.live/dsp/dist/vst-bridge.js?url'`
and the once-per-context `WeakSet` guard + zero-gain pin→destination,
exactly as `es9.ts:52-56, 314-339` does.

## 4. LANE INTEGRATION — the ports do all the work

Lane membership/order is `node.data.channel: 1..8` + the order arrays on
`pinned-mixmstrs` (`channel-columns.ts:10-22`); drops and reordering are
handled by Canvas + the janitor (`column-reconcile.ts`). **You write no
wiring code.** `planColumnWiring` (`patch-convenience.ts:786-975`) infers
everything from the def's declared port SHAPES:

**`vstFxDef`** (insert, the `clouds` pattern — `clouds.ts:290-315`):
```ts
inputs:  [{ id:'in_l', type:'audio' }, { id:'in_r', type:'audio' }],
outputs: [{ id:'out_l', type:'audio' }, { id:'out_r', type:'audio' }],
stereoPairs: [['in_l','in_r'], ['out_l','out_r']],
// no chainWiring → role inferred 'both' → FX insert in the chain
```

**`vstInstrumentDef`** (source, the `tidyVco` pattern —
`tidy-vco.ts:73-127`):
```ts
inputs: [
  { id:'poly', type:'polyPitchGate' },   // → auto-wired clip pitch{n}
  { id:'gate', type:'gate', edge:'gate' }, // → also gets gate{n} (BUG-B
                                           //   rule, patch-convenience.ts:188-193)
  { id:'vel',  type:'cv' },              // id contains 'vel', NO paramTarget
                                         //   → isVelCvInput (:133) → vel{n}
],
outputs: [{ id:'out_l', type:'audio' }, { id:'out_r', type:'audio' }],
stereoPairs: [['out_l','out_r']],
// NO audio inputs → resolveMainAudioIn null → binned as chain SOURCE;
// clip wiring comes from resolveClipWiring (patch-convenience.ts:180-213).
```
Do NOT give the instrument card `chainWiring:{role:'noteSink'}` — that
path (`:830-854`) is for external-gear taps (cvBuddy/midiOutBuddy); a
card that RETURNS audio into the lane should be a plain instrument shape.
Gotchas: gate/trigger-ish extra inputs must avoid the
`CONTROL_GATE_WORDS` id tokens (`:57`); don't declare any note OUTPUTS or
`isNoteSource` (`:123`) disqualifies the card.

The clip player exposes per lane `pitch{n}: polyPitchGate`,
`gate{n}: gate`, `vel{n}: cv` (`clipplayer.ts:166-173`,
`clipChannelPorts`, `patch-convenience.ts:305-310`). `maxInstances`:
leave UNSET (not the es9 `maxInstances:1` — multiple VST cards are the
whole point).

## 5. CV → MIDI (the correctness-critical part)

### 5a. Note mapping — the repo convention, verbatim

`note-entry.ts:12-14, 119-125`: **0.0 pitch CV = C4 = MIDI 60; 1.0 = one
octave = 12 semitones.** `midiToVOct(m) = (m-60)/12`;
`vOctToMidi(v) = Math.round(v*12 + 60)`. A4 = 440 Hz = MIDI 69 = +0.75.
Octave names: `noteNameForMidi` (`:109-116`), `oct = floor(m/12)-1`,
lowercase (`'c4'`). **Reuse the existing inverse** — do not rewrite it:
`pitchCvToMidiNote(vOct)` at `midi-out-buddy.ts:86-91` (rounds to nearest
semitone, clamps to MIDI 12..108 per `MIN_MIDI`/`MAX_MIDI`,
`note-entry.ts:23-24`). Mapping table your tests must pin:
c3 = −1.0 → 48 · c4 = 0.0 → 60 · a4 = +0.75 → 69 · c5 = +1.0 → 72 ·
c0 = −4.0 → 24 (clamped range floor is midi 12 = c-1+12 = c0? — the clamp
is 12..108, i.e. c0..c8).

### 5b. Gates and polyphony

- Poly cable (`poly.ts:9-37`): ONE 32-channel signal, voice pair *i* =
  `ch 2i` pitch (V/oct), `ch 2i+1` gate (0/1), 16 pairs. Velocity is NOT
  on the poly cable — it's the separate mono `vel{n}` cv, 0..1
  (= velocity/127).
- Gate threshold **0.5** (`midi-out-buddy.ts:80 GATE_THRESHOLD`); rising
  = `prev < 0.5 && cur >= 0.5`, falling = the inverse
  (`midi-out-buddy.ts:507`).
- Clip retrigger = gate dips to 0 for **3 ms** then back
  (`midi-cv-buddy.ts:473-492` precedent; clipplayer floors gates at 1 ms,
  `clipplayer.ts:1396-1397`) — at audio rate in the worklet these are
  trivially clean off/on pairs; NO 25 ms-poll workarounds needed (that
  hazard, `midi-out-buddy.ts:526-529`, exists only because midiOutBuddy
  polls analysers on the scheduler tick — the worklet approach makes it
  moot and is precisely the fidelity upgrade this card should ship).

### 5c. Where conversion runs: the worklet, per sample

The `vst-bridge` worklet (dsp package) processes, per voice pair:
1. **Gate rise** → `NoteOn(0x90, note, vel)` where
   `note = pitchCvToMidiNote(pitch[sample])` sampled AT the rise, and
   `vel = max(1, round(clamp01(velInput[sample]) * 127))` (the
   `velocityCvToMidi` rule, `midi-out-buddy.ts:98-102`; default **100** =
   `DEFAULT_VELOCITY`, `clip-types.ts:70`, when `vel` is unpatched).
2. **Gate fall** → `NoteOff(0x80, soundingNote, 0)` for that voice's
   currently-sounding note (track it per voice — the note at fall time
   may differ from the pitch CV at fall time).
3. **Pitch moved ≥ 1 semitone while gate high** (legato/tied steps —
   clipplayer holds gate across tied notes) → `NoteOff(old)` +
   `NoteOn(new, same vel)` in that order at the same sample offset.
   (MIDI has no per-voice slide without bend; see open question Q1.)
4. Mono fallback: if only `gate`+`pitch` are patched (poly unpatched),
   run the same state machine on one voice from those mono inputs.

Events are stamped with the worklet's **outgoing-stream frame counter**
(the same counter that indexes what it writes to the audio-out ring) —
that counter IS the `sampleTime` domain of the card→bridge audio blocks,
so the bridge places every event at the exact sample the gate crossed.

Ship events over a third SAB ring (audio-rate-safe, no postMessage on the
audio path): fixed 16-byte records
`{u32 sampleTimeLo, u32 sampleTimeHi, u8 len, 3B data, 4B pad}` in an
`Int32Array`+`Uint8Array` view pair, SPSC like `es9-ring.ts` (head/tail
Int32 header). **Write order matters:** worklet writes the MIDI ring
BEFORE the audio ring each quantum; worker drains MIDI BEFORE audio each
tick — then no event can arrive after the audio block that contains its
sampleTime. (The bridge tolerates late events at offset 0 of the next
block, so a violation degrades by ≤ one block, but get the order right.)

Keep ALL of §5's logic in pure functions in
`packages/dsp/src/lib/vst-bridge-core.ts` (voice state machine in,
events out) so it unit-tests without a worklet, like
`es9-bridge-core.ts`.

## 6. WORKER / TRANSPORT DELTAS vs the es9 clone

Base: `es9/bridge.worker.ts` (10 ms drain, 2 s ping, reconnect backoff
1-5 s). Changes:
1. `hello` gains `clientId` (the node id) — pass through from the owner.
2. Drain: read MIDI ring → send one 0x02 frame per tick (if events);
   then read audio-out ring → for the FX card send mask `0b11` planes;
   for the instrument card (no audio input patched into the bridge) send
   **mask-0 clock blocks** — same frame count, no plane payload.
3. Inbound 0x01 → write planes 0/1 to the audio-in ring (worklet plays
   them with the es9 slip logic: target 512 frames, `es9-bridge.ts` dsp
   worklet `:116-161` is the template).
4. Forward the §2c control messages to the owner (deviceInfo→helperInfo,
   plus pluginList/mounted/mountError/unmounted/editor/state/stateSet/
   meters/status/rtt). Card subscribes via the owner exactly like
   `Es9Card.svelte` does (`subscribeEs9` pattern, `bridge-owner.ts:201`).
5. Delete es9-isms: `config {inputMask,outputMask,outputModes}` (no
   equivalent — mount/unmount replaces it), takeover, busy-close
   handshake (`bridge-state.ts`) — `busy` here just means the 16-instance
   cap.

## 7. CARD LIFECYCLE, PERSISTENCE, MULTIPLAYER

- **Factory** (`AudioModuleFactory`, `engine.ts:126-129`): register the
  worklet, `acquireVstBridge(node.id, ctx.sampleRate)` → rings →
  `worklet.port.postMessage({type:'rings', …})`; handle maps `poly`/
  `gate`/`vel` → worklet inputs, `out_l`/`out_r` → outputs 0/1;
  `dispose()` = release + detach (the es9 shape, `es9.ts:389-429`; skip
  the vestigial `__es9Attach` analog).
- **Persist** `{pluginId, stateB64}` for the card. Params
  (`ParamDef`) are numeric-only, so this goes in the node's Y.Doc data
  (the `node.data.channel` precedent shows arbitrary JSON lives there) —
  **UNCONFIRMED which write path modules use for non-param data; follow
  how clipplayer persists clip content before inventing one.** Cap
  stateB64 (256 KB suggested) and warn in-card when a plugin exceeds it.
- **Auto-remount on load:** owner connects with `clientId = node.id`. If
  the bridge replays `mounted` (parked instance) → done. Else if node
  data has `pluginId` → send `mount`, then `setState(stateB64)` after
  `mounted`. Refresh state on `getState` at a low cadence or on
  `editor{open:false}` (UNCONFIRMED best trigger — decide in review;
  don't poll per-second).
- **Sample rate:** ctx is pinned 48 kHz (`Canvas.svelte:8150-8152`) but
  read `ctx.sampleRate` defensively like `Es9Card.svelte:73-78`; the
  bridge renders at whatever `hello.rate` says and remounts (state
  preserved) if it changes.
- **Multiplayer caveat** (same as es9): audio renders only on the machine
  running the helper + owning the plugin; collaborators see the card
  inert with a "helper not connected" state. Say so in `docs:`.
- **Card UI essentials:** connection pill, plugin picker (list + filter,
  from `pluginList`), mount/unmount, **open editor**, meters (in/out dBFS,
  loadPct, rtt), `latencySamples` readout, state-size indicator. SAB
  unavailable → the es9 'unsupported' path (`bridge-client.ts:64-74`;
  `/rack` is crossOriginIsolated via `_headers`/`vite.config.ts`/
  `hooks.server.ts:161-171`, so this only trips on odd embeddings).

## 8. REGISTRATION / RATCHET CHECKLIST (the cross-PR conflict surface)

Per CLAUDE.md:163-171 and the docs gate (CLAUDE.md:395-427), for EACH new
type (`vstInstrument`, `vstFx`):
- [ ] co-located `docs:` on the def (explanation + every port + control) —
      required for new modules; add both types to `STRICT_DOCS`
      (`docs/strict-docs.ts:29` area)
- [ ] `docs/module-manifest.ts` `DESCRIPTIONS` entry
- [ ] `ui/modules-card-map.test.ts` `EXPECTED_NODE_TYPES`
- [ ] `e2e/vrt/vrt-exemptions.ts` entry
- [ ] `control/push2/push-card-config.ts` `PUSH_CARD_CONTROLS`
- [ ] `e2e/tests/per-module-per-port*.spec.ts` expectations
- [ ] run `flox activate -- task docs:accept`, review contract-lock diff
- [ ] ports as LITERAL arrays in the def (the manifest extractor is a
      regex over source — `es9.ts:84-86`)

## 9. BUILD ORDER

- **M1 — protocol + core (pure, no UI):** `vst-protocol.ts` codec +
  tests (mirror `es9-transport.test.ts`); `vst-bridge-core.ts` poly→MIDI
  state machine + tests (§5, esp. the note table and retrigger).
- **M2 — vstFx end-to-end:** worker/owner/rings/worklet + def + card;
  prove with the helper running: lane audio → bypass (unmounted) →
  mount `au:aufx:dely:appl` (Apple AUDelay, always installed) → audible
  delay in the lane.
- **M3 — vstInstrument:** MIDI ring + conversion in the worklet; prove:
  clip lane notes → `au:aumu:dls :appl` (Apple DLS synth) plays them;
  verify c3/c4/a4 land as MIDI 48/60/69; poly chords; tied-note legato.
- **M4 — persistence + editor + polish:** clientId reattach, auto-remount
  + setState, editor button, meters/latency UI, docs + checklist §8.
- **M5 — e2e:** Playwright specs gated on helper availability (the es9
  hardware-spec precedent): clip→instrument-card→mixer RMS proof; fx-card
  insert proof; refresh-keeps-plugin proof.

## TESTABILITY

- Unit (no helper): protocol codecs (round-trip + malformed); the §5a
  note table `[-1→48, 0→60, 0.75→69, 1→72, clamps]`; gate threshold
  edges; 3 ms retrigger → off+on; legato pitch-step → off+on ordering;
  velocity floor 1 / default 100; 16-voice independence; MIDI-before-
  audio ring ordering; def shapes (ports/stereoPairs/no-chainWiring)
  like `es9.test.ts:1-45`.
- Integration (helper running, skip otherwise): mount list non-empty;
  AUDelay renders; DLS sounds a note sent as 0x02; reply `sampleTime`
  echoes; bypass is bit-exact; two sockets mount two plugins at once.
- Manual acceptance = the owner's sentence: instrument card + fx card in
  one lane, clip plays, both plugins work, editors open, refresh keeps
  both mounted.
- Helper-side reference tests to crib from:
  `../patchtogether.nativeapps/Tests/VSTBridgeCoreTests/ServiceIntegrationTests.swift`
  (`testTwoConcurrentInstances`, `testClientIdReattachKeepsPlugin`).

## Owner questions still open

1. **Pitch-move-while-gate-high** (tied/legato steps): plan says
   NoteOff+NoteOn per semitone step. Alternative is pitch-bend within ±2
   semitones (`DEFAULT_BEND_SEMITONES`, `midi-cv-buddy.ts:241`) for true
   slides — richer but stateful and range-limited. OK to ship off+on
   first?
2. **State blob cap** in the patch (suggested 256 KB; sample-based
   instruments can exceed it — then persist pluginId only and rely on the
   bridge's parked instance + the user's own saving)?
3. Should the FX card mix dry/wet or stay 100% wet (plugin-internal mix
   knobs usually cover this — plan says stay pure)?
4. Faces: both cards start **unfaced** (join
   `.myrobots/2026-08-18-unfaced-modules.md`) — acceptable for v1?
