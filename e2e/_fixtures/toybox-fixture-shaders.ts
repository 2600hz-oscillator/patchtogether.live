// e2e/_fixtures/toybox-fixture-shaders.ts
//
// THE DETERMINISTIC FIXTURE-SHADER PACK (#2070) — trivial, time-INVARIANT
// GLSL loaded AS DATA through the product's own custom-shader seam, so the
// layering / locks / randomize / undo / editor-binding e2e can assert EXACT
// compositing arithmetic instead of perceptual floors, and run fast under
// SwiftShader.
//
// ── Why this is data, not product code (#2070 constraint 1) ────────────────
// Every entry is a manifest-shaped `ToyboxContent` whose `glsl` is a `data:`
// URL. `getContent()` fetches `meta.glsl` with a plain `fetch()`, which
// resolves data: URLs natively — so a registered fixture rides the ENTIRE
// bundled-content path (dropdown, lazy fetch, program cache, randomize
// pools) with zero product changes and nothing servable to players. The pack
// enters the page at runtime through the harness-only
// `__toyboxRegisterFixtureContent` hook (+layout.svelte, testHooksEnabled-
// gated), which validates each entry through the REAL compile probe
// (`validateToyboxShader`) before registering it in the runtime provider.
// Verified empirically: `task webgl:attest:check` reproduces the same
// content hash before and after this pack existed.
//
// ── Why the shaders look like this ─────────────────────────────────────────
// Bundled-content convention (caustic-pool et al.): SHADERTOY single-pass
// (`mainImage`), bare param identifiers, declarations injected by the engine
// from `params[]`. NO entry reads iTime — every fixture is a pure function
// of (uv, params), so any two frames are byte-identical by construction and
// a single-frame read IS the steady state.

/** One RGB triple in 0..1 space (shader-side units). */
export type Rgb01 = readonly [number, number, number];

/** Manifest-shaped content entry (structurally ToyboxContent — typed locally
 *  so e2e does not import product source). */
export interface FixtureContent {
  id: string;
  label: string;
  family: 'GEN' | 'FX' | 'FRAG';
  glsl: string;
  shadertoy: true;
  input?: 'none' | 'scene';
  params: Array<{
    id: string;
    label: string;
    min: number;
    max: number;
    default: number;
    curve: 'linear';
  }>;
}

const dataUrl = (src: string): string =>
  'data:text/plain;charset=utf-8,' + encodeURIComponent(src);

const param = (id: string, def: number, min = 0, max = 1) => ({
  id,
  label: id.toUpperCase(),
  min,
  max,
  default: def,
  curve: 'linear' as const,
});

/** FLAT: every pixel is exactly (fr, fg, fb). The atom of exact-compositing
 *  assertions — a fade/over/map of two flats is a computable constant. */
export const FIX_FLAT: FixtureContent = {
  id: 'e2e-fix-flat',
  label: 'E2E FLAT',
  family: 'GEN',
  shadertoy: true,
  params: [param('fr', 1), param('fg', 0), param('fb', 0)],
  glsl: dataUrl(`// e2e fixture: flat color (time-invariant by construction)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(fr, fg, fb, 1.0);
}
`),
};

/** GRADIENT: R = uv.x, G = uv.y, B = gb. Position is IN the pixel value, so
 *  orientation / tiling / mirroring / displacement have computable
 *  signatures, and the canvas Y-orientation is measurable, not assumed. */
export const FIX_GRADIENT: FixtureContent = {
  id: 'e2e-fix-gradient',
  label: 'E2E GRADIENT',
  family: 'GEN',
  shadertoy: true,
  params: [param('gb', 0)],
  glsl: dataUrl(`// e2e fixture: uv coordinate gradient (time-invariant)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv.x, uv.y, gb, 1.0);
}
`),
};

/** CHECKER: `cells`^2 black/white board. Structure-through-pixels for the
 *  tile/mirror/displace op family. */
export const FIX_CHECKER: FixtureContent = {
  id: 'e2e-fix-checker',
  label: 'E2E CHECKER',
  family: 'GEN',
  shadertoy: true,
  params: [param('cells', 4, 1, 16)],
  glsl: dataUrl(`// e2e fixture: checkerboard (time-invariant)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float c = mod(floor(uv.x * cells) + floor(uv.y * cells), 2.0);
  fragColor = vec4(vec3(c), 1.0);
}
`),
};

/** FRAG INVERT: 1 - scene. Proves the FRAG (scene-input) chain with exact
 *  arithmetic: invert of a flat (r,g,b) is (1-r, 1-g, 1-b). */
export const FIX_FRAG_INVERT: FixtureContent = {
  id: 'e2e-fix-frag-invert',
  label: 'E2E FRAG INVERT',
  family: 'FRAG',
  shadertoy: true,
  input: 'scene',
  params: [],
  glsl: dataUrl(`// e2e fixture: invert the scene input (time-invariant)
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec3 s = texture(iChannel0, uv).rgb;
  fragColor = vec4(1.0 - s, 1.0);
}
`),
};

/** The whole pack, iterable (derived membership — no counts anywhere). */
export const TOYBOX_FIXTURE_PACK: readonly FixtureContent[] = [
  FIX_FLAT,
  FIX_GRADIENT,
  FIX_CHECKER,
  FIX_FRAG_INVERT,
];

// ── Exact compositing arithmetic (ONE place, mirroring COMBINE_FRAG_SRC) ───
//
// These mirror the engine's combine shader (modules/toybox.ts,
// COMBINE_FRAG_SRC) for OPAQUE inputs (every fixture writes alpha 1), so
// specs COMPUTE their expected pixels instead of hand-typing them. If the
// engine's op math changes, the fixture assertions change with these — the
// disagreement surfaces as a pixel diff, which is the point.

/** FADE (uOp 0): `mix(base, top, amount * top.a)`; opaque top ⇒ plain mix. */
export function expectedFade(base: Rgb01, top: Rgb01, amount: number): Rgb01 {
  const k = Math.min(1, Math.max(0, amount));
  return [0, 1, 2].map((i) => base[i]! + (top[i]! - base[i]!) * k) as unknown as Rgb01;
}

/** OVER (uOp 4): premultiplied source-over with amount scaling source alpha;
 *  for OPAQUE base and top this reduces to the same mix as FADE
 *  (out = t*sa + b*(1-sa), oa = 1). */
export function expectedOver(base: Rgb01, top: Rgb01, opacity: number): Rgb01 {
  return expectedFade(base, top, opacity);
}

/** MAP (uOp 3): multiply (mode 0) / screen (mode 1), mixed by amount. */
export function expectedMap(
  base: Rgb01,
  top: Rgb01,
  amount: number,
  mode: 'multiply' | 'screen',
): Rgb01 {
  const k = Math.min(1, Math.max(0, amount));
  return [0, 1, 2].map((i) => {
    const m = mode === 'screen' ? 1 - (1 - base[i]!) * (1 - top[i]!) : base[i]! * top[i]!;
    return base[i]! + (m - base[i]!) * k;
  }) as unknown as Rgb01;
}

// ── Whole-graph fold (graph-structure-through-pixels, #2070 migration) ──────
//
// Evaluate a rolled combine graph over FIXTURE-FLAT layers to ONE exact
// color: sources resolve to their flat params, 2-input blends apply the op
// math above, and spatial 1-input ops (tile/mirror) are IDENTITY on a
// uniform field. Returns null when the graph contains anything it cannot
// compute — the caller treats that as "re-pin the seed", never as a pass.

const glslSmoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** LUMAKEY (uOp 1) for OPAQUE flats: keep = smoothstep(a-soft, a+soft+1e-4,
 *  luma(top)), inverted when invert > 0.5; out = mix(base, top, keep). */
export function expectedLumakey(
  base: Rgb01,
  top: Rgb01,
  amount: number,
  soft: number,
  invert: number,
): Rgb01 {
  const a = Math.min(1, Math.max(0, amount));
  const s = Math.max(0, soft);
  const l = 0.299 * top[0]! + 0.587 * top[1]! + 0.114 * top[2]!;
  let keep = glslSmoothstep(a - s, a + s + 0.0001, l);
  if (invert > 0.5) keep = 1 - keep;
  return [0, 1, 2].map((i) => base[i]! + (top[i]! - base[i]!) * keep) as unknown as Rgb01;
}

interface FoldNode {
  id: string;
  kind: string;
  layer?: number;
  params?: Record<string, number>;
}
interface FoldEdge {
  from: string;
  to: string;
  toPort: string;
}

/**
 * Fold a combine graph over flat layers to the exact OUT color, or null when
 * any wired layer is not a FIX_FLAT or any op is outside the computable set.
 * `layers` is the applied blob's layer array (flat colors read off each
 * layer's own params — DERIVED from the artifact, never hand-typed).
 */
export function foldComputableGraph(
  combine: { nodes: FoldNode[]; edges: FoldEdge[] },
  layers: Array<{ kind: string; contentId?: string | null; params?: Record<string, number> }>,
): Rgb01 | null {
  const byId = new Map(combine.nodes.map((n) => [n.id, n] as const));
  const memo = new Map<string, Rgb01 | null>();
  const evalNode = (id: string, stack: Set<string>): Rgb01 | null => {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return null; // same-frame cycle — not computable
    stack.add(id);
    const n = byId.get(id);
    let out: Rgb01 | null = null;
    if (!n) out = null;
    else if (n.kind === 'source') {
      const layer = layers[n.layer ?? -1];
      if (layer && layer.kind === 'gen' && layer.contentId === FIX_FLAT.id) {
        const p = layer.params ?? {};
        out = [p.fr ?? 1, p.fg ?? 0, p.fb ?? 0];
      } else out = null;
    } else {
      const inbound = combine.edges.filter((e) => e.to === id);
      const inAt = (port: string): Rgb01 | null => {
        const e = inbound.find((x) => x.toPort === port);
        return e ? evalNode(e.from, stack) : null;
      };
      const p = n.params ?? {};
      if (n.kind === 'output') {
        out = inAt('in0');
      } else if (n.kind === 'tile' || n.kind === 'mirror') {
        // spatial rearrangement of a UNIFORM field is identity
        out = inAt('in0');
      } else if (n.kind === 'fade' || n.kind === 'over') {
        const b = inAt('in0');
        const t = inAt('in1');
        out = b && t ? expectedFade(b, t, p.amount ?? 1) : null;
      } else if (n.kind === 'map') {
        const b = inAt('in0');
        const t = inAt('in1');
        out =
          b && t
            ? expectedMap(b, t, p.amount ?? 1, (p.mode ?? 0) > 0.5 ? 'screen' : 'multiply')
            : null;
      } else if (n.kind === 'lumakey') {
        const b = inAt('in0');
        const t = inAt('in1');
        out = b && t ? expectedLumakey(b, t, p.amount ?? 0.5, p.soft ?? 0.1, p.invert ?? 0) : null;
      } else {
        out = null; // non-computable op kind — caller re-pins the seed
      }
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  const outNode = combine.nodes.find((n) => n.kind === 'output');
  return outNode ? evalNode(outNode.id, new Set()) : null;
}

/** Per-channel tolerance for a CHAINED fold (two+ ops, one RGBA8 store per
 *  intermediate FBO), canvas bytes. */
export const CHAIN_TOLERANCE = 5;

/** 0..1 → 0..255 (the canvas byte the probe reads). */
export function toBytes(c: Rgb01): [number, number, number] {
  return [Math.round(c[0]! * 255), Math.round(c[1]! * 255), Math.round(c[2]! * 255)];
}

/** Per-channel tolerance for a FLAT-color assertion, canvas bytes: RGBA8
 *  quantisation in the FBO + the preview drawImage resample. Flat fields
 *  resample to themselves, so this stays tight. */
export const FLAT_TOLERANCE = 3;

/** Per-channel tolerance for a GRADIENT sample, canvas bytes: the 200×150
 *  preview downscales the engine FBO, so a gradient pixel is a small
 *  neighbourhood average — wider than FLAT, still far tighter than any
 *  perceptual floor. */
export const GRADIENT_TOLERANCE = 8;
