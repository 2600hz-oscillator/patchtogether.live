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

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pollScopeBandAmp, scopePollMsg } from '../_helpers/scope-poll';

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

/**
 * Poll the scope until we observe the target frequency over `threshold` or the
 * bound fires. Returns the highest amplitude seen.
 *
 * The sampling loop lives at ONE export site and runs INSIDE the page. What it
 * replaces did a CDP round trip per sample AND shipped the whole ch1
 * Float32Array across the wire to reduce it test-side, so the cost of measuring
 * scaled with the thing being measured — on the same main thread as the audio.
 *
 * ⚠ AND IT DISTINGUISHES THE TWO ZEROES. "0" from a poll that never resolved a
 * scope buffer and "0" from a genuinely silent band are the same number meaning
 * opposite things — the ambiguity CLAUDE.md names, where "frozen" and "never
 * looked" are indistinguishable from the output. The off-band probes below
 * ASSERT on a near-zero reading, so a poll that silently saw nothing would
 * confirm them. This fails loudly instead.
 */
async function pollBandAmp(
  page: Page,
  scopeNodeId: string,
  freqHz: number,
  threshold: number,
  boundMs: number,
): Promise<number> {
  const r = await pollScopeBandAmp(page, scopeNodeId, freqHz, threshold, boundMs);
  expect(
    r.samples,
    scopePollMsg(`bandAmp@${freqHz}Hz resolved NO scope buffer, so its 0 is not a measurement`, r),
  ).toBeGreaterThan(0);
  return r.best;
}

/** Open the bluebox's dock full view — the keypad's home on the default
 *  shell (`control-btn_*` momentary buttons in the ladder). */
async function openDock(page: Page) {
  await page.evaluate(
    () => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('bb'),
  );
  // ⚠ Return the DOCK-SCOPED root: the lane tile ranks some of the same
  // `control-btn_*` keys, so a bare page-level locator is ambiguous.
  const dock = page.locator('[data-testid="dock-full-view"][data-fullview-node="bb"]');
  await expect(dock).toBeVisible();
  return dock;
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

test('bluebox: the shell mounts with no console errors and the full keypad', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'bb', type: 'bluebox', position: { x: 100, y: 100 } }]);

  const tile = page.locator('.svelte-flow__node[data-id="bb"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  const dock = await openDock(page);
  // The tone bank hero paints, and all 12 keys render as dock momentary
  // controls (`control-btn_*` — the same button params the keypad card drove).
  await expect(dock.locator('[data-testid="bluebox-tonebank"]')).toBeVisible();
  for (const key of ['0', '5', '9', 'bluebox', 'redbox']) {
    await expect(dock.locator(`[data-testid="control-btn_${key}"]`)).toBeVisible();
  }
});

test('bluebox: clicking "5" produces 770 + 1336 Hz peaks at the scope', async ({ page, rack }) => {
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
  const dock = await openDock(page);
  const key5 = dock.locator('[data-testid="control-btn_5"]');
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

test('bluebox: clicking BLUEBOX produces a 2600 Hz dominant peak', async ({ page, rack }) => {
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

  const dock = await openDock(page);
  const blueKey = dock.locator('[data-testid="control-btn_bluebox"]');
  await blueKey.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0 });
  const amp2600 = await pollBandAmp(page, 'scp', 2600, 0.05, 2000);
  const amp1700 = await pollBandAmp(page, 'scp', 1700, 0, 200);
  await blueKey.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'mouse', button: 0 });

  expect(amp2600).toBeGreaterThan(0.05);
  // BLUEBOX is one tone; the REDBOX freqs must be quiet.
  expect(amp2600).toBeGreaterThan(amp1700 * 5);
});

test('bluebox: clicking REDBOX produces 1700 + 2200 Hz peaks', async ({ page, rack }) => {
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

  const dock = await openDock(page);
  const redKey = dock.locator('[data-testid="control-btn_redbox"]');
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

test('bluebox: setting btn_5 param directly drives the tone (no UI click)', async ({ page, rack }) => {
  // Sanity-check the param→worklet path independent of the keypad UI —
  // this is the same path the Instruments / Group-controls layer uses
  // to surface BLUEBOX's keys on a containing group's bar.

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

// ─── THE FACEPLATE: the tone bank's captions, measured in RENDERED PIXELS ────
//
// ⚠ WHY THIS IS A PIXEL ASSERTION AND NOT A TEXT ONE. The hero panel's caption
// row names which oscillator each bar is, and its LABEL MODE (`Hz` <-> `keys`)
// is also the panel's declared faces-parity probe — which asserts that row's
// text CHANGED, via `toHaveText`, i.e. `textContent`. **A CSS ellipsis leaves no
// trace in `textContent`**, so a caption clipped to `2 5…` would pass
// faces-parity, pass module-face-lint, and pass VRT (whose dock baseline only
// ever captures the DEFAULT `Hz` mode) while the picture's labels quietly
// stopped naming their oscillators. The panel therefore carries no
// `text-overflow` rule at all, and this is the leg proving the layout does not
// need one.
//
// MEASURED (darwin, dock faceplate): the longest caption is `2 5 8 0` at
// 30.92 CSS px; the cell FLOORS at 51 px, because the panel hits its 380 px
// `minWidth` and the dock scrolls rather than shrinking further — so that is
// 20.1 px of margin at the narrowest width reachable at all.
// `Range.getBoundingClientRect` measures the TEXT; `scrollWidth` is the wrong
// instrument here, because it reports the CLAMPED box the moment an overflow
// rule engages, which is exactly the state this exists to detect.
test('bluebox faceplate: no tone-bank caption is clipped, in EITHER label mode', async ({ page }) => {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: 'bb', type: 'bluebox', position: { x: 120, y: 120 } }]);

  const shell = page.locator('.svelte-flow__node[data-id="bb"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  await expect(faceplate.getByTestId('bluebox-tonebank')).toBeVisible();

  /** Every caption whose TEXT is wider than its own cell, in CSS px. */
  const overflows = async (): Promise<string[]> =>
    page.evaluate(() => {
      const row = document.querySelector('[data-testid="bluebox-bank-axis"]');
      const bad: string[] = [];
      for (const el of [...(row?.children ?? [])]) {
        const e = el as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(e);
        const textW = range.getBoundingClientRect().width;
        if (textW > e.clientWidth) {
          bad.push(`"${e.textContent}" ${textW.toFixed(1)} CSS px in a ${e.clientWidth} px cell`);
        }
      }
      return bad;
    });

  const modeButton = faceplate.getByTestId('bluebox-bank-label');
  // The NARROWEST width the dock actually gives the panel: past its 380 px
  // minWidth the pane scrolls instead of shrinking, so this IS the worst case.
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(faceplate.getByTestId('bluebox-bank-axis')).toBeVisible();

  for (const mode of ['Hz', 'keys'] as const) {
    // ⚠ ASSERT THE MODE IS ACTUALLY ENTERED before measuring it — the
    // card-control-overflow lesson: a sweep that re-measures the default layout
    // twice is green about half of what it claims to cover.
    await expect(modeButton, `the caption row is in ${mode} mode`).toHaveText(mode);
    expect(
      (await overflows()).join('; '),
      `${mode} mode: a caption is wider than its cell. With no text-overflow rule it now ` +
        `COLLIDES with its neighbour; with one it would have truncated invisibly and every ` +
        `text-reading gate in the repo would still be green`,
    ).toBe('');
    if (mode === 'Hz') await modeButton.click();
  }
});
