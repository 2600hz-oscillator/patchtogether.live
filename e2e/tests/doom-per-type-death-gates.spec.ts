// doom-per-type-death-gates.spec.ts
//
// E2E coverage for the per-monster-type kill + per-player death gates
// added in feat/doom-per-type-death-gates. Each new gate output is the
// same shape as the existing evt_kill / evt_door / evt_gun_pN gate ports:
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
import { pollGatePulsePeak, gatePulseMsg } from '../_helpers/scope-poll';

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

// ⚠ A LOCAL `firePulse` HELPER STOOD HERE AND IS DELETED. It fired N pulses
// spaced `spacingMs` apart from the TEST side, once per `expect.poll` round, so
// every pulse cost a CDP round trip on the same main thread as the audio graph
// and DOOM's own frame loop. `pollGatePulsePeak` fires from inside the page on
// its own timer, beside the sampler that latches the result — see its header
// for why the coincidence this replaced could not survive a loaded shard.

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

      await page.goto('/rack?seed=none');
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

      // Shell-agnostic node locator: xyflow stamps the wrapper class from the
      // EMITTED node type, which is `moduleShell` for every lane node, so a
      // per-type class matches nothing. `:has` keeps the wrapper semantics.
      await page.locator('.svelte-flow__node:has([data-shell-type="scope"])').first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400);

      // Baseline: scope.ch1 should sit at 0 (CSN resting offset). The DELTA
      // after forcePulse is the assertion.
      const before = await readScopePeak(page, scopeNodeId);

      // ⚠ THE FIRE-THEN-READ LOOP IS GONE, AND ITS OWN COMMENT SAID WHY IT HAD
      // TO. It read: "a 10ms pulse against ~43ms analyser refresh is borderline,
      // so we re-fire until the snapshot lands during a HIGH window." That is a
      // probe built on a COINCIDENCE — the pulse must still be inside the
      // analyser window at the moment one particular CDP round trip reads it —
      // and each round trip runs on the same main thread as the audio graph.
      // On a loaded shard the coincidence stops happening: `evt_kill_demon`
      // went 0-amplitude on CI again on 2026-09-05, exactly as the note
      // predicted, and gibribbon's identical hand-rolled probe lost a DIFFERENT
      // port on each of two runs.
      //
      // `pollGatePulsePeak` pulses AND samples in the page on independent
      // timers and LATCHES the peak, so the pulse only has to be caught once by
      // any sample, ever. Measured on gibribbon's five ports, which share this
      // shape: ~5-6 s each and rotating failures, down to 1.4 s each and stable.
      //
      // ⚠ DOOM'S OWN WAITS ARE UNTOUCHED. The `10_000` locator wait and the
      // `waitForTimeout(400)` settle above are deliberate, predate this file's
      // current shape, and belong to the game-clock-is-frame-clock discipline
      // (#345 lockstep starvation) — the seam change lands entirely below them
      // and needed no help from either. They stay exactly as they are.
      const r = await pollGatePulsePeak(page, {
        sourceNodeId: doomNodeId,
        port: pair.port,
        scopeNodeId,
        threshold: 0.1,
        // Unchanged in value from the ceiling this replaces: DOOM boot +
        // worklet start still has to fit, and a latched probe that is healthy
        // returns in ~1-2 s, so the ceiling costs nothing when it is not needed.
        boundMs: 20_000,
      });

      expect(
        r.hookFound,
        `${pair.id}: extras.forcePulse never resolved — ${gatePulseMsg(pair.id, r)}`,
      ).toBe(true);
      expect(
        r.reachedThreshold,
        `${pair.id}: pulse never reached SCOPE.ch1 — ${gatePulseMsg(pair.id, r)}`,
      ).toBe(true);

      expect(before, `${pair.id}: baseline scope read must succeed`).not.toBeNull();

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
