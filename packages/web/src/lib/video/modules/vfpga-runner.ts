// packages/web/src/lib/video/modules/vfpga-runner.ts
//
// vfpga-runner — a HOST module that runs a loaded `.vfpga` declarative effect
// spec (a "virtual FPGA bitstream"). ONE registered video module declares the
// full I/O SUPERSET; the loaded VfpgaSpec (node.data.vfpga = id, resolved from
// $lib/video/vfpga/registry.ts) selects which subset is ACTIVE and what
// render-graph runs. Hot-swap on preset change rebuilds the GL pipeline.
//
// Why a superset on the def: edge-validation (Canvas.svelte) + the registry
// sweeps read def.inputs/outputs, so EVERY port any VFPGA could wire MUST exist
// on the def. The card highlights only the loaded spec's ACTIVE ports (it still
// renders the full superset of handles so the per-module-per-port handle sweep
// stays green; inactive ports are dimmed). Active-port + per-CV attenuverter /
// scope state live in node.data (TOYBOX live-node.data pattern — NEVER per-frame
// Y.Doc writes).
//
// Superset:
//   inputs : vin1..vin4 (video) ; cv1..cv4 (cv, linear, → synthetic cvN_val
//            params) ; g1..g4 (gate, → synthetic gN_evt params, raw passthrough
//            + factory hysteresis edge-detect — the DOOM/backdraft convention).
//   outputs: vout1 (video, canonical surface.texture) ; vout2 (video, via
//            read('outputTexture:vout2')).
//   params : p1..p8 generic slot bank + the cv/gate synthetic params.
//
// Render: MAIN THREAD (#1811). This header used to claim renderLocus 'worker'
// and the def used to declare 'worker-experimental'; both were wrong — the
// render worker's bundle manifest never imported a VFPGA factory, so the flag
// installed a proxy that never received a frame. See the def below for the
// three structural reasons it cannot move (vin1..vin4, vout1+vout2, and the
// card's per-frame read('gateState') poll).
//
// Inputs (def):
//   vin1..vin4 (video): bound to the active spec's declared video-in samplers.
//   cv1..cv4 (cv, linear, paramTarget=cvN_val): the spec's CV roles read these
//     post scale+offset (node.data.cvInputs attenuverter/offset) as uniforms.
//   g1..g4 (gate, paramTarget=gN_evt): raw gate sample; the factory edge-detects
//     rising edges; the spec's gate roles read held level / edge count uniforms.
// Outputs (def):
//   vout1 (video): the spec's vout1 fbo (surface.texture).
//   vout2 (video): the spec's vout2 fbo, if declared (read('outputTexture:vout2')).
// Params (def):
//   p1..p8 (linear 0..1 generic slots) — a loaded spec maps its params on with
//     labels/ranges; cvN_val + gN_evt are synthetic CV/gate params (no knob).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type {
  VideoNodeHandle,
  VideoNodeSurface,
  VideoEngineContext,
  VideoFrameContext,
} from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { patch as livePatch } from '$lib/graph/store';
import {
  VFPGA_VIDEO_IN_PORTS,
  VFPGA_CV_PORTS,
  VFPGA_GATE_PORTS,
  VFPGA_PARAM_SLOTS,
  gateEvtParam,
  type VfpgaSpec,
  type VfpgaEffect,
} from '$lib/video/vfpga/types';
import { fabricToEffect } from '$lib/video/vfpga/place-and-route';
import { swapRegisters } from '$lib/video/vfpga/register-swap';
import { getVfpgaSpec, DEFAULT_VFPGA_ID, listVfpgaSpecs } from '$lib/video/vfpga/registry';
import { specParamSlotDefault } from '$lib/graph/vfpga-runner';
import { effectiveCvValue, foldCvToUnipolar } from '$lib/video/toybox-cv-math';
import { getCvInput, type CvInputs } from '$lib/video/toybox-cv-routes';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import {
  renderSmpteSnapshot,
  SNAPSHOT_W,
  SNAPSHOT_H,
} from '$lib/video/vfpga/snapshot';

/** The synthetic CV param a cv input writes into (`cv1` → `cv1_val`, …). */
function cvValParam(slot: number): string {
  return `cv${slot}_val`;
}

/** Resolve the render graph a spec runs: a fabric-described spec (design §2) is
 *  place-and-routed into a VfpgaEffect; a legacy spec uses its hand-authored
 *  `effect` directly. Throws if a spec declares neither (the registry's
 *  looksLikeVfpgaSpec guard already requires one, so this is a defensive net). */
function resolveSpecEffect(s: VfpgaSpec): VfpgaEffect {
  if (s.fabric) return fabricToEffect(s.fabric);
  if (s.effect) return s.effect;
  throw new Error(`vfpga spec "${s.id}" has neither a fabric nor an effect`);
}

/** node.data shape this module owns. */
interface VfpgaRunnerData {
  /** Loaded VFPGA spec id (defaults to DEFAULT_VFPGA_ID). */
  vfpga?: string;
  /** Per-CV-input attenuverter (SCALE) + OFFSET — TOYBOX cvInputs shape. */
  cvInputs?: CvInputs;
}

// ----------------------------------------------------------------------
// Compiled effect — the GL pipeline for one loaded VfpgaSpec.
// ----------------------------------------------------------------------

interface CompiledPass {
  program: WebGLProgram;
  /** sampler uniform location + the source id (vinN port or fbo id). */
  samplers: { source: string; loc: WebGLUniformLocation | null }[];
  /** float uniform locations the host sets each frame, keyed by uniform name. */
  uniforms: Map<string, WebGLUniformLocation | null>;
  /** STATIC float consts (P&R `pass.consts` — bitstream constants + unbound cell-
   *  knob defaults): {location, value}. Set verbatim each frame BEFORE the role
   *  loop, so a knob bound to a p/cv/gate role (absent here) still overrides. */
  consts: { loc: WebGLUniformLocation | null; value: number }[];
  /** target fbo id, or 'output' for the surface FBO. */
  target: string;
}

interface CompiledEffect {
  passes: CompiledPass[];
  /** Intermediate FBOs by id (rgba8 / float). */
  fbos: Map<string, { fbo: WebGLFramebuffer; texture: WebGLTexture }>;
  /** vout1/vout2 → the fbo id (or 'output') whose texture they sample. */
  vout1Id: string;
  vout2Id: string | null;
  /** Register ping-pong pairs (P&R output) the host swaps at END of frame: the
   *  front buffer just written becomes next frame's `:prev` back buffer (the
   *  fabric clock edge). Empty for legacy effects with no registers. */
  registers: { front: string; back: string }[];
}

export const vfpgaRunnerDef: VideoModuleDef = {
  type: 'vfpgaRunner',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'vfpga-runner',
  category: 'sources',
  // Every catalog VFPGA is pure-GL with a DOM-free factory → eligible for the
  // off-main-thread render worker under the EXPLICIT flag.
  //
  // ⚠ RENDER LOCUS: MAIN (#1811). This def used to declare
  // `renderLocus: 'worker-experimental'`, and that declaration was INERT AND
  // MISLEADING — the render worker's bundle manifest never imported a VFPGA
  // factory, so `?videoworker=1` installed a WorkerProxyHandle that received
  // no frame, ever, and silently fell back to the main thread for the life of
  // the node. The render-locus gate (worker/worker-eligibility.test.ts) found
  // it by asserting the manifest and the registry agree in both directions.
  //
  // Registering a factory would not have fixed it, for two reasons that are
  // structural rather than incidental:
  //   * VFPGA declares vin1..vin4. The worker's `getInputTexture` ALWAYS
  //     returns null (there are no cross-thread input textures and no
  //     worker-side edges), so a patched VFPGA would render as if every video
  //     input were unpatched — a different picture, not a degraded one.
  //   * VFPGA declares vout1 AND vout2. The return protocol carries ONE
  //     ImageBitmap per node, so vout2 could only be served by materialising
  //     the main factory — a double render, strictly slower than staying put.
  // The original note below is still true and is the THIRD reason:
  //   the card polls `read('gateState')` + `readParam('cvN_val')` every frame
  //   for its gate LEDs / CV scopes, and WorkerProxyHandle serves `read()` by
  //   materialising AND ticking a main-thread fallback handle.
  //
  // Re-promotion needs worker-side input edges, a multi-output return
  // protocol, and worker-side probe forwarding. Until then this renders on the
  // main thread and SAYS SO.
  inputs: [
    // VIDEO inputs — the superset; a loaded spec binds videoIn of them.
    ...VFPGA_VIDEO_IN_PORTS.map((id) => ({ id, type: 'video' as const })),
    // CV inputs → synthetic cvN_val params (linear-scaled), read as uniforms.
    ...VFPGA_CV_PORTS.map((id, i) => ({
      id,
      type: 'cv' as const,
      paramTarget: cvValParam(i + 1),
      cvScale: { mode: 'linear' as const },
    })),
    // GATE inputs → synthetic gN_evt params (raw passthrough; factory edge-detect).
    // Declared GATE: the host itself ALWAYS maintains and publishes the held
    // level (:420 heldUniform, :556 the card's activity LEDs) and additionally
    // an edge count (:421) — which of the two a given loaded spec reads is the
    // spec's choice, so `gate` is the superset that never lies. (`PortDef.edge`
    // cannot express "depends on the loaded program"; see the Phase-0 table
    // §4.2 finding 2.)
    ...VFPGA_GATE_PORTS.map((id, i) => ({
      id,
      type: 'gate' as const,
      edge: 'gate' as const,
      paramTarget: gateEvtParam(i + 1),
    })),
  ],
  outputs: [
    { id: 'vout1', type: 'video' },
    { id: 'vout2', type: 'video' },
  ],
  params: [
    // Generic slot bank p1..p8 (a loaded spec maps + labels these on the card).
    ...VFPGA_PARAM_SLOTS.map((id) => ({
      id,
      label: id.toUpperCase(),
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
    // Synthetic CV params (no card knob — rendered only as the cv jacks).
    ...VFPGA_CV_PORTS.map((_id, i) => ({
      id: cvValParam(i + 1),
      label: `CV${i + 1}`,
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
    // Synthetic gate params (no card knob — rendered only as the gate jacks).
    ...VFPGA_GATE_PORTS.map((_id, i) => ({
      id: gateEvtParam(i + 1),
      label: `G${i + 1}`,
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
  ],

  // ── CONTROL FAMILIES ─────────────────────────────────────────────────────
  //
  // The two DOM-only control surfaces this card has always carried and no
  // `ParamDef` can describe. Both are DYNAMIC — the picker's roster is the
  // bundled `.vfpga` catalog, and the CV rack renders one strip per CV role the
  // LOADED bitstream declares — which is exactly what this construct is for.
  //
  // ⚠ THE `testidPrefix` VALUES ARE THE CARD'S OWN, NOT NEW NAMES.
  // `module-docs-lint` greps card source for each prefix precisely so a
  // declared family cannot drift off the card, and `VfpgaRunnerCard.svelte`
  // already emits `data-testid="vfpga-preset"` and `data-testid="vfpga-cv"`.
  // Inventing prettier ids would have meant editing the card's testids, which
  // `e2e/tests/vfpga-runner.spec.ts` addresses by name.
  //
  // ⚠ A FAMILY, NOT AN `options` ROSTER ON A PARAM — the milkdrop/dx7 choice,
  // for the same two reasons. There is no param to put a roster ON (the loaded
  // bitstream is `node.data.vfpga`, not a ParamDef), and `params` is real code
  // where `controlFamilies` is hash-transparent, so a roster would have cost a
  // real-GPU re-attest this whole faceplate otherwise avoids.
  controlFamilies: [
    { id: 'vfpga-preset', label: 'VFPGA picker', kind: 'other', testidPrefix: 'vfpga-preset' },
    { id: 'vfpga-cv', label: 'Modulation rack', kind: 'cell', testidPrefix: 'vfpga-cv' },
  ],

  // ── PARAMS WITH NO USER CONTROL (#1726) ──────────────────────────────────
  //
  // EIGHT of this def's sixteen params exist so the CV BRIDGE has somewhere to
  // write, not so a player has something to turn. The def's own comments have
  // said so since it shipped ("no card knob — rendered only as the cv jacks"),
  // and `VfpgaRunnerCard.svelte` renders a knob for NONE of them: its grid is
  // built from `spec.params` (the p1..p8 slots) and its CV/gate rows are the
  // attenuverter + LED, never the raw sample.
  //
  // `writer: 'cv-port'` is the ANCHORED arm — every one of these is the
  // `paramTarget` of a declared input port above, so renaming a port reddens
  // the entry rather than leaving it quietly true. DERIVED from the same two
  // port rosters that generate the params, so the two lists cannot drift.
  noUserControl: [
    ...VFPGA_CV_PORTS.map((portId, i) => ({
      param: cvValParam(i + 1),
      writer: 'cv-port' as const,
      why:
        `the raw sample the ${portId} jack writes. A player conditions it with that input's `
        + 'SCALE attenuverter + OFFSET (node.data.cvInputs, the CV band\'s panel) and the loaded '
        + "VFPGA's cvRole decides which shader uniform it lands on — nothing anywhere turns this "
        + 'value directly.',
    })),
    ...VFPGA_GATE_PORTS.map((portId, i) => ({
      param: gateEvtParam(i + 1),
      writer: 'cv-port' as const,
      why:
        `the raw gate level the ${portId} jack writes. The factory hysteresis edge-detector turns `
        + "it into the held-level and rising-edge-count uniforms the loaded VFPGA's gateRole "
        + 'reads; a rotary over a raw 0/1 swing would be a control over the cable, not over the '
        + 'module.',
    })),
  ],

  // ── FACEPLATE (PF-20) ────────────────────────────────────────────────────
  //
  // WHAT THIS MODULE IS, MUSICALLY. Every other video module in the fleet IS
  // one effect: its params are the effect. VFPGA-RUNNER is a HOST — it is
  // whichever `.vfpga` bitstream is loaded into it, and swapping that rebuilds
  // the entire GL pipeline. So the player's verb is not "turn a knob", it is
  // LOAD A PROGRAM and then play the eight generic slots that program mapped
  // onto itself. Nothing else here is reconfigurable at runtime.
  //
  // THE TIER LADDER, read back as a sentence: the one control that decides what
  // this module IS comes first (the VFPGA picker), then the slot bank in slot
  // order (a loaded spec maps its params onto p1 upward, so slot order IS the
  // spec's own priority), and the CV conditioning rack last — it is a DOCK-ONLY
  // panel, and rank 10 is comfortably past the six-cell lane plate, so it costs
  // no lane rank it could not use.
  //
  // ⚠ NO HERO. `heroFacePlan` MOVES the promoted key out of its band, and two
  // of the three bands here hold exactly one cell — promoting either would
  // empty its band, drop the band, and render its authored hint nowhere. The
  // module's picture arrives from `hasVideoSurface` + the extension body
  // instead, which is where a video face's identity belongs anyway.
  face: {
    // DERIVED from the same roster that generates the params — never a
    // hand-typed slot list.
    order: [
      'vfpga-preset-{n}',
      ...VFPGA_PARAM_SLOTS,
      'vfpga-cv-{n}',
    ],

    pages: [
      {
        id: 'program',
        label: 'program',
        hint:
          'which .vfpga bitstream is loaded. Picking one disposes the running GL pipeline and '
          + "builds the new spec's, seeding that spec's param-slot defaults — so the slots below "
          + 'mean something different for every entry in this list',
        controls: ['vfpga-preset-{n}'],
      },
      {
        id: 'slots',
        label: 'slots',
        hint:
          'the generic 0..1 param bank the host owns. The loaded VFPGA maps its own params onto '
          + 'these in slot order and scales each into its declared range, so P1 is always that '
          + "program's first parameter and a slot the program does not map is inert",
        controls: [...VFPGA_PARAM_SLOTS],
      },
      {
        id: 'modulation',
        label: 'modulation',
        hint:
          "what the patch is doing to the loaded program: a SCALE attenuverter (bipolar, so it "
          + 'inverts) and an OFFSET per active CV role, applied before the value reaches the '
          + 'shader uniform, with a live trace of what actually arrives — and an activity lamp '
          + 'per active gate role',
        controls: ['vfpga-cv-{n}'],
      },
    ],

    // ⚠ MANDATORY FOR A VIDEO DEF. `primaryAudioOutPortId` matches
    // `type === 'audio'` and both outputs here are video, so ANY other glyph
    // literal falls through `glyphBinding` to `{kind:'static'}` and reddens
    // module-face-lint's dead-glyph clause. The picture arrives through
    // `hasVideoSurface(def)` and the extension's `fullViewBody` instead.
    glyph: 'none',

    // The module-owned dock body: the live output picture, the fleet-standard
    // SCREEN ON/OFF switch (owner ruling 2026-08-18), and the FABRIC floorplan
    // view the card's `fabric` button used to be the only route to.
    extension: 'vfpgaRunner',

    // ⚠ NO `monitor`: `face-monitor-source.test.ts` derives its subject from
    // cards that mount a hide-controls monitor, and this card never has one.
    // ⚠ NO `rear` curation: three cable domains on the input rail is exactly
    // what the DERIVED default already splits on, and the skill is explicit
    // that a group should mean something other than restating the domains.
  },

  docs: {
    explanation: "vfpga-runner is a runtime that executes a loaded .vfpga declarative spec — a \"virtual FPGA bitstream\" — as a WebGL video effect. ONE registered host module declares the full I/O superset it can ever wire (4 video ins, 4 CV, 4 gates, 2 video outs, an 8-slot generic param bank); the loaded VfpgaSpec selects which subset is ACTIVE and what render-graph runs, the way a bitstream reconfigures an FPGA fabric. A fabric-described spec (a grid of typed tiles wired by a routing netlist) is place-and-routed into the GL pass pipeline; a spec may also carry a legacy hand-authored render graph as an escape hatch, and when a spec declares both, the fabric path wins at runtime (smpte-bars ships both — its fabric lowers byte-identically to its legacy effect — to dogfood place-and-route on the reference VFPGA). Changing the preset hot-swaps the effect: the old GL pipeline is disposed and a new one built, with the new spec's param-slot defaults seeded. Usage: pick a VFPGA from the faceplate\'s \"load preset…\" menu (the bundled catalog ships smpte-bars as the default test-pattern generator plus glitch/datamosh-style effects: chroma-rot, databend-cvbs, framestore-howl, macroblock-mosh, scaler-glitch, sync-bender and tmds-sparkle). The card preview shows the REAL output of whatever VFPGA is loaded (a live blit of this node's own output FBO, not a frozen CPU snapshot); the \"fabric\" button toggles a read-only floorplan view (tile grid + lit routing nets). The card surfaces controls only for the loaded spec's active roles — a knob per mapped param slot, a SCALE attenuverter + OFFSET + always-on scope per active CV input, and an activity LED per active gate input — while the PatchPanel still renders the full superset of jacks (inactive ports dimmed). On the FACEPLATE the same surface is arranged as three bands - the VFPGA picker, the eight generic slot knobs, and a CV conditioning rack carrying each active CV role's SCALE attenuverter, OFFSET and live trace - with the output picture, a SCREEN on/off switch and the fabric floorplan view in the plate's own body. This module renders on the MAIN thread: it declares four video inputs the render worker cannot supply textures for, two video outputs the single-ImageBitmap return protocol cannot both carry, and a per-frame gate-state probe the worker proxy can only serve by materialising a main-thread fallback anyway.",
    inputs: {
      "vin1": "Video input 1. Bound to the loaded spec's first declared video-in sampler (a spec consumes 0–4 of these); a pattern generator like smpte-bars consumes none. Unpatched here samples a 1×1 transparent-black fallback so the shader never reads garbage.",
      "vin2": "Video input 2. Sampled by the loaded VFPGA only if its spec declares a video-in for this slot; otherwise dimmed/inactive and a transparent-black fallback is bound.",
      "vin3": "Video input 3. Sampled by the loaded VFPGA only if its spec declares a video-in for this slot; otherwise inactive with a transparent-black fallback.",
      "vin4": "Video input 4. The last of the four superset video ins; active only when the loaded spec maps a video-in role onto it, else dimmed with a transparent-black fallback.",
      "cv1": "CV input 1 (linear). Modulates whatever target the loaded VFPGA maps onto CV input 1 via its cvRoles, written into that role's shader uniform after the faceplate\'s per-input SCALE attenuverter + OFFSET. Routes through the synthetic cv1_val param.",
      "cv2": "CV input 2 (linear). Modulates the loaded spec's CV-role-2 modulation target (whatever uniform that VFPGA maps onto cv2), post SCALE + OFFSET. Inactive if the loaded spec declares no CV role here. Routes through synthetic param cv2_val.",
      "cv3": "CV input 3 (linear). Modulates the loaded spec's CV-role-3 target, applied as a uniform after the per-input SCALE attenuverter + OFFSET. Routes through synthetic param cv3_val.",
      "cv4": "CV input 4 (linear). Modulates the loaded spec's CV-role-4 target, applied post SCALE + OFFSET. Inactive if the loaded VFPGA declares no CV role for this slot. Routes through synthetic param cv4_val.",
      "g1": "Gate input 1. The host both holds its level and counts rising edges (hysteresis edge-detect); the loaded spec's gate role for this slot chooses level (gate, hold-while-high via heldUniform) or rising-edge count (trigger, advance-per-pulse via countUniform). Routes through synthetic param g1_evt.",
      "g2": "Gate input 2. Raw passthrough plus factory edge-detect; the loaded spec's gate-role-2 reads the held level and/or the rising-edge count. Acts as a gate or a trigger per which role uniforms it declares. Routes through synthetic param g2_evt.",
      "g3": "Gate input 3. Held level (gate) and rising-edge count (trigger) both available to the loaded spec's gate-role-3; interpretation is the role's choice of heldUniform/countUniform. Routes through synthetic param g3_evt.",
      "g4": "Gate input 4. The last superset gate; level + edge-count exposed to the loaded spec's gate-role-4 (gate vs trigger per its uniforms). Inactive if no gate role is mapped here. Routes through synthetic param g4_evt.",
    },
    outputs: {
      "vout1": "Primary video output — the canonical surface texture. The loaded spec's vout1 FBO (the final pass writing 'output'); always present, and what downstream modules and OUTPUT sample.",
      "vout2": "Secondary video output. Exposed only when the loaded spec declares a vout2 FBO (read('outputTexture:vout2')); otherwise null/inactive. Lets a multi-output effect tap a second buffer.",
    },
    controls: {
      "vfpga-preset-{n}": "VFPGA picker - the dropdown listing every bundled .vfpga bitstream by name (smpte-bars, chroma-rot, databend-cvbs, framestore-howl, macroblock-mosh, scaler-glitch, sync-bender, tmds-sparkle). Picking one writes node.data.vfpga and hot-swaps the running effect: the old GL pipeline is disposed, the new spec's passes are compiled, and its param-slot defaults are seeded into p1..p8 so the loaded program renders with its intended bend amounts immediately. It is the module\'s identity control - every other control here means something different depending on what this one says. ",
      "vfpga-cv-{n}": "Modulation rack - one strip per CV role the LOADED VFPGA declares, each carrying a SCALE attenuverter (-1..+1, so it inverts), an OFFSET (0..1), and an always-on trace of the value that actually reaches the shader uniform; then an activity lamp per active gate role. SCALE and OFFSET are applied to the raw cv1..cv4 sample before the spec's cvRole adds it onto its uniform, so they set how far and in which direction a patched cable swings that role. They live in node.data.cvInputs (never per-frame Y.Doc writes) The lamps read the factory's held gate state through the same read('gateState') seam. A spec that declares neither CV nor gate roles renders an empty rack.",
      "p1": "Generic param slot 1 (host 0..1). A loaded VFPGA maps and labels one of its params onto this slot; the faceplate renders a knob in the spec's [min,max] range only when the loaded spec uses the slot. The mapped value drives the bound shader uniform.",
      "p2": "Generic param slot 2. Surfaced as a labeled knob (in the spec's mapped range) only if the loaded VFPGA maps a param onto it; otherwise hidden. CV patched to the same uniform adds on top of this base.",
      "p3": "Generic param slot 3. A labeled knob appears only when the loaded spec maps a param here; the host slot is generic 0..1, shown to the user in the spec's [min,max] range.",
      "p4": "Generic param slot 4. Mapped + labeled by the loaded VFPGA when used; renders a knob in the spec's range, otherwise inactive.",
      "p5": "Generic param slot 5. Labeled and ranged by whichever spec param the loaded VFPGA maps onto it; no knob when the slot is unused by the loaded spec.",
      "p6": "Generic param slot 6. Surfaced as a knob (spec label + range) only when the loaded VFPGA uses the slot; the underlying host value is a 0..1 generic slot.",
      "p7": "Generic param slot 7. Mapped + labeled per the loaded spec; renders a knob in the mapped range when active, otherwise dimmed/hidden.",
      "p8": "Generic param slot 8 — the last of the p1..p8 bank. Labeled and ranged by the loaded VFPGA's mapped param when used; no knob otherwise.",
      "cv1_val": "Synthetic CV param for the cv1 jack (no knob). Carries the raw CV sample written by the cv1 input; read as the loaded spec's CV-role-1 modulation uniform after the faceplate\'s SCALE attenuverter + OFFSET.",
      "cv2_val": "Synthetic CV param for the cv2 jack (no knob). Holds the raw cv2 sample, surfaced to the loaded spec's CV-role-2 uniform post SCALE + OFFSET.",
      "cv3_val": "Synthetic CV param for the cv3 jack (no knob). Holds the raw cv3 sample, read by the loaded spec's CV-role-3 uniform after SCALE + OFFSET.",
      "cv4_val": "Synthetic CV param for the cv4 jack (no knob). Holds the raw cv4 sample, read by the loaded spec's CV-role-4 uniform after SCALE + OFFSET.",
      "g1_evt": "Synthetic gate param for the g1 jack (no knob). The factory hysteresis edge-detector turns this raw sample into the held-level and rising-edge-count uniforms the loaded spec's gate-role-1 reads.",
      "g2_evt": "Synthetic gate param for the g2 jack (no knob). Edge-detected into the held-level and rising-edge-count uniforms consumed by the loaded spec's gate-role-2.",
      "g3_evt": "Synthetic gate param for the g3 jack (no knob). Edge-detected into the held-level / rising-edge-count uniforms the loaded spec's gate-role-3 reads.",
      "g4_evt": "Synthetic gate param for the g4 jack (no knob). Edge-detected into the held-level / rising-edge-count uniforms the loaded spec's gate-role-4 reads.",
    },
  },
  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const { fbo: outFbo, texture: outTexture } = ctx.createFbo();

    // ---- Live param state (flat numeric bag) ----
    const params: Record<string, number> = {};
    for (const p of vfpgaRunnerDef.params) params[p.id] = p.defaultValue;
    Object.assign(params, node.params ?? {});

    /** Seed the loaded spec's param-slot DEFAULTS into the engine bag for any slot
     *  the node hasn't set (the host slot bank is generic 0 → a spec param at min →
     *  an inert bend). With a default seeded, a freshly-loaded VFPGA renders with
     *  its intended bend amounts. Mirrors the card/graph mutator's seeding so the
     *  engine + card agree; a card-written slot value (in node.params) always wins. */
    function seedSpecParamDefaults(s: VfpgaSpec, n: ModuleNode): void {
      const nodeParams = (n.params ?? {}) as Record<string, number>;
      for (const p of s.params ?? []) {
        const key = `p${p.slot}`;
        if (nodeParams[key] === undefined) params[key] = specParamSlotDefault(p);
      }
    }

    // ---- Per-gate edge-detect state ----
    const gateEdges: EdgeState[] = VFPGA_GATE_PORTS.map(() => makeEdgeState());
    const gateCounts: number[] = VFPGA_GATE_PORTS.map(() => 0);

    // ---- 1×1 transparent-black fallback for unpatched video-in samplers ----
    const blackTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, blackTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- Compiled effect (rebuilt on hot-swap) ----
    let spec: VfpgaSpec = resolveSpec(node);
    let compiled: CompiledEffect | null = null;

    function resolveSpec(n: ModuleNode): VfpgaSpec {
      const id = (n.data as VfpgaRunnerData | undefined)?.vfpga ?? DEFAULT_VFPGA_ID;
      return getVfpgaSpec(id) ?? getVfpgaSpec(DEFAULT_VFPGA_ID) ?? listVfpgaSpecs()[0]!;
    }

    function buildEffect(s: VfpgaSpec): CompiledEffect {
      // FABRIC FRONT-STEP (design §4.1): a fabric-described spec is place-and-
      // routed into the SAME VfpgaEffect shape the legacy hand-authored `effect`
      // has, so the GL code below is unchanged. A legacy effect-only spec
      // (smpte-bars) uses its `effect` directly.
      const effect = resolveSpecEffect(s);
      const fbos = new Map<string, { fbo: WebGLFramebuffer; texture: WebGLTexture }>();
      for (const f of effect.fbos ?? []) {
        if (f.kind === 'float' && ctx.createFloatFbo) {
          const { fbo, texture } = ctx.createFloatFbo();
          fbos.set(f.id, { fbo, texture });
        } else {
          const { fbo, texture } = ctx.createFbo();
          fbos.set(f.id, { fbo, texture });
        }
      }
      const passes: CompiledPass[] = effect.passes.map((pass) => {
        const program = ctx.compileFragment(pass.frag);
        const samplers = (pass.inputs ?? []).map((inp) => ({
          source: inp.source,
          loc: gl.getUniformLocation(program, inp.uniform),
        }));
        const uniforms = new Map<string, WebGLUniformLocation | null>();
        for (const u of pass.uniforms ?? []) uniforms.set(u, gl.getUniformLocation(program, u));
        // uTime / uResolution are ALWAYS available to a pass that declares them.
        if (!uniforms.has('uTime')) uniforms.set('uTime', gl.getUniformLocation(program, 'uTime'));
        if (!uniforms.has('uResolution')) uniforms.set('uResolution', gl.getUniformLocation(program, 'uResolution'));
        // Static consts (P&R bitstream constants + unbound knob defaults): resolve
        // each uniform's location once. A const whose uniform is ALSO a spec
        // role/param uniform is harmless (the role loop overrides it each frame).
        const consts = Object.entries(pass.consts ?? {}).map(([u, value]) => ({
          loc: gl.getUniformLocation(program, u),
          value,
        }));
        return { program, samplers, uniforms, consts, target: pass.target };
      });
      // Register ping-pong pairs to swap at end of frame (P&R output only).
      // Defensive: only keep pairs whose BOTH FBOs were actually allocated.
      const registers = (effect.registers ?? []).filter(
        (r) => fbos.has(r.front) && fbos.has(r.back),
      );
      return {
        passes,
        fbos,
        vout1Id: effect.outputs.vout1,
        vout2Id: effect.outputs.vout2 ?? null,
        registers,
      };
    }

    function disposeEffect(e: CompiledEffect | null): void {
      if (!e) return;
      for (const p of e.passes) gl.deleteProgram(p.program);
      for (const { fbo, texture } of e.fbos.values()) {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
      }
    }

    seedSpecParamDefaults(spec, node);
    compiled = buildEffect(spec);

    // ---- Live node.data readers (off the LIVE patch each call) ----
    function liveData(): VfpgaRunnerData {
      const d = livePatch.nodes[node.id]?.data as VfpgaRunnerData | undefined;
      return d ?? (node.data as VfpgaRunnerData | undefined) ?? {};
    }
    function liveCvInputs(): CvInputs {
      const ci = liveData().cvInputs;
      return ci && typeof ci === 'object' ? ci : {};
    }

    /** Resolve the texture for a pass sampler source (a vinN port or an fbo id). */
    function textureForSource(frame: VideoFrameContext, source: string, e: CompiledEffect): WebGLTexture {
      if (source.startsWith('vin')) {
        const tex = frame.getInputTexture(node.id, source);
        return tex ?? blackTex;
      }
      const f = e.fbos.get(source);
      return f ? f.texture : blackTex;
    }

    /** Target FBO for a pass target id ('output' → surface FBO, else an fbo id). */
    function targetFbo(target: string, e: CompiledEffect): WebGLFramebuffer | null {
      if (target === 'output') return outFbo;
      return e.fbos.get(target)?.fbo ?? outFbo;
    }

    /** The texture an output id ('output' → surface, else an fbo id) samples. */
    function textureForOutputId(id: string, e: CompiledEffect): WebGLTexture | null {
      if (id === 'output') return outTexture;
      return e.fbos.get(id)?.texture ?? null;
    }

    /** Compute the post scale+offset value for a CV role's host CV slot. The
     *  raw cv sample (folded to 0..1) lives in params[cvN_val]; apply the
     *  attenuverter (SCALE) + OFFSET, mapped 0..1. */
    function cvRoleValue(slot: number): number {
      const raw = params[cvValParam(slot)] ?? 0;
      const { scale, offset } = getCvInput(liveCvInputs(), VFPGA_CV_PORTS[slot - 1]!);
      return effectiveCvValue(raw, scale, offset, 0, 1);
    }

    function setAllUniforms(pass: CompiledPass, frame: VideoFrameContext): void {
      // uTime / uResolution (host-provided, never accumulated).
      const uT = pass.uniforms.get('uTime');
      if (uT) gl.uniform1f(uT, frame.time);
      const uR = pass.uniforms.get('uResolution');
      if (uR) gl.uniform2f(uR, ctx.res.width, ctx.res.height);

      // ACCUMULATE each float uniform from all its contributors, then write ONCE.
      // A uniform's value = its static const BASE (bitstream const / unbound knob
      // default OR a bound param's mapped value) PLUS any CV/gate role contribution
      // that targets the SAME uniform. This makes the modular mental model work: a
      // param sets the base amount and a CV patched to the same control ADDS its
      // modulation on top (instead of the last loop silently overwriting). A
      // uniform driven by a single source just gets that source's value.
      const acc = new Map<WebGLUniformLocation, number>();
      const add = (loc: WebGLUniformLocation | null, v: number) => {
        if (!loc) return;
        acc.set(loc, (acc.get(loc) ?? 0) + v);
      };

      // BASE: static consts (bitstream constants + unbound cell-knob defaults).
      for (const c of pass.consts) add(c.loc, c.value);
      // BASE: param slots → their uniform (the mapped value across [min,max]).
      for (const ps of spec.params ?? []) {
        const loc = pass.uniforms.get(ps.uniform);
        if (!loc) continue;
        const knob = params[`p${ps.slot}`] ?? 0; // 0..1 generic slot
        add(loc, ps.min + knob * (ps.max - ps.min));
      }
      // MODULATION: CV roles add onto their uniform (post scale+offset 0..1, then
      // a per-uniform range hint — SHIFT-style roles span 0..7).
      for (const role of spec.cvRoles ?? []) {
        add(pass.uniforms.get(role.uniform) ?? null, cvRoleValue(role.slot) * roleRangeHint(role.uniform));
      }
      // MODULATION: gate roles add held level + rising-edge count onto their
      // uniform(s) (a re-roll/burst trigger drives a count; a hold drives a level).
      for (const role of spec.gateRoles ?? []) {
        if (role.heldUniform) add(pass.uniforms.get(role.heldUniform) ?? null, gateEdges[role.slot - 1]!.pressed ? 1 : 0);
        if (role.countUniform) add(pass.uniforms.get(role.countUniform) ?? null, gateCounts[role.slot - 1]!);
      }

      for (const [loc, v] of acc) gl.uniform1f(loc, v);
    }

    /** A CV role uniform's value range hint. v1: SHIFT-style roles scale 0..1 →
     *  0..7 (the SMPTE bar count); default roles pass 0..1 through. Generic so a
     *  future spec can opt a role into a wider range purely by uniform name
     *  convention without a host edit. */
    function roleRangeHint(uniform: string): number {
      return uniform === 'uShift' ? 7 : 1;
    }

    /** Edge-detect every gate input from its raw synthetic param + bump counts. */
    function tickGates(): void {
      for (let i = 0; i < VFPGA_GATE_PORTS.length; i++) {
        const sample = params[gateEvtParam(i + 1)] ?? 0;
        const ev = detectEdge(gateEdges[i]!, sample);
        if (ev?.pressed) gateCounts[i] = (gateCounts[i]! + 1) % 1000000;
      }
    }

    const surface: VideoNodeSurface = {
      fbo: outFbo,
      texture: outTexture,
      draw(frame) {
        const e = compiled;
        if (!e) return;
        tickGates();
        for (const pass of e.passes) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo(pass.target, e));
          gl.viewport(0, 0, ctx.res.width, ctx.res.height);
          gl.useProgram(pass.program);
          // Bind samplers.
          for (let i = 0; i < pass.samplers.length; i++) {
            const s = pass.samplers[i]!;
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, textureForSource(frame, s.source, e));
            if (s.loc) gl.uniform1i(s.loc, i);
          }
          setAllUniforms(pass, frame);
          ctx.drawFullscreenQuad();
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        // CLOCK EDGE (P1, design §4.3): swap each register's front↔back FBO so
        // the buffer JUST written this frame becomes next frame's `:prev` read.
        // Exchanging the {fbo,texture} entries under the two stable fbo ids means
        // next frame's targetFbo(front)/textureForSource(back) resolve to the
        // rotated buffers with no pass-binding rewrite. Pure, GL-free helper.
        if (e.registers.length) swapRegisters(e.fbos, e.registers);
      },
      dispose() {
        disposeEffect(compiled);
        compiled = null;
        gl.deleteFramebuffer(outFbo);
        gl.deleteTexture(outTexture);
        gl.deleteTexture(blackTex);
      },
    };

    /** Build a deterministic CPU preview snapshot for the card (independent of
     *  worker/main GL). v1 ships only smpte-bars; its preview is computed in JS
     *  from the same pattern math. Returns null for specs without a CPU preview
     *  (the card then shows a neutral placeholder). */
    function buildSnapshot(): ImageData | null {
      if (spec.id === 'smpte-bars') {
        const shift = cvRoleValue(1) * roleRangeHint('uShift');
        const bright = paramValueFor('uBrightness');
        const sat = paramValueFor('uSaturation');
        return renderSmpteSnapshot({ shift, brightness: bright, saturation: sat });
      }
      return null;
    }

    /** The mapped value of the spec param whose uniform == `uniform`. */
    function paramValueFor(uniform: string): number {
      const ps = (spec.params ?? []).find((p) => p.uniform === uniform);
      if (!ps) return 0;
      const knob = params[`p${ps.slot}`] ?? 0;
      return ps.min + knob * (ps.max - ps.min);
    }

    /** HOT-SWAP: re-resolve the spec from the live node.data.vfpga id and, if it
     *  changed, rebuild the GL pipeline (dispose old, build new). Idempotent
     *  when the id is unchanged. The card writes node.data.vfpga then pulses the
     *  `__reloadVfpga` synthetic param so this fires on BOTH the main handle AND
     *  (forwarded by the worker proxy's setParam) the worker-side node. */
    function reloadVfpga(): void {
      const next = resolveSpec(node);
      if (next.id === spec.id && compiled) return;
      spec = next;
      // Pull the live node.params (the card/graph mutator seeds the new spec's
      // param-slot defaults there on preset change) into the engine bag, then seed
      // any slot the node still hasn't set, so the swapped-in VFPGA renders with
      // its intended defaults immediately (not the host's inert 0).
      const live = livePatch.nodes[node.id];
      if (live?.params) Object.assign(params, live.params);
      seedSpecParamDefaults(spec, (live as ModuleNode | undefined) ?? node);
      const old = compiled;
      compiled = buildEffect(spec);
      disposeEffect(old);
    }

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        // `__reloadVfpga` is a synthetic hot-swap pulse (not a real param) — the
        // card writes node.data.vfpga then sets this to trigger a rebuild here
        // (and, via the worker proxy's setParam forward, on the worker node too).
        if (paramId === '__reloadVfpga') {
          reloadVfpga();
          return;
        }
        params[paramId] = value;
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        const e = compiled;
        if (!e) return undefined;
        // Per-port output texture (vout2 — vout1 is surface.texture).
        if (key === 'outputTexture:vout2') {
          return e.vout2Id ? textureForOutputId(e.vout2Id, e) : null;
        }
        if (key === 'outputTexture:vout1') {
          return textureForOutputId(e.vout1Id, e);
        }
        // CPU preview snapshot for the card.
        if (key === 'snapshot') return buildSnapshot();
        if (key === 'snapshotSize') return { width: SNAPSHOT_W, height: SNAPSHOT_H };
        // Live spec id (for card title / docs link).
        if (key === 'vfpga') return spec.id;
        // Per-gate held state (card activity LEDs).
        if (key === 'gateState') return gateEdges.map((g) => g.pressed);
        return undefined;
      },
      dispose() {
        surface.dispose();
      },
    };
  },
};
