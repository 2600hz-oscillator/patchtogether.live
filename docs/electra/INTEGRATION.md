# Electra One — MULTI-VIEW integration (FOUNDATION / spike)

A deep, *automagic* integration between patchtogether and the
[Electra One](https://electra.one/) MIDI controller: one button generates a
named, auto-mapped **three-page** preset from the live rack and pushes it to the
device, then keeps both sides in sync (motorized-style value feedback + per-channel
VU metering) and adds a real tap-tempo.

> Status: **FOUNDATION / spike.** The pure logic (preset generator, tap-tempo,
> feedback delta/echo, value↔CC curve mapping, SysEx framing) is built + unit
> tested; the Web MIDI adapter + orchestrator are wired behind the existing
> on-demand MIDI permission flow; a sample preset + Lua templates are committed
> as the starting scheme. The **device is not present here** — everything is
> exercised against a fake Electra. Hardware bring-up + the optional Faust
> recompile for "most accurate" meters are follow-ups.

---

## 1. The three views

The Electra has **12 pots per control set, up to 3 control sets per page**
(≤ 36 controls/page), plus pads + a touch display. We map the rack onto three
pages.

| Page | Name | Backs onto | What it shows |
|------|------|-----------|---------------|
| 1 | CONTROL | a Control Surface module's bindings (or a generic node walk) | up to 36 params as faders/lists, grouped by source module |
| 2 | MIXMASTER (MIXMSTRS) | the `mixmstrs` node | per-channel fader / EQ / comp / sends + master + a read-only VU meter row |
| 3 | SYSTEM | the `timelorde` singleton | BPM display + tweak + **tap-tempo** + swing/source/mute |

**Common WRITE/READ semantics**

- **WRITE** = patch store `patch.nodes[id].params[paramId] = v`. Yjs-synced, so
  it drives the engine reconciler *and* remote rack-mates.
- **READ** = `engine.readParam(node, id)` (live, CV-inclusive) for params, or
  `engine.read(node, key)` (module-internal, e.g. `measuredBpm`, `levels`).

### View 1 — CONTROL SURFACE (page 1)

Lays out a Control Surface's bindings — pointers keyed `moduleId:paramId`, the
**same key MIDI uses** — or a generic `patch.nodes` walk. Grouped by source
module via `groupBindingsByModule` (`control-surface.ts:129`); group headers
become Electra visual groups; order is first-seen (the surface has no ordering
beyond first-seen — a known limit). Each control → `cc7`, CC# allocated
sequentially, injected app-side via `importBindings` keyed `moduleId:paramId`.
Per-control Lua formatter for units/curve.

> Discrete params stored in `node.data` (e.g. MIDI-CV-BUDDY channel/priority)
> are **not** `ParamDef`s and are excluded from the knob walk — they need a
> bespoke list+overlay (follow-up).

**Feasibility:** most directly supported by existing infra (this is the easy view).

### View 2 — MIXMASTER (page 2)

Controls (all real params today):

- Ch fader ×4 = `chN_volume` (0..1)
- EQ Lo/Mid/Hi ×4 = `chN_low/mid/high` (±12 dB)
- Comp ×4 = `compN` macro (single knob — preferred over thresh/ratio/compEnable)
- Send1/Send2 ×4 = `chN_send1/2` (0..1)
- Master = `master_volume`

= **29 writable controls** across 3 control sets + a dedicated meter row.

**PAN / MUTE / SOLO = GAP.** No such params (channels are stereo pairs, no pan
law). MUTE is *emulated* Electra-side: a pad `onChange` writes `chN_volume = 0`
with a saved restore; SOLO zeroes the other channels. True pan needs new DSP +
a Faust recompile (out of v1 scope).

**METERS — the hard part.** Per-channel VU was not readable on the foundation
spike. Two ways to get a level tap:

1. **Faust post-fader taps (most accurate — SHIPPED).** `mixmstrs.dsp` now emits
   4 extra mono outputs (worklet outputs 6..9): each channel's POST-fader level
   (post EQ → comp → volume fader, `(mainL+mainR)/2`). The output count went 6 →
   10; the factory splits 6..9 off to AnalyserNodes and reports their RMS as
   `handle.read('levels') → number[4]` (mirrors `scope.ts` + the engine RMS).
   These 4 taps are NOT patchable module ports. The VU reflects exactly what each
   channel contributes to the master bus. v1 is mono per channel; a stereo VU
   would add 4 more outputs for L/R (a future option, noted in the .dsp).
2. **JS approx (no rebuild — the original spike).** Tapped each channel's *input*
   and reported `inputRMS × live chN_volume`; ignored EQ/comp gain. Replaced by
   the accurate Faust path above.

**Master VU is free** via `audioOut.read('outputSnapshot')`.

**Feeding the device.** The feedback pump samples `read('levels')` (per channel)
+ `outputSnapshot` (master) on every ~33 Hz tick via the host's `readMeterAmp`,
maps each to a dBFS meter CC (`ampToMeterCc`, floor −60 dB), and streams it on
CTRL to the read-only meter controls. Deltaed (a steady channel doesn't re-spam)
and echo-safe (meters are app→device only — inbound meter CCs are ignored).

**Rendering the meter on the device** — two options:

- **Option 1 (recommended — SHIPPED):** a read-only `vfader` (variant thin/outline)
  bound to a unique `cc7`; the app streams the level CC at ~30 Hz and the fill
  animates as a VU. One small CC per update; a `fmtMeterDb` Lua formatter labels
  the level in dBFS. *(This is what the generator + sample.epr emit.)*
- **Option 2 (advanced):** a custom Lua VU tile (`type:custom`, FW 3.6+) drawing
  bar + dB + peak-hold via `setPaintCallback`, fed by `parameterMap.set` / a
  bespoke meter SysEx then `control:repaint()`. One narrow tile per channel due
  to FW 4.1.4's single-pot limit (irrelevant for read-only). Template:
  [`lua/custom-vu.lua`](./lua/custom-vu.lua).

### View 3 — SYSTEM (page 3, TIMELORDE)

**BPM DISPLAY** = `(hasExternalClock && measuredBpm > 0 ? measuredBpm : bpm)`,
**SOURCE** = `hasExternalClock ? 'EXT' : 'INT'` (mirror `TimelordeCard.svelte:107`).

Reads: `bpm` via `engine.readParam(node,'bpm')`; `measuredBpm` +
`hasExternalClock` via `engine.read(node,'measuredBpm'/'hasExternalClock')`
(`timelorde.ts:340/343`); `hasExternalClock` also via scanning `patch.edges` for
a target `portId === 'clock'`.

**TWEAK** writes the INTERNAL `bpm` (curve `log`, 10..300). The app setter applies
the log map (`electra/curve.ts`) since `ccValueToParamValue` in midi-learn is
linear-only. **Enabled only when the source is internal**; greyed when an external
clock edge is patched.

**TAP-TEMPO (built here).** The Electra pad sends a momentary note on press; the
**app** computes BPM in a pure ring-buffer helper (`electra/tap-tempo.ts`):
last 3-5 tap timestamps (`performance.now()`), `bpm = 60000 / medianIntervalMs`,
reset on a > ~2 s gap, clamp 10..300; write
`patch.nodes[tlId].params.bpm = bpm`. This **reuses the internal-bpm path** —
no new param / worklet change — and syncs to rack-mates. Tap math is in JS, not
Lua (no sub-second timer). The tap pad is disabled when `hasExternalClock`
(hardware is master).

Optional: `swingAmount` (0..90), `swingSource` (discrete 0..10 → list+overlay),
`muteOutputs` toggle, read-only `running`.

---

## 2. App support (modules)

All new code lives under `packages/web/src/lib/electra/`.

| File | Role |
|------|------|
| `types.ts` | preset (.epr) schema + allocation-table types |
| `tap-tempo.ts` | pure ring-buffer → BPM helper (`TapTempo`, `bpmFromTaps`) |
| `curve.ts` | curve-aware value ↔ 7-bit-CC mapping (mirrors `Knob.svelte`) + meter dB helpers |
| `preset.ts` | **`generatePreset()`** — the pure 3-page generator + `emitPresetJson()` |
| `feedback.ts` | `FeedbackState` (delta + echo-suppression) + `FeedbackPump` (value + 30 Hz meter streams) |
| `broker.ts` | Web MIDI adapter — single `sysex:true` access, identity probe, CTRL/PLAY split, SysEx/CC/Note fan-out + framing helpers |
| `autoconfig.ts` | `ElectraAutoconfig` — the orchestrator (identity → generate → push → wire → pump → page 1) |
| `host.ts` | live wiring of `AutoconfigHost` from the patch store / engine / registries |
| `lua-bundle.ts` | the Lua layer uploaded to the device (string constant) |

UI: `packages/web/src/lib/ui/ElectraConnectButton.svelte` — the gated
**"Auto-configure Electra One"** affordance in the rackspace bar. On-demand only
(asks for MIDI on first click); **no eager prompt**. Engine access for code
outside the Svelte context tree goes through `audio/engine-ref.ts`
(`setActiveEngine` in `Canvas.svelte` / `getActiveEngine` in the button).

**One unavoidable non-Electra change:** the MIXMSTRS per-channel meter tap —
`read('levels')` in `mixmstrs.ts`, fed by 4 new POST-fader outputs added to
`mixmstrs.dsp` (accurate post-EQ/comp/fader levels; a Faust recompile). Master VU
reuses the existing `audioOut.read('outputSnapshot')`.

### Reused as-is

midi-learn CC dispatch + `importBindings`/`exportBindings`, `resolveSurfaceParam`,
`engine.readParam/read`, the patch store singleton, the registries, the Web MIDI
shims, `installSimulatedMidiDevice` / `__test_setAccess` for tests.

### Opportunistic (non-blocking)

`cc14`/NRPN ingest + a curve-aware `ccValueToParamValue` in midi-learn (it can
later delegate to `electra/curve.ts`).

---

## 3. Testing (shift-left)

- **Unit:**
  - tap-tempo helper — `tap-tempo.test.ts` (flake-checked 3×)
  - preset generator — `preset.test.ts` (known patch → expected `.epr` + allocation
    table + a committed snapshot)
  - feedback delta/echo — `feedback.test.ts`
  - ParamDef→control mapping per curve — `curve.test.ts`
  - broker SysEx/CC framing + fake-device fan-out — `broker.test.ts`
  - orchestrator inbound dispatch + tap routing + EXT gating — `autoconfig.test.ts`
- **E2E (no hardware, follow-up):** drive the broker via `__test_setAccess` +
  a fake Electra: assert a generated CC writes the right param, a param change
  emits the right CC on CTRL, tap CCs converge BPM, an external-clock edge greys
  the tap path, and capture SysEx bytes from a fake output to assert the
  `.epr`/Lua upload framing.

Run: `flox activate -- task test:one -- src/lib/electra/`
(flake-check: `REPEAT=3 …`).

---

## 4. Runtime SysEx the app uses

| Purpose | Bytes |
|---------|-------|
| Upload preset | `F0 00 21 45 01 01 <json> F7` |
| Upload Lua | `F0 00 21 45 01 0C <lua> F7` |
| Execute Lua (e.g. `info.setText`) | `F0 00 21 45 08 0D <expr> F7` |
| Page switch | `F0 00 21 45 09 0A <page> F7` |
| Identity probe | `F0 00 21 45 02 7F F7` |
| Per-control value / meter | **plain CC** on CTRL (parameter-map auto-sync — avoid the slow `14 07`/`14 0E` JSON value writes) |
| ACK / NACK | `7E 01` / `7E 00` |

All JSON is **minified + 7-bit ASCII** at upload (`emitPresetJson` clamps any
code point > 0x7E).

---

## 5. The Electra scheme (the bulk)

### 5.1 Preset `.epr` skeleton

`version: 2`, `name: "patchtogether"`.

```jsonc
{
  "version": 2,
  "name": "patchtogether",
  "pages": [
    { "id": 1, "name": "CONTROL",  "defaultControlSetId": 1 },
    { "id": 2, "name": "MIXMSTRS", "defaultControlSetId": 1 },
    { "id": 3, "name": "SYSTEM",   "defaultControlSetId": 1 }
  ],
  "devices": [
    { "id": 1, "name": "PT-CTRL", "port": 2, "channel": 1, "rate": 33 },  // ~30Hz throttle for meters
    { "id": 2, "name": "PT-PLAY", "port": 1, "channel": 1 }
  ],
  "overlays": [ /* swingSource 0..10, INT/EXT, discrete params */ ],
  "groups":   [ /* visual headers per source module on CONTROL */ ],
  "controls": [ /* generated per resolved param (see 5.2) */ ]
}
```

A full generated example is committed at [`sample.epr`](./sample.epr) (3 pages,
46 controls) with its allocation table at
[`sample-allocations.json`](./sample-allocations.json). This is the starting
scheme the owner iterates on the device.

### 5.2 Control examples

**page 1 — fader**

```jsonc
{
  "type": "fader",
  "inputs": [{ "potId": 1, "valueId": "value" }],
  "values": [{
    "message": { "deviceId": 1, "type": "cc7", "parameterNumber": <CC#>, "min": 0, "max": 127 },
    "min": <defMin>, "max": <defMax>, "formatter": "<fmtFn>"
  }]
}
```

**page 2 — writable cc7 controls + a read-only meter row**

```jsonc
// meter vfader (variant thin) — app→device only; inbound NOT routed to a param
{
  "type": "vfader", "variant": "thin", "readOnly": true,
  "values": [{ "message": { "deviceId": 1, "type": "cc7", "parameterNumber": <meterCC> } }]
}
```

**page 3 — TAP pad / BPM encoder / SRC list**

```jsonc
{
  "type": "pad", "mode": "momentary",
  "values": [{ "message": { "deviceId": 2, "type": "note", "parameterNumber": <tapNote>, "onValue": 127, "offValue": 0 } }]
}
// BPM encoder: cc7 + "fmtBpm" formatter; SRC: read-only list + INT/EXT overlay
```

### 5.3 Lua layers (uploaded via `01 0C` / the editor pane)

See [`lua/patchtogether.lua`](./lua/patchtogether.lua) (formatters, source banner,
tap-pad/BPM gating, MIXMASTER mute/solo) and [`lua/custom-vu.lua`](./lua/custom-vu.lua)
(Option 2 custom VU). The bundled-at-upload copy is `electra/lua-bundle.ts`.

- **Formatters:** `fmtDb` (`%+.1f dB`), `fmtRatio`, `fmtBpm` (applies the log
  map 10..300), `fmtBpmDisplay` (measured vs internal).
- **Source banner:** host pushes `"INT 120"` / `"EXT 128"` via `info.setText`
  (Execute-Lua `08 0D`).
- **Tap-pad gating:** host pushes an external flag; `pt_setExternal(bool)` calls
  `control:setActive(...)` to grey the TAP pad + BPM encoder in EXT mode.
- **MUTE/SOLO** (MIXMASTER): a pad `onChange` saves + writes channel-volume CC to
  0 / restores (round-trips to the app → `chN_volume`).
- **Custom VU** (Option 2 only): `control:setPaintCallback` drawing bar + dB
  ticks + peak-hold, fed by `parameterMap.set` or a bespoke meter SysEx then
  `control:repaint()`.

> **Lua limits:** Lua **cannot** create controls/pages at runtime (all live in
> the `.epr`) and has **no sub-second timer** — all timing/animation is
> host-driven (hence tap-tempo math lives in the app, not Lua).

---

## 6. Build status + follow-ups

**Built + tested here:** preset generator, tap-tempo, feedback (value + meter)
with echo-suppression, curve mapping, SysEx framing + Web MIDI broker, the
orchestrator, the gated UI button, the sample `.epr` + Lua templates, and the
**accurate per-channel VU**: 4 POST-fader outputs in `mixmstrs.dsp` →
`read('levels')` → the 30 Hz meter stream → the MIXMASTER meter row
(`fmtMeterDb` dBFS readout).

**Follow-ups (not in this spike):**

- Hardware bring-up (real port-name resolution, ACK/NACK handling, retry).
- Stereo (L/R-split) per-channel VU (+4 more Faust outputs) + true pan
  (DSP + recompile).
- Discrete `node.data` params (MIDI-CV-BUDDY etc.) → bespoke list+overlay.
- `cc14`/NRPN ingest + curve-aware `ccValueToParamValue` in midi-learn.
- E2E spec against the fake Electra (framing capture + round-trip).
