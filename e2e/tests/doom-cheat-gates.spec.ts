// e2e/tests/doom-cheat-gates.spec.ts
//
// LIVE end-to-end coverage for the DOOM IDDQD / IDKFA cheat gate inputs.
//
// Each cheat is a gate input on the DOOM card. A rising edge synthesises the
// 5-character lowercase ASCII keypress sequence ('iddqd' / 'idkfa') into the
// WASM key queue at 50 ms per char (10 ms key-down, 40 ms gap). DOOM's
// `m_cheat.c::cht_CheckCheat` parser sniffs `event_t.data2` on every keydown
// + matches it against the cheat strings; on the 5th char it applies the
// god-mode / all-ammo-and-keys effect to `players[consoleplayer]`.
//
// Skip semantics: requires DOOM WASM + DOOM1.WAD on the dev server (same
// shipping/probing rule as doom-audio-output.spec.ts + doom-controls.spec.ts).
// CI builds both before running e2e; locally a developer who hasn't run the
// WASM build sees the skip rather than a noisy fail.
//
// Out of scope:
//   - the WASM cheat parser itself (vanilla doom behaviour, exhaustively
//     tested by 30 years of speedrun history)
//   - C-side observation of the cheat-flag bit (we deliberately don't add a
//     `dgpt_get_player_cheats` accessor to the C source — the task forbids
//     WASM source edits and there's a parallel agent on the WASM tree).
//     Instead, we verify via `extras.lastCheatInjected()` (the JS oracle
//     that flips the moment the rising edge fires the injection path).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

async function doomWasmPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

async function doomWadPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

/** Boot the DOOM runtime via extras + start a single-player game so the
 *  cheat parser actually has a level loaded + a consoleplayer mobj to flip
 *  the god-mode bit on. Returns true on success, false on any failure. */
async function ensureDoomRunning(page: Page, nodeId: string): Promise<boolean> {
  return await page.evaluate(async (id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return false;
    const node = w.__patch.nodes[id];
    if (!node) return false;
    const extras = eng.read(node, 'extras') as
      | {
          ensureLoaded?: () => Promise<string | null>;
          startNetGame?: (s: unknown, p: number) => void;
        }
      | undefined;
    if (!extras || typeof extras.ensureLoaded !== 'function') return false;
    const err = await extras.ensureLoaded();
    if (err) return false;
    extras.startNetGame?.(
      {
        deathmatch: 0,
        episode: 1,
        map: 1,
        skill: 1,
        nomonsters: 1,
        fastMonsters: 0,
        respawnMonsters: 0,
        numPlayers: 1,
      },
      0,
    );
    return true;
  }, nodeId);
}

/** Drive a single cheat gate input by writing the synthetic param directly via
 *  the dispatcher's setParam path. We avoid wiring a source module just to
 *  pulse a gate: the unit tests already pin the rising-edge detector, and
 *  this test cares about the WASM-side effect — keeping the patch small (one
 *  node) removes a source of flake. Uses the video domain engine's setParam
 *  (id+paramId+value) which the factory ultimately receives. */
async function setCheatParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, p, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { setParam?: (nodeId: string, paramId: string, value: number) => void } | null;
        } | null;
      };
      const ve = w.__engine?.()?.getDomain?.('video');
      if (!ve?.setParam) throw new Error('video engine setParam missing');
      ve.setParam(id, p, v);
    },
    { id: nodeId, p: paramId, v: value },
  );
}

async function pulseCheatGate(page: Page, nodeId: string, cheat: 'iddqd' | 'idkfa'): Promise<void> {
  const paramId = cheat === 'iddqd' ? 'cv_iddqd_in' : 'cv_idkfa_in';
  // Rising edge: 0 → 1. The factory's setParam detects the LOW→HIGH transition
  // + schedules the 5-character injection.
  await setCheatParam(page, nodeId, paramId, 1);
}

async function readLastCheat(page: Page, nodeId: string): Promise<string | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const extras = eng.read(node, 'extras') as
      | { lastCheatInjected?: () => 'iddqd' | 'idkfa' | null }
      | undefined;
    return extras?.lastCheatInjected?.() ?? null;
  }, nodeId);
}

test.describe('DOOM IDDQD / IDKFA cheat gates — rising edge synthesises the 5-char keypress sequence', () => {
  test('rising edge on iddqd_in injects the IDDQD god-mode cheat within ~500ms', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasWasm = await doomWasmPresent(page);
    const hasWad = await doomWadPresent(page);
    test.skip(
      !hasWasm || !hasWad,
      'DOOM WASM and/or DOOM1.WAD not present locally — '
        + 'run `bash packages/web/native/build-doom-wasm.sh` + drop DOOM1.WAD '
        + 'into packages/web/static/doom. CI builds both before e2e.',
    );

    const doomId = 'v-doom-cheat-iddqd';
    await spawnPatch(page, [
      { id: doomId, type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await page.locator('[data-card-type="doom"]').first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // Boot DOOM + start a single-player game so a consoleplayer mobj exists.
    await expect.poll(
      async () => ensureDoomRunning(page, doomId),
      { timeout: 15_000, intervals: [200, 400, 800] },
    ).toBe(true);

    // Precondition: lastCheatInjected starts as null (no rising edge yet).
    expect(await readLastCheat(page, doomId)).toBeNull();

    // Rising edge on iddqd_in.
    await pulseCheatGate(page, doomId, 'iddqd');

    // The injection scheduler posts 5 char-down + 5 char-up setTimeouts;
    // the 5th char-down lands at t=200ms, the 5th char-up at t=210ms. The
    // engine's I_GetEvent drain runs each tic (~28.5ms), so the parser sees
    // all 5 characters within ~250ms of the rising edge. Poll up to 500ms
    // for `lastCheatInjected` to reflect the trigger — it flips the moment
    // the rising edge fires (synchronous with setParam), so this is a
    // structural assertion that the gate path wired correctly.
    await expect.poll(
      async () => readLastCheat(page, doomId),
      {
        timeout: 500,
        intervals: [50, 100, 150],
        message:
          'extras.lastCheatInjected stayed null after a rising edge on iddqd_in — '
          + 'either the factory did not detect cv_iddqd_in, the param did not route '
          + 'through setParam, or the rising-edge detector mis-fired.',
      },
    ).toBe('iddqd');

    // Give the schedule time to drain into the WASM (5 × 50ms = 250ms).
    await page.waitForTimeout(300);

    // Smoke: the runtime must still be alive (the cheat injection path must
    // never crash the WASM — e.g. by writing past the key queue).
    const stillLive = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[id];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { getGameState?: () => number }
        | undefined;
      const gs = extras?.getGameState?.() ?? -1;
      // GS_LEVEL=0, GS_INTERMISSION=1, GS_FINALE=2, GS_DEMOSCREEN=3 — any
      // non-(-1) is "runtime is alive".
      return gs >= 0;
    }, doomId);
    expect(stillLive, 'DOOM runtime crashed after IDDQD injection').toBe(true);
  });

  test('rising edge on idkfa_in injects the IDKFA all-keys-weapons-ammo cheat within ~500ms', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasWasm = await doomWasmPresent(page);
    const hasWad = await doomWadPresent(page);
    test.skip(
      !hasWasm || !hasWad,
      'DOOM WASM and/or DOOM1.WAD not present locally — '
        + 'run `bash packages/web/native/build-doom-wasm.sh` + drop DOOM1.WAD '
        + 'into packages/web/static/doom. CI builds both before e2e.',
    );

    const doomId = 'v-doom-cheat-idkfa';
    await spawnPatch(page, [
      { id: doomId, type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await page.locator('[data-card-type="doom"]').first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    await expect.poll(
      async () => ensureDoomRunning(page, doomId),
      { timeout: 15_000, intervals: [200, 400, 800] },
    ).toBe(true);

    expect(await readLastCheat(page, doomId)).toBeNull();

    await pulseCheatGate(page, doomId, 'idkfa');

    await expect.poll(
      async () => readLastCheat(page, doomId),
      {
        timeout: 500,
        intervals: [50, 100, 150],
        message:
          'extras.lastCheatInjected stayed null after a rising edge on idkfa_in — '
          + 'either the factory did not detect cv_idkfa_in, the param did not route '
          + 'through setParam, or the rising-edge detector mis-fired.',
      },
    ).toBe('idkfa');

    await page.waitForTimeout(300);

    const stillLive = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return false;
      const node = w.__patch.nodes[id];
      if (!node) return false;
      const extras = eng.read(node, 'extras') as
        | { getGameState?: () => number }
        | undefined;
      const gs = extras?.getGameState?.() ?? -1;
      return gs >= 0;
    }, doomId);
    expect(stillLive, 'DOOM runtime crashed after IDKFA injection').toBe(true);
  });

  test('holding the iddqd gate HIGH does NOT re-trigger; lowering + raising re-fires', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // This is a structural test — runs even without WASM (the rising-edge
    // detection is JS-side, no runtime needed). Skip is still appropriate
    // because the test exercises the factory's setParam path the same way
    // the live cheat injection does, and a missing WASM still leaves the
    // factory functional.
    const doomId = 'v-doom-cheat-sticky';
    await spawnPatch(page, [
      { id: doomId, type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);
    await page.locator('[data-card-type="doom"]').first()
      .waitFor({ state: 'visible', timeout: 10_000 });

    // First rising edge: iddqd fires.
    await pulseCheatGate(page, doomId, 'iddqd');
    expect(await readLastCheat(page, doomId)).toBe('iddqd');

    // Drive idkfa next so a re-fire on iddqd (without lowering it first)
    // would visibly OVERWRITE lastCheatInjected back to 'iddqd' — letting
    // us detect any false re-trigger.
    await pulseCheatGate(page, doomId, 'idkfa');
    expect(await readLastCheat(page, doomId)).toBe('idkfa');

    // Re-write `cv_iddqd_in` to 1 multiple times. The detector is sticky
    // on HIGH — these are no-ops.
    for (let i = 0; i < 5; i++) {
      await setCheatParam(page, doomId, 'cv_iddqd_in', 1);
    }
    // lastCheatInjected must still reflect the most recent ACTUAL trigger.
    expect(
      await readLastCheat(page, doomId),
      'held-HIGH iddqd should NOT re-fire — sticky one-shot detector',
    ).toBe('idkfa');

    // Lower then raise → re-fire.
    await setCheatParam(page, doomId, 'cv_iddqd_in', 0);
    await pulseCheatGate(page, doomId, 'iddqd');
    expect(await readLastCheat(page, doomId)).toBe('iddqd');
  });
});
