// e2e/tests/live-glyphs.spec.ts
//
// LIVE proof for the glyph primitives (VuMeter + ScopeScreen):
//
//   1. VuMeter (moog914 adoption): wire a live VCO → the 914 filter bank and
//      prove the meter LIGHTS from real audio — both the engine-level source
//      (read('level') RMS > 0) AND the DOM the VuMeter renders (data-lit > 0),
//      versus a silent 914 (no source) reading 0. This is the segments-change-
//      with-level assertion, driven by a REAL signal at the audio thread.
//
//   2. ScopeScreen waveform (showcase): the /dev/glyphs showcase drives the
//      waveform screen with a moving buffer; assert the trace is NON-FLAT via
//      the DOM-exposed `data-trace-peak` (capability-safe — no GPU/pixel read,
//      so it's green on CI's SwiftShader too).
//
//   3. ScopeScreen envelope + wave (adsr / tidyvco adoptions): the screens
//      mount in the right mode on their cards.
//
// The RMS/level path is a plain AnalyserNode read (no H.264 / getUserMedia /
// WebGL), so every assertion here runs identically on CI and locally.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Engine-level output RMS from a module's read('level') handle. */
async function readLevel(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return 0;
    const v = eng.read(node, 'level');
    return typeof v === 'number' ? v : 0;
  }, nodeId);
}

/** The VuMeter root's `data-lit` (segments currently lit) for a module card. */
async function meterLit(page: Page, testid: string): Promise<number> {
  const el = page.locator(`[data-testid="${testid}"]`).first();
  const raw = await el.getAttribute('data-lit');
  return raw ? Number(raw) : 0;
}

test('VuMeter lights from a live 914 output; silent 914 reads zero', async ({ page, rack }) => {
  void rack;
  // A VCO whose SAW output feeds the 914 filter bank input. The 914 bands
  // default to 0.5, so a broadband saw yields audible summed output.
  await spawnPatch(
    page,
    [
      { id: 'vco1', type: 'analogVco', position: { x: 100, y: 100 } },
      { id: 'flt1', type: 'moog914', position: { x: 460, y: 100 } },
      // A second, UNPATCHED 914 as the silent control.
      { id: 'flt2', type: 'moog914', position: { x: 820, y: 100 } },
    ],
    [
      {
        id: 'e1',
        from: { nodeId: 'vco1', portId: 'saw' },
        to: { nodeId: 'flt1', portId: 'audio' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // Give the audio graph a few hundred ms to settle + the analyser to fill.
  await expect
    .poll(() => readLevel(page, 'flt1'), { timeout: 6000, message: 'live 914 RMS' })
    .toBeGreaterThan(0.01);

  // The unpatched 914 stays silent.
  expect(await readLevel(page, 'flt2')).toBeLessThan(0.005);

  // The VuMeter DOM the card renders reflects it: the driven meter lights
  // segments, the silent one is dark. The meter smooths on the shared frame,
  // so poll until it climbs.
  await expect
    .poll(() => meterLit(page, 'moog914-vumeter'), { timeout: 6000, message: 'driven VuMeter lit segments' })
    .toBeGreaterThan(0);

  // (Both 914s share the testid; the first match is the driven one at x=460.
  // The engine-level silent assertion above is the authoritative dark proof.)
});

test('ScopeScreen waveform trace is non-flat when a signal is driven (showcase)', async ({ page }) => {
  await page.goto('/dev/glyphs');
  const screen = page.locator('[data-testid="show-scope-waveform"]');
  await expect(screen).toBeVisible();
  expect(await screen.getAttribute('data-mode')).toBe('waveform');
  // The showcase drives a moving sine into the screen; its per-frame peak is
  // mirrored to data-trace-peak. Poll until a non-flat frame lands.
  await expect
    .poll(
      async () => {
        const raw = await screen.getAttribute('data-trace-peak');
        return raw ? Number(raw) : 0;
      },
      { timeout: 5000, message: 'live waveform trace peak' },
    )
    .toBeGreaterThan(0.05);
});

test('ScopeScreen mounts in envelope mode on ADSR and wave mode on TIDY VCO', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: 'env1', type: 'adsr', position: { x: 100, y: 100 } },
    { id: 'osc1', type: 'tidyVco', position: { x: 100, y: 420 } },
  ]);
  const envScreen = page.locator('[data-testid="adsr-envelope-screen"]').first();
  await expect(envScreen).toBeVisible();
  expect(await envScreen.getAttribute('data-mode')).toBe('envelope');

  const waveScreen = page.locator('[data-testid="tidyvco-wave-screen"]').first();
  await expect(waveScreen).toBeVisible();
  expect(await waveScreen.getAttribute('data-mode')).toBe('wave');
});
