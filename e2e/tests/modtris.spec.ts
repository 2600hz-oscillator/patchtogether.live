// e2e/tests/modtris.spec.ts
//
// MODTRIS module end-to-end (research prototype). Mirrors pong.spec.ts:
//
//   1. The card mounts cleanly + renders its 16-bit canvas.
//   2. The game-loop ticks deterministically — pieces appear + advance
//      under gravity without any inputs.
//   3. A CV/gate source patched into a move/rotate/drop gate input
//      produces visible state evolution (board changes between snapshot
//      samples). We don't try to play a full Tetris from Playwright;
//      smoke + the load-bearing "CV → game-state" path only.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ mode: 'parallel' });

interface ModtrisSnapshot {
  tick: number;
  lines: number;
  wellLength: number;
  hasPiece: boolean;
  pieceRow: number | null;
}

async function readModtrisSnapshot(page: Page, nodeId: string): Promise<ModtrisSnapshot | null> {
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
    const well = snap.well as ArrayLike<number> | undefined;
    const piece = snap.piece as { row?: number } | null | undefined;
    return {
      tick: (snap.tick as number) ?? 0,
      lines: (snap.lines as number) ?? 0,
      wellLength: well ? well.length : 0,
      hasPiece: piece != null,
      pieceRow: piece?.row ?? null,
    };
  }, nodeId);
}

// ⚠ The legacy "card mounts" test folded in the S2 legacy-removal inversion:
// its subject (the module spawns, its screen paints, no console errors) is
// covered on the shipping surface by the FACE describe below (the dock body
// paints a LIVE board + errorWatch). S2 manifest.

test('modtris: game-loop ticks (piece spawns + state evolves)', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'm', type: 'modtris', position: { x: 200, y: 200 } }]);

  // Resume the AudioContext so the analyser taps work. Same flow as PONG's
  // spec — the scheduler-clock ticks regardless, but the analyser taps
  // need the audio context to be running for input edge-detection.
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  // #1523: baseline-then-poll replaces sleep-read-sleep-read. "Has the tick
  // advanced past the baseline?" is answerable at any moment, so the 1.2 s
  // second sleep was only ever a bet that the game loop is faster than that on
  // whatever machine is running — a bet with different odds on every renderer.
  await expect
    .poll(() => readModtrisSnapshot(page, 'm'), {
      timeout: 10_000,
      message: 'modtris snapshot must become readable',
    })
    .not.toBeNull();
  const snap1 = (await readModtrisSnapshot(page, 'm'))!;
  expect(snap1.wellLength).toBe(10 * 20);

  await expect
    .poll(async () => (await readModtrisSnapshot(page, 'm'))?.tick ?? -1, {
      timeout: 10_000,
      message: `the game loop tick never advanced past the baseline (${snap1.tick})`,
    })
    .toBeGreaterThan(snap1.tick);
});

test('modtris: BUGGLES.clock patched into drop_fast produces game-state evolution', async ({ page, rack }) => {
  // BUGGLES.clock is a real gate source (5 ms pulses at ~2 Hz). Patching
  // it into MODTRIS's drop_fast input should produce hard-drop events,
  // which advance the well + tick counter and may produce locks.
  await spawnPatch(
    page,
    [
      { id: 'b', type: 'buggles', position: { x: 100, y: 100 } },
      { id: 'm', type: 'modtris', position: { x: 400, y: 100 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'b', portId: 'clock' }, to: { nodeId: 'm', portId: 'drop_fast' } },
    ],
  );
  await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2000 }).catch(() => { /* */ });

  await expect
    .poll(() => readModtrisSnapshot(page, 'm'), {
      timeout: 10_000,
      message: 'modtris snapshot must become readable',
    })
    .not.toBeNull();
  const initial = (await readModtrisSnapshot(page, 'm'))!;

  // Tick MUST advance (scheduler-clock keeps running regardless). The old form
  // slept 2 s "for BUGGLES.clock to fire several pulses at ~1-2 Hz" — a bet on
  // the arrival time of a stochastic source. Poll the tick instead: the same
  // claim, without the bet.
  await expect
    .poll(async () => (await readModtrisSnapshot(page, 'm'))?.tick ?? -1, {
      timeout: 15_000,
      message: `tick never advanced past the baseline (${initial.tick}) under BUGGLES.clock`,
    })
    .toBeGreaterThan(initial.tick);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FACE, ON THE DEFAULT SHELL.
//
// ⚠ NOTHING IN THIS SUITE HAD EVER OBSERVED MODTRIS UNDER THE SHIPPING SHELL.
// Every test above once drove `?shell=legacy` (the shared `rack` fixture
// flipped to the DEFAULT shell in S2), so the surface a player actually gets was
// unexercised — which is how modtris sat for months rendering a BLANK
// PLACEHOLDER in the lane while its game ran and pulsed gates underneath.
// These legs navigate the DEFAULT shell deliberately.
//
// ⚠ EVERY LEG BELOW CARRIES A `pageerror` GUARD. A shared derivation repaired on
// `ModuleShellPlaceholder` can still throw inside `ModuleShell`, and only
// PROMOTING the module reveals it — a thrown body renders as an empty pane and
// several of these assertions would fail with a locator message that says
// nothing about the cause.
// ─────────────────────────────────────────────────────────────────────────────

/** Read the well signature, the tick and the NEXT queue head, IN THE PAGE.
 *
 *  ⚠ ONE EVALUATE PER SAMPLE PAIR, AND THE FRAME WAIT IS INSIDE IT. Two
 *  Playwright round-trips straddling an rAF window would sample the same main
 *  thread the subject runs on; on a loaded runner that starves both, and "the
 *  game froze" and "we never looked" become indistinguishable from the output.
 *  The accumulator goes in the page and reports what it actually saw. */
async function sampleGameOverFrames(page: Page, nodeId: string, frames: number): Promise<{
  ok: boolean;
  firstTick: number; secondTick: number;
  firstWell: string; secondWell: string;
  firstPiece: string; secondPiece: string;
  firstLevel: number;
  firstNext: string;
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
        tick?: number; lines?: number; level?: number;
        well?: ArrayLike<number>;
        piece?: { kind?: string; rotation?: number; col?: number; row?: number } | null;
        queue?: string[];
      } | undefined;
      if (!s) return null;
      const well = s.well ? Array.from(s.well as ArrayLike<number>).join('') : '';
      const p = s.piece;
      return {
        tick: s.tick ?? -1,
        level: s.level ?? -1,
        well,
        piece: p ? `${p.kind}:${p.rotation}:${p.col}:${p.row}` : 'none',
        next: s.queue?.[0] ?? '—',
      };
    };
    const a = probe();
    if (!a) {
      return { ok: false, firstTick: -1, secondTick: -1, firstWell: '', secondWell: '',
               firstPiece: '', secondPiece: '', firstLevel: -1, firstNext: '', framesWaited: 0 };
    }
    for (let i = 0; i < (n as number); i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const b = probe();
    if (!b) {
      return { ok: false, firstTick: a.tick, secondTick: -1, firstWell: a.well, secondWell: '',
               firstPiece: a.piece, secondPiece: '', firstLevel: a.level, firstNext: a.next,
               framesWaited: n as number };
    }
    return {
      ok: true,
      firstTick: a.tick, secondTick: b.tick,
      firstWell: a.well, secondWell: b.well,
      firstPiece: a.piece, secondPiece: b.piece,
      firstLevel: a.level, firstNext: a.next,
      framesWaited: n as number,
    };
  }, [nodeId, frames] as [string, number]);
}

/** Boot the DEFAULT shell with one modtris, and open its dock faceplate. */
async function openModtrisFace(page: Page, params?: Record<string, number>) {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: 'modtris', position: { x: 200, y: 200 }, params }]);
  await page.locator('button:has-text("Tap to start")').first()
    .click({ timeout: 2000 }).catch(() => { /* already running */ });

  const shell = page.locator('.svelte-flow__node[data-id="m"] [data-testid="module-shell"]');
  await expect(shell, 'the promoted face renders a ModuleShell tile in the lane — before this '
    + 'promotion the shipping shell rendered a BLANK PLACEHOLDER here')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  return faceplate;
}

test('modtris FACE: the dock body paints a LIVE well on the default shell', async ({ page, errorWatch }) => {
  const faceplate = await openModtrisFace(page);

  const body = faceplate.getByTestId('modtris-well-body');
  await expect(body, 'the fullViewBody extension carries the well the legacy card used to own')
    .toBeVisible();
  const canvas = faceplate.getByTestId('modtris-face-canvas');
  await expect(canvas).toBeVisible();

  // The well is DPR-correct: backing store is exactly 2x the CSS box. This is
  // the fix for the card handing the painter the BACKING STORE, which rendered
  // its absolute-sized NEXT / LN / LV strip at half scale.
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
  expect(lit.painted, `well never painted a non-background pixel in ${lit.frames} frames`).toBe(true);

  // ⚠ SAMPLE TWICE ACROSS FRAMES — a still picture and a live one look the same
  // in one sample, and the whole claim of this body is that the game is LIVE.
  const s = await sampleGameOverFrames(page, 'm', 40);
  expect(s.ok, 'the engine snapshot must be readable from the face').toBe(true);
  expect(
    s.secondTick,
    `the game must be running behind the body: tick ${s.firstTick} -> ${s.secondTick} across `
      + `${s.framesWaited} frames`,
  ).toBeGreaterThan(s.firstTick);

  // The a11y name is where the painted LN / LV / NEXT become speakable.
  await expect(faceplate.locator('[role="img"][aria-label^="MODTRIS"]'))
    .toHaveAttribute('aria-label', /\d+ lines, level \d+, next piece \S+, well \d+% full/);

  errorWatch.assertClean();
});

test('modtris FACE: BOTH ranked controls are cells that read the GRAPH, and their values live in aria', async ({ page, errorWatch }) => {
  // Spawned with NON-DEFAULT values on purpose. A cell showing 60 proves nothing
  // — 60 is the def default, so it is what a cell wired to NOTHING would also
  // show. 96 and 4 can only come from the node.
  const faceplate = await openModtrisFace(page, { gravityBpm: 96, levelStep: 4 });

  const drop = faceplate.getByTestId('control-gravityBpm');
  const lvl = faceplate.getByTestId('control-levelStep');
  await expect(drop, 'the face ranks gravityBpm, so it must render exactly one cell').toHaveCount(1);
  await expect(lvl, 'and levelStep, which this PR WIRED — it was inert before').toHaveCount(1);

  // ⚠ THE CELL *IS* THE SLIDER — the testid sits on the `role="slider"` element
  // itself, not on a wrapper around one.
  await expect(drop).toHaveAttribute('role', 'slider');
  await expect(lvl).toHaveAttribute('role', 'slider');

  // ⚠ THE VALUES LIVE IN `aria-valuenow` / `aria-valuetext`, NOT IN A RESTING
  // DECIMAL UNDER THE FADER. That is the whole point of the readout ruling: the
  // data is REMOVED from the plate rather than hidden, and this is where it
  // survives.
  await expect(drop, 'the cell must show the NODE\'s value, not the def default')
    .toHaveAttribute('aria-valuenow', '96');
  await expect(lvl).toHaveAttribute('aria-valuenow', '4');

  // …and the travel comes from the DEF, which is the other half of the card/def
  // agreement this PR bound through `paramSpec`.
  await expect(drop).toHaveAttribute('aria-valuemin', '30');
  await expect(drop).toHaveAttribute('aria-valuemax', '240');
  await expect(lvl).toHaveAttribute('aria-valuemin', '1');
  await expect(lvl).toHaveAttribute('aria-valuemax', '20');

  // NEGATIVE CONTROL on the instrument: DIFFERENT node values must produce
  // DIFFERENT readings, or the assertions above are pinning constants.
  const faceplate2 = await openModtrisFace(page, { gravityBpm: 200, levelStep: 17 });
  await expect(faceplate2.getByTestId('control-gravityBpm')).toHaveAttribute('aria-valuenow', '200');
  await expect(faceplate2.getByTestId('control-levelStep')).toHaveAttribute('aria-valuenow', '17');

  errorWatch.assertClean();
});

test('modtris FACE: SCREEN OFF stops the PICTURE and the game keeps playing', async ({ page, errorWatch }) => {
  // ⚠ THE STRONGEST SINGLE ASSERTION ON THIS SURFACE, and it is here rather than
  // in a comment because `skifree` — one module away in the same family — does
  // NOT have this property, and somebody will copy this body.
  //
  // MODTRIS's game runs on the shared SCHEDULER CLOCK, subscribed inside the
  // module's FACTORY: not in a card, not on rAF, and not gated on the
  // AudioContext (the clock is a Web Worker `setInterval`). So collapsing the
  // preview must stop a `drawModtris` call and NOTHING else — pieces keep
  // falling, lines keep clearing, and LINE / OVERFILL keep firing.
  //
  // ⚠ SPAWNED AT 240 BPM, AND THE WINDOW IS SIZED BY THE THING THAT DRIVES IT.
  // The observable is a PIECE FALLING ONE ROW, and gravity is `60 / bpm` seconds
  // per row — so at the 60 BPM default one row costs a full second and a 40-rAF
  // window (~0.67 s) can legitimately catch none. That is a budget scaled by the
  // wrong quantity, not a flaky product: at 240 BPM a row costs 0.25 s and 120
  // frames (~2 s at 60 Hz, ~6 s at 20 Hz on a loaded runner) carries at least
  // eight drops. The tick assertion below is independent of gravity entirely.
  const faceplate = await openModtrisFace(page, { gravityBpm: 240 });
  await expect(faceplate.getByTestId('modtris-face-canvas')).toBeVisible();

  const toggle = faceplate.getByTestId('modtris-face-screen-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();

  // THE PICTURE IS GONE…
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(
    faceplate.getByTestId('modtris-face-canvas'),
    'SCREEN OFF must reclaim the well\'s space, not merely blank it',
  ).toHaveCount(0);

  // …AND THE ACCESSIBLE NAME IS NOT. The frame is deliberately OUTSIDE the
  // collapse guard, so a screen reader still tracks the game with the picture
  // off. (`FroggerBoardBody` puts it inside, so the same claim in that file's
  // comment is false there — reported, not fixed here.)
  await expect(
    faceplate.locator('[role="img"][aria-label^="MODTRIS"]'),
    'the a11y name must survive SCREEN OFF',
  ).toHaveCount(1);

  // …AND THE GAME IS NOT STOPPED. Measured in the page across a frame window.
  const s = await sampleGameOverFrames(page, 'm', 120);
  expect(s.ok, 'the engine snapshot must be readable with the well collapsed').toBe(true);
  expect(
    s.secondTick,
    `the scheduler must keep stepping the game with SCREEN OFF — tick ${s.firstTick} -> `
      + `${s.secondTick} across ${s.framesWaited} frames. If this is equal, collapsing the `
      + 'preview has stopped the MODULE, which is the #1720/#1721 class.',
  ).toBeGreaterThan(s.firstTick);
  expect(
    s.secondPiece,
    `the piece must keep falling with SCREEN OFF (${s.framesWaited} frames elapsed)`,
  ).not.toBe(s.firstPiece);

  // Turning it back on restores the picture — the toggle is not one-way.
  await toggle.click();
  await expect(faceplate.getByTestId('modtris-face-canvas')).toBeVisible();

  errorWatch.assertClean();
});

test('modtris FACE: the VRT pin really pins — and it negative-controls the sampler above', async ({ page, errorWatch }) => {
  // ⚠ THIS LEG DOES TWO JOBS AND BOTH ARE LOAD-BEARING.
  //
  //  1. IT VALIDATES THE INSTRUMENT. The SCREEN-OFF test above asserts the tick
  //     KEEPS ADVANCING. On its own that is a one-sided reading: a sampler that
  //     could never report "stopped" would pass it forever. Here the SAME
  //     sampler is pointed at a game that genuinely is not ticking, and it must
  //     say so.
  //
  //  2. IT PROVES THE PIN. `__modtrisVrtSeed` + `__modtrisVrtTicks` are what let
  //     this module leave EXEMPT_FROM_VRT, and a DEAD pin is invisible in a
  //     captured image — it produces a perfectly plausible well, a different one
  //     on every boot. `bootWithFace` asserts the globals REACHED the page; this
  //     asserts they had an EFFECT.
  //
  // Installed with `addInitScript`, i.e. BEFORE any navigation, which is how the
  // VRT face harness installs them — so this exercises the construction-time
  // read rather than a second path invented for the test.
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __modtrisVrtSeed?: number; __modtrisVrtTicks?: number };
    g.__modtrisVrtSeed = 0x4d54;
    g.__modtrisVrtTicks = 3200;
  });

  await openModtrisFace(page);

  const pinned = await sampleGameOverFrames(page, 'm', 40);
  expect(pinned.ok, 'the engine snapshot must still be readable under the pin').toBe(true);

  // THE PIN HELD THE WELL — same tick, same stack, same falling piece, across a
  // frame window in which the unpinned game advanced.
  expect(
    pinned.secondTick,
    `the pinned game must NOT advance: tick ${pinned.firstTick} -> ${pinned.secondTick} across `
      + `${pinned.framesWaited} frames. If this grew, the pin is DEAD and every modtris VRT `
      + 'baseline is capturing a different well on every boot.',
  ).toBe(pinned.firstTick);
  expect(pinned.secondWell, 'the pinned stack must not change').toBe(pinned.firstWell);
  expect(pinned.secondPiece, 'the pinned piece must not fall').toBe(pinned.firstPiece);

  // AND IT PINNED TO THE REQUESTED POSITION, not merely to a standstill. A pin
  // that froze at tick 0 would satisfy everything above and would capture the
  // boot frame — which is the frame a stepper that never ran also produces.
  expect(
    pinned.firstTick,
    'the pin must have STEPPED the game to its requested position, not just stopped it',
  ).toBe(3200);
  expect(
    pinned.firstWell.replace(/0/g, ''),
    'the pinned well must carry a real STACK — an empty well is the boot frame',
  ).not.toBe('');

  // …and the well still PAINTS while pinned, or the VRT capture would be a blank
  // canvas that passes for a stable one.
  const canvas = page.getByTestId('dock-full-view').getByTestId('modtris-face-canvas');
  const lit = await canvas.evaluate(async (el: Element) => {
    const c = el as HTMLCanvasElement;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let p = 0; p < d.length; p += 4 * 97) {
        if (d[p]! + d[p + 1]! + d[p + 2]! > 60) return { painted: true, frames: i + 1 };
      }
    }
    return { painted: false, frames: 30 };
  });
  expect(lit.painted, `the pinned well never painted in ${lit.frames} frames`).toBe(true);

  errorWatch.assertClean();
});

test('modtris FACE: the SEED half of the pin is load-bearing — a different seed is a different well', async ({ page }) => {
  // ⚠ THE HALF FROGGER DID NOT NEED, AND THE REASON THIS PIN IS TWO GLOBALS.
  // frogger has no `Math.random` anywhere in its stepper, so a tick count alone
  // made its board a pure function of (ticks, params). modtris has a 7-bag
  // Fisher-Yates shuffle, so the SAME tick count under a DIFFERENT seed must
  // produce a DIFFERENT well — otherwise the seed is decorative and every
  // baseline is pinned by the tick count alone, which would leave the piece
  // sequence free to change per boot.
  async function wellUnderSeed(seed: number): Promise<{ well: string; next: string; piece: string }> {
    await page.addInitScript((s) => {
      const g = globalThis as unknown as { __modtrisVrtSeed?: number; __modtrisVrtTicks?: number };
      g.__modtrisVrtSeed = s as number;
      g.__modtrisVrtTicks = 3200;
    }, seed);
    await openModtrisFace(page);
    const s = await sampleGameOverFrames(page, 'm', 4);
    expect(s.ok, `the snapshot must be readable under seed ${seed}`).toBe(true);
    return { well: s.firstWell, next: s.firstNext, piece: s.firstPiece };
  }

  const a = await wellUnderSeed(0x4d54);
  const b = await wellUnderSeed(0x1234);
  expect(
    `${b.well}|${b.next}|${b.piece}`,
    'two seeds produced an IDENTICAL pinned state at the same tick count — the seed is not '
      + 'reaching the 7-bag, so the VRT baselines are pinned by ticks alone',
  ).not.toBe(`${a.well}|${a.next}|${a.piece}`);
});
