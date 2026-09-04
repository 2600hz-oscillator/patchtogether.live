// e2e/tests/face-clipplayer.spec.ts
//
// THE CLIP PLAYER FACE, driven for real on the DEFAULT shell.
//
// ⚠ THE FILENAME IS DELIBERATE — `face-` rather than `clipplayer-face-`, the
// shape `face-videobox` / `face-peertube` established. Checked with minimatch
// against the live `e2e/webgl-heavy-globs.ts` list rather than by reading the
// neighbouring prose: it matches NOTHING there, so it runs in the ordinary e2e
// lane. A spec swept into the heavy lane runs NOWHERE in PR CI and is green
// forever, and the `clipplayer-*` prefix is exactly the shape a future broad
// glob named after a module would catch.
//
// ⚠ ALL EIGHTEEN EXISTING CLIPPLAYER SPECS DRIVE THE LEGACY CARD. Most boot the
// `rack` fixture (`?shell=legacy`) and the rest write `node.data` straight
// through the Y.Doc, so every one of them stays green after promotion while
// covering a surface no player meets — or covering no surface at all. This file
// is the default-shell leg they owe.
//
// `clipplayer-face-model.test.ts` pins the ranking, the six panel registrations,
// the panel/lane-tier arithmetic, the deleted families' surfaces, the shared
// menu extraction and the docs corrections. `module-face-lint` holds the def,
// `shell-cells.test.ts` holds the probes and `faces-parity` drives every cell.
// None of them can see:
//
//  1. ⚠ THAT THE PROMOTION DID NOT MAKE THE INSTRUMENT SILENT. This is the poly
//     discipline (CLAUDE.md boundary 8) in its strongest form: not "an edge
//     materializes", not the engine class driven directly, but a PAD CLICKED ON
//     THE REAL FACE driving a real VCO→VCA→SCOPE chain to audible RMS. The
//     module has no internal clock, so the same click is ALSO asserted silent
//     while TIMELORDE is stopped — a positive control the launch itself cannot
//     fake.
//  2. THAT THE CANVAS AND THE DOCK ARE THE SAME INSTRUMENT. `laneRenderKind`
//     reads `NON_SHELL_LANE_TYPES` and `DockFullView` switches on bare
//     `STRICT_FACES`; nothing in the repo reads both. If the carve-out ever
//     comes back, the lane paints the verbatim card while the dock paints the
//     faceplate, and only a DOM assertion on both surfaces can see it.
//  3. THAT THE SHARED CLIP MENU IS ACTUALLY MOUNTED ON THE FACE. The unit test
//     proves one definition and three imports; only a browser proves the
//     portal opens from a face pad and its rows act on the right clip.
//  4. THAT AN EIGHT-WIDE ROW IS EIGHT WIDE. Every panel probe drives member 0.
//     A panel that rendered ONE member would satisfy every probe in the
//     registry and lose the property the whole surface exists for.
//  5. THAT THE EDITOR BAND WRITES NOTHING ON MOUNT. It draws a default clip's
//     grid for an empty slot; a band that committed that clip for being
//     rendered would put a Y.Doc write in every rack boot.
//  5b. ⚠ THAT THE GRID AND THE EDITOR ARE **NEVER ON SCREEN TOGETHER**, which
//     is the owner's 2026-09-04 P0 and the thing no gate in the repo can
//     express. `faces-parity` asks that each cell EXISTS and OPERATES;
//     `module-face-lint` reads the def; and the VRT dock baseline was captured
//     with both surfaces in frame, so the defect WAS the baseline. Only a
//     NEGATIVE assertion on the live faceplate can see it, and it has to run in
//     both directions — either half alone passes on a face that lost a surface.
//  6. ⚠ THAT `?shell=legacy` + AN OPEN DOCK PUTS **TWO** LIVE SURFACES ON ONE
//     NODE, so six of this module's testids match TWO elements. This face
//     deliberately reuses the CARD's testid vocabulary — it is what lets the
//     eighteen existing specs' locators mean the same thing on both surfaces,
//     and what `module-docs-lint`'s card grep ties together — and the price is
//     that an UNSCOPED `clipplayer-*` locator is ambiguous in that one
//     configuration. Nothing in the repo can see it: the flag steers the CANVAS
//     lane while the dock reads `migrated(type)`, so the card and the faceplate
//     are both correct and both live. Measured, not assumed, in the last leg
//     below — a hazard nobody has written down is one the next author meets as
//     a strict-mode surprise.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

/** The FLAT clip key of a (lane, slot) cell.
 *
 * ⚠ THE STRIDE IS 64, NOT 8, AND ASSUMING OTHERWISE IS THE TRAP THIS CONSTANT
 * EXISTS FOR. `clipIndex(slot, lane) = lane * SCENE_STRIDE + slot` with
 * SCENE_STRIDE = 64, fixed independently of the eight slots the grid SHOWS, so
 * that a Launchpad can scroll to scene 9+ in the same key space. Lane 0's keys
 * therefore equal their slot (0..7) and every other lane starts at a multiple
 * of 64 — so the second row of the visible grid is 64..71, and `9` is not a
 * visible pad at all. Mirrored here rather than imported because an e2e may not
 * import from `packages/web`. */
const SCENE_STRIDE = 64;
const padKey = (lane: number, slot: number): number => lane * SCENE_STRIDE + slot;

test.describe.configure({ mode: 'parallel' });

const CP = 'f-cp';

/** The DEFAULT shell (no `?shell=legacy`) — this file's whole subject. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

function laneShell(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

/** Open a node's dock faceplate, scoped BY NODE so a second clip player in the
 *  rack can never satisfy the locator. */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = laneShell(page, nodeId);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible();
  return dockShell;
}

/** This node's dock PANE. The tab rail is painted by `DockFullView` and lives
 *  OUTSIDE the module shell, so it cannot be reached from `openDock`'s return.
 *  Scoped by node for the same reason everything else here is: the split view
 *  can hold two panes. */
function dockPane(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${nodeId}"]`);
}

/**
 * Open one `face.pages` page on this node's faceplate — the face's own view
 * switcher, and the successor to the legacy card's GRID / CLIP / ARR / CTRL
 * strip (`face.tabbed`, owner P0 2026-09-04).
 *
 * ⚠ THE `aria-selected` WAIT IS NOT DECORATION. A railed face renders exactly
 * one band; clicking a chip and reading a cell in the same breath is a race
 * against the swap, and the attribute is the state the swap actually commits.
 */
async function showPage(page: Page, nodeId: string, pageId: string): Promise<void> {
  const tab = dockPane(page, nodeId).getByTestId(`faceplate-tab-${pageId}`);
  await tab.click();
  await expect(tab, `the ${pageId} page opens`).toHaveAttribute('aria-selected', 'true');
}

/** This node's `data`, read off the live graph. */
async function readData(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

/** Set running + a fast bpm on every TIMELORDE, creating one if the seed has
 *  none — the same Y.Doc path the card's transport and the face's deck use.
 *  Copied in shape from `clipplayer.spec.ts`, which owns the legacy-side twin
 *  of the audible leg below. */
async function setTransport(page: Page, running: number): Promise<void> {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-face-cp'] = {
          id: 'tl-face-cp', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 200 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 200;
        }
      }
    });
  }, running);
}

test.describe('CLIP PLAYER faceplate', () => {
  // Group-scoped budget: boot + spawn + a dock open, and in the audible leg a
  // real engine chain and two observation windows. Derived from the shared boot
  // bound, never a flat literal.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 2);

  // ── 1. THE SPLIT-BRAIN LEG, IN THE DOM ──────────────────────────────────
  test('the LANE TILE is the SHELL — the lane strip and the panic STOP, and no legacy card', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);

    // The verbatim card is GONE from the canvas — the half of the promotion
    // `NON_SHELL_LANE_TYPES` used to prevent.
    await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(0);
    await expect(page.locator('[data-testid="clipplayer-card"]')).toHaveCount(0);

    const shell = laneShell(page, CP);
    await expect(shell).toBeVisible();

    // …and the tile carries the module's own strip: eight lane lamps, all idle
    // on a fresh player, plus the one gesture that must not need an Expand.
    const strip = shell.getByTestId('clipplayer-tile-strip');
    await expect(strip).toBeVisible();
    await expect(strip.locator('[data-testid^="clipplayer-tile-lane-"]')).toHaveCount(8);
    for (let lane = 0; lane < 8; lane++) {
      await expect(strip.getByTestId(`clipplayer-tile-lane-${lane}`)).toHaveAttribute(
        'data-state',
        'idle',
      );
    }
    await expect(strip.getByTestId(`clipplayer-tile-stopall-${CP}`)).toBeVisible();

    expect(errors, 'no page errors while the tile paints').toEqual([]);
  });

  // ── 2. THE POLY DISCIPLINE — a pad clicked ON THE FACE reaches audio ─────
  //
  // ⚠ THE ORDER OF THE THREE OBSERVATIONS IS THE POINT. A launch on a stopped
  // transport must be SILENT: the module has no internal BPM and freezes with
  // TIMELORDE, so "the pad wrote something" and "the pad made sound" are
  // different claims and the middle window separates them. That middle window
  // is also the positive control for the third — a chain that was audible all
  // along would fail it.
  test('a PAD CLICKED ON THE FACE drives the real chain to audible output', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(
      page,
      [
        {
          id: CP, type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
          // QNT off so the first launch fires immediately with nothing playing
          // to line up to; 1/16 steps.
          params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 },
        },
        { id: 'f-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
        {
          id: 'f-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
          // base 0 → fully closed at cv=0; cvAmount 1 → the gate opens it fully.
          params: { base: 0, cvAmount: 1 },
        },
        { id: 'f-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      ],
      [
        { id: 'fe1', from: { nodeId: CP, portId: 'pitch1' }, to: { nodeId: 'f-vco', portId: 'pitch' },
          sourceType: 'polyPitchGate', targetType: 'pitch' },
        { id: 'fe2', from: { nodeId: 'f-vco', portId: 'sine' }, to: { nodeId: 'f-vca', portId: 'audio' },
          sourceType: 'audio', targetType: 'audio' },
        { id: 'fe3', from: { nodeId: CP, portId: 'gate1' }, to: { nodeId: 'f-vca', portId: 'cv' },
          sourceType: 'gate', targetType: 'cv' },
        { id: 'fe4', from: { nodeId: 'f-vca', portId: 'audio' }, to: { nodeId: 'f-scp', portId: 'ch1' },
          sourceType: 'audio', targetType: 'audio' },
      ],
    );

    const dock = await openDock(page, CP);
    const grid = dock.getByTestId('clipplayer-face-grid');
    await expect(grid, 'the hero paints the launch grid').toBeVisible();
    await expect(grid.locator('[data-testid^="clipplayer-pad-"]')).toHaveCount(64);

    // (1) Nothing launched → the VCA is closed → the chain is silent.
    await setTransport(page, 0);
    const before = await readScopePeakOverWindow(page, 'f-scp', 500);
    expect(before.rms, 'silent before any launch (VCA closed)').toBeLessThan(0.03);

    // Draw four notes into lane 0 slot 0 so the launch has something to play.
    // The NOTES are seeded through the graph (drawing sixteen cells by hand is
    // a different test); the LAUNCH is the gesture under test and it is a real
    // click on the real pad.
    await page.evaluate((cp) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[cp]!;
        if (!n.data) n.data = {};
        n.data.clips = {
          '0': {
            kind: 'note', lengthSteps: 4, root: 48, loop: true,
            steps: [
              { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
              { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
              { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
              { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
            ],
          },
        };
      });
    }, CP);
    await expect(grid.getByTestId('clipplayer-pad-0')).toHaveAttribute('data-state', 'loaded');

    // STICKY NOW is on the grid, where the card has it: a modifier on the pad
    // click, carried by the panel that reads it. Asserted BEFORE the launch so
    // the leg below cannot pass on a surface that lost it.
    await expect(grid.getByTestId(`clipplayer-now-${CP}`)).toBeVisible();
    await expect(grid.getByTestId(`clipplayer-now-${CP}`)).toHaveAttribute('aria-pressed', 'false');

    // ⚠ THE GESTURE. A single click on the face's own pad — through the 220 ms
    // debounce the panel shares with the card, which is why the effect is
    // POLLED rather than read once.
    await grid.getByTestId('clipplayer-pad-0').click();
    // ⚠ THE OBSERVABLE IS THE PAD, NOT `data.queued`, AND THE DIFFERENCE IS
    // REAL. A launch with QNT off and nothing playing has no boundary to wait
    // for, so the engine can adopt the queue into `playing` on its very next
    // tick — polling `queued` alone is a race against the thing working. The
    // pad's own `data-state` covers both halves of that ("queued" then
    // "playing") and is what a player actually sees.
    await expect
      .poll(
        async () => await grid.getByTestId('clipplayer-pad-0').getAttribute('data-state'),
        { message: 'the face pad leaves LOADED for a launched state' },
      )
      .not.toBe('loaded');
    const launched = await readData(page, CP);
    expect(
      [
        (launched.queued as unknown[] | undefined)?.[0] ?? null,
        (launched.playing as unknown[] | undefined)?.[0] ?? null,
      ],
      'lane 0 is addressed at slot 0 in the graph, queued or already adopted',
    ).toContain(0);

    // (2) STILL SILENT with the transport stopped — the TIMELORDE lock, and the
    // positive control for the window below.
    const frozen = await readScopePeakOverWindow(page, 'f-scp', 700);
    expect(frozen.rms, 'frozen while TIMELORDE is stopped (the lock)').toBeLessThan(0.03);

    // (3) Run the transport → the launched clip drives lane 0's pitch + gate.
    await setTransport(page, 1);
    const after = await readScopePeakOverWindow(page, 'f-scp', 1500);
    expect(after.polls, 'the SCOPE was sampled across the window').toBeGreaterThan(0);
    expect(after.rms, 'audible gated RMS once the transport runs').toBeGreaterThan(0.03);
    expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
    expect(after.rms, 'the transport raised the output').toBeGreaterThan(frozen.rms + 0.02);

    // …and the tile agrees with the dock: the same node's lane strip now shows
    // lane 0 sounding. (Two surfaces of one instrument — leg 2 of the header.)
    await expect
      .poll(
        async () =>
          await laneShell(page, CP)
            .getByTestId('clipplayer-tile-lane-0')
            .getAttribute('data-state'),
        { message: 'the lane tile reflects the launch the dock performed' },
      )
      .toBe('playing');

    expect(errors, 'no page errors across the chain').toEqual([]);
  });

  // ── 3. THE SHARED CLIP MENU, OPENED FROM A FACE PAD ─────────────────────
  test('the extracted clip menu opens from a face pad and CLEAR deletes that clip', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);
    const grid = dock.getByTestId('clipplayer-face-grid');

    // ⚠ LANE 1, SLOT 1 — deliberately NOT lane 0. Lane 0's flat keys equal
    // their slot, so a menu that silently acted on "the selected clip" instead
    // of the right-clicked one would be indistinguishable there. Key 65.
    const key = String(padKey(1, 1));
    await grid.getByTestId(`clipplayer-pad-${key}`).dblclick();
    await expect
      .poll(async () => Object.keys(((await readData(page, CP)).clips ?? {}) as object), {
        message: 'double-clicking a face pad creates its clip',
      })
      .toContain(key);
    // …and the double-click NAVIGATED, so the grid is no longer on screen — the
    // owner's contract (the dedicated leg below is what proves it). Come back
    // before right-clicking a pad, exactly as the card's GRID button does.
    await showPage(page, CP, 'session');

    // The menu is PORTALED to <body>, so it is located on the page and not
    // inside the dock subtree.
    await grid.getByTestId(`clipplayer-pad-${key}`).click({ button: 'right' });
    const menu = page.getByTestId(`clipplayer-clip-prob-menu-${CP}`);
    await expect(menu, 'the shared menu is mounted on the face').toBeVisible();
    await expect(menu).toHaveAttribute('data-menu-kind', 'clip');

    // ⚠ CLEAR CARRIES `data-clip-idx`, NEVER `data-clip` — a second
    // `[data-clip="65"]` match while the menu is open would make every existing
    // pad locator in eighteen spec files ambiguous. Asserted here because the
    // menu now has three mounts and only one definition.
    const clear = menu.getByTestId(`clipplayer-menu-clear-${CP}`);
    await expect(clear).toHaveAttribute('data-clip-idx', key);
    await expect(menu.locator('[data-clip]')).toHaveCount(0);

    await clear.click();
    await expect
      .poll(async () => Object.keys(((await readData(page, CP)).clips ?? {}) as object), {
        message: 'CLEAR deletes the clip the menu was opened on',
      })
      .not.toContain(key);

    expect(errors).toEqual([]);
  });

  // ── 4. EIGHT IS EIGHT ───────────────────────────────────────────────────
  //
  // Every registry probe drives member 0. A panel that rendered ONE member
  // would satisfy all of them and quietly lose the property the surface is for
  // — so this drives member 3 and counts the rest.
  test('every per-lane row paints all EIGHT members, and a non-probed member writes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);

    // ⚠ COUNTED BEFORE ANY NAVIGATION, AND THAT IS DELIBERATE. A railed face
    // HIDES its inactive bands, it never unmounts them (`dockBandVisible`'s own
    // rule, so `faces-parity` cannot read a tab flip as forty lost controls) —
    // so all four rows are in the DOM on the session page and `toHaveCount`
    // sees them. If a band ever starts unmounting, this is where it goes red.
    for (const prefix of [
      'clipplayer-mono-',
      'clipplayer-rate-',
      'clipplayer-auto-arm-',
      'clipplayer-scene-repeat-',
    ]) {
      await expect(
        dock.locator(`[data-testid^="${prefix}"]`),
        `${prefix} paints eight members`,
      ).toHaveCount(8);
    }

    // …but DRIVING one needs its page open: three of the four rows are on the
    // `channels` band, which the rail hides while the launcher is showing.
    await showPage(page, CP, 'channels');

    // MONO on lane 3 — POLY is the default, so the flip is observable.
    await dock.getByTestId('clipplayer-mono-3').click();
    await expect
      .poll(async () => ((await readData(page, CP)).mono as boolean[])?.[3] ?? false, {
        message: 'lane 3 flips to MONO from the face',
      })
      .toBe(true);

    // RATE on lane 5 — a CYCLING BUTTON on the face where the card draws a
    // <select> (a native select is a cell no click probe can commit). One click
    // steps UP from the default index 3.
    await dock.getByTestId('clipplayer-rate-5').click();
    await expect
      .poll(async () => ((await readData(page, CP)).rate as number[])?.[5] ?? 3, {
        message: 'lane 5 cycles its clock rate from the face',
      })
      .toBe(4);

    // ARM on lane 6 — a single-KEY write into `automation.lanes`.
    await dock.getByTestId('clipplayer-auto-arm-6').click();
    await expect
      .poll(async () => {
        const auto = (await readData(page, CP)).automation as { lanes?: Record<string, unknown> } | undefined;
        return Object.keys(auto?.lanes ?? {});
      }, { message: 'lane 6 arms from the face' })
      .toContain('6');

    // SCENE REPEAT on scene 2 — ∞ → 2, the first step of the card's own cycle.
    // Back on `session`, where the scenes live beside the grid rows they are.
    await showPage(page, CP, 'session');
    await dock.getByTestId('clipplayer-scene-repeat-2').click();
    await expect
      .poll(async () => {
        const reps = (await readData(page, CP)).sceneRepeats as Record<string, number> | undefined;
        return reps?.['2'] ?? 0;
      }, { message: 'scene 2 takes a finite repeat count from the face' })
      .toBe(2);

    expect(errors).toEqual([]);
  });

  // ── 5. THE EDITOR BAND ──────────────────────────────────────────────────
  test('the editor band draws an empty slot without writing, and the first cell click commits', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);

    const editor = dock.getByTestId('clipplayer-face-editor');
    // ⚠ THE EDITOR IS NOT ON SCREEN UNTIL ASKED FOR (owner P0, 2026-09-04 — the
    // dedicated leg below is what proves the whole contract). Reaching it here
    // through the RAIL rather than through a pad double-click is the point of
    // this leg's subject: the tab is a second way in, it performs no
    // `ensureClip`, and the roll must still draw an empty slot without writing.
    await showPage(page, CP, 'editor');
    await expect(editor, 'the editor band paints once its page is open').toBeVisible();
    // ⚠ AND IT HAS WRITTEN NOTHING. A band that committed a clip for being
    // rendered would put a Y.Doc write in every rack boot and in every VRT
    // capture; the pending marker is how the surface says "not yet".
    await expect(editor).toHaveAttribute('data-pending', '1');
    expect(Object.keys(((await readData(page, CP)).clips ?? {}) as object), 'no clip on mount').toEqual([]);

    // The roll is real: the whole editable range is drawn at once, so there are
    // cells to click before any clip exists.
    const roll = editor.getByTestId('clipplayer-pianoroll');
    await expect(roll).toBeVisible();
    await expect(roll.locator('[data-testid^="clipplayer-cell-"]').first()).toBeVisible();

    await editor.getByTestId('clipplayer-cell-0-0').click();
    await expect
      .poll(async () => Object.keys(((await readData(page, CP)).clips ?? {}) as object), {
        message: 'the first cell click commits the clip',
      })
      .toContain('0');
    await expect(editor, 'and the pending marker lifts').toHaveAttribute('data-pending', '0');

    expect(errors).toEqual([]);
  });

  // ── 6. THE DELETED READOUTS BECAME LAMPS ────────────────────────────────
  //
  // Three families left the def in this promotion. "Not a cell" must not mean
  // "gone", and `face-resting-text-source` declares body markup its own blind
  // spot — so the lamps are asserted here, along with the property that makes
  // them legal: the measurement is on the accessible name, never in a text node.
  test('the automation readouts are StatusLed lamps, and paint no derived value', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);
    const deck = dock.getByTestId('clipplayer-face-deck');
    await expect(deck).toBeVisible();

    for (const [testid, caption] of [
      [`clipplayer-auto-assigned-${CP}`, 'ASSIGNED'],
      [`clipplayer-auto-cap-${CP}`, 'MAX'],
    ] as const) {
      const lamp = deck.getByTestId(testid);
      await expect(lamp, `${caption} is a lamp`).toBeVisible();
      // Dark on a fresh player: nothing assigned, no cap hit.
      await expect(lamp).toHaveAttribute('data-lit', '0');
      // ⚠ THE CAPTION IS STATIC AND THE MEASUREMENT IS NOT PAINTED. The lamp's
      // visible text is the caption alone; the sentence lives on aria-label.
      await expect(lamp).toHaveText(caption);
      const label = (await lamp.getAttribute('aria-label')) ?? '';
      expect(label.length, `${caption} announces its measurement`).toBeGreaterThan(caption.length);
    }

    // The OVERRIDE dot kept its click and is disabled while nothing is
    // suspended — a lamp that is also a button is still a lamp.
    const override = deck.getByTestId(`clipplayer-auto-override-${CP}`);
    await expect(override).toBeVisible();
    await expect(override).toBeDisabled();

    // RST keeps its MIDI-assign wrapper on the face: right-click opens the
    // assign menu rather than the node's own context menu.
    await expect(deck.getByTestId('clipplayer-reset')).toBeVisible();

    expect(errors).toEqual([]);
  });

  // ── 7. THE EDITOR FOLLOWS THE PAD, ACROSS LANES ──────────────────────────
  //
  // ⚠ THE P0 THIS PINS (owner, 2026-09-03). The selection registry's guard
  // bounded the flat key by CLIP_COUNT (= 64, a PAD count) while the key space
  // is stride-64 (`lane*64+slot`, see `padKey` above) — so double-clicking any
  // pad OFF lane 1 CREATED its clip and then silently dropped the SELECT, and
  // the editor band stayed bound to the old clip with every edit landing there.
  // Leg "the extracted clip menu…" above is the shape of the miss: it
  // double-clicks pad 65 and asserts CREATION, which stayed green throughout.
  // This leg asserts the BINDING (the head's accessible name) and the WRITE
  // (the cell click lands in the clip the head names, and ONLY there).
  test('the editor follows the pad you double-click across lanes, and writes THAT clip', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);
    const grid = dock.getByTestId('clipplayer-face-grid');
    const editor = dock.getByTestId('clipplayer-face-editor');
    // The clip head is the editor's one role=group; its accessible name carries
    // the channel/slot identity the 2026-08-17/19 rulings moved off resting text.
    //
    // ⚠ THE PAGE HAS TO BE OPEN FOR A ROLE QUERY TO SEE IT, and that is a
    // property of the fix rather than a workaround: the rail HIDES the inactive
    // band, and a hidden band is out of the accessibility tree, which is
    // precisely what "we do not see the grid" (and, at rest, the editor) means
    // for a screen reader as well as for the eye. Reached through the rail here
    // because the SUBJECT of this leg is the pad double-click that follows.
    await showPage(page, CP, 'editor');
    const head = editor.getByRole('group');
    await expect(head, 'a fresh player binds the editor to clip 0').toHaveAttribute(
      'aria-label',
      /^channel 1 slot 1,/,
    );
    await showPage(page, CP, 'session');

    // PAD A — lane 1 slot 3 (flat key 2, the stride-invariant lane): bind, edit.
    // ⚠ THE DOUBLE-CLICK IS ALSO THE NAVIGATION now, so no `showPage` here: if
    // it ever stopped opening the editor page, `cell-0-0` would be hidden and
    // this click would fail rather than the binding silently going untested.
    await grid.getByTestId('clipplayer-pad-2').dblclick();
    await expect(head, 'the editor binds to pad A').toHaveAttribute('aria-label', /^channel 1 slot 3,/);
    await editor.getByTestId('clipplayer-cell-0-0').click();
    await expect
      .poll(async () => {
        const clips = ((await readData(page, CP)).clips ?? {}) as Record<string, { steps?: unknown[] }>;
        return clips['2']?.steps?.length ?? 0;
      }, { message: 'the cell click writes clip 2' })
      .toBe(1);

    // PAD B — lane 3 slot 2 (flat key 129): the key the old CLIP_COUNT bound
    // rejected. The head must follow, and the next edit must land in 129 —
    // and NOT in 2, which is precisely where the broken binding sent it.
    const keyB = String(padKey(2, 1)); // lane index 2, slot index 1 → 129
    // Back to the launcher first — the editor page is showing, so the grid is
    // not (the card's GRID button, in the face's vocabulary).
    await showPage(page, CP, 'session');
    await grid.getByTestId(`clipplayer-pad-${keyB}`).dblclick();
    await expect(head, 'the editor binds to pad B, off lane 1').toHaveAttribute(
      'aria-label',
      /^channel 3 slot 2,/,
    );
    await editor.getByTestId('clipplayer-cell-0-1').click();
    await expect
      .poll(async () => {
        const clips = ((await readData(page, CP)).clips ?? {}) as Record<string, { steps?: unknown[] }>;
        return [clips[keyB]?.steps?.length ?? 0, clips['2']?.steps?.length ?? 0];
      }, { message: 'the edit lands in clip 129 and clip 2 is untouched' })
      .toEqual([1, 1]);

    // The editor-foot QUEUE targets B's lane+slot — the same binding, on the
    // launch path (the card's editor-foot semantics, verbatim).
    // ⚠ QUEUED **OR** PLAYING, the audible leg's own lesson: with nothing
    // playing there is no boundary to wait for, so the engine can adopt the
    // queue into `playing` on its very next tick — polling `queued` alone is a
    // race against the thing working (it lost on a REPEAT run). Either field
    // holding slot index 1 on lane index 2 proves the binding.
    await editor.getByTestId('clipplayer-edit-queue').click();
    await expect
      .poll(async () => {
        const d = await readData(page, CP);
        return [
          (d.queued as unknown[] | undefined)?.[2] ?? null,
          (d.playing as unknown[] | undefined)?.[2] ?? null,
        ];
      }, { message: 'QUEUE addresses lane 3 (index 2) at slot 2 (index 1), queued or already adopted' })
      .toContain(1);

    expect(errors).toEqual([]);
  });

  // ── 8. THE PLAYHEAD COLUMN DIES WITH THE TRANSPORT ───────────────────────
  //
  // ⚠ THE STUCK-COLUMN ARTIFACT (owner, 2026-09-03). Stopping TIMELORDE keeps
  // every lane's `active` slot (clips resume on restart) and leaves the elapsed
  // schedule behind, so the engine's `currentStep:L` read kept answering the
  // LAST sounded step — and the editor painted a full-column "playhead" frozen
  // on screen for as long as the clip stayed armed. The legacy card polled the
  // same key and froze the same way, but its editor is a view you leave; the
  // face's editor band is always on screen, so the column read as a permanent
  // artifact. The read is now gated on the SAME `transportRunning()` the
  // scheduler gates on (clipplayer.ts), which clears both surfaces at once.
  //
  // The order is the point: run → column PRESENT (the positive control — a
  // roll that never paints a playhead cannot pass the clears-leg vacuously) →
  // stop → column CLEARS → run → column RETURNS (the gate did not kill the
  // playhead, and a stopped lane really does resume).
  test('the playhead column clears when the transport stops, and returns when it runs', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      {
        id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio',
        // QNT off so the launch fires immediately; 1/16 steps.
        params: { quantize: 0, stepDiv: 2 },
      },
    ]);
    // A real transport, STOPPED — free-run (no TIMELORDE) legitimately keeps
    // its own clock, so the stuck state needs the rack clock present.
    await setTransport(page, 0);
    const dock = await openDock(page, CP);
    const grid = dock.getByTestId('clipplayer-face-grid');
    const editor = dock.getByTestId('clipplayer-face-editor');

    // Notes for clip 0 (the editor's default binding) seeded through the graph
    // — the launch and the paint are the subjects, not sixteen cell clicks.
    await page.evaluate((cp) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[cp]!;
        if (!n.data) n.data = {};
        n.data.clips = {
          '0': {
            kind: 'note', lengthSteps: 16, root: 48, loop: true,
            steps: [
              { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
              { step: 4, midi: 74, velocity: 127, lengthSteps: 1 },
              { step: 8, midi: 76, velocity: 127, lengthSteps: 1 },
              { step: 12, midi: 79, velocity: 127, lengthSteps: 1 },
            ],
          },
        };
      });
    }, CP);
    await expect(grid.getByTestId('clipplayer-pad-0')).toHaveAttribute('data-state', 'loaded');

    const playheadCells = editor.locator('.cell.playhead');

    await setTransport(page, 1);
    await grid.getByTestId('clipplayer-pad-0').click();
    // …and NOW open the editor. The launch is a `session` gesture and the
    // playhead is an `editor` observation; on a railed face those are two
    // pages, so the leg performs the navigation a player would rather than
    // reading a band that is off screen.
    await showPage(page, CP, 'editor');
    await expect
      .poll(async () => await playheadCells.count(), {
        message: 'POSITIVE CONTROL: the running clip paints a playhead column',
      })
      .toBeGreaterThan(0);

    // ⚠ THE STUCK STATE, RECREATED: stop the transport while the clip is still
    // armed (`data.playing[0]` stays 0 — that is the resume contract, asserted
    // so this leg cannot silently pass by the lane having stopped instead).
    await setTransport(page, 0);
    await expect
      .poll(async () => await playheadCells.count(), {
        message: 'the frozen column CLEARS when the transport stops',
      })
      .toBe(0);
    expect(
      ((await readData(page, CP)).playing as unknown[] | undefined)?.[0],
      'the lane is still ARMED (stopping the transport is not stopping the clip)',
    ).toBe(0);

    await setTransport(page, 1);
    await expect
      .poll(async () => await playheadCells.count(), {
        message: 'the playhead returns when the transport runs again',
      })
      .toBeGreaterThan(0);

    expect(errors).toEqual([]);
  });

  // ── 9. GRID **XOR** EDITOR — THE OWNER'S P0, ASSERTED BOTH WAYS ──────────
  //
  // ⚠ WHAT WENT WRONG, AND WHY EVERY GATE IN THE REPO WAS GREEN FOR IT. The
  // face shipped (#2326) with the launch grid promoted to `face.hero.cell` and
  // all four bands stacked in one scrolling column, and its own source argued
  // the point out loud: "The faceplate holds the launch grid (the hero), the
  // note editor (a band) and this deck AT ONCE, so there is no selection left
  // to make" (ClipplayerDeckBody) and "A faceplate has no views: this band is
  // on screen from the moment the dock opens" (ClipplayerNotePanel). The owner
  // (2026-09-04): "we do NOT want the clip viewer always visible. we want to
  // see it when we double click on a grid cell, at which point, we do not see
  // the grid. this needs to work exactly the way the legacy card did."
  //
  // Every existing gate was structurally blind to it. `faces-parity` asks that
  // each cell EXISTS and OPERATES; `module-face-lint` reads the def; the VRT
  // dock baseline was captured WITH the editor in frame, so the defect WAS the
  // baseline. Not one of them can express "these two surfaces must never be on
  // screen together", which is why this leg asserts the NEGATIVE — and asserts
  // it in BOTH directions, because either half alone passes on a face that
  // simply lost a surface.
  //
  // The legacy contract, from `ClipplayerCard.svelte`:
  //   * `cardView` starts at 'grid';
  //   * `onPadDblClick` = ensureClip + select + `cardView = 'clip'`;
  //   * grid and editor are branches of ONE if/else;
  //   * `onPadClick` debounces 220 ms so a double-click never also launches;
  //   * the strip's GRID button is the way back.
  test('double-clicking a pad REPLACES the grid with that clip in the editor', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await gotoShell(page);
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    const dock = await openDock(page, CP);
    const grid = dock.getByTestId('clipplayer-face-grid');
    const editor = dock.getByTestId('clipplayer-face-editor');

    // ── (1) AT REST: THE LAUNCHER, AND ONLY THE LAUNCHER ──────────────────
    // `cardView = 'grid'` — the face's equivalent is `pages[0]`.
    await expect(grid, 'a freshly opened faceplate shows the launch grid').toBeVisible();
    await expect(
      editor,
      'THE OWNER\'S REPORT: the clip viewer must NOT be on screen until asked for',
    ).toBeHidden();

    // ⚠ HIDDEN, NOT ABSENT — the distinction the platform depends on. A railed
    // face hides its inactive bands with CSS and never unmounts them, because
    // `faces-parity` matches hidden elements and would read an unmount as a
    // face that lost its cells. So the roll is in the DOM and out of view.
    await expect(
      editor.locator('[data-testid^="clipplayer-cell-"]').first(),
      'the editor band is HIDDEN, not unmounted',
    ).toHaveCount(1);

    // ── (2) THE GESTURE: DOUBLE-CLICK LANE 3 SLOT 2 (flat key 129) ────────
    // Off lane 1 deliberately: lane 0's flat keys equal their slot, so a
    // navigation that opened "whatever was already selected" would look correct
    // there and nowhere else — the #2336 stride-64 lesson, applied to the view.
    const key = String(padKey(2, 1));
    await grid.getByTestId(`clipplayer-pad-${key}`).dblclick();

    // ── (3) THE EDITOR IS SHOWING **THAT** CLIP ───────────────────────────
    await expect(editor, 'the editor opens on a double-click').toBeVisible();
    await expect(
      editor.getByRole('group'),
      'and it is bound to the pad that was double-clicked, not to clip 0',
    ).toHaveAttribute('aria-label', /^channel 3 slot 2,/);

    // ── (4) …AND THE GRID IS GONE. The half the owner actually reported. ──
    await expect(grid, '"at which point, we do not see the grid"').toBeHidden();

    // ── (5) THE WAY BACK. The card's GRID button; the face's SESSION tab. ──
    await showPage(page, CP, 'session');
    await expect(grid, 'the launcher comes back').toBeVisible();
    await expect(editor, 'and the clip viewer goes away again').toBeHidden();

    // ── (6) A SINGLE CLICK STILL LAUNCHES, AND DOES NOT NAVIGATE ──────────
    // Two jobs. It is this leg's NEGATIVE CONTROL — without it everything above
    // would pass just as well on a face whose pads had stopped launching, which
    // is the larger regression this change could have caused. And it is the
    // CLOCK for (7): a launch commits only when the pad's own 220 ms debounce
    // fires, so observing THIS one land is proof that at least that much wall
    // clock has passed since the click below it in the ordering argument.
    //
    // A DIFFERENT pad (lane 1 slot 1, flat key 0) so the two claims cannot be
    // confused with each other.
    await grid.getByTestId('clipplayer-pad-0').click();
    await expect
      .poll(
        async () => {
          const d = await readData(page, CP);
          return [
            (d.queued as unknown[] | undefined)?.[0] ?? null,
            (d.playing as unknown[] | undefined)?.[0] ?? null,
          ];
        },
        { message: 'a SINGLE click still launches (queued, or already adopted as playing)' },
      )
      .toContain(0);
    await expect(grid, 'and a launch is not a navigation — the grid stays').toBeVisible();
    await expect(editor, 'the clip viewer stays away').toBeHidden();

    // ── (7) THE DOUBLE-CLICK NEVER LAUNCHED ───────────────────────────────
    // The card's 220 ms debounce, and the reason it exists: without it every
    // trip to the editor fires the clip on the way in.
    //
    // ⚠ ORDERED, NOT SLEPT. "It did not happen" needs a moment after which it
    // could no longer happen, and a bare wait is the thing this repo forbids.
    // The debounce timer for lane 3 was scheduled BEFORE the one for lane 1,
    // and (6) has just observed lane 1's fire — so lane 3's would have fired
    // first if it had been left armed. Reading lane 3 as untouched HERE is
    // therefore a real ordering argument rather than a race that happened to
    // win.
    const d = await readData(page, CP);
    expect(
      [
        (d.queued as unknown[] | undefined)?.[2] ?? null,
        (d.playing as unknown[] | undefined)?.[2] ?? null,
      ],
      'a double-click NEVER launches — the debounce cleared the pending click',
    ).toEqual([null, null]);
    // …and the pad it opened is LOADED, which is the other half of the card's
    // gesture: the trip to the editor creates the clip on the way in.
    await expect(grid.getByTestId(`clipplayer-pad-${key}`)).toHaveAttribute('data-state', 'loaded');

    expect(errors, 'no page errors across the view swap').toEqual([]);
  });

  // ── 10. THE TWO-SURFACE HAZARD, MEASURED AND SCOPED ─────────────────────
  test('under ?shell=legacy an open dock makes the card AND the face live — scope, do not assume', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    // ⚠ THE ESCAPE HATCH ONLY. `?shell=legacy` steers `laneRenderKind`, so the
    // CANVAS keeps the verbatim card; `DockFullView` reads `migrated(type)`,
    // which the flag does not answer, so the DOCK paints the faceplate. Both
    // are correct and both are live views of one node.
    await page.goto('/rack?shell=legacy&seed=none');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await spawnPatch(page, [
      { id: CP, type: 'clipplayer', position: { x: 120, y: 120 }, domain: 'audio' },
    ]);
    await expect(page.getByTestId('clipplayer-card')).toHaveCount(1);
    await page.evaluate((id) => {
      (globalThis as unknown as { __openDockFullView: (n: string) => void }).__openDockFullView(id);
    }, CP);
    const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${CP}"]`);
    await expect(pane).toBeVisible();

    // THE MEASUREMENT: six testids, two elements each. Asserted as an EXACT
    // count rather than "at least one", so the day a surface stops emitting one
    // this goes red instead of quietly halving.
    for (const testid of [
      'clipplayer-pad-0',
      'clipplayer-color-0',
      'clipplayer-mono-0',
      'clipplayer-rate-0',
      'clipplayer-auto-arm-0',
      'clipplayer-scene-repeat-0',
    ]) {
      await expect(
        page.locator(`[data-testid="${testid}"]`),
        `${testid}: the card and the faceplate BOTH emit it in this configuration`,
      ).toHaveCount(2);
    }

    // …AND THE REMEDY IS ALREADY THERE, which is why this is a hazard and not a
    // defect: every face surface lives under a node-scoped module shell, so a
    // scoped locator resolves to exactly one. That is what every spec in this
    // file and in `clipplayer-grid-stability` / `menu-viewport-clamp` does.
    const dockShell = pane.locator(
      `[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${CP}"]`,
    );
    await expect(dockShell.getByTestId('clipplayer-pad-0')).toHaveCount(1);
    await expect(
      page.locator('.svelte-flow__node[data-id="' + CP + '"]').getByTestId('clipplayer-pad-0'),
    ).toHaveCount(1);

    expect(errors).toEqual([]);
  });
});
