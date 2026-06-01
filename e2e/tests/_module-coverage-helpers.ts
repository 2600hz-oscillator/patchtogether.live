// e2e/tests/_module-coverage-helpers.ts
//
// Shared per-module-coverage helpers. Built lazily as the group-by-group
// coverage PRs need them — start minimal, grow under demand. Lives next
// to _helpers.ts (spawnPatch + readStatus) so test files only have to
// import from one place per concern.

import type { Page } from '@playwright/test';

/**
 * Read a scope module's analyser snapshot via the dev `__engine` hook.
 * Returns ch1 + ch2 Float32 arrays + the sample rate so callers can
 * convert sample counts to time. Mirrors the pattern from
 * `e2e/tests/voice-chain.spec.ts` (which inlines this read each time).
 *
 * `null` is returned if the engine isn't ready yet — callers should
 * usually wait for a `waitForTimeout` after wiring before reading.
 */
export async function readScopeSnapshot(
  page: Page,
  scopeNodeId: string,
): Promise<{ ch1: Float32Array; ch2: Float32Array; sampleRate: number } | null> {
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
      | { ch1: Float32Array; ch2: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return null;
    // Return plain arrays so they cross the page->node boundary intact.
    return {
      ch1: Array.from(snap.ch1) as unknown as Float32Array,
      ch2: Array.from(snap.ch2) as unknown as Float32Array,
      sampleRate: snap.sampleRate,
    };
  }, scopeNodeId);
}

/**
 * Compute peak + rms + nonzero-count summary from a Float32-like array.
 * Tests use this to assert "audio is flowing" without baking in exact
 * threshold semantics in every spec. Returns a `Summary` value object.
 */
export interface AudioSummary {
  peak: number;
  rms: number;
  nonzeroSamples: number;
  totalSamples: number;
}

export function summarize(samples: ArrayLike<number>): AudioSummary {
  let peak = 0;
  let energy = 0;
  let nonzero = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
    if (a > 1e-6) nonzero++;
  }
  return { peak, rms: Math.sqrt(energy / Math.max(1, n)), nonzeroSamples: nonzero, totalSamples: n };
}

/**
 * Wait a fixed wall-clock duration (ms). Thin wrapper for readability
 * in tests — `await runFor(page, 500)` reads better than
 * `await page.waitForTimeout(500)` when scattered through a long spec.
 */
export async function runFor(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Poll a scope's analyser over `windowMs` and return the MAX peak seen.
 * A single readScopeSnapshot only captures the ~50ms analyser buffer at
 * one instant — for envelope-driven voices (e.g. a 303's single-decay
 * amp env retriggered at 240 BPM) that instant can land in a decay
 * trough, so the one-shot peak dips under the alive-floor and the test
 * flakes. Max-holding across the whole drive window makes "does this
 * voice ever make sound?" robust for percussive/decaying/gated sources
 * without weakening the assertion (a truly silent module never crosses
 * the floor). Returns running max peak/rms + the snapshot count.
 */
export async function readScopePeakOverWindow(
  page: Page,
  scopeNodeId: string,
  windowMs: number,
  pollMs = 60,
): Promise<{ peak: number; rms: number; polls: number }> {
  const deadline = Date.now() + windowMs;
  let peak = 0;
  let rms = 0;
  let polls = 0;
  while (Date.now() < deadline) {
    const snap = await readScopeSnapshot(page, scopeNodeId);
    if (snap) {
      const s = summarize(snap.ch1);
      if (s.peak > peak) peak = s.peak;
      if (s.rms > rms) rms = s.rms;
      polls++;
    }
    await page.waitForTimeout(pollMs);
  }
  return { peak, rms, polls };
}

/**
 * Mutate one node's `params` record inside a Yjs transaction. Tests
 * use this to retroactively change a knob value (e.g. master fader,
 * sequencer bpm) without re-spawning the patch. Wraps `__ydoc.transact`
 * so the change replicates correctly to peers in collab tests too.
 */
export async function setNodeParams(
  page: Page,
  nodeId: string,
  params: Record<string, number>,
): Promise<void> {
  await page.evaluate(
    ({ id, p }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const node = w.__patch.nodes[id];
        if (!node.params) node.params = {};
        for (const [k, v] of Object.entries(p)) node.params[k] = v;
      });
    },
    { id: nodeId, p: params },
  );
}
