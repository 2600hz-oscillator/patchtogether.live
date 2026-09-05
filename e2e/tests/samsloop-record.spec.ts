// e2e/tests/samsloop-record.spec.ts
//
// SAMSLOOP audio-input record path, on the DEFAULT shell (S2 re-point —
// the dock REC cell + the __samsloopRecording registry probe replace the
// card's REC/STOP label flip):
//   1. Spawn NOISE → samsloop.audio_l_in. Press REC, wait, press again;
//      the registry probe tracks armed → stopped.
//   2. node.data.sample.bytes is non-empty (recorded SOMETHING) AND ≤
//      the 3 MB byte budget.
//   3. The waveform canvas has non-trivial luma variance during/after
//      the recording (we drew something, not a blank canvas).
//   4. The three dock SELECTOR cells write the take settings, a take
//      honors them, and a settings change UNDER an armed take stops it
//      cleanly (the face's replacement for disabled-while-recording).
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
import { expectedAchievedRate, openSamsloopPane, readContextSampleRate, readSample, samsloopIsRecording } from './_samsloop-helpers';

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
  await page.goto('/rack?seed=none');
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

    const pane = await openSamsloopPane(page, 's');
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await expect(rec).toBeVisible();
    expect(await samsloopIsRecording(page, 's')).toBe(false);

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
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
    // (The card DISABLED the format buttons while recording; the face's
    // selector cells stay live and a change STOPS the take cleanly instead —
    // pushRecSetting, unit-pinned. The freeze invariant survives, the
    // disabled-chrome sub-claims died with the card.)

    // Capture ~700 ms of noise (the polls above are also inside the bracket —
    // the recorder is live during them, and that is now counted, not leaked).
    await page.waitForTimeout(700);

    // Stop recording — the bracket closes when the stopping click resolves;
    // the label read-back below is OUTSIDE it (the recorder is already off).
    await rec.click();
    const heldMs = Date.now() - heldFrom;
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);

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
    const variance = await pane.getByTestId('samsloop-face-canvas').evaluate((el) => {
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

    // (b) Record ~700 ms of noise (dock REC cell + registry probe).
    const pane = await openSamsloopPane(page, 's');
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await expect(rec).toBeVisible();
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
    await page.waitForTimeout(700);
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);

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
    await pane.getByTestId('shell-cell-samsloop-trigger').click();
    const playing = await readScopePeakOverWindow(page, 'scp', 1500);
    expect(
      playing.peak,
      `post-trigger peak ${playing.peak} over ${playing.polls} polls — a recorded sample MUST play`,
    ).toBeGreaterThan(0.05);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('max-seconds readout reflects settings, at the rate the machine can produce', async ({ page }) => {
    // ⚠ REWRITTEN FOR THE FACE. The card's derived `samsloop-max-seconds`
    // string died with the card (readout ruling; the budget→seconds VALUES are
    // unit-owned — see the rack-budget note below). What SURVIVES here is the
    // behavioural half the string was derived from: the three dock SELECTOR
    // cells write the take settings into node.data, a take HONORS them, and —
    // the face's own documented semantics — changing a setting UNDER an armed
    // take stops it cleanly (pushRecSetting) rather than re-formatting it.
    const errors = await setupPage(page);
    // A live input edge: a take with NO input pulls zero frames and commits
    // nothing, so the honors-check below needs real audio like every other
    // recording leg here.
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
      ],
    );

    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate, 'audio engine must be up to record').toBeGreaterThan(0);
    const pane = await openSamsloopPane(page, 's');
    const pick = async (cell: string, option: string) => {
      await pane.getByTestId(cell).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    const recSettings = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: { recChannels?: number; recBits?: number; recRate?: number } }> };
        };
        const d = w.__patch.nodes['s']?.data ?? {};
        return { chan: d.recChannels ?? null, bits: d.recBits ?? null, rate: d.recRate ?? null };
      });

    // Mono / 8-bit / 22 kHz reaches node.data. (Mono IS the default, and
    // picking the already-selected option fires no change — hop through
    // stereo first so the mono write is a real write.)
    await pick('shell-cell-samsloop-chan', 'stereo');
    await pick('shell-cell-samsloop-chan', 'mono');
    await pick('shell-cell-samsloop-bits', '8');
    await pick('shell-cell-samsloop-rate-select', '22k');
    await expect.poll(recSettings).toEqual({ chan: 1, bits: 8, rate: 22_050 });

    // …and a take HONORS them: record ~400 ms (silence is fine — format is
    // format) and the persisted sample carries the picked bits/channels at
    // the rate this machine can actually produce.
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
    // pacing: the LENGTH OF THE TAKE — a real-time capture, so the wall clock
    // IS the subject; shortening this shortens the RECORDING, not a wait.
    await page.waitForTimeout(400);
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);
    // The encode-and-commit on stop is async — poll for the persisted take.
    await expect
      .poll(async () => (await readSample(page, 's')) !== null, { message: 'take committed' })
      .toBe(true);
    const sample = await readSample(page, 's');
    expect(sample!.bits).toBe(8);
    expect(sample!.channels).toBe(1);
    expect(sample!.rate).toBe(expectedAchievedRate(ctxRate, 22_050));

    // Changing a setting UNDER an armed take STOPS it (the face's replacement
    // for the card's disabled-while-recording buttons).
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 're-armed' }).toBe(true);
    await pick('shell-cell-samsloop-chan', 'stereo');
    await expect
      .poll(() => samsloopIsRecording(page, 's'), { message: 'a settings change ends the take' })
      .toBe(false);
    await expect.poll(recSettings).toMatchObject({ chan: 2 });

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('the RATE switch never claims a rate it cannot produce', async ({ page }) => {
    // Integer decimation cannot hit 44.1 kHz from a 48 kHz context (or 48 from
    // 44.1). The old card silently stored the request anyway; now the card
    // says so and stores the truth. Which switch position is honest depends on
    // the machine, so DERIVE which one to check rather than assuming.
    // ⚠ REWRITTEN FOR THE FACE. The card's `samsloop-rate-note` string died
    // with the card (readout ruling); the TRUTH it narrated — the stored tag
    // is what the samples ARE, whatever the switch requested — is asserted
    // directly here, per switch position, on a real take each time.
    const errors = await setupPage(page);
    await spawnPatch(
      page,
      [
        { id: 'n', type: 'noise', position: { x: 100, y: 200 } },
        { id: 's', type: 'samsloop', position: { x: 400, y: 200 } },
      ],
      [
        { id: 'e1', from: { nodeId: 'n', portId: 'white' }, to: { nodeId: 's', portId: 'audio_l_in' },
          sourceType: 'noise', targetType: 'samsloop' },
      ],
    );
    const ctxRate = await readContextSampleRate(page);
    expect(ctxRate).toBeGreaterThan(0);
    const pane = await openSamsloopPane(page, 's');
    const rec = pane.getByTestId('shell-cell-samsloop-rec');

    for (const switchRate of [22_050, 44_100, 48_000]) {
      await pane.getByTestId('shell-cell-samsloop-rate-select').click();
      await page
        .getByRole('option', { name: `${Math.round(switchRate / 1000)}k`, exact: true })
        .click();
      await rec.click();
      await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
      // pacing: the LENGTH OF THE TAKE — real-time capture, wall clock is the subject.
      await page.waitForTimeout(250);
      await rec.click();
      await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);
      const achieved = expectedAchievedRate(ctxRate, switchRate);
      await expect
        .poll(async () => (await readSample(page, 's'))?.rate ?? null, {
          message: `switch ${switchRate} at ctx ${ctxRate} must STORE ${achieved} — the tag is what the samples are`,
        })
        .toBe(achieved);
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
    // On the face the budget narration is the REC REFUSAL live region
    // (`samsloop-face-rec-error`, absent at rest — face-samsloop-rec-refusal
    // covers the full-rack arm); a free rack shows no refusal and records.
    // (The card's max-seconds / budget-note readouts died with the card; the
    // budget→seconds VALUES are unit-owned, see the note below.)
    const pane = await openSamsloopPane(page, 's');
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await expect(pane.getByTestId('samsloop-face-rec-error')).toHaveCount(0);
    await expect(rec).toBeEnabled();

    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms on a free rack' }).toBe(true);
    await page.waitForTimeout(400);
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);
    await expect
      .poll(async () => (await readSample(page, 's'))?.bytesLen ?? 0, { message: 'take committed' })
      .toBeGreaterThan(0);
    await expect(pane.getByTestId('samsloop-face-rec-error')).toHaveCount(0);

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
  // it. (Planting it at spawn was not available either — `SpawnNode` carries no
  // `data`, and widening `_helpers.ts` for a test convenience forced a relay
  // re-attest because that file was in the COLLAB ATTEST BASIS. That attest was
  // deleted 2026-08-17, so widening `SpawnNode` is now merely a design call, not
  // a blocked one — but the split below is better regardless.)
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

    // ⚠ The face's EXPORT cell is never disabled (enablement was card
    // chrome); the guarded behaviour survives as a SUCCESSFUL NO-OP — a press
    // with nothing to export starts NO download, and the same press after a
    // take does. Both directions asserted, so the leg keeps its name's claim.
    const pane = await openSamsloopPane(page, 's');
    const dl = pane.getByTestId('shell-cell-samsloop-download');

    let sawDownload = false;
    page.on('download', () => { sawDownload = true; });
    await dl.click();
    // pacing: bounding a NEGATIVE claim — the no-op resolves synchronously in
    // the handler, and only wall clock can prove no download event follows.
    await page.waitForTimeout(500);
    expect(sawDownload, 'an empty samsloop must export NOTHING').toBe(false);

    // Record briefly.
    const rec = pane.getByTestId('shell-cell-samsloop-rec');
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
    await page.waitForTimeout(400);
    await rec.click();
    await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);
    await expect
      .poll(async () => (await readSample(page, 's')) !== null, { message: 'take committed' })
      .toBe(true);

    const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
    expect(download.suggestedFilename()).toMatch(/\.wav$/);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
