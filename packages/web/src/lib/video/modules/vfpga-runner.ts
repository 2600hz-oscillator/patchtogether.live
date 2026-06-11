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
// Render: renderLocus 'worker' (every catalog VFPGA is pure-GL). The worker
// re-runs THIS factory; the card preview pulls a CPU snapshot (`read('snapshot')`)
// computed in JS from the active spec, independent of where GL runs.
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
} from '$lib/video/vfpga/types';
import { getVfpgaSpec, DEFAULT_VFPGA_ID, listVfpgaSpecs } from '$lib/video/vfpga/registry';
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
}

export const vfpgaRunnerDef: VideoModuleDef = {
  type: 'vfpgaRunner',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'vfpga-runner',
  category: 'sources',
  schemaVersion: 1,
  // Every catalog VFPGA is pure-GL with a DOM-free factory → eligible for the
  // off-main-thread render worker (flag-gated; default OFF → byte-identical).
  renderLocus: 'worker',
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
    ...VFPGA_GATE_PORTS.map((id, i) => ({
      id,
      type: 'gate' as const,
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

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const { fbo: outFbo, texture: outTexture } = ctx.createFbo();

    // ---- Live param state (flat numeric bag) ----
    const params: Record<string, number> = {};
    for (const p of vfpgaRunnerDef.params) params[p.id] = p.defaultValue;
    Object.assign(params, node.params ?? {});

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
      const fbos = new Map<string, { fbo: WebGLFramebuffer; texture: WebGLTexture }>();
      for (const f of s.effect.fbos ?? []) {
        if (f.kind === 'float' && ctx.createFloatFbo) {
          const { fbo, texture } = ctx.createFloatFbo();
          fbos.set(f.id, { fbo, texture });
        } else {
          const { fbo, texture } = ctx.createFbo();
          fbos.set(f.id, { fbo, texture });
        }
      }
      const passes: CompiledPass[] = s.effect.passes.map((pass) => {
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
        return { program, samplers, uniforms, target: pass.target };
      });
      return {
        passes,
        fbos,
        vout1Id: s.effect.outputs.vout1,
        vout2Id: s.effect.outputs.vout2 ?? null,
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
      // uTime / uResolution.
      const uT = pass.uniforms.get('uTime');
      if (uT) gl.uniform1f(uT, frame.time);
      const uR = pass.uniforms.get('uResolution');
      if (uR) gl.uniform2f(uR, ctx.res.width, ctx.res.height);
      // CV roles → their uniform (post scale+offset 0..1, then mapped to a
      // role-appropriate value: SHIFT-style roles want a 0..7-ish range; we
      // hand the raw 0..1 and let the spec's shader scale, EXCEPT we multiply
      // by a role-declared range hint baked into the uniform value below).
      for (const role of spec.cvRoles ?? []) {
        const loc = pass.uniforms.get(role.uniform);
        if (!loc) continue;
        gl.uniform1f(loc, cvRoleValue(role.slot) * roleRangeHint(role.uniform));
      }
      // Gate roles → held level + edge count uniforms.
      for (const role of spec.gateRoles ?? []) {
        if (role.heldUniform) {
          const loc = pass.uniforms.get(role.heldUniform);
          if (loc) gl.uniform1f(loc, gateEdges[role.slot - 1]!.pressed ? 1 : 0);
        }
        if (role.countUniform) {
          const loc = pass.uniforms.get(role.countUniform);
          if (loc) gl.uniform1f(loc, gateCounts[role.slot - 1]!);
        }
      }
      // Param slots → their uniform (the mapped value across [min,max]).
      for (const ps of spec.params ?? []) {
        const loc = pass.uniforms.get(ps.uniform);
        if (!loc) continue;
        const knob = params[`p${ps.slot}`] ?? 0; // 0..1 generic slot
        gl.uniform1f(loc, ps.min + knob * (ps.max - ps.min));
      }
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
