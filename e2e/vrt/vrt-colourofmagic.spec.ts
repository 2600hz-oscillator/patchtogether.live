// e2e/vrt/vrt-colourofmagic.spec.ts
//
// Deterministic per-block composite VRT for COLOUR OF MAGIC. Each scene feeds a
// colourful STRUCTURED source (LINES horizontal stripes → CHROMA tint) into the
// module and captures the on-card preview of a chosen output. Determinism: we
// PIN the engine clock (`__videoEngineFreezeTime = 0`) BEFORE boot, so LINES
// renders a fixed-phase grating every frame and the whole chain (CHROMA + the
// pure-function COLOUR OF MAGIC blocks) is bit-stable — then suspend the
// AudioContext so the card's preview rAF holds the frozen frame.
//
// Scenes prove: (a) RGB / YDbDr / HSV recolorization visibly differs from the
// passthrough; (b) a mono override patched into a channel visibly CLOBBERS it
// (a cross-grating appears in green); (c) the palette REPLACE remap recolours
// (cyan/magenta/yellow). The canvas IS the regression target here (unlike the
// masked solo-spawn VRT), so nothing is masked.
//
// Informational lane (`task vrt`) — darwin baseline captured locally; linux
// gated in EXEMPT_BASELINE_PAIRS until a vrt-update.yml workflow_dispatch runs.
//
// Output: e2e/vrt/__screenshots__/vrt-colourofmagic.spec.ts/{platform}/<id>.png

import { test, expect } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

// Colourful horizontal-stripe source: LINES (grayscale grating) → CHROMA (tint,
// tintMix < 1 so the stripes still modulate) → COLOUR OF MAGIC.in.
const SRC_TINT = { tintR: 0.85, tintG: 0.5, tintB: 0.65, tintMix: 0.55 };

interface Node { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface Edge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

interface Scene { id: string; params: Record<string, number>; override?: boolean }
const SCENES: Scene[] = [
  // Reference: the untouched source passthrough.
  { id: 'com-pass', params: { preview: 0 } },
  // RGB recolorization: red up, blue down.
  { id: 'com-rgb', params: { preview: 1, bias_r: 0.5, bias_b: -0.3 } },
  // YDbDr: push the blue-yellow (Db) axis.
  { id: 'com-ydbdr', params: { preview: 2, bias_db: 0.45 } },
  // HSV: rotate hue + lift saturation.
  { id: 'com-hsv', params: { preview: 3, bias_h: 140, bias_s: 0.3 } },
  // Mono override clobbers the GREEN channel with a crossing (vertical) grating.
  { id: 'com-override', params: { preview: 1 }, override: true },
  // Palette REPLACE: remap R/G/B → cyan / magenta / yellow.
  { id: 'com-palette', params: { preview: 1, replace: 1, pal_r: 0x00ffff, pal_g: 0xff00ff, pal_b: 0xffff00 } },
];

function buildNodes(comParams: Record<string, number>, override: boolean): Node[] {
  const nodes: Node[] = [
    { id: 'lines', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 9, orient: 0 } },
    { id: 'chroma', type: 'chroma', position: { x: 260, y: 40 }, domain: 'video', params: SRC_TINT },
    { id: 'com', type: 'colourofmagic', position: { x: 520, y: 60 }, domain: 'video', params: comParams },
  ];
  if (override) {
    nodes.push({ id: 'lines-ovr', type: 'lines', position: { x: 40, y: 320 }, domain: 'video', params: { amp: 15, orient: 1 } });
  }
  return nodes;
}
function buildEdges(override: boolean): Edge[] {
  const edges: Edge[] = [
    { id: 'e-l', from: { nodeId: 'lines', portId: 'out' }, to: { nodeId: 'chroma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-c', from: { nodeId: 'chroma', portId: 'out' }, to: { nodeId: 'com', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
  if (override) {
    edges.push({ id: 'e-ovr', from: { nodeId: 'lines-ovr', portId: 'out' }, to: { nodeId: 'com', portId: 'rgb_g_in' }, sourceType: 'mono-video', targetType: 'mono-video' });
  }
  return edges;
}

test.describe('VRT: COLOUR OF MAGIC per-block recolorization', () => {
  for (const scene of SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      test.setTimeout(90_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      // Pin the engine clock BEFORE boot → LINES renders a fixed-phase grating,
      // the whole chain is bit-stable (no per-frame drift to flake the capture).
      await page.addInitScript(() => {
        (globalThis as unknown as { __videoEngineFreezeTime?: number }).__videoEngineFreezeTime = 0;
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await spawnPatch(page, buildNodes(scene.params, !!scene.override), buildEdges(!!scene.override));

      const card = page.locator('.svelte-flow__node-colourofmagic').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(page.locator('canvas[data-testid="colourofmagic-canvas"]')).toHaveCount(1);

      // Let the frozen frame settle into the preview.
      await page.waitForTimeout(700);
      // Suspend the AudioContext so the preview rAF holds the frozen frame.
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
        const eng = w.__engine?.();
        if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
      });
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      }
      await page.waitForTimeout(200);

      await expect(card).toHaveScreenshot(`${scene.id}.png`, { maskColor: '#ff00ff' });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
