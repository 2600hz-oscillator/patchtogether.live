# es9 module — full 16×16 audio+CV I/O via the native bridge (PLAN)

**Status: PLAN ONLY.** Do not implement while other inet.modular work is in
flight. Written 2026-07-10 to be dropped into `.myrobots/plans/` when the
tree frees up. The NATIVE side is already built and testable in
`../patchtogether.es9` (`es9-bridge` + protocol v1 + a browser harness that
exercises everything this module will do).

> **Decision-of-record:** `es9-stereo-io.md` recorded
> `feedback_no_native_helper_apps` — "per-pair addressing is a separate
> native PRODUCT, not a helper bolted onto the browser app." The owner
> explicitly reversed this for the ES-9 on 2026-07-09: the ES-9 gets a native
> bridge app (`patchtogether.es9` repo) **and** a first-class module in this
> app with all the I/O jacks. This plan is that module.

## Goal

One `es9` module whose jacks mirror the physical ES-9: patch a hardware
Maths LFO into any patchtogether cv/pitch/gate input, and patch any
patchtogether signal out of the ES-9's DC-coupled jacks into the rack —
16 channels in, 16 out, audio and CV interchangeably.

## What already exists (contract — do not re-litigate)

The native app `es9-bridge` (repo `../patchtogether.es9`) owns CoreAudio:
one full-duplex AUHAL on the ES-9 @48 kHz (matches our hard-pinned
AudioContext rate), lock-free rings, drift-absorbing resampler, and a
localhost server:

- `http://127.0.0.1:9209/` — its own test harness (useful reference: it is a
  working protocol client with worklet ring + slip).
- `ws://127.0.0.1:9209/ws` — **protocol v1** (spec =
  `patchtogether.es9/Sources/ES9Core/BridgeProtocol.swift`; summary in its
  `docs/DESIGN.md`): JSON text control (`hello`→`deviceInfo`, `config` with
  input/output channel masks + per-output `audio|cv` underrun mode, `meters`
  ~8 Hz, `status`, `ping/pong`) + binary planar-Float32 blocks with a 20-byte
  header, `channelMask`, ≤4096 frames. Bridge→client blocks carry ES-9
  INPUTS; client→bridge blocks carry ES-9 OUTPUTS. Bit-transparent: float
  ±1.0 ↔ jack ±10 V (nominal).
- Security: upgrades are Origin-gated (loopback, `patchtogether.live` +
  subdomains allowed). Single active client; later connections get
  `status:busy`.
- Duplicate protocol constants as literals here (the
  provider.ts/CAPACITY_REJECTION pattern) — never import across repos.

## Signal semantics — volts ↔ app conventions

App conventions (verified): `cv` = bipolar −1..+1 full-depth; `pitch` =
1.0/octave with 0 V ≙ C4; `gate` = 0/1 with `GATE_HI = 0.5`. Hardware full
scale: ±10 V ↔ float ±1.0. **All class scaling lives in this module** (the
bridge is deliberately raw). Per-jack signal-class selector (persisted in
`node.data`):

| class | hardware → browser | browser → hardware | port type |
| --- | --- | --- | --- |
| audio | raw | raw | `audio` |
| cv    | ×2 (±5 V → ±1) | ÷2 (±1 → ±5 V) | `cv` |
| pitch | ×10 (1 V/oct → 1.0/oct, 0 V = C4) | ÷10 | `cv` (family-interchangeable) |
| gate  | comparator, hysteresis 1 V/2 V → 0/1 | 0/1 → 0/+5 V (×0.5) | `cv` |

(cv/pitch/gate cables interconnect freely — `canConnect` — so the scaled twin
port can stay type `cv` for all three classes; the class only changes the
math. Attenuverter-style fine trim can come later; ±10 V nominal full scale
until the bridge ships measured calibration in `deviceInfo`.)

### The port-typing problem and its resolution

`canConnect` rejects `audio`→CV-family AND CV-family→`audio` (verified,
`graph/types.ts`). A single fixed-type output jack cannot serve both a VCO
recording (audio) and a Maths LFO (cv). Resolution:

- **Hardware→browser: two ports per DC input jack.** `in<N>_audio_out`
  (type `audio`, raw) **and** `in<N>_cv_out` (type `cv`, class-scaled). Both
  live simultaneously; patch whichever fits the target. S/PDIF returns
  (channels 15/16) are AC digital — audio-only, no cv twin.
- **Browser→hardware: one port per jack**, type `audio` with
  `accepts: ['cv','pitch','gate']` — input-side `accepts` widening is
  established precedent (`scope.ts`, `scaler.ts`, `gatemaiden.ts`). The
  jack's class selector applies the inverse scaling and sets the bridge-side
  underrun mode (`cv` = hold, `audio` = fade).

### Jack complement (mirrors the panel; expanders reserved for later)

- **IN 1–14** (DC-coupled jacks): 14 × (`audio` + `cv`) output ports = 28.
- **S/PDIF IN L/R** (USB in 15/16): 2 × `audio` output ports.
- **OUT 1–8** (DC-coupled jacks): 8 input ports (`audio` + accepts CV family).
- **MIX 9–16** (USB outs 9–16, internal mixer/phones buses): 8 input ports,
  audio-only, in a collapsed section.
- Card uses `PatchPanel groupingStrategy="sectioned"` (MixmstrsCard
  precedent): sections IN 1–8 / IN 9–14 + S/PDIF / OUT 1–8 / MIX.
- Labels render from `deviceInfo.inputLabels/outputLabels` (don't hardcode —
  expanders and non-default ES-9 configs change them).

## Browser-side architecture

**Never route audio through the main thread** (canvas-drag jank stalls it
80–200 ms — documented). The page is already crossOriginIsolated (COOP/COEP
for Faust), so SharedArrayBuffer is available:

```
WebSocket ──► bridge Worker ──SAB ring (in)──► AudioWorkletProcessor 'es9-bridge'
   ▲              │                                │ 32 outputs (16 raw + 16 scaled)
   └──────────────┴◄─SAB ring (out)────────────────┘ 16 inputs (class-inverse-scaled)
 (worker owns transport, reconnect,                    ↕ 128-frame quanta
  control JSON, meters → main thread for UI)
```

- `packages/dsp/src/es9-bridge.ts` — worklet: two SAB Float32 rings
  (Atomics indices; ~1024-frame capacity, ~384-frame target), per-channel
  class transform, underrun policy mirroring the bridge (cv-class holds last
  value, audio fades), sample-slip re-centering. No top-level class export;
  vitest global shims; pure ring/scale math in `dsp/src/lib/es9-bridge-core.ts`
  for unit tests. Build via `node packages/dsp/scripts/build.mjs es9-bridge`.
- Bridge **Worker** (`packages/web/src/lib/audio/es9/bridge-client.ts` + a
  small `.worker.ts`): owns the WebSocket (binary frames → SAB in-ring;
  out-ring → binary frames at ~10 ms cadence), `hello/config` state machine,
  auto-reconnect with backoff, posts meters/status to main thread. Masks in
  `config` derive from which jacks are actually patched (recompute on edge
  changes; idle channels cost nothing).
- URL: `VITE_ES9_BRIDGE_URL` env override, literal fallback
  `ws://127.0.0.1:9209/ws` (provider.ts pattern; 9209 avoids 1234/1235/5173/4173).
- Fallback when SAB is somehow unavailable: MessagePort batching
  (doom-pcm-worklet / recorderbox-capture precedent, +1 batch latency). Card
  shows the Chromium notice for Safari (which blocks ws://localhost from
  https; AudioOutCard setSinkId-notice precedent).

## Module definition sketch

```ts
// packages/web/src/lib/audio/modules/es9.ts  — literal-init (docs regex!)
export const es9Def: AudioModuleDef = {
  type: 'es9',
  domain: 'audio',
  label: 'ES-9',
  category: 'utilities',
  palette: { top: 'Audio modules', sub: 'I/O' },
  maxInstances: 1,
  size: '4u',            // final sizing per module-sizing-rack-format.md
  inputs: [
    // out1..out8 (to DC jacks), type 'audio', accepts ['cv','pitch','gate']
    // mix9..mix16 (USB mixer buses), type 'audio'
  ],
  outputs: [
    // in1_audio..in14_audio (raw), in1_cv..in14_cv (class-scaled),
    // spdif_l, spdif_r (audio only)
  ],
  params: [],            // class selectors live in node.data, not params
  docs: { /* full explanation + every port + voltage table */ },
  factory: es9Factory,   // DOM-free: worklet node + per-port gain fan-out,
                         // silent ConstantSource keep-alives; Worker/WS
                         // lifecycle attaches from the card via the
                         // audioin.ts __attach-hook pattern
};
```

Factory shape: one `AudioWorkletNode('es9-bridge', { numberOfInputs: 16,
numberOfOutputs: 32, outputChannelCount: Array(32).fill(1) })`; port maps
index worklet i/o per jack (attenumix precedent). Card owns connect/status
UI and hands the Worker's MessagePorts/SABs to the engine node via an
`__es9Attach` handle hook (audioin precedent), keeping the factory
jsdom-testable.

Persistence (`node.data`): per-jack classes (`inClass: {1:'cv',...}`,
`outClass: {...}`), optional URL override. Transient (Svelte `$state`, NOT
Yjs): connection status, meters, deviceInfo. Multiplayer: the module exists
in the shared patch; only a user whose machine runs `es9-bridge` hears/drives
hardware — everyone else sees status "no bridge" and the jacks are silent
(keep-alive holds the graph alive; document this in docs.explanation).

## Implementation checklist (the conventions gauntlet)

1. `packages/web/src/lib/audio/modules/es9.ts` — literal `es9Def` (glob
   auto-registers; docs-site regex needs the literal form).
2. `packages/dsp/src/es9-bridge.ts` (+ `lib/es9-bridge-core.ts`) — build,
   commit `dist` per repo convention; note the `.sha` pinning.
3. `packages/web/src/lib/ui/modules/Es9Card.svelte` (PascalCase: `es9` →
   `Es9Card`) — sectioned PatchPanel, class selectors, status LED, meters,
   Chromium notice, `useEngine()` + `__es9Attach`.
4. Worker + client: `packages/web/src/lib/audio/es9/bridge-client.ts`,
   `bridge.worker.ts` (duplicated protocol constants, no cross-repo import).
5. Hand-list appends: `EXPECTED_NODE_TYPES` (modules-card-map.test.ts),
   `DESCRIPTIONS` (docs/module-manifest.ts), `STRICT_DOCS`
   (docs/strict-docs.ts).
6. `flox activate -- task docs:accept` → re-pin contract-lock.txt (review diff).
7. VRT baselines (linux + darwin) or `e2e/vrt/vrt-exemptions.ts` entry.
8. Per-port e2e: hardware-dependent emit/drive exemptions with documented
   reasons in `e2e/tests/per-module-per-port.spec.ts` (handle presence stays
   auto-covered). BETTER: add a mock bridge to `e2e/_helpers` — a ~60-line
   Node `ws` server speaking protocol v1 with synthetic signals (the protocol
   was sized for this) — then the ports can be tested for real in CI.
9. Unit tests: def-shape/co-located `es9.test.ts`; ring/scale math in
   `packages/dsp` vitest (worklet-global shims, seq-clock precedent);
   `REPEAT=3` flake-check everything new.
10. `flox activate -- task typecheck` + full `task ci` before PR.

## Verification on hardware (cannot be CI'd)

1. `es9-bridge` running, ES-9 attached. Spawn `es9`, status LED `connected`,
   labels populate from deviceInfo.
2. Maths LFO → ES-9 input 3, jack class `cv`: patch `in3_cv` → any filter
   cutoff cv-in — cutoff breathes with the hardware LFO. Scope shows ±5 V ≈
   full deflection.
3. patchtogether LFO → `out1` (class `cv`) → ES-9 output 1 → hardware VCA:
   rack responds; kill the bridge mid-LFO — output fades (no stuck voltage).
4. VCO → `out2` class `audio`; record ES-9 in 1 loopback: clean audio both ways.
5. Pitch: patchtogether pitch cable → `out3` class `pitch` → oscillator V/oct:
   octaves track (1.000 V/oct within DAC tolerance).
6. Gate: hardware +5 V gate → `in4_cv` class `gate` → envelope trigger: no
   double-fires (hysteresis), tight timing.
7. Latency: harness measure button (cable out 1 → in 1) — expect ~25–40 ms
   browser round trip; CV feels instant.

## Open questions (decide at implementation time)

- Auto-spawn/auto-connect UX: probe `ws://127.0.0.1:9209` on module spawn
  only (never on page load — don't fingerprint-probe users who don't own one).
- Per-jack trim/attenuverter param row vs. class-only v1.
- Mask strategy: patched-jacks-only (recompute on edge change) vs. all-on.
- Meter display density for 32 jacks (per-section peak LEDs vs full bars).
- Expander support lands as: bridge `deviceInfo` grows channels → module
  renders extra sections dynamically? Requires ports-from-deviceInfo, which
  fights the static-def contract — likely a second module type (`es9x`) or a
  def-regeneration decision. Deferred deliberately.
