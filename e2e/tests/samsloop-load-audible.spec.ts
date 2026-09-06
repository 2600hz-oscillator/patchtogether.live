// e2e/tests/samsloop-load-audible.spec.ts
//
// OWNER BUG (dev, 2026-09-06): "when i load this patch samsloop doesnt play."
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────
// The frame→fraction window rework moved START/END from frame indices to
// fractions of the sample and added a load-time migration — but ONLY on the
// `file` (upload) hydrate branch. A patch saved BEFORE the rework that holds a
// RECORDING (`node.data.sample`) or a legacy YArray (`node.data.samples`)
// loaded with its frame-indexed start/end intact; both params clamp to the
// worklet's ±2 declared range, so any touched frame index resolved to
// startFrac = 1 — a ONE-FRAME window at the sample's tail. The voice "plays"
// (playhead publishes, waveform paints, faders look right) and the output is
// the last sample repeated: DC, inaudible. The existing persistence spec
// asserts the BYTES survive — presence, not liveness — which is exactly how
// this shipped.
//
// ── WHAT THIS SPEC PINS ─────────────────────────────────────────────────────
//   1. file-path load: save → fresh page → load → TRIGGER → the scope peak
//      moves (liveness, not presence).
//   2. pre-rework RECORD patch (frame-indexed window): loads, the window
//      MIGRATES to fractions, and playback is real — the playhead SWEEPS the
//      window rather than pinning at the tail, and the output is audible.
//   3. pre-rework LEGACY-YArray patch: same assertion, third source kind.
//
// The playhead-spread read is what separates "plays the recording" from
// "emits one frame of DC forever": broken, position sits at ≈1.0 with zero
// spread; fixed, it sweeps the window.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { openSamsloopPane, samsloopIsRecording } from './_samsloop-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAV_PATH = resolve(__dirname, '../fixtures/samsloop-test.wav');

const AUDIBLE_FLOOR = 0.02;

async function setupPage(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  return errors;
}

async function saveEnvelope(page: Page): Promise<unknown> {
  const envelope = await page.evaluate(() => {
    const w = window as unknown as { __persistence?: { save?: () => unknown } };
    return w.__persistence?.save?.();
  });
  expect(envelope, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  return envelope;
}

/** Reload to a FRESH page, boot the engine (the product's load runs behind a
 *  user gesture that does this), and apply the envelope. */
async function freshLoad(page: Page, envelope: unknown): Promise<void> {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __persistence?: { load?: (env: unknown) => unknown };
      __ensureEngine?: unknown;
    };
    return typeof w.__persistence?.load === 'function' && typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  await page.evaluate((env) => {
    const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
    w.__persistence!.load!(env);
  }, envelope);
  await expect(
    page.locator('.svelte-flow__node:has([data-shell-type="samsloop"])'),
  ).toHaveCount(1, { timeout: 10_000 });
}

/** The samsloop node's live window params. */
async function readWindowParams(page: Page, id = 's'): Promise<{ start: number; end: number }> {
  return await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
    };
    const p = w.__patch.nodes[nid]?.params ?? {};
    return { start: p.start ?? 0, end: p.end ?? 1 };
  }, id);
}

/**
 * Sample the worklet-published playhead over a window and return its spread.
 * A real playing window SWEEPS (spread ≫ 0, and dips well under the tail); the
 * one-frame DC failure pins at ≈1.0 with ~zero spread.
 */
async function readPlayheadSpread(
  page: Page,
  id: string,
  windowMs: number,
): Promise<{ min: number; max: number; samples: number }> {
  return await page.evaluate(
    async ({ nid, windowMs }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      };
      let min = Infinity;
      let max = -Infinity;
      let samples = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < windowMs) {
        const eng = w.__engine?.();
        const node = w.__patch?.nodes?.[nid];
        if (eng && node) {
          const ph = eng.read(node, 'playhead') as { position: number; voices: number } | undefined;
          if (ph && ph.voices > 0 && ph.position >= 0) {
            if (ph.position < min) min = ph.position;
            if (ph.position > max) max = ph.position;
            samples++;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return { min: samples > 0 ? min : -1, max: samples > 0 ? max : -1, samples };
    },
    { nid: id, windowMs },
  );
}

async function uploadWav(page: Page, pane: Locator): Promise<void> {
  await pane.getByTestId('shell-cell-samsloop-wav-input').setInputFiles({
    name: 'samsloop-test.wav',
    mimeType: 'audio/wav',
    buffer: readFileSync(WAV_PATH),
  });
  await expect(pane.getByTestId('shell-cell-samsloop-wav-input-status')).toContainText(
    /loaded \d+ samples/i,
    { timeout: 5000 },
  );
}

function patchNodes(): SpawnNode[] {
  return [
    { id: 's', type: 'samsloop', position: { x: 400, y: 200 }, params: { mode: 1 } },
    { id: 'scp', type: 'scope', position: { x: 700, y: 200 } },
  ];
}
function patchEdges(): SpawnEdge[] {
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
/** noise → record inputs, for the RECORD-path fixtures. */
function recordNodes(): SpawnNode[] {
  return [{ id: 'n', type: 'noise', position: { x: 100, y: 200 } }, ...patchNodes()];
}
function recordEdges(): SpawnEdge[] {
  return [
    {
      id: 'e1',
      from: { nodeId: 'n', portId: 'white' },
      to: { nodeId: 's', portId: 'audio_l_in' },
      sourceType: 'noise',
      targetType: 'samsloop',
    },
    ...patchEdges(),
  ];
}

/** Record a short take through the real REC transport. */
async function recordTake(page: Page): Promise<void> {
  const pane = await openSamsloopPane(page, 's');
  const rec = pane.getByTestId('shell-cell-samsloop-rec');
  await rec.click();
  await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC arms' }).toBe(true);
  await page.waitForTimeout(500);
  await rec.click();
  await expect.poll(() => samsloopIsRecording(page, 's'), { message: 'REC stops' }).toBe(false);
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { data?: { sample?: { bytesB64?: string } } }> };
          };
          return (w.__patch.nodes['s']?.data?.sample?.bytesB64 ?? '').length;
        }),
      { message: 'take committed' },
    )
    .toBeGreaterThan(0);
}

/** Rewrite the saved window to pre-rework FRAME INDICES (what an old envelope
 *  carries): start = a quarter in, end = the full frame count. */
async function writeLegacyFrameWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<string, { params: Record<string, number>; data?: { sampleLength?: number } }>;
      };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const node = w.__patch.nodes['s']!;
    const frames = node.data?.sampleLength ?? 0;
    if (!(frames > 1)) throw new Error(`no sampleLength to frame-index against (${frames})`);
    w.__ydoc.transact(() => {
      node.params.start = Math.floor(frames / 4);
      node.params.end = frames;
    });
  });
}

/** Post-load assertions shared by the two pre-rework legs: the window migrated
 *  to fractions, a trigger is AUDIBLE, and the playhead SWEEPS the window
 *  instead of pinning at the tail (the DC failure mode). */
async function assertMigratedAndPlaying(page: Page): Promise<void> {
  // The factory's hydrate (init + 200 ms poll) runs the migration; poll for it.
  await expect
    .poll(async () => (await readWindowParams(page)).end, {
      message: 'window END migrates to a fraction (<= 1)',
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(1);
  const win = await readWindowParams(page);
  expect(win.start, `migrated start ${win.start}`).toBeGreaterThan(0.2);
  expect(win.start, `migrated start ${win.start}`).toBeLessThan(0.3);
  expect(win.end, `migrated end ${win.end}`).toBeGreaterThan(0.95);

  const pane = await openSamsloopPane(page, 's');
  await pane.getByTestId('shell-cell-samsloop-trigger').click();
  const w = await readScopePeakOverWindow(page, 'scp', 4000, { untilPeak: AUDIBLE_FLOOR });
  expect(w.peak, `post-load post-trigger peak ${w.peak} (must be audible)`).toBeGreaterThan(
    AUDIBLE_FLOOR,
  );
  // Liveness of the MECHANISM: a real loop sweeps the window. The broken state
  // pins at ≈1.0 (one-frame window at the tail) with ~zero spread.
  const ph = await readPlayheadSpread(page, 's', 700);
  expect(ph.samples, 'playhead published while playing').toBeGreaterThan(0);
  expect(ph.min, `playhead min ${ph.min} — must sweep the window, not pin at the tail`).toBeLessThan(
    0.95,
  );
}

test.describe('SAMSLOOP plays after patch load', () => {
  test('upload patch: fresh-page load, TRIGGER produces audible output', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, patchNodes(), patchEdges());
    const pane = await openSamsloopPane(page, 's');
    await uploadWav(page, pane);
    await page.waitForTimeout(600); // factory poll pushes the buffer

    // Positive control: it plays BEFORE the round-trip.
    await pane.getByTestId('shell-cell-samsloop-trigger').click();
    const before = await readScopePeakOverWindow(page, 'scp', 2000, { untilPeak: 0.05 });
    expect(before.peak, `pre-save post-trigger peak ${before.peak}`).toBeGreaterThan(0.05);

    const env = await saveEnvelope(page);
    await freshLoad(page, env);
    await page.waitForTimeout(800); // factory poll decodes + pushes

    const pane2 = await openSamsloopPane(page, 's');
    await pane2.getByTestId('shell-cell-samsloop-trigger').click();
    const after = await readScopePeakOverWindow(page, 'scp', 4000, { untilPeak: 0.05 });
    expect(after.peak, `post-load post-trigger peak ${after.peak} (must be audible)`).toBeGreaterThan(0.05);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('pre-rework RECORD patch (frame-indexed window): loads, migrates, and PLAYS', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, recordNodes(), recordEdges());
    await recordTake(page);
    await writeLegacyFrameWindow(page);

    const env = await saveEnvelope(page);
    await freshLoad(page, env);
    await assertMigratedAndPlaying(page);

    // SAME-SESSION RE-LOAD: apply the same envelope over the live rack. The
    // sample signature is unchanged, so the push branches never run — the
    // frame-indexed window written by the load must STILL migrate (the poll
    // guard), or a second load of the same old patch re-silences the module.
    await page.evaluate((e) => {
      const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
      w.__persistence!.load!(e);
    }, env);
    await assertMigratedAndPlaying(page);

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('pre-rework LEGACY-YArray patch (frame-indexed window): loads, migrates, and PLAYS', async ({ page }) => {
    const errors = await setupPage(page);
    await spawnPatch(page, patchNodes(), patchEdges());
    // Seed the LEGACY `node.data.samples` shape directly (a real pre-base64
    // patch): a loud square so the analyser floor is never the measurement.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const N = 24_000; // 0.5 s at 48 k
      const pcm: number[] = [];
      for (let i = 0; i < N; i++) pcm.push(i % 100 < 50 ? 0.8 : -0.8);
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['s'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.samples = pcm;
        n.data.sampleLength = N;
        n.data.sampleRate = 48_000;
        n.data.fileName = 'legacy-square.wav';
      });
    });
    await writeLegacyFrameWindow(page);

    const env = await saveEnvelope(page);
    await freshLoad(page, env);
    await assertMigratedAndPlaying(page);

    expect(errors, errors.join('; ')).toEqual([]);
  });
});
