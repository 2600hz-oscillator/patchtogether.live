// e2e/vrt/vrt-scope-modes.spec.ts
//
// VRT baselines for SCOPE's X/Y (Lissajous) MODE switch + phosphor
// INTENSITY (persistence) knob — the two features added in this PR. The
// per-module scope.png baseline (vrt.spec.ts) already covers NORMAL mode at
// the 12:00 INTENSITY default (= today's render, pixel-identical canvas);
// these scenes cover the NEW states:
//
//   * xy-lissajous   — ch1/ch2 driven by two oscillators a perfect-fifth
//                      apart (≈3:2) with MODE switched to X/Y. EYEBALL: a
//                      stable 2D Lissajous figure (NOT a flat line).
//   * intensity-dot  — NORMAL mode, INTENSITY at 7:00 (min, 0.0). EYEBALL:
//                      the trace collapses toward the newest beam position —
//                      a short bright segment, near-zero trail.
//   * intensity-long — NORMAL mode, INTENSITY at 5:00 (max, 1.0). EYEBALL:
//                      a ~2-screen persistence trail, older sweep faded
//                      behind the newest at reduced brightness (phosphor).
//
// Determinism: after a settle we SUSPEND the AudioContext (same trick as
// vrt-scenes.ts) so the analyser buffer freezes; drawScope is a pure
// function of that frozen buffer + params, so every rAF paints identical
// pixels. The intensity scenes use a shorter timebase (timeMs=10) so a
// 2-screen trail still fits inside the 2048-sample analyser buffer.
//
// Linux deferred (mirrors the main scope baseline — see EXEMPT_BASELINE_PAIRS
// `linux/scope`): captured on darwin here; linux pending a `task vrt:update`
// on linux CI.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from '../tests/_helpers';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

interface ScopeCase {
  name: string;
  nodes: SpawnNode[];
  edges: SpawnEdge[];
  settleMs: number;
  /** Deterministic draw seed (phase-locked synthetic sines). Set before
   *  the card mounts so the on-card draw loop renders FIXED pixels every
   *  run — essential for X/Y, where two live oscillators aren't phase-
   *  locked and the figure orientation would otherwise drift. */
  seed: { ch1Freq: number; ch2Freq: number; ch2Phase?: number };
}

const CASES: ScopeCase[] = [
  {
    name: 'xy-lissajous',
    nodes: [
      { id: 'vco1', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: 'vco2', type: 'analogVco', position: { x: 40, y: 300 }, domain: 'audio', params: { tune: 7 } },
      // mode=1 (X/Y) set at spawn so the very first paint is the Lissajous.
      { id: 'vrt-1', type: 'scope', position: { x: 520, y: 60 }, domain: 'audio', params: { mode: 1 } },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'vco1', portId: 'sine' }, to: { nodeId: 'vrt-1', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'vco2', portId: 'sine' }, to: { nodeId: 'vrt-1', portId: 'ch2' }, sourceType: 'audio', targetType: 'audio' },
    ],
    settleMs: 400,
    // 220 vs 330 Hz = a clean 3:2 (perfect fifth) Lissajous, ch2 in phase.
    seed: { ch1Freq: 220, ch2Freq: 330, ch2Phase: 0 },
  },
  {
    name: 'intensity-dot',
    nodes: [
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: 'vrt-1', type: 'scope', position: { x: 520, y: 60 }, domain: 'audio', params: { timeMs: 10, intensity: 0 } },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vrt-1', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
    settleMs: 300,
    // 440 Hz fills the 10ms window with ~4.4 cycles; ch2 unused in NORMAL.
    seed: { ch1Freq: 440, ch2Freq: 440 },
  },
  {
    name: 'intensity-long',
    nodes: [
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 40 }, domain: 'audio' },
      { id: 'vrt-1', type: 'scope', position: { x: 520, y: 60 }, domain: 'audio', params: { timeMs: 10, intensity: 1 } },
    ],
    edges: [
      { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vrt-1', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
    settleMs: 300,
    seed: { ch1Freq: 440, ch2Freq: 440 },
  },
];

async function freezeAudio(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
    const eng = w.__engine?.();
    if (eng) { try { await eng.ctx.suspend(); } catch { /* already suspended */ } }
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

test.describe.configure({ mode: 'default' });

test.describe('VRT: SCOPE X/Y mode + INTENSITY persistence', () => {
  for (const c of CASES) {
    test(`${c.name} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/scope-${c.name}`),
        `scope-${c.name} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // Seed the on-card draw loop with a deterministic phase-locked
      // snapshot BEFORE the card mounts (during spawnPatch). The audio
      // graph (VCOs + cables) is still spawned for realism + so the freeze
      // path exercises the real engine, but the trace pixels come from the
      // fixed seed → identical every run.
      await page.evaluate((seed) => {
        (globalThis as unknown as { __scopeVrtSeed?: unknown }).__scopeVrtSeed = seed;
      }, c.seed);

      await spawnPatch(page, c.nodes, c.edges);

      const card = page.locator('.svelte-flow__node-scope').first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      await page.waitForTimeout(c.settleMs);
      await freezeAudio(page);

      await expect(card).toHaveScreenshot(`scope-${c.name}.png`, {
        maskColor: '#ff00ff',
      });

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `scope ${c.name}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
