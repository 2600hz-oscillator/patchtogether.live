// e2e/tests/clear-load-multiwindow.spec.ts
//
// B3 regression. Reproduces the original bug:
//   "when i did a clear workspace in the host and then did 'load example'
//    something weird happened. at first i heard it in the other window
//    but i didn't see it."
//
// Two browser contexts attach to the same Hocuspocus rackspace. Host
// (context A) clears the patch then loads the example in two ydoc
// transacts. Listener (context B) must see the example modules in its
// CANVAS DOM (.svelte-flow__node) within 500ms — proving the UI
// subscription is in lockstep with the audio reconciler. Pre-fix this
// flaked: the engine had the nodes (audio played) but the listener's
// canvas could be empty because the bind:nodes path stomped the array.

import { test, expect } from '@playwright/test';

interface Ctx {
  pageA: import('@playwright/test').Page;
  pageB: import('@playwright/test').Page;
  close: () => Promise<void>;
}

async function openTwoContexts(
  browser: import('@playwright/test').Browser,
): Promise<Ctx> {
  const rackspaceId = `b3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        typeof (window as unknown as { __attachProvider?: unknown })
          .__attachProvider === 'function' &&
        typeof (window as unknown as { __ensureEngine?: unknown })
          .__ensureEngine === 'function',
    );
  }

  // Bring the engine + reconciler online on both sides BEFORE attaching
  // the provider — so that as soon as the host's transact arrives, the
  // listener's reconciler is awake and the bug surfaces if it's still
  // there.
  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async () => {
        const w = window as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      }),
    ),
  );

  await Promise.all(
    [pageA, pageB].map((p) =>
      p.evaluate(async (id) => {
        const w = window as unknown as {
          __attachProvider: (id: string) => Promise<unknown>;
        };
        await w.__attachProvider(id);
      }, rackspaceId),
    ),
  );

  return {
    pageA,
    pageB,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

test.describe('@collab B3 reconciler determinism', () => {
  test('host clears + loads example; listener canvas shows modules within 500ms', async ({
    browser,
  }) => {
    const s = await openTwoContexts(browser);
    try {
      // Seed the host with some leftover state so the clear has something
      // to remove. This mimics the user's original sequence (their host
      // had the example loaded, they hit Clear, then hit Load example).
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.nodes['leftover-vco'] = {
            id: 'leftover-vco',
            type: 'analogVco',
            domain: 'audio',
            position: { x: 50, y: 50 },
            params: {},
          };
        });
      });

      // Wait for the listener to see the leftover (proves sync is working
      // end-to-end before we exercise the bug path).
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
              return Object.keys(w.__patch.nodes).includes('leftover-vco');
            }),
          { timeout: 4000 },
        )
        .toBe(true);

      // Host: Clear (one transact) then Load example (one transact).
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
          for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        });
        w.__ydoc.transact(() => {
          // The five-node example chain (mirrors loadExample() in Canvas.svelte).
          const nodes: Record<string, { type: string; params: Record<string, number> }> = {
            'b3-seq': { type: 'sequencer', params: { bpm: 180, length: 8, isPlaying: 1, gateLength: 0.4 } },
            'b3-vco': { type: 'analogVco', params: {} },
            'b3-adsr': { type: 'adsr', params: { attack: 0.005, decay: 0.08, sustain: 0.3, release: 0.15 } },
            'b3-vca': { type: 'vca', params: { base: 0, cvAmount: 1 } },
            'b3-out': { type: 'audioOut', params: { master: 0.4 } },
          };
          for (const [id, n] of Object.entries(nodes)) {
            w.__patch.nodes[id] = {
              id,
              type: n.type,
              domain: 'audio',
              position: { x: 100, y: 100 },
              params: n.params,
            };
          }
          const wires: Array<[string, string, string, string, string]> = [
            ['b3-seq', 'pitch', 'b3-vco', 'pitch', 'pitch'],
            ['b3-seq', 'gate', 'b3-adsr', 'gate', 'gate'],
            ['b3-vco', 'sine', 'b3-vca', 'audio', 'audio'],
            ['b3-adsr', 'env', 'b3-vca', 'cv', 'cv'],
            ['b3-vca', 'audio', 'b3-out', 'L', 'audio'],
            ['b3-vca', 'audio', 'b3-out', 'R', 'audio'],
          ];
          for (const [src, srcPort, dst, dstPort, type] of wires) {
            const id = `e-${src}-${srcPort}-${dst}-${dstPort}`;
            w.__patch.edges[id] = {
              id,
              source: { nodeId: src, portId: srcPort },
              target: { nodeId: dst, portId: dstPort },
              sourceType: type,
              targetType: type,
            };
          }
        });
      });

      // Listener canvas MUST render the 5 module cards. This is the heart
      // of the regression: pre-fix, the audio engine had the nodes (so
      // sound played) but Svelte Flow's bind-stomp could leave the canvas
      // empty. We poll the actual DOM so we're testing what the user sees.
      await expect
        .poll(
          async () =>
            await s.pageB
              .locator('.svelte-flow__node')
              .count(),
          { timeout: 500, intervals: [50, 100, 100, 100, 150] },
        )
        .toBe(5);

      // Each node id we published should appear as a DOM element on the
      // listener side — id-by-id so a flake on a single missing card is
      // visible in the failure message.
      for (const id of ['b3-seq', 'b3-vco', 'b3-adsr', 'b3-vca', 'b3-out']) {
        await expect(s.pageB.locator(`.svelte-flow__node[data-id="${id}"]`)).toBeVisible();
      }
    } finally {
      await s.close();
    }
  });

  test('listener engine + UI agree on node ids after clear+load (snapshot parity)', async ({
    browser,
  }) => {
    const s = await openTwoContexts(browser);
    try {
      await s.pageA.evaluate(() => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
          for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        });
        w.__ydoc.transact(() => {
          for (const id of ['parity-a', 'parity-b', 'parity-c']) {
            w.__patch.nodes[id] = {
              id,
              type: 'analogVco',
              domain: 'audio',
              position: { x: 0, y: 0 },
              params: {},
            };
          }
        });
      });

      // What the engine sees and what the canvas renders must converge.
      // Pre-B3 they could disagree.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate(() => {
              const w = window as unknown as {
                __engine: () => {
                  getDomain: (d: string) => { nodes: Map<string, unknown> };
                } | null;
              };
              const eng = w.__engine();
              if (!eng) return null;
              const audio = eng.getDomain('audio');
              return [...audio.nodes.keys()].sort();
            }),
          { timeout: 4000 },
        )
        .toEqual(['parity-a', 'parity-b', 'parity-c']);

      const domIds = await s.pageB
        .locator('.svelte-flow__node')
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLElement).dataset.id).filter(Boolean).sort(),
        );
      expect(domIds).toEqual(['parity-a', 'parity-b', 'parity-c']);
    } finally {
      await s.close();
    }
  });
});
