// e2e/vrt/vrt-quadralogical.spec.ts
//
// Composite-state VRT for QUADRALOGICAL's Phase-2 per-edge effects.
//
// One representative scene PER EFFECT (8 effects → 8 baselines). Each scene:
//   * Feeds four SOLID-COLOUR sources into in1..in4 (LINES → CHROMA with
//     tintMix=1, so each input is a deterministic flat colour — no animated
//     phase, no frame-time dependence → pixel-stable across runs).
//       in1 = RED, in2 = GREEN, in3 = BLUE, in4 = YELLOW.
//   * Selects the target effect on the TOP edge (1–2, in1↔in2) so the effect
//     blends red↔green, and positions the joystick ON that edge (0, +0.6) so
//     the edge is active + visible.
//   * For the keyers (CHROMA/LUMA) the key/threshold are set so the effect
//     visibly keys; WIPE/IRIS use a mid amount so the spatial split shows.
//   * The MIX is rendered into the on-card preview canvas. We then set
//     `freeze=1` on the quad (holds the FBO) + suspend the AudioContext, and
//     capture the WHOLE CARD (canvas included — the canvas is the regression
//     target here, unlike the masked solo-spawn VRT in vrt.spec.ts).
//
// Because the sources are flat colours, the captured frame is determined purely
// by (joystick pos, edge fx, edge params) — exactly the thing we want to lock.
//
// Informational lane (`task vrt`) — darwin baseline captured locally; linux
// needs a `vrt-update.yml` workflow_dispatch (the EXEMPT_BASELINE_PAIRS gate in
// vrt-exemptions.ts skips linux until that runs).
//
// Output: e2e/vrt/__screenshots__/vrt-quadralogical.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

// Distinct flat colour per input. tintMix=1 → CHROMA outputs the pure tint
// regardless of its (animated) LINES input → deterministic flat source.
const TINTS = [
  { tintR: 1, tintG: 0, tintB: 0, tintMix: 1 }, // in1 red
  { tintR: 0, tintG: 1, tintB: 0, tintMix: 1 }, // in2 green
  { tintR: 0, tintG: 0, tintB: 1, tintMix: 1 }, // in3 blue
  { tintR: 1, tintG: 1, tintB: 0, tintMix: 1 }, // in4 yellow
];

function buildNodes(quadParams: Record<string, number>) {
  const nodes: Array<{ id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }> = [];
  for (let i = 0; i < 4; i++) {
    nodes.push({ id: `lines${i}`, type: 'lines', position: { x: 40, y: 40 + i * 150 }, domain: 'video', params: { amp: 8 + i } });
    nodes.push({ id: `chroma${i}`, type: 'chroma', position: { x: 240, y: 40 + i * 150 }, domain: 'video', params: TINTS[i]! });
  }
  nodes.push({ id: 'quad', type: 'quadralogical', position: { x: 520, y: 60 }, domain: 'video', params: quadParams });
  return nodes;
}

function buildEdges() {
  const edges: Array<{ id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }> = [];
  for (let i = 0; i < 4; i++) {
    edges.push({ id: `l${i}`, from: { nodeId: `lines${i}`, portId: 'out' }, to: { nodeId: `chroma${i}`, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' });
    edges.push({ id: `c${i}`, from: { nodeId: `chroma${i}`, portId: 'out' }, to: { nodeId: 'quad', portId: `in${i + 1}` }, sourceType: 'video', targetType: 'video' });
  }
  return edges;
}

// Each scene = (id, label, quad params). The top edge (1–2) carries the effect
// under test; joystick sits on that edge so it's active. amount/param chosen so
// the effect reads clearly on a red↔green pair.
interface EffectScene { id: string; fx: number; params: Record<string, number> }
const EFFECT_SCENES: EffectScene[] = [
  { id: 'edge-dissolve', fx: 0, params: {} },
  { id: 'edge-add',      fx: 1, params: { edge1_amount: 1 } },
  { id: 'edge-multiply', fx: 2, params: { edge1_amount: 1 } },
  { id: 'edge-wipe',     fx: 3, params: { edge1_amount: 0, edge1_param: 0.05 } },   // horizontal wipe
  { id: 'edge-chroma',   fx: 4, params: { edge1_amount: 0.5, edge1_param: 0.2, keyG: 1 } }, // key green
  { id: 'edge-luma',     fx: 5, params: { edge1_amount: 0.5, edge1_param: 0.2 } },
  { id: 'edge-diff',     fx: 6, params: { edge1_amount: 1 } },
  { id: 'edge-iris',     fx: 7, params: { edge1_amount: 0.3, edge1_param: 0.05 } }, // mid iris
];

test.describe('VRT: QUADRALOGICAL per-edge effects', () => {
  for (const scene of EFFECT_SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      // Video e2e on CI's SwiftShader is SLOW — generous budget.
      test.setTimeout(90_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Joystick on the TOP edge (in1↔in2 active); the target effect on edge 1–2.
      const quadParams: Record<string, number> = {
        pos_x: 0,
        pos_y: 0.6,
        edge1_fx: scene.fx,
        ...scene.params,
      };
      await spawnPatch(page, buildNodes(quadParams), buildEdges());

      const card = page.locator('.svelte-flow__node-quadralogical').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(page.locator('canvas[data-testid="quadralogical-canvas"]')).toHaveCount(1);

      // Let the flat-colour sources + the mix settle into the on-card preview.
      await page.waitForTimeout(700);

      // Freeze the quad (holds the mix FBO) + suspend the AudioContext so the
      // on-card preview's rAF holds the frozen frame → pixel-stable.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const n = w.__patch.nodes['quad'];
          if (n) n.params.freeze = 1;
        });
      });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
      });
      // A couple of rAFs so the final frozen frame paints into the canvas.
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      await page.waitForTimeout(200);

      await expect(card).toHaveScreenshot(`${scene.id}.png`, {
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
