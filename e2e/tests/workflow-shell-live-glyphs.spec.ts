// e2e/tests/workflow-shell-live-glyphs.spec.ts
//
// LIVE shell-face glyphs (P1 batch-1 owner feedback: "LIVE, not static") —
// the tidyVco DOCK HERO glyph proven end to end under `?shell=1`:
//
//   1. The dock glyph mounts in ScopeScreen's LIVE 'waveform' mode (an
//      analyser tap on the module's primary audio output) — not the old
//      static 'wave' buffer.
//   2. SILENT (the REAL source chain present but its transport stopped): the
//      trace stays flat (data-trace-peak ≈ 0) and the canvas is STATIC —
//      byte-identical frames over time.
//   3. DRIVEN via the REAL default-mode source chain (POLYSEQZ's own
//      transport → tidyVco poly chord bus → AUDIOOUT, the tidy-vco.spec
//      pattern): the trace goes non-flat AND the canvas pixels CHANGE
//      frame to frame.
//   4. The dock hero LAYOUT: the DUAL pair (param-derived core waveform +
//      live trace — tidyVco's 'dual' binding) is capped to the first four
//      knob columns (214px, split between the panes) and does NOT span the
//      faceplate width. (The dual behavior itself — static morph always-on,
//      live-while-twisting — is workflow-shell-dual-glyph.spec.ts.)
//
// Liveness is asserted through the DOM-mirrored `data-trace-peak` seam
// (capability-safe — no GPU read); the canvas-change assertion reads the 2D
// canvas via toDataURL (plain CPU canvas — identical on CI's SwiftShader).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, seedKriaGate } from './_helpers';
import { setNodeParams } from './_module-coverage-helpers';
import { BOOT_MS } from '../_helpers/boot-budget';
import { waitFrames } from '../_helpers/frames';

/** Painted frames the SILENT glyph must stay byte-identical across. FRAMES, not
 *  ms: the glyph repaints once per rAF, so "static" is a claim about frames and
 *  a duration would mean a different claim on every renderer. */
const STATIC_GLYPH_FRAMES = 16;

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

/** data-trace-peak of the DOCK full-view glyph (NaN → 0). */
async function dockTracePeak(page: Page): Promise<number> {
  const raw = await page
    .getByTestId('dock-full-view')
    .getByTestId('shell-glyph')
    .getAttribute('data-trace-peak');
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Snapshot the dock glyph canvas as a data URL after two settled rAFs. */
async function dockGlyphFrame(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const c = document.querySelector(
      '[data-testid="dock-full-view"] [data-testid="shell-glyph"] canvas',
    ) as HTMLCanvasElement | null;
    return c ? c.toDataURL() : '';
  });
}

test.describe('LIVE shell glyphs (?shell=1)', () => {
  test('tidyVco dock hero glyph: static-silent, then MOVES when the real POLYSEQZ chain drives audio', async ({ page }) => {
    await gotoWorkflowShell(page);

    // The REAL default-mode poly chain (tidy-vco.spec pattern) with the
    // transport STOPPED — the silent control state.
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

    // Seed gated chord steps (they only play once the transport starts).
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
    await seedKriaGate(page, 'p-seq-clk');
    });

    // Open the tidyVco dock full-view from the lane tile's expand pill.
    await setZoomTier(page, 'p-tv', 0.6, 'full');
    const shell = page.locator('.svelte-flow__node[data-id="p-tv"] [data-testid="module-shell"]');
    await shell.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();

    // 1) LIVE mode mounted: tidyVco binds DUAL (param-wave + live trace) —
    //    the LIVE TRACE pane is ScopeScreen's 'waveform' mode bound to the
    //    audio tap, riding next to the param-derived core-waveform pane.
    const glyph = faceplate.getByTestId('shell-glyph');
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveAttribute('data-mode', 'waveform');
    await expect(
      faceplate.locator('[data-glyph-kind="waveform"]'),
    ).toHaveAttribute('data-glyph-binding', 'dual');

    // 4) The dock hero LAYOUT: the dual pair is CAPPED at the 4-knob-column
    //    width (the panes SPLIT it) rather than stretching to the plate.
    const dualBox = (await faceplate.getByTestId('shell-glyph-dual').boundingBox())!;
    const glyphBox = (await glyph.boundingBox())!;
    const plateBox = (await faceplate.boundingBox())!;
    expect(dualBox.width, 'dual hero spans the first 4 knob columns').toBeLessThanOrEqual(DOCK_HERO_GLYPH_W + 2);
    expect(dualBox.width).toBeGreaterThanOrEqual(DOCK_HERO_GLYPH_W - 2);
    expect(glyphBox.width, 'the trace pane keeps the 40px scope floor').toBeGreaterThanOrEqual(40);
    // ⚠ THIS USED TO READ "blank space remains to the hero's right", against the
    // plate's MIDPOINT — and it passed only because the plate was padded to
    // 900 px by `.faceplate-body`'s min-width while tidyVco's real content is
    // 431 px. #1796 removed that floor (owner: *"we do not want useless gray
    // horizontal space on cards, ever"*), so the plate is now 464 px, half of
    // it is 282, and a hero correctly capped at 214 px ends at 299 — past the
    // midpoint of a plate that is no longer twice the size it needs to be.
    //
    // The claim worth keeping is that the hero is CAPPED, not STRETCHED, and
    // the two assertions directly above already pin the cap to ±2 px. What this
    // adds is that the cap is a real constraint on THIS plate — the hero must
    // be strictly narrower than the faceplate and end inside it — which is a
    // relation rather than a proxy for the old padding.
    expect(
      DOCK_HERO_GLYPH_W,
      'the 4-column cap must actually constrain this plate, or "capped" says nothing',
    ).toBeLessThan(plateBox.width);
    expect(
      dualBox.x + dualBox.width,
      'the hero ends INSIDE the faceplate rather than spanning it',
    ).toBeLessThan(plateBox.x + plateBox.width);

    // 2) SILENT: the live trace is present but FLAT and the canvas is STATIC.
    //    (Wait until the glyph has painted at least one live frame first —
    //    the peak attribute is mirrored per painted frame.)
    await expect
      .poll(async () => (await glyph.getAttribute('data-trace-peak')) !== null, {
        timeout: 5000,
        message: 'live glyph painted a frame',
      })
      .toBe(true);
    expect(await dockTracePeak(page), 'silent chain → flat trace').toBeLessThan(0.005);
    const silentA = await dockGlyphFrame(page);
    // The claim is "the glyph canvas does not CHANGE ACROSS PAINTED FRAMES", so
    // the window has to be measured in frames. 300 ms was ~18 frames on a local
    // GPU and ~2 under CI's SwiftShader (7.9 fps measured) — the same source
    // line making a much weaker claim on the machine that runs it. The positive
    // control is step 3 below: once the chain is driven, the SAME canvas read
    // must differ. Sixteen frames is well past the flat-vs-moving boundary that
    // control demonstrates.
    await waitFrames(page, STATIC_GLYPH_FRAMES);
    const silentB = await dockGlyphFrame(page);
    expect(silentA.length, 'canvas snapshot resolved').toBeGreaterThan(0);
    expect(silentB, 'silent glyph canvas is static (byte-identical frames)').toBe(silentA);
    expect(await dockTracePeak(page), 'still flat after the window').toBeLessThan(0.005);

    // 3) DRIVE the real chain: start POLYSEQZ's own transport.
    await setNodeParams(page, 'p-seq-clk', { running: 1 });
    await expect
      .poll(() => dockTracePeak(page), { timeout: 8000, message: 'driven trace goes non-flat' })
      .toBeGreaterThan(0.05);

    // …and the canvas pixels actually CHANGE frame to frame.
    const drivenA = await dockGlyphFrame(page);
    await expect
      .poll(async () => (await dockGlyphFrame(page)) !== drivenA, {
        timeout: 5000,
        message: 'driven glyph canvas repaints a different frame',
      })
      .toBe(true);
  });
});
