// packages/web/src/lib/video/modules/toybox.ts
//
// TOYBOX — swappable fragment-shader video source (Phase 1).
//
// The foundation of a planned 4-layer shader/video/OBJ compositor with a
// combine graph, CV targets, presets and a node editor. PHASE 1 ships ONE
// renderable layer (index 0) drawn straight to the module's output FBO:
//   - The layer picks a content entry from the bundled bank
//     (packages/web/static/toybox/*; see toybox-content.ts). GLSL is
//     fetched lazily from a static URL on selection (never JS-bundled).
//   - Each content shader uses the uniforms `iTime` (engine seconds),
//     `iResolution` (vec2) and its own declared float uniforms (the
//     manifest's per-content `params` — the single source of truth for the
//     card faders and later CV targets).
//
// Persistence: node.data.layers is a LAYER_COUNT (=4) array of
// { kind, contentId, params }. P1 only RENDERS index 0, but the persisted
// shape is already the 4-layer shape so Phase 2 (layers 1..3 + a combine
// pass) needs no migration. The card mutates patch.nodes[id].data.layers
// directly (rides Y.Doc out to rack-mates); the factory reads the LIVE node
// from the store each frame (the WAVECEL content pattern) so content/param
// edits take effect without an engine round-trip.
//
// Extension seam: the factory exposes a `renderLayer(i, time)` helper even
// though only i=0 runs in P1. Phase 2's combine pass will render layers
// 1..3 into their own FBOs via the same helper, then composite.
//
// Inputs:  (none in P1 — CV targets land in Phase 2)
// Outputs: out (video) — the rendered layer-0 frame.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface, VideoEngineContext } from '$lib/video/engine';
import { patch as livePatch } from '$lib/graph/store';
import {
  DEFAULT_CONTENT_ID,
  LAYER_COUNT,
  ensureToyboxCatalog,
  getContent,
  getContentMeta,
  makeDefaultLayers,
  type ToyboxLayer,
} from '$lib/video/toybox-content';

export const toyboxDef: VideoModuleDef = {
  type: 'toybox',
  palette: { top: 'Video modules', sub: 'Sources' },
  domain: 'video',
  label: 'TOYBOX',
  category: 'sources',
  schemaVersion: 1,
  inputs: [],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  // No numeric engine params — the content + per-layer float params live in
  // node.data.layers (non-numeric; the card writes them, the factory reads
  // the live node). The empty params array keeps the per-port / docs sweeps
  // happy (TOYBOX is a content-driven source, like WAVECEL's table choice).
  params: [],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const { fbo, texture } = ctx.createFbo();

    // Kick off the catalog load so getContentMeta() is populated for the
    // synchronous hot path. Fire-and-forget; draw() tolerates a not-yet-
    // resolved catalog (renders the fallback until a program is ready).
    void ensureToyboxCatalog();

    // ---- Compiled-program cache (keyed by contentId) ----
    interface CompiledShader {
      program: WebGLProgram;
      uTime: WebGLUniformLocation | null;
      uResolution: WebGLUniformLocation | null;
      /** Declared float-uniform locations, keyed by param id. */
      uParams: Map<string, WebGLUniformLocation | null>;
    }
    // contentId → compiled program (ready), or 'pending' while fetching, or
    // 'error' if compile/fetch failed (don't retry-spam). Absent = not yet
    // requested.
    const programs = new Map<string, CompiledShader>();
    const inflight = new Set<string>();
    const failed = new Set<string>();

    /** Ensure a compiled program exists for `contentId`. Async: fetches the
     *  GLSL (lazy, cached in toybox-content) + compiles + resolves uniform
     *  locations for the content's declared params. Idempotent per id. */
    function ensureProgram(contentId: string): void {
      if (programs.has(contentId) || inflight.has(contentId) || failed.has(contentId)) return;
      inflight.add(contentId);
      void (async () => {
        try {
          const { meta, glsl } = await getContent(contentId);
          const program = ctx.compileFragment(glsl);
          const uParams = new Map<string, WebGLUniformLocation | null>();
          for (const p of meta.params) {
            uParams.set(p.id, gl.getUniformLocation(program, p.id));
          }
          programs.set(contentId, {
            program,
            uTime: gl.getUniformLocation(program, 'iTime'),
            uResolution: gl.getUniformLocation(program, 'iResolution'),
            uParams,
          });
        } catch (err) {
          failed.add(contentId);
          console.warn(`[TOYBOX] content '${contentId}' failed to compile:`, err);
        } finally {
          inflight.delete(contentId);
        }
      })();
    }

    // Pre-warm the default content so a fresh node shows something ASAP.
    ensureProgram(DEFAULT_CONTENT_ID);

    /** Resolve the live layer array for THIS node from the store. Falls back
     *  to the captured node's data, then to a fresh default array. Always
     *  returns a LAYER_COUNT-length array (pads short persisted arrays). */
    function liveLayers(): ToyboxLayer[] {
      const live = livePatch.nodes[node.id];
      const raw =
        (live?.data?.layers as ToyboxLayer[] | undefined) ??
        (node.data?.layers as ToyboxLayer[] | undefined);
      if (!raw || raw.length === 0) return makeDefaultLayers();
      // Defensive: pad to LAYER_COUNT so index access is always safe.
      const out = raw.slice(0, LAYER_COUNT);
      while (out.length < LAYER_COUNT) out.push({ kind: 'shader', contentId: null, params: {} });
      return out;
    }

    /**
     * Render layer `i` into the bound framebuffer. P1 only ever calls this
     * for i=0 (into the output FBO). Phase 2 will call it per-layer into
     * per-layer FBOs before a combine pass — the seam is here now so that
     * lands without restructuring draw().
     *
     * Returns true if it actually drew (a compiled program was ready);
     * false if the layer is empty or its program isn't compiled yet (caller
     * leaves the framebuffer at its cleared state).
     */
    function renderLayer(i: number, layers: ToyboxLayer[], time: number): boolean {
      const layer = layers[i];
      if (!layer || !layer.contentId) return false;
      const contentId = layer.contentId;
      ensureProgram(contentId);
      const compiled = programs.get(contentId);
      if (!compiled) return false; // still fetching / errored → caller clears

      const g = gl;
      g.useProgram(compiled.program);
      if (compiled.uTime) g.uniform1f(compiled.uTime, time);
      if (compiled.uResolution) g.uniform2f(compiled.uResolution, ctx.res.width, ctx.res.height);

      // Per-param float uniforms: live layer value, else manifest default.
      const meta = getContentMeta(contentId);
      if (meta) {
        for (const p of meta.params) {
          const loc = compiled.uParams.get(p.id);
          if (!loc) continue;
          const v = layer.params?.[p.id];
          g.uniform1f(loc, typeof v === 'number' ? v : p.default);
        }
      }
      ctx.drawFullscreenQuad();
      return true;
    }

    // VRT determinism: when globalThis.__toyboxFreezeTime is a number, pin
    // iTime to it (ignore the engine clock) so the shader output is pixel-
    // stable for deterministic screenshots. Set via the card's
    // window.__toyboxFreeze(time) hook (and the VRT spec). null/undefined =
    // run live off the engine clock. Read fresh each frame so toggling the
    // freeze takes effect immediately.
    function frozenTime(): number | null {
      const g = globalThis as unknown as { __toyboxFreezeTime?: number | null };
      return typeof g.__toyboxFreezeTime === 'number' ? g.__toyboxFreezeTime : null;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        // Clear to opaque black so an empty / not-yet-compiled layer 0 reads
        // as black rather than stale garbage.
        g.clearColor(0, 0, 0, 1);
        g.clear(g.COLOR_BUFFER_BIT);

        const time = frozenTime() ?? frame.time;
        const layers = liveLayers();
        // P1: only layer 0 renders, straight into the output FBO. (Phase 2:
        // loop 0..LAYER_COUNT-1 into per-layer FBOs + a combine pass.)
        renderLayer(0, layers, time);

        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        for (const c of programs.values()) gl.deleteProgram(c.program);
        programs.clear();
      },
    };

    return {
      domain: 'video',
      surface,
      // No numeric engine params in P1 — content + per-layer floats live in
      // node.data. setParam/readParam are no-ops (kept for the handle shape).
      setParam() { /* no numeric params in P1 */ },
      readParam() { return undefined; },
      read(key) {
        if (key === 'fboTexture') return surface.texture;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
