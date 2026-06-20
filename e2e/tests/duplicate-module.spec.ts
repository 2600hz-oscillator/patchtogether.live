// e2e/tests/duplicate-module.spec.ts
//
// Right-click → Duplicate clones a module with all its data + params into a
// fresh node id offset from the source. Edges are NOT copied (the duplicate
// starts unpatched).
//
// Multiplayer (@collab): a duplicate created in user A's window appears in
// user B's window via Yjs sync — proving the duplicate goes through the
// standard add-node path that's synchronized cross-window.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readNodes(page: Page): Promise<PatchNode[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return Object.values(w.__patch.nodes).filter(Boolean) as PatchNode[];
  });
}

test('right-click → Duplicate creates a clone with same params, fresh id, offset position', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      {
        id: 'adsr-source',
        type: 'adsr',
        position: { x: 200, y: 200 },
        params: { attack: 1.234, decay: 0.5, sustain: 0.7, release: 2.1 },
      },
    ],
    [],
  );

  // Right-click the ADSR card's TITLE BAR → "Duplicate". We deliberately
  // right-click `.title` rather than the node's geometric center: a right-click
  // that lands on a knob/fader hits the control's own contextmenu handler,
  // which `stopPropagation()`s the event so it never reaches SvelteFlow's
  // onnodecontextmenu — the "Control actions" menu (MIDI Learn/Forget) opens
  // instead of the module menu, and there's no "Duplicate" item. The title bar
  // is control-free, so the module menu opens deterministically. (See the
  // four-modules flake write-up: a tall card's center can sit right on the
  // fader-row, making the target intermittent.)
  const adsr = page.locator('.svelte-flow__node-adsr').first();
  await adsr.locator('.title').click({ button: 'right' });
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  await page.locator('[role="menuitem"]', { hasText: 'Duplicate' }).click();

  // Two ADSRs in the patch graph now.
  await expect(page.locator('.svelte-flow__node-adsr')).toHaveCount(2);

  const nodes = await readNodes(page);
  const adsrs = nodes.filter((n) => n.type === 'adsr');
  expect(adsrs.length).toBe(2);

  const source = adsrs.find((n) => n.id === 'adsr-source');
  const dup = adsrs.find((n) => n.id !== 'adsr-source');
  expect(source).toBeDefined();
  expect(dup).toBeDefined();
  expect(dup!.id).toMatch(/^adsr-/);

  // Same params; deep-equal.
  expect(dup!.params).toEqual(source!.params);

  // Position is offset down-right by ~30px.
  expect(dup!.position.x).toBeGreaterThan(source!.position.x);
  expect(dup!.position.y).toBeGreaterThan(source!.position.y);
  expect(dup!.position.x - source!.position.x).toBeLessThan(60);
  expect(dup!.position.y - source!.position.y).toBeLessThan(60);
});

test('right-click → Duplicate deep-clones data (mutating dup does not affect source)', async ({
  page,
}) => {
  // Use a sequencer-like data shape: array of step objects. The Yjs
  // "reassigning object that already occurs in the tree" gotcha only fires
  // when the same JS reference ends up at two paths — so a mutation through
  // one MUST not be visible at the other.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      {
        id: 'seq-source',
        type: 'sequencer',
        position: { x: 100, y: 100 },
        params: { bpm: 120, length: 4 },
      },
    ],
    [],
  );
  // Seed data via __patch (spawnPatch helper does not pass `data`).
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes['seq-source']!.data = {
        steps: [
          { on: true, midi: 60 },
          { on: true, midi: 64 },
          { on: false, midi: null },
          { on: true, midi: 67 },
        ],
      };
    });
  });

  // Right-click the sequencer's TITLE BAR → Duplicate. The sequencer card is
  // tall (step grid + fader-row + quicksave controls); its geometric center
  // sits right on top of the fader-row, so `seq.click({ button: 'right' })`
  // intermittently lands on a Fader. A fader's contextmenu handler
  // `stopPropagation()`s the event (so SvelteFlow's onnodecontextmenu never
  // fires) and opens the "Control actions" menu instead — which has no
  // "Duplicate" item, so the click below would hang until the 30s test
  // timeout. Right-clicking `.title` (control-free) opens the module menu
  // deterministically. We also wait for the module menu to be visible before
  // clicking, gating actionability on the menu actually being present.
  const seq = page.locator('.svelte-flow__node-sequencer').first();
  await seq.locator('.title').click({ button: 'right' });
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  await page.locator('[role="menuitem"]', { hasText: 'Duplicate' }).click();
  await expect(page.locator('.svelte-flow__node-sequencer')).toHaveCount(2);

  // Mutate the duplicate's nested step. Source must be untouched.
  const dupId = await page.evaluate(() => {
    const w = window as unknown as { __patch: { nodes: Record<string, { type: string; id: string }> } };
    const ids = Object.keys(w.__patch.nodes).filter(
      (k) => w.__patch.nodes[k]!.type === 'sequencer' && k !== 'seq-source',
    );
    return ids[0] ?? null;
  });
  expect(dupId).toBeTruthy();

  await page.evaluate((id) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const dupNode = w.__patch.nodes[id]!;
      // Reassigning the array entirely (rather than mutating in place) keeps
      // Yjs happy AND proves the dup's data is independent: the source's
      // steps array reference must not change as a result.
      dupNode.data = {
        steps: [
          { on: false, midi: null },
          { on: false, midi: null },
          { on: false, midi: null },
          { on: false, midi: null },
        ],
      };
    });
  }, dupId);

  // Read source's steps — first step must still be on/midi 60.
  const sourceFirstStep = await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: { steps?: Array<{ on: boolean; midi: number | null }> } }> };
    };
    return w.__patch.nodes['seq-source']!.data!.steps![0];
  });
  expect(sourceFirstStep).toEqual({ on: true, midi: 60 });
});

test('right-click → Duplicate does not copy edges of the source', async ({ page }) => {
  // Patch: VCO → VCA. Duplicate the VCO. Expect: 1 edge still (VCO → VCA),
  // duplicated VCO has no edges.
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'vco-source', type: 'analogVco', position: { x: 100, y: 100 } },
      { id: 'vca-sink',   type: 'vca',       position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e-vco-vca', from: { nodeId: 'vco-source', portId: 'sine' }, to: { nodeId: 'vca-sink', portId: 'audio' } },
    ],
  );

  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);

  const vco = page.locator('.svelte-flow__node-analogVco').first();
  // Right-click the card background (title bar) — a knob/fader right-click now
  // opens the per-control MIDI menu instead of the module menu.
  await vco.locator('.title').click({ button: 'right' });
  await expect(page.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
  await page.locator('[role="menuitem"]', { hasText: 'Duplicate' }).click();
  await expect(page.locator('.svelte-flow__node-analogVco')).toHaveCount(2);

  // Edge count unchanged — duplicate did NOT copy the source's edge.
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
});

test('@collab duplicate in A appears in B', async ({ browser }) => {
  // De-flake (consolidated #837+#841): this test chains two 20s SYNC_BUDGET_MS
  // polls (seed-sync, then duplicate-sync) plus two-context setup — the default
  // 30s per-test timeout can't contain that, so a slow-but-correct sync tripped
  // the TEST timeout at teardown (the residual @collab red). Give the
  // @collab-standard 120s ceiling (a ceiling, not a sleep — no CI delta on green).
  test.setTimeout(120_000);
  // Two browser contexts on the same rackspace. A duplicates a node; B
  // observes the new node show up. This proves Duplicate goes through the
  // standard add-node path (Y.Doc transact) that the multiplayer provider
  // synchronizes cross-window.
  const rackspaceId = `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    for (const p of [pageA, pageB]) {
      await p.goto('/');
      await p.waitForLoadState('networkidle');
      await p.waitForFunction(
        () =>
          typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
      );
    }
    await Promise.all(
      [pageA, pageB].map((p) =>
        p.evaluate(async (id) => {
          const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
          await w.__attachProvider(id);
        }, rackspaceId),
      ),
    );

    // A: seed an ADSR with known params.
    await pageA.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['adsr-shared'] = {
          id: 'adsr-shared',
          type: 'adsr',
          domain: 'audio',
          // x:600 keeps the ADSR clear of the auto-spawned TIMELORDE (top-left,
          // ~24,24 → 384,564 at 3u×2hp) — otherwise TIMELORDE's knob-row occludes
          // the ADSR title and the right-click intercepts (CI hang, #759 sizing).
          position: { x: 600, y: 200 },
          params: { attack: 0.5 },
        };
      });
    });

    // Wait for B to see the seed.
    await expect
      .poll(async () => await pageB.evaluate(() => {
        const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
        return Object.keys(w.__patch.nodes).includes('adsr-shared');
      }), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
      .toBe(true);

    // A: right-click the title bar → Duplicate. (Title bar, not node center —
    // a center right-click can land on a control whose contextmenu handler
    // stopPropagation()s the event, opening the per-control menu instead of
    // the module menu; see the non-collab specs above.)
    // force:true on the right-click — in the 2-context @collab case the
    // auto-spawned TIMELORDE singleton's display canvas can overlap the ADSR
    // title in SCREEN space (SvelteFlow fitView re-centers both nodes), so the
    // contextmenu right-click retried-until-test-timeout on the attest run
    // (the page never opened the menu → A never got a 2nd ADSR → B never saw 2).
    // The title is already on-screen; force bypasses the unrelated-overlay check.
    const adsr = pageA.locator('.svelte-flow__node-adsr').first();
    await adsr.locator('.title').click({ button: 'right', force: true });
    await expect(pageA.locator('[role="menu"][aria-label="Module actions"]')).toBeVisible();
    // force:true — the module action menu renders inside the SvelteFlow node
    // layer, so the auto-spawned TIMELORDE display canvas can overlap the
    // Duplicate menuitem in screen space too (the menu is visible above, but the
    // click landed on nothing → A stayed at 1 ADSR on the attest run). The
    // menuitem is confirmed present; force bypasses the overlay intercept.
    await pageA.locator('[role="menuitem"]', { hasText: 'Duplicate' }).click({ force: true });
    await expect(pageA.locator('.svelte-flow__node-adsr')).toHaveCount(2);

    // B: should see 2 ADSR nodes appear within 4s.
    await expect
      .poll(async () => await pageB.evaluate(() => {
        const w = window as unknown as { __patch: { nodes: Record<string, { type: string }> } };
        return Object.values(w.__patch.nodes).filter((n) => n && n.type === 'adsr').length;
      }), { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS })
      .toBe(2);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
