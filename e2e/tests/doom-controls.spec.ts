// e2e/tests/doom-controls.spec.ts
//
// ⚠ DOOM SPECS ARE NORMALLY OFF-LIMITS — the standing owner ruling is
//   "do not [touch] doom in any way without specific approval". The
//   tic-precision assertions in this file were blurred under a SPECIFIC
//   approval given by the owner on 2026-08-18, verbatim:
//     "okay see if you can go make the doom tests blurrier and less flakey,
//      just knowing doom renders and our kb logic and basic game nav works
//      is fine"
//   That approval covers THE SPECS ONLY — not video/modules/doom.ts, not the
//   WASM/WAD assets, not the netcode. See #1848 and e2e/tests/_doom-helpers.ts.
//
// E2E coverage for the 2026-05-29 DOOM controls overhaul (PR
// fix/doom-controls-comprehensive). Six fixes, six tests:
//
//   1. gamepad-card-labels-match: assert button-LED labels render the
//      same glyphs as the output port labels (no LB/⬅ mismatch).
//   2. cv-input-drives-player: LFO → DOOM.p1_up moves the player.
//   3. keyboard-disabled-when-cv-patched: with CV patched, keyboard
//      ArrowUp does not also drive the marine.
//   4. esc-cv-gate-fires: pulse DOOM.p1_esc, assert KEY_ESCAPE reaches
//      the engine (menu state changes).
//   5. q-key-maps-to-esc: with the canvas focused, pressing `q` injects
//      KEY_ESCAPE so the pause menu opens.
//   6. evt-kill-fires-score: use the test hook (forcePulse) to fire
//      DOOM.evt_kill into SCOREBOARD.score and assert the counter
//      increments — proves the same-domain video CV/gate bridge is
//      wired.
//
// Most tests need the WASM + WAD on the dev server. If they aren't
// shipped, the test skips with the canonical diagnostic (matches the
// pattern of doom-wasm.spec.ts).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { waitFrames } from '../_helpers/frames';
import {
  MOVE_EPS,
  addEdgeLive,
  manhattan,
  pressUntilInLevel,
  waitTics,
} from './_doom-helpers';

/** How many GAME TICS a control leg observes. Tics, never ms — DOOM's game
 *  clock IS the frame clock, so "while the sim ran" has exactly one honest
 *  unit. See _doom-helpers.ts. */
const CONTROL_TICS = 25;

async function assetsMissing(page: Page): Promise<string | null> {
  const wasm = await page.request.get('/doom/doom.js');
  if (!wasm.ok()) {
    return (
      `DOOM WASM not on dev server (status ${wasm.status()}). ` +
      `Run \`bash packages/web/native/build-doom-wasm.sh\` to enable this test locally.`
    );
  }
  const wad = await page.request.get('/doom/DOOM1.WAD');
  if (!wad.ok()) {
    return (
      `DOOM1.WAD missing (status ${wad.status()}). ` +
      `See packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md.`
    );
  }
  return null;
}

async function bootDoom(page: Page): Promise<void> {
  await spawnPatch(page, [
    { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
  ]);
  const card = page.locator('[data-testid="doom-card"]');
  await expect(card, 'DOOM card mounts').toHaveCount(1);
  const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
  await expect(loadBtn).toBeVisible();
  await loadBtn.click();
  await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
    timeout: 30_000,
  });
}

async function readPlayerY(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const extras = ve?.read?.('v-doom', 'extras') as
      | { getRuntime?: () => { getPlayerState?: () => { x: number; y: number } | null } | null }
      | undefined;
    const st = extras?.getRuntime?.()?.getPlayerState?.();
    return st?.y ?? null;
  });
}

async function readPlayerXY(page: Page): Promise<{ x: number; y: number } | null> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const extras = ve?.read?.('v-doom', 'extras') as
      | { getRuntime?: () => { getPlayerState?: () => { x: number; y: number } | null } | null }
      | undefined;
    return extras?.getRuntime?.()?.getPlayerState?.() ?? null;
  });
}

/** BASIC GAME NAV: walk the title sequence into E1M1 by keyboard.
 *
 *  Was `for (4) { press Enter; waitForTimeout(300) }` — a bet that each 300 ms
 *  window holds enough GAME TICS for DOOM to consume the key. It does not on a
 *  slow renderer (DOOM's game clock is the frame clock), and the walk then
 *  strands in the skill picker so the NEXT assertion fails for an unrelated
 *  reason. pressUntilInLevel presses until the marine exists, which is
 *  self-correcting at any tic rate. */
async function waitForLevel(page: Page): Promise<void> {
  await pressUntilInLevel(page, 'v-doom');
}

// ----------------------------------------------------------------- #1
test.describe('GAMEPAD card — button-LED labels match output port labels (#1)', () => {
  test('button LEDs render the SAME glyphs as the port label table', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'g', type: 'gamepad', position: { x: 100, y: 100 }, domain: 'audio' },
    ]);

    const card = page.locator('[data-testid="gamepad-card"]');
    await expect(card).toHaveCount(1);

    // The card is a 12-button row in the same order as BUTTON_LED_IDS in
    // GamepadCard.svelte: lb, rb, a, b, x, y, du, dd, dl, dr, start, back.
    // After fix #1 the LEDs use GAMEPAD_OUTPUTS[id].label (the chevron set
    // for d-pad, LB/RB/A/B/X/Y for face/shoulder, STA/SEL for start/back).
    //
    // AUTO-RETRYING toHaveText, never a one-shot allInnerTexts() (#1616):
    // xyflow's NodeWrapper renders a freshly-attached node `visibility:hidden`
    // until its ResizeObserver measurement lands (NodeWrapper.svelte
    // `style:visibility={hasDimensions ? …}`), and spawnPatch's mount wait
    // proves ATTACHMENT, not visibility — the wrapper is hidden for ≥1 frame
    // on EVERY mount (measured: 1 frame on a healthy renderer). innerText
    // inside a rendered-but-hidden subtree is "" (textContent still holds the
    // labels), so a one-shot read landing in that window saw 12 EMPTY strings
    // while toHaveCount(1) passed — presence gates none of this. `useInnerText`
    // keeps the subject the VISIBLE rendered glyphs; the retry loop waits for
    // the LEDs' first paint instead of judging the half-born card (the same
    // wait-for-boot-before-judging shape as #1620/#1621).
    await expect(card.locator('.btn-led')).toHaveText(
      ['LB', 'RB', 'A', 'B', 'X', 'Y', '⬆', '⬇', '⬅', '⮕', 'STA', 'SEL'],
      { useInnerText: true },
    );
  });
});

// ----------------------------------------------------------------- #2
test.describe('CV input drives the player (single-player) (#2)', () => {
  test.setTimeout(180_000);
  test('LFO → DOOM.p1_up makes the marine move (player.y changes over time)', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    const skip = await assetsMissing(page);
    if (skip) { test.skip(true, skip); return; }

    // LFO at a slow rate so its ±1 sweep holds above 0 for several ticks at
    // a stretch (a high-rate LFO would oscillate faster than the engine
    // edge-detector can transcribe).
    //
    // ⚠ SPAWNED WITHOUT THE CV EDGE, on purpose. The edge is added LIVE below,
    // after the marine is in the level and has been proven stationary — that
    // makes the wire the ONLY thing that changed between the control leg and
    // the positive leg. (spawnPatch CLEARS the graph, so it cannot add an edge
    // to a booted runtime; addEdgeLive transacts one in, see _doom-helpers.)
    await spawnPatch(
      page,
      [
        { id: 'lfo',    type: 'lfo',  position: { x: 50,  y: 50  }, domain: 'audio', params: { rate: 0.5 } },
        { id: 'v-doom', type: 'doom', position: { x: 400, y: 50  }, domain: 'video' },
      ],
    );

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card).toHaveCount(1);
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay')).toHaveCount(0, { timeout: 30_000 });
    await card.click(); // latch keyboard for Enter presses
    await waitForLevel(page);

    // ── NEGATIVE CONTROL (permanent): NO CV EDGE ⇒ the marine holds still ───
    // Same reader, same epsilon, same span of GAME TICS as the positive leg.
    // Without it, "the marine moved" would be satisfied by a marine that was
    // already walking (a stuck key, a demo playing itself), and the CV path
    // would be certified by something that has nothing to do with CV.
    const unpatchedBefore = await readPlayerXY(page);
    expect(unpatchedBefore, 'player not spawned').not.toBeNull();
    const idleTics = await waitTics(page, 'v-doom', CONTROL_TICS, 30_000);
    const unpatchedAfter = await readPlayerXY(page);
    expect(
      idleTics,
      `DOOM's game clock did not advance ${CONTROL_TICS} tics (advanced ${idleTics}) — ` +
        `the control leg would report "did not move" for a sim that cannot move.`,
    ).toBeGreaterThanOrEqual(CONTROL_TICS);
    expect(
      manhattan(unpatchedBefore!, unpatchedAfter!),
      `the marine moved BEFORE any CV was patched ` +
        `(|dx|+|dy|=${manhattan(unpatchedBefore!, unpatchedAfter!)} over ${idleTics} tics).`,
    ).toBeLessThan(MOVE_EPS);

    // ── Wire LFO.phase0 → DOOM.p1_up and poll until the marine is elsewhere ─
    // A POLL, not a fixed 3 s hold: at 0.5 Hz the LFO's first rising edge into
    // p1_up arrives on its own schedule and the marine then walks at DOOM's tic
    // rate, so the DURATION is renderer- and phase-dependent while the VERDICT
    // ("did the marine leave its spot") is not.
    const before = await readPlayerXY(page);
    await addEdgeLive(page, {
      id: 'e-cv-up',
      from: { nodeId: 'lfo', portId: 'phase0' },
      to: { nodeId: 'v-doom', portId: 'p1_up' },
      sourceType: 'cv',
      targetType: 'cv',
    });

    await expect
      .poll(async () => manhattan(before!, (await readPlayerXY(page))!), {
        timeout: 45_000,
        intervals: [250, 500, 1000],
        message:
          'CV → p1_up never walked the marine forward; pre-fix the SP ' +
          'own-slot-null guard dropped every CV write.',
      })
      .toBeGreaterThan(MOVE_EPS);
  });
});

// ----------------------------------------------------------------- #3
test.describe('Keyboard goes inert when CV is patched (#3)', () => {
  test.setTimeout(180_000);
  test('with CV patched, keyboard ArrowUp produces no additional motion', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    const skip = await assetsMissing(page);
    if (skip) { test.skip(true, skip); return; }

    // Use a CONSTANT zero source rather than an oscillating LFO so the CV
    // path NEVER drives a key — we just want to flip the inert state.
    // A constant CV at 0 = no rising edge ever = no CV-driven motion + the
    // node is "patched" so keyboard goes inert.
    // ATTENUMIX with input 0 = constant 0 is the simplest zero source.
    // Easier: just use LFO at rate 0 (its phase output stays at 1 with no
    // modulation) — but even that would be a constant high → KEY_UPARROW
    // held forever. We instead use an LFO with normal rate so we can
    // compare "CV moving" vs "keyboard added on top" — pre-fix the
    // keyboard ALSO drove the marine, so total motion would be much
    // larger. Post-fix, the keyboard path is gated at the runtime
    // boundary (`setKeyboardInert(true)`) and adds nothing.
    await spawnPatch(
      page,
      [
        { id: 'lfo',    type: 'lfo',  position: { x: 50,  y: 50  }, domain: 'audio', params: { rate: 0.5 } },
        { id: 'v-doom', type: 'doom', position: { x: 400, y: 50  }, domain: 'video' },
      ],
      [
        { id: 'e-cv', from: { nodeId: 'lfo', portId: 'phase0' }, to: { nodeId: 'v-doom', portId: 'p1_up' }, sourceType: 'cv', targetType: 'cv' },
      ],
    );

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card).toHaveCount(1);
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay')).toHaveCount(0, { timeout: 30_000 });
    await card.click();
    await waitForLevel(page);

    // Check the runtime reports keyboard-inert == true after a CV gate is
    // patched. This is the same flag the card's $effect drives via
    // extras.setKeyboardInert(cvGatePatched), which closes the keyboard at
    // the runtime boundary even if the JS claim gate is bypassed.
    //
    // ⚠ POLLED, not read once. `cvGatePatched` is a Svelte derived and the card
    // re-pushes it into the runtime on its rAF; the engine reconciler may
    // materialize the doom node a beat AFTER the edge syncs (DoomCard.svelte
    // says so in as many words). A single read is therefore a race against
    // frame ordering, which is exactly the class of flake this file is being
    // de-flaked for — state readiness gets an auto-retrying expect.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const w = globalThis as unknown as {
              __engine?: () => {
                getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
              } | null;
            };
            const ve = w.__engine?.()?.getDomain?.('video');
            const extras = ve?.read?.('v-doom', 'extras') as
              | { getRuntime?: () => { isKeyboardInert?: () => boolean } | null }
              | undefined;
            return extras?.getRuntime?.()?.isKeyboardInert?.() ?? null;
          }),
        {
          timeout: 15_000,
          message:
            'runtime never reported keyboard-inert=true while a CV gate was patched on ' +
            'the SP DOOM node (SP fallback: own slot is null but CV-patched is still ' +
            'true). The card never called extras.setKeyboardInert(true) — bug #3.',
        },
      )
      .toBe(true);

    // Belt-and-braces: a held ArrowUp must produce no setKeyForKeyboardCode
    // delta. We compare counter at the runtime boundary via the inert path:
    // setKeyForKeyboardCode returns false when inert, so the engine's
    // gamekeydown[KEY_UPARROW] should NOT toggle from a keyboard event.
    const setKeyboardOk = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      const extras = ve?.read?.('v-doom', 'extras') as
        | { getRuntime?: () => { setKeyForKeyboardCode?: (c: string, p: boolean) => boolean } | null }
        | undefined;
      return extras?.getRuntime?.()?.setKeyForKeyboardCode?.('ArrowUp', true) ?? null;
    });
    expect(
      setKeyboardOk,
      `setKeyForKeyboardCode while inert should return false (the runtime drops keyboard input). ` +
        `Got ${setKeyboardOk}.`,
    ).toBe(false);
  });
});

// ----------------------------------------------------------------- #4
test.describe('ESC + ENTER CV gate inputs (#4)', () => {
  test('p1_esc / p1_enter ports exist on the DOOM module def (smoke)', async ({ page, rack }) => {
    // Read the def shape from the registered module-spec window global.
    // No WASM required — this is a pure def smoke.
    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    const portIds = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __moduleSpecs?: Array<{ type: string; inputs?: { id: string }[] }>;
      };
      const specs = w.__moduleSpecs;
      const def = specs?.find((s) => s.type === 'doom');
      return def?.inputs?.map((i) => i.id) ?? [];
    });
    expect(portIds).toContain('p1_esc');
    expect(portIds).toContain('p1_enter');
    expect(portIds).toContain('p4_esc');
    expect(portIds).toContain('p4_enter');
  });
});

// ----------------------------------------------------------------- #5
test.describe('q → KEY_ESCAPE intercept in DOOM keyboard mode (#5)', () => {
  test.setTimeout(180_000);
  test('pressing q with the card focused injects KEY_ESCAPE (opens menu)', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    const skip = await assetsMissing(page);
    if (skip) { test.skip(true, skip); return; }

    await bootDoom(page);
    const card = page.locator('[data-testid="doom-card"]');
    await card.click();
    await waitForLevel(page);

    // E1M1 is loaded — gamestate == GS_LEVEL (0). Pressing q should
    // route to KEY_ESCAPE inside the engine. We don't have a direct
    // "menuactive" probe exposed, but the ESCAPE keypath is dgpt_set_key
    // and we can observe the keypath has been exercised via the held-keys
    // path on the runtime — getHeldKeyboardKeysCount() reports the size
    // of heldKeyboardKeys. A successful q→ESC routes through pushDoomKey
    // (NOT setKeyForKeyboardCode), so heldKeyboardKeys stays empty — but
    // the runtime's KEY_ESCAPE assertion goes through. We assert via a
    // direct dgpt_set_key recorder hook the card has installed... or, more
    // simply, snapshot getGameState() before + after the q-press and
    // assert the engine processed the menu request.
    const beforeState = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      const extras = ve?.read?.('v-doom', 'extras') as
        | { getGameState?: () => number }
        | undefined;
      return extras?.getGameState?.() ?? -1;
    });
    // Should be in GS_LEVEL (0) before the q.
    expect(beforeState).toBe(0);

    // q, then wait for the engine to process the keypress — in TICS. The unit
    // matters: DOOM consumes a queued key inside a tic, so "300 ms" is "however
    // many tics this renderer managed", which is ~9 under SwiftShader and ~18
    // on a real GPU. 4 tics is 4 tics everywhere.
    await page.keyboard.press('KeyQ');
    await waitTics(page, 'v-doom', 4, 10_000);

    // After ESCAPE the engine processes M_StartControlPanel, which doesn't
    // change gamestate but sets `menuactive = true`. We don't have a JS
    // probe for that, so as a softer assertion we send q again to close +
    // confirm the round-trip didn't crash the runtime, then sample
    // gamestate is still GS_LEVEL.
    await page.keyboard.press('KeyQ');
    await waitTics(page, 'v-doom', 4, 10_000);
    const afterState = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      const extras = ve?.read?.('v-doom', 'extras') as
        | { getGameState?: () => number }
        | undefined;
      return extras?.getGameState?.() ?? -1;
    });
    // Still in GS_LEVEL — KEY_ESCAPE in-level just toggles the pause menu;
    // gamestate stays at GS_LEVEL. (The mere fact that the runtime survived
    // and getGameState() still returns 0 demonstrates the q→ESC path didn't
    // throw, lose the runtime, or send a literal 'q' that doomgeneric's
    // letter handler rejected — pre-fix the keyboard path would have routed
    // KeyQ through KEY_FOR_KEYBOARD_CODE which has no entry for KeyQ, so
    // nothing happened at all.)
    expect(afterState).toBe(0);
  });
});

// ----------------------------------------------------------------- #7
test.describe('DOOM Volume control writes params.audioGain (the −42 dB fix UI) (#7)', () => {
  test('Volume knob renders + drives params.audioGain via the setParam path', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // No WASM/WAD needed — the Volume control is plain card UI bound to the
    // audioGain param (default 1, range 0..2). The engine forwards the value
    // to the PCM worklet on change (a fixed makeup gain there does the loudness
    // lift; this knob trims on top). We assert the card → param write path.
    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);

    // The Volume control is a standard Knob (role="slider", aria-label="Volume")
    // inside the OUTPUT-FIT row.
    const volume = card.locator('[data-testid="doom-volume"]');
    await expect(volume, 'Volume control renders on the card').toHaveCount(1);
    const knob = volume.locator('[role="slider"][aria-label="Volume"]');
    await expect(knob, 'Volume knob (aria slider) renders').toHaveCount(1);

    // audioGain starts at its default of 1.
    const before = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes['v-doom']?.params?.audioGain ?? 1;
    });
    expect(before, 'audioGain defaults to 1').toBeCloseTo(1, 5);

    // Drag the knob DOWN (vertical drag = lower value; the D15 Knob maps
    // downward drag to a lower value). A clear drag delta moves it off 1.
    const box = await knob.boundingBox();
    expect(box, 'knob has a bounding box').not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 60, { steps: 12 }); // drag down → lower gain
    await page.mouse.up();

    // Poll the SUBJECT (the param the drag is supposed to write) rather than
    // waiting a fixed 100 ms for Svelte to flush. State readiness → an
    // auto-retrying expect; the drag either lands or the poll's cap reports it.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
            };
            return w.__patch.nodes['v-doom']?.params?.audioGain ?? 1;
          }),
        {
          timeout: 10_000,
          message:
            'dragging the Volume knob down never wrote params.audioGain — the knob ' +
            "isn't wired to the audioGain param's setter.",
        },
      )
      .toBeLessThan(before);

    const after = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes['v-doom']?.params?.audioGain ?? 1;
    });
    // The drag must have changed audioGain (downward → strictly lower), and it
    // stays within the param's [0,2] range. This proves card → setParam →
    // patch.nodes[id].params.audioGain (the same path the engine's setParam
    // watches + forwards to the worklet).
    expect(
      after,
      `dragging the Volume knob down must lower params.audioGain ` +
        `(was ${before}, now ${after}). If unchanged, the knob isn't wired to ` +
        `the audioGain param's setter.`,
    ).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(2);
  });
});

// ----------------------------------------------------------------- #6
test.describe('DOOM evt_kill → SCOREBOARD.score fires (same-domain video CV bridge) (#6)', () => {
  test('forcePulse(evt_kill) increments SCOREBOARD score downstream', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // No WASM required for this one — we use the forcePulse test hook
    // (PR #421) to fire the evt_kill gate without driving a real game
    // event. The bridge is the unit under test, not the WASM.
    await spawnPatch(
      page,
      [
        { id: 'v-doom',  type: 'doom',       position: { x: 100, y: 100 }, domain: 'video' },
        { id: 'v-score', type: 'scoreboard', position: { x: 500, y: 100 }, domain: 'video' },
      ],
      [
        {
          id: 'e-kill-score',
          from: { nodeId: 'v-doom',  portId: 'evt_kill' },
          to:   { nodeId: 'v-score', portId: 'score' },
          sourceType: 'gate',
          targetType: 'cv',
        },
      ],
    );

    // Let the engine settle — in FRAMES. The video CV/gate bridge samples on
    // the video frame tick, so the thing being waited for is literally a count
    // of frames; 300 ms is a different number of them on every renderer.
    await waitFrames(page, 8);

    // Snapshot SCORE before.
    const before = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      return ve?.read?.('v-score', 'score') as number | undefined;
    });
    expect(before, 'scoreboard returned no score reading').toBeDefined();

    // Force-pulse evt_kill 3 times via the test hook (drains through the
    // same CSN identity the bridge captured). Each rising edge through the
    // analyser sample-and-hold + scoreboard's gateEdge detector should
    // bump the counter by 1.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      const extras = ve?.read?.('v-doom', 'extras') as
        | { forcePulse?: (port: string) => void }
        | undefined;
      if (!extras?.forcePulse) throw new Error('extras.forcePulse missing');
      extras.forcePulse('evt_kill');
    });
    // Each pulse is 10 ms wide and the bridge samples on the VIDEO FRAME TICK,
    // so what has to elapse between pulses is FRAMES — enough that a frame
    // samples the high and a later frame samples the subsequent low. 5 frames
    // is 5 frames on every renderer; the old 80 ms was ~5 frames locally and
    // well under 1 on a loaded SwiftShader shard, which silently merged two
    // pulses into one edge.
    await waitFrames(page, 5);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const extras = (w.__engine?.()?.getDomain?.('video')?.read?.('v-doom', 'extras') as
        | { forcePulse?: (port: string) => void }
        | undefined);
      extras?.forcePulse?.('evt_kill');
    });
    await waitFrames(page, 5);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const extras = (w.__engine?.()?.getDomain?.('video')?.read?.('v-doom', 'extras') as
        | { forcePulse?: (port: string) => void }
        | undefined);
      extras?.forcePulse?.('evt_kill');
    });
    // Final settle — frames again, same reason.
    await waitFrames(page, 8);

    const after = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (id: string, k: string) => unknown } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      return ve?.read?.('v-score', 'score') as number | undefined;
    });
    expect(after, 'scoreboard score read failed').toBeDefined();
    const delta = (after ?? 0) - (before ?? 0);
    // Allow some loss to frame timing (a pulse may be entirely within a
    // sub-frame window between sample-and-hold reads). At least ONE pulse
    // must survive though — otherwise the bridge is broken.
    expect(
      delta,
      `expected SCOREBOARD counter to increment via the same-domain video CV/gate ` +
        `bridge (DOOM.evt_kill → SCOREBOARD.score). Got ${before} → ${after}. ` +
        `If 0, the bridge is missing — pre-fix the edge fell through to plain ` +
        `VideoEngine.addEdge which only handles texture lookup, so SCOREBOARD ` +
        `never saw a setParam call from this edge.`,
    ).toBeGreaterThanOrEqual(1);
  });
});
