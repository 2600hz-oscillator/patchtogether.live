// e2e/tests/sequencer-clock-without-play.spec.ts
//
// PR fix/clock-without-play — orthogonality contract between play_cv and the
// clock input across all 4 sequencers (sequencer / drumseqz / score /
// polyseqz).
//
// Truth table (locked by these tests):
//
//   | playing | clockConnected | playCvConnected | shouldRun |
//   |---------|----------------|-----------------|-----------|
//   | true    | *              | *               | true      | (Play button OR play_cv high)
//   | false   | true           | false           | true      | clock-only mode (← bug PR-82 introduced)
//   | false   | true           | true            | false     | play_cv patched + low → respect play_cv
//   | false   | false          | *               | false     | stopped
//
// The "clock-only" case is the headline bug fix: previously, gating the
// sequencer tick on `playing` alone meant a patched-but-unplayed clock
// couldn't drive the sequencer. The clock pulses ARE the play signal when
// play_cv isn't patched.
//
// Test strategy mirrors sequencer-clock.spec.ts: a fast clock source
// (TIMELORDE at high BPM) feeds the sequencer's clock input. We poll
// engine.read(node, 'totalAdvances') and assert the sequencer advanced
// (or didn't, depending on the case).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

// Serial mode: each test reuses the same page to avoid 5+ concurrent page.goto
// loads overwhelming the Vite dev server (we observed waitForFunction timeouts
// when run with the default parallel scheduler — the dev server's optimize-deps
// pass blocks new connections for tens of seconds under load). Within the file
// the runtime is still bounded by the dev server's bandwidth, but each test
// gets 30s of wall-clock budget instead of a shared 30s deadline.
test.describe.configure({ mode: 'serial' });

interface SeqCfg {
  type: string;
  /** Length param to keep the sequencer cycling tightly so totalAdvances
   *  accumulates fast even at modest clock rates. */
  spawnParams: Record<string, number>;
}

const SEQUENCERS: SeqCfg[] = [
  { type: 'sequencer', spawnParams: { length: 4, bpm: 30 } },
  { type: 'drumseqz',  spawnParams: { length: 4, bpm: 30 } },
  { type: 'score',     spawnParams: { bpm: 30 } },
  { type: 'polyseqz',  spawnParams: { length: 4, bpm: 30 } },
];

/** Helper: read totalAdvances off the named module via the dev __engine. */
async function readTotalAdvances(
  page: import('@playwright/test').Page,
  nodeId: string,
): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return -1;
    const node = w.__patch.nodes[id];
    if (!node) return -1;
    const cs = eng.read(node, 'totalAdvances');
    return typeof cs === 'number' ? cs : -1;
  }, nodeId);
}

for (const s of SEQUENCERS) {
  test.describe(`${s.type}: clock-without-play orthogonality`, () => {
    test(`${s.type}: clock patched + play_cv NOT patched + isPlaying=0 → advances at clock rate`, async ({ page, rack }) => {
      // The headline bug fix: clock pulses should drive the sequencer even
      // when isPlaying is 0 and play_cv is unpatched.

      await spawnPatch(
        page,
        [
          {
            id: 'clk',
            type: 'sequencer',
            // Fast clock source: 480 BPM ⇒ 32 16th-pulses/sec on the chain
            // out. We use a Sequencer (not TIMELORDE) as the clock source
            // because TIMELORDE is a singleton — using it here would
            // interfere with other parallel tests in this describe.
            params: { bpm: 480, length: 4, isPlaying: 1 },
          },
          {
            id: 'subj',
            type: s.type,
            // isPlaying=0 + low internal BPM. Without the fix, the subject
            // would not advance. With the fix, it advances on each clock
            // pulse.
            params: { ...s.spawnParams, isPlaying: 0 },
          },
        ],
        [
          {
            id: 'eclk',
            from: { nodeId: 'clk',  portId: 'clock' },
            to:   { nodeId: 'subj', portId: 'clock' },
            sourceType: 'gate',
            targetType: 'gate',
          },
        ],
      );

      // Poll for advances rather than a single sample after a fixed wait —
      // engine startup + edge reconciliation can take a beat under dev-server
      // load, and the clock-only path's first reset tick wipes the edge
      // counter, so the first ~50ms of clock samples are intentionally
      // discarded. Given a 480 BPM 16th source = 32 pulses/sec, even with
      // ~100ms of warmup we should see >= 3 advances within a few seconds.
      // Generous timeout (10s) absorbs cold-start dev-server load when this
      // test happens to be the first to spin up an AudioContext on a freshly-
      // booted Vite worker.
      await expect
        .poll(
          async () => await readTotalAdvances(page, 'subj'),
          { timeout: 10_000, intervals: [100, 100, 200, 200, 500, 500, 1000] },
        )
        .toBeGreaterThanOrEqual(3);
    });

    test(`${s.type}: free-run mode (no clock, no play_cv) — Play button toggle still works`, async ({ page, rack }) => {
      // Regression: the original "press Play with no patches" path must
      // continue to advance via internal BPM.

      await spawnPatch(
        page,
        [
          {
            id: 'subj',
            type: s.type,
            // isPlaying=1 with high BPM so we accumulate advances quickly.
            params: { ...s.spawnParams, bpm: 480, isPlaying: 1 },
          },
        ],
        [],
      );

      await expect
        .poll(
          async () => await readTotalAdvances(page, 'subj'),
          { timeout: 10_000, intervals: [100, 100, 200, 200, 500, 500, 1000] },
        )
        .toBeGreaterThanOrEqual(3);
    });

    test(`${s.type}: play_cv patched + clock patched + play_cv LOW → does NOT advance (play_cv overrides)`, async ({ page, rack }) => {
      // play_cv-patched semantics: play_cv state wins over clock-only mode.
      // We patch BOTH clock AND play_cv and leave play_cv low (the source
      // never sends a rising edge). The sequencer should stay stopped even
      // though clock pulses are arriving.

      await spawnPatch(
        page,
        [
          {
            id: 'clk',
            type: 'sequencer',
            params: { bpm: 480, length: 4, isPlaying: 1 },
          },
          {
            id: 'silence',
            type: 'sequencer',
            // Internal-BPM Sequencer with isPlaying=0 — its `gate` output
            // stays low forever, simulating a play_cv source that never
            // fires. (We can't simply leave the port unwired because that's
            // the case under test in another assertion; we need play_cv
            // marked as connected but with no rising edges.)
            params: { bpm: 30, length: 16, isPlaying: 0 },
          },
          {
            id: 'subj',
            type: s.type,
            // isPlaying=0 — should remain stopped because play_cv is patched.
            params: { ...s.spawnParams, isPlaying: 0 },
          },
        ],
        [
          {
            id: 'eclk',
            from: { nodeId: 'clk',  portId: 'clock' },
            to:   { nodeId: 'subj', portId: 'clock' },
            sourceType: 'gate',
            targetType: 'gate',
          },
          {
            id: 'eplay',
            from: { nodeId: 'silence', portId: 'gate' },
            to:   { nodeId: 'subj',    portId: 'play_cv' },
            sourceType: 'gate',
            targetType: 'gate',
          },
        ],
      );

      // Wait long enough to be confident the sequencer would have advanced
      // if the gate were broken — 800ms at the source's clock rate should
      // produce ~25 pulses if the sequencer were running. Then assert it
      // didn't advance.
      await page.waitForTimeout(800);

      const advances = await readTotalAdvances(page, 'subj');
      expect(
        advances,
        `${s.type}: should NOT advance when play_cv is patched but low, even with clock patched`,
      ).toBeLessThanOrEqual(1);
    });
  });
}
