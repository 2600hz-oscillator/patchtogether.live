// e2e/tests/snes9x-gameplay-gates.spec.ts
//
// DETERMINISTIC gameplay-driven proof that the SNES9X SMW event GATES fire on
// REAL Super Mario World play (not just synthetic RAM, which snes9x's unit
// suite already covers).
//
// What this proves that the unit/synthetic-RAM tests can't:
//   * The documented SMW WRAM addresses ($7E14C8 sprite-status table for
//     KILL, $7E0071 player-anim for DEATH) are CORRECT against the live ROM —
//     a real monster-stomp moves a sprite slot ALIVE($08)->KILLED($02..$06)
//     and a real death drives $7E0071 into $09. If either address were wrong,
//     gate1/gate2 would never pulse here.
//   * The full pipeline: live WRAM -> detectSmwEvents() -> pulseGate() ->
//     gate1/gate2 output, driven by ACTUAL gameplay.
//
// HOW it stays deterministic + ROM-independent:
//   * The input is a COMMITTED, ROM-independent per-frame controller fixture
//     (e2e/fixtures/smw-stomp-death-inputs.json) — run-length-encoded
//     RETRO_DEVICE_ID_JOYPAD bitmasks, NOT a savestate (a savestate would
//     embed ROM-derived data + couple us to a specific ROM dump). The
//     sequence boots SMW -> starts a file -> dismisses the intro -> walks the
//     overworld onto a level tile -> enters the level -> jump-spams a stomp
//     (gate1) -> walks into the enemy swarm to die (gate2).
//   * Frames are advanced via extras.stepFrame(mask) (a test-only handle that
//     runs ONE emulated frame + the real detection/gate path) with the rAF
//     auto-advance disabled, so the engine's timing-variable frame loop can't
//     perturb the scripted sequence. The snes9x2005 core is deterministic, so
//     the kill + death land on fixed frames every run.
//
// ROM-GATED: skips cleanly when /roms/snes9x/game.sfc is absent (CI runs
// without the user-provided, gitignored ROM — same pattern as the snes9x /
// QBERT ROM-gated specs). Locally: `task setup:snes9x ROM=...` +
// `task setup:snes9x:build`.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnPatch } from './_helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(here, '../fixtures/smw-stomp-death-inputs.json');

interface InputFixture {
  game: string;
  totalFrames: number;
  expect: { killByFrame: number; deathByFrame: number; enteredLevelByFrame: number };
  rle: [number, number][];
}

function loadFixture(): InputFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as InputFixture;
}

async function isRomPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      return (await fetch('/roms/snes9x/game.sfc', { method: 'HEAD' })).ok;
    } catch {
      return false;
    }
  });
}

test.describe('SNES9X gameplay gates (ROM-gated): real SMW stomp -> gate1, death -> gate2', () => {
  // Booting + replaying ~3000 emulated frames takes a while; give it room.
  test.setTimeout(180_000);

  test('a deterministic SMW playthrough pulses gate1 (kill) then gate2 (death)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    if (!(await isRomPresent(page))) {
      test.skip(true, 'no /roms/snes9x/game.sfc — run `task setup:snes9x` to enable this spec');
    }

    const fixture = loadFixture();

    await spawnPatch(page, [
      { id: 's', type: 'snes9x', position: { x: 200, y: 200 }, domain: 'video' },
    ]);
    await expect(page.locator('.svelte-flow__node-snes9x')).toBeVisible();

    // Wait for the WASM core + ROM to load.
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node) return false;
        const extras = eng.read(node, 'extras') as { romLoaded?: () => boolean } | undefined;
        return extras?.romLoaded?.() === true;
      },
      's',
      { timeout: 30_000, polling: 200 },
    );

    // Replay the committed input fixture frame-by-frame via extras.stepFrame
    // (rAF auto-advance off → stepFrame is the exclusive frame driver). Record
    // the first frame gate1 / gate2 actually pulse (pulseCount increments) +
    // when the game enters a level (mode $14 with a non-zero translevel).
    const result = await page.evaluate(
      ({ id, rle }) => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: { id: string; type: string; domain: string }, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        const node = w.__patch.nodes[id];
        if (!eng || !node) return { ok: false as const, reason: 'no engine/node' };
        const extras = eng.read(node, 'extras') as
          | {
              setManualStep?: (on: boolean) => void;
              stepFrame?: (mask: number) => number;
              pulseCount?: (port: string) => number;
              readWram?: (addr: number) => number;
            }
          | undefined;
        if (!extras?.stepFrame || !extras.pulseCount || !extras.readWram) {
          return { ok: false as const, reason: 'no stepFrame handle' };
        }
        extras.setManualStep?.(true);

        const gate1Base = extras.pulseCount('gate1');
        const gate2Base = extras.pulseCount('gate2');
        let killFrame = -1;
        let deathFrame = -1;
        let enteredLevelFrame = -1;
        let frame = 0;
        for (const [mask, count] of rle) {
          for (let i = 0; i < count; i++) {
            const mode = extras.stepFrame(mask);
            if (enteredLevelFrame < 0 && mode === 0x14 && extras.readWram(0x13bf) !== 0) {
              enteredLevelFrame = frame;
            }
            if (killFrame < 0 && extras.pulseCount('gate1') > gate1Base) killFrame = frame;
            if (deathFrame < 0 && extras.pulseCount('gate2') > gate2Base) deathFrame = frame;
            frame++;
          }
        }
        return {
          ok: true as const,
          killFrame,
          deathFrame,
          enteredLevelFrame,
          gate1Pulses: extras.pulseCount('gate1') - gate1Base,
          gate2Pulses: extras.pulseCount('gate2') - gate2Base,
          totalFrames: frame,
        };
      },
      { id: 's', rle: fixture.rle },
    );

    expect(result.ok, result.ok ? '' : (result as { reason: string }).reason).toBe(true);
    if (!result.ok) return;

    // Sanity: the sequence actually reached a playable level.
    expect(result.enteredLevelFrame, 'SMW should enter a level during the sequence').toBeGreaterThan(0);

    // ── gate1: a REAL monster stomp pulsed gate1 (KILL). ──
    expect(result.gate1Pulses, 'gate1 (KILL) must pulse on a real SMW stomp').toBeGreaterThanOrEqual(1);
    expect(result.killFrame, 'the kill must occur after entering the level').toBeGreaterThan(result.enteredLevelFrame);

    // ── gate2: a REAL death pulsed gate2 (DEATH). ──
    expect(result.gate2Pulses, 'gate2 (DEATH) must pulse when Mario dies').toBeGreaterThanOrEqual(1);
    expect(result.deathFrame, 'the death must occur after the kill').toBeGreaterThan(result.killFrame);

    // The committed fixture is deterministic against the snes9x2005 core, so
    // the gates land near their recorded frames. Allow a small tolerance in
    // case a future core rebuild shifts timing by a frame or two.
    expect(Math.abs(result.killFrame - fixture.expect.killByFrame)).toBeLessThanOrEqual(30);
    expect(Math.abs(result.deathFrame - fixture.expect.deathByFrame)).toBeLessThanOrEqual(30);
  });
});
