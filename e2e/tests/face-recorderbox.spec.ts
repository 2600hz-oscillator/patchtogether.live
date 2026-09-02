// e2e/tests/face-recorderbox.spec.ts
//
// THE RECORDERBOX FACE, driven for real on the DEFAULT shell — the seams no
// other gate can see.
//
// ⚠ THE FILENAME IS LOAD-BEARING — NOT `recorderbox-face.spec.ts`, which is
// what the build brief asked for. `e2e/webgl-heavy-globs.ts` classifies by
// PREFIX, and a module-named spec is one glob away from being swept into the
// WebGL-HEAVY lane, which is EXCLUDED from the sharded e2e matrix and skipped by
// the attest job whenever the hash is unchanged — i.e. it would run NOWHERE in
// PR CI, green forever (the `node-source-videobox.spec.ts` header records the
// incident, and `face-videobox` / `face-videovarispeed` are the shipped
// convention this follows). There is no `**/recorderbox-*` glob TODAY, which is
// exactly the kind of fact that changes without anyone re-reading this file.
// Nothing here is WebGL-heavy: it reads DOM facts and registry state through
// `window.__nodeRecording`, and samples no pixels.
//
// ── WHAT ALREADY COVERS THIS MODULE, AND WHY NONE OF IT COVERS THE FACE ─────
//
// `recorderbox.spec.ts` and `recorderbox-recover-reachable.spec.ts` are the
// module's two existing specs and BOTH boot `?shell=legacy`. They survive the
// promotion unchanged and go on passing over a surface no player meets — the
// 377-of-431 problem stated in AGENTS.md. `recorderbox-face-model.test.ts` pins
// every source-level claim; `face-rack-status-source.test.ts` proves the body
// declares what it paints; `face-screen-render-*.spec.ts` drives the SCREEN
// switch; `workflow-shell-faces` photographs the plate. None of them can see:
//
//  1. ⚠ THAT A TAKE CAN BE STARTED AT ALL WITH NO CARD ANYWHERE. This is the
//     whole practical argument for the promotion. recorderbox is in NEITHER
//     half of `HEADLESS_MOUNT_LANE_TYPES`, not in `DOM_SOURCE_LANE_TYPES` and
//     not in `CARD_PRODUCER_LANE_TYPES` — so unlike camera or loopback there is
//     no `<HeadlessSourceHost>` keeping an off-screen card alive, and with the
//     face declared and the transport left in the card there would be no route
//     to `nodeRecorder.start` on ANY surface. So this file asserts the card is
//     absent AND a take still starts.
//  2. THAT THE LANE TILE CAN DO IT, not just the dock. `Canvas.svelte`'s
//     workflow seed auto-spawns a recorderbox into every fresh rack, so the
//     tile is where this module is normally met.
//  3. THE PEER-FLIP PATH. `node.data.recording` is Y.Doc-synced, so a rack-mate
//     pressing RECORD (and a saved patch loaded with `recording: true`) must
//     start a take here too. That path passes through NO click handler, which is
//     why the reconciler had to be PORTED rather than paraphrased — and why a
//     "press the button" test alone would not have noticed it being dropped.
//  4. THE ENCODER INTERLOCK. A runtime that cannot encode must refuse, visibly.
//  5. THAT THE DELETED READOUTS STAYED DELETED and their facts survived on the
//     accessible names.
//
// ── WHAT SHIPS ON ARGUMENT, NOT MEASUREMENT ─────────────────────────────────
//
// ⚠ NO CI RUNNER HAS AN H.264 ENCODER THAT EMITS CHUNKS. `probeEncoders`
// deliberately does not trust `VideoEncoder.isConfigSupported` (a false positive
// on a headless software runner, which then writes an `ftyp` and never a
// `moof`); it ANDs it with a real encode-and-flush smoke test. So the thing this
// file can prove is that a PRESS REACHES THE NODE-OWNED REGISTRY — which is
// precisely the seam the promotion moved and precisely what would break — and
// the thing it cannot prove is that the bytes on disk are playable. That half is
// the owner's hardware check, and this module already carries an outstanding one
// from the capture-wiring fix.
//
// To make the reachable half deterministic on every machine, the capability
// answer is PINNED through `window.__recorderboxTestEncoder` — the same page
// global the VRT face scenes use, read at probe time in
// `$lib/ui/modules/recorderbox-transport.ts` (`lib/ui`, outside the WebGL attest
// basis). It is a TRI-STATE: truthy pins "can encode", falsy pins "cannot", so
// BOTH sides of the interlock are driven deliberately rather than one of them
// being whatever the runner felt like. Nothing here pins the encoder to make a
// failing assertion pass: the pin replaces a MACHINE fact, and every assertion
// below is about the CODE's response to it.
//
// ── THE POSITIVE CONTROL, AND IT WAS NOT HYPOTHETICAL ───────────────────────
//
// ⚠ LEG 1 FAILED FOR REAL BEFORE IT PASSED, on the first shape of these bodies,
// and the defect it caught is one no unit test could: `patch.nodes[id]` reads
// are not reactive on their own, AND touching `nodeVersion(id)` is not enough
// if the derivation returns the NODE — the SyncedStore proxy has a stable
// identity, so a derived that recomputes to the same proxy is value-equal and
// Svelte notifies nobody. Measured: a RECORD press wrote
// `data.recording = true` to the doc, `window.__nodeRecording` reported no
// take, the reconcile ran exactly twice (both with `recording === false`), and
// the switch stayed on `● REC` while the graph was perfectly correct. Deriving
// the LEAF with the signal touched inside it turns all four legs green. A unit
// test over `node.data` passes on BOTH states, which is precisely why this file
// exists and why the fix is not "obviously right by inspection".
//
// NO WALL-CLOCK WAITS. Every wait is an auto-retrying `expect` on the real
// subject; the only wall-clock numbers are the test BUDGET, from the one export
// site in `boot-budget.ts`, and they BOUND a failure rather than gating it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/**
 * The per-test budget.
 *
 * ⚠ SCALED BY WHAT DRIVES THE COST, not by a flat bump. What this file pays for
 * is a dock mount plus, in the legs that arm one, a CAPTURE PUMP: the registry
 * blits the node into its own full-resolution canvas and hands a frame to the
 * encoder on every animation frame, which is genuine WebGL work under
 * SwiftShader. So the budget is the shared slow-boot budget times the number of
 * TAKES a test starts (`+1` for the boot itself), which is the only quantity in
 * this file that varies between tests.
 */
const takeBudget = (takes: number) => SLOW_BOOT_TEST_TIMEOUT_MS * (takes + 1);

/** Install the capability pin BEFORE any script runs, so the very first probe
 *  sees it. `addInitScript` rather than `evaluate`: the body probes at mount and
 *  a post-navigation write would race its own subject. */
async function pinEncoder(page: Page, canEncode: boolean): Promise<void> {
  await page.addInitScript((v) => {
    (globalThis as { __recorderboxTestEncoder?: number }).__recorderboxTestEncoder = v;
  }, canEncode ? 1 : 0);
}

/**
 * Stub the FOLDER picker so arming does not open a native dialog nothing can
 * dismiss. The counters are asserted on: the folder model must call the
 * DIRECTORY picker and NEVER the single-file save picker.
 *
 * ⚠ THE FAKE FOLDER IS EMPTY, AND THAT DETAIL COST A DEBUGGING ROUND. The
 * nearest existing stub (`recorderbox.spec.ts`) has `getFileHandle` resolve
 * UNCONDITIONALLY, which is a folder in which EVERY name already exists — so
 * `mayShowOverwriteConfirm` fires, `confirm()` is auto-DISMISSED by Playwright,
 * and the take is cancelled before it starts. That stub gets away with it only
 * because its assertion (the directory picker was called) happens BEFORE the
 * overwrite check. A stub that models an impossible folder is not a
 * simplification, it is a different scenario. Here `create: false` reports
 * NotFound — a fresh destination — so no modal is raised at all and nothing in
 * this file depends on dialog handling.
 */
async function stubPickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __pick?: { dir: number; file: number };
      showDirectoryPicker?: unknown;
      showSaveFilePicker?: unknown;
    };
    w.__pick = { dir: 0, file: 0 };
    const fakeFile = {
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    };
    const fakeDir = {
      name: 'takes',
      getFileHandle: async (_name: string, opts?: { create?: boolean }) => {
        // An EMPTY folder: a lookup finds nothing, a create hands back a sink.
        if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
        return fakeFile;
      },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    };
    w.showDirectoryPicker = async () => {
      (w.__pick as { dir: number }).dir++;
      return fakeDir;
    };
    w.showSaveFilePicker = async () => {
      (w.__pick as { file: number }).file++;
      return fakeFile;
    };
  });
}

async function boot(page: Page): Promise<void> {
  // Plain /rack — the DEFAULT shell. The two existing recorderbox specs boot
  // `?shell=legacy`, which is precisely the surface promotion does not change.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/**
 * THE PROBE, and it reads the REGISTRY rather than any surface.
 *
 * `window.__nodeRecording` (#1574, already in the tree) spreads
 * `nodeRecorder.view(nodeId)`, so `state` is present exactly when the registry
 * holds an ENTRY for this node. That is the fact this file needs: "the press
 * reached `nodeRecorder.start`", which is true whether or not the runner's
 * encoder then produces a byte. `recording` is the stricter
 * `state === 'recording' | 'finalizing'`, reported alongside so a failure says
 * which of the two happened.
 */
async function nodeRecording(page: Page, nodeId: string) {
  return await page.evaluate((id) => {
    const probe = (globalThis as {
      __nodeRecording?: (n: string) => { recording: boolean; state?: string; elapsed?: number };
    }).__nodeRecording;
    if (!probe) return { present: false, recording: false, state: undefined as string | undefined };
    const v = probe(id);
    return { present: v.state !== undefined, recording: v.recording, state: v.state };
  }, nodeId);
}

/** Open this node's dock faceplate (the auto-retrying tv-librarian pattern — the
 *  tile button is hit-testable while a previous pane is still tearing down, so
 *  one click can land on nothing). */
async function openDock(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(async () => {
    if ((await dockShell.count()) === 0) {
      await shell.getByTestId('shell-open-dock').click();
    }
    await expect(dockShell).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return dockShell;
}

/** Write `node.data.recording` straight onto the shared doc — what a RACK-MATE's
 *  press looks like from this browser, and what a patch loaded with
 *  `recording: true` looks like too. Deliberately NOT a click. */
async function peerSetRecording(page: Page, nodeId: string, on: boolean): Promise<void> {
  await page.evaluate(
    ({ id, on }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.recording = on;
      });
    },
    { id: nodeId, on },
  );
}

test.describe('RECORDERBOX face — the promotion is what makes it recordable', () => {
  // ⚠ A PAGE ERROR FAILS EVERY TEST IN THIS FILE. A TypeError inside a
  // `$derived` does not surface as a thrown assertion — it takes the subtree's
  // render down and the symptom lands somewhere else entirely. A shared
  // derivation repaired on `ModuleShellPlaceholder` can still throw in
  // `ModuleShell`, and only promoting reveals it.
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`uncaught page error during a recorderbox face test: ${err.message}`);
    });
    await stubPickers(page);
  });

  test('the shell replaces the card, and the LANE TILE alone can start a take', async ({ page }) => {
    test.setTimeout(takeBudget(1));
    await pinEncoder(page, true);
    await boot(page);
    await spawnPatch(page, [{ id: 'frb1', type: 'recorderbox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    // ⚠ THE PRECONDITION THIS WHOLE FILE RESTS ON: on the default shell no
    // recorderbox card is mounted anywhere — not in the lane, not in a headless
    // host. If this ever finds a card, nothing below proves anything about the
    // face, because the card carries a reconciler of its own.
    await expect(page.locator('[data-testid="recorderbox-card"]')).toHaveCount(0);

    const tile = page.locator(
      '.svelte-flow__node[data-id="frb1"] [data-testid="recorderbox-tile-body"]',
    );
    await expect(tile, 'the lane tile carries the module\'s own transport').toBeVisible({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    const rec = tile.locator('[data-testid="recorderbox-tile-record"]');
    await expect(rec).toBeVisible();
    await expect(rec, 'a pinned-encodable runtime leaves RECORD live').toBeEnabled();

    // NEGATIVE CONTROL FIRST: the probe can say no. Without this, an assertion
    // that a take started would be indistinguishable from a probe that always
    // reports one.
    expect(
      (await nodeRecording(page, 'frb1')).present,
      'nothing is recording before the press — the probe can report absence',
    ).toBe(false);

    await rec.click();

    // ⚠ THE TRANSPORT EXPERIMENT. `__nodeRecording` reads
    // `nodeRecorder.view()`, i.e. the NODE-owned registry — not the tile, not a
    // component flag. A registry ENTRY is the observable that says
    // `nodeRecorder.start` was reached with no card in the document.
    await expect
      .poll(async () => (await nodeRecording(page, 'frb1')).present, {
        message:
          'pressing RECORD on the LANE TILE must reach the node-owned recorder with NO card '
          + 'mounted anywhere. An absent entry means the transport did not survive the '
          + 'promotion — the exact failure the extraction to recorderbox-transport.ts exists '
          + 'to prevent, and one every registry gate would report as green.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);

    // The FOLDER model, on the face's own path: the DIRECTORY picker is what a
    // start calls, never the per-save "Save As" file picker.
    const picks = await page.evaluate(
      () => (globalThis as { __pick?: { dir: number; file: number } }).__pick ?? { dir: 0, file: 0 },
    );
    expect(picks.dir, 'a start picks a destination FOLDER once').toBeGreaterThan(0);
    expect(picks.file, 'no per-save "Save As" prompt — the folder model').toBe(0);

    // The switch reflects the shared state, not a local mirror…
    await expect(rec).toHaveAttribute('data-recording', 'true');
    await expect(rec).toHaveAttribute('aria-pressed', 'true');

    // …and STOP ends it, through the same seam.
    await rec.click();
    await expect
      .poll(async () => (await nodeRecording(page, 'frb1')).present, {
        message: 'STOP must end the take through the registry',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(false);
  });

  test('a PEER FLIP of node.data.recording starts a take — no click involved', async ({ page }) => {
    test.setTimeout(takeBudget(1));
    await pinEncoder(page, true);
    await boot(page);
    await spawnPatch(page, [{ id: 'frb2', type: 'recorderbox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    await expect(page.locator('[data-testid="recorderbox-card"]')).toHaveCount(0);
    await expect(
      page.locator('.svelte-flow__node[data-id="frb2"] [data-testid="recorderbox-tile-body"]'),
    ).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE LEG A "PRESS THE BUTTON" TEST CANNOT REACH. `data.recording` is
    // Y.Doc-synced: a rack-mate's press, and a saved patch loaded with
    // `recording: true`, both arrive as a WRITE with no click handler in the
    // path. Re-implementing the start at each surface instead of porting the
    // reactor would drop both while a hand test still passed — which is why the
    // reconciler owns the reads and every surface's effect is one line.
    await peerSetRecording(page, 'frb2', true);
    await expect
      .poll(async () => (await nodeRecording(page, 'frb2')).present, {
        message:
          'a Y.Doc write to node.data.recording must start a take. This is the rack-mate and '
          + 'the load-with-recording=true path; it passes through no click handler at all.',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(true);

    // …and the reverse flip ends it, so the reactor is bidirectional.
    await peerSetRecording(page, 'frb2', false);
    await expect
      .poll(async () => (await nodeRecording(page, 'frb2')).present, {
        message: 'a peer flip to false must END the take, not merely stop showing it',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(false);
  });

  test('a runtime that CANNOT encode refuses — visibly, and without starting', async ({ page }) => {
    test.setTimeout(takeBudget(0));
    // The other side of the tri-state pin. This is the CI condition made
    // deliberate: on a runner with no working H.264 encoder the switch must be
    // dead and a peer flip must not arm anything.
    await pinEncoder(page, false);
    await boot(page);
    await spawnPatch(page, [{ id: 'frb3', type: 'recorderbox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });

    const tile = page.locator(
      '.svelte-flow__node[data-id="frb3"] [data-testid="recorderbox-tile-body"]',
    );
    await expect(tile).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
    const rec = tile.locator('[data-testid="recorderbox-tile-record"]');
    await expect(rec, 'RECORD is dead where nothing can encode').toBeDisabled({
      timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
    });

    // ⚠ THE FACT IS SPEAKABLE AND UNPAINTED. The card's "no H.264 encoder
    // available" badge is deleted; the sentence lives on the REC lamp's
    // accessible name, which is where the resting-text ruling puts it.
    await expect(tile.locator('[data-testid="recorderbox-tile-rec-led"]')).toHaveAttribute(
      'aria-label',
      /no H\.264 encoder/i,
    );

    // And a PEER flip cannot route around the interlock either — the reconciler
    // gates START on the capability, which is the half a click handler would
    // have owned before the extraction.
    await peerSetRecording(page, 'frb3', true);
    await expect
      .poll(async () => (await nodeRecording(page, 'frb3')).present, {
        message: 'a peer flip must not arm a runtime that cannot encode',
        timeout: SLOW_BOOT_TEST_TIMEOUT_MS,
      })
      .toBe(false);
  });

  test('the DOCK body carries the file name, the folder and the deleted readouts a11y', async ({ page }) => {
    test.setTimeout(takeBudget(0));
    await pinEncoder(page, true);
    await boot(page);
    await spawnPatch(page, [{ id: 'frb4', type: 'recorderbox', domain: 'video' }], [], {
      mountTimeout: BOOT_MS,
    });
    const dock = await openDock(page, 'frb4');
    const body = dock.locator('[data-testid="recorderbox-face-body"]');
    await expect(body).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE TWO SLOTS ARE COUNTERPARTS, NEVER SIBLINGS. ModuleShell renders
    // `tileBody` only where `fullViewBody` is NOT painting, so with the dock
    // open there must be exactly ONE of each on the page — otherwise every
    // testid below is doubled and strict mode would be the only thing telling
    // anyone.
    await expect(page.locator('[data-testid="recorderbox-face-body"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="recorderbox-tile-record"]')).toHaveCount(1);

    // The typed FILE field — a real input, not a ShellEntryCell, because the
    // save path sanitizes and an entry cell's rejections would disagree with
    // the name actually written.
    const file = body.locator('[data-testid="recorderbox-face-filename"]');
    await expect(file).toHaveValue('recording');
    await file.fill('take-7');
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
            };
            return w.__patch.nodes.frb4?.data?.filename;
          }),
        { message: 'the FILE field writes through to the shared node data' },
      )
      .toBe('take-7');

    // The DIR row's empty state, and the folder the PICK gesture remembers.
    await expect(body.locator('[data-testid="recorderbox-face-folder"]')).toHaveText(
      '(chosen on record)',
    );
    await body.locator('[data-testid="recorderbox-face-change-folder"]').click();
    await expect(
      body.locator('[data-testid="recorderbox-face-folder"]'),
      'the picked folder is named on the surface — #1583 was a destination silently redirected, '
        + 'so this is the one painted string here that is load-bearing rather than merely allowed',
    ).toHaveText('takes', { timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

    // ⚠ THE DELETED READOUTS STAY DELETED, and their facts survive on the
    // lamps. The card painted `REC 00:12`, `SAVING…` and `saved <chunk>`; none
    // of the three may exist as a text node on either surface.
    await expect(page.locator('[data-testid="recorderbox-rec-indicator"]')).toHaveCount(0);
    // ⚠ `SAVING` SURVIVES AS A LAMP CAPTION AND THAT IS LEGAL — a caption is a
    // NAME, painted identically lit and unlit, which is the whole design of
    // `StatusLed`. What is deleted is the card's `SAVING…` STATE WORD, which
    // existed only while finalizing and was therefore a state painted as text.
    // The ellipsis is what tells them apart, so the assertion names it.
    await expect(body).not.toContainText('SAVING…');
    await expect(body.locator('[data-testid="recorderbox-face-saving-led"]')).toHaveText('SAVING');
    await expect(body.locator('[data-testid="recorderbox-face-rec-led"]')).toHaveAttribute(
      'aria-label',
      /not recording/i,
    );
    await expect(body.locator('[data-testid="recorderbox-face-saving-led"]')).toHaveAttribute(
      'aria-label',
      /nothing to finalize/i,
    );

    // The crash-recovery block is ABSENT at rest — which is also what makes the
    // dock baseline deterministic.
    await expect(page.locator('[data-testid="recorderbox-face-recover"]')).toHaveCount(0);

    // SIZE is operable at rest and rides the shared doc.
    const size = body.locator('[data-testid="recorderbox-face-quality"]');
    await expect(size).toBeEnabled();
    await expect(size).toHaveValue('balanced');
  });
});
