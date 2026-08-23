// e2e/tests/samsloop-take-survives-card-collapse.spec.ts
//
// #1588 — collapsing SAMSLOOP must not destroy an in-progress recording.
//
// ⚠ SAMSLOOP IS PROMOTED NOW, and the subject survived the promotion unchanged — which
// is worth stating because the surface under the test DID change. This file used to say
// "SAMSLOOP is un-migrated, so its card exists ONLY inside the dock full-view". It is in
// STRICT_FACES today, `DockFullView` reads `migrated()` alone, and the dock renders the
// FACEPLATE; `samsloop-card` appears on neither surface. The defect was never about which
// component it was — it was that a take must not depend on ANY component's lifetime — so
// the spec now collapses the faceplate and asserts exactly the same two things. The
// original defect, on the card that no longer renders:
//
// Collapsing UNMOUNTS the surface, and the card's unmount `$effect` ran
// `attachedTap.setEnabled(false)` + `removeEventListener('message', …)` — and **nothing
// called `stopRecording()`**, the only path that encodes the buffer and writes
// `node.data.sample`. So a view action destroyed up to 60 s of unrepeatable live audio
// with no commit path and no recover candidate: strictly worse than recorderbox before
// #1574. The tap, the accumulator, the peak bar and the commit now live in
// `$lib/ui/modules/node-samsloop-registry`, keyed to the NODE.
//
// ── THE ASSERTION IS CAUSAL, AND IT IS CAUSAL TWICE ──────────────────────────
//
// "Still recording" as a boolean is too weak: an entry can survive while the pump is
// dead, which is the half-fix #1531 warned about. So this spec requires two independent
// things, either of which alone would leave a hole:
//
//   1. THE TAKE KEEPS GROWING while the card is gone. `elapsed` here is frames/rate —
//      the LENGTH OF THE TAKE — not a wall clock. That distinction is the whole gate: the
//      card's shipped readout was `(performance.now() - recStartTimeMs) / 1000`, which
//      advances happily with a detached tap, so an assertion on it would have been green
//      against the exact defect under test. `node-samsloop-registry.test.ts` drives the
//      two apart in both directions as a permanent leg.
//
//   2. THE AUDIO CAPTURED WHILE THE CARD WAS GONE IS IN THE COMMITTED TAKE. The source
//      is gated by a VCA that is CLOSED (base = 0, exact silence) for the whole time the
//      card is mounted, OPENED only while it is collapsed, and CLOSED again before the
//      re-expand. So any energy at all in `node.data.sample` can only have been captured
//      while the card did not exist. A frozen pump yields a take of pure silence.
//
// Both are sampled from the NODE's own record (`__samsloopRecording`), never from the
// card — the card is the thing that is supposed to be irrelevant — and the accumulation
// loop runs IN THE PAGE, reporting samples/elapsedMs/values seen, so "frozen" and "never
// looked" cannot be confused in a failure message.
//
// NOT capability-gated: unlike #1574 this needs no hardware encoder, only an
// AudioContext, which every lane has (playwright.config.ts launches with
// --autoplay-policy=no-user-gesture-required).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.setTimeout(120_000);

/** The dB-free amplitude floor that counts as "there is audio here". 16-bit
 *  quantization noise is 1/32767 ≈ 3e-5 and the noise source runs at ≈0.29 peak
 *  (white @ LEVEL 0.5, -10.8 dBFS), so this sits ~3 decades above the floor and
 *  ~1 decade below the signal. Both controls below use the SAME number. */
const AUDIBLE_PEAK = 0.02;

interface SamsloopProbe {
  recording: boolean;
  state: string | null;
  stopReason: string | null;
  committed: boolean;
  frames: number;
  elapsed: number;
  wallElapsed: number;
  captureRate: number;
}

/** The NODE's own view of its take — deliberately not read off the card. */
async function nodeTake(page: Page, id: string): Promise<SamsloopProbe> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __samsloopRecording(x: string): SamsloopProbe }).__samsloopRecording(n),
    id,
  );
}

/**
 * Wait until the node's TAKE LENGTH passes `targetSec`, accumulating IN THE PAGE.
 *
 * Returns the distinct values seen so a failure says whether the take was frozen or the
 * probe never looked — "0.0000" from a starved Playwright poll loop and "0.0000" from a
 * detached tap are indistinguishable without this (the repo has paid for that once).
 */
async function waitForTakePast(page: Page, id: string, targetSec: number, budgetMs: number) {
  return page.evaluate(
    async ({ id, targetSec, budgetMs }) => {
      const api = (globalThis as unknown as { __samsloopRecording(x: string): SamsloopProbe })
        .__samsloopRecording;
      const seen: number[] = [];
      const t0 = performance.now();
      let last: SamsloopProbe = api(id);
      while (performance.now() - t0 < budgetMs) {
        last = api(id);
        if (seen[seen.length - 1] !== last.elapsed) seen.push(last.elapsed);
        if (last.elapsed > targetSec) break;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return {
        ok: last.elapsed > targetSec,
        elapsed: last.elapsed,
        frames: last.frames,
        wallElapsed: last.wallElapsed,
        recording: last.recording,
        samples: seen.length,
        seen: seen.slice(-6),
        elapsedMs: performance.now() - t0,
      };
    },
    { id, targetSec, budgetMs },
  ) as Promise<{
    ok: boolean;
    elapsed: number;
    frames: number;
    wallElapsed: number;
    recording: boolean;
    samples: number;
    seen: number[];
    elapsedMs: number;
  }>;
}

/** Open or close the gate the source runs through. `base` is the VCA's static gain
 *  floor: 0 is EXACT silence (no CV is patched, so gain = base). */
async function setGate(page: Page, open: boolean) {
  await page.evaluate((v) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['v'];
      if (n) n.params.base = v;
    });
  }, open ? 1 : 0);
}

/** Decode the COMMITTED take and measure it, in thirds so a failure says WHERE the
 *  energy is. 16-bit signed LE mono is what the defaults record. */
async function measureTake(page: Page, id: string) {
  return page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<
          string,
          { data?: { sample?: { bytesB64: string; bits: number; channels: number; rate: number; durationSec: number } } } | undefined
        >;
      };
    };
    const s = w.__patch.nodes[n]?.data?.sample;
    if (!s) return null;
    const bin = atob(s.bytesB64);
    const stride = Math.ceil(s.bits / 8) * s.channels;
    const frames = Math.floor(bin.length / stride);
    const peaks = [0, 0, 0];
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const off = i * stride;
      let v: number;
      if (s.bits === 16) {
        v = (bin.charCodeAt(off) | (bin.charCodeAt(off + 1) << 8)) & 0xffff;
        if (v & 0x8000) v -= 0x10000;
        v /= 32767;
      } else {
        v = ((bin.charCodeAt(off) << 24) >> 24) / 127;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      const third = Math.min(2, Math.floor((i * 3) / Math.max(1, frames)));
      if (a > peaks[third]!) peaks[third] = a;
    }
    return { frames, peak, peaks, rate: s.rate, durationSec: s.durationSec, bits: s.bits, channels: s.channels };
  }, id);
}

/** NOISE -> VCA (gate) -> SAMSLOOP.audio_l_in, with the gate CLOSED. */
async function buildGatedPatch(page: Page) {
  await spawnPatch(
    page,
    [
      { id: 'n', type: 'noise', position: { x: 60, y: 200 } },
      // base defaults to 0 — the VCA ships CLOSED (Eurorack convention), so the
      // chain is exactly silent until `setGate(page, true)`.
      { id: 'v', type: 'vca', position: { x: 300, y: 200 } },
      { id: 's', type: 'samsloop', position: { x: 560, y: 200 } },
    ],
    [
      {
        id: 'e_nv',
        from: { nodeId: 'n', portId: 'white' },
        to: { nodeId: 'v', portId: 'audio' },
        sourceType: 'noise',
        targetType: 'vca',
      },
      {
        id: 'e_vs',
        from: { nodeId: 'v', portId: 'audio' },
        to: { nodeId: 's', portId: 'audio_l_in' },
        sourceType: 'vca',
        targetType: 'samsloop',
      },
    ],
    { mountTimeout: 40_000 },
  );
}

/**
 * Open samsloop's dock full view and wait for its surface to mount.
 *
 * ⚠ THE SURFACE IS THE FACEPLATE NOW, NOT THE CARD. samsloop entered
 * `STRICT_FACES`, and `DockFullView` reads `migrated()` alone — so the dock
 * renders `ModuleShell` and `samsloop-card` never appears on either surface.
 * This spec's SUBJECT is unchanged and if anything sharper: #1588 was a take
 * destroyed by a COMPONENT UNMOUNT, and the promotion swapped which component
 * unmounts without changing that the take must not care. The waited-on element
 * is the face's own body, which only the faceplate renders.
 */
async function openSamsloopFace(page: Page) {
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(id),
    's',
  );
  await expect(page.getByTestId('samsloop-output-body')).toBeVisible({ timeout: 20_000 });
}

/** The face's REC transport. The shell names a cell `shell-cell-<familyId>`
 *  (`ModuleShell.cellTestId`), so the family id is the whole identifier — the
 *  `-{n}` suffix is a FACE-KEY spelling and never reaches the DOM.
 *  ⚠ Unlike the card's button it carries a STATIC caption, so "is it
 *  recording?" is read from the registry via `nodeTake`, which was always the
 *  stronger observable anyway. */
const REC_CELL = 'shell-cell-samsloop-rec';

test('a SAMSLOOP take keeps GROWING while its card is collapsed, and captures audio the card never saw', async ({
  page,
}) => {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await buildGatedPatch(page);
  await openSamsloopFace(page);

  const rec = page.getByTestId(REC_CELL);
  // ⚠ NO CAPTION ASSERTION. The card's button relabelled itself REC ↔ STOP; the
  // face cell's caption is static, because a faceplate paints no derived state.
  // The transport's real state is polled off the NODE below — which was always
  // the stronger observable, since a caption can be right while the pump is
  // dead and that is the exact half-fix #1531 warned about.
  await expect(rec).toBeEnabled();
  await rec.click();
  await expect.poll(async () => (await nodeTake(page, 's')).recording, { timeout: 20_000 }).toBe(true);

  // Establish a real baseline WITH the card mounted. The gate is closed, so this stretch
  // of the take is silence — which is exactly what makes the energy assertion at the end
  // attributable to the collapsed span alone.
  const before = await waitForTakePast(page, 's', 0.2, 15_000);
  expect(
    before.ok,
    `the take did not grow even WITH the card mounted (units: SECONDS of take): ${JSON.stringify(before)}`,
  ).toBe(true);

  // ── THE ACT UNDER TEST: collapse. This unmounts the card. ──
  await page.getByTestId('faceplate-collapse').click();
  await expect(page.getByTestId('samsloop-output-body')).toHaveCount(0, { timeout: 15_000 });

  const atCollapse = await nodeTake(page, 's');
  expect(
    atCollapse.recording,
    'the take was DESTROYED by the collapse — this is the #1588 regression',
  ).toBe(true);

  // Open the gate ONLY now: everything audible in the finished take is captured while no
  // card exists.
  await setGate(page, true);

  const after = await waitForTakePast(page, 's', atCollapse.elapsed + 0.5, 25_000);
  expect(
    after.ok,
    `the take did not grow while collapsed (frozen pump). atCollapse=${atCollapse.elapsed.toFixed(4)}s ` +
      `now=${after.elapsed.toFixed(4)}s frames=${after.frames} distinct samples=${after.samples} ` +
      `last=${JSON.stringify(after.seen)} wall=${after.wallElapsed.toFixed(3)}s over ${Math.round(after.elapsedMs)}ms`,
  ).toBe(true);
  expect(after.elapsed, 'and it advanced MONOTONICALLY across the collapse').toBeGreaterThan(
    atCollapse.elapsed,
  );

  // Close the gate again BEFORE re-expanding, so the audible window is bounded on both
  // sides by "no card mounted".
  await setGate(page, false);

  // Re-expand: the remounted card must adopt the SAME running take, not a fresh idle one.
  await openSamsloopFace(page);
  // The remounted surface must adopt the SAME running take rather than a fresh
  // idle one. Read off the NODE, not the caption — see the note at the first
  // press for why the caption stopped being an observable.
  await expect
    .poll(async () => (await nodeTake(page, 's')).recording, { timeout: 10_000 })
    .toBe(true);

  await page.getByTestId(REC_CELL).click();
  await expect.poll(async () => (await nodeTake(page, 's')).recording, { timeout: 20_000 }).toBe(false);

  const take = await measureTake(page, 's');
  expect(take, 'STOP must have committed node.data.sample').not.toBeNull();
  expect(
    take!.peak,
    `the committed take is SILENT — the audio played while the card was collapsed never ` +
      `reached the accumulator. peak=${take!.peak.toFixed(5)} thirds=${JSON.stringify(take!.peaks.map((p) => +p.toFixed(5)))} ` +
      `frames=${take!.frames} dur=${take!.durationSec.toFixed(3)}s`,
  ).toBeGreaterThan(AUDIBLE_PEAK);
  // …and the take is longer than what had been captured at the moment of the collapse.
  expect(
    take!.durationSec,
    `the committed take (${take!.durationSec.toFixed(3)}s) is no longer than it was at the collapse ` +
      `(${atCollapse.elapsed.toFixed(3)}s), so nothing after the collapse was kept`,
  ).toBeGreaterThan(atCollapse.elapsed);
});

test('POSITIVE CONTROL: the same probe, with the card mounted the whole time', async ({ page }) => {
  // Without this leg the test above proves nothing when it fails: a red run could equally
  // mean "the gate never opened", "noise is inaudible on this runner", "the decoder is
  // wrong" or "the threshold is too high". This runs the IDENTICAL gate/decode/threshold
  // with no collapse at all, so those explanations are excluded by construction and a red
  // collapse leg can only mean the collapse.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await buildGatedPatch(page);
  await openSamsloopFace(page);

  await page.getByTestId(REC_CELL).click();
  await expect.poll(async () => (await nodeTake(page, 's')).recording, { timeout: 20_000 }).toBe(true);

  const before = await waitForTakePast(page, 's', 0.2, 15_000);
  expect(before.ok, `the take did not grow at all: ${JSON.stringify(before)}`).toBe(true);

  await setGate(page, true);
  const after = await waitForTakePast(page, 's', before.elapsed + 0.5, 25_000);
  expect(after.ok, `the take stalled with the card mounted: ${JSON.stringify(after)}`).toBe(true);
  await setGate(page, false);

  await expect(page.getByTestId('samsloop-output-body')).toBeVisible();
  await page.getByTestId(REC_CELL).click();
  await expect.poll(async () => (await nodeTake(page, 's')).recording, { timeout: 20_000 }).toBe(false);

  const take = await measureTake(page, 's');
  expect(take, 'STOP must have committed node.data.sample').not.toBeNull();
  expect(
    take!.peak,
    `the gated source produced NO audible energy even with the card mounted — the probe, ` +
      `not the fix, is what is broken. peak=${take!.peak.toFixed(5)} ` +
      `thirds=${JSON.stringify(take!.peaks.map((p) => +p.toFixed(5)))} frames=${take!.frames}`,
  ).toBeGreaterThan(AUDIBLE_PEAK);
});

test('NEGATIVE CONTROL: deleting the node DOES end its take', async ({ page }) => {
  // Without this leg the test above would pass just as happily if the registry simply
  // never ended a take at all — which would be a leak, not a fix. This proves the sweep
  // can still tear down, so "survives collapse" is a real discrimination.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await buildGatedPatch(page);
  await openSamsloopFace(page);

  await page.getByTestId(REC_CELL).click();
  await expect.poll(async () => (await nodeTake(page, 's')).recording, { timeout: 20_000 }).toBe(true);
  const running = await waitForTakePast(page, 's', 0.15, 15_000);
  expect(running.ok, `baseline: the take must be live before we delete it: ${JSON.stringify(running)}`).toBe(true);

  // Remove the node from the graph — the ONE event besides STOP that may end a take.
  // `__patch` is the live store spawnPatch writes into, so Canvas's sweep sees this
  // exactly as it sees a menu / lasso / undo / peer delete.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    delete g.__patch.nodes['s'];
  });

  await expect
    .poll(async () => (await nodeTake(page, 's')).recording, {
      timeout: 20_000,
      message: 'a deleted node kept recording — the sweep is not reaching the samsloop registry',
    })
    .toBe(false);
});
