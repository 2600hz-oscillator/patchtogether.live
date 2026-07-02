// doom-per-type-death-gates.spec.ts
//
// E2E coverage for the per-monster-type kill + per-player death gates
// added in feat/doom-per-type-death-gates. Each new gate output is the
// same shape as the existing evt_kill / evt_door / evt_gun_pN ports:
// 10 ms pulse, subscribePulse-compatible, routed through the cross-domain
// audio bridge. We drive them via the same `extras.forcePulse(port)` test
// hook as video-audio-cvgate-coverage.spec.ts (no in-game-kill flake) and
// assert the bridged signal lands on a downstream SCOPE's analyser.
//
// What this catches that the unit sweep doesn't:
//   * doomDef.outputs registration → engine cross-domain dispatcher path
//     → live AudioContext → AnalyserNode snapshot, end-to-end with a real
//     browser. The unit-level engine-video-audio-bridge sweep proves the
//     dispatcher wires every gate; this spec proves the wiring actually
//     produces a signal on the audio sink.
//   * The forcePulse contract for the NEW (string-typed) port surface —
//     pre-fix it was a hard union of 6 literals; if a future change drops
//     the per-monster / per-player branches the e2e fails loudly.
//
// Skipped cleanly when the DOOM WASM asset isn't built (CI builds it; a
// local dev who hasn't run `bash packages/web/native/build-doom-wasm.sh`
// will see this as a `test.skip`).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

// Per-port forcePulse pair — same shape as
// video-audio-cvgate-coverage.spec.ts but for the NEW gates only. Coverage
// is a representative sample: a shareware monster (Imp), a non-shareware
// monster (Cyberdemon — exercises the path regardless of WAD scope at
// forcePulse-time since WASM events aren't required), and per-player
// deaths for P1 + P4 (the boundary slots). The unit-level
// engine-video-audio-bridge .each sweep proves the dispatcher wires
// EVERY remaining gate identically.
interface Pair {
  id: string;
  /** Source port id on the DOOM node. */
  port: string;
  /** Human-readable description for failure messages. */
  desc: string;
}

const PAIRS: Pair[] = [
  { id: 'evt_kill_imp',    port: 'evt_kill_imp',    desc: 'Imp kill (shareware E1)' },
  { id: 'evt_kill_demon',  port: 'evt_kill_demon',  desc: 'Demon kill (shareware E1)' },
  { id: 'evt_kill_baron',  port: 'evt_kill_baron',  desc: 'Baron of Hell kill (shareware E1 boss)' },
  { id: 'evt_kill_cyber',  port: 'evt_kill_cyber',  desc: 'Cyberdemon kill (DOOM II only — port still routable)' },
  { id: 'evt_p1_dies',     port: 'evt_p1_dies',     desc: 'P1 player death' },
  { id: 'evt_p4_dies',     port: 'evt_p4_dies',     desc: 'P4 player death (boundary slot)' },
];

async function doomWasmPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

async function firePulse(
  page: Page,
  sourceNodeId: string,
  port: string,
  repeats = 1,
  spacingMs = 40,
): Promise<boolean> {
  return await page.evaluate(
    async ({ nodeId, p, n, s }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[nodeId];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { forcePulse?: (port: string) => void }
        | undefined;
      if (!extras || typeof extras.forcePulse !== 'function') return false;
      for (let i = 0; i < n; i++) {
        extras.forcePulse(p);
        if (i < n - 1) await new Promise((r) => setTimeout(r, s));
      }
      return true;
    },
    { nodeId: sourceNodeId, p: port, n: repeats, s: spacingMs },
  );
}

async function readScopePeak(
  page: Page,
  scopeNodeId: string,
): Promise<{ peak: number; rms: number } | null> {
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
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeNodeId);
}

test.describe.configure({ mode: 'serial' });

test.describe('DOOM per-type death gates: every new gate routes via forcePulse → SCOPE.ch1', () => {
  for (const pair of PAIRS) {
    test(`${pair.id} (${pair.desc}): pulse propagates through the audio bridge`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      const present = await doomWasmPresent(page);
      test.skip(
        !present,
        'DOOM WASM not built — run `bash packages/web/native/build-doom-wasm.sh`',
      );

      const doomNodeId = `src-doom-${pair.id}`;
      const scopeNodeId = `cons-scope-${pair.id}`;

      await spawnPatch(
        page,
        [
          { id: doomNodeId, type: 'doom', position: { x: 80, y: 80 }, domain: 'video' },
          { id: scopeNodeId, type: 'scope', position: { x: 540, y: 80 }, domain: 'audio' },
        ],
        [
          {
            id: `e-${pair.id}-bridge`,
            from: { nodeId: doomNodeId, portId: pair.port },
            to:   { nodeId: scopeNodeId, portId: 'ch1' },
            sourceType: 'gate',
            targetType: 'audio',
          },
        ],
      );

      await page.locator('.svelte-flow__node-scope').first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400);

      // Baseline: scope.ch1 should sit at 0 (CSN resting offset). The DELTA
      // after forcePulse is the assertion.
      const before = await readScopePeak(page, scopeNodeId);

      // Fire-then-read loop: a 10ms pulse against ~43ms analyser refresh is
      // borderline, so we re-fire until the snapshot lands during a HIGH
      // window. Empirically 4-5 rounds suffice on the CI box.
      let after: { peak: number; rms: number } | null = null;
      await expect.poll(
        async () => {
          const fired = await firePulse(page, doomNodeId, pair.port, 3, 20);
          if (!fired) return 0;
          after = await readScopePeak(page, scopeNodeId);
          return after?.peak ?? 0;
        },
        { timeout: 6000, intervals: [50, 80, 120, 200, 300] },
      ).toBeGreaterThan(0.1);

      expect(before, `${pair.id}: baseline scope read must succeed`).not.toBeNull();
      expect(after,  `${pair.id}: post-drive scope read must succeed`).not.toBeNull();

      expect(
        errors.filter((e) =>
          !e.includes('AudioContext')
          && !e.includes('DOOM1.WAD')
          && !e.includes('doom.js')
        ),
        `${pair.id}: no console / page errors (AudioContext + DOOM asset warnings excepted)`,
      ).toEqual([]);
    });
  }
});
