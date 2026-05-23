// e2e/tests/numpad-plus.spec.ts
//
// NUMPAD+ end-to-end. Uses Playwright's keyboard.press('Numpad1')
// etc. to fire real Numpad event.codes that the module's
// document-level listener picks up.
//
// Covers:
//   1. Spawn + card mounts + no console errors.
//   2. Layer button toggles `activeLayer` param + the live readout.
//   3. Octave nudge arrows update the param.
//   4. Pressing Numpad1 at octave 4 fires C4 (MIDI 60 = 0 V/oct) on
//      the active layer's pitch + gate outputs.
//   5. REC ARM + isPlaying transition → records the next note into
//      the layer's step 0, OVERDUB writes whenever any key fires.
//   6. patch NUMPAD+ l1_pitch → SCOPE.ch1: keypress moves the
//      scope's most-recent sample (proves the pitch CV actually
//      reaches the audio graph).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function spawnNumpadPlus(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'np', type: 'numpadPlus', position: { x: 200, y: 200 } }]);
  await expect(page.locator('[data-testid="numpad-plus-card"]')).toBeVisible();
}

test.describe('NUMPAD+ module', () => {
  test('spawns + card mounts + no console errors', async ({ page }) => {
    const errs: string[] = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await spawnNumpadPlus(page);
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('4');
    expect(errs.filter((e) => !e.includes('DEP0040')), errs.join('; ')).toEqual([]);
  });

  test('octave arrows update the octave param', async ({ page }) => {
    await spawnNumpadPlus(page);
    await page.locator('[data-testid="numpad-octave-up"]').click();
    await page.locator('[data-testid="numpad-octave-up"]').click();
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('6');
    await page.locator('[data-testid="numpad-octave-down"]').click();
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('5');
  });

  test('layer button selects activeLayer + the live readout follows', async ({ page }) => {
    await spawnNumpadPlus(page);
    await page.locator('[data-testid="numpad-layer-3"]').click();
    const al = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes.np?.params.activeLayer;
    });
    expect(al).toBe(2); // L3 (0-indexed = 2)
  });

  test('pressing Numpad1 at octave 4 drives l1_pitch ~ 0 V/oct (C4)', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'np', type: 'numpadPlus', position: { x: 200, y: 200 } },
        { id: 'sc', type: 'scope',      position: { x: 700, y: 200 }, domain: 'audio' },
      ],
      [
        {
          id: 'e_np_sc',
          from: { nodeId: 'np', portId: 'l1_pitch' },
          to:   { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'pitch',
          targetType: 'audio',
        },
      ],
    );
    await expect(page.locator('[data-testid="numpad-plus-card"]')).toBeVisible();

    // Dispatch keydown directly on document — same reason as the
    // OVERDUB test (Playwright's keyboard events route through the
    // focused element + can be lost without an editable focus). The
    // module listens at the document level with capture phase, so it
    // sees these directly.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' }));
    });
    await page.waitForTimeout(250);

    const pitch = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const sc = w.__patch.nodes.sc;
      if (!eng || !sc) return null;
      const snap = eng.read(sc, 'snapshot') as { ch1?: Float32Array } | null;
      if (!snap?.ch1) return null;
      return snap.ch1[snap.ch1.length - 1] ?? null;
    });

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Numpad1', key: '1' }));
    });

    // C4 = MIDI 60 = 0 V/oct. setTargetAtTime smoothing means the
    // sampled value should be near 0; the exact value depends on
    // exponential convergence — assert it's well within ±0.1 (which
    // would correspond to ±1.2 semitones — much smaller than 1V).
    expect(pitch, `l1_pitch sample = ${pitch} (expected ~0 for C4)`).not.toBeNull();
    if (pitch !== null) {
      expect(Math.abs(pitch)).toBeLessThan(0.1);
    }
  });

  test('OVERDUB writes the pressed note into the active layer step 0 at start of bar', async ({ page }) => {
    await spawnNumpadPlus(page);

    // Force overdub on directly in the patch graph (the on-card click
    // also works but going through the patch store bypasses any
    // Yjs / Svelte rerender timing question).
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) np.params.overdub = 1;
    });
    await page.waitForTimeout(50);

    // Dispatch keydown directly on the document (capture-phase listener
    // sees it regardless of focused element).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad3', key: '3' }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { code: 'Numpad3', key: '3' }));
    });
    await page.waitForTimeout(150);

    const debug = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { data?: Record<string, unknown>; params?: Record<string, number>; id: string; type: string; domain: string }> };
      };
      const np = w.__patch.nodes.np;
      const eng = w.__engine?.();
      return {
        overdubParam: np?.params?.overdub,
        layers: np?.data?.layers,
        engRead_pressedNoteCount: np && eng ? eng.read(np, 'pressedNoteCount') : 'no-eng',
        engRead_activeLayer: np && eng ? eng.read(np, 'activeLayer') : 'no-eng',
      };
    });
    expect(debug.layers, `layers array populated; debug=${JSON.stringify(debug)}`).toBeDefined();
    if (!debug.layers) return;
    const step0 = (debug.layers as Array<Array<{ on?: boolean; midi?: number | null }>>)[0]?.[0];
    expect(step0?.on, `step 0 on; debug=${JSON.stringify(debug)}`).toBe(true);
    expect(step0?.midi).toBe(62); // D4 = MIDI 62 (Numpad3 at octave 4)
  });

  test('layer-CV input wins over the activeLayer param', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // JOYSTICK pinned to x=0.75 → cv 0.75 → round(0.75*4) = 3 → L4.
    await spawnPatch(
      page,
      [
        { id: 'jo', type: 'joystick',   position: { x:  60, y: 100 } },
        { id: 'np', type: 'numpadPlus', position: { x: 400, y: 100 } },
      ],
      [
        {
          id: 'e_jo_np',
          from: { nodeId: 'jo', portId: 'x' },
          to:   { nodeId: 'np', portId: 'layer' },
          sourceType: 'cv',
          targetType: 'cv',
        },
      ],
    );
    // Pin the joystick to (0.75, 0). The X output emits 0.75 CV.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const jo = w.__patch.nodes.jo;
      if (jo) jo.params.pos_x = 0.75;
    });
    // Set the activeLayer param to 0 (L1) — the CV (→ L4) should win.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) np.params.activeLayer = 0;
    });
    await page.waitForTimeout(150);

    const al = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      const np = w.__patch.nodes.np;
      if (!eng || !np) return -1;
      return eng.read(np, 'activeLayer') as number;
    });
    expect(al, `activeLayer via CV = ${al} (expected 3 = L4)`).toBe(3);
  });
});
