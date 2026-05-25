// e2e/tests/doom-instance-model.spec.ts
//
// Slice 3 acceptance: the per-peer instance model + netcode-start wiring.
//
// The committed architecture is "one node, N runtimes": there is exactly
// ONE DOOM node on the shared rack (the host spawns it; every other peer
// sees it via Yjs sync and does NOT spawn its own). A peer becomes a
// PLAYER by JOINING — claiming a slot in `node.data.players` — at which
// point it brings up its OWN DoomRuntime + its OWN DoomNetcode bound to
// that one shared node.
//
// This 2-context test proves:
//   1. User A spawns the DOOM node; User B sees the SAME node via Yjs sync
//      (B never spawns a second node — node count stays 1 on both).
//   2. Both A and B Join → roster `node.data.players` holds both users in
//      distinct slots (0 and 1, lex-stable).
//   3. Each peer has its own DoomNetcode instance STARTED (debugStats peers
//      list is populated cross-peer).
//   4. The arbiter is the lex-min user (User A, "aaa-...").
//
// This slice does NOT launch a running netgame (slice 4's Launch); it only
// proves the instance model + roster + netcode-start wiring. Gated on WASM
// presence — skips cleanly if /doom/doom.js is absent, like the other doom
// specs. Joining requires each peer's WASM to load (the runtime is what
// netcode binds to), so the WASM gate is mandatory here.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawnPatch, type SpawnNode } from './_helpers';

interface DoomPair {
  pageA: Page;
  pageB: Page;
  close: () => Promise<void>;
}

async function checkWasmAvailable(page: Page): Promise<{ ok: boolean; reason?: string }> {
  const wasmOk = await page.evaluate(async () => {
    try {
      const r = await fetch('/doom/doom.js', { method: 'HEAD' });
      return r.ok;
    } catch { return false; }
  });
  if (!wasmOk) {
    return {
      ok: false,
      reason: 'DOOM WASM not built — run `bash packages/web/native/build-doom-wasm.sh`',
    };
  }
  const wadOk = await page.evaluate(async () => {
    try {
      const r = await fetch('/doom/DOOM1.WAD', { method: 'HEAD' });
      return r.ok;
    } catch { return false; }
  });
  if (!wadOk) {
    return { ok: false, reason: 'DOOM1.WAD missing — see static/doom/DOWNLOAD_INSTRUCTIONS.md' };
  }
  return { ok: true };
}

async function openPair(browser: Browser): Promise<DoomPair> {
  const rackspaceId = `doom-inst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(() =>
      typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }

  // A attaches first + takes the lex-smallest id so it wins the arbiter
  // tiebreak (pickHost lex-min). Both engines must be live so the video
  // domain materializes the DOOM module when the shared node syncs.
  await pageA.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'aaa-userA', displayName: 'A', color: '#f00' });
  }, rackspaceId);
  await pageB.evaluate(async (id) => {
    const w = window as unknown as {
      __attachProvider: (id: string) => Promise<unknown>;
      __ensureEngine: () => Promise<unknown>;
      __setAwarenessUser: (u: { id: string; displayName: string; color: string }) => boolean;
    };
    await w.__ensureEngine();
    await w.__attachProvider(id);
    w.__setAwarenessUser({ id: 'bbb-userB', displayName: 'B', color: '#0f0' });
  }, rackspaceId);

  return {
    pageA,
    pageB,
    async close() {
      await Promise.all([ctxA.close().catch(() => {}), ctxB.close().catch(() => {})]);
    },
  };
}

/** Spawn ONE DOOM node on `page` + load its runtime. Returns true on
 *  success, false on load timeout (caller skips). */
async function spawnAndLoadDoom(page: Page, nodeId: string): Promise<boolean> {
  const nodes: SpawnNode[] = [
    { id: nodeId, type: 'doom', position: { x: 60, y: 60 }, domain: 'video' },
  ];
  await spawnPatch(page, nodes, []);
  const card = page.locator('[data-testid="doom-card"]');
  await card.locator('button.overlay', { hasText: /Click to load DOOM/i }).click();
  try {
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as {
          __engine?: () => { getDomain?: (d: string) => {
            read?: (id: string, k: string) => unknown;
          } | null } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        return ve?.read?.(id, 'loaded') === true;
      },
      nodeId,
      { timeout: 25000 },
    );
    const err = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain?: (d: string) => {
          read?: (id: string, k: string) => unknown;
        } | null } | null;
      };
      return w.__engine?.()?.getDomain?.('video')?.read?.(id, 'loadError') ?? null;
    }, nodeId);
    return err === null;
  } catch {
    return false;
  }
}

/** Count the DOOM nodes currently in this page's patch graph. */
async function doomNodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { type?: string }> };
    };
    const nodes = w.__patch?.nodes ?? {};
    return Object.values(nodes).filter((n) => n.type === 'doom').length;
  });
}

/** Drive the slice-3 Join entry point exposed by DoomCard's e2e hook. */
async function join(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as { __doomCards?: Record<string, unknown> };
      return !!w.__doomCards && !!w.__doomCards[id];
    },
    nodeId,
    { timeout: 10000 },
  );
  await page.evaluate(async (id) => {
    const w = globalThis as unknown as {
      __doomCards: Record<string, { join: () => Promise<void> }>;
    };
    await w.__doomCards[id]!.join();
  }, nodeId);
}

async function readCardState(page: Page, nodeId: string): Promise<{
  roster: Record<string, string>;
  mySlot: number | null;
  netStarted: boolean;
  isNetArbiter: boolean;
  isHost: boolean;
  memberIds: string[];
  netcodePeers: string[];
} | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __doomCards?: Record<string, { getState: () => unknown }>;
    };
    const card = w.__doomCards?.[id];
    return card ? (card.getState() as never) : null;
  }, nodeId);
}

/** Decode the roster the card stores at node.data.players (a JSON STRING
 *  leaf — see DoomCard.writeNodeRoster). Tolerates the legacy object form. */
function decodePlayers(raw: unknown): Record<string, string> {
  let players: unknown = raw;
  if (typeof players === 'string') {
    try { players = JSON.parse(players); } catch { return {}; }
  }
  if (!players || typeof players !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(players as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Read the shared roster straight off the node in the patch graph. */
async function readNodeRoster(page: Page, nodeId: string): Promise<Record<string, string>> {
  const raw = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { data?: { players?: unknown } }> };
    };
    return w.__patch?.nodes?.[id]?.data?.players ?? null;
  }, nodeId);
  return decodePlayers(raw);
}

test.describe('@collab DOOM per-peer instance model (slice 3)', () => {
  // Cold WASM fetch + 4 MB WAD on TWO contexts + cross-context Yjs sync +
  // netcode start sits in the same 20-60 s window as the other doom specs.
  test.setTimeout(180_000);

  test('one shared node; both peers join distinct slots + start their own netcode', async ({ browser }) => {
    const pair = await openPair(browser);
    try {
      const assets = await checkWasmAvailable(pair.pageA);
      if (!assets.ok) {
        test.skip(true, assets.reason);
        return;
      }

      const NODE = 'sut';

      // ─── A spawns the single DOOM node + loads its runtime ───
      const aLoaded = await spawnAndLoadDoom(pair.pageA, NODE);
      if (!aLoaded) {
        test.skip(true, 'DOOM runtime failed to load on A within 25s');
        return;
      }

      // ─── B sees the SAME node via Yjs sync (does NOT spawn its own) ───
      await pair.pageB.locator('[data-testid="doom-card"]').waitFor({ timeout: 10000 });
      // Both pages have exactly ONE doom node — the model is one node, not
      // one-node-per-peer.
      expect(await doomNodeCount(pair.pageA), 'A: one doom node').toBe(1);
      expect(await doomNodeCount(pair.pageB), 'B: one doom node').toBe(1);

      // B must load its own runtime to become a player (netcode binds to
      // it). The card hook's join() kicks the load; wait for B's runtime.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as { __doomCards?: Record<string, unknown> };
          return !!w.__doomCards && !!w.__doomCards[id];
        },
        NODE,
        { timeout: 10000 },
      );

      // ─── Both JOIN ───
      // A joins first → slot 0; B joins → slot 1 (first empty slot).
      await join(pair.pageA, NODE);
      // Wait for A's claim to sync to B's node before B claims, so the
      // slot assignment is deterministic (A=0, B=1). The first cross-context
      // node-data hop competes with the cold WASM/awareness traffic, so give
      // it generous headroom.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as {
            __patch?: { nodes: Record<string, { data?: { players?: unknown } }> };
          };
          let raw: unknown = w.__patch?.nodes?.[id]?.data?.players;
          if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return false; } }
          if (!raw || typeof raw !== 'object') return false;
          return Object.values(raw as Record<string, unknown>).includes('aaa-userA');
        },
        NODE,
        { timeout: 30000 },
      ).catch(() => {
        throw new Error(
          "B never saw A's roster claim (node.data.players) sync within 30s — " +
          'cross-context node-data sync or the roster write is broken',
        );
      });
      await join(pair.pageB, NODE);

      // B's WASM has to finish loading before its netcode starts; wait for
      // B to report netStarted.
      await pair.pageB.waitForFunction(
        (id) => {
          const w = globalThis as unknown as {
            __doomCards?: Record<string, { getState: () => { netStarted?: boolean; mySlot?: number | null } }>;
          };
          const st = w.__doomCards?.[id]?.getState();
          return !!st && st.netStarted === true && st.mySlot !== null;
        },
        NODE,
        { timeout: 30000 },
      );
      // And wait for the roster to converge on BOTH peers (2 distinct slots).
      for (const p of [pair.pageA, pair.pageB]) {
        await p.waitForFunction(
          (id) => {
            const w = globalThis as unknown as {
              __patch?: { nodes: Record<string, { data?: { players?: unknown } }> };
            };
            let raw: unknown = w.__patch?.nodes?.[id]?.data?.players;
            if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return false; } }
            if (!raw || typeof raw !== 'object') return false;
            return Object.keys(raw as Record<string, unknown>).length === 2;
          },
          NODE,
          { timeout: 15000 },
        );
      }

      // ─── Assertion 1: roster has both users in distinct slots ───
      const rosterA = await readNodeRoster(pair.pageA, NODE);
      const rosterB = await readNodeRoster(pair.pageB, NODE);
      // Both peers converge on the same roster.
      expect(rosterA, 'A and B see the same roster').toEqual(rosterB);
      // Two players, distinct slots, slot 0 = A (lex-stable), slot 1 = B.
      expect(rosterA['0'], 'slot 0 = user A').toBe('aaa-userA');
      expect(rosterA['1'], 'slot 1 = user B').toBe('bbb-userB');

      // ─── Assertion 2: each peer has its OWN netcode started ───
      const stateA = await readCardState(pair.pageA, NODE);
      const stateB = await readCardState(pair.pageB, NODE);
      expect(stateA, 'A card state').not.toBeNull();
      expect(stateB, 'B card state').not.toBeNull();
      expect(stateA!.netStarted, 'A netcode started').toBe(true);
      expect(stateB!.netStarted, 'B netcode started').toBe(true);
      expect(stateA!.mySlot, 'A slot').toBe(0);
      expect(stateB!.mySlot, 'B slot').toBe(1);
      // Each netcode knows about the other peer (the lex-sorted member list
      // gives every peer a non-self peer entry).
      expect(stateA!.netcodePeers, 'A netcode sees B').toContain('bbb-userB');
      expect(stateB!.netcodePeers, 'B netcode sees A').toContain('aaa-userA');

      // ─── Assertion 3: arbiter is the lex-min user (A) ───
      expect(stateA!.isNetArbiter, 'A is arbiter (lex-min)').toBe(true);
      expect(stateB!.isNetArbiter, 'B is NOT arbiter').toBe(false);
    } finally {
      await pair.close();
    }
  });
});
