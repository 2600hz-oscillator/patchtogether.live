// e2e/tests/bluebox.spec.ts
//
// BLUEBOX end-to-end smoke. Spawn BLUEBOX + SCOPE, patch the audio
// output into ch1, click each test button, and confirm the analyser
// sees the expected spectral peaks. Three flavours:
//
//   1. Digit "5"          → peaks near 770 + 1336 Hz, silent off-band.
//   2. BLUEBOX phreaker   → dominant 2600 Hz peak.
//   3. REDBOX phreaker    → two peaks at 1700 + 2200 Hz.
//
// Detection: SCOPE's `snapshot` exposes both an AnalyserNode FFT bin
// array (.ch1Freq, log-magnitude in dB) and the raw time-domain ch1
// samples. We use a Goertzel on the time-domain samples — simpler than
// reading bin indices and produces a per-frequency magnitude we can
// compare against an off-band reference (500 Hz).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// ─── helpers ────────────────────────────────────────────────────────────────

async function readScopeChannel(
  page: Page,
  scopeNodeId: string,
): Promise<{ ch1: Float32Array; sampleRate: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return null;
    return {
      ch1: Array.from(snap.ch1) as unknown as Float32Array,
      sampleRate: snap.sampleRate,
    };
  }, scopeNodeId);
}

/** Goertzel-style band magnitude — same shape as the unit-test helper. */
function bandAmp(buf: Float32Array | number[], freqHz: number, sr: number): number {
  const w = 2 * Math.PI * freqHz / sr;
  let re = 0;
  let im = 0;
  const n = buf.length;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i] ?? 0;
    re += v * Math.cos(w * i);
    im += v * Math.sin(w * i);
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

/** Poll the scope until we observe the target frequency over `threshold`
 *  or the deadline fires. Returns the highest amplitude seen. */
async function pollBandAmp(
  page: Page,
  scopeNodeId: string,
  freqHz: number,
  threshold: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let best = 0;
  while (Date.now() < deadline) {
    const snap = await readScopeChannel(page, scopeNodeId);
    if (snap) {
      const amp = bandAmp(snap.ch1, freqHz, snap.sampleRate);
      if (amp > best) best = amp;
      if (best > threshold) return best;
    }
    await page.waitForTimeout(50);
  }
  return best;
}

/** Set a node's button param via the live store (no UI click — used in
 *  the test that asserts the param surface works without the keypad). */
async function setBlueboxParam(page: Page, nodeId: string, paramId: string, value: number) {
  await page.evaluate(
    ({ id, p, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[p] = v;
      });
    },
    { id: nodeId, p: paramId, v: value },
  );
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('bluebox: card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'bb', type: 'bluebox', position: { x: 100, y: 100 } }]);

  const card = page.locator('[data-testid="bluebox-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('BLUEBOX');
  // All 12 keys render with their dedicated testids.
  await expect(page.locator('[data-testid="bluebox-key-0"]')).toBeVisible();
  await expect(page.locator('[data-testid="bluebox-key-5"]')).toBeVisible();
  await expect(page.locator('[data-testid="bluebox-key-9"]')).toBeVisible();
  await expect(page.locator('[data-testid="bluebox-key-bluebox"]')).toBeVisible();
  await expect(page.locator('[data-testid="bluebox-key-redbox"]')).toBeVisible();
  expect(errors, errors.join('; ')).toEqual([]);
});

test('bluebox: clicking "5" produces 770 + 1336 Hz peaks at the scope', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'bb',  type: 'bluebox', position: { x: 80,  y: 80 } },
      { id: 'scp', type: 'scope',   position: { x: 380, y: 80 },
        params: { timeMs: 100, ch1Range: 1 } },
      // Audio out is required so the engine's tail node keeps the graph
      // alive even if the scope is the only audible sink; master=0 mutes
      // speakers since we only need the analyser tap.
      { id: 'out', type: 'audioOut', position: { x: 680, y: 80 },
        params: { master: 0.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'bb',  portId: 'out' },     to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await page.waitForTimeout(200);

  // Silence-baseline: no buttons held — confirm the scope sees ~zero
  // at the row freq before we press anything (rules out a ghost tone).
  {
    const snap = await readScopeChannel(page, 'scp');
    if (snap) {
      const ampSilence = bandAmp(snap.ch1, 770, snap.sampleRate);
      expect(ampSilence).toBeLessThan(0.02);
    }
  }

  // Press "5" via the UI — dispatch a pointerdown and hold while we
  // poll the scope. Skip pointerup until after we've measured so the
  // tone stays on.
  const key5 = page.locator('[data-testid="bluebox-key-5"]');
  await key5.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 });

  // 770 Hz row + 1336 Hz col peaks must both rise above silence; an
  // off-band probe at 500 Hz must stay quiet.
  const ampRow = await pollBandAmp(page, 'scp', 770, 0.05, 2000);
  const ampCol = await pollBandAmp(page, 'scp', 1336, 0.05, 2000);
  const ampOff = await pollBandAmp(page, 'scp', 500, 0, 200);

  await key5.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0 });

  expect(ampRow, `770 Hz peak too low; off-band at 500 Hz was ${ampOff.toFixed(4)}`)
    .toBeGreaterThan(0.05);
  expect(ampCol, `1336 Hz peak too low; off-band at 500 Hz was ${ampOff.toFixed(4)}`)
    .toBeGreaterThan(0.05);
  expect(ampOff).toBeLessThan(ampRow * 0.5);
  expect(ampOff).toBeLessThan(ampCol * 0.5);
});

test('bluebox: clicking BLUEBOX produces a 2600 Hz dominant peak', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'bb',  type: 'bluebox', position: { x: 80,  y: 80 } },
      { id: 'scp', type: 'scope',   position: { x: 380, y: 80 },
        params: { timeMs: 100, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 680, y: 80 },
        params: { master: 0.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'bb',  portId: 'out' },     to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(200);

  const blueKey = page.locator('[data-testid="bluebox-key-bluebox"]');
  await blueKey.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0 });
  const amp2600 = await pollBandAmp(page, 'scp', 2600, 0.05, 2000);
  const amp1700 = await pollBandAmp(page, 'scp', 1700, 0, 200);
  await blueKey.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'mouse', button: 0 });

  expect(amp2600).toBeGreaterThan(0.05);
  // BLUEBOX is one tone; the REDBOX freqs must be quiet.
  expect(amp2600).toBeGreaterThan(amp1700 * 5);
});

test('bluebox: clicking REDBOX produces 1700 + 2200 Hz peaks', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'bb',  type: 'bluebox', position: { x: 80,  y: 80 } },
      { id: 'scp', type: 'scope',   position: { x: 380, y: 80 },
        params: { timeMs: 100, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 680, y: 80 },
        params: { master: 0.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'bb',  portId: 'out' },     to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(200);

  const redKey = page.locator('[data-testid="bluebox-key-redbox"]');
  await redKey.dispatchEvent('pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0 });
  const amp1700 = await pollBandAmp(page, 'scp', 1700, 0.05, 2000);
  const amp2200 = await pollBandAmp(page, 'scp', 2200, 0.05, 2000);
  const amp2600 = await pollBandAmp(page, 'scp', 2600, 0, 200);
  await redKey.dispatchEvent('pointerup', { pointerId: 3, pointerType: 'mouse', button: 0 });

  expect(amp1700).toBeGreaterThan(0.05);
  expect(amp2200).toBeGreaterThan(0.05);
  // 2600 belongs to BLUEBOX, NOT REDBOX.
  expect(amp1700).toBeGreaterThan(amp2600 * 3);
  expect(amp2200).toBeGreaterThan(amp2600 * 3);
});

test('bluebox: setting btn_5 param directly drives the tone (no UI click)', async ({ page }) => {
  // Sanity-check the param→worklet path independent of the keypad UI —
  // this is the same path the Instruments / Group-controls layer uses
  // to surface BLUEBOX's keys on a containing group's bar.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'bb',  type: 'bluebox', position: { x: 80,  y: 80 } },
      { id: 'scp', type: 'scope',   position: { x: 380, y: 80 },
        params: { timeMs: 100, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 680, y: 80 },
        params: { master: 0.0 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'bb',  portId: 'out' },     to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await page.waitForTimeout(200);

  await setBlueboxParam(page, 'bb', 'btn_5', 1);
  const ampRow = await pollBandAmp(page, 'scp', 770, 0.05, 2000);
  await setBlueboxParam(page, 'bb', 'btn_5', 0);
  expect(ampRow).toBeGreaterThan(0.05);
});
