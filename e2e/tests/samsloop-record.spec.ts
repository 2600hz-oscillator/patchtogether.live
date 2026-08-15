// e2e/tests/samsloop-record.spec.ts
//
// SAMSLOOP audio-input record path:
//   1. Spawn NOISE → samsloop.audio_l_in. Click REC, wait, click STOP.
//      Assert the button label flips REC → STOP → REC across the click
//      sequence.
//   2. node.data.sample.bytes is non-empty (recorded SOMETHING) AND ≤
//      the 3 MB byte budget.
//   3. The waveform canvas has non-trivial luma variance during/after
//      the recording (we drew something, not a blank canvas).
//   4. Settings switches: the max-seconds readout tracks CHAN/BITS/RATE.
//   5. CHAN / BITS / RATE buttons are disabled while a recording is in
//      flight (settings change mid-recording should stop the recording
//      cleanly — separately exercised in the unit-level state-machine).
//   6. ⚠ THE ONE THAT MATTERS, AND THE ONE THAT WAS MISSING:
//      **the recording PLAYS.** Record → trigger → audible RMS at `out`.
//   7. The take's DURATION is the wall-clock time REC was held, and its
//      stored rate is the rate this machine's AudioContext can actually
//      produce. That pair is what the old tagging bug broke: a 48 kHz
//      capture stamped 44 100 played 148 cents flat and 8.8 % long, and
//      nothing here noticed because every assertion was about bytes.
//
// ⚠ WHY 6 EXISTS. Read 1-5 again: every assertion above is about BYTES
// (`node.data.sample` populated, inside the budget, right rate/bits/channels),
// PIXELS (the waveform canvas has variance) or CHROME (a button label, a
// disabled state, a max-seconds readout). Not one of them listens. And for the
// whole life of the feature the module was **SILENT after REC** — the card
// wrote `node.data.sample.bytesB64` and the engine factory read only
// `node.data.fileBytesB64` / `node.data.samples`, so a recorded buffer never
// reached the worklet at all. Bytes: correct. Waveform: drawn. Save/load:
// round-tripped. Download: a valid WAV. Sound: none. This whole file was green
// throughout, and so was `samsloop.spec.ts`, whose audio test drives the
// UPLOAD path.
//
// The lesson is the repo's own: ask what a suite is structurally unable to
// see. A recorder's test set that never asserts audio can only ever prove the
// recorder writes a file.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { expectedAchievedRate, readContextSampleRate, readSample } from './_samsloop-helpers';

/** The record byte budget (SAMSLOOP_RECORD_BUDGET_BYTES). Restated rather
 *  than imported because the e2e workspace does not resolve `$lib`; the
 *  authority is samsloop-record.ts and its unit test pins the value. */
const RECORD_BUDGET_BYTES = 3_000_000;

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('domcontentloaded');
  return errors;
}

test.describe('SAMSLOOP audio-input record', () => {
  test('REC → wait → STOP commits bytes + waveform has visible trace', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'n', portId: 'white' },
          to:   { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise',
          targetType: 'samsloop',
        },
      ],
    );

    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await expect(rec).toContainText('REC');

    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate, 'audio engine must be up before REC').toBeGreaterThan(0);

    // Start recording. ⚠ #1569: `heldFrom` must be stamped BEFORE the click
    // that starts the recorder — it used to be stamped after the STOP-label +
    // three disabled-state polls below, so on a loaded runner the recorder had
    // already captured a few hundred ms that the window never counted (CI:
    // stored 1160 ms vs a 943 ms window — the excess IS those polls' round
    // trips). Stamping outside both clicks makes [heldFrom, heldMs] a strict
    // OUTER bracket of the recorded span, so the ×1.2 upper band is
    // structurally sound instead of a bet on poll latency.
    const heldFrom = Date.now();
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    // Settings buttons get disabled while recording.
    await expect(page.locator('[data-testid="samsloop-chan-stereo"]')).toBeDisabled();
    await expect(page.locator('[data-testid="samsloop-bits-16"]')).toBeDisabled();
    await expect(page.locator('[data-testid="samsloop-rate-48k"]')).toBeDisabled();

    // Capture ~700 ms of noise (the polls above are also inside the bracket —
    // the recorder is live during them, and that is now counted, not leaked).
    await page.waitForTimeout(700);

    // Stop recording — the bracket closes when the stopping click resolves;
    // the label read-back below is OUTSIDE it (the recorder is already off).
    await rec.click();
    const heldMs = Date.now() - heldFrom;
    await expect(rec).toContainText('REC');

    // Settings re-enable.
    await expect(page.locator('[data-testid="samsloop-chan-stereo"]')).toBeEnabled();

    // node.data.sample populated and within the byte budget.
    const sample = await readSample(page, 's');
    expect(sample, 'expected node.data.sample populated after stop').not.toBeNull();
    expect(sample!.bytesLen).toBeGreaterThan(0);
    expect(sample!.bytesLen).toBeLessThanOrEqual(RECORD_BUDGET_BYTES);
    // Defaults: 48 kHz target / 16-bit / MONO.
    expect(sample!.bits).toBe(16);
    expect(sample!.channels).toBe(1);
    expect(sample!.durationSec).toBeGreaterThan(0);

    // ⚠ THE RATE TAG. Derived from THIS machine's context rate, not
    // hard-coded: on a 48 kHz runner the 48 kHz target is a genuine no-op
    // (48 000), on a 44.1 kHz one it stays 44 100 because we never upsample.
    // Either way the tag must be what the samples ARE.
    expect(
      sample!.rate,
      `ctx ${ctxRate} Hz with the 48k switch must store ${expectedAchievedRate(ctxRate, 48_000)} Hz`,
    ).toBe(expectedAchievedRate(ctxRate, 48_000));

    // …and the persisted duration is derived from THAT rate, not from the
    // switch. Exact, because both sides are stored: a half-applied fix that
    // tagged the achieved rate but kept computing seconds from the request
    // would pass the assertion above and fail this one.
    const frames = sample!.bytesLen / ((sample!.bits / 8) * sample!.channels);
    expect(
      sample!.durationSec,
      `durationSec ${sample!.durationSec} must be ${frames} frames / ${sample!.rate} Hz`,
    ).toBeCloseTo(frames / sample!.rate, 6);

    // Sanity band only — REC was held for ~heldMs (an upper bound, since the
    // two clicks bracket the capture). This catches "recorded nothing" and
    // "never stopped"; the RATE assertion above is what catches the tagging
    // bug, and it is exact.
    expect(
      sample!.durationSec * 1000,
      `stored ${(sample!.durationSec * 1000).toFixed(0)} ms vs ~${heldMs} ms of REC`,
    ).toBeGreaterThan(heldMs * 0.3);
    expect(sample!.durationSec * 1000).toBeLessThan(heldMs * 1.2);

    // Waveform canvas has non-trivial luma variance — we drew SOMETHING
    // (the live-record peak trace, or the static decoded preview after
    // stop). "Non-trivial" = stdev of the red-channel pixel intensity
    // across the canvas > 5 (a blank canvas has stdev ≈ 0).
    const variance = await page.locator('[data-testid="samsloop-waveform"]').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      // Sample every 4th pixel to keep the calc cheap.
      const reds: number[] = [];
      for (let i = 0; i < img.data.length; i += 16) reds.push(img.data[i]!);
      const mean = reds.reduce((a, b) => a + b, 0) / reds.length;
      const variance = reds.reduce((sum, x) => sum + (x - mean) ** 2, 0) / reds.length;
      return Math.sqrt(variance);
    });
    expect(variance, `red-channel stdev across waveform canvas: ${variance}`).toBeGreaterThan(5);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('a RECORDED sample PLAYS — record → trigger → audible at the output', async ({ page }) => {
    // THE P0 REGRESSION LOCK. NOISE → samsloop.audio_l_in (the record chain)
    // and samsloop.out → SCOPE.ch1 (the playback chain), in one patch, so the
    // recorder's write and the player's read are joined by a cable rather than
    // by an assumption.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n',   type: 'noise',    position: { x: 100, y: 200 } },
        { id: 's',   type: 'samsloop', position: { x: 400, y: 200 }, domain: 'audio', params: { mode: 1 } },
        { id: 'scp', type: 'scope',    position: { x: 800, y: 200 }, domain: 'audio' },
      ],
      [
        { id: 'e1', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
        { id: 'e2', from: { nodeId: 's', portId: 'out' }, to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // (a) NEGATIVE CONTROL, BEFORE. Nothing recorded yet and no trigger, so
    //     the output must be silent. Without this leg a leaky patch (noise
    //     bleeding to the scope through some other route) would make the
    //     post-trigger assertion pass for the wrong reason — which is exactly
    //     the failure mode that let the silent recorder ship.
    const beforeRec = await readScopePeakOverWindow(page, 'scp', 400);
    expect(
      beforeRec.peak,
      `pre-record peak ${beforeRec.peak} — samsloop must be silent with no sample and no trigger`,
    ).toBeLessThan(0.02);

    // (b) Record ~700 ms of noise.
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await expect(rec).toBeVisible();
    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    await page.waitForTimeout(700);
    await rec.click();
    await expect(rec).toContainText('REC');

    // The bytes landed — asserted here too so a failure below is diagnosable
    // as "recorded but does not play" rather than "did not record".
    const sample = await readSample(page, 's');
    expect(sample, 'nothing was recorded — the failure below would be about the wrong thing').not.toBeNull();
    expect(sample!.bytesLen).toBeGreaterThan(0);

    // (c) NEGATIVE CONTROL, MIDDLE. SAMSLOOP is idle-by-default: a loaded
    //     sample does NOT auto-play. So it must STILL be silent here, which
    //     also proves the audible reading in (d) comes from the TRIGGER and
    //     not from the record tap leaking into the output.
    await page.waitForTimeout(600); // the factory polls node.data every 200 ms
    const loaded = await readScopePeakOverWindow(page, 'scp', 500);
    expect(
      loaded.peak,
      `post-record pre-trigger peak ${loaded.peak} — a loaded sample must stay idle`,
    ).toBeLessThan(0.02);

    // (d) THE ASSERTION THE MODULE SHIPPED WITHOUT: trigger it and listen.
    //     Renderer-tolerant — a max-held peak over a window with a generous
    //     floor, because the claim is "audible vs silent", not a level.
    await page.locator('[data-testid="samsloop-trigger-button"]').click();
    const playing = await readScopePeakOverWindow(page, 'scp', 1500);
    expect(
      playing.peak,
      `post-trigger peak ${playing.peak} over ${playing.polls} polls — a recorded sample MUST play`,
    ).toBeGreaterThan(0.05);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('max-seconds readout reflects settings, at the rate the machine can produce', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);

    const budget = page.locator('[data-testid="samsloop-max-seconds"]');
    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate, 'audio engine must be up to derive the readout').toBeGreaterThan(0);

    // The readout is derived, not looked up: min(3 MB / bytes-per-second,
    // 60 s), at the ACHIEVED rate. Computing the expectation the same way the
    // card does is the only version of this test that is not an assertion
    // about which sample rate the runner happens to use.
    const expectSeconds = (switchRate: number, bits: number, channels: number) => {
      const rate = expectedAchievedRate(ctxRate, switchRate);
      const exact = Math.min(3_000_000 / (rate * (bits / 8) * channels), 60);
      return (Math.round(exact * 100) / 100).toFixed(2);
    };

    // Defaults: MONO / 16-bit / 48 kHz.
    await expect(budget).toContainText(`${expectSeconds(48_000, 16, 1)}s`);

    // Mono / 8-bit / 22 kHz — the 60 s LENGTH cap binds here, not the bytes.
    await page.locator('[data-testid="samsloop-chan-mono"]').click();
    await page.locator('[data-testid="samsloop-bits-8"]').click();
    await page.locator('[data-testid="samsloop-rate-22k"]').click();
    await expect(budget).toContainText(`${expectSeconds(22_050, 8, 1)}s`);
    await expect(budget).toContainText('60.00s');

    // Stereo / 16-bit / 48 kHz — the tightest combination on offer.
    await page.locator('[data-testid="samsloop-chan-stereo"]').click();
    await page.locator('[data-testid="samsloop-bits-16"]').click();
    await page.locator('[data-testid="samsloop-rate-48k"]').click();
    await expect(budget).toContainText(`${expectSeconds(48_000, 16, 2)}s`);

    // NEGATIVE CONTROL on the readout: the three switches must actually move
    // it. If `expectSeconds` and the card were both wrong in the same way,
    // every assertion above would still pass — this one fails unless the
    // control does something.
    await page.locator('[data-testid="samsloop-chan-mono"]').click();
    await expect(budget).not.toContainText(`${expectSeconds(48_000, 16, 2)}s`);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('the RATE switch never claims a rate it cannot produce', async ({ page }) => {
    // Integer decimation cannot hit 44.1 kHz from a 48 kHz context (or 48 from
    // 44.1). The old card silently stored the request anyway; now the card
    // says so and stores the truth. Which switch position is honest depends on
    // the machine, so DERIVE which one to check rather than assuming.
    const errors = await setupPage(page);
    await spawnPatch(page, [{ id: 's', type: 'samsloop', position: { x: 200, y: 200 } }]);
    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate).toBeGreaterThan(0);

    const note = page.locator('[data-testid="samsloop-rate-note"]');
    for (const switchRate of [22_050, 44_100, 48_000]) {
      await page.locator(`[data-testid="samsloop-rate-${Math.round(switchRate / 1000)}k"]`).click();
      const achieved = expectedAchievedRate(ctxRate, switchRate);
      if (achieved === switchRate) {
        await expect(note, `${switchRate} IS achievable at ctx ${ctxRate} — no note expected`)
          .toHaveCount(0);
      } else {
        await expect(note, `${switchRate} is NOT achievable at ctx ${ctxRate} — the card must say so`)
          .toContainText(`${(achieved / 1000).toFixed(1)}k`);
      }
    }

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('the RACK budget, EMPTY rack: full length, no note, records', async ({ page }) => {
    // Leg 1 of 2. A free rack ⇒ nothing about the ledger is visible and REC
    // behaves exactly as it did before the ledger existed. This leg is what
    // makes the refusal in the next test mean "the ledger fired" rather than
    // "the button is always dead", and it costs nothing — no payload at all.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise',    position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
      ],
    );
    const card = page.locator('.svelte-flow__node[data-id="s"]');
    const rec = card.locator('[data-testid="samsloop-rec-button"]');

    await expect(card.locator('[data-testid="samsloop-rack-budget-note"]')).toHaveCount(0);
    await expect(rec).toBeEnabled();
    await expect(card.locator('[data-testid="samsloop-max-seconds"]')).toHaveText(/^\d+\.\d\ds max$/);

    await rec.click();
    await expect(rec).toContainText('STOP', { timeout: 3000 });
    await page.waitForTimeout(400);
    await rec.click();
    await expect(rec).toContainText('REC');
    expect((await readSample(page, 's'))?.bytesLen ?? 0).toBeGreaterThan(0);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  // ⚠ THE "FULL RACK" LEG DELIBERATELY DOES NOT LIVE HERE — see
  // `samsloop-rack-budget.test.ts` in the unit lane.
  //
  // It was here, and it TIMED OUT on CI shard 9 (twice, including the retry).
  // Not on an assertion, and not because the feature was broken: the
  // failure's own page snapshot showed the card rendering
  // `0.00s max` + `rack sample budget: 12.5 / 12 MB used — no room to record`
  // on exactly the right node. The test's own construction burned the budget.
  // Measured from the CI trace, out of 30 s:
  //     5.6 s  page.evaluate writing 11 MB into the live Y.Doc
  //    11.3 s  the app digesting that write before the note appeared
  //     6.6 s  page.evaluate writing 12.5 MB
  //   = 23.5 s of payload churn, 1.5 s left for the assertion.
  //
  // That cost is INTRINSIC, not a bad arrangement: proving this ceiling needs
  // ~12 MB of base64 actually present in `node.data`, and materialising that
  // in a live syncedStore doc costs 15-20 s on a CI runner however you stage
  // it. (Planting it at spawn is not available either — `SpawnNode` carries no
  // `data`, and `_helpers.ts` is in the COLLAB ATTEST BASIS, so widening it
  // for a test convenience would force a relay re-attest.)
  //
  // So the ceiling proof moved to the unit lane, where it is instant and can
  // be exhaustive, and it is split three ways so nothing is lost:
  //   * the VALUES  — ledger → seconds → refusal message — against a REAL
  //     Y.Doc, so it exercises the live syncedStore shape and not a fixture;
  //   * the WIRING  — a source-anchored guard that the card binds those to the
  //     DOM and subscribes to `docVersion()`, which is the exact regression
  //     that shipped in the first cut of this feature;
  //   * the EMPTY-rack behaviour — the test above, which stays here because it
  //     is the negative control and costs nothing.
  // The requirement is that over-budget is provably visible, not that the
  // proof lives in Playwright.

  test('DOWNLOAD button enabled only after a successful recording', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'n', portId: 'white' },
          to:   { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise',
          targetType: 'samsloop',
        },
      ],
    );

    const dl = page.locator('[data-testid="samsloop-download-button"]');
    await expect(dl).toBeDisabled();

    // Record briefly.
    const rec = page.locator('[data-testid="samsloop-rec-button"]');
    await rec.click();
    await expect(rec).toContainText('STOP');
    await page.waitForTimeout(400);
    await rec.click();
    await expect(rec).toContainText('REC');

    await expect(dl).toBeEnabled({ timeout: 2000 });

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
