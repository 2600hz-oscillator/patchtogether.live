// e2e/tests/_score-helpers.ts
//
// SCORE / sequencer test-setup helpers. Deliberately NOT in _helpers.ts: no
// multi-context spec uses anything here — this only seeds a SCORE node's music
// and toggles its transport, which cannot move relay/sync behavior, so it does
// not belong in the shared multi-context helper file.
//
// The split originally had a mechanical reason on top of that one: _helpers.ts
// was a hand-listed entry in the @collab attestation basis, so parking this
// here instead avoided a full ~8-min local re-attest on every edit. The collab
// attest was deleted 2026-08-17, so only the meaning-based reason survives —
// which was always the better half of the argument.

import { expect, type Page } from '@playwright/test';

/**
 * Seed a SCORE node's music into the live graph and THEN start its transport.
 *
 * ⚠ THE ORDER IS THE WHOLE POINT — it is the defect that reddened main twice
 * (c31e9be9, then run 30784972908 / `e2e (shard 9/10)`), was re-run past twice,
 * and was "fixed" once on a wrong theory: #1294 blamed CI load + propagation
 * latency under ten parallel shards and enlarged the wait. NO WAIT CAN FIX IT.
 *
 *   A note fires ONLY when the scheduler REACHES its grid tick. Grid tick 0 is
 *   emitted on the FIRST scheduler tick after `isPlaying` goes true and is
 *   never revisited unless the sequence loops. So `spawnPatch(..., isPlaying:1)`
 *   followed by a SECOND `page.evaluate` that seeds the notes is a race whose
 *   LOSS IS PERMANENT: when that round-trip lands after the engine's first
 *   tick, the note at grid tick 0 is consumed while the score is still empty.
 *   Whatever that note alone carries — the tie-START role (the only writer of
 *   `tiedGateHoldUntilTick`), the dynamic level, the sole `currentNoteId` — can
 *   then never arrive, and the readout sits on its sentinel while the engine
 *   hums along perfectly. `values seen: [-1]` with no NaN is its fingerprint:
 *   engine and node readable the whole time, just never asked to play anything.
 *
 * MEASURED (2026-08-03), seeding at +1500 ms instead of immediately:
 * `totalAdvances` was already 14 when the seed landed, and 5 s later the engine
 * had advanced 54 steps with `tiedGateHoldUntilTick` STILL -1. Not slow —
 * permanently past the only tick that could have armed it.
 *
 * So: spawn with `isPlaying: 0`, seed here, start the transport LAST. The
 * engine resets `tickIndex` to 0 on the 0→1 edge, so grid tick 0 is emitted
 * with the music already in place — by construction rather than by timing.
 *
 * Two legs make a future red DIAGNOSABLE instead of a 25 s shrug:
 *  1. A missing node THROWS and names the nodes that ARE present. The old
 *     `if (!n) return;` was a silent no-op — a seed that writes nothing and
 *     then waits is unfalsifiable from its own output. The write is also READ
 *     BACK through the live graph, so "the seed never landed" and "the engine
 *     ignored it" are different failures with different messages.
 *  2. `advancesBeforePlay` is asserted to be 0 on EVERY run — a permanent
 *     negative-control leg for the ordering guarantee itself. If the transport
 *     ever starts early again, THIS fails in ~3 s naming the cause, instead of
 *     a downstream readout expiring on a sentinel after 25 s.
 */
export async function seedScoreThenPlay(
  page: Page,
  nodeId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const notesWanted = Array.isArray(data.notes) ? data.notes.length : 0;
  const tiesWanted = Array.isArray(data.ties) ? data.ties.length : 0;

  const seeded = await page.evaluate(
    ({ nodeId, payload }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const n = w.__patch.nodes[nodeId];
      if (!n) {
        throw new Error(
          `score seed: __patch.nodes["${nodeId}"] is MISSING — the seed would have ` +
            'written NOTHING and every downstream wait would have expired on a ' +
            `sentinel. nodes present: [${Object.keys(w.__patch.nodes).join(', ')}]`,
        );
      }
      w.__ydoc.transact(() => {
        n.data = payload;
      });
      // Read BACK through the live graph, not the local object: this is the
      // assertion that the write reached the store the ENGINE reads.
      const back = w.__patch.nodes[nodeId]?.data as
        | { notes?: unknown[]; ties?: unknown[] }
        | undefined;
      return { notes: back?.notes?.length ?? -1, ties: back?.ties?.length ?? -1 };
    },
    { nodeId, payload: data },
  );
  expect(seeded.notes, `seeded notes readable back through the LIVE graph (${nodeId})`).toBe(
    notesWanted,
  );
  expect(seeded.ties, `seeded ties readable back through the LIVE graph (${nodeId})`).toBe(
    tiesWanted,
  );

  // The engine handle must be readable before we can prove the transport was
  // stopped — an unreadable engine would make the ordering leg below vacuous.
  await page.waitForFunction(
    (nid) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const e = w.__engine?.();
      const n = w.__patch.nodes[nid];
      if (!e || !n) return false;
      return typeof e.read(n, 'totalAdvances') === 'number';
    },
    nodeId,
    { timeout: 20_000 },
  );

  const start = await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (node: unknown, key: string) => unknown } | null;
      __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const e = w.__engine?.();
    const n = w.__patch.nodes[nid];
    const raw = e && n ? e.read(n, 'totalAdvances') : undefined;
    w.__ydoc.transact(() => {
      const nn = w.__patch.nodes[nid];
      if (!nn) return;
      if (!nn.params) nn.params = {};
      nn.params.isPlaying = 1;
    });
    return { advancesBeforePlay: typeof raw === 'number' ? raw : -1 };
  }, nodeId);
  expect(
    start.advancesBeforePlay,
    `the SCORE transport ("${nodeId}") was still STOPPED when the music was seeded — ` +
      'grid tick 0 (the tie-start / dynamic-bearing / sole-note slot) has NOT been ' +
      'consumed yet. A non-zero count means playback started BEFORE the seed and no ' +
      'downstream wait can recover it (see seedScoreThenPlay).',
  ).toBe(0);
}
