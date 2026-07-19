// e2e/vrt/mirrorpool-composite.spec.ts
//
// Deterministic composite VRT for MIRRORPOOL (the hemisphere-pool liquid
// renderer). Each scene patches two deterministic pure-UV sources into the
// POOL + SCENE inputs and dials MIRRORPOOL to a visually distinct setting,
// then captures the PAGE (the cellshade-composite recipe: source cards +
// cords + the MIRRORPOOL card with its live OUT preview INCLUDED — the canvas
// IS the regression target here).
//
//   mirrorpool-refract  default REFRACT mode — reflected scene over the
//                       refracted pool beneath, light wind swell.
//   mirrorpool-mirror   MODE=1 MIRROR — near-full mirror of the scene, broken
//                       by the ripple normals.
//   mirrorpool-storm    high wind + downpour rain — the rain-ring field on a
//                       choppy surface.
//
// DETERMINISM: the engine clock is pinned (`__videoEngineFreezeTime`), the
// rain scheduler is seeded (`__mirrorpoolVrtSeed`), and the ANALYTIC height
// path is forced (`__mirrorpoolForceAnalytic`) so the render never depends on
// whether the runner's GL exposes renderable float targets (the isFloat
// premise the perf review flagged). Renderer-tolerant by construction — the
// canvas is a page capture with a masked mismatch colour, never an exact-pixel
// solo assert.
//
// BASELINE STATUS: DEFERRED on BOTH platforms via EXEMPT_BASELINE_PAIRS —
// MIRRORPOOL is a maximally look-affecting video source HELD for owner
// preview; no VRT baseline is pinned until the owner approves the look. Once
// approved, capture darwin locally + linux via vrt-update.yml, then drop the
// mirrorpool-* pairs from EXEMPT_BASELINE_PAIRS.

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

interface Node { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface Edge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

interface Scene { id: string; nodes: Node[]; edges: Edge[] }

/** pool source → POOL, scene source → SCENE, with per-scene mirrorpool params. */
function scene(id: string, mp: Record<string, number>): Scene {
  return {
    id,
    nodes: [
      { id: 'pool', type: 'shapedramps', position: { x: 40, y: 40 }, domain: 'video' },
      { id: 'scn', type: 'lines', position: { x: 40, y: 340 }, domain: 'video', params: { orient: 0, amp: 9, phase: 0 } },
      { id: 'mp', type: 'mirrorpool', position: { x: 460, y: 120 }, domain: 'video', params: mp },
    ],
    edges: [
      { id: 'e-pool', from: { nodeId: 'pool', portId: 'h_lin' }, to: { nodeId: 'mp', portId: 'pool' }, sourceType: 'mono-video', targetType: 'video' },
      { id: 'e-scn', from: { nodeId: 'scn', portId: 'out' }, to: { nodeId: 'mp', portId: 'scene' }, sourceType: 'mono-video', targetType: 'video' },
    ],
  };
}

// Camera = the orbit + free-look rig (orbit_az/orbit_el/orbit_dist +
// look_yaw/look_pitch). Each scene frames the pool from above-and-in-front
// (positive elevation, aim-at-centre) at a slight orbit for a legible angle.
const SCENES: Scene[] = [
  scene('mirrorpool-refract', { surface_mode: 0, wind_speed: 0.3, rain: 0.15, brightness: 1, orbit_az: -0.5, orbit_el: 0.5, orbit_dist: 2.6, zoom: 0.5 }),
  scene('mirrorpool-mirror', { surface_mode: 1, wind_speed: 0.25, rain: 0.1, brightness: 1, orbit_az: -0.5, orbit_el: 0.5, orbit_dist: 2.6, zoom: 0.5 }),
  scene('mirrorpool-storm', { surface_mode: 0.3, wind_speed: 0.9, rain: 0.95, brightness: 1.2, orbit_az: 0.4, orbit_el: 0.35, orbit_dist: 2.4, zoom: 0.4 }),
];

test.describe('VRT: MIRRORPOOL composite scenes', () => {
  for (const s of SCENES) {
    test(`${s.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${s.id}`),
        `${s.id} on ${VRT_PLATFORM}: baseline deferred (HELD for owner preview — see EXEMPT_BASELINE_PAIRS)`,
      );

      test.setTimeout(90_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      // Pin clock + seed rain + force the analytic (float-independent) path
      // BEFORE boot so the whole chain is bit-stable across renderers.
      await page.addInitScript(() => {
        const g = globalThis as unknown as {
          __videoEngineFreezeTime?: number;
          __mirrorpoolVrtSeed?: number;
          __mirrorpoolForceAnalytic?: boolean;
        };
        g.__videoEngineFreezeTime = 1.0;
        g.__mirrorpoolVrtSeed = 0x51ee;
        g.__mirrorpoolForceAnalytic = true;
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');
      await page.addStyleTag({
        content:
          '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution{display:none !important;}',
      });

      await spawnPatch(page, s.nodes, s.edges);

      const card = page.locator('.svelte-flow__node-mirrorpool').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(page.locator('canvas[data-testid="mirrorpool-preview"]')).toHaveCount(1);

      await page.waitForTimeout(700);
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
      });
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      await page.waitForTimeout(200);

      await expect(page).toHaveScreenshot(`${s.id}.png`, { maskColor: '#ff00ff', fullPage: false });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${s.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
