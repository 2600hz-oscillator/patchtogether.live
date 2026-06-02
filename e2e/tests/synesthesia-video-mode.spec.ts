// e2e/tests/synesthesia-video-mode.spec.ts
//
// LIVE-patch coverage for SYNESTHESIA's per-block VIDEO mode (the cross-domain
// pixel path). Three claims:
//
//   1. VIDEO drive: a self-running video source (ACIDWARP) → SYNESTHESIA
//      .a_video_in, copy A in VIDEO mode, lights copy A's R/G/B/Luma VU meters
//      and fires a channel gate (proving the card reads the frame pixels →
//      channel levels → worklet env/gate stage).
//   2. Mode independence: copy A in VIDEO, copy B in AUDIO — switching A to
//      video does NOT light B (no audio + audio mode → B stays dark).
//   3. AUDIO regression: with copy A toggled to VIDEO, an AUDIO-mode copy B fed
//      a tone still lights the matching spectral band (existing behaviour
//      unbroken when the OTHER copy is in video mode).
//
// The precise solid-red→R / white→all channel mapping is proven deterministically
// at the DSP-unit layer (synesthesia-dsp.test.ts videoChannelLevels); here we
// prove the real wiring end-to-end (ACIDWARP's plasma has nonzero R/G/B/Luma so
// all four channels light + their gates can fire).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { runFor, readScopePeakOverWindow } from './_module-coverage-helpers';

/** Read SYNESTHESIA's VU snapshot ({levelsA, levelsB}) via the dev engine hook. */
async function readSynLevels(
  page: Page,
  nodeId: string,
): Promise<{ levelsA: number[]; levelsB: number[] } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { levelsA: number[]; levelsB: number[] }
      | undefined;
    if (!snap) return null;
    return { levelsA: Array.from(snap.levelsA), levelsB: Array.from(snap.levelsB) };
  }, nodeId);
}

/** Poll the snapshot over `ms`, returning {maxA, maxB} per-lane max levels. */
async function maxLevels(
  page: Page,
  nodeId: string,
  ms: number,
): Promise<{ a: number[]; b: number[] }> {
  const deadline = Date.now() + ms;
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  while (Date.now() < deadline) {
    const s = await readSynLevels(page, nodeId);
    if (s) for (let i = 0; i < 4; i++) {
      a[i] = Math.max(a[i]!, s.levelsA[i] ?? 0);
      b[i] = Math.max(b[i]!, s.levelsB[i] ?? 0);
    }
    await page.waitForTimeout(60);
  }
  return { a, b };
}

test.describe('SYNESTHESIA VIDEO mode — cross-domain colour analysis', () => {
  test('ACIDWARP → a_video_in (copy A VIDEO) lights R/G/B/Luma meters + fires a gate', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video' },
      // Copy A in VIDEO mode; copy B left in AUDIO mode (default) with no input.
      { id: 'syn', type: 'synesthesia', position: { x: 420, y: 40 }, domain: 'audio',
        params: { a_mode: 1, b_mode: 0 } },
      { id: 'scp', type: 'scope', position: { x: 420, y: 420 }, domain: 'audio' },
    ];
    const edges: SpawnEdge[] = [
      // Cross-domain video → synesthesia video input (consumed card-side).
      { id: 'e_acid_syn', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'syn', portId: 'a_video_in' }, sourceType: 'video', targetType: 'video' },
      // Route a channel GATE into SCOPE so we can prove the gate fires.
      { id: 'e_gate_scp', from: { nodeId: 'syn', portId: 'a_band4_gate' }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType: 'gate', targetType: 'gate' },
    ];
    await spawnPatch(page, nodes, edges);

    // The card's rAF must run + read frames. Card visibility ensures the rAF
    // loop is active.
    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });
    await runFor(page, 500);

    const { a, b } = await maxLevels(page, 'syn', 1500);

    // Copy A (VIDEO): all four channel meters light off the plasma's colour.
    for (let c = 0; c < 4; c++) {
      expect(a[c], `copy A channel ${c} lit (a=${a.map((v) => v.toFixed(3)).join(',')})`).toBeGreaterThan(0.02);
    }
    // Copy B stays dark (AUDIO mode, no input).
    expect(Math.max(...b), `copy B dark (b=${b.map((v) => v.toFixed(3)).join(',')})`).toBeLessThan(0.02);

    // A channel gate fired (the Luma channel of a bright plasma crosses the
    // gate's high threshold).
    const gate = await readScopePeakOverWindow(page, 'scp', 800);
    expect(gate.peak, 'a_band4_gate fired (SCOPE saw the gate)').toBeGreaterThan(0.4);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  test('AUDIO regression: copy B (AUDIO) still lights the right band while copy A is VIDEO', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const nodes: SpawnNode[] = [
      { id: 'acid', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video' },
      // A in VIDEO; B in AUDIO, fed a 261 Hz tone → band 2 must light.
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 360 }, domain: 'audio', params: { tune: 0 } },
      { id: 'vca', type: 'vca', position: { x: 300, y: 360 }, domain: 'audio', params: { base: 1, cvAmount: 0 } },
      { id: 'syn', type: 'synesthesia', position: { x: 560, y: 40 }, domain: 'audio',
        params: { a_mode: 1, b_mode: 0 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_acid_syn', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'syn', portId: 'a_video_in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e_vco_vca', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'e_vca_syn', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'syn', portId: 'b_in' }, sourceType: 'audio', targetType: 'audio' },
    ];
    await spawnPatch(page, nodes, edges);

    const synCard = page.locator('.svelte-flow__node-synesthesia').first();
    await synCard.waitFor({ state: 'visible', timeout: 10_000 });
    await runFor(page, 500);

    const { a, b } = await maxLevels(page, 'syn', 1500);

    // Copy B (AUDIO, 261 Hz): band 2 (index 1) is the most-energized lane.
    expect(b[1], `B band2 dominates (b=${b.map((v) => v.toFixed(3)).join(',')})`).toBe(Math.max(...b));
    expect(b[1]!).toBeGreaterThan(0.02);
    // Copy A (VIDEO) is independently lit — proves both modes coexist.
    expect(Math.max(...a), `A video lit (a=${a.map((v) => v.toFixed(3)).join(',')})`).toBeGreaterThan(0.02);

    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });
});
