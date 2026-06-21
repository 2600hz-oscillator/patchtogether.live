# vfpga — design + forward build plan (research/design pass)

Status: **DESIGN / RESEARCH** (no engine or registry edits in this pass). Branch
`research/vfpga-design`.

> **Reading-order note for whoever picks this up:** the brief that spawned this
> doc assumed `vfpgaRunner` was a *stubbed P0*. **It is not.** The full
> FPGA-fabric architecture from the prior design
> (`vfpga-fpga-authentic-architecture.md`) has **already shipped** — P0 through
> P6, eight specs, a 25-cell library, place-and-route, register ping-pong,
> LUT16/DSP/BRAM, the floorplan card viz, and the docs routes. **362 vfpga unit
> tests pass on this worktree.** This doc therefore does two things: (1) it is
> the *consolidated, accurate* design reference for the `.vfpga` format **as it
> actually exists today** (the prior doc described the target; this describes the
> shipped reality), and (2) it charts the **decisive next slices** — the one
> ratified-but-unbuilt owner directive plus the highest-value catalog/quality
> additions. Treat §1–§4 as "what is" and §5–§7 as "what's next."

---

## 0. Current state of the shipped system (ground truth, verified on this tree)

What exists today under `packages/web/src/lib/video/vfpga/` and its card/docs:

| Area | File(s) | Status |
|---|---|---|
| Format types (`VfpgaSpec`, `VfpgaFabric`, `VfpgaTile`, `VfpgaNet`, IOB superset) | `types.ts` | **Real, complete** |
| Place & route (validate → topo-sort → comb-loop reject → FBO assign → pass emit) | `place-and-route.ts` | **Real, pure, GL-free, 40 tests** |
| Register ping-pong swap (the fabric clock edge) | `register-swap.ts` | **Real, 6 tests** |
| Cell library (glob-collected) | `cells/*.ts` (25 cells) | **Real, 130 tests** |
| Spec registry (glob-collected, deduped) | `registry.ts` | **Real, 85 tests** |
| Host module (def + factory: hot-swap, CV roles, gate edge-detect, register swap, snapshot) | `modules/vfpga-runner.ts` | **Real, 22 tests** |
| CPU preview snapshot | `snapshot.ts` | Real (smpte-bars only) |
| Fabric floorplan card viz (Canvas2D, pure model) | `ui/modules/vfpga-floorplan*.ts`, `VfpgaFloorplan.svelte` | **Real, 14 tests** |
| Card (PatchPanel, no side jacks; preset menu; CV scopes) | `ui/modules/VfpgaRunnerCard.svelte` | Real (#782) |
| Docs index + per-spec subpages | `routes/docs/modules/vfpga-runner/`, `routes/docs/modules/vfpga/[slug]/` | Real |

**Shipped cell library (type:op):**
- **clb**: `passthru`, `mix`, `threshold`, `add`, `diff`, `multiply`, `gain`,
  `invert`, `luma`, `select`, `hsvShift`, `chromaRot`, `syncBend`, `databend`,
  `mosh`, `tmdsbend`, `warp`, `smpte`
- **dsp**: `conv3x3`, `mac`, `quadDemod`
- **bram**: `linebuf`
- **lut16**: `lut` (literal 4-input bitwise truth table, 16-texel INIT)
- **reg**: implicit 1-frame capture (handled in P&R, not a cell file)
- **iob_in / iob_out**: fixed edge tiles (handled in P&R, not cells)
- Shared bend RNG: `bend-seed.ts` (`BEND_SEED_GLSL`, `uSeed`) — deterministic,
  re-rollable, VRT-safe.

**Shipped catalog (8 specs):** `smpte-bars` (generator; legacy `effect` +
dogfood `fabric`), `sync-bender`, `chroma-rot`, `framestore-howl`,
`databend-cvbs` (LUT16), `macroblock-mosh`, `tmds-sparkle` (LUT16),
`scaler-glitch` (BRAM).

**What is NOT yet built** (the actionable surface — see §5):
1. **Audio-rate bend modulation** — owner directive #4 (2026-06-10) was *ratified
   "YES"* but there is **no audio→CV bridge** in the vfpga path. CV today is
   frame-rate (one sample per render frame, post attenuverter/offset). This is
   the single ratified-but-unbuilt item.
2. **CPU preview snapshots for the bent specs** — only `smpte-bars` has one;
   the 7 bent specs fall back to a neutral placeholder on the card.
3. **Catalog breadth beyond the original 7 bent + smpte** — keying / displacement
   / posterize / pure-pattern-generator families are *expressible today* with the
   shipped cells but **no preset ships them** (see §6).
4. **Cell breadth gaps** the catalog in §6 wants: a `framestore`/`delayN` BRAM op
   (only `linebuf` exists), a `posterize`/`quantize` clb op, a `key` (luma/chroma
   comparator→alpha) clb op, a `displace` (sample-by-a-second-texture) clb op,
   a `noise`/`pattern` 0-input generator clb op, `screen`/`mul`-blend already
   partly covered by `multiply`/`add`/`diff`.

---

## 1. Research summary — FPGA video-effects hardware + the concepts we borrow

This grounds the *why* behind the model; the model itself is §2.

### 1.1 FPGA architecture (the structure we model faithfully)

A field-programmable gate array is a sea of SRAM-configured **LUTs + flip-flops**
grouped into **Configurable Logic Blocks (CLBs)**, wired by a programmable
**routing fabric / switch matrix** (which occupies 80–90% of the die), with hard
**DSP slices** (multiply-accumulate), **Block RAM** (on-chip line/frame memory),
and **I/O Blocks (IOBs)** at the edges, all driven by a global **clock tree**. A
**bitstream** loads every LUT truth table, routing switch, and tile mode; a
synthesis → **place-and-route** toolchain turns a netlist into that bitstream
([FPGARelated architecture overview](https://www.fpgarelated.com/fpga-fundamentals/fpga-architecture),
[ecrionix "Inside an FPGA"](https://ecrionix.org/fpga-from-scratch/day-02-inside-an-fpga-luts-clbs/),
[Wevolver FPGA architecture guide](https://www.wevolver.com/article/fpga-architecture-a-comprehensive-guide-for-digital-design-engineers)).

We model the **structure and feel**, not a per-pixel gate simulator (the wrong
cost/aesthetic tradeoff at video-res × 60 fps on a GPU). The mapping the shipped
system uses — and it lines up cleanly with canonical FPGA architecture:

| Silicon primitive | VFPGA tile | GPU realisation |
|---|---|---|
| CLB (LUT+FF compute cell) | `clb` tile | one parameterised GLSL kernel → one FBO |
| LUT (k-input truth table) | `lut16` tile | literal 4-in bitwise LUT, 16-texel INIT sampled per pixel |
| Flip-flop / register | `reg` tile | ping-pong FBO pair holding *last frame*; `:prev` reads it |
| Switch matrix / interconnect | `nets[]` | which texture binds to which input sampler (the binding *is* the switch) |
| IOB | `iob_in`/`iob_out` | host port adapters (IIN←vin, CIN←cv, GIN←gate, OUT→vout) |
| DSP slice | `dsp` tile | heavier MAC/convolve kernel; counted against a DSP budget |
| Block RAM | `bram` tile | line/frame-buffer FBO + an addressing kernel |
| Global clock | the render frame | `uTime`/frame-index; register swap = the clock edge |

The **bitstream → P&R → GPU passes** flow is the load-bearing reframe: a `.vfpga`
author describes a *fabric*; `fabricToEffect()` lowers it (topo-sort, comb-loop
reject, FBO assignment, pass emission) into the engine's `VfpgaEffect` pass-list.
The pass-list is P&R's *output*, never the authoring surface — exactly like a real
toolchain emits a bitstream from a netlist.

### 1.2 Video-synthesis lineage (the aesthetic we draw on)

- **Analog/modular video synthesis** — LZX Industries' modular and standalone
  instruments (Chromagnon, Visionary/Visual Cortex, Videomancer, BitVision) and
  the broader Eurorack-video lineage establish the *modular video* vocabulary we
  share: colorization, **keying** (chroma/luma), raster/scan generation, ramps,
  **feedback** ([LZX](https://lzxindustries.net/),
  [Chromagnon](https://lzxindustries.net/products/chromagnon),
  [Perfect Circuit — Visual Cortex](https://www.perfectcircuit.com/lzx-industries-visual-cortex.html)).
- **FPGA-based video synthesis** specifically — LZX's frame-buffer/FPGA modules
  for CV-controllable digital image manipulation, plus the open-source FPGA
  video-synth efforts on scanlines.xyz — are the direct precedent for "a
  reconfigurable digital fabric as a video instrument"
  ([scanlines.xyz FPGA video synth](https://scanlines.xyz/t/open-source-fpga-based-video-synthesis-platform/153)).
- **Circuit-bending video** — Gieskes-style camcorder/VCR/scaler bends and the
  Syntonie CBV chroma-corruptor lineage: deliberately mis-routing consumer video
  hardware (frame buffers, sync, datapaths) for glitch
  ([Gieskes/video-circuits lineage](https://videocircuits.blogspot.com/2010),
  [MOD WIGGLER circuit-bending video](https://modwiggler.com/forum/viewtopic.php?p=1403688)).
  In the fabric model a "bend" *is* a mis-configured tile or a hostile net — the
  framing pays off because the bends are literally bitstream configurations.

### 1.3 Effect concepts the catalog is built from

- **Keying** — chroma key removes a colour, luma key thresholds brightness into a
  cut-out for compositing (VJ/music-video staple)
  ([VDMX luma keying](https://vdmx.vidvox.net/tutorials/masking-techniques-for-layer-composition),
  [PixelFlow keying](https://audioeffetti.com/en/blog/pixelflow-advanced-keying-techniques-with-smart-luma-chroma-and-cut-fill-n175174)).
- **Posterize/quantize** — reduce colour/level count for a graphic, banded look.
- **Scanline / raster** — sine/square/saw/triangle scanline profiles; CRT raster
  shaping ([OBS retro effects](https://obsproject.com/forum/resources/retro-effects.1972/),
  GlitchCRT lineage).
- **Feedback / howl-around** — frame-store recirculation; the register-as-state.
- **Displacement** — sample one texture's UVs from a second (warp/distort).
- **Datamoshing** — exploiting codec inter-frame prediction: deleting I-frames so
  P-frame motion vectors keep applying to the wrong reference → melt/bloom
  ([Glitchology datamoshing](https://glitchology.com/datamoshing/),
  [datamosh frame mechanics](https://writingwithacamera.com/Handouts/Datamoshing)).
- **Digital-link bit errors** — composite databending, TMDS/HDMI sparkle, scaler
  /deinterlace artifacts (the bent catalog's authenticity anchors; LUT16 + BRAM).

The shipped catalog already realises sync, chroma, feedback, datapath-LUT, codec,
link, and scaler bends. The **gaps the next wave fills** are the *non-bent*
modular-video staples (keying, displacement, posterize, pure pattern generators)
that the LZX/VJ lineage expects and the fabric can express cheaply.

---

## 2. `.vfpga` format — the model (as shipped) + the one extension

### 2.1 Headline: the model and why

> **The `.vfpga` format is a declarative FPGA *bitstream*: a 2-D grid of typed,
> configurable tiles (`clb`/`dsp`/`bram`/`reg`/`lut16`/`iob_*`) wired by a routing
> netlist, that a pure place-and-route step compiles into the WebGL multi-pass
> engine's existing pass-list.** It is authored as in-repo, glob-collected,
> bundled TypeScript (no runtime-compiled or uploaded code → no untrusted eval).

Why this model (vs. the simpler "shader-graph DAG" or "register+LUT VM" the brief
floated as alternatives):
- It is the **authentic** one — a real FPGA *is* tiles + routing + a clock +
  registers + a bitstream + P&R, and that composition model is exactly what makes
  an FPGA an FPGA. The owner explicitly directed FPGA authenticity.
- A bare "shader-graph DAG" is a subset of this (drop the reg/bram/lut16 tile
  semantics and the clock edge) — we'd lose feedback-as-state and the LUT anchor.
- A "register+LUT bytecode VM evaluated per pixel" is the *gate-simulator* path
  the prior design correctly rejected: wrong cost/aesthetic on a GPU.
- It maps 1:1 onto our **existing** GL engine (`compileFragment` + `createFbo` /
  `createFloatFbo` + ordered passes + ping-pong), so P&R's output is a shape the
  factory already consumes unchanged.

### 2.2 Schema (the actual shipped TypeScript; authoritative is `types.ts`)

```ts
interface VfpgaSpec {
  id: string; name: string; doc: string; docSlug: string;   // identity + docs
  videoIn: 0|1|2|3|4; videoOut: 1|2;                          // declared IOB usage
  cvRoles?: VfpgaCvRole[];      // map a host CV input → a named uniform target
  gateRoles?: VfpgaGateRole[];  // map a host gate → held-level / edge-count uniforms
  params?: VfpgaParamSpec[];    // map a logical knob → a host p1..p8 slot + a uniform
  fabric?: VfpgaFabric;         // the bitstream (the catalog path)
  effect?: VfpgaEffect;         // legacy hand-authored pass-list (escape hatch)
  // exactly ONE of fabric/effect must be present
}

interface VfpgaFabric {
  grid: { rows: number; cols: number };           // floorplan (viz + auto-place)
  tiles: VfpgaTile[];
  nets: VfpgaNet[];                               // the switch matrix
  outputs: { vout1: string; vout2?: string };    // tile/IOB-out each vout samples
  budget?: { dsp?: number; bramRows?: number; passes?: number };  // resource caps
}

interface VfpgaTile {
  id: string;                                    // net-endpoint name
  type: 'clb'|'dsp'|'bram'|'reg'|'lut16'|'iob_in'|'iob_out';
  pos?: { row: number; col: number };            // placement (viz; optional)
  config: {
    op?: string;                                 // selects the cell within the type
    consts?: Record<string, number>;             // static bitstream constants
    lutInit?: number; bitPlanes?: number[];      // LUT16
    taps?: number[];                             // DSP conv
    rows?: number;                               // BRAM line-buffer depth
    clockDiv?: number;                           // reg: update every N frames (typed; impl later)
    kind?: 'rgba8'|'float';                      // tile FBO precision
    bind?: { knob: string; to: 'p'|'cv'|'gate'; slot?: number; uniform: string }[];
  };
  inputs?: string[];                             // logical input names the cell reads
}

interface VfpgaNet {
  from: string;  // "<tileId>" | "IIN1".."IIN4" | "CIN1".. | "GIN1".. | "<regId>:prev"
  to:   string;  // "<tileId>:<inputName>" | "OUT1" | "OUT2"
}
```

### 2.3 Primitive op set (the cell contract)

A cell is `{ type, op, inputs[], knobs[], kernel({uTexFor, uniformFor}) }`. The
kernel returns `#version 300 es` GLSL with the shared `in vec2 vUv; out vec4
outColor;` contract, a `uniform sampler2D uTex_<name>;` per input, and a `uniform
float <uniform>;` per knob. P&R instantiates the template with the tile's config.
This is the entire op-extension surface — **drop a `cells/<op>.ts` and it's live**
(glob-collected, zero shared-index edit). See §0 for the shipped op list and §5/§6
for the next ops to add.

### 2.4 How params / CV / gate map in (the binding mechanism)

- **Param slot** — `params[].slot` (1..8) maps a logical knob onto host `p1..p8`;
  the card renders a labelled knob over `[min,max]`. A tile binds a cell knob to
  that slot via `config.bind` (`to:'p', slot, uniform`).
- **CV role** — `cvRoles[].slot` (1..4) drives a named `uniform`; the host applies
  the per-input attenuverter (SCALE) + OFFSET, then **adds** the result onto the
  uniform (modular "CV adds on top of the knob base"). A tile binds via
  `config.bind` (`to:'cv'`).
- **Gate role** — `gateRoles[].slot` (1..4) gives a `heldUniform` (post
  edge-detect held level, 0/1) and/or a `countUniform` (rising-edge count — the
  re-roll/burst seed). The host edge-detects via `$lib/doom/cv-gate-edge`.
- **Accumulation contract** (in `vfpga-runner.ts setAllUniforms`): a uniform's
  value = static-const/param **base** + CV/gate **modulation**, written **once**.
  This is the rule any new role/op must respect.

### 2.5 Compile-to-GL + versioning + validation (all shipped)

- **Compile**: `fabricToEffect(fabric)` → `VfpgaEffect { passes[], fbos[],
  outputs, registers[] }`; the factory's `buildEffect` compiles that to a
  `CompiledEffect` (programs, FBOs, register pairs). Register pairs are swapped
  in place at end of frame (`register-swap.ts`).
- **Versioning**: `VfpgaSpec` is in-repo bundled TS — versioning is by git, not a
  wire format; the host module def carries `schemaVersion: 1`. **Recommendation
  for any future on-disk/shareable `.vfpga`** (out of current scope): add a
  top-level `formatVersion: number` to `VfpgaFabric` and gate P&R on it, so a
  serialized bitstream can be range-checked. Not needed while specs are bundled.
- **Validation** (`validateFabric`, pure, returns every diagnostic): unique tile
  ids; IOB ⊆ host superset; every `net.from`/`net.to` resolves; **no
  combinational cycle** (feedback must pass a `:prev` register edge); referenced
  `(type,op)` exists in the cell library; declared inputs/binds/consts match the
  cell's knobs/inputs; outputs resolve; `budget` (dsp/bramRows/passes) not
  exceeded. `fabricToEffect` throws `FabricCompileError` carrying all diagnostics.

### 2.6 Example `.vfpga` documents

**(a) Minimal generator — SMPTE bars (1 tile, no input):**
```ts
fabric: {
  grid: { rows: 1, cols: 1 },
  tiles: [
    { id: 'gen', type: 'clb', config: { op: 'smpte',
        bind: [ { knob: 'shift', to: 'cv', slot: 1, uniform: 'uShift' },
                { knob: 'brightness', to: 'p', slot: 1, uniform: 'uBrightness' },
                { knob: 'saturation', to: 'p', slot: 2, uniform: 'uSaturation' } ] } },
    { id: 'o1', type: 'iob_out', config: { op: 'OUT1' } },
  ],
  nets: [ { from: 'gen', to: 'OUT1' } ],
  outputs: { vout1: 'o1' },
}
```

**(b) Feedback — framestore-howl (the register-as-state pattern; abridged from the
shipped spec):**
```ts
tiles: [
  { id: 'warp', type: 'clb', config: { op: 'warp', consts: { rot: 0.02 },
      bind: [ { knob:'zoom', to:'p', slot:2, uniform:'uWarpZoom' }, /* hue, gain, clear */ ] },
    inputs: ['a'] },
  { id: 'mix',  type: 'clb', config: { op: 'mix',
      bind: [ { knob:'t', to:'p', slot:1, uniform:'uMixT' } ] }, inputs: ['a','b'] },
  { id: 'store', type: 'reg', config: { op: 'reg' }, inputs: ['a'] },   // the frame store
  { id: 'out',  type: 'clb', config: { op: 'passthru' }, inputs: ['a'] },
  { id: 'o1',   type: 'iob_out', config: { op: 'OUT1' } },
],
nets: [
  { from: 'store:prev', to: 'warp:a' },  // read LAST frame → cuts the feedback cycle
  { from: 'IIN1', to: 'mix:a' }, { from: 'warp', to: 'mix:b' },
  { from: 'mix', to: 'store:a' }, { from: 'mix', to: 'out:a' }, { from: 'out', to: 'OUT1' },
],
outputs: { vout1: 'o1' }, budget: { passes: 4 },
```

**(c) NEW — a proposed luma-key compositor (illustrates the §6 catalog gap; needs
the proposed `key` clb op from §5):**
```ts
// two video ins; key IIN1 by luma, composite over IIN2.
videoIn: 2, videoOut: 1,
params: [
  { slot:1, label:'thresh', uniform:'uKeyThresh', min:0, max:1, defaultValue:0.5 },
  { slot:2, label:'soft',   uniform:'uKeySoft',   min:0, max:0.5, defaultValue:0.1 },
],
fabric: {
  grid: { rows: 1, cols: 2 },
  tiles: [
    { id:'key', type:'clb', config:{ op:'key', consts:{ mode:0 /*luma*/ },
        bind:[ {knob:'thresh',to:'p',slot:1,uniform:'uKeyThresh'},
               {knob:'soft',  to:'p',slot:2,uniform:'uKeySoft'} ] }, inputs:['a'] },
    { id:'comp', type:'clb', config:{ op:'select' }, inputs:['a','b','m'] }, // a over b by mask m
    { id:'o1', type:'iob_out', config:{ op:'OUT1' } },
  ],
  nets: [
    { from:'IIN1', to:'key:a' }, { from:'IIN1', to:'comp:a' },
    { from:'IIN2', to:'comp:b' }, { from:'key', to:'comp:m' }, { from:'comp', to:'OUT1' },
  ],
  outputs: { vout1: 'o1' }, budget: { passes: 2 },
}
```
(Implementability note — VERIFIED on this tree: the shipped `select` cell is a
2-input MUX chosen by a *uniform* knob (`sel<0.5 → a, else b`), **not** a
per-pixel mask-texture composite. So the `comp` tile above needs a **new
3-input `composite` cell** (`a` over `b` weighted by mask texture `m`), or a
mask-input variant of `select`. This is a P-CAT2 deliverable — do not assume
`select` can take an `m` input.)

---

## 3. The model's authenticity ledger (honest)

**Authentic:** tiles + routing fabric + bitstream + place-and-route + IOBs + a
real 4-input LUT16 truth table + registers-as-the-only-state (exactly one frame,
clocked) + a DSP/BRAM/pass resource budget that can "not fit." The composition
model is genuinely FPGA-shaped.

**Feeling, not literal:** CLB/DSP/BRAM tiles are parameterised GLSL kernels, not
synthesized gate netlists; "routing" is sampler binding, not a switchbox; the
clock is the render frame, not a ns-scale clock tree. This is the deliberate,
correct tradeoff for a GPU at video rate — documented so we never over-claim.

---

## 4. Catalog — shipped + the proposed next wave

### 4.1 Shipped (8)
sync-bender, chroma-rot, framestore-howl, databend-cvbs (LUT16), macroblock-mosh,
tmds-sparkle (LUT16), scaler-glitch (BRAM), smpte-bars (generator).

### 4.2 Proposed next wave — the modular-video staples the bent set skipped

These fill the **non-bent** LZX/VJ vocabulary the fabric can express cheaply.
"Easy" = composes from shipped cells; "needs cell" = wants one new `cells/<op>.ts`.

| # | id | one-liner | primitives | difficulty |
|---|---|---|---|---|
| 1 | `luma-key` | key IIN1 by brightness, composite over IIN2 | `key`(new), `select`/`composite` | needs cell (`key`, maybe `composite`) |
| 2 | `chroma-key` | key IIN1 by a target hue/chroma, composite over IIN2 | `key`(new, mode=chroma), `composite` | needs cell |
| 3 | `posterizer` | reduce levels per channel → banded graphic look | `posterize`(new clb) | needs cell (trivial) |
| 4 | `displacer` | warp IIN1's UVs by IIN2 as a displacement map | `displace`(new clb, 2-in) | needs cell |
| 5 | `ramps` | XY/radial CV-able gradient pattern generator (0-in) | `ramp`(new clb generator) | needs cell (easy) |
| 6 | `noise-field` | seeded value/FBM noise generator (re-rollable by gate) | `noise`(new clb, reuses `bend-seed`) | needs cell (easy) |
| 7 | `scanlines` | sine/square/saw/tri scanline + CRT raster shaping | `scanline`(new clb) | needs cell (easy) |
| 8 | `edge-detect` | Sobel/Laplacian outline (reuses shipped `conv3x3` DSP) | `conv3x3` (consts only) | **easy — preset only, no new cell** |
| 9 | `solarize` | invert above a luma threshold (Sabattier) | `luma`+`invert`+`select`/`threshold` | easy — preset only |
| 10 | `color-quantize` | RGB→nearest-of-N palette posterize+dither | `posterize`(#3) + dither const | needs #3 |
| 11 | `delay-line` | per-frame N-frame video delay/echo (BRAM frame ring) | `framestore`/`delayN`(new bram op) | needs cell (medium) |
| 12 | `mirror-kaleido` | symmetry fold (quad/hex) UV remap | `mirror`(new clb) or `warp` variant | needs cell (easy–medium) |
| 13 | `slit-scan` | accumulate one column/row per frame into a register | `reg` + a column-copy clb | needs cell (medium) |

**Recommended next-wave spine (highest value / lowest risk first):**
`edge-detect` + `solarize` (preset-only, ship in one PR to prove "no-new-cell"
presets), then `posterizer`/`ramps`/`noise-field`/`scanlines` (each one trivial
cell), then the 2-input `luma-key`/`displacer` (the compositor cells).

The bent catalog already proved every tile *type* (clb/dsp/bram/reg/lut16/iob);
this wave proves the **format's reach into the canonical video-synth toolbox** and
seeds future "bent vs. clean" pairs (Q7 in the prior doc).

---

## 5. Phased build plan (each phase = one reviewable PR)

> Discipline carried from CLAUDE.md + memory: new-spec PRs auto-enrol in the
> registry-driven sweeps (per-module-per-port, behavioral, vrt per-card, the
> spec-validation + every-spec-has-a-docs-subpage + DESCRIPTIONS unit gates), so
> each new spec needs a DESCRIPTIONS entry, a docs subpage, lowercase id/label,
> a bespoke e2e (real input→effect→non-black output), VRT baselines
> (linux+darwin via the vrt-update workflow), and a **3× flake-check**. Any GLSL
> precision/encode assert must be **capability-/renderer-tolerant** (CI runs
> SwiftShader). Re-pin the webgl-attest hash as the **last** commit on any PR
> touching `lib/video/**`.

### Attest / VRT / CI flags per phase
- **webgl-attest**: the hash basis is `lib/video/**` non-test sources (+ WebGL
  cards). **Any new `cells/*.ts` or `specs/*.ts` or a `vfpga-runner.ts` edit →
  re-attest required.** A new `specs/*.ts` *spec data* file with no GLSL change
  to a *cell* still lives under `lib/video/**` → it IS in-basis → re-attest.
  (The floorplan/`lib/ui` Canvas2D helpers are **not** in-basis.)
- **VRT**: each new spec adds one per-card VRT row (the card looks the same shell;
  the *preview* differs). Card-shell changes → `task vrt` + inspect diff.
- **CI wall-time**: new presets add per-port + vrt + one bespoke e2e each. The
  bent specs are pure-GL and cheap; keep each bespoke e2e to a single
  input→output non-black assertion. Flag any phase that adds **> ~2 min** CI for
  explicit sign-off (the audio-rate phase, P-A1, is the one to watch — it touches
  the audio engine seam).

---

#### **P-CAT0 — "preset-only" proof slice (SMALLEST VALUABLE FIRST) ✅ recommended start**
Ship `edge-detect` + `solarize` as **presets composed entirely from shipped
cells** (`conv3x3`, `luma`, `invert`, `select`/`threshold`). **No new cell, no
engine touch.**
- Why first: proves the format's *no-new-code* authoring path end-to-end (a real
  user/designer adds an effect by writing one spec data file), exercises the full
  new-spec gate chain (DESCRIPTIONS, docs subpage, per-port, VRT, e2e) on the
  cheapest possible change, and is reviewable in an hour.
- Risk: **low.** Attest: **re-attest required** (new files under `lib/video/**`,
  even though no GLSL changed — over-invalidation is the safe direction).
  VRT: 2 new rows. CI: ~+small (2 cheap e2e).
- Validate locally: `task test:one -- vfpga`, `task typecheck`,
  `npx --workspace e2e playwright test per-module-per-port --grep vfpga`,
  `task vrt --grep vfpga`, the bespoke e2e ×3, then re-pin attest last.

#### **P-CAT1 — the "one trivial cell each" generators/quantizers**
`posterizer`, `ramps`, `noise-field`, `scanlines` — each is one new `clb` cell +
one spec. `noise-field`/`ramps` are 0-input generators (great default-load
content); `noise-field` reuses `bend-seed.ts`. Confirm `select`'s shipped input
signature here (the §2.6c note) and, if needed, add a 3-input `composite` cell.
- Risk: low–medium (GLSL, but trivial kernels). Attest: required. VRT: 4 rows.

#### **P-CAT2 — the compositor cells (keying + displacement)**
`key` (luma+chroma modes → mask) + `composite`/`select`-mask + `displace`
(2-input UV warp); specs `luma-key`, `chroma-key`, `displacer`. These are the
**2-input** path — verify the host binds `vin2` and the per-port sweep covers it.
- Risk: medium (2-input pixel correctness; key softness on SwiftShader — assert
  *structure* not exact alpha). Attest: required. VRT: 3 rows.

#### **P-A1 — audio-rate bend modulation (the ratified-but-unbuilt owner directive)**
Wire an **audio→CV bridge** so a bend uniform can be driven faster than frame
rate. **This is an engine-seam change — design it carefully, build it as a
review-before-merge PR, and it is the one phase most likely to need a CI
sign-off.** Two viable designs (pick in the PR after a spike):
  - **(A) Per-frame envelope/peak sample (cheap, recommended first cut):** read
    the patched audio source's recent RMS/peak via the existing analyser plumbing
    once per render frame and fold it into the CV role value. Gives "audio
    *reactive*" bends with zero new per-sample path. Lowest risk; ships the
    *feeling* of audio-rate without the worker/audio-thread bridge.
  - **(B) True at-rate (worker shared-buffer):** publish a small
    audio-thread→render ring (SharedArrayBuffer) the worker reads per frame to
    sub-sample modulation. Higher risk (cross-thread, COOP/COEP, worker), defer
    unless (A) is judged insufficient.
- **Recommendation:** ship **(A)** as P-A1 (re-frames the directive as "audio-
  *reactive* bends," honest about not being literal per-sample), and only pursue
  (B) if the owner wants genuine at-rate after seeing (A).
- Risk: medium–high (audio/video engine seam). Attest: **required** (`lib/video`
  touch). CI: flag for sign-off (audio e2e + the seam).
- Coverage: an e2e wiring a **real audio source → vfpga CV → bend** and asserting
  the bend *responds* (per the poly/MIDI "real source chain" discipline applied
  to audio→video).

#### **P-PREV — CPU preview snapshots for the bent/new specs**
Extend `snapshot.ts` beyond smpte-bars so the card preview shows a representative
still for each spec (or a per-spec deterministic placeholder). Pure TS, GL-free,
unit-tested. Pairs naturally with each catalog PR (add the snapshot with the
spec) rather than as one big phase.
- Risk: low. Attest: `snapshot.ts` is `lib/video/**` → required.

#### **P-CAT3 — BRAM/state effects (delay-line, slit-scan)**
`delay-line` (a `framestore`/`delayN` BRAM op — only `linebuf` ships today) and
`slit-scan` (a register + column-copy). Highest-effort catalog items; do last.
- Risk: medium. Attest: required. Watch CI wall-time (frame-ring FBOs).

---

## 6. Smallest valuable first slice — explicit recommendation

**Ship P-CAT0 (`edge-detect` + `solarize`, preset-only) first.** It:
- delivers two real, useful effects with **zero new GLSL and zero engine risk**,
- proves the whole new-spec authoring + gate pipeline on the cheapest change,
- is fully reviewable and 3×-flake-checkable in one short PR,
- and de-risks the format's headline claim ("add an effect = add one data file").

Flags for that first slice: **webgl-attest re-pin required** (new files in
`lib/video/**`, over-invalidation is safe); **VRT +2 rows** (regenerate
linux+darwin baselines via the vrt-update workflow_dispatch); **CI delta small**
(2 cheap input→output e2e); **stability** — both effects are deterministic
(conv consts / luma threshold), so no flake surface beyond the known VRT ±1px
layout-rounding settle (already handled in the harness).

---

## 7. Scaffold decision (this pass)

**Design-only. No code scaffolded.** Rationale: the format types, the pure
parser/validator (`validateFabric`), and their unit tests **already exist and are
green** (the brief's optional scaffold — "a pure parser/validator + unit tests" —
is literally the shipped `place-and-route.ts` + `place-and-route.test.ts`).
Writing a parallel one would duplicate shipped code and risk diverging from the
single source of truth. The genuinely *new* foundational work (a `posterize`/`key`
cell, the audio→CV bridge) all touches `cells/*.ts` or the engine seam — i.e. it
is GLSL/engine, **not** the "pure TS, no GL, no card" clean slice the brief
scoped a scaffold to. So per the brief's own "if it's not clean, DON'T" guard,
the correct move is design-only.

If a future builder wants a *non-GL* foundation increment that is still clean, the
candidate is: a **pure preset-authoring lint** (a unit-tested function that, given
a `VfpgaSpec`, returns warnings the validator doesn't — e.g. "vout1 tile has a
second consumer" or "an unbound knob with no const uses the cell default") under
`lib/video/vfpga/lint.ts` + `.test.ts`. That is pure TS, GL-free, additive, and
would be the clean-scaffold path — but it is an enhancement, not a prerequisite,
so it is left as a P-CAT0-adjacent option, not done here.

---

## 8. Sources
- FPGA architecture: [FPGARelated](https://www.fpgarelated.com/fpga-fundamentals/fpga-architecture),
  [ecrionix](https://ecrionix.org/fpga-from-scratch/day-02-inside-an-fpga-luts-clbs/),
  [Wevolver](https://www.wevolver.com/article/fpga-architecture-a-comprehensive-guide-for-digital-design-engineers)
- Video synthesis hardware: [LZX](https://lzxindustries.net/),
  [Chromagnon](https://lzxindustries.net/products/chromagnon),
  [Perfect Circuit — Visual Cortex](https://www.perfectcircuit.com/lzx-industries-visual-cortex.html),
  [scanlines.xyz FPGA video synth](https://scanlines.xyz/t/open-source-fpga-based-video-synthesis-platform/153)
- Circuit-bending / glitch: [video-circuits](https://videocircuits.blogspot.com/2010),
  [MOD WIGGLER](https://modwiggler.com/forum/viewtopic.php?p=1403688),
  [Glitchology datamoshing](https://glitchology.com/datamoshing/),
  [datamosh frame mechanics](https://writingwithacamera.com/Handouts/Datamoshing)
- Effects: [VDMX luma keying](https://vdmx.vidvox.net/tutorials/masking-techniques-for-layer-composition),
  [PixelFlow keying](https://audioeffetti.com/en/blog/pixelflow-advanced-keying-techniques-with-smart-luma-chroma-and-cut-fill-n175174),
  [OBS retro effects](https://obsproject.com/forum/resources/retro-effects.1972/)
- Internal prior design: `.myrobots/plans/vfpga-fpga-authentic-architecture.md`
