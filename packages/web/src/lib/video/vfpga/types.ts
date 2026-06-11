// packages/web/src/lib/video/vfpga/types.ts
//
// The `.vfpga` declarative spec format — the "virtual FPGA bitstream" a
// `vfpga-runner` host card loads + runs.
//
// CONCEPT: ONE registered video module (`vfpga-runner`, type `vfpgaRunner`)
// declares the full I/O SUPERSET its host card can wire (4 video ins, 4 CV,
// 4 gates, 2 video outs, an 8-slot generic param bank). A loaded VfpgaSpec
// selects which subset is ACTIVE and what render-graph runs — swap a compiled
// effect into one host, the way a bitstream reconfigures an FPGA fabric. The
// metaphor is inspired by — NOT a clone of — historic video-synth hardware;
// every id stays generic (no trademarked names).
//
// A spec is AUTHORED as `$lib/video/vfpga/specs/<id>.ts` exporting `<id>Spec`
// and is collected into the registry by `import.meta.glob` at build time, so
// adding a VFPGA needs NO edit to any shared index file (zero conflict surface).
//
// v1 SCOPE: specs are IN-REPO BUNDLED TYPESCRIPT only — there is NO user upload
// / runtime-compiled-code path. The GLSL the passes reference is plain inline
// strings the host `ctx.compileFragment`s; nothing here `eval`s untrusted text.

/** A CV role a spec declares on one of the host's 4 generic CV inputs (cv1..cv4).
 *  The role maps a CV input onto a named modulation target the effect's shader
 *  passes read as a uniform. The host always edge-scales the CV linearly and
 *  applies the per-input attenuverter (SCALE) + OFFSET before the uniform write. */
export interface VfpgaCvRole {
  /** Which host CV input drives this role (1..4 → cv1..cv4). */
  slot: 1 | 2 | 3 | 4;
  /** Short human label shown under the CV jack on the card. */
  label: string;
  /** The GLSL uniform name (a `float`) the role's post scale+offset value is
   *  written into on every pass that declares it in `uniforms`. */
  uniform: string;
  /** One-line description for the docs subpage. */
  doc?: string;
}

/** A GATE role a spec declares on one of the host's 4 gate inputs (g1..g4).
 *  The host raw-passes the gate sample into the synthetic `gN_evt` param AND
 *  runs a factory hysteresis edge-detector; the effect reads the detected
 *  rising-edge count / held state via the named uniform(s). */
export interface VfpgaGateRole {
  /** Which host gate input drives this role (1..4 → g1..g4). */
  slot: 1 | 2 | 3 | 4;
  /** Short human label shown under the gate jack on the card. */
  label: string;
  /** Optional `float` uniform set to the HELD gate level (0/1, post edge-detect
   *  hysteresis) on every pass that declares it. */
  heldUniform?: string;
  /** Optional `float` uniform set to a monotonically-increasing rising-edge
   *  COUNT (wrapped to a large period) so a shader can advance a pattern per
   *  pulse. Declared on passes that read it in `uniforms`. */
  countUniform?: string;
  /** One-line description for the docs subpage. */
  doc?: string;
}

/** One mapped param slot. The spec maps its logical param onto a fixed host
 *  slot p1..p8; the card renders a knob for it with the spec's label/range. */
export interface VfpgaParamSpec {
  /** Which host param slot this maps onto (1..8 → p1..p8). */
  slot: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Knob label. */
  label: string;
  /** The `float` uniform the slot value is written into on declaring passes. */
  uniform: string;
  min: number;
  max: number;
  defaultValue: number;
  curve?: 'linear' | 'log' | 'exp' | 'discrete';
  units?: string;
  doc?: string;
}

/** An intermediate framebuffer the effect allocates. v1: only `vout1` needs a
 *  target, but the field exists so multi-pass effects (later waves) can declare
 *  ping-pong / scratch FBOs. */
export interface VfpgaFbo {
  /** Id referenced by a pass `target` / `inputs` / `outputs`. */
  id: string;
  /** RGBA8 (the default) or a FLOAT target (createFloatFbo, for signed /
   *  out-of-[0,1] precision). */
  kind: 'rgba8' | 'float';
}

/** One render pass. The host compiles `frag`, binds its declared `inputs`
 *  (video-in port ids OR fbo ids) to sampler uniforms, sets the `uniforms`
 *  it reads (param/CV/gate roles + the always-provided uTime/uResolution),
 *  and renders into `target` (an fbo id, or `'output'` for the surface FBO). */
export interface VfpgaPass {
  /** GLSL #version 300 es fragment source. `in vec2 vUv; out vec4 outColor;`
   *  is the shared contract (matches every host video module). */
  frag: string;
  /** Sampler bindings: each entry names a host VIDEO-IN port (`vin1`..`vin4`)
   *  or a declared fbo id, and the sampler uniform to bind it to. A null
   *  texture (unpatched video in) binds a 1×1 transparent-black fallback so
   *  the shader never samples garbage. */
  inputs?: { source: string; uniform: string }[];
  /** Render destination: an fbo id, or `'output'` for the host surface FBO
   *  that downstream + the canonical `vout1` samples. */
  target: string;
  /** Uniform names this pass reads — the host only sets uniforms a pass
   *  declares (so an effect can omit ones it ignores). Param/CV/gate uniforms
   *  PLUS the always-available `uTime` (seconds) / `uResolution` (vec2). */
  uniforms?: string[];
}

export interface VfpgaEffect {
  /** Ordered render passes (producers first; the LAST pass writing `output`
   *  feeds `vout1`). */
  passes: VfpgaPass[];
  /** Intermediate FBOs the passes render into / sample from. */
  fbos?: VfpgaFbo[];
  /** Which fbo/output each module video OUTPUT samples. `vout1` is REQUIRED
   *  and is the canonical surface (downstream samples `surface.texture`).
   *  `vout2` (optional) is exposed via `read('outputTexture:vout2')`. */
  outputs: { vout1: string; vout2?: string };
}

// ----------------------------------------------------------------------
// FABRIC CONFIGURATION ("the bitstream") — the FPGA-authentic authoring
// surface (design §2). An author describes a GRID of typed TILES wired by a
// routing NETLIST; a pure place-and-route step (`vfpga/place-and-route.ts`)
// lowers the fabric into the exact same `VfpgaEffect` shape the factory's
// `buildEffect` already consumes — `effect.passes[]` becomes the *output* of
// P&R, not the authoring surface. `effect` stays as a legacy escape hatch
// (smpte-bars keeps it). See `.myrobots/plans/vfpga-fpga-authentic-architecture.md`.
// ----------------------------------------------------------------------

/** A fabric tile TYPE (the silicon primitive it models, design §1.1):
 *  - `clb`     — generic per-pixel ALU cell (parameterised kernel; the P0 cells).
 *  - `dsp`     — heavier MAC/convolve cell (3×3 conv, demod). [kernels: later phase]
 *  - `bram`    — on-chip line/frame memory (line buffer, frame store). [later phase]
 *  - `reg`     — clocked flip-flop: a ping-pong FBO holding LAST frame's value;
 *               reading it via `<id>:prev` is the clocked (previous-frame) read
 *               that legally breaks feedback cycles. [swap is P1; type defined now]
 *  - `lut16`   — literal 4-input bitwise truth table (16-texel INIT). [later phase]
 *  - `iob_in`  — fixed fabric-edge INPUT block: maps a host port (IIN/CIN/GIN)
 *               into the fabric so nets can source it.
 *  - `iob_out` — fixed fabric-edge OUTPUT block: a fabric net sink that drives a
 *               host video output (OUT1/OUT2). */
export type VfpgaTileType =
  | 'clb'
  | 'dsp'
  | 'bram'
  | 'reg'
  | 'lut16'
  | 'iob_in'
  | 'iob_out';

/** A per-config-knob binding: routes a tile-config knob to a host param slot
 *  (p1..p8), a CV role, or a gate role, surfaced to the kernel as `uniform`.
 *  This is the foundation's uniform-binding mechanism, sourced from a tile's
 *  config instead of a pass's `uniforms[]`. */
export interface VfpgaTileBind {
  /** The config knob name this binding drives (e.g. 'amount', 't'). */
  knob: string;
  /** Bind source: a param slot, a CV role, or a gate role. */
  to: 'p' | 'cv' | 'gate';
  /** Host slot index (1-based): p1..p8 / cv1..cv4 / g1..g4. */
  slot?: number;
  /** The GLSL uniform the bound value is written into in the tile's kernel. */
  uniform: string;
}

/** One configurable fabric tile — a node in the routing graph. Its `type`
 *  selects the kernel family and `config.op` selects the specific cell within
 *  that family (P&R instantiates the cell's GLSL template with this config). */
export interface VfpgaTile {
  /** Unique tile id; the net-endpoint name nets reference (`from`/`to`). */
  id: string;
  /** Which silicon primitive this tile models. */
  type: VfpgaTileType;
  /** Floorplan placement (for the card viz + P&R hints). Optional → auto-place. */
  pos?: { row: number; col: number };
  config: {
    /** Selects the kernel WITHIN the type (the cell `op` name, e.g. 'mix'). For
     *  IOB tiles `op` names the host port: iob_in → 'IIN1'..'IIN4' / 'CIN1'.. /
     *  'GIN1'.. ; iob_out → 'OUT1' | 'OUT2'. */
    op?: string;
    /** Static bitstream constants (kernel knobs not bound to p/cv/gate). */
    consts?: Record<string, number>;
    /** LUT16: 16-bit truth table (per selected bit-plane). [later phase] */
    lutInit?: number;
    /** LUT16 / bitmask: which channel bit-planes participate. [later phase] */
    bitPlanes?: number[];
    /** DSP: convolution kernel taps. [later phase] */
    taps?: number[];
    /** BRAM: line-buffer depth (rows). [later phase] */
    rows?: number;
    /** reg: update every N frames (clock divider). [later phase] */
    clockDiv?: number;
    /** Tile FBO precision (default 'rgba8'; 'float' → createFloatFbo). */
    kind?: 'rgba8' | 'float';
    /** Per-knob bindings to host p/cv/gate (uniform-binding mechanism). */
    bind?: VfpgaTileBind[];
  };
  /** Logical input names this tile's kernel reads (a sampler each), giving nets
   *  stable endpoints to target (`<tileId>:<inputName>`). A 0-input generator/
   *  IOB-in tile omits this. */
  inputs?: string[];
}

/** One routed net — the switch-matrix wire from a source to a destination.
 *  The binding IS the switch; there is no literal switchbox object. */
export interface VfpgaNet {
  /** Source: a tile's output (`"<tileId>"`), a host IOB-in port
   *  (`"IIN1".."IIN4"` / `"CIN1".."CIN4"` / `"GIN1".."GIN4"`), or the CLOCKED
   *  back-buffer read of a register tile (`"<regId>:prev"` — previous frame,
   *  which legally breaks a feedback cycle). A plain `"<regId>"` read (no
   *  `:prev`) participating in a cycle is a combinational loop → P&R rejects. */
  from: string;
  /** Destination: a tile's named input (`"<tileId>:<inputName>"`) or a host
   *  video output (`"OUT1" | "OUT2"`). */
  to: string;
}

/** The fabric configuration — the FPGA bitstream the host loads + P&R compiles. */
export interface VfpgaFabric {
  /** Floorplan dimensions (for the card viz + auto-placement). */
  grid: { rows: number; cols: number };
  /** The configurable tiles. */
  tiles: VfpgaTile[];
  /** The routing netlist (the switch-matrix). */
  nets: VfpgaNet[];
  /** Which fabric endpoint each module video OUTPUT samples — a tile id (whose
   *  output FBO that vout reads) or a host `OUT1`/`OUT2` IOB-out tile id. */
  outputs: { vout1: string; vout2?: string };
  /** Resource caps (authentic "doesn't fit" budget + a CI-walltime guardrail):
   *  max DSP tiles, max BRAM rows, max compiled passes. */
  budget?: { dsp?: number; bramRows?: number; passes?: number };
}

export interface VfpgaSpec {
  /** Stable unique id (generic, no trademarked names). Doubles as the
   *  "load preset…" option value + the docs slug key. */
  id: string;
  /** Display name shown in the load menu + on the card title readout. */
  name: string;
  /** One-paragraph model summary (shown on the docs subpage). */
  doc: string;
  /** URL slug for the per-VFPGA docs subpage (`/docs/modules/vfpga/<docSlug>/`). */
  docSlug: string;
  /** How many host VIDEO inputs (vin1..vinN) this effect consumes (0..4). A
   *  pattern GENERATOR declares 0. */
  videoIn: 0 | 1 | 2 | 3 | 4;
  /** How many host VIDEO outputs this effect drives (1 or 2). */
  videoOut: 1 | 2;
  /** CV roles mapped onto host CV inputs. */
  cvRoles?: VfpgaCvRole[];
  /** Gate roles mapped onto host gate inputs. */
  gateRoles?: VfpgaGateRole[];
  /** Param slots mapped onto the host p1..p8 bank. */
  params?: VfpgaParamSpec[];
  /** NEW (design §2): the fabric configuration. When present, the factory P&R's
   *  it into a `VfpgaEffect` (P1). The fabric-described path is the catalog goal. */
  fabric?: VfpgaFabric;
  /** LEGACY escape hatch (design §4): a hand-authored render-graph. Kept
   *  first-class for `smpte-bars` + edge cases; deprecated for NEW catalog
   *  VFPGAs (those are fabric-described). Exactly ONE of `fabric`/`effect` must
   *  be present (P&R supplies `effect` from `fabric` at build time). */
  effect?: VfpgaEffect;
}

// ----------------------------------------------------------------------
// Host superset constants — the FIXED port/param pools the host declares
// + every spec maps a subset of. Shared by the module def, the card, the
// factory, and the validation unit test (single source of truth).
// ----------------------------------------------------------------------

/** Host VIDEO inputs (the superset; a spec activates videoIn of them). */
export const VFPGA_VIDEO_IN_PORTS = ['vin1', 'vin2', 'vin3', 'vin4'] as const;
/** Host CV inputs. */
export const VFPGA_CV_PORTS = ['cv1', 'cv2', 'cv3', 'cv4'] as const;
/** Host GATE inputs. */
export const VFPGA_GATE_PORTS = ['g1', 'g2', 'g3', 'g4'] as const;
/** Host VIDEO outputs. */
export const VFPGA_VIDEO_OUT_PORTS = ['vout1', 'vout2'] as const;
/** Host generic param slots. */
export const VFPGA_PARAM_SLOTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'] as const;

// ----------------------------------------------------------------------
// FABRIC IOB superset — the fixed fabric-edge ports a net can source/sink
// (design §1.1). They map 1:1 onto the host superset above: IIN←vin, CIN←cv
// (post attenuverter), GIN←gate (edge-detected), OUT→vout. A net `from`/`to`
// referencing an IOB name must be within these sets (validation §2.1).
// ----------------------------------------------------------------------

/** Fabric IOB-in VIDEO ports (←vin1..vin4). */
export const VFPGA_IOB_IIN = ['IIN1', 'IIN2', 'IIN3', 'IIN4'] as const;
/** Fabric IOB-in CV ports (←cv1..cv4, post attenuverter). */
export const VFPGA_IOB_CIN = ['CIN1', 'CIN2', 'CIN3', 'CIN4'] as const;
/** Fabric IOB-in GATE ports (←g1..g4, edge-detected). */
export const VFPGA_IOB_GIN = ['GIN1', 'GIN2', 'GIN3', 'GIN4'] as const;
/** Fabric IOB-out VIDEO ports (→vout1/vout2). */
export const VFPGA_IOB_OUT = ['OUT1', 'OUT2'] as const;

/** Every fabric IOB-in port name (the union a `net.from` IOB source must be in). */
export const VFPGA_IOB_IN_PORTS: readonly string[] = [
  ...VFPGA_IOB_IIN,
  ...VFPGA_IOB_CIN,
  ...VFPGA_IOB_GIN,
];

/** Map a 1-based IOB-in VIDEO port to its backing host vin port (IIN1→vin1). */
export const iobIinToVin = (port: string): string | null =>
  /^IIN[1-4]$/.test(port) ? `vin${port.slice(3)}` : null;
/** Map a 1-based IOB-out VIDEO port to its host vout port (OUT1→vout1). */
export const iobOutToVout = (port: string): string | null =>
  /^OUT[1-2]$/.test(port) ? `vout${port.slice(3)}` : null;

/** The synthetic per-gate param a gate input's raw sample is written into
 *  (`g1` → `g1_evt`, …). The factory edge-detects these. */
export function gateEvtParam(slot: number): string {
  return `g${slot}_evt`;
}

/** Map a 1-based slot index to the host port/param id. */
export const vinPort = (slot: number): string => `vin${slot}`;
export const cvPort = (slot: number): string => `cv${slot}`;
export const gatePort = (slot: number): string => `g${slot}`;
export const paramSlotId = (slot: number): string => `p${slot}`;
