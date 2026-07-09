// e2e/tests/_scheduler-control.ts
//
// Deterministic scheduler control for playhead-vs-sounding-step tests.
//
// Why this exists
// ---------------
// Sequencer / DRUMSEQZ / SCORE et al. expose `currentStep` / `currentNoteId`
// via `engine.read(node, key)`. Internally each module computes the value as
// `playhead.currentAt(ctx.currentTime)` — i.e. the answer changes with
// AudioContext.currentTime. A test that says "wait N ms, then assert step=K"
// is structurally racy:
//   - waitForTimeout sleeps wall-clock, not audio-clock; under CI load the
//     scheduler may already have advanced past K by the time the assertion
//     runs.
//   - Even if you read fast, between the assert and the read, more time
//     passes and the answer can be different on repeat reads.
//
// Strategy
// --------
// 1. Drive playback by *step target*, not wall-clock. Use
//    `waitForSoundingStep(page, id, K)` to block until the audio thread
//    reports `currentStep === K` (or any value in an inclusive range).
// 2. Immediately call `freezeAudioClock(page)` — this calls `ctx.suspend()`
//    which halts AudioContext.currentTime. After this, every
//    `engine.read('currentStep')` returns the same value, because the
//    playhead's "now" is frozen.
// 3. Assert deterministically. Re-read as many times as you want — same
//    answer. No flake possible.
// 4. Call `unfreezeAudioClock(page)` if the test needs to advance further;
//    otherwise let test teardown drop the page.
//
// Why suspend/resume (not a fake clock)
// -------------------------------------
// The module reads `ctx.currentTime` directly via a closure on the
// AudioContext. Injecting a fake clock would require threading an indirection
// through every per-module scheduler — invasive and risky. Suspend/resume is
// the existing AudioContext API and is already used by VRT (see
// e2e/vrt/vrt-composite-coverage.spec.ts) for the same "freeze the audio
// graph so the visual state is stable" purpose. The playhead trackers
// (packages/web/src/lib/audio/modules/playhead-tracker.ts) have a sticky
// `lastSounding` that holds across reads, so a suspended-clock read is the
// most-recent-sounding step at the moment of suspend — exactly what we want
// to assert.
//
// One nuance: while suspended, the scheduler clock Worker continues to fire
// tick() callbacks, but each tick calls `ctx.currentTime` which is now
// stationary — so the lookahead loop refuses to queue new steps until
// resume. The playhead state therefore stays still, by design.

import type { Page } from '@playwright/test';

interface EngineGlobals {
  __engine?: () => {
    ctx: AudioContext;
    read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
  } | null;
  __patch: {
    nodes: Record<string, { id: string; type: string; domain: string }>;
  };
}

/**
 * Wait until the engine reports `currentStep === target` for the given node.
 * Polls every 25 ms (matches SCHEDULER_TICK_MS so the underlying scheduler
 * has a chance to advance between polls). Throws on timeout.
 */
export async function waitForSoundingStep(
  page: Page,
  nodeId: string,
  target: number,
  opts: { key?: string; timeoutMs?: number } = {},
): Promise<void> {
  const key = opts.key ?? 'currentStep';
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await page.waitForFunction(
    ({ id, k, t }) => {
      const w = globalThis as unknown as EngineGlobals;
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      const v = eng.read(node, k);
      return typeof v === 'number' && v === t;
    },
    { id: nodeId, k: key, t: target },
    { timeout: timeoutMs, polling: 25 },
  );
}

/**
 * Atomically wait for `currentStep === target` AND immediately suspend the
 * AudioContext in the same browser microtask — eliminates the Playwright
 * round-trip race where the audio clock can advance past `target` in the
 * ~50–200 ms between `waitForSoundingStep` returning to Node.js and a
 * separate `freezeAudioClock` call completing.
 *
 * After this resolves the audio clock is suspended (same state as after
 * `waitForSoundingStep` + `freezeAudioClock`) and every subsequent
 * `readEngineValue` call is deterministic.
 */
export async function waitForSoundingStepAndFreeze(
  page: Page,
  nodeId: string,
  target: number,
  opts: { key?: string; timeoutMs?: number } = {},
): Promise<void> {
  const key = opts.key ?? 'currentStep';
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  await page.evaluate(
    async ({ id, k, t, dl }) => {
      const w = globalThis as unknown as EngineGlobals & { Date: typeof Date };
      const eng = w.__engine?.();
      if (!eng) throw new Error('waitForSoundingStepAndFreeze: engine not ready');
      while (Date.now() < dl) {
        const node = w.__patch.nodes[id];
        if (node) {
          const v = eng.read(node, k);
          if (typeof v === 'number' && v === t) {
            try { await eng.ctx.suspend(); } catch { /* already suspended */ }
            return;
          }
        }
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      throw new Error(`waitForSoundingStepAndFreeze: timeout waiting for ${id}.${k} === ${t}`);
    },
    { id: nodeId, k: key, t: target, dl: deadline },
  );
}

/**
 * Wait until the engine reports `currentNoteId === target` for a SCORE-like
 * node (target may be a string id or null).
 */
export async function waitForCurrentNoteId(
  page: Page,
  nodeId: string,
  target: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await page.waitForFunction(
    ({ id, t }) => {
      const w = globalThis as unknown as EngineGlobals;
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id];
      if (!eng || !node) return false;
      const v = eng.read(node, 'currentNoteId');
      return v === t;
    },
    { id: nodeId, t: target },
    { timeout: timeoutMs, polling: 25 },
  );
}

/**
 * Suspend the AudioContext so AudioContext.currentTime stops advancing.
 * After this returns, every `engine.read('currentStep')` is deterministic
 * (same answer on every read) until `unfreezeAudioClock` is called.
 */
export async function freezeAudioClock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as unknown as EngineGlobals;
    const eng = w.__engine?.();
    if (!eng) return;
    try {
      await eng.ctx.suspend();
    } catch {
      /* already suspended or context closed — both fine */
    }
  });
}

/**
 * Resume the AudioContext. Step advancement continues from the playhead's
 * frozen position. Usually only needed when a test wants to advance past
 * the first freeze to assert a later step.
 */
export async function unfreezeAudioClock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = globalThis as unknown as EngineGlobals;
    const eng = w.__engine?.();
    if (!eng) return;
    try {
      await eng.ctx.resume();
    } catch {
      /* */
    }
  });
}

/**
 * Read an engine value for `nodeId` under `key`. Strongly typed wrapper that
 * also serves as documentation: tests should call this AFTER freezeAudioClock
 * to get a stable read.
 */
export async function readEngineValue<T = unknown>(
  page: Page,
  nodeId: string,
  key: string,
): Promise<T | null> {
  return (await page.evaluate(
    ([id, k]) => {
      const w = globalThis as unknown as EngineGlobals;
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes[id as string];
      if (!node) return null;
      return eng.read(node, k as string) as unknown;
    },
    [nodeId, key] as const,
  )) as T | null;
}
