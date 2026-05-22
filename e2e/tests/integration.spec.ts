// e2e/tests/integration.spec.ts
//
// Cross-module integration smoke. Generated patches from
// _pair-patches.ts each wire a source into a sink, drive any
// upstream that's needed, and assert the sink receives signal.
//
// The unique value of this spec vs per-module.spec.ts: pair-patches
// exercise the engine's reconciler in actual cross-module
// compositions (cross-domain bridges, CV-family edges, polyPitchGate
// splits, etc.). Per-module.spec.ts asserts each module is
// individually sound; this spec asserts they COMPOSE.
//
// Generators in _pair-patches.ts:
//   * monoVideoToScope() — every mono-video output → SCOPE.ch1
//   * cvIntoAdsr() — LFO.phase0 → ADSR.{attack,decay,sustain,release}
//   * gateIntoCvParam() — SEQUENCER.gate → ADSR.attack (cv-family)
//
// What's still out of scope:
//   * Cartesian audio source × audio sink (~200 tests — too expensive
//     for CI today; revisit once Playwright sharding lands).
//   * Every CV source × every CV consumer (~150 tests — same reason).
//   * Video-domain pair-patches beyond the mono-video bridge.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';
import {
  monoVideoToScope,
  cvIntoAdsr,
  gateIntoCvParam,
  type PairPatch,
} from './_pair-patches';

test.describe.configure({ mode: 'parallel' });

function runPair(group: string, patch: PairPatch): void {
  test(`${group} — ${patch.label}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, patch.nodes, patch.edges);

    // If a sequencer is in the patch, seed playable steps so its gate
    // actually fires. (Most spec authors forget the step seed; this
    // is a convention — generator-emitted patches with a `seq` node
    // get a 4-note major chord seeded here.)
    const hasSeq = patch.nodes.some((n) => n.id === 'seq');
    if (hasSeq) {
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const seq = w.__patch.nodes['seq'];
          if (!seq) return;
          if (!seq.data) seq.data = {};
          seq.data.steps = [
            { on: true, midi: 60 },
            { on: true, midi: 64 },
            { on: true, midi: 67 },
            { on: true, midi: 72 },
          ];
        });
      });
    }

    // 1.0 s — long enough for wavetable loads + several sequencer
    // ticks at 240 BPM (~63 ms per 16th).
    await runFor(page, 1000);

    const snap = await readScopeSnapshot(page, patch.readNodeId);
    expect(snap, `${patch.label}: scope snapshot`).not.toBeNull();
    if (!snap) return;
    const sum = summarize(snap.ch1);
    expect(
      sum.peak,
      `${patch.label}: peak (peak=${sum.peak.toFixed(4)}, rms=${sum.rms.toFixed(4)})`,
    ).toBeGreaterThan(0.005);

    expect(
      errors,
      `console/page errors: ${errors.join(' | ')}`,
    ).toEqual([]);
  });
}

test.describe('integration: cross-domain mono-video bridge', () => {
  // Mono-video outputs published by audio modules (SCOPE's own viz,
  // WAVVIZ, SWOLEVCO, WAVESCULPT) AND every video module's preview
  // canvas. The bridge is the engine path that lets a SCOPE.ch1
  // (audio input) sample bytes from a mono-video producer.
  for (const p of monoVideoToScope()) runPair('mono-video → scope', p);
});

test.describe('integration: cv-family interchange (cv ↔ pitch ↔ gate)', () => {
  // The canConnect rule says cv / pitch / gate interchange at the
  // type level (see graph/types.ts CV_FAMILY). These tests assert
  // the engine actually delivers signal through those edges — gate
  // arrives at a cv input, cv arrives at a gate input.
  for (const p of cvIntoAdsr()) runPair('cv-into-adsr', p);
  for (const p of gateIntoCvParam()) runPair('gate-into-cv-param', p);
});
