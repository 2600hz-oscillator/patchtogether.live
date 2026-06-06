// packages/web/src/lib/video/toybox-surface.ts
//
// TOYBOX Phase-6 texmap — PURE helpers for the OBJ "surface texture from another
// layer" feature. No GL, no DOM, no Yjs: just the dependency-aware render-order
// resolution + the per-layer "is this surface source SAFE to sample this frame"
// guard. Lives outside the module factory so it unit-tests in jsdom and the GL
// pass (modules/toybox.ts) consumes its verdicts.
//
// The feature lets an OBJ layer sample ANOTHER layer's rendered FBO as a
// UV-mapped surface texture (material.surfaceSource = that layer index). The
// constraint is render ORDER: surface.draw() renders layers in a loop, and an
// OBJ in layer N sampling layer M's FBO needs M rendered FIRST. We compute a
// per-frame topological render order from the surfaceSource dependency edges,
// dropping any edge that would form a cycle (incl. self-reference, which is a
// WebGL feedback loop) so the OBJ degrades to matcap-only rather than reading
// the FBO it is currently writing.

import { LAYER_COUNT, type ToyboxLayer } from './toybox-content';
import {
  LAYER_INPUT_SOURCE,
  isCombineGraph,
  type ToyboxCombineGraph,
} from './toybox-combine-graph';

/** A layer's resolved surface-source intent, defensively normalised from the
 *  raw (possibly pre-feature / malformed) material.surfaceSource. */
export interface SurfaceIntent {
  /** The validated in-range, non-self source layer index, or -1 = none. */
  source: number;
}

/**
 * Read layer `i`'s render-dependency source defensively: the OTHER layer whose
 * rendered FBO this layer needs as an input THIS frame. Two cases:
 *   - 'obj' with material.surfaceSource: the texmap source layer.
 *   - 'frag': a Shadertoy FRAG layer receives the COMPOSITED LAYER BELOW (index
 *     i-1) as iChannel0 — so it depends on i-1 being rendered first.
 *
 * Returns the source layer index ONLY if it is a finite in-range number that is
 * NOT the layer's own index (self-reference is a WebGL feedback loop → rejected).
 * Everything else (undefined / -1 / NaN / out-of-range / self / layer 0 frag) →
 * -1 (no input / matcap-only).
 */
export function readSurfaceSource(layers: ToyboxLayer[], i: number): number {
  const layer = layers[i];
  if (!layer) return -1;
  // FRAG layer: its scene input is the layer directly below (i-1).
  if (layer.kind === 'frag') {
    const src = i - 1;
    if (src < 0 || src >= LAYER_COUNT) return -1; // layer 0 has nothing below
    return src;
  }
  if (layer.kind !== 'obj') return -1;
  const raw = layer.material?.surfaceSource;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return -1;
  const src = Math.trunc(raw);
  if (src < 0 || src >= LAYER_COUNT) return -1;
  if (src === i) return -1; // self-reference → matcap-only (no feedback loop)
  return src;
}

export interface RenderOrderResult {
  /** The layer indices in the order they should be RENDERED this frame. Always
   *  a permutation of 0..LAYER_COUNT-1 (every layer still renders into its own
   *  FBO; only the SEQUENCE changes). */
  order: number[];
  /** Per-layer (by TRUE index): the safe surface-source index to sample, or -1
   *  if none / unsafe (cycle, out-of-range, self, or not orderable-before). The
   *  GL pass uses this verbatim: -1 → uUseSurface=0 (matcap only). */
  safeSource: number[];
}

/**
 * Compute a per-frame render order + the safe surface-source per layer.
 *
 * Dependency edge M→N iff layer N is 'obj' AND readSurfaceSource(N) = M (a
 * valid in-range non-self index). We topo-order the layers (Kahn) so every
 * consumer renders AFTER its source. If the surfaceSource edges form a cycle
 * (incl. a 2-cycle A↔B), the cycle members are dropped from the ordered prefix
 * and their safeSource is forced to -1 (matcap-only) — so a layer can never
 * read an FBO that hasn't been produced yet this frame, and a cycle degrades
 * gracefully instead of deadlocking.
 *
 * A source is "safe" for consumer N iff it was ORDERED STRICTLY BEFORE N in the
 * resolved order (so its FBO is finished when N's OBJ pass binds it). Whether
 * the source layer actually PRODUCED content is decided at render time (the GL
 * pass binds the source texture regardless and only flips uUseSurface on when
 * it drew); here we only resolve ORDER + cycle safety.
 */
export function resolveRenderOrder(layers: ToyboxLayer[]): RenderOrderResult {
  const n = Math.min(LAYER_COUNT, layers.length);
  // dep[N] = M means N depends on (must render after) M.
  const dep: number[] = [];
  for (let i = 0; i < n; i++) dep[i] = readSurfaceSource(layers, i);

  // Kahn topo-sort over the dependency edges M→N. indeg[N] = 1 if N has a dep.
  const indeg: number[] = new Array(n).fill(0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const m = dep[i];
    if (m >= 0 && m < n) {
      indeg[i] = (indeg[i] ?? 0) + 1;
      adj[m]!.push(i);
    }
  }
  // Seed the queue with every zero-indegree layer in ascending index order
  // (deterministic). Process Kahn, appending freed layers in ascending order.
  const order: number[] = [];
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if ((indeg[i] ?? 0) === 0) queue.push(i);
  queue.sort((a, b) => a - b);
  const placed: boolean[] = new Array(n).fill(false);
  // kahnPlaced[N] = N was ordered by Kahn (its full dependency chain resolved),
  // as opposed to being appended below as a cycle member. Only Kahn-placed
  // layers may carry a safe surface source — a cycle member (and anything that
  // depends on one) must fall back to matcap regardless of where it lands in the
  // append order, so a 2-cycle A↔B can't have B read A just because B was
  // appended after A.
  const kahnPlaced: boolean[] = new Array(n).fill(false);
  // positionOf[N] = index of N within `order` once placed (for the strict
  // before-check); -1 until placed.
  const positionOf: number[] = new Array(n).fill(-1);
  while (queue.length) {
    const cur = queue.shift()!;
    positionOf[cur] = order.length;
    order.push(cur);
    placed[cur] = true;
    kahnPlaced[cur] = true;
    const freed: number[] = [];
    for (const nxt of adj[cur] ?? []) {
      indeg[nxt] = (indeg[nxt] ?? 0) - 1;
      if ((indeg[nxt] ?? 0) === 0) freed.push(nxt);
    }
    freed.sort((a, b) => a - b);
    for (const f of freed) queue.push(f);
  }
  // Any layer NOT placed is part of a cycle (incl. self via readSurfaceSource
  // already excluding self, so only 2+ cycles reach here). Append them in
  // ascending index order so EVERY layer still renders into its FBO — they just
  // can't safely use their surface source (kahnPlaced stays false).
  for (let i = 0; i < n; i++) {
    if (!placed[i]) {
      positionOf[i] = order.length;
      order.push(i);
      placed[i] = true;
    }
  }

  // safeSource[N] = dep[N] iff BOTH N and dep[N] were Kahn-placed (so neither is
  // in a cycle) AND dep[N] was ordered STRICTLY BEFORE N (its FBO is ready).
  // Requiring Kahn-placement on both ends is what makes a 2-cycle degrade BOTH
  // sides to matcap rather than letting the later-appended member read the
  // earlier one.
  const safeSource: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const m = dep[i];
    if (
      m >= 0 &&
      m < n &&
      kahnPlaced[i] &&
      kahnPlaced[m] &&
      positionOf[m] < positionOf[i]
    ) {
      safeSource[i] = m;
    } else {
      safeSource[i] = -1;
    }
  }

  return { order, safeSource };
}

// ---------------- LAYER INPUT (prev-frame OUT feedback tap) ----------------
//
// A texture-source param on layer `i` (OBJ material.surfaceSource, VIDEO
// videoSource, a FRAG scene input) can be set to the LAYER-INPUT sentinel,
// meaning "sample whatever node output is wired into this layer's SOURCE-node
// input port (src{i}.in0)". In Phase 1 that resolves to the PREVIOUS frame's OUT
// composite (outTexture — the only already-retained tap), so a post-feedback
// OUT -> SURFACE loop reads one frame late and is stable.
//
// The decision needs TWO conditions, AND-ed: (a) the layer's source param
// selects the sentinel, AND (b) the layer-i SOURCE node has a wired in0 edge
// (the explicit feedback tap). Either missing → false (pure no-op: the param
// falls through to MATCAP / below-layer / idle; an unwired in0 dot renders but is
// read by no render path).

/** True if a SOURCE node for layer `i` has a wired in0 (LAYER-INPUT tap) edge in
 *  the combine graph. The src{i} node is matched by its `layer` field (defaulting
 *  to a `src{i}` id only as a fallback), so a renamed/hand-authored source still
 *  resolves. PURE — no GL. */
export function layerHasInputEdge(combine: unknown, i: number): boolean {
  if (!isCombineGraph(combine)) return false;
  const g = combine as ToyboxCombineGraph;
  // The SOURCE node(s) emitting layer i (normally exactly one).
  const srcIds = new Set(
    g.nodes
      .filter((n) => n.kind === 'source' && (typeof n.layer === 'number' ? n.layer : 0) === i)
      .map((n) => n.id),
  );
  if (srcIds.size === 0) return false;
  return g.edges.some((e) => e.toPort === 'in0' && srcIds.has(e.to));
}

/** Does layer `i` want the LAYER INPUT (prev-frame OUT) tap as its texture
 *  source THIS frame? True iff the layer's source param selects the LAYER-INPUT
 *  sentinel AND the layer-i SOURCE node has a wired in0 edge. Pure; the GL pass
 *  binds outTexture (retained prev-frame OUT) when true.
 *
 *   - OBJ:   material.surfaceSource === LAYER_INPUT_SOURCE.
 *   - VIDEO: layer.videoSource === 'layerIn'.
 *   - FRAG:  a scene-input shader whose sceneInputSource === 'layer-input'
 *            (overrides the default below-layer iChannel0).
 *  Any other kind → false. */
export function layerInputWanted(layers: ToyboxLayer[], combine: unknown, i: number): boolean {
  const layer = layers[i];
  if (!layer) return false;
  let selected = false;
  if (layer.kind === 'obj') {
    selected = layer.material?.surfaceSource === LAYER_INPUT_SOURCE;
  } else if (layer.kind === 'video') {
    selected = layer.videoSource === 'layerIn';
  } else if (layer.kind === 'frag') {
    selected = layer.sceneInputSource === 'layer-input';
  } else {
    return false;
  }
  if (!selected) return false;
  return layerHasInputEdge(combine, i);
}
