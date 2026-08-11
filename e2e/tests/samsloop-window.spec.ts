// e2e/tests/samsloop-window.spec.ts
//
// THE START/END LOOP WINDOW — the tests whose absence shipped a dead control.
//
// Owner report: "the start and end controls on samsloop are just broken. start
// slider doesn't move start point, moving end at all turns clip black in viewer
// and stops working."
//
// All three symptoms were ONE defect, introduced by #1316 (bbba5b5d): the engine
// factory's RECORD branch cached `node.data.sampleLength = f32.length` AFTER
// `postMessage(..., [f32.buffer])` had TRANSFERRED — and therefore DETACHED —
// that very buffer, so it stored 0. `SamsloopCard` sizes BOTH window faders to
// `Math.max(1, sampleLength)`, so on a 40 000-frame take they became [0, 1]
// sliders: START moved the play head by at most one sample (inert), touching END
// wrote an `end` the worklet clamps to a one-sample window (silence), and the
// card's `end / samples.length` highlight band collapsed to zero width, leaving
// the waveform panel unlit — "black".
//
// WHY NOTHING CAUGHT IT — and what each test here is the answer to:
//   * samsloop-boundaries-roundtrip.spec.ts writes start/end STRAIGHT INTO THE
//     Y.DOC and asserts they persist. It never touches a fader, so it cannot see
//     a fader whose RANGE is wrong, and it never listens, so it cannot see a
//     window that produces no audio. Both assertions it makes stayed true.
//   * samsloop-record.spec.ts (added by the same PR) proves a recorded sample
//     PLAYS — but only at the DEFAULT full window, which the worklet clamps to
//     the buffer, so `sampleLength: 0` is invisible to it.
//   * per-module-per-port and the behavioral sweep both SKIP samsloop
//     ("needs a decoded sample buffer AND a trigger to emit").
//   * VRT masks samsloop's `canvas` (vrt-exemptions.ts) — the exact surface that
//     goes black is excluded from the baseline by construction.
//
// So the three tests below assert, in order: START moves the AUDIBLE start point
// (both directions, so a dead fader cannot pass), END crops the AUDIBLE end AND
// leaves a valid render, and a RECORDED take's window metadata matches the bytes
// actually stored (the regression itself, anchored to the artifact rather than
// to a magic number).
//
// The audio assertions are the point: they read the SCOPE, not the slider. A
// staircase fixture — quiet first half, loud second half — turns "which slice is
// playing" into a level that is renderer-independent and needs no calibration.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

/** 16-bit mono WAV: a 220 Hz sine whose amplitude STEPS from 0.20 to 0.90 at the
 *  halfway mark. The peak of whatever window is playing therefore NAMES the half
 *  it came from, with a 4.5× separation that no renderer or CI load can blur.
 *  44.1 kHz so `finalizeSamsloopBuffer` applies no downsample (factor < 2) and
 *  the decoded length is exactly `sec * 44100` — one less moving part. */
const QUIET_AMP = 0.2;
const LOUD_AMP = 0.9;
function staircaseWav(sec = 4, rate = 44100): Buffer {
  const n = Math.floor(sec * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const amp = i < n / 2 ? QUIET_AMP : LOUD_AMP;
    data.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function setupPage(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?shell=legacy');
  await page.waitForLoadState('networkidle');
  return errors;
}

interface SamsState {
  start: number; end: number;
  engineStart: number | null; engineEnd: number | null;
  sampleLength: number | null;
  /** Frames implied by the RECORDED bytes actually on node.data, or null when
   *  the source is an upload. The ARTIFACT `sampleLength` must agree with. */
  recordedFrames: number | null;
}

async function readSams(page: Page, id = 's'): Promise<SamsState> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> }> };
      __engine?: () => { readParam: (n: unknown, k: string) => number | undefined } | null;
    };
    const n = w.__patch.nodes[nid]!;
    const eng = w.__engine?.() ?? null;
    const d = (n.data ?? {}) as Record<string, unknown>;
    const s = d.sample as { byteLength: number; bits: number; channels: number } | undefined;
    return {
      start: n.params.start,
      end: n.params.end,
      engineStart: eng ? (eng.readParam(n, 'start') ?? null) : null,
      engineEnd: eng ? (eng.readParam(n, 'end') ?? null) : null,
      sampleLength: (d.sampleLength as number | undefined) ?? null,
      recordedFrames: s ? Math.floor(s.byteLength / (Math.ceil(s.bits / 8) * s.channels)) : null,
    };
  }, id);
}

/** What the card's waveform canvas is actually SHOWING, in three counts:
 *   `trace` — orange peak-per-pixel pixels (the sample is drawn at all);
 *   `band`  — the translucent START..END highlight (the window is drawn at all);
 *   `lit`   — anything above the panel's near-black background.
 *  `band` is the one that went to ZERO — the "clip turns black" symptom. */
async function readWaveform(page: Page): Promise<{ trace: number; band: number; lit: number }> {
  const canvas = page.locator('[data-testid="samsloop-waveform"]');
  await expect(canvas).toHaveCount(1);
  return await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return { trace: 0, band: 0, lit: 0 };
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let trace = 0, band = 0, lit = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      // Trace: rgb(255,150,40) with AA tolerance.
      if (r > 200 && g > 100 && g < 200 && b < 100) trace++;
      // Band: rgba(80,160,220,0.18) over #0a0c11 ≈ rgb(23,39,54) — blue-dominant
      // and dim, which nothing else on this canvas is.
      else if (b > r + 10 && b > 35) band++;
      if (r + g + b > 60) lit++;
    }
    return { trace, band, lit };
  });
}

/**
 * Drive a REAL fader through a REAL pointer gesture to (approximately) `frac`.
 *
 * The gesture, not `setNodeParam`: the reported defect is that the CONTROL is
 * dead, and a test that writes the param directly is blind to a control whose
 * declared range collapsed. Fader.svelte maps 100 px of travel to the full
 * range, so pressing at the track centre (which click-to-jumps to 0.5, or keeps
 * a thumb already within the 0.08 grab radius) and moving `(frac-0.5)*100` px
 * lands within ±0.08 of `frac`. Callers assert on the READ-BACK value, never on
 * the requested one.
 */
async function dragFader(page: Page, paramId: string, frac: number): Promise<void> {
  const el = page.locator(`[data-testid="control-${paramId}"]`);
  await expect(el).toBeVisible();
  const box = (await el.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - (frac - 0.5) * 100, { steps: 12 });
  await page.mouse.up();
  // The commit pump is rAF-coalesced and flushed on pointerup; the reconciler
  // then lands it on the AudioParam. One frame plus a reconcile microtask.
  await page.waitForTimeout(250);
}

/** The declared max of a fader — what `Math.max(1, sampleLength)` produced. */
async function faderMax(page: Page, paramId: string): Promise<number> {
  return await page
    .locator(`[data-testid="control-${paramId}"]`)
    .evaluate((el) => Number(el.getAttribute('aria-valuemax')));
}

async function loadStaircase(page: Page, sec = 4): Promise<number> {
  await page.locator('[data-testid="samsloop-wav-input"]').setInputFiles({
    name: 'staircase.wav', mimeType: 'audio/wav', buffer: staircaseWav(sec),
  });
  await expect(page.locator('[data-testid="samsloop-upload-status"]'))
    .toContainText(/loaded \d+ samples/i, { timeout: 15000 });
  // The factory polls node.data every 200 ms, decodes and posts the buffer.
  await expect.poll(() => readSams(page).then((s) => s.sampleLength ?? 0), { timeout: 10000 })
    .toBeGreaterThan(0);
  const st = await readSams(page);
  return st.sampleLength!;
}

async function trigger(page: Page): Promise<void> {
  await page.locator('[data-testid="samsloop-trigger-button"]').click();
}

const SAMS_AND_SCOPE = {
  nodes: [
    { id: 's', type: 'samsloop', position: { x: 200, y: 200 }, domain: 'audio', params: { mode: 1 } },
    { id: 'scp', type: 'scope', position: { x: 760, y: 200 }, domain: 'audio' },
  ],
  edges: [
    { id: 'e1', from: { nodeId: 's', portId: 'out' }, to: { nodeId: 'scp', portId: 'ch1' },
      sourceType: 'audio', targetType: 'audio' },
  ],
};

test.describe('SAMSLOOP START/END loop window', () => {
  test('the START fader moves the AUDIBLE start point (asserted on the scope, both directions)', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, SAMS_AND_SCOPE.nodes, SAMS_AND_SCOPE.edges);
    const len = await loadStaircase(page);
    expect(len, 'the staircase must decode to a real buffer').toBeGreaterThan(10_000);

    // ── START high: the window is the LOUD second half. ────────────────────
    await dragFader(page, 'start', 0.8);
    const hi = await readSams(page);
    expect(
      hi.start,
      `START must land in the LOUD half (> ${len / 2} of ${len}); got ${hi.start}. ` +
      'A fader whose range collapsed to [0,1] fails HERE, on the value, before any audio is read.',
    ).toBeGreaterThan(len * 0.5);
    expect(hi.engineStart, 'the engine must have received the same start').toBeCloseTo(hi.start, 0);

    await trigger(page);
    const loud = await readScopePeakOverWindow(page, 'scp', 1200);
    expect(
      loud.peak,
      `peak ${loud.peak} over ${loud.polls} polls with start=${Math.round(hi.start)}/${len} — ` +
      `the window is entirely inside the ${LOUD_AMP} half`,
    ).toBeGreaterThan(0.6);

    // ── START low + END mid: the window is the QUIET first half. ───────────
    // This leg is the NEGATIVE CONTROL on the one above: a START fader that did
    // nothing would replay the identical slice and report the identical peak,
    // so a single-direction assertion proves nothing about the control.
    await dragFader(page, 'end', 0.45);
    await dragFader(page, 'start', 0.05);
    const lo = await readSams(page);
    expect(
      lo.start,
      `START must come back DOWN into the quiet half; got ${lo.start} of ${len}`,
    ).toBeLessThan(len * 0.45);
    expect(lo.end, `END must sit inside the quiet half; got ${lo.end} of ${len}`)
      .toBeLessThan(len * 0.5);
    expect(lo.end, 'END must stay above START or the window is degenerate').toBeGreaterThan(lo.start);

    await trigger(page);
    const quiet = await readScopePeakOverWindow(page, 'scp', 1200);
    expect(
      quiet.peak,
      `peak ${quiet.peak} over ${quiet.polls} polls with window ` +
      `${Math.round(lo.start)}..${Math.round(lo.end)} of ${len} — entirely inside the ${QUIET_AMP} half`,
    ).toBeLessThan(0.45);
    // Still AUDIBLE, not merely quieter: the window moved, it did not die.
    expect(quiet.peak, `peak ${quiet.peak} — the quiet half must still be heard, not silent`)
      .toBeGreaterThan(0.05);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('the END fader crops the AUDIBLE end, keeps the window drawn, and playback continues', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, SAMS_AND_SCOPE.nodes, SAMS_AND_SCOPE.edges);
    const len = await loadStaircase(page);

    const full = await readWaveform(page);
    expect(full.trace, `the sample must be drawn at all (trace px ${full.trace})`).toBeGreaterThan(20);
    expect(full.band, `the full window must be drawn (band px ${full.band})`).toBeGreaterThan(200);

    // Crop END back into the QUIET half. Both halves were audible before; only
    // the quiet one is in the window now, so the peak MUST drop — that is the
    // crop, measured on the audio.
    await dragFader(page, 'end', 0.4);
    const cropped = await readSams(page);
    expect(cropped.end, `END must land in the quiet half; got ${cropped.end} of ${len}`)
      .toBeLessThan(len * 0.5);
    expect(cropped.end, 'END must stay above START').toBeGreaterThan(cropped.start);
    expect(cropped.engineEnd, 'the engine must have received the same end').toBeCloseTo(cropped.end, 0);

    // THE "BLACK CLIP" ASSERTION. This is what went to zero: the START..END
    // highlight band. A `sampleLength` of 0 made `end / samples.length` collapse,
    // the band vanished, and the panel lost its lit wash. Both counts are read
    // AFTER the crop, so a band that survives here is the fixed behaviour.
    const drawn = await readWaveform(page);
    expect(
      drawn.band,
      `START..END band px ${drawn.band} after moving END — a collapsed window draws ZERO ` +
      'band px, which is the "clip turns black" symptom',
    ).toBeGreaterThan(200);
    expect(drawn.trace, `the sample must still be drawn (trace px ${drawn.trace})`).toBeGreaterThan(20);
    expect(
      drawn.lit,
      `lit px ${drawn.lit} (was ${full.lit} at the full window) — the panel must not go dark`,
    ).toBeGreaterThan(full.lit * 0.4);

    // …and it MUST STILL PLAY. "Stops working" was the other half of the report.
    await trigger(page);
    const after = await readScopePeakOverWindow(page, 'scp', 1200);
    expect(
      after.peak,
      `peak ${after.peak} over ${after.polls} polls with window ` +
      `${Math.round(cropped.start)}..${Math.round(cropped.end)} of ${len} — cropping END must not kill playback`,
    ).toBeGreaterThan(0.05);
    expect(after.peak, `peak ${after.peak} — the crop kept only the ${QUIET_AMP} half`).toBeLessThan(0.45);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('a RECORDED take bounds both window faders to its OWN frame count, not to 1', async ({ page }) => {
    // THE REGRESSION, stated against the artifact. `sampleLength` is not compared
    // to a magic number — it is compared to the frame count implied by the bytes
    // actually sitting on node.data, so the assertion cannot rot when the record
    // budget, the bit depth or the channel count changes.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 }, domain: 'audio' },
        ...SAMS_AND_SCOPE.nodes.map((n) => (n.id === 's' ? { ...n, position: { x: 420, y: 200 } } : n)),
      ],
      [
        { id: 'e0', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
        ...SAMS_AND_SCOPE.edges,
      ],
    );

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 5000 });
    await page.waitForTimeout(800);
    await rec.click();
    await expect(rec).toContainText('REC');

    // Let the factory's 200 ms poll decode + post the take (and, before the fix,
    // stomp sampleLength with the length of a DETACHED buffer).
    await page.waitForTimeout(900);

    const st = await readSams(page);
    expect(st.recordedFrames, 'nothing was recorded — the assertions below would be about the wrong thing')
      .not.toBeNull();
    expect(st.recordedFrames!, 'the take must be a real length').toBeGreaterThan(1000);
    expect(
      st.sampleLength,
      `node.data.sampleLength is ${st.sampleLength} but the stored bytes hold ${st.recordedFrames} frames. ` +
      'A 0 here is the transferred-then-read-back buffer: postMessage detaches the view, so `f32.length` is 0.',
    ).toBe(st.recordedFrames);

    // The user-visible consequence, asserted directly on the controls: both
    // faders declare the take's range. `Math.max(1, 0)` makes this 1.
    const startMax = await faderMax(page, 'start');
    const endMax = await faderMax(page, 'end');
    expect(
      startMax,
      `START fader max is ${startMax}; the take is ${st.recordedFrames} frames. ` +
      'A max of 1 is a slider with one sample of travel — the "start slider does nothing" report.',
    ).toBe(st.recordedFrames);
    expect(endMax, `END fader max is ${endMax}; the take is ${st.recordedFrames} frames`)
      .toBe(st.recordedFrames);

    // And driving END through the real fader leaves a live window + live audio.
    await dragFader(page, 'end', 0.5);
    const cropped = await readSams(page);
    expect(
      cropped.end,
      `END must land inside the take (0..${st.recordedFrames}); got ${cropped.end}`,
    ).toBeGreaterThan(st.recordedFrames! * 0.2);
    expect(cropped.end, 'END must stay above START').toBeGreaterThan(cropped.start);

    const drawn = await readWaveform(page);
    expect(drawn.band, `START..END band px ${drawn.band} after moving END on a recorded take`)
      .toBeGreaterThan(200);

    await trigger(page);
    const playing = await readScopePeakOverWindow(page, 'scp', 1500);
    expect(
      playing.peak,
      `peak ${playing.peak} over ${playing.polls} polls — a cropped recorded take must still play`,
    ).toBeGreaterThan(0.02);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
