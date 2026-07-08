// packages/web/src/lib/video/modules/lushgarden-scene.test.ts
//
// LUSH GARDEN — unit coverage for the pure scene math the GL factory
// consumes verbatim (lushgarden-scene.ts): manifest parsing (matte flags),
// spawn-kind mix, cap/replace-oldest, reset, the rate→interval spawn
// scheduler + its gated-mode switch, grow-in easing, the placement/
// perspective/parallax layout model, and the painter's depth sort.
// The GL side (baking, 4-output render, gate wiring) is covered by the
// bespoke e2e spec (e2e/tests/lushgarden.spec.ts).

import { describe, it, expect } from 'vitest';
import {
  parseLushgardenManifest,
  createRng,
  pickKind,
  createScene,
  spawnPlant,
  resetScene,
  createSpawnScheduler,
  stepSpawner,
  growFactor,
  layoutPlant,
  sortPlantsForRender,
  parallaxFactor,
  effectiveWorldWidth,
  PLANT_CAP,
  WORLD_WIDTH,
  GROW_IN_S,
  FAR_SCALE,
  FAR_PARALLAX,
  RATE_MIN,
  RATE_MAX,
  MAX_SPAWNS_PER_FRAME,
  KIND_CANONICAL_HEIGHT,
  CANONICAL_FRAME_H,
  SPAWN_MIX,
  type LushgardenManifestEntry,
  type LayoutParams,
} from './lushgarden-scene';

// ---- helpers --------------------------------------------------------------

function entry(id: string, kind: LushgardenManifestEntry['kind'], w = 200, h = 250,
  matte: 'none' | 'white' = 'none'): LushgardenManifestEntry {
  return { id, file: `${id}.png`, kind, w, h, alpha: matte === 'none', matte,
    license: 'CC0', author: 'test', title: id, sourcePage: '' };
}

const ATLAS: LushgardenManifestEntry[] = [
  entry('f1', 'flower'), entry('f2', 'flower', 180, 240, 'white'),
  entry('b1', 'bush', 360, 300), entry('t1', 'tree', 380, 560),
];

const RES = { resW: 1024, resH: 768 };

function baseLayout(over: Partial<LayoutParams> = {}): LayoutParams {
  return { horizon: 0.65, view: 0.5, now: 100, ...RES, ...over };
}

// ── manifest parser ─────────────────────────────────────────────────────────

describe('parseLushgardenManifest', () => {
  it('accepts well-formed rows and normalizes matte/alpha defaults', () => {
    const rows = parseLushgardenManifest([
      { id: 'a', file: 'a.png', kind: 'flower', w: 100, h: 120 },
      { id: 'b', file: 'b.png', kind: 'tree', w: 300, h: 500, alpha: false, matte: 'white',
        license: 'CC BY 2.0', author: 'x', title: 'T', sourcePage: 'http://x' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'a', matte: 'none', alpha: true });
    expect(rows[1]).toMatchObject({ id: 'b', matte: 'white', alpha: false, license: 'CC BY 2.0' });
  });

  it('drops malformed rows without failing the whole atlas', () => {
    const rows = parseLushgardenManifest([
      { id: 'ok', file: 'ok.png', kind: 'bush', w: 10, h: 10 },
      { id: '', file: 'x.png', kind: 'bush', w: 10, h: 10 },      // no id
      { id: 'k', file: 'k.png', kind: 'cactus', w: 10, h: 10 },   // bad kind
      { id: 'z', file: 'z.png', kind: 'tree', w: 0, h: 10 },      // bad dims
      'not-an-object',
      null,
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('returns [] for a non-array payload', () => {
    expect(parseLushgardenManifest({ nope: true })).toEqual([]);
    expect(parseLushgardenManifest(undefined)).toEqual([]);
  });
});

// ── kind mix ────────────────────────────────────────────────────────────────

describe('pickKind', () => {
  it('buckets per the 70/20/10 spawn mix', () => {
    expect(pickKind(0)).toBe('flower');
    expect(pickKind(SPAWN_MIX.flower - 1e-9)).toBe('flower');
    expect(pickKind(SPAWN_MIX.flower)).toBe('bush');
    expect(pickKind(SPAWN_MIX.flower + SPAWN_MIX.bush - 1e-9)).toBe('bush');
    expect(pickKind(SPAWN_MIX.flower + SPAWN_MIX.bush)).toBe('tree');
    expect(pickKind(0.999999)).toBe('tree');
  });

  it('seeded spawn stream approximates the mix', () => {
    const rng = createRng(0xbeef);
    const scene = createScene();
    const counts = { flower: 0, bush: 0, tree: 0 };
    for (let i = 0; i < 300; i++) {
      const p = spawnPlant(scene, ATLAS, rng, i * 0.01);
      expect(p).not.toBeNull();
      counts[p!.kind]++;
    }
    expect(counts.flower).toBeGreaterThan(300 * 0.55);
    expect(counts.bush).toBeGreaterThan(300 * 0.1);
    expect(counts.tree).toBeGreaterThan(300 * 0.03);
    expect(counts.tree).toBeLessThan(300 * 0.25);
  });
});

// ── spawn / cap / reset ─────────────────────────────────────────────────────

describe('spawnPlant', () => {
  it('returns null on an empty atlas', () => {
    const scene = createScene();
    expect(spawnPlant(scene, [], createRng(1), 0)).toBeNull();
    expect(scene.plants).toHaveLength(0);
  });

  it('assigns monotonically increasing serials and in-range placement', () => {
    const rng = createRng(7);
    const scene = createScene();
    for (let i = 0; i < 50; i++) spawnPlant(scene, ATLAS, rng, i);
    for (let i = 1; i < scene.plants.length; i++) {
      expect(scene.plants[i]!.serial).toBeGreaterThan(scene.plants[i - 1]!.serial);
    }
    for (const p of scene.plants) {
      expect(p.depth).toBeGreaterThanOrEqual(0);
      expect(p.depth).toBeLessThan(1);
      expect(p.worldX).toBeGreaterThanOrEqual(0);
      expect(p.worldX).toBeLessThan(effectiveWorldWidth(p.depth));
      expect(p.aspect).toBeGreaterThan(0);
      expect(p.visibleAt).toBeNull();
    }
  });

  it('falls back to the whole atlas when the picked kind bucket is empty', () => {
    const flowersOnly = [entry('f9', 'flower')];
    const rng = createRng(0xabad1dea);
    const scene = createScene();
    for (let i = 0; i < 40; i++) {
      const p = spawnPlant(scene, flowersOnly, rng, i);
      expect(p!.entryId).toBe('f9'); // trees/bushes picked → fall back to f9
    }
  });

  it('replaces the OLDEST plant at the cap (garden keeps evolving)', () => {
    const rng = createRng(3);
    const scene = createScene();
    for (let i = 0; i < PLANT_CAP; i++) spawnPlant(scene, ATLAS, rng, i);
    expect(scene.plants).toHaveLength(PLANT_CAP);
    const oldestSerial = Math.min(...scene.plants.map((p) => p.serial));

    const p = spawnPlant(scene, ATLAS, rng, 999);
    expect(scene.plants).toHaveLength(PLANT_CAP); // still capped
    expect(scene.plants.some((q) => q.serial === oldestSerial)).toBe(false); // oldest gone
    expect(scene.plants[scene.plants.length - 1]!.serial).toBe(p!.serial);   // newest present
  });

  it('resetScene clears all plants but keeps the serial counter', () => {
    const rng = createRng(5);
    const scene = createScene();
    for (let i = 0; i < 10; i++) spawnPlant(scene, ATLAS, rng, i);
    const nextBefore = scene.nextSerial;
    resetScene(scene);
    expect(scene.plants).toHaveLength(0);
    expect(scene.nextSerial).toBe(nextBefore);
    const p = spawnPlant(scene, ATLAS, rng, 11);
    expect(p!.serial).toBe(nextBefore);
  });
});

// ── spawn scheduler ─────────────────────────────────────────────────────────

describe('stepSpawner', () => {
  it('rate → interval: 2 Hz over ~3 simulated seconds of 60 fps ≈ 6 spawns', () => {
    // 183 frames = 3.05 s — the .05 s of headroom absorbs the float-
    // accumulation error of summing 1/60 per frame (the fractional
    // accumulator itself carries no systematic drift).
    const s = createSpawnScheduler();
    let spawned = 0;
    for (let i = 0; i < 183; i++) spawned += stepSpawner(s, 1 / 60, 2, false);
    expect(spawned).toBe(6);
  });

  it('clamps rate into [RATE_MIN, RATE_MAX]', () => {
    const lo = createSpawnScheduler();
    let n = 0;
    for (let i = 0; i < 612; i++) n += stepSpawner(lo, 1 / 60, 0, false); // 10.2s @ min 0.5Hz
    expect(n).toBe(5);
    const hi = createSpawnScheduler();
    n = 0;
    for (let i = 0; i < 63; i++) n += stepSpawner(hi, 1 / 60, 1e9, false); // 1.05s @ max 10Hz
    expect(n).toBe(10);
  });

  it('gated mode (grow patched) spawns NOTHING and drains the accumulator', () => {
    const s = createSpawnScheduler();
    stepSpawner(s, 0.4, 10, false); // acc builds up
    expect(stepSpawner(s, 0.4, 10, true)).toBe(0);
    expect(s.acc).toBe(0);
    // back to ungated: no backlog burst from the gated window
    expect(stepSpawner(s, 0, 10, false)).toBe(0);
  });

  it('clamps a tab-suspend dt and caps the per-frame burst', () => {
    const s = createSpawnScheduler();
    const n = stepSpawner(s, 60 /* absurd dt */, RATE_MAX, false);
    expect(n).toBe(MAX_SPAWNS_PER_FRAME);
    expect(s.acc).toBe(0); // backlog dropped
  });

  it('dt = 0 (frozen engine frame) spawns nothing', () => {
    const s = createSpawnScheduler();
    expect(stepSpawner(s, 0, RATE_MAX, false)).toBe(0);
  });
});

// ── grow-in ─────────────────────────────────────────────────────────────────

describe('growFactor', () => {
  it('eases 0 → 1 over GROW_IN_S with ease-out shape', () => {
    expect(growFactor(0)).toBe(0);
    expect(growFactor(GROW_IN_S)).toBe(1);
    expect(growFactor(GROW_IN_S * 10)).toBe(1);
    const early = growFactor(GROW_IN_S * 0.25);
    // ease-OUT: front-loaded — at 25% time it's already well past 25% scale
    expect(early).toBeGreaterThan(0.5);
    expect(early).toBeLessThan(1);
    expect(growFactor(-1)).toBe(0);
  });
});

// ── layout: perspective + anchor + parallax ────────────────────────────────

describe('layoutPlant', () => {
  const rng = createRng(11);

  function grownPlant(depth: number, worldX: number, kind: 'flower' | 'bush' | 'tree' = 'flower') {
    const scene = createScene();
    const p = spawnPlant(scene, ATLAS.filter((e) => e.kind === kind), rng, 0)!;
    p.depth = depth;
    p.worldX = worldX;
    p.bornAt = 0; // now=100 → fully grown
    return p;
  }

  it('depth 0 anchors at the bottom edge at full canonical height', () => {
    const p = grownPlant(0, 0.5);
    const r = layoutPlant(p, baseLayout({ view: 0 }))!;
    expect(r.y).toBe(0);
    const expectedH = KIND_CANONICAL_HEIGHT.flower * (RES.resH / CANONICAL_FRAME_H);
    expect(r.h).toBe(Math.round(expectedH));
  });

  it('depth 1 anchors AT the horizon at FAR_SCALE height (never above it)', () => {
    const p = grownPlant(1, 0.5, 'tree');
    const horizon = 0.65;
    const r = layoutPlant(p, baseLayout({ horizon, view: 0 }))!;
    expect(r.y).toBe(Math.round(1 * horizon * RES.resH));
    const expectedH = KIND_CANONICAL_HEIGHT.tree * (RES.resH / CANONICAL_FRAME_H) * FAR_SCALE;
    expect(r.h).toBe(Math.round(expectedH));
  });

  it('kind scale ordering holds at equal depth: tree > bush > flower', () => {
    const hs = (['tree', 'bush', 'flower'] as const).map((k) => {
      const p = grownPlant(0.3, 0.5, k);
      return layoutPlant(p, baseLayout({ view: 0 }))!.h;
    });
    expect(hs[0]).toBeGreaterThan(hs[1]!);
    expect(hs[1]).toBeGreaterThan(hs[2]!);
  });

  it('grow-in scales up from the ground anchor (y fixed, w/h growing)', () => {
    const p = grownPlant(0.4, 0.5);
    p.bornAt = 100; // born "now"
    const early = layoutPlant(p, baseLayout({ now: 100 + GROW_IN_S * 0.3, view: 0 }))!;
    const late = layoutPlant(p, baseLayout({ now: 100 + GROW_IN_S, view: 0 }))!;
    expect(early.y).toBe(late.y);          // bottom stays planted
    expect(early.h).toBeLessThan(late.h);  // still growing
    expect(early.w).toBeLessThan(late.w);
  });

  it('grow-in dates from visibleAt when set (slow texture fetch still animates)', () => {
    const p = grownPlant(0.4, 0.5);
    p.bornAt = 0;
    p.visibleAt = 100; // textures became ready "now"
    const r = layoutPlant(p, baseLayout({ now: 100 + GROW_IN_S * 0.3, view: 0 }));
    const full = layoutPlant(p, baseLayout({ now: 200, view: 0 }))!;
    expect(r!.h).toBeLessThan(full.h);
  });

  it('parallax: near plants shift more than far plants for the same view delta', () => {
    // A 0.3→0.5 view sweep keeps BOTH plants on-screen (a full 0→1 sweep
    // pans a near-plane plant at worldX 1.0 fully out of frame — that
    // hide/reveal is itself pinned in the next test).
    const near = grownPlant(0, 1.0);
    const far = grownPlant(1, 1.0);
    const at = (pl: ReturnType<typeof grownPlant>, view: number) =>
      layoutPlant(pl, baseLayout({ view }))!;
    const dView = 0.2;
    const nearShift = at(near, 0.3).x - at(near, 0.5).x;
    const farShift = at(far, 0.3).x - at(far, 0.5).x;
    expect(nearShift).toBeGreaterThan(farShift);
    // exact model: pan = view · (WORLD_WIDTH-1) · parallaxFactor(depth)
    expect(nearShift).toBeCloseTo(dView * (WORLD_WIDTH - 1) * 1 * RES.resW, -1);
    expect(farShift).toBeCloseTo(dView * (WORLD_WIDTH - 1) * FAR_PARALLAX * RES.resW, -1);
  });

  it('returns null when fully off-screen at this view', () => {
    const p = grownPlant(0, WORLD_WIDTH - 0.01); // far right of the near world
    expect(layoutPlant(p, baseLayout({ view: 0 }))).toBeNull();  // panned away
    expect(layoutPlant(p, baseLayout({ view: 1 }))).not.toBeNull(); // pan reveals it
  });

  it('parallaxFactor + effectiveWorldWidth pin the pan/spawn window model', () => {
    expect(parallaxFactor(0)).toBe(1);
    expect(parallaxFactor(1)).toBeCloseTo(FAR_PARALLAX);
    expect(effectiveWorldWidth(0)).toBeCloseTo(WORLD_WIDTH);
    expect(effectiveWorldWidth(1)).toBeCloseTo(1 + (WORLD_WIDTH - 1) * FAR_PARALLAX);
  });
});

// ── painter's sort ──────────────────────────────────────────────────────────

describe('sortPlantsForRender', () => {
  it('orders far → near with stable serial tie-break, without mutating input', () => {
    const rng = createRng(23);
    const scene = createScene();
    for (let i = 0; i < 30; i++) spawnPlant(scene, ATLAS, rng, i);
    scene.plants[3]!.depth = scene.plants[7]!.depth; // force a tie
    const before = [...scene.plants];
    const sorted = sortPlantsForRender(scene.plants);
    expect(scene.plants).toEqual(before); // input untouched
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      expect(a.depth >= b.depth).toBe(true);
      if (a.depth === b.depth) expect(a.serial).toBeLessThan(b.serial);
    }
  });
});
