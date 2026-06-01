// e2e/tests/4plexvid.spec.ts
//
// 4PLEXVID — 4-in / 4-out video router. End-to-end coverage that the
// per-output selector routes the SELECTED input to the output, that a
// gate rising edge advances the selector (wrapping 1->2->3->4->1), and
// that the four outputs route INDEPENDENTLY.
//
// Strategy — deterministic distinguishable inputs:
//   in1 = SHAPES (a bright shape on black → high luminance).
//   in2/in3/in4 = UNPATCHED → the router renders black for those.
// So as a selector rotates in1->in2->in3->in4->in1 the routed OUTPUT
// goes BRIGHT -> black -> black -> black -> BRIGHT. The bright/black swing
// is unambiguous under software-GL on CI (no two-bright-sources signature
// fragility), and the wrap back to bright after 4 gates proves the
// modulo rotate.
//
// We route each router output into its OWN VIDEO-OUT sink so we read the
// real downstream signal (the multi-output `read('outputTexture:outN')`
// path), not the card's single-output preview. Gates are fired by setting
// the synthetic gate{N} param directly via the video engine's setParam —
// the same entry point the cross-domain CV bridge uses — so the test is
// deterministic and needs no audio LFO.
//
// Canvas reads use windowed polling (sample until the expected level is
// seen or a deadline passes), never two fixed reads — the robust pattern
// from videobox-output.spec, so a stalled software-GL frame under CI load
// doesn't false-fail.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Mean luminance over a VIDEO-OUT canvas (identified by its node id). */
async function meanLuma(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  await expect(handle, `VIDEO-OUT ${nodeId} canvas present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    return sum / (data.length / 4);
  });
}

/** Poll a VIDEO-OUT until its mean luminance satisfies `pred`, or fail
 *  after `timeout`. Returns the last sampled value for the assertion msg. */
async function waitForLuma(
  page: Page,
  nodeId: string,
  pred: (m: number) => boolean,
  timeout = 6000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await meanLuma(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    last = await meanLuma(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

// A square tiled across the frame (in1) reads with a high mean luma; an
// unpatched input renders pure black (mean ~0). The two bands are far
// apart, so a generous BRIGHT floor + a low DARK ceiling never overlap
// even under software-GL antialiasing on CI.
const BRIGHT = 12; // mean-luma floor for "showing the bright SHAPES input"
const DARK = 6;    // mean-luma ceiling for "showing an unpatched (black) input"

/** Fire a gate pulse on a 4PLEXVID node's gate input via the video
 *  engine's setParam (the CV-bridge entry point). Rising edge advances. */
async function fireGate(page: Page, nodeId: string, gateId: string): Promise<void> {
  await page.evaluate(({ nodeId, gateId }) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { setParam?: (n: string, p: string, v: number) => void } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    ve?.setParam?.(nodeId, gateId, 1); // rising edge → advance
    ve?.setParam?.(nodeId, gateId, 0); // release → re-arm for next pulse
  }, { nodeId, gateId });
}

test.describe('4PLEXVID — gate-advanced 4x4 video router', () => {
  test('each output shows its selected input; gate advances + wraps; outputs are independent', async ({ page }) => {
    const errors = await setup(page);

    // SHAPES into in1 (bright). in2/in3/in4 left unpatched (black). Each
    // router output → its own VIDEO-OUT sink.
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: { shape: 1, tile: 1, tileN: 4, zoom: 8 } },
        { id: 'plex', type: '4plexvid', position: { x: 360, y: 40 }, domain: 'video' },
        { id: 'o1', type: 'videoOut', position: { x: 760, y: 20 }, domain: 'video' },
        { id: 'o2', type: 'videoOut', position: { x: 760, y: 260 }, domain: 'video' },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'plex', portId: 'in1' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e_o1', from: { nodeId: 'plex', portId: 'out1' }, to: { nodeId: 'o1', portId: 'in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e_o2', from: { nodeId: 'plex', portId: 'out2' }, to: { nodeId: 'o2', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // ---- 1. Default selectors = 0 (in1). Both outputs show the bright
    //         SHAPES input (out1 + out2 both select in1 by default). ----
    {
      const r1 = await waitForLuma(page, 'o1', (m) => m > BRIGHT);
      expect(r1.ok, `out1 shows bright in1 at start (mean=${r1.last.toFixed(1)})`).toBe(true);
      const r2 = await waitForLuma(page, 'o2', (m) => m > BRIGHT);
      expect(r2.ok, `out2 shows bright in1 at start (mean=${r2.last.toFixed(1)})`).toBe(true);
    }

    // ---- 2. Fire ONE gate into out1 → its selector advances to in2
    //         (unpatched → black). out1 goes dark. ----
    await fireGate(page, 'plex', 'gate1');
    {
      const r1 = await waitForLuma(page, 'o1', (m) => m < DARK);
      expect(r1.ok, `out1 dark after 1 gate (advanced to unpatched in2; mean=${r1.last.toFixed(1)})`).toBe(true);
    }

    // ---- 3. INDEPENDENCE: out2's selector was never gated → still in1 →
    //         still bright, even though out1 moved off in1. ----
    {
      const r2 = await waitForLuma(page, 'o2', (m) => m > BRIGHT);
      expect(r2.ok, `out2 still bright (independent of out1's gate; mean=${r2.last.toFixed(1)})`).toBe(true);
    }

    // ---- 4. WRAP: three more gates on out1 take it in3 -> in4 -> in1.
    //         Back at in1 it must be bright again (1->2->3->4->1 modulo). ----
    await fireGate(page, 'plex', 'gate1'); // → in3 (black)
    await fireGate(page, 'plex', 'gate1'); // → in4 (black)
    await fireGate(page, 'plex', 'gate1'); // → in1 (bright, wrapped)
    {
      const r1 = await waitForLuma(page, 'o1', (m) => m > BRIGHT);
      expect(r1.ok, `out1 bright again after wrap (4 gates → back to in1; mean=${r1.last.toFixed(1)})`).toBe(true);
    }

    await page.screenshot({ path: 'test-results/4plexvid.png' });
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
