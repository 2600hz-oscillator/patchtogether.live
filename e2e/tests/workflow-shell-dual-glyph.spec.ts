// e2e/tests/workflow-shell-dual-glyph.spec.ts
//
// The tidyVco DUAL-DISPLAY glyph (owner spec) under `?shell=1`:
//
//   (a) DOCK: the hero band shows BOTH displays — the param-derived STATIC
//       core waveform (ScopeScreen 'wave', from shape1/shape2/PW/mix) and the
//       live analyser trace ('waveform') — and the static morph is NON-FLAT
//       with NO gate and NO audio flowing (the whole point: the live trace
//       alone flatlines when ungated).
//   (b) LIVE-WHILE-TWISTING: a REAL pointer drag on the SHAPE 1 knob changes
//       the static display's pixels DURING the gesture (mid-gesture frames
//       captured while the pointer is still down — the transient-read
//       binding), and the live trace keeps animating through the pointer
//       capture (driven by the real POLYSEQZ → tidyVco → audioOut chain).
//   (c) COMPACT lane tile: the glyph well prefers the STATIC morph (the
//       oscillator's identity) — no live-trace pane in the row tile.
//
// Liveness/flatness asserts ride the DOM-mirrored seams (`data-wave-peak` /
// `data-trace-peak` — capability-safe, no GPU read); pixel-change asserts read
// the 2D canvas via toDataURL (plain CPU canvas — identical on SwiftShader).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, seedKriaGate } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// ⚠ THIS SPEC ALREADY SPENT ITS FLAKE. Run 33509092036 recovered "(a) dock hero
// shows BOTH displays" `timedOut -> passed` on the SAME SHA with the bare
// `Test timeout of 30000ms exceeded` — one of seven such recovered flakes in the
// 47.5 h window audited on 2026-09-01, and one of the two still unrepaired on
// `origin/main` when that audit was written. Its boot wait is bounded with
// `BOOT_MS` — 30 000 on CI, IDENTICAL to the budget containing it (1.00x).
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** The dock hero glyph width cap (mirrors DOCK_HERO_GLYPH_W). */
const DOCK_HERO_GLYPH_W = 214;

async function gotoWorkflowShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Set the viewport ZOOM and wait for the LOD tier to settle on the shell. */
async function setZoomTier(page: Page, nodeId: string, zoom: number, tier: string): Promise<void> {
  await page.evaluate((z) => {
    const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void } }).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom: z }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    ({ nodeId, tier }) => {
      const el = document.querySelector(
        `.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`,
      );
      return !!el && el.getAttribute('data-shell-tier') === tier;
    },
    { nodeId, tier },
    { timeout: 10_000 },
  );
}

/** Spawn a lone, UNGATED tidyVco (no source, no output — nothing can sound). */
async function spawnLoneTidyVco(page: Page): Promise<void> {
  await spawnPatch(page, [
    { id: 'd-tv', type: 'tidyVco', position: { x: 460, y: 240 }, domain: 'audio', params: {} },
  ]);
}

/** Open the tidyVco dock full-view from its lane tile's expand pill. */
async function openDock(page: Page, nodeId: string) {
  await setZoomTier(page, nodeId, 0.6, 'full');
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`)
    .getByTestId('shell-open-dock')
    .click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  return faceplate;
}

/** Snapshot a dock glyph pane's canvas as a data URL after two settled rAFs. */
async function dockPaneFrame(page: Page, paneTestid: string): Promise<string> {
  return await page.evaluate(async (tid) => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const c = document.querySelector(
      `[data-testid="dock-full-view"] [data-testid="${tid}"] canvas`,
    ) as HTMLCanvasElement | null;
    return c ? c.toDataURL() : '';
  }, paneTestid);
}

/** Parse a DOM-mirrored peak attribute (absent/NaN → 0). */
function peakOf(raw: string | null): number {
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

test.describe('tidyVco DUAL-display glyph (?shell=1)', () => {
  test('(a) dock hero shows BOTH displays; the static morph is non-flat with NO gate/audio', async ({ page }) => {
    await gotoWorkflowShell(page);
    await spawnLoneTidyVco(page);
    const faceplate = await openDock(page, 'd-tv');

    // The glyph cell resolved DUAL.
    await expect(faceplate.locator('[data-glyph-kind="waveform"]')).toHaveAttribute(
      'data-glyph-binding',
      'dual',
    );

    // BOTH panes mounted: the param-derived core waveform + the live trace.
    const wave = faceplate.getByTestId('shell-glyph-wave');
    const trace = faceplate.getByTestId('shell-glyph');
    await expect(wave).toBeVisible();
    await expect(wave).toHaveAttribute('data-mode', 'wave');
    await expect(trace).toBeVisible();
    await expect(trace).toHaveAttribute('data-mode', 'waveform');

    // The STATIC morph is NON-FLAT with no gate and no audio: the default
    // assignment (shape1 0 → saw) draws a full-scale cycle. The live trace,
    // by contrast, is flat — exactly the complaint the dual display fixes.
    expect(peakOf(await wave.getAttribute('data-wave-peak')), 'morph display non-flat ungated').toBeGreaterThan(0.9);
    expect(peakOf(await trace.getAttribute('data-trace-peak')), 'live trace flat ungated').toBeLessThan(0.005);

    // Layout: the pair SPLITS the existing 4-knob-column hero cap — both
    // panes whole (≥ the 40px scope floor), no widening of the band.
    const dualBox = (await faceplate.getByTestId('shell-glyph-dual').boundingBox())!;
    const waveBox = (await wave.boundingBox())!;
    const traceBox = (await trace.boundingBox())!;
    expect(dualBox.width).toBeLessThanOrEqual(DOCK_HERO_GLYPH_W + 2);
    expect(waveBox.width).toBeGreaterThanOrEqual(40);
    expect(traceBox.width).toBeGreaterThanOrEqual(40);
    expect(waveBox.x + waveBox.width, 'panes sit side by side').toBeLessThanOrEqual(traceBox.x + 1);
  });

  test('(b) the static morph re-renders DURING a real SHAPE 1 drag, and the live trace keeps animating', async ({ page }) => {
    await gotoWorkflowShell(page);

    // The REAL default-mode poly chain (the live-glyphs/tidy-vco pattern),
    // driven: POLYSEQZ's own transport → tidyVco poly bus → AUDIOOUT.
    await spawnPatch(
      page,
      [
        { id: 'p-seq-clk', type: 'kria', position: { x: 40, y: 440 }, domain: 'audio', params: { bpm: 240, running: 0 } },
      { id: 'p-seq', type: 'cartesian', position: { x: 40, y: 60 }, domain: 'audio' },
        { id: 'p-tv', type: 'tidyVco', position: { x: 460, y: 240 }, domain: 'audio', params: {} },
        { id: 'p-out', type: 'audioOut', position: { x: 1050, y: 60 }, domain: 'audio',
          params: { master: 0.2 } },
      ],
      [
      { id: 'e_p-seq_clk', from: { nodeId: 'p-seq-clk', portId: 'gate1' }, to: { nodeId: 'p-seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
        { id: 'pe1', from: { nodeId: 'p-seq', portId: 'pitch' }, to: { nodeId: 'p-tv', portId: 'poly' },
          sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
        { id: 'pe2', from: { nodeId: 'p-tv', portId: 'out_l' }, to: { nodeId: 'p-out', portId: 'L' },
          sourceType: 'audio', targetType: 'audio' },
        { id: 'pe3', from: { nodeId: 'p-tv', portId: 'out_r' }, to: { nodeId: 'p-out', portId: 'R' },
          sourceType: 'audio', targetType: 'audio' },
      ],
    );
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes['p-seq'];
        if (!seq) return;
        if (!seq.data) seq.data = {};
        seq.data.cells = Array.from({ length: 16 }, (_, i) => [
          { on: true, midi: 60, chord: 'maj' },
          { on: true, midi: 57, chord: 'min' },
          { on: true, midi: 65, chord: 'maj' },
          { on: true, midi: 62, chord: 'min' },
        ][i % 4]);
      });
    });
    await seedKriaGate(page, 'p-seq-clk');

    const faceplate = await openDock(page, 'p-tv');
    const wave = faceplate.getByTestId('shell-glyph-wave');
    await expect(wave).toBeVisible();

    // Drive the chain so the trace is genuinely animating before the drag.
    await setNodeParams(page, 'p-seq-clk', { running: 1 });
    await expect
      .poll(async () => peakOf(await faceplate.getByTestId('shell-glyph').getAttribute('data-trace-peak')), {
        timeout: 8000,
        message: 'driven trace goes non-flat',
      })
      .toBeGreaterThan(0.05);

    // ── The REAL pointer gesture on SHAPE 1 (KnobConic: vertical drag). ──
    const knob = faceplate.getByTestId('control-shape1');
    await expect(knob).toBeVisible();
    const kb = (await knob.boundingBox())!;
    const cx = kb.x + kb.width / 2;
    const cy = kb.y + kb.height / 2;

    const waveBefore = await dockPaneFrame(page, 'shell-glyph-wave');
    expect(waveBefore.length).toBeGreaterThan(0);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // A few real pointermoves to get the transient stream flowing (still DOWN).
    let dy = 0;
    const step = async () => {
      dy += 12; // ~0.06 of the 0..1 range per step (1/200 px sensitivity)
      await page.mouse.move(cx, cy - dy, { steps: 3 });
    };
    await step();

    // MID-GESTURE (pointer still captured): the static morph pixels CHANGE.
    let waveMid = '';
    await expect
      .poll(
        async () => {
          await step();
          waveMid = await dockPaneFrame(page, 'shell-glyph-wave');
          return waveMid !== waveBefore;
        },
        { timeout: 8000, message: 'static morph re-renders DURING the drag' },
      )
      .toBe(true);

    // …and keeps morphing as the gesture continues (a second distinct frame,
    // still mid-drag — the display tracks the stream, not one repaint).
    await expect
      .poll(
        async () => {
          await step();
          return (await dockPaneFrame(page, 'shell-glyph-wave')) !== waveMid;
        },
        { timeout: 8000, message: 'static morph keeps tracking the gesture' },
      )
      .toBe(true);

    // The LIVE TRACE did not pause under pointer capture: frames keep changing.
    const traceA = await dockPaneFrame(page, 'shell-glyph');
    await expect
      .poll(async () => (await dockPaneFrame(page, 'shell-glyph')) !== traceA, {
        timeout: 5000,
        message: 'live trace keeps animating during the drag',
      })
      .toBe(true);

    await page.mouse.up();

    // The gesture's end state COMMITS: shape1 moved off its default.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params?: Record<string, number> }> };
          };
          return w.__patch.nodes['p-tv']?.params?.shape1 ?? 0;
        }),
      )
      .toBeGreaterThan(0.1);
  });

  test('(c) the compact lane tile prefers the STATIC morph (no trace pane in the row)', async ({ page }) => {
    await gotoWorkflowShell(page);
    await spawnLoneTidyVco(page);

    // zoom 0.45 = the LOD 'compact' band — the design-point lane tile.
    await setZoomTier(page, 'd-tv', 0.45, 'compact');
    const tile = page.locator('.svelte-flow__node[data-id="d-tv"] [data-testid="module-shell"]');

    const wave = tile.getByTestId('shell-glyph-wave');
    await expect(wave).toBeVisible();
    await expect(wave).toHaveAttribute('data-mode', 'wave');
    expect(peakOf(await wave.getAttribute('data-wave-peak')), 'tile morph non-flat ungated').toBeGreaterThan(0.9);

    // The identity, not the (flatlining) live trace: no waveform pane in-row.
    await expect(tile.getByTestId('shell-glyph')).toHaveCount(0);
  });
});
