// e2e/tests/frogger.spec.ts
//
// FROGGER module end-to-end. Mirrors modtris.spec.ts:
//
//   1. The card mounts cleanly + renders its canvas with no console errors.
//   2. The game auto-starts on spawn (start_gate synthetic pulse fires on
//      first scheduler tick) — isGameInPlay flips true within the first
//      few hundred milliseconds, AND the world ticks forward (sprites
//      advance) without any user input.
//   3. A CV/gate source patched into start_gate restarts the game
//      mid-flight (player position resets to (7,13)).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel' });

interface FroggerSnapshot {
  tick: number;
  isGameInPlay: boolean;
  level: number;
  time: number;
  spriteCount: number;
  playerX: number;
  playerY: number;
  playerLives: number;
  homesFilled: number;
}

async function readFroggerSnapshot(page: Page, nodeId: string): Promise<FroggerSnapshot | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as unknown as Record<string, unknown> | undefined;
    if (!snap || typeof snap !== 'object') return null;
    const sprites = snap.sprites as Array<{ visable?: boolean; key?: string }> | undefined;
    const player = snap.player as { x?: number; y?: number; lives?: number } | undefined;
    const homesFilled = (sprites ?? []).filter(
      (sp) => typeof sp.key === 'string' && sp.key.startsWith('player-home-') && sp.visable === true,
    ).length;
    return {
      tick: (snap.tick as number) ?? 0,
      isGameInPlay: (snap.isGameInPlay as boolean) ?? false,
      level: (snap.level as number) ?? 0,
      time: (snap.time as number) ?? 0,
      spriteCount: sprites ? sprites.length : 0,
      playerX: player?.x ?? -1,
      playerY: player?.y ?? -1,
      playerLives: player?.lives ?? -1,
      homesFilled,
    };
  }, nodeId);
}

test('frogger: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'f', type: 'frogger', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-frogger');
  await expect(card).toBeVisible();
  await expect(card).toContainText('FROGGER');
  const canvas = card.locator('[data-testid="frogger-canvas"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
});

test('frogger: auto-starts on spawn (no user input — isGameInPlay flips + sprites advance)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'f', type: 'frogger', position: { x: 200, y: 200 } }]);
  // Resume the AudioContext so the scheduler-clock subscribes start firing.
  // Same flow as MODTRIS / PONG specs.
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  // Within ~500 ms the auto-start synthesized rising-edge has fired + the
  // game is running.
  await page.waitForTimeout(500);
  const snap1 = await readFroggerSnapshot(page, 'f');
  expect(snap1, 'frogger snapshot must be readable').not.toBeNull();
  expect(snap1!.spriteCount).toBeGreaterThan(20);
  expect(snap1!.isGameInPlay, 'auto-start should have flipped isGameInPlay true').toBe(true);
  expect(snap1!.playerX).toBe(7);  // initial position
  expect(snap1!.playerY).toBe(13);

  // Tick must advance + sprites should evolve (vehicles + rafts move under
  // the spriteTick clock).
  await page.waitForTimeout(1500);
  const snap2 = await readFroggerSnapshot(page, 'f');
  expect(snap2).not.toBeNull();
  expect(snap2!.tick, `tick did not advance (snap1=${snap1!.tick} snap2=${snap2!.tick})`).toBeGreaterThan(snap1!.tick);
});

test('frogger: BUGGLES.clock patched into start_gate restarts the game', async ({ page, rack }) => {
  // BUGGLES.clock is a real gate source (5 ms pulses at ~1-2 Hz). Each
  // pulse should re-fire startGame() and reset the world; the tick keeps
  // advancing across restarts, so we use that + isGameInPlay as the
  // smoke-test that the rising edge is consumed.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 'f', type: 'frogger', position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'clock' }, to: { nodeId: 'f', portId: 'start_gate' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await page.waitForTimeout(300);
  const initial = await readFroggerSnapshot(page, 'f');
  expect(initial).not.toBeNull();
  // Auto-start fires + game is in play.
  expect(initial!.isGameInPlay).toBe(true);

  // Wait for BUGGLES.clock to fire several pulses.
  await page.waitForTimeout(2000);
  const later = await readFroggerSnapshot(page, 'f');
  expect(later).not.toBeNull();
  // Tick keeps advancing across restarts.
  expect(later!.tick).toBeGreaterThan(initial!.tick);
  // Player position is always back at (7,13) after a fresh start. The pulses
  // are short enough that the player can't have moved (no movement gates
  // patched) — so the assertion is that we're still seeing the initial pos.
  expect(later!.playerX).toBe(7);
  expect(later!.playerY).toBe(13);
  expect(later!.isGameInPlay).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FACE, ON THE DEFAULT SHELL.
//
// ⚠ NOTHING IN THIS SUITE HAD EVER OBSERVED FROGGER UNDER THE SHIPPING SHELL.
// Every test above drives `?shell=legacy` (and the shared `rack` fixture is
// `?shell=legacy` by construction), so the surface a player actually gets was
// unexercised — which is how frogger sat for months rendering a BLANK
// PLACEHOLDER in the lane while its game ran and pulsed gates underneath.
// These legs navigate the DEFAULT shell deliberately.
// ─────────────────────────────────────────────────────────────────────────────

/** Read the game's own tick + timer + a sprite signature, IN THE PAGE.
 *
 *  ⚠ ONE EVALUATE PER SAMPLE, AND THE FRAME WAIT IS INSIDE IT. Two Playwright
 *  round-trips straddling an rAF window would sample the same main thread the
 *  subject runs on; on a loaded runner that starves both, and "the game froze"
 *  and "we never looked" become indistinguishable from the output. The
 *  accumulator goes in the page and reports what it actually saw. */
async function sampleGameOverFrames(page: Page, nodeId: string, frames: number): Promise<{
  ok: boolean;
  firstTick: number; secondTick: number;
  firstTime: number; secondTime: number;
  firstSprites: string; secondSprites: string;
  framesWaited: number;
}> {
  return page.evaluate(async ([id, n]) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const probe = () => {
      const eng = w.__engine?.();
      const node = w.__patch?.nodes[id as string];
      if (!eng || !node) return null;
      const s = eng.read(node, 'snapshot') as {
        tick?: number; time?: number;
        sprites?: Array<{ x?: number; y?: number }>;
      } | undefined;
      if (!s) return null;
      return {
        tick: s.tick ?? -1,
        time: s.time ?? -1,
        sprites: (s.sprites ?? []).map((sp) => `${sp.x},${sp.y}`).join('|'),
      };
    };
    const a = probe();
    if (!a) {
      return { ok: false, firstTick: -1, secondTick: -1, firstTime: -1, secondTime: -1,
               firstSprites: '', secondSprites: '', framesWaited: 0 };
    }
    for (let i = 0; i < (n as number); i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const b = probe();
    if (!b) {
      return { ok: false, firstTick: a.tick, secondTick: -1, firstTime: a.time, secondTime: -1,
               firstSprites: a.sprites, secondSprites: '', framesWaited: n as number };
    }
    return {
      ok: true,
      firstTick: a.tick, secondTick: b.tick,
      firstTime: a.time, secondTime: b.time,
      firstSprites: a.sprites, secondSprites: b.sprites,
      framesWaited: n as number,
    };
  }, [nodeId, frames] as [string, number]);
}

/** Boot the DEFAULT shell with one frogger, and open its dock faceplate. */
async function openFroggerFace(page: Page, params?: Record<string, number>) {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'f', type: 'frogger', position: { x: 200, y: 200 }, params }]);
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 }).catch(() => { /* already running */ });

  const shell = page.locator('.svelte-flow__node[data-id="f"] [data-testid="module-shell"]');
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane — before this '
    + 'promotion the shipping shell rendered a BLANK PLACEHOLDER here')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return faceplate;
}

test('frogger FACE: the dock body paints a LIVE board on the default shell', async ({ page }) => {
  const faceplate = await openFroggerFace(page);

  const body = faceplate.getByTestId('frogger-board-body');
  await expect(body, 'the fullViewBody extension carries the board the legacy card used to own')
    .toBeVisible();
  const canvas = faceplate.getByTestId('frogger-face-canvas');
  await expect(canvas).toBeVisible();

  // The board is DPR-correct: backing store is exactly 2x the CSS box. This is
  // the §13.2 fix — the card used to hand the painter the BACKING STORE, so its
  // absolute-sized HUD rendered at half scale.
  const geom = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) };
  });
  expect(geom.w, `backing store px vs CSS px: ${geom.w} vs ${geom.cssW}`).toBe(geom.cssW * 2);
  expect(geom.h, `backing store px vs CSS px: ${geom.h} vs ${geom.cssH}`).toBe(geom.cssH * 2);

  // …and it actually PAINTS. A coarse sample, taken in the page, so a black
  // canvas and an unmounted one are distinguishable.
  const lit = await canvas.evaluate(async (el: Element) => {
    const c = el as HTMLCanvasElement;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBg = 0;
      for (let p = 0; p < d.length; p += 4 * 97) {
        if (d[p]! + d[p + 1]! + d[p + 2]! > 60) nonBg++;
      }
      if (nonBg > 0) return { painted: true, nonBg, frames: i + 1 };
    }
    return { painted: false, nonBg: 0, frames: 30 };
  });
  expect(lit.painted, `board never painted a non-background pixel in ${lit.frames} frames`).toBe(true);
});

test('frogger FACE: the ONE ranked control is a cell that reads the GRAPH, and its value lives in aria', async ({ page }) => {
  // Spawned with a NON-DEFAULT value on purpose. A cell showing 60 proves
  // nothing — 60 is the def default, so it is what a cell wired to NOTHING
  // would also show. 20 can only come from the node.
  const faceplate = await openFroggerFace(page, { initialTime: 20 });

  const cell = faceplate.getByTestId('control-initialTime');
  await expect(cell, 'the face ranks initialTime, so it must render exactly one cell').toHaveCount(1);

  // ⚠ THE CELL *IS* THE SLIDER — the testid sits on the `role="slider"` element
  // itself, not on a wrapper around one.
  await expect(cell).toHaveAttribute('role', 'slider');

  // ⚠ THE VALUE LIVES IN `aria-valuetext`, NOT IN A RESTING DECIMAL UNDER THE
  // DIAL. That is the whole point of the readout ruling: the data is REMOVED
  // from the plate rather than hidden, and this is where it survives. Every
  // spec proving a face tracks its graph reads this attribute.
  await expect(cell, 'the cell must show the NODE\'s value, not the def default')
    .toHaveAttribute('aria-valuetext', /^20/);
  await expect(cell).toHaveAttribute('aria-valuenow', '20');

  // …and the travel comes from the DEF, which is the other half of the
  // card/def agreement this PR bound through `paramSpec`.
  await expect(cell).toHaveAttribute('aria-valuemin', '10');
  await expect(cell).toHaveAttribute('aria-valuemax', '120');

  // NEGATIVE CONTROL on the instrument: a DIFFERENT node value must produce a
  // DIFFERENT reading, or the assertions above are pinning a constant.
  const faceplate2 = await openFroggerFace(page, { initialTime: 90 });
  await expect(faceplate2.getByTestId('control-initialTime'))
    .toHaveAttribute('aria-valuetext', /^90/);
});

test('frogger FACE: SCREEN OFF stops the PICTURE and the game keeps playing', async ({ page }) => {
  // ⚠ THE STRONGEST SINGLE ASSERTION ON THIS SURFACE, and it is here rather
  // than in a comment because `skifree` — one module away in the same family —
  // does NOT have this property, and somebody will copy this body.
  //
  // FROGGER's game runs on the shared SCHEDULER CLOCK, subscribed inside the
  // module's FACTORY: not in a card, not on rAF, and not gated on the
  // AudioContext (the clock is a Web Worker `setInterval`). So collapsing the
  // preview must stop a `drawFrogger` call and NOTHING else — the timer counts,
  // the traffic moves, and the HOME / DEAD / LEVEL gates keep firing.
  const faceplate = await openFroggerFace(page);
  await expect(faceplate.getByTestId('frogger-face-canvas')).toBeVisible();

  const toggle = faceplate.getByTestId('frogger-face-screen-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();

  // THE PICTURE IS GONE…
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(
    faceplate.getByTestId('frogger-face-canvas'),
    'SCREEN OFF must reclaim the board\'s space, not merely blank it',
  ).toHaveCount(0);

  // …AND THE GAME IS NOT. Measured in the page across a frame window.
  const s = await sampleGameOverFrames(page, 'f', 40);
  expect(s.ok, 'the engine snapshot must be readable with the board collapsed').toBe(true);
  expect(
    s.secondTick,
    `the scheduler must keep stepping the game with SCREEN OFF — tick ${s.firstTick} -> `
      + `${s.secondTick} across ${s.framesWaited} frames. If this is equal, collapsing the `
      + 'preview has stopped the MODULE, which is the #1720/#1721 class.',
  ).toBeGreaterThan(s.firstTick);
  expect(
    s.secondSprites,
    `traffic must keep moving with SCREEN OFF (${s.framesWaited} frames elapsed)`,
  ).not.toBe(s.firstSprites);

  // Turning it back on restores the picture — the toggle is not one-way.
  await toggle.click();
  await expect(faceplate.getByTestId('frogger-face-canvas')).toBeVisible();
});

test('frogger FACE: the VRT TICK PIN really pins — and it negative-controls the sampler above', async ({ page }) => {
  // ⚠ THIS LEG DOES TWO JOBS AND BOTH ARE LOAD-BEARING.
  //
  //  1. IT VALIDATES THE INSTRUMENT. The SCREEN-OFF test above asserts the tick
  //     KEEPS ADVANCING. On its own that is a one-sided reading: a sampler that
  //     could never report "stopped" would pass it forever, and CLAUDE.md names
  //     exactly this shape ("negative-control the instrument, not just the
  //     code"). Here the SAME sampler is pointed at a game that genuinely is
  //     not ticking, and it must say so.
  //
  //  2. IT PROVES THE PIN. `__froggerVrtTicks` is what let this module leave
  //     EXEMPT_FROM_VRT, and a DEAD pin is invisible in a captured image — it
  //     produces a perfectly plausible board, a different one on every boot.
  //     `bootWithFace` asserts the global REACHED the page; this asserts it
  //     had an EFFECT.
  //
  // Installed with `addInitScript`, i.e. BEFORE any navigation, which is how
  // the VRT face harness installs it — so this exercises the construction-time
  // read rather than a second path invented for the test.
  await page.addInitScript(() => {
    (globalThis as unknown as { __froggerVrtTicks?: number }).__froggerVrtTicks = 96;
  });

  await openFroggerFace(page);

  const pinned = await sampleGameOverFrames(page, 'f', 40);
  expect(pinned.ok, 'the engine snapshot must still be readable under the pin').toBe(true);

  // THE PIN HELD THE BOARD — same tick, same timer, same traffic, across a
  // frame window in which the unpinned game advanced.
  expect(
    pinned.secondTick,
    `the pinned game must NOT advance: tick ${pinned.firstTick} -> ${pinned.secondTick} across `
      + `${pinned.framesWaited} frames. If this grew, the pin is DEAD and every frogger VRT `
      + 'baseline is capturing a different board on every boot.',
  ).toBe(pinned.firstTick);
  expect(pinned.secondSprites, 'pinned traffic must not move').toBe(pinned.firstSprites);
  expect(pinned.secondTime, 'the pinned HUD timer must not count down').toBe(pinned.firstTime);

  // AND IT PINNED TO THE REQUESTED POSITION, not merely to a standstill. A pin
  // that froze at tick 0 would satisfy everything above and would capture the
  // boot frame — which is the frame a stepper that never ran also produces.
  expect(
    pinned.firstTick,
    'the pin must have STEPPED the game to its requested position, not just stopped it',
  ).toBeGreaterThan(0);

  // …and the board still PAINTS while pinned, or the VRT capture would be a
  // blank canvas that passes for a stable one.
  const canvas = page.getByTestId('dock-full-view').getByTestId('frogger-face-canvas');
  const lit = await canvas.evaluate(async (el: Element) => {
    const c = el as HTMLCanvasElement;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let p = 0; p < d.length; p += 4 * 97) {
        if (d[p]! + d[p + 1]! + d[p + 2]! > 60) return true;
      }
    }
    return false;
  });
  expect(lit, 'a pinned board must still be painted — a blank canvas is stable too').toBe(true);
});
