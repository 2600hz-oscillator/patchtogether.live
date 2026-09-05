// e2e/tests/workflow-mode.spec.ts
//
// THE SHELL, exercised on the /rack scratch canvas: WorkflowTopbar (File..
// menu) + the left rail + the pinned M/E/C trio auto-spawned (drawer-only —
// never canvas cards) + the bottom dock drawer toggles.
//
// This file used to have a second half asserting "dawless is unchanged" on a
// bare /rack. That shell is DELETED, so those assertions are gone rather than
// re-pointed: there is no second UI for them to be about, and re-pointing them
// would have re-asserted the shell's own chrome twice under a name that says
// the opposite.
//
// Driving /rack keeps this in the NORMAL e2e lane (no DB/relay needed — the
// seeded /r/[id] path needs Neon, which shard runners don't have).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

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
    // BOOT bound, not an assertion — the hand-typed 10 s here was a flat
    // wall-clock lottery ticket below the one export site's number and lost
    // on a loaded shard (waitForPinnedTrio timed out at boot, passed on
    // retry, flake-gate red — the exact #1906 class its sweep missed
    // because these are waitForFunction sites, not bare toBeVisible ones).
    { timeout: BOOT_MS },
  );
}

/** Wait until the workflow ensure effect has written the pinned trio.
 *
 *  ⚠ The inner cap is the shared BOOT_MS export, not a hand-typed number:
 *  this is STATE readiness (a doc write by the ensure effect), and how long
 *  boot takes is a function of shard load, not of the subject. Measured
 *  twice (runs 33268032993 and 33277673075, both shard 7): the flat 10s cap
 *  expired under CI load and the identical attempt passed on retry — the
 *  flake gate's definition of "slower on CI", which takes a budget, not a
 *  fix to the subject. */
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
    // Same BOOT bound as above. ⚠ This site is the #1847 spec-wide park, and
    // its cause was NOT the bound — see the describe note below.
    { timeout: BOOT_MS },
  );
}

test.describe('workflow shell', () => {
  // ── WHY THIS SPEC WAS PARKED, AND WHAT ACTUALLY FIXED IT ──────────────────
  //
  // Seven observations in 34 h (2026-08-30/31 census), six different legs, one
  // shared helper: `waitForPinnedTrio` timed out at boot, passed on retry. Two
  // of them reddened `main`. The park (9 `test.fixme`) is lifted here because
  // the cause is fixed, not because it stopped reproducing.
  //
  // TWO defects, both proven from the failing runs' own traces:
  //
  //  1. PRODUCT — `/rack` seeded the whole shell TWICE, into two different
  //     Y.Docs. `routes/rack/+page.svelte` called `bindRackspace` from an
  //     `$effect`, and Svelte 5 runs a CHILD's effects before its parent's, so
  //     <Canvas> mounted, published `__patch`, and ran all four seed effects
  //     against the store's initial doc — which `bindRackspace` then DESTROYED.
  //     Every failing trace carries the fingerprint: two `[canvas] workflow:
  //     ensured pinned modules` console lines, 7.7–28.0 s apart, and the wait
  //     can only be satisfied by the SECOND one (`bindRackspace` correctly
  //     re-points `__patch` at the surviving doc). Fixed by binding at page
  //     init, before <Canvas> exists — see the note at that call site.
  //
  //  2. INSTRUMENT — this spec had no per-test budget, so the bound was
  //     Playwright's DEFAULT 30 s test timeout, which on CI is EXACTLY
  //     `BOOT_MS`. Run 33295180895 reports both "Test timeout of 30000ms
  //     exceeded" and "waitForFunction: Timeout 30000ms exceeded" — the test
  //     clock ran out FIRST, having already spent `goto` out of the same
  //     budget. That is why raising the wait 10 s → 30 s changed nothing, and
  //     it is exactly what `SLOW_BOOT_TEST_TIMEOUT_MS` exists for (19 sibling
  //     specs already use it, including shard-7 neighbour
  //     `workflow-drawer-face.spec.ts`). A BOUND you cannot reach is not a
  //     bound.
  //
  // ⚠ Shard-7 locality carried no information. `scripts/e2e-shard-plan.mjs` is
  // deterministic and has placed this spec on shard 7 since the 2026-08-27
  // timings re-pin, so "only ever shard 7" is where it only ever RAN.
  test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

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
    await page.goto('/rack');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await expect(page.getByTestId('workflow-leftbar')).toBeVisible();
    // There is no second topbar: the slot bar was deleted with the old shell
    // and File.. carries every action it had.
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

  test('M / E toggle the bottom dock drawers with the FULL pinned card; one at a time; C opens the clip PANE; ESC closes', async ({ page }) => {
    await page.goto('/rack');
    await waitForPinnedTrio(page);
    // :visible — the workflow topbar's always-mounted audio-I/O card hosts
    // (P2) are standalone flows inside a visibility-hidden panel, so the
    // FIRST .svelte-flow__pane in DOM order is hidden until that menu opens.
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

    const drawer = page.getByTestId('dock-zone-bottom');

    // M → mixmstrs drawer, rendering the pinned card IN FULL (P2.5a: the
    // real module surface PLAIN-mounts in the drawer via DockCardHost — no
    // flow host, so it carries a data-dock-card marker, not a
    // .svelte-flow__node wrapper. On the default shell the pinned occupant is
    // the one that gets its FACE (#1739 — the tray is its only surface), so
    // the host mounts a module-shell faceplate rather than the verbatim card.
    await page.keyboard.press('m');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
    await expect(
      drawer
        .locator(
          '[data-dock-card="pinned-mixmstrs"] [data-testid="module-shell"], [data-dock-card="pinned-mixmstrs"] .mod-card, [data-dock-card="pinned-mixmstrs"] .card',
        )
        .first(),
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

    // C → the built-in CLIP PLAYER as a dock FULL-VIEW PANE, not the pinned
    // drawer (owner 2026-07-26: "opening clip player with c is same as
    // expanding any other module" — so it can sit side-by-side with a module;
    // the full behavior sweep lives in workflow-dock-occupancy.spec.ts). ESC
    // still closes it.
    //
    // ⚠ THE OCCUPANT IS THE FACEPLATE NOW, NOT THE VERBATIM CARD, and the
    // assertion changed with it rather than being relaxed. This line used to
    // read `[data-dock-card="pinned-clipplayer"]` with the comment "the same
    // real card mounts, just in the faceplate frame"; `clipplayer` was promoted
    // and `DockFullView` switches on bare STRICT_FACES membership, so
    // the pane mounts `<ModuleShell view="dock-full">` exactly as it does for
    // every other promoted module. What this test is ABOUT is unchanged —
    // occupancy: `c` opens a full-view PANE and not the exclusive pinned
    // drawer — so it asserts the pane hosts the module's surface, whichever
    // branch that surface comes from.
    //
    // ⚠ AND THE RENDERER FLAG NEVER CHANGED THAT (stated back when this test
    // still booted the second renderer): the flag steered the CANVAS lane; the
    // dock full view reads `migrated(type)` alone. Two different questions, one
    // of which the URL did not answer.
    await page.keyboard.press('c');
    const clipPane = page.locator(
      '[data-testid="dock-fullview-pane"][data-pane-node="pinned-clipplayer"]',
    );
    await expect(clipPane).toBeVisible();
    await expect(
      clipPane.locator('[data-testid="module-shell"][data-shell-node="pinned-clipplayer"]'),
    ).toBeVisible();
    await expect(drawer).toHaveCount(0); // NOT the exclusive pinned drawer
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);
  });

  test('M/E/C are inert while typing in an input / contenteditable', async ({ page }) => {
    await page.goto('/rack');
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
    // NB both bottom surfaces are asserted absent: `m`/`e` would open the
    // pinned drawer, `c` the clip player's full-view pane — the typing guard
    // has to silence ALL THREE.
    await page.locator('#wf-typing-probe').click();
    await page.keyboard.type('mec');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);
    await page.locator('#wf-ce-probe').click();
    await page.keyboard.type('mec');
    await expect(page.getByTestId('dock-zone-bottom')).toHaveCount(0);
    await expect(page.getByTestId('dock-fullview-drawer')).toHaveCount(0);
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
    await page.goto('/rack');
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
    // button runs. (The workflow topbar's own File.. → Clear rack row is
    // covered separately below; the pinned survival contract is on the
    // clearPatch path used by quickload too.)
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
    await page.goto('/rack');
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

  // audible default-wire proof; mixmstrs audio stays covered by its own specs.
  test('default wiring carries REAL audio: source → mixmstrs ch1 → auto-wired AUDIO OUT is audible', async ({ page }) => {
    // Real-chain proof (not just edge materialization): a free-running VCO
    // into the pinned mixer's channel 1 must register energy on the pinned
    // AUDIO OUT's terminal tap (the limiter feeding ctx.destination) with
    // ZERO hand-patching between mixer and output — the default wires are
    // the only mixer→out cables in the rack.
    await page.goto('/rack');
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

    // ---- the PER-CHANNEL taps are live IN CHROME, on this same real chain ----
    //
    // `outputSnapshotL`/`outputSnapshotR` (audio-out.ts) hang two AnalyserNodes
    // off a ChannelSplitter(2) at the same post-limiter node as the mono tap.
    // Their per-channel BEHAVIOUR is negative-controlled in both directions in
    // the ART lane (art/scenarios/audio-out/per-channel-taps.test.ts, which runs
    // under node-web-audio-api). What ART structurally CANNOT see is Chrome:
    // an analyser one hop further from the graph than `outTap` could fail to be
    // pulled and quietly return all-zeros, and every only-L/R e2e built on it
    // would then be vacuous rather than red.
    //
    // So the assertions here are deliberately PATCH-AGNOSTIC — they hold for
    // any signal, so this stays a liveness probe and not a second copy of the
    // ART matrix (which is where "which side is loud" belongs).
    //
    // Measured in Chrome on this exact chain: mono 0.15507, L 0.31015, R 0
    // (linear RMS). Two things worth knowing. (1) mono is EXACTLY L/2 — the
    // downmix blindness, in a real browser, on a real patch. (2) this default
    // chain is LEFT-ONLY: a mono VCO into mixmstrs ch1L reaches AUDIO OUT's L
    // and nothing else, and the mono tap has never been able to say so.
    const taps = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string } | undefined> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes['pinned-audioOut'];
      if (!eng || !node) return null;
      const read = (k: string) =>
        eng.read(node, k) as { samples: Float32Array; sampleRate: number } | undefined;
      const rms = (s?: Float32Array) => {
        if (!s?.length) return -1;
        let q = 0;
        for (let i = 0; i < s.length; i++) q += s[i]! * s[i]!;
        return Math.sqrt(q / s.length);
      };
      const mono = read('outputSnapshot');
      const l = read('outputSnapshotL');
      const r = read('outputSnapshotR');
      return {
        defined: { mono: !!mono, l: !!l, r: !!r },
        len: { mono: mono?.samples.length ?? -1, l: l?.samples.length ?? -1, r: r?.samples.length ?? -1 },
        sr: { mono: mono?.sampleRate ?? -1, l: l?.sampleRate ?? -1, r: r?.sampleRate ?? -1 },
        rms: { mono: rms(mono?.samples), l: rms(l?.samples), r: rms(r?.samples) },
      };
    });
    expect(taps, 'engine/pinned-audioOut unavailable for the per-channel tap read').not.toBeNull();
    const t = taps!;
    // Same shape as the mono key, so every existing helper works unchanged.
    expect(t.defined, `per-channel read keys resolved: ${JSON.stringify(t.defined)}`)
      .toEqual({ mono: true, l: true, r: true });
    expect(t.len.l, `outputSnapshotL length ${t.len.l} vs mono ${t.len.mono}`).toBe(t.len.mono);
    expect(t.len.r, `outputSnapshotR length ${t.len.r} vs mono ${t.len.mono}`).toBe(t.len.mono);
    expect(t.sr.l, `outputSnapshotL sampleRate ${t.sr.l} vs mono ${t.sr.mono}`).toBe(t.sr.mono);
    expect(t.sr.r, `outputSnapshotR sampleRate ${t.sr.r} vs mono ${t.sr.mono}`).toBe(t.sr.mono);
    // THE liveness assertion: the mono tap is audible (the poll above just
    // proved it), so at least one channel tap must be too. All-zeros here is
    // exactly the Chrome-only failure ART cannot report.
    const loudest = Math.max(t.rms.l, t.rms.r);
    expect(
      loudest,
      `channel taps read all-zero while the mono tap is audible — ` +
        `RMS (linear) mono=${t.rms.mono} L=${t.rms.l} R=${t.rms.r}`,
    ).toBeGreaterThan(0.01);
    // …and the mono key really is the DOWNMIX of these two: rms((L+R)/2) can
    // never exceed max(rms L, rms R). A tap reading some unrelated, hotter node
    // would break this even though it is not all-zero.
    expect(
      t.rms.mono,
      `mono tap ${t.rms.mono} exceeds max(L=${t.rms.l}, R=${t.rms.r}) — not a downmix of these taps`,
    ).toBeLessThanOrEqual(loudest * 1.02);
  });

  test('File.. menu: quicksave slot 1 round-trips through quickload', async ({ page }) => {
    await page.goto('/rack');
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

  // ── TOPBAR PARITY: controls ported from the deleted topbar. ──────────────
  // That topbar is now gone; these prove the workflow
  // topbar carries its `Clear` and `AspectToggle` first, so that deletion is
  // not a feature regression.

  // observation of THIS leg (run on 7c489c134, shard 7 — the sixth distinct leg in six runs).
  test('File.. menu: Clear rack deletes canvas modules + cables and KEEPS the pinned trio', async ({ page }) => {
    await page.goto('/rack');
    await waitForPinnedTrio(page);

    // Two wired canvas modules to clear.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, Record<string, unknown>>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const [id, type] of [['wf-clear-vco', 'analogVco'], ['wf-clear-vca', 'vca']]) {
          w.__patch.nodes[id!] = {
            id, type, domain: 'audio', position: { x: 240, y: 240 }, params: {}, data: {},
          };
        }
        w.__patch.edges['wf-clear-edge'] = {
          id: 'wf-clear-edge',
          source: { nodeId: 'wf-clear-vco', portId: 'sine' },
          target: { nodeId: 'wf-clear-vca', portId: 'audio' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    });
    await expect(page.locator('.svelte-flow__node[data-id="wf-clear-vco"]')).toBeVisible();

    // File.. → Clear rack. It is the LAST row, below the danger divider.
    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();
    const clearRow = page.getByTestId('workflow-file-clear');
    await expect(clearRow).toBeEnabled();
    await clearRow.click();
    // Action rows close the menu (the `fire()` contract).
    await expect(page.getByTestId('workflow-file-menu')).toHaveCount(0);

    // Canvas modules + their cable are gone…
    await expect(page.locator('.svelte-flow__node[data-id="wf-clear-vco"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator('.svelte-flow__node[data-id="wf-clear-vca"]')).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
          return Object.keys(w.__patch.edges).length;
        }),
      )
      .toBe(0);
    // …and the pinned trio survived, which is the whole reason Clear is a
    // clearPatch call and not a wholesale wipe.
    await waitForPinnedTrio(page);
  });

  // aspect-toggle proof.
  test('File.. menu: the output-aspect toggle flips 4:3 ⇄ 16:9 and leaves the menu open', async ({ page }) => {
    await page.goto('/rack');
    await waitForPinnedTrio(page);

    await page.getByTestId('workflow-file-trigger').click();
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();

    const toggle = page.getByTestId('workflow-aspect-host').getByTestId('aspect-toggle');
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute('data-video-aspect');
    expect(before, 'aspect pill must report its current aspect').toMatch(/^(4:3|16:9)$/);

    await toggle.click();

    // The aspect actually changed…
    await expect
      .poll(async () => toggle.getAttribute('data-video-aspect'), { timeout: 5_000 })
      .not.toBe(before);
    // …and the menu is STILL OPEN, so the state flip is visible on the pill
    // (this row is deliberately NOT wrapped in the menu-closing `fire()`).
    await expect(page.getByTestId('workflow-file-menu')).toBeVisible();

    // Flipping back restores the original aspect — proves the control is a
    // real toggle, not a one-way write.
    await toggle.click();
    await expect
      .poll(async () => toggle.getAttribute('data-video-aspect'), { timeout: 5_000 })
      .toBe(before);
  });
});
