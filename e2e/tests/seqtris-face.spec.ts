// e2e/tests/seqtris-face.spec.ts
//
// SEQTRIS'S PROMOTED FACE — the DEFAULT shell, which nothing else in the repo
// exercises for this module.
//
// ── ⚠ WHY THIS FILE EXISTS: GREEN DOES NOT MEAN COVERED ────────────────────
//
// `e2e/tests/seqtris.spec.ts` is a good file — it is the AGENTS.md boundary-8
// chain, five tests running simulated Launchpad → the app's own CONNECT click →
// bindUnit → onKey → the pure core → PIECE → a real DX7 → SCOPE RMS, with a
// full-window negative control. It runs on the `rack` FIXTURE, which is
// `?shell=legacy` BY CONSTRUCTION, so every one of those five tests keeps
// passing after promotion WITHOUT EVER TOUCHING THE NEW SURFACE. That is the
// `e2e-rack-fixture-hides-shell-parity` finding in its exact shape, and it is
// why those five are left alone (they are also the legacy card's own gate,
// which must keep working while `?shell=legacy` ships) and why this file is the
// default-shell half rather than a re-pointing of them.
//
// ── ⚠ AND THE BLIND SPOT IS UNUSUALLY WIDE HERE ────────────────────────────
//
// SEVEN of the card's eleven testids have ZERO consumers anywhere in the tree.
// A promoted surface that silently dropped THE WELL, THE SCENE COLUMN, THE PORT
// PICKER or THE LAMP would be caught by no gate at all. The structural half of
// that is held at the source in `seqtris-face-model.test.ts`; this file is the
// half that can only be seen in a browser.
//
// ── WHAT EACH LEG PROVES ───────────────────────────────────────────────────
//
//   1. LANE — the tile paints a live well: 64 cells, at least one carrying a
//      piece, and the cells are actually PAINTED rather than merely present.
//   2. DOCK — the hardware scene column is EIGHT rows in `SEQTRIS_SCENE_ACTIONS`
//      order with the two dead spacers still at 1 and 2.
//   3. RULE 8, RE-PAID ON THE SURFACE THAT NOW SHIPS — the simulated Launchpad
//      through the FACE's own CONNECT / picker / unbind, then an ON-SCREEN scene
//      press through PIECE → DX7 → audible SCOPE RMS.
//   4. SCREEN — the picture goes, the accessible name stays, and the game KEEPS
//      PLAYING. The only leg that can fail if someone gates the module on the
//      view.
//   5. NEGATIVE CONTROL — the identical dock graph, undriven, silent over a
//      full window with no early exit.
//
// Every leg carries a `pageerror` guard: a shared derivation repaired only on
// `ModuleShellPlaceholder` can still throw inside `ModuleShell`, and only
// PROMOTING reveals it — a face that throws mid-render leaves a plausible-
// looking empty tile.
//
// NO WALL-CLOCK WAITS DEFINE READINESS: every wait is an auto-retrying
// `expect`/`expect.poll` on the real subject, and the audible windows are
// FAILURE BOUNDS rather than gates (a sounding voice ends one the moment it
// crosses the floor). The in-page sampler throws on zero samples, so "the
// instrument never looked" cannot print as "the module is silent".

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, seedKriaGate, type SpawnEdge, type SpawnNode } from './_helpers';
import {
  readScopePeakOverWindow,
  describeScopeWindow,
} from './_module-coverage-helpers';
// ⚠ IMPORTED, NOT RE-DERIVED. #2286 gave the boot bound exactly one home, and
// #2291/#2293 root-caused what a second drifting copy costs. The PER-TEST
// BUDGET below is the other half of that: Playwright's default is an INVISIBLE
// 30 000 that nothing in a file can be grepped for except by its absence, and a
// bound at or above the budget containing it can never come true — the outer
// clock kills the test first and a legible `element not found` becomes an
// illegible `Test timeout exceeded`.
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const NODE = 'sq';

/** CAP on the "wait until audible" observation — it BOUNDS THE FAILURE and is
 *  not the gate; a sounding voice ends the window the moment it crosses the
 *  floor. Sized like the sibling file's, for a contended CI shard where the
 *  main-thread step scheduler can stall for most of a second at a time. */
const AUDIBLE_CAP_MS = 10_000;
/** Full-window observation for the SILENCE assertion — deliberately no early
 *  exit, because "it never got loud" only means something if we watched. */
const SILENCE_WINDOW_MS = 800;
const AUDIBLE_FLOOR = 0.01;

/**
 * The scene column, TOP-origin, as `SEQTRIS_SCENE_ACTIONS` declares it.
 *
 * ⚠ RE-STATED HERE BECAUSE AN e2e CANNOT IMPORT FROM `packages/web`, and the
 * duplication is pinned rather than trusted: `seqtris-face-model.test.ts`
 * asserts the roster's exact contents at the source, and leg 2 below asserts
 * that the RENDERED column matches this list — so a roster change that did not
 * reach this file fails there rather than silently testing the old order.
 * ⚠ THE `null`s ARE THE POINT. They are the two dead buttons, left DARK on the
 * hardware, and the column exists on screen precisely so the mapping is
 * learnable without one plugged in.
 */
const SCENE_ACTIONS: readonly (string | null)[] = [
  'reset', null, null, 'drop', 'rotateLeft', 'rotateRight', 'moveLeft', 'moveRight',
];

interface SeqtrisState {
  divisor: number;
  lines: number;
  notesFired: number;
  spawns: number;
  tiedDrops: number;
  clockPulses: number;
  clockPatched: boolean;
}

/** Read the module's own state off the LIVE engine handle. */
async function readState(page: Page): Promise<SeqtrisState> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const engine = w.__engine?.();
    const node = w.__patch.nodes[id];
    return engine!.read(node, 'state') as SeqtrisState;
  }, NODE);
}

/** The shipping shell. ⚠ NOT `?shell=legacy` and NOT the `rack` fixture — see
 *  the header; that fixture is the reason the existing suite cannot see any of
 *  this. */
async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Resume the AudioContext so the scheduler clock's audio-side consumers run.
 *  A local copy rather than an import: coupling two suites' lifetimes buys
 *  nothing. */
async function resumeAudio(page: Page): Promise<void> {
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 })
    .catch(() => { /* already running */ });
}

/** Install the in-memory Launchpad. Must run BEFORE the CONNECT click. */
async function installLaunchpad(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as Record<string, unknown>).__seqtrisTestInstall === 'function',
  );
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __seqtrisTestInstall: () => Promise<boolean> };
    await w.__seqtrisTestInstall();
  });
}

function shellTile(page: Page) {
  return page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
}

/** Open the dock full view — where the `fullViewBody` paints. ⚠ CONNECT, the
 *  picker and the scene column are DOCK-ONLY by `dockFullViewHeadPlan`: a
 *  ~192 px lane tile cannot carry them under `_card-overflow`'s bound, which is
 *  the `midiCvBuddy` / `skifree` call rather than a preference. */
async function openDock(page: Page) {
  await shellTile(page).getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view')).toBeVisible();
  await expect(page.getByTestId('seqtris-face-body')).toBeVisible();
  return page.getByTestId('seqtris-face-body');
}

/** A `pageerror` collector. ⚠ EVERY FACE SPEC OWES ONE. */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('AudioContext'));
}

/** SEQTRIS → DX7 → SCOPE, optionally with a KRIA clock into the game. The same
 *  graph shape the legacy chain drives, so the two files differ only in WHICH
 *  SURFACE plays it. */
function graph(opts: { clocked: boolean; gravity?: number }): {
  nodes: SpawnNode[];
  edges: SpawnEdge[];
} {
  const nodes: SpawnNode[] = [
    {
      id: NODE,
      type: 'seqtris',
      position: { x: 340, y: 60 },
      domain: 'audio',
      params: { gravity: opts.gravity ?? 1 },
    },
    {
      id: 'dx',
      type: 'dx7',
      position: { x: 680, y: 60 },
      domain: 'audio',
      params: {
        algorithm: 5, voiceCount: 5, attack: 0.02, decay: 0.2,
        sustain: 0.9, release: 0.4, level: 1,
      },
    },
    { id: 'sc', type: 'scope', position: { x: 1020, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    {
      id: 'e_piece',
      from: { nodeId: NODE, portId: 'piece' },
      to: { nodeId: 'dx', portId: 'poly' },
      sourceType: 'polyPitchGate',
      targetType: 'polyPitchGate',
    },
    {
      id: 'e_out',
      from: { nodeId: 'dx', portId: 'out' },
      to: { nodeId: 'sc', portId: 'ch1' },
      sourceType: 'audio',
      targetType: 'audio',
    },
  ];
  if (opts.clocked) {
    nodes.push({
      id: 'clk',
      type: 'kria',
      position: { x: 40, y: 60 },
      domain: 'audio',
      params: { bpm: 240, running: 1 },
    });
    edges.push({
      id: 'e_clk',
      from: { nodeId: 'clk', portId: 'gate1' },
      to: { nodeId: NODE, portId: 'clock' },
      sourceType: 'gate',
      targetType: 'gate',
    });
  }
  return { nodes, edges };
}

// ────────────────────────────────────────────────────────────────────────────

test.describe('SEQTRIS — the promoted FACE, on the default shell', () => {
  test('the LANE TILE paints a LIVE WELL with nothing expanded', async ({ page }) => {
    // ⚠ THE STATE NOTHING ELSE WATCHES. Before promotion this lane was a
    // `ModuleShellPlaceholder` while the game ran underneath; the well's 64
    // testids have zero consumers, so nothing else can tell a tile with a board
    // on it from a title bar and two knobs.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    const g = graph({ clocked: false });
    await spawnPatch(page, g.nodes, g.edges);
    await resumeAudio(page);

    const tile = shellTile(page);
    await expect(tile, 'a promoted module paints the curated shell, not the placeholder')
      .toBeVisible();
    await expect(
      page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell-placeholder"]`),
      'the placeholder must be gone — promotion is what swaps them',
    ).toHaveCount(0);

    const well = tile.getByTestId('seqtris-tile-well');
    await expect(well, 'the tileBody must paint the well').toBeVisible();

    // ⚠ ALL 64, and the count is what a "the grid stopped nesting" regression
    // would break: a single `{#each}` renders 8 and every later assertion would
    // still be about "cells".
    const cells = tile.locator('[data-testid^="seqtris-tile-cell-"]');
    await expect(cells, 'an 8x8 well is 64 cells').toHaveCount(64);

    // ── THE PIECE IS THERE, AND IT IS PAINTED ──────────────────────────────
    // ⚠ PAINT, NOT PRESENCE. A rack-fixture-shaped test that only counted
    // elements would pass on an unstyled grid, which is exactly what a body
    // that mounted with its `<style>` scoped away would render.
    await expect
      .poll(async () => (await cells.evaluateAll(
        (els) => els.filter((e) => (e as HTMLElement).dataset.piece).length,
      )), {
        timeout: BOOT_MS,
        message: 'no cell ever carried a data-piece — the body mounted but never attached to the '
          + "module's snapshot seam, or the engine handle never appeared",
      })
      .toBeGreaterThan(0);

    const paint = await cells.evaluateAll((els) => {
      const filled = els.filter((e) => (e as HTMLElement).dataset.piece);
      const empty = els.filter((e) => !(e as HTMLElement).dataset.piece);
      return {
        filledCount: filled.length,
        emptyCount: empty.length,
        filledBg: filled[0] ? getComputedStyle(filled[0]).backgroundColor : null,
        emptyBg: empty[0] ? getComputedStyle(empty[0]).backgroundColor : null,
      };
    });
    expect(paint.emptyCount, 'a fresh spawn cannot fill the whole well').toBeGreaterThan(0);
    expect(paint.filledBg, `a piece cell must be painted (${JSON.stringify(paint)})`).toBeTruthy();
    expect(
      paint.filledBg,
      `a piece cell must not be transparent (${JSON.stringify(paint)})`,
    ).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(
      paint.filledBg,
      `the piece colour must DIFFER from an empty cell's, or the palette never reached the DOM `
        + `(${JSON.stringify(paint)})`,
    ).not.toBe(paint.emptyBg);

    // The tile is READ-ONLY: no scene column, no CONNECT, no SCREEN switch.
    await expect(tile.getByTestId('seqtris-face-controls')).toHaveCount(0);
    await expect(tile.getByTestId('seqtris-face-connect')).toHaveCount(0);
    await expect(tile.getByTestId('seqtris-tile-screen-toggle')).toHaveCount(0);
    // …but the bind lamp IS here — the glance that answers "is my Launchpad on
    // it", which is the whole reason the tile is not blank without the column.
    await expect(tile.getByTestId('seqtris-tile-led')).toBeVisible();

    expect(realErrors(errors), 'a face that throws mid-render leaves a plausible empty tile')
      .toEqual([]);
  });

  test('the DOCK carries the LAUNCHPAD\'S OWN COLUMN — eight rows, two of them dead', async ({ page }) => {
    // ⚠ THE ORDER IS THE ONE THING THAT MUST NOT MOVE. `face.order` is a
    // PRIORITY ranking, so ranking these as cells would reorder them; the
    // column is unrankable by construction and lives in the body instead. A
    // body that "tidied" the dead entries out, or sorted by label, would slide
    // the six live captions up two rows and teach the WRONG mapping — and
    // nothing else in CI would notice.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    const g = graph({ clocked: false });
    await spawnPatch(page, g.nodes, g.edges);
    await resumeAudio(page);
    const body = await openDock(page);

    const controls = body.getByTestId('seqtris-face-controls');
    await expect(controls, 'the scene column must paint').toBeVisible();
    await expect(
      controls.locator(':scope > *'),
      'the column is EIGHT rows — the hardware\'s, including the two dead buttons',
    ).toHaveCount(SCENE_ACTIONS.length);

    // The rendered order, read back and compared with the roster.
    const rendered = await controls.evaluateAll(
      (els) => Array.from(els[0]!.children).map((c) => (c as HTMLElement).dataset.testid ?? null),
    );
    expect(
      rendered,
      'the rendered column must be SEQTRIS_SCENE_ACTIONS in order, with the dead rows still '
        + 'occupying indices 1 and 2',
    ).toEqual(SCENE_ACTIONS.map((a) => (a === null ? null : `seqtris-face-control-${a}`)));

    // ⚠ AND THE DEAD ROWS ARE HIDDEN FROM THE A11Y TREE BUT PRESENT IN LAYOUT —
    // a spacer that collapsed would be the same defect as a deleted one.
    for (const i of [1, 2]) {
      const dead = controls.locator(':scope > *').nth(i);
      await expect(dead, `row ${i} is a dead button`).toHaveAttribute('aria-hidden', 'true');
      const box = await dead.boundingBox();
      expect(box, `row ${i} must occupy layout`).not.toBeNull();
      expect(box!.height, `row ${i} must have height (${JSON.stringify(box)})`).toBeGreaterThan(0);
    }

    // Each live button SPEAKS its hardware mapping — the row number a caption
    // cannot carry, and the reason this column is legible without hardware.
    const drop = body.getByTestId('seqtris-face-control-drop');
    await expect(drop).toHaveAttribute('aria-label', 'Scene button 4 — drop');
    await expect(drop, 'the caption is the control name, not the sentence').toHaveText('drop');

    // ⚠ AND THE LANE TILE'S COUNTERPART IS STILL MOUNTED BESIDE IT. The two
    // coexist, which is why they namespace their testids; asserting the tile's
    // well is still there proves the dock locator above resolved the DOCK body
    // rather than accidentally matching one element of two.
    await expect(shellTile(page).getByTestId('seqtris-tile-well')).toBeVisible();
    await expect(body.getByTestId('seqtris-face-well')).toBeVisible();

    expect(realErrors(errors)).toEqual([]);
  });

  test('RULE 8 ON THE PROMOTED SURFACE: a Launchpad bound THROUGH THE FACE plays audibly', async ({ page }) => {
    // ⚠ THE LEG THAT PROVES THE NEW SURFACE CAN ACTUALLY PLAY THE GAME. The
    // boundary-8 chain is re-paid on the surface that now ships: the simulated
    // hardware, the FACE's own CONNECT click, the FACE's own port picker, and
    // then an ON-SCREEN scene press through PIECE → a real DX7 → SCOPE RMS.
    // ⚠ NO CLOCK IS PATCHED, deliberately: the only thing that can move a piece
    // here is a press, so gravity cannot paper over a broken gesture path.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    const g = graph({ clocked: false });
    await spawnPatch(page, g.nodes, g.edges);
    await resumeAudio(page);
    await installLaunchpad(page);
    const body = await openDock(page);

    // ── THE BIND, THROUGH THE FACE'S OWN AFFORDANCES ───────────────────────
    // ⚠ Deliberately NOT a `bindUnit` call from the harness: the gesture, the
    // enumeration and the claim are exactly what this file exists to prove.
    await expect(body.getByTestId('seqtris-face-led')).toHaveAttribute('data-lit', '0');
    await body.getByTestId('seqtris-face-connect').click();

    const port = body.getByTestId('seqtris-face-port-0');
    await port.waitFor({ state: 'visible' });
    await port.click();

    // ⚠ THE UNBIND SWAP IS THE `revision` SEAM'S OWN TEST. `launchpadStatus()`
    // reads a per-binding closure that nothing invalidates; without the shared
    // tick this button never appears, the lamp never lights, and no other gate
    // in the tree would see it.
    await expect(
      body.getByTestId('seqtris-face-unbind'),
      'CONNECT → pick must swap to Unbind — if it does not, the revision tick is missing and the '
        + 'whole binder surface is frozen at its first paint',
    ).toBeVisible();
    await expect(body.getByTestId('seqtris-face-led')).toHaveAttribute('data-lit', '1');
    // …and the LANE TILE's lamp agrees, which is why the tick is page-wide
    // rather than component-local: two surfaces, one hardware claim.
    await expect(
      shellTile(page).getByTestId('seqtris-tile-led'),
      'the tile lamp must not disagree with the dock about one Launchpad',
    ).toHaveAttribute('data-lit', '1');

    const before = await readState(page);
    expect(before.clockPatched, 'nothing is patched into clock').toBe(false);
    expect(before.notesFired, 'nothing has been played yet').toBe(0);

    // ── THE ACT: press a scene button ON SCREEN ────────────────────────────
    // ⚠ LISTEN FIRST, THEN PLAY. A seqtris press is under 300 ms of sound and
    // nothing re-triggers it, so a window opened after the press round-trips
    // measures the release tail rather than the note — the measured failure the
    // sibling file's `listenWhile` header records in full. The sampler runs its
    // loop INSIDE the page and yields between polls, and CDP delivers its call
    // first on the shared session, so it is already looking when the click
    // lands.
    const listening = readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, {
      untilPeak: AUDIBLE_FLOOR,
    });
    try {
      for (const action of ['moveRight', 'moveLeft', 'rotateRight', 'moveRight']) {
        await body.getByTestId(`seqtris-face-control-${action}`).click();
      }
    } catch (err) {
      await listening.catch(() => {});
      throw err;
    }
    const w = await listening;

    const after = await readState(page);
    expect(
      after.notesFired,
      'the ON-SCREEN scene buttons must reach the game core through api().press()',
    ).toBeGreaterThan(0);
    expect(
      w.peak,
      `a press on the FACE must be audible through PIECE → DX7 — the presses DID reach the game `
        + `core (notesFired=${after.notesFired}), so this is the PIECE → DX7 → SCOPE leg never `
        + `carrying the note — ${describeScopeWindow(w)}`,
    ).toBeGreaterThan(AUDIBLE_FLOOR);

    expect(realErrors(errors)).toEqual([]);
  });

  test('SCREEN OFF hides the picture, KEEPS the accessible name, and never stops the game', async ({ page }) => {
    // ⚠ THE ONLY LEG THAT CAN FAIL IF SOMEONE GATES THE MODULE ON THE VIEW, and
    // the whole point of the convention. SCREEN OFF here is safe TWICE over —
    // the game runs on the shared scheduler clock subscribed inside the
    // FACTORY, and `launchpad.paint()` is called from that same factory's
    // `changed()` — so it stops a DOM render and nothing else.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    const g = graph({ clocked: true, gravity: 1 });
    await spawnPatch(page, g.nodes, g.edges);
    await resumeAudio(page);
    await seedKriaGate(page, 'clk');
    const body = await openDock(page);

    const well = body.getByTestId('seqtris-face-well');
    await expect(well).toBeVisible();
    const labelBefore = await well.getAttribute('aria-label');
    expect(labelBefore, 'the well must name itself').toContain('Seqtris well, 8 by 8');
    await expect(body.locator('[data-testid="seqtris-face-grid"]')).toBeVisible();

    // The game is genuinely running before the act, so "it kept running" is not
    // satisfied by a game that never started.
    await expect
      .poll(async () => (await readState(page)).notesFired, {
        timeout: BOOT_MS,
        message: 'the clocked game never fired a note, so this leg could not tell a working '
          + 'SCREEN switch from a module that was already dead',
      })
      .toBeGreaterThan(0);

    // ── THE ACT ────────────────────────────────────────────────────────────
    const toggle = body.getByTestId('seqtris-face-screen-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await expect(
      body.locator('[data-testid="seqtris-face-grid"]'),
      'SCREEN OFF must actually remove the picture, or the switch is decorative',
    ).toHaveCount(0);
    await expect(
      body.locator('[data-testid^="seqtris-face-cell-"]'),
      'the 64 cells go with it — that is the space being reclaimed',
    ).toHaveCount(0);

    // ⚠ THE ACCESSIBLE NAME SURVIVES. The `role="img"` frame renders
    // UNCONDITIONALLY and only the GRID sits inside the collapse guard, so a
    // screen reader still tracks the board with the picture off.
    await expect(well, 'the frame must outlive the picture').toBeAttached();
    await expect(well).toHaveAttribute('role', 'img');
    expect(
      await well.getAttribute('aria-label'),
      'the accessible name must still name the well with SCREEN OFF',
    ).toContain('Seqtris well, 8 by 8');

    // ⚠ ONE FLAG, TWO SURFACES. The lane tile HONOURS `previewCollapsed`
    // without offering the switch, so there is no way for them to disagree.
    await expect(
      shellTile(page).locator('[data-testid="seqtris-tile-grid"]'),
      'the tile must follow the same node.data flag',
    ).toHaveCount(0);

    // ── THE ASSERTION THAT MATTERS: the game did not stop ──────────────────
    const off = await readState(page);
    await expect
      .poll(async () => (await readState(page)).notesFired, {
        timeout: BOOT_MS,
        message: 'notesFired stopped climbing with SCREEN OFF — the view is gating the module, '
          + 'which is the producer-kill defect this convention exists to prevent',
      })
      .toBeGreaterThan(off.notesFired);
    const later = await readState(page);
    expect(
      later.clockPulses,
      `the clock must keep being counted with the screen off (${JSON.stringify(later)})`,
    ).toBeGreaterThan(off.clockPulses);

    // …and it comes back.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(body.locator('[data-testid^="seqtris-face-cell-"]')).toHaveCount(64);

    expect(realErrors(errors)).toEqual([]);
  });

  test('NEGATIVE CONTROL: the identical dock graph, undriven, is silent', async ({ page }) => {
    // ⚠ WITHOUT THIS, LEG 3 IS THE ONLY INSTRUMENT AND NOTHING CHECKS IT. The
    // same graph, the dock open, no clock, no Launchpad, no press — watched for
    // a FULL window with no early exit, because "it never got loud" only means
    // something if we looked.
    const errors = watchPageErrors(page);
    await gotoShell(page);
    const g = graph({ clocked: false });
    await spawnPatch(page, g.nodes, g.edges);
    await resumeAudio(page);
    const body = await openDock(page);
    await expect(body.getByTestId('seqtris-face-well')).toBeVisible();

    const w = await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS);
    expect(
      w.peak,
      `an undriven SEQTRIS must be silent even with its face open — ${describeScopeWindow(w)}`,
    ).toBeLessThan(AUDIBLE_FLOOR);

    const state = await readState(page);
    expect(state.notesFired, 'nothing should have been played').toBe(0);
    // ⚠ AND MOUNTING THE SURFACE MUST NOT PLAY THE GAME. A body that pressed on
    // mount, or an `$effect` that ran a gesture, would show up here and nowhere
    // else.
    expect(state.clockPulses, 'no clock is patched, so nothing should have pulsed').toBe(0);
    expect(state.spawns, 'the opening piece is spawned by createSeqtrisState, not by a surface')
      .toBe(0);

    expect(realErrors(errors)).toEqual([]);
  });
});
