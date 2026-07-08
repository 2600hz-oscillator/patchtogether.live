// packages/web/src/lib/video/modules/lushgarden-scene.ts
//
// LUSH GARDEN — pure scene / spawn / layout math for the lushgarden video
// generator. Everything here is deterministic + GL-free so the unit suite
// can pin the whole placement model without a WebGL context (same split as
// shapegen-math.ts / spirographs-math.ts). The GL factory (lushgarden.ts)
// consumes these helpers verbatim.
//
// SCENE MODEL
//   • A virtual GROUND PLANE runs from the bottom edge of the frame up to a
//     HORIZON line at `horizon` (0..1, fraction of frame height from the
//     bottom). THE HORIZON IS INVISIBLE — it is placement geometry only
//     (the ceiling for far-plant anchors + the perspective scale gradient);
//     no output ever draws a line/gradient/ground fill at it.
//   • Plants spawn at a random (worldX, depth). depth ∈ [0,1] maps the
//     plant's ground anchor linearly from the bottom edge (near, depth 0)
//     to the horizon (far, depth 1), and scales the sprite down with
//     distance (lerp 1 → FAR_SCALE — the perspective gradient).
//   • Painter's algorithm: render far → near (sortPlantsForRender).
//   • The world is WIDER than the frame (WORLD_WIDTH frame-widths at the
//     near plane). `view` (0..1) pans a virtual viewport across it; a
//     plant's screen-x shift is proportional to its PARALLAX FACTOR
//     (near = 1, far = FAR_PARALLAX), which is the deliberate "weird 2D
//     parallax" — near plants sweep past while the far rank barely moves.
//     Each depth's SPAWNABLE world width shrinks by the same factor
//     (effectiveWorldWidth), so every plant is reachable at some view and
//     on-screen density stays flat across depth.
//   • Sprite cap: PLANT_CAP. At the cap a new spawn REPLACES THE OLDEST
//     plant (lowest serial) so the garden keeps evolving instead of
//     freezing — the oldest flower "dies" and the new one grows in.
//
// SPAWNING
//   • Continuous mode: `rate` spawns/sec (RATE_MIN..RATE_MAX, log-feel
//     knob) via a fractional accumulator (stepSpawner) — dt-driven so the
//     schedule follows engine time (and an engine-frozen frame, dt = 0,
//     spawns nothing — VRT determinism).
//   • Gated mode: when the `grow` gate input is PATCHED, rate-spawning
//     stops entirely and exactly ONE plant spawns per rising edge (the
//     factory's gateEdge detector feeds spawns through here).

// ---------------------------------------------------------------------------
// Manifest contract
// ---------------------------------------------------------------------------

export type PlantKind = 'flower' | 'bush' | 'tree';

/** One cutout in the atlas manifest (static/lushgarden/manifest.json). */
export interface LushgardenManifestEntry {
  id: string;
  file: string;
  kind: PlantKind;
  /** Source image pixel dims (drives the sprite aspect ratio). */
  w: number;
  h: number;
  /** True when the PNG carries a real alpha channel. */
  alpha: boolean;
  /** 'white' = flat white background to be keyed out at bake time. */
  matte: 'none' | 'white';
  license: string;
  author: string;
  title: string;
  sourcePage: string;
}

const KINDS: readonly PlantKind[] = ['flower', 'bush', 'tree'];

/**
 * Parse + validate a fetched manifest.json payload. Tolerant: silently
 * DROPS malformed rows (wrong kind, non-positive dims, missing id/file)
 * rather than failing the whole atlas — one bad row must never kill the
 * module. Missing `matte` defaults to 'none', missing `alpha` to true
 * (the atlas contract says cutouts are alpha PNGs unless flagged).
 */
export function parseLushgardenManifest(json: unknown): LushgardenManifestEntry[] {
  if (!Array.isArray(json)) return [];
  const out: LushgardenManifestEntry[] = [];
  for (const raw of json) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const file = typeof r.file === 'string' ? r.file : '';
    const kind = r.kind as PlantKind;
    const w = typeof r.w === 'number' ? r.w : 0;
    const h = typeof r.h === 'number' ? r.h : 0;
    if (!id || !file || !KINDS.includes(kind) || !(w > 0) || !(h > 0)) continue;
    out.push({
      id,
      file,
      kind,
      w,
      h,
      alpha: typeof r.alpha === 'boolean' ? r.alpha : true,
      matte: r.matte === 'white' ? 'white' : 'none',
      license: typeof r.license === 'string' ? r.license : '',
      author: typeof r.author === 'string' ? r.author : '',
      title: typeof r.title === 'string' ? r.title : '',
      sourcePage: typeof r.sourcePage === 'string' ? r.sourcePage : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tuning constants (single source of truth — the def + card import these)
// ---------------------------------------------------------------------------

/** Atlas canonical sprite heights per kind, in pixels of the 768-tall engine
 *  frame at the NEAR plane (depth 0, fully grown). The atlas encodes the
 *  tree > bush > flower relative scale through these. */
export const KIND_CANONICAL_HEIGHT: Record<PlantKind, number> = {
  flower: 256,
  bush: 416,
  tree: 560,
};

/** The engine frame height the canonical heights are expressed against. */
export const CANONICAL_FRAME_H = 768;

/** Spawn kind mix: ~70% flower / 20% bush / 10% tree. */
export const SPAWN_MIX: Record<PlantKind, number> = {
  flower: 0.7,
  bush: 0.2,
  tree: 0.1,
};

/** Hard sprite cap. At the cap, a new spawn replaces the OLDEST plant. */
export const PLANT_CAP = 350;

/** World width at the near plane, in frame-widths. */
export const WORLD_WIDTH = 2.5;

/** Grow-in duration (seconds): quick ease-out scale-up from the ground anchor. */
export const GROW_IN_S = 0.35;

/** Perspective scale at the horizon (depth 1). Near plane (depth 0) = 1. */
export const FAR_SCALE = 0.22;

/** Fraction of the view pan applied to a plant AT the horizon (depth 1).
 *  Near-plane plants (depth 0) get the full pan. */
export const FAR_PARALLAX = 0.2;

/** Spawn-rate knob range (spawns/sec) + default. Log-curve knob. */
export const RATE_MIN = 0.5;
export const RATE_MAX = 10;
export const RATE_DEFAULT = 2;

/** Default horizon (fraction of frame height from the bottom). */
export const HORIZON_DEFAULT = 0.65;

/** Default view pan (0..1, centered). */
export const VIEW_DEFAULT = 0.5;

/** Rate-spawn burst clamp: max spawns processed per frame, so a tab
 *  suspend / long stall can't dump a backlog burst on resume. */
export const MAX_SPAWNS_PER_FRAME = 4;

/** dt clamp (seconds) — same stall guard for the accumulator itself. */
export const MAX_FRAME_DT_S = 0.5;

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — VRT/tests seed it; the factory uses a
// fixed seed so a frozen-time engine renders a reproducible garden.
// ---------------------------------------------------------------------------

export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map one uniform sample to a plant kind per SPAWN_MIX
 *  (< .7 flower, < .9 bush, else tree). */
export function pickKind(r: number): PlantKind {
  if (r < SPAWN_MIX.flower) return 'flower';
  if (r < SPAWN_MIX.flower + SPAWN_MIX.bush) return 'bush';
  return 'tree';
}

// ---------------------------------------------------------------------------
// Scene state
// ---------------------------------------------------------------------------

export interface Plant {
  /** Monotonic spawn serial — the replacement policy evicts the LOWEST. */
  serial: number;
  entryId: string;
  kind: PlantKind;
  /** Sprite aspect ratio (entry w / h). */
  aspect: number;
  /** World-x in frame-width units, within [0, effectiveWorldWidth(depth)). */
  worldX: number;
  /** 0 = near (bottom edge) … 1 = far (at the horizon). */
  depth: number;
  /** Engine-time (s) the plant spawned — drives the grow-in. */
  bornAt: number;
  /** Engine-time (s) the plant's textures first became renderable, or null.
   *  The renderer stamps this so a slow image fetch still gets its full
   *  grow-in animation instead of popping in fully grown. */
  visibleAt: number | null;
  /** Per-plant psychedelic hue phase offset (0..1). */
  phase: number;
}

export interface SceneState {
  plants: Plant[];
  nextSerial: number;
}

export function createScene(): SceneState {
  return { plants: [], nextSerial: 1 };
}

/** Parallax factor for a depth: 1 at the near plane, FAR_PARALLAX at the
 *  horizon. Multiplies BOTH the view pan and the spawnable world width. */
export function parallaxFactor(depth: number): number {
  const d = clamp01(depth);
  return 1 - d * (1 - FAR_PARALLAX);
}

/** The spawnable world width (frame-widths) at a depth: the visible frame
 *  (1) plus the pannable overflow scaled by that depth's parallax factor —
 *  so view=0 shows the left edge and view=1 the right edge of EVERY rank. */
export function effectiveWorldWidth(depth: number): number {
  return 1 + (WORLD_WIDTH - 1) * parallaxFactor(depth);
}

/**
 * Spawn one plant. Picks kind by SPAWN_MIX, an entry of that kind uniformly
 * (falling back to the whole atlas if the kind bucket is empty), a random
 * (worldX, depth) and a hue phase. At PLANT_CAP the OLDEST plant (lowest
 * serial) is evicted first. Returns the new plant, or null when the
 * manifest has no usable entries.
 */
export function spawnPlant(
  state: SceneState,
  entries: readonly LushgardenManifestEntry[],
  rng: () => number,
  now: number,
): Plant | null {
  if (entries.length === 0) return null;
  const kind = pickKind(rng());
  let bucket = entries.filter((e) => e.kind === kind);
  if (bucket.length === 0) bucket = [...entries];
  const entry = bucket[Math.min(bucket.length - 1, Math.floor(rng() * bucket.length))]!;
  const depth = rng();
  const worldX = rng() * effectiveWorldWidth(depth);
  const plant: Plant = {
    serial: state.nextSerial++,
    entryId: entry.id,
    kind: entry.kind,
    aspect: entry.w / entry.h,
    worldX,
    depth,
    bornAt: now,
    visibleAt: null,
    phase: rng(),
  };
  if (state.plants.length >= PLANT_CAP) {
    // Replace the OLDEST (lowest serial) so the garden keeps evolving.
    let oldestIdx = 0;
    for (let i = 1; i < state.plants.length; i++) {
      if (state.plants[i]!.serial < state.plants[oldestIdx]!.serial) oldestIdx = i;
    }
    state.plants.splice(oldestIdx, 1);
  }
  state.plants.push(plant);
  return plant;
}

/** Reset: clear every plant (the `reset` trigger). Serial keeps counting. */
export function resetScene(state: SceneState): void {
  state.plants.length = 0;
}

// ---------------------------------------------------------------------------
// Spawn scheduler (continuous mode)
// ---------------------------------------------------------------------------

export interface SpawnScheduler {
  /** Fractional spawn accumulator. */
  acc: number;
}

export function createSpawnScheduler(): SpawnScheduler {
  return { acc: 0 };
}

/**
 * Advance the continuous spawner by one frame. Returns how many plants to
 * spawn THIS frame (0..MAX_SPAWNS_PER_FRAME).
 *
 *   • `gated` (the `grow` input is patched) → always 0; edge-driven spawns
 *     bypass this scheduler entirely.
 *   • dt is clamped to MAX_FRAME_DT_S and the accumulator saturates at the
 *     per-frame burst cap, so a suspended tab resumes calmly.
 *   • dt = 0 (engine-frozen frame) → 0 — deterministic captures hold still.
 */
export function stepSpawner(
  sched: SpawnScheduler,
  dtSec: number,
  rateHz: number,
  gated: boolean,
): number {
  if (gated) {
    sched.acc = 0;
    return 0;
  }
  const dt = Math.max(0, Math.min(MAX_FRAME_DT_S, dtSec));
  const rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rateHz));
  sched.acc += dt * rate;
  let n = Math.floor(sched.acc);
  sched.acc -= n;
  if (n > MAX_SPAWNS_PER_FRAME) {
    n = MAX_SPAWNS_PER_FRAME;
    sched.acc = 0; // drop the backlog — no post-stall burst
  }
  return n;
}

// ---------------------------------------------------------------------------
// Grow-in + layout
// ---------------------------------------------------------------------------

/** Ease-out-cubic grow-in factor for a plant age (seconds). 0 → 0, ≥GROW_IN_S → 1. */
export function growFactor(ageSec: number): number {
  const t = clamp01(ageSec / GROW_IN_S);
  const u = 1 - t;
  return 1 - u * u * u;
}

export interface LayoutParams {
  /** Horizon height, fraction of frame height from the bottom (0..1). */
  horizon: number;
  /** View pan 0..1 across the pannable overflow. */
  view: number;
  /** Engine time (seconds) — drives the grow-in. */
  now: number;
  /** Engine render resolution. */
  resW: number;
  resH: number;
}

/** A sprite rect in BOTTOM-LEFT-origin pixels (GL viewport convention). */
export interface PlantRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute a plant's on-screen rect. The ground anchor (rect bottom-center)
 * sits at y = depth·horizon·resH; height = canonical kind height (scaled to
 * the engine frame) × perspective (lerp 1 → FAR_SCALE over depth) × grow-in;
 * x pans with the depth-scaled view offset (the parallax). The grow-in
 * scales the sprite UP FROM THE GROUND ANCHOR (bottom stays planted, width
 * grows about the center).
 *
 * Returns null when the plant is fully off-screen at this view (caller
 * skips the draw) or not grown at all yet.
 */
export function layoutPlant(plant: Plant, p: LayoutParams): PlantRect | null {
  const grownAt = plant.visibleAt ?? plant.bornAt;
  const g = growFactor(p.now - grownAt);
  if (g <= 0) return null;

  const persp = 1 - clamp01(plant.depth) * (1 - FAR_SCALE);
  const hPx = KIND_CANONICAL_HEIGHT[plant.kind] * (p.resH / CANONICAL_FRAME_H) * persp * g;
  const wPx = hPx * plant.aspect;
  if (hPx < 1 || wPx < 1) return null;

  const pan = clamp01(p.view) * (WORLD_WIDTH - 1) * parallaxFactor(plant.depth);
  const centerXFrac = plant.worldX - pan;
  const cx = centerXFrac * p.resW;
  if (cx + wPx / 2 <= 0 || cx - wPx / 2 >= p.resW) return null;

  const anchorY = clamp01(plant.depth) * clamp01(p.horizon) * p.resH;
  return {
    x: Math.round(cx - wPx / 2),
    y: Math.round(anchorY),
    w: Math.max(1, Math.round(wPx)),
    h: Math.max(1, Math.round(hPx)),
  };
}

/**
 * Painter's-algorithm render order: FAR first (depth descending), so near
 * plants composite over far ones. Ties break on serial (older first) for a
 * stable, deterministic order. Returns a NEW array; input untouched.
 */
export function sortPlantsForRender(plants: readonly Plant[]): Plant[] {
  return [...plants].sort((a, b) => b.depth - a.depth || a.serial - b.serial);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
