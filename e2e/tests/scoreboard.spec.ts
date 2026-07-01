// e2e/tests/scoreboard.spec.ts
//
// SCOREBOARD — 4-digit neon 7-segment counter. End-to-end coverage:
//   1. SEQUENCER → SCOREBOARD.score: each step's GATE pulse advances the
//      counter by 1. After ~1 second at 240 BPM (= 4 quarter-notes/sec)
//      the counter should be ~4.
//   2. A second SEQUENCER → SCOREBOARD.reset: a single rising edge clears
//      the counter back to 0.
//   3. The card's preview canvas paints non-trivial pixels (proves the
//      drawScoreboard helper actually drew the digits, not a blank frame).
//
// The counter is read via the video-engine's `read(node, 'score')` — the
// same engine API the on-card preview uses, so this also exercises the
// card↔engine wire.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Read the live counter via the video-engine's read API (the same path
 *  the card preview polls). Returns NaN if the engine or node is missing. */
async function readCounter(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => {
          read?: (n: string, k: string) => unknown;
        } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const v = ve?.read?.(nodeId, 'score');
    return typeof v === 'number' ? v : Number.NaN;
  }, nodeId);
}

/** Poll `readCounter` until it satisfies `pred` or `timeout` elapses.
 *  Mirrors the windowed-polling pattern from 4plexvid.spec — a stalled
 *  software-GL frame on CI shouldn't false-fail us. */
async function waitForCounter(
  page: Page,
  nodeId: string,
  pred: (n: number) => boolean,
  timeout = 6000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await readCounter(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(80);
    last = await readCounter(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

test.describe('SCOREBOARD — 4-digit neon 7-segment counter widget', () => {
  test('SEQUENCER gate increments the counter; RESET clears to 0; preview canvas has non-trivial pixels', async ({ page }) => {
    const errors = await setup(page);

    // Two SEQUENCERS for two independent gate streams. The first
    // (240 BPM = 4 quarter-notes/sec) drives the SCORE gate; we leave
    // the reset SEQUENCER stopped, then start it explicitly to fire
    // one RESET pulse later in the test.
    await spawnPatch(
      page,
      [
        {
          id: 'scoreSeq',
          type: 'sequencer',
          position: { x: 40, y: 40 },
          domain: 'audio',
          // 240 BPM → 4 pulses/sec. After 1 s of sequencer time we'd
          // expect ~4 increments — leaves headroom for jsdom/CI clock
          // jitter without becoming meaningless. length=8 so the SCORE
          // gate keeps firing well past our observation window.
          params: { bpm: 240, length: 8, isPlaying: 1 },
        },
        {
          id: 'resetSeq',
          type: 'sequencer',
          position: { x: 40, y: 260 },
          domain: 'audio',
          // Stays stopped until we want to fire the reset pulse.
          params: { bpm: 240, length: 4, isPlaying: 0 },
        },
        {
          id: 'sb',
          type: 'scoreboard',
          position: { x: 460, y: 60 },
          domain: 'video',
        },
      ],
      [
        // Sequencer's `clock` output fires once per step regardless of
        // step.on (the `gate` output only pulses when a step has midi +
        // is "on", and the sequencer's default steps are all off). Clock
        // = a true 0/1 pulse train that the SCOREBOARD's hysteresis
        // detector reads as a steady rising-edge stream.
        {
          id: 'e_score',
          from: { nodeId: 'scoreSeq', portId: 'clock' },
          to:   { nodeId: 'sb',       portId: 'score' },
          sourceType: 'gate',
          targetType: 'cv',
        },
        {
          id: 'e_reset',
          from: { nodeId: 'resetSeq', portId: 'clock' },
          to:   { nodeId: 'sb',       portId: 'reset' },
          sourceType: 'gate',
          targetType: 'cv',
        },
      ],
    );

    // ---- 1. SCORE gate increments the counter. ----
    // At 240 BPM the scoreSeq fires a gate every 250 ms. After ~1 s we
    // should see ≥ 2 increments (generous floor — software-GL CI is
    // slow + the audio engine's startup latency eats a tic or two on
    // first run). The HEADLINE assertion is "counter advances", and
    // the wider acceptance window lets the spec stay deterministic
    // under load.
    const advanced = await waitForCounter(page, 'sb', (n) => n >= 2, 4000);
    expect(advanced.ok, `counter advanced past 2 within 4s (saw ${advanced.last})`).toBe(true);
    // Upper-bound sanity: counter shouldn't be wildly past the gate
    // rate even with jitter (a misfired edge-detector that triggers on
    // both edges would race past 100). Generous ceiling.
    expect(advanced.last).toBeLessThan(50);

    // ---- 2. Stop SCORE gate + fire RESET. Counter returns to 0. ----
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        // Halt the score-driving sequencer so no more increments race
        // the reset path.
        const s = w.__patch.nodes['scoreSeq'];
        if (s) s.params.isPlaying = 0;
        // Start the reset sequencer — its first gate will fire ~immediately.
        const r = w.__patch.nodes['resetSeq'];
        if (r) r.params.isPlaying = 1;
      });
    });

    const reset = await waitForCounter(page, 'sb', (n) => n === 0, 4000);
    expect(reset.ok, `counter cleared to 0 after RESET gate (saw ${reset.last})`).toBe(true);

    // ---- 3. The preview canvas painted non-trivial pixels. ----
    const variance = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas[data-testid="scoreboard-screen"]',
      );
      if (!canvas) return -1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return -1;
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Mean luma + variance: a totally black canvas has mean ≈ 0 + variance ≈ 0.
      // A canvas with even faint glowing 7-segments has variance well above 5.
      const n = width * height;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      const mean = sum / n;
      let sq = 0;
      for (let i = 0; i < data.length; i += 4) {
        const y = (data[i]! + data[i + 1]! + data[i + 2]!) / 3 - mean;
        sq += y * y;
      }
      return Math.sqrt(sq / n);
    });
    expect(variance, `preview canvas variance > 5 (saw ${variance})`).toBeGreaterThan(5);

    await page.screenshot({ path: 'test-results/scoreboard.png' });
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
