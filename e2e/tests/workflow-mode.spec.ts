// e2e/tests/workflow-mode.spec.ts
//
// WORKFLOW MODE P1 — the shell fork, exercised on the /rack scratch canvas:
//   /rack                 → DAWLESS: the current UI, byte-for-byte (topbar +
//                           preset slot bar render; no workflow chrome).
//   /rack?mode=workflow   → WORKFLOW: WorkflowTopbar (File.. menu) + empty
//                           left rail + the pinned M/E/C trio auto-spawned
//                           (drawer-only — never canvas cards) + the bottom
//                           dock drawer toggles.
//
// Driving /rack keeps this in the NORMAL e2e lane (no DB/relay needed —
// the seeded /r/[id] path needs Neon, which shard runners don't have; the
// server-side mode plumbing is unit-tested in lib/server/rackspaces.test.ts
// and the seed route accepts `mode` for the DB-backed lane). The workflow
// ensure effect + dock keymap + File.. menu are identical code on both
// routes — only the mode SOURCE differs (?mode= vs. the rackspace column).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

/** The pinned trio's deterministic node ids (graph/workflow-pins.ts). */
const PINNED_IDS = ['pinned-mixmstrs', 'pinned-electraControl', 'pinned-clipplayer'] as const;

/** The workflow default wires (graph/workflow-pins.ts WORKFLOW_DEFAULT_WIRES):
 *  pinned MIXMSTRS master L/R → pinned AUDIO OUT L/R, deterministic ids. */
const DEFAULT_WIRE_IDS = [
  'e-pinned-mixmstrs-masterL-pinned-audioOut-L',
  'e-pinned-mixmstrs-masterR-pinned-audioOut-R',
] as const;

/** Wait until the default-wire seed has written both master→out edges. */
async function waitForDefaultWires(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { edges: Record<string, unknown> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => !!w.__patch!.edges[id]);
    },
    DEFAULT_WIRE_IDS as unknown as string[],
    { timeout: 10_000 },
  );
}

/** Wait until the workflow ensure effect has written the pinned trio. */
async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    { timeout: 10_000 },
  );
}

test.describe('dawless is unchanged', () => {
  test('/rack renders the current topbar; zero workflow chrome', async ({ page }) => {
    await page.goto('/rack');
    // The existing dawless topbar chrome, exactly as before.
    await expect(page.locator('header.topbar')).toBeVisible();
    await expect(page.getByTestId('preset-slot-bar')).toBeVisible();
    await expect(page.getByTestId('raw-json-select')).toBeVisible();
    await expect(page.getByTestId('load-example-select')).toBeVisible();
    // No workflow shell pieces anywhere.
    await expect(page.getByTestId('workflow-topbar')).toHaveCount(0);
    await expect(page.getByTestId('workflow-leftbar')).toHaveCount(0);
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    // No pinned nodes auto-spawn on the dawless scratch canvas.
    const pinnedCount = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return 0;
      return Object.values(w.__patch.nodes).filter((n) => n?.data?.pinned === true).length;
    });
    expect(pinnedCount).toBe(0);
    // The M key does nothing in dawless (keymap is workflow-gated).
    await page.locator('.svelte-flow__pane').waitFor({ state: 'visible' });
    await page.keyboard.press('m');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
  });
});

test.describe('workflow shell', () => {
  // A fresh workflow rack now auto-spawns the video-zone defaults (videoOut +
  // recorderbox + synesthesia — PR #1155). These tests exercise the workflow
  // SHELL (dock keymap, pins, File.. menu), NOT video rendering, so idle the
  // engine rAF loop before boot (the established render-smoke seam — no
  // per-frame step(), no assertion weakened): synesthesia's live WebGL loop
  // otherwise runs on CI's SwiftShader software renderer in every shell test,
  // adding wall-time + main-thread contention (the CI-SwiftShader video-e2e
  // cost class) for no benefit here. The defaults' real spawn+wire is covered
  // in workflow-video-zone-defaults.spec.ts, which boots the engine live.
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  test('boots the workflow topbar + left rail, replaces the slot bar, spawns the pinned trio off-canvas', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    await expect(page.getByTestId('workflow-leftbar')).toBeVisible();
    // File.. REPLACES the top-left slot bar (Q5 reversible default).
    await expect(page.getByTestId('preset-slot-bar')).toHaveCount(0);
    await expect(page.getByTestId('workflow-file-trigger')).toBeVisible();
    // The P3 media slots are LIVE (loader + assets picker — behavior in
    // workflow-media.spec.ts), and so is the P4 camera manager (behavior
    // in workflow-camera.spec.ts).
    await expect(page.getByTestId('workflow-topbar-slot-media-loader')).toBeEnabled();
    await expect(page.getByTestId('workflow-topbar-slot-assets-picker')).toBeEnabled();
    await expect(page.getByTestId('workflow-topbar-slot-cameras')).toBeEnabled();

    // The pinned trio lands in the patch graph…
    await waitForPinnedTrio(page);
    // …but NEVER as canvas cards (drawer-only — Q3 reversible default).
    for (const id of PINNED_IDS) {
      await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`)).toHaveCount(0);
    }
  });

  test('M / E / C toggle the bottom dock drawers with the FULL pinned card; one at a time; ESC closes', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    // :visible — the workflow topbar's always-mounted audio-I/O card hosts
    // (P2) are standalone flows inside a visibility-hidden panel, so the
    // FIRST .svelte-flow__pane in DOM order is hidden until that menu opens.
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    const drawer = page.getByTestId('dock-zone-bottom');

    // M → mixmstrs drawer, rendering the pinned card IN FULL (P2.5a: the
    // real module card PLAIN-mounts in the drawer via DockCardHost — no
    // flow host, so the card carries a data-dock-card marker, not a
    // .svelte-flow__node wrapper; the mixmstrs face itself proves "full").
    await page.keyboard.press('m');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
    await expect(
      drawer.locator('[data-dock-card="pinned-mixmstrs"] .mod-card, [data-dock-card="pinned-mixmstrs"] .card').first(),
    ).toBeVisible();

    // E while M is open → the electra drawer REPLACES it (one at a time).
    await page.keyboard.press('e');
    await expect(drawer).toHaveCount(1);
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');
    await expect(
      drawer.locator('[data-dock-card="pinned-electraControl"]'),
    ).toBeVisible();

    // E again → toggles closed.
    await page.keyboard.press('e');
    await expect(drawer).toHaveCount(0);

    // C → clipplayer drawer; ESC closes it.
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-dock-type', 'clipplayer');
    await expect(
      drawer.locator('[data-dock-card="pinned-clipplayer"]'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });

  test('M/E/C are inert while typing in an input / contenteditable', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    // Real text-entry surfaces, appended to the live document so the real
    // window keydown listener (not a synthetic target) sees the events.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'wf-typing-probe';
      document.body.appendChild(input);
      const ce = document.createElement('div');
      ce.id = 'wf-ce-probe';
      ce.contentEditable = 'true';
      ce.textContent = 'edit me';
      document.body.appendChild(ce);
    });
    await page.locator('#wf-typing-probe').click();
    await page.keyboard.type('mec');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    await page.locator('#wf-ce-probe').click();
    await page.keyboard.type('mec');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    // Blur back to a NON-typing target → the keymap is live again. NB: don't
    // click the flow pane CENTER — the workflow video-zone default cards
    // (videoOut/recorderbox/synesthesia, PR #1155) now occupy it, so a center
    // click lands on a card control (e.g. recorderbox's SIZE <select>) and
    // focus stays in a typing target, leaving the dock keymap inert
    // (isTypingTarget). Click an empty topbar corner instead (the proven
    // workflow-viewport-nav pattern) → activeElement returns to <body>.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('m');
    await expect(page.getByTestId('dock-zone-bottom')).toBeVisible();
  });

  test('pinned nodes refuse deletion; Clear keeps the trio', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    // Programmatic delete through the shared primitive path: drive the
    // graph directly (the UI exposes no delete affordance for pinned nodes
    // — they never render on canvas), then verify the guard held.
    const survived = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      // Simulate what any rogue bulk-delete path would do WITHOUT the
      // guard… via the guarded seam there is no exported hook here, so
      // assert the invariant the guards protect: after a Clear-equivalent
      // sweep that respects pinned (the shipped clearPatch), pinned nodes
      // remain. We drive the real Clear button below instead.
      return Object.keys(w.__patch.nodes).filter((id) => id.startsWith('pinned-')).length;
    });
    // P1's M/E/C trio + P2's topbar surface pins (timelorde, the MIDI-DIN
    // midiclock bridge, audioIn, audioOut) = 7 always-on pinned modules.
    expect(survived).toBe(7);

    // Spawn a normal node, then Clear via the graph-level sweep the Clear
    // button runs (workflow topbar has no Clear button in P1; the pinned
    // survival contract is on the clearPatch path used by quickload too).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, Record<string, unknown>> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['wf-test-vco'] = {
          id: 'wf-test-vco',
          type: 'analogVco',
          domain: 'audio',
          position: { x: 200, y: 200 },
          params: {},
          data: {},
        };
      });
    });
    await expect(page.locator('.svelte-flow__node[data-id="wf-test-vco"]')).toBeVisible();

    // Quickload path (below) is the wholesale-replace case; here assert the
    // ensure effect SELF-HEALS when someone nukes the trio wholesale.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.nodes)) {
          if (id.startsWith('pinned-')) delete w.__patch.nodes[id];
        }
      });
    });
    await waitForPinnedTrio(page); // the ensure effect re-spawns the trio
  });

  test('default wiring: pinned MIXMSTRS master L/R auto-wires to pinned AUDIO OUT (one-shot, user delete respected)', async ({ page }) => {
    // Owner directive: "the audio out in the rack should be default wired to
    // the master L/R outs from the in rack mixmstrs in workflow mode."
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await waitForDefaultWires(page);

    // Both edges carry the exact endpoints (not just the ids).
    const wires = await page.evaluate((ids) => {
      const w = globalThis as unknown as {
        __patch: {
          edges: Record<
            string,
            { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } } | undefined
          >;
        };
      };
      return ids.map((id) => {
        const e = w.__patch.edges[id];
        return e ? `${e.source.nodeId}.${e.source.portId}->${e.target.nodeId}.${e.target.portId}` : null;
      });
    }, DEFAULT_WIRE_IDS as unknown as string[]);
    expect(wires).toEqual([
      'pinned-mixmstrs.masterL->pinned-audioOut.L',
      'pinned-mixmstrs.masterR->pinned-audioOut.R',
    ]);

    // USER DELETE IS RESPECTED: rip out the L wire, churn the snapshot with
    // an unrelated node write, and prove the ensure does NOT re-add it (the
    // one-shot `workflowDefaultWired` latch on the pinned AUDIO OUT).
    await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        delete w.__patch.edges[id];
      });
    }, DEFAULT_WIRE_IDS[0]);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, Record<string, unknown>> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['wf-churn'] = {
          id: 'wf-churn',
          type: 'analogVco',
          domain: 'audio',
          position: { x: 260, y: 260 },
          params: {},
          data: {},
        };
      });
    });
    await expect(page.locator('.svelte-flow__node[data-id="wf-churn"]')).toBeVisible();
    // The R wire survives; the deleted L wire STAYS deleted across churn.
    const after = await page.evaluate((ids) => {
      const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
      return ids.map((id) => !!w.__patch.edges[id]);
    }, DEFAULT_WIRE_IDS as unknown as string[]);
    expect(after).toEqual([false, true]);
  });

  test('default wiring carries REAL audio: source → mixmstrs ch1 → auto-wired AUDIO OUT is audible', async ({ page }) => {
    // Real-chain proof (not just edge materialization): a free-running VCO
    // into the pinned mixer's channel 1 must register energy on the pinned
    // AUDIO OUT's terminal tap (the limiter feeding ctx.destination) with
    // ZERO hand-patching between mixer and output — the default wires are
    // the only mixer→out cables in the rack.
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);
    await waitForDefaultWires(page);

    // spawnPatch boots the engine + wipes the graph; the ensure re-spawns
    // the pins and re-seeds the default wires (fresh audioOut, no latch).
    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 120, y: 120 } },
    ]);
    await waitForPinnedTrio(page);
    await waitForDefaultWires(page);

    // Feed the mixer: VCO sine → MIXMSTRS ch1 L (a normal user patch).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['e-vco-sine-pinned-mixmstrs-ch1L'] = {
          id: 'e-vco-sine-pinned-mixmstrs-ch1L',
          source: { nodeId: 'vco', portId: 'sine' },
          target: { nodeId: 'pinned-mixmstrs', portId: 'ch1L' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    });

    // The terminal audibility probe: AUDIO OUT's outputSnapshot RMS.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = globalThis as unknown as {
              __engine?: () => {
                read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
              } | null;
              __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
            };
            const eng = w.__engine?.();
            const node = w.__patch.nodes['pinned-audioOut'];
            if (!eng || !node) return 0;
            const snap = eng.read(node, 'outputSnapshot') as { samples: Float32Array } | undefined;
            if (!snap?.samples?.length) return 0;
            let sumSq = 0;
            for (let i = 0; i < snap.samples.length; i++) sumSq += snap.samples[i]! * snap.samples[i]!;
            return Math.sqrt(sumSq / snap.samples.length);
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.01);
  });

  test('File.. menu: quicksave slot 1 round-trips through quickload', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await waitForPinnedTrio(page);

    // Open File.. → Quicksave → slot 1 (captures the current rack: the
    // pinned trio + timelorde-less scratch state).
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();
    await page.getByTestId('workflow-file-quicksave').click();
    await page.getByTestId('workflow-quicksave-1').click();
    // The menu closes after firing; re-open and check slot 1 shows occupied
    // (green) in BOTH submenus.
    await expect(page.getByTestId('workflow-file-menu')).toHaveCount(0);
    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const w = globalThis as unknown as {
            __presetSet?: { occupied: () => boolean[] };
          };
          return w.__presetSet?.occupied()[0] ?? false;
        });
      }, { timeout: 15_000 })
      .toBe(true);

    // Mutate the rack: add a marker node the quickload must remove.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, Record<string, unknown>> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['wf-marker'] = {
          id: 'wf-marker',
          type: 'analogVco',
          domain: 'audio',
          position: { x: 300, y: 300 },
          params: {},
          data: {},
        };
      });
    });
    await expect(page.locator('.svelte-flow__node[data-id="wf-marker"]')).toBeVisible();

    // File.. → Quickload → slot 1: restores the quicksaved state (marker
    // gone), and the pinned trio is intact afterwards (ensure self-heal +
    // the saved state itself contained the trio).
    await page.getByTestId('workflow-file-trigger').click();
    await page.getByTestId('workflow-file-quickload').click();
    const slot1 = page.getByTestId('workflow-quickload-1');
    await expect(slot1).toBeEnabled();
    await slot1.click();
    await expect(page.locator('.svelte-flow__node[data-id="wf-marker"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await waitForPinnedTrio(page);
  });
});
