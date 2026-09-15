// SAMSLOOP NORMALIZE + DENOISE — the two in-place transforms, on the shipping
// shell, proved by AUDIBLE OUTPUT and by the bytes the worklet plays.
//
// ⚠ THE FILENAME IS DELIBERATE. Checked against `e2e/webgl-heavy-globs.ts`:
// `samsloop*` matches nothing there, so this runs in the ordinary sharded e2e
// lane (a spec swept into the heavy lane runs in NO job on a pull request).
//
// OWNER (2026-09-11): "samsloop should have a normalize button intended for
// low-volume vocal samples which normalizes the buffer … we also want a
// Denoise button that attempts to remove unwanted background noise or tape
// hiss." Rulings (2026-09-15): in-place PCM rewrite (an upload then exports
// as WAV), NOT undoable like REC, NORMALIZE to 0 dBFS after DC removal with
// silence / already-full-scale REFUSED, and DENOISE on a pad REFUSED with
// "no steady noise floor found".
//
// ── WHAT THIS PINS, AND WHY BYTES-PRESENCE WOULD NOT ────────────────────────
//   ⚠ IN THE FACE'S ORDER: DENOISE FIRST, THEN NORMALIZE — the order the
//   sample page ranks them in and the docs prescribe. The first cut of this
//   spec pressed NORMALIZE first, and that hid a defect the reviewer found:
//   the DC offset this fixture carries defeated DENOISE (read as signal in
//   bins 0–3, the take was refused as a pad) and only NORMALIZE's offset
//   removal, run first, made the leg pass. Now the offset is STILL THERE when
//   DENOISE runs, as it is for a player.
//   1. A quiet, hissy, DC-offset vocal-shaped upload (built here, no new
//      fixture) plays QUIETLY (positive control). DENOISE rewrites it as a
//      `sample` record: the hiss in the GAPS between syllables drops by a
//      stated dB while the syllables stay within a dB (decoded in-page from
//      the bytes the worklet plays, AC — the offset removed per segment), the
//      OFFSET SURVIVES (it is NORMALIZE's to remove and report), the status
//      line says the floor, and the take is still quiet and audible.
//   2. NORMALIZE then lifts it to full scale, reports the +0.01 offset DENOISE
//      left for it, and the TRIGGER produces a peak near 1.0 at the terminal
//      scope — the LOUDER buffer reached the worklet (evidence P3: presence is
//      not liveness). A SECOND DENOISE refuses ("already denoised"): the
//      marker rode through the normalize.
//   3. The transformed sample SURVIVES a save → fresh-page → load: audible
//      again, bytes identical, and the waveform paints the same picture.
//   4. Refusals reach the PLAYER: a silent upload → "silent"; a pad → "no
//      steady noise floor"; neither writes a record.
//
// ⚠ THE TAB CLICK IS CONDITIONAL. samsloop declares two pages and the dock
// rail only becomes real tabs above `DOCK_TAB_MIN_BANDS`; today there is no
// `faceplate-tab-sample`, so clicking it unconditionally would be the
// invisible 30 s timeout. The `toBeVisible` on the cell is what holds.
//
// Every wait is `expect.poll` on observable state (boundary 2); the only
// `waitForTimeout` is none.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';
import {
  buildTestWav,
  openSamsloopPane,
  readSample,
  readSamplePcmStats,
  readWaveformLitPixels,
  seededNoise,
  wavPcmStats,
} from './_samsloop-helpers';

const RATE = 24_000;
const SECONDS = 2.4;
/** Syllable cadence: 0.35 s ON, 0.25 s OFF — four syllables with real gaps. */
const ON_S = 0.35;
const PERIOD_S = 0.6;
const HISS_RMS_DB = -45;
const VOWEL_PEAK = 0.06; // ≈ −24 dBFS: a quiet vocal take
const DC = 0.01;

const SYLLABLES: Array<[number, number]> = [0, 1, 2, 3].map((k) => [k * PERIOD_S + 0.02, k * PERIOD_S + ON_S - 0.02]);
const GAPS: Array<[number, number]> = [0, 1, 2, 3].map((k) => [k * PERIOD_S + ON_S + 0.03, (k + 1) * PERIOD_S - 0.03]);

/** The quiet, hissy, DC-offset "vocal": three formants gated by syllables,
 *  seeded white hiss throughout, a constant offset. */
function hissyVocalWav(): Buffer {
  const rnd = seededNoise(0xc0ffee);
  const hissAmp = 10 ** (HISS_RMS_DB / 20) * Math.sqrt(12); // uniform ±a/2 has rms a/√12
  return buildTestWav({
    rate: RATE,
    seconds: SECONDS,
    sample: (_i, t) => {
      const on = t % PERIOD_S < ON_S;
      let v = 0;
      if (on) {
        // A 20 ms raised-cosine edge so the syllable is a note, not a click.
        const ph = t % PERIOD_S;
        const env = Math.min(1, ph / 0.02, (ON_S - ph) / 0.02);
        for (const [f, a] of [[220, 0.55], [660, 0.3], [1100, 0.15]] as const) {
          v += a * Math.sin(2 * Math.PI * f * t);
        }
        v *= VOWEL_PEAK * env;
      }
      return v + hissAmp * rnd() + DC;
    },
  });
}

/** A steady five-partial drone — the owner's pad. No gap, no floor to find. */
function padWav(): Buffer {
  return buildTestWav({
    rate: RATE,
    seconds: 2,
    sample: (_i, t) => {
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * 110 * h * t) / h;
      return 0.3 * v;
    },
  });
}

function silentWav(): Buffer {
  return buildTestWav({ rate: RATE, seconds: 1, sample: () => 0 });
}

async function setupPage(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

function nodes(): SpawnNode[] {
  return [
    { id: 's', type: 'samsloop', position: { x: 400, y: 200 }, params: { mode: 1 } },
    { id: 'scp', type: 'scope', position: { x: 700, y: 200 } },
  ];
}
function edges(): SpawnEdge[] {
  return [
    {
      id: 'e2',
      from: { nodeId: 's', portId: 'out' },
      to: { nodeId: 'scp', portId: 'ch1' },
      sourceType: 'audio',
      targetType: 'audio',
    },
  ];
}

async function uploadWav(pane: Locator, buffer: Buffer, name: string): Promise<void> {
  await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({ name, mimeType: 'audio/wav', buffer });
  await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toContainText(/loaded \d+ samples/i, {
    timeout: 10_000,
  });
}

/** The sample page's tab, WHEN the rail has one (see the header). */
async function openSamplePage(page: Page): Promise<void> {
  const tab = page.getByTestId('faceplate-tab-sample');
  if ((await tab.count()) > 0) await tab.click();
}

function transformCell(pane: Locator, key: 'denoise' | 'normalize'): Locator {
  return pane.locator(`[data-cell-key="samsloop-${key}-{n}"] button`);
}

/**
 * TRIGGER until the scope hears at least `floor`, then SAMPLE A SECOND TIME
 * and return THAT window's peak — "sample twice, assert on the second": the
 * first window validated the module is sounding; the second is the reading.
 */
async function triggerThenMeasure(page: Page, pane: Locator, floor: number): Promise<number> {
  const trig = pane.getByTestId('shell-cell-samsloop-trigger');
  await expect
    .poll(
      async () => {
        await trig.click();
        const w = await readScopePeakOverWindow(page, 'scp', 500, { untilPeak: floor });
        return w.peak;
      },
      { timeout: 20_000, message: `TRIGGER produces output above ${floor}` },
    )
    .toBeGreaterThan(floor);
  // The loop is running (mode = 1): read a full window with no early exit.
  const w = await readScopePeakOverWindow(page, 'scp', 600, {});
  test.info().annotations.push({ type: 'scope', description: describeScopeWindow(w) });
  return w.peak;
}

async function saveEnvelope(page: Page): Promise<unknown> {
  const env = await page.evaluate(() => {
    const w = window as unknown as { __persistence?: { save?: () => unknown } };
    return w.__persistence?.save?.();
  });
  expect(env, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  return env;
}

async function freshLoad(page: Page, envelope: unknown): Promise<void> {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const w = window as unknown as { __persistence?: { load?: (e: unknown) => unknown }; __ensureEngine?: unknown };
    return typeof w.__persistence?.load === 'function' && typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  await page.evaluate((env) => {
    const w = window as unknown as { __persistence?: { load?: (e: unknown) => unknown } };
    w.__persistence!.load!(env);
  }, envelope);
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="samsloop"])')).toHaveCount(1, {
    timeout: 10_000,
  });
}

async function sampleHash(page: Page, id: string): Promise<number> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { sample?: { bytesB64: string } } }> } };
    const b = w.__patch.nodes[nid]?.data?.sample?.bytesB64 ?? '';
    let h = 0;
    for (let i = 0; i < b.length; i++) h = ((h << 5) - h + b.charCodeAt(i)) | 0;
    return h;
  }, id);
}

test.describe('SAMSLOOP normalize + denoise', () => {
  test('quiet hissy upload: DENOISE → gaps drop, offset kept; NORMALIZE → audible at full scale; second DENOISE refuses; survives reload', async ({ page }) => {
    test.setTimeout(120_000); // four scope windows, a worker STFT and a reload on a SwiftShader runner
    const errors = await setupPage(page);
    await spawnPatch(page, nodes(), edges());
    const pane = await openSamsloopPane(page, 's');
    const wav = hissyVocalWav();
    await uploadWav(pane, wav, 'quiet-hissy-vocal.wav');
    await openSamplePage(page);

    const normalize = transformCell(pane, 'normalize');
    const denoise = transformCell(pane, 'denoise');
    await expect(denoise, 'DENOISE is on the faceplate').toBeVisible();
    await expect(normalize, 'NORMALIZE is on the faceplate').toBeVisible();
    // DENOISE precedes NORMALIZE in the DOM — the processing order, and the
    // order this spec presses them in.
    const keys = await pane.locator('[data-cell-key^="samsloop-"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-cell-key')),
    );
    expect(keys.indexOf('samsloop-denoise-{n}')).toBeLessThan(keys.indexOf('samsloop-normalize-{n}'));

    const status = pane.getByTestId('samsloop-face-transform-status');
    await expect(status, 'absent at rest').toHaveCount(0);

    // ── POSITIVE CONTROL: the take plays, and it is QUIET ──────────────────
    const quietPeak = await triggerThenMeasure(page, pane, 0.02);
    expect(quietPeak, `quiet before any transform (peak ${quietPeak.toFixed(3)})`).toBeLessThan(0.3);

    // ── DENOISE FIRST, on the take AS UPLOADED (offset and all) ──────────
    const before = wavPcmStats(wav, [...SYLLABLES, ...GAPS]);
    expect(before.mean, 'the fixture carries the offset').toBeCloseTo(DC, 3);
    const gapsBefore = before.segDb.slice(SYLLABLES.length);
    const vowelsBefore = before.segDb.slice(0, SYLLABLES.length);
    await denoise.click();
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText(/denoised −\d+\.\d dB in the gaps, floor −\d+ dBFS/);
    await expect(status).toContainText(/written 16-bit mono @ 24\.0 kHz/);

    const rec = await readSample(page, 's');
    expect(rec, 'the upload became a sample record').not.toBeNull();
    expect(rec!.bits).toBe(16);
    expect(rec!.channels).toBe(1);
    expect(rec!.rate).toBe(RATE);
    expect(rec!.durationSec).toBeCloseTo(SECONDS, 2);
    const uploadKeys = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: Record<string, unknown> }> } };
      const d = w.__patch.nodes['s']?.data ?? {};
      return ['fileBytesB64', 'fileName', 'fileMime', 'fileSize'].filter((k) => k in d);
    });
    expect(uploadKeys, 'the upload keys are gone (EXPORT now ships a WAV)').toEqual([]);

    const afterDen = await readSamplePcmStats(page, 's', [...SYLLABLES, ...GAPS]);
    const gapsAfter = afterDen!.segDb.slice(SYLLABLES.length);
    const vowelsAfter = afterDen!.segDb.slice(0, SYLLABLES.length);
    const gapDrop = gapsBefore.map((b, i) => b - gapsAfter[i]!);
    const vowelMove = vowelsBefore.map((b, i) => Math.abs(b - vowelsAfter[i]!));
    const denoiseLine = await status.textContent();
    for (const d of gapDrop) expect(d, 'hiss in the gap drops ≥ 6 dB').toBeGreaterThan(6);
    for (const m of vowelMove) expect(m, 'the syllable stays within 1.5 dB').toBeLessThan(1.5);
    expect(afterDen!.mean, 'DENOISE leaves the offset for NORMALIZE').toBeCloseTo(DC, 3);
    expect(afterDen!.peak, 'DENOISE did not change the level').toBeLessThan(0.3);
    const denoised = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { sample?: { denoised?: boolean } } }> } };
      return w.__patch.nodes['s']?.data?.sample?.denoised;
    });
    expect(denoised, 'the record carries the marker').toBe(true);

    // Still audible, still quiet: the denoised buffer reached the worklet.
    const stillQuiet = await triggerThenMeasure(page, pane, 0.02);
    expect(stillQuiet).toBeLessThan(0.3);

    // ── NORMALIZE, on the denoised record ────────────────────────────────
    const hashAfterDenoise = await sampleHash(page, 's');
    await normalize.click();
    await expect(status).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
    await expect(status).toContainText(/normalized \+\d+\.\d dB/);
    await expect(status).toContainText(/dc \+0\.01/); // the offset DENOISE kept, removed here
    await expect(status).toContainText(/written 16-bit mono @ 24\.0 kHz/);
    await expect.poll(() => sampleHash(page, 's'), { message: 'a new record' }).not.toBe(hashAfterDenoise);

    const afterNorm = await readSamplePcmStats(page, 's', [...SYLLABLES, ...GAPS]);
    expect(afterNorm!.peak, 'peak on full scale').toBeGreaterThan(0.999);
    expect(Math.abs(afterNorm!.mean), 'the offset is gone').toBeLessThan(0.001);
    const carried = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { sample?: { denoised?: boolean } } }> } };
      return w.__patch.nodes['s']?.data?.sample?.denoised;
    });
    expect(carried, 'the marker rides through the normalize').toBe(true);

    // AUDIBLE, LOUDER: the rewritten buffer reached the worklet.
    const loudPeak = await triggerThenMeasure(page, pane, 0.5);
    expect(loudPeak, `full-scale after normalize (peak ${loudPeak.toFixed(3)})`).toBeGreaterThan(0.5);
    expect(loudPeak / Math.max(quietPeak, 1e-6), 'the gain reached the output').toBeGreaterThan(3);

    const measured =
      `quiet peak ${quietPeak.toFixed(3)} → denoised peak ${stillQuiet.toFixed(3)} → normalized peak ${loudPeak.toFixed(3)}; ` +
      `gap drop dB ${gapDrop.map((v) => v.toFixed(1)).join(', ')}; ` +
      `vowel move dB ${vowelMove.map((v) => v.toFixed(2)).join(', ')}; ` +
      `offset after denoise ${afterDen!.mean.toFixed(4)}; ` +
      `denoise status "${denoiseLine}"; normalize status "${await status.textContent()}"`;
    test.info().annotations.push({ type: 'transform', description: measured });
    console.log(`[samsloop-transform] ${measured}`);

    // ── A SECOND DENOISE REFUSES, and writes nothing ──────────────────────
    const hashBefore = await sampleHash(page, 's');
    await denoise.click();
    await expect(status).toHaveAttribute('data-phase', 'refused', { timeout: 10_000 });
    await expect(status).toContainText(/already denoised/i);
    expect(await sampleHash(page, 's')).toBe(hashBefore);

    // ── PERSISTENCE: reload → audible, bytes identical, same picture ─────
    const litBefore = await readWaveformLitPixels(page, 's');
    expect(litBefore, 'the waveform paints the transformed sample').toBeGreaterThan(200);
    const env = await saveEnvelope(page);
    await freshLoad(page, env);
    const pane2 = await openSamsloopPane(page, 's');
    expect(await sampleHash(page, 's'), 'bytes survive the round trip').toBe(hashBefore);
    const reloaded = await triggerThenMeasure(page, pane2, 0.5);
    expect(reloaded, 'the transformed sample plays after a fresh load').toBeGreaterThan(0.5);
    await expect
      .poll(() => readWaveformLitPixels(page, 's'), { message: 'the waveform repaints from the record' })
      .toBeGreaterThan(200);
    const litAfter = await readWaveformLitPixels(page, 's');
    expect(Math.abs(litAfter - litBefore) / litBefore, 'the same picture (±40 %)').toBeLessThan(0.4);
    // No stale status line survives the new page.
    await expect(page.getByTestId('samsloop-face-transform-status')).toHaveCount(0);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('refusals reach the player: a SILENT sample and a PAD, neither written', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await setupPage(page);
    await spawnPatch(page, nodes(), edges());
    const pane = await openSamsloopPane(page, 's');
    await openSamplePage(page);
    const status = pane.getByTestId('samsloop-face-transform-status');

    // SILENT → NORMALIZE refuses with "silent" (owner ruling 3).
    await uploadWav(pane, silentWav(), 'silence.wav');
    await transformCell(pane, 'normalize').click();
    await expect(status).toHaveAttribute('data-phase', 'refused', { timeout: 20_000 });
    await expect(status).toContainText(/silent/i);
    expect(await readSample(page, 's'), 'nothing written').toBeNull();

    // PAD → DENOISE refuses with "no steady noise floor" (owner ruling 4).
    await uploadWav(pane, padWav(), 'pad.wav');
    // The upload changed the sample: the old refusal is stale and retired.
    await expect(status, 'a stale refusal does not survive a new sample').toHaveCount(0);
    await transformCell(pane, 'denoise').click();
    await expect(status).toHaveAttribute('data-phase', 'refused', { timeout: 30_000 });
    await expect(status).toContainText(/no steady noise floor/i);
    expect(await readSample(page, 's'), 'the pad is untouched').toBeNull();

    // And the pad still PLAYS — the refusal changed nothing.
    const peak = await triggerThenMeasure(page, pane, 0.1);
    expect(peak).toBeGreaterThan(0.1);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
