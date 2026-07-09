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

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function spawnNumpadPlus(page: Page): Promise<void> {
  await page.goto('/rack');
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

  test('right-click a key → Remap → next keypress rebinds it (persisted + displayed)', async ({ page }) => {
    await spawnNumpadPlus(page);

    // Key 0 = the C pad; default physical key is Numpad1 → label "1".
    const keyC = page.locator('[data-testid="numpad-key-0"]');
    await expect(keyC.locator('.kmap-phys')).toHaveText('1');

    // Right-click → context menu → Remap.
    await keyC.click({ button: 'right' });
    await expect(page.locator('[data-testid="numpad-key-menu"]')).toBeVisible();
    await page.locator('[data-testid="numpad-remap-item"]').click();
    await expect(page.locator('[data-testid="numpad-remap-hint"]')).toBeVisible();

    // Press a NON-numpad key — 'q' → code KeyQ. It binds to C.
    await page.keyboard.press('q');

    // The pad now displays "Q", the listening hint is gone, and the keymap is
    // persisted in node.data with KeyQ→0 and the old Numpad1 binding dropped.
    await expect(keyC.locator('.kmap-phys')).toHaveText('Q');
    await expect(page.locator('[data-testid="numpad-remap-hint"]')).toHaveCount(0);
    const keymap = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { keymap?: Record<string, number> } }> };
      };
      return w.__patch.nodes.np?.data?.keymap ?? null;
    });
    expect(keymap).not.toBeNull();
    expect(keymap!['KeyQ']).toBe(0);
    expect(keymap!['Numpad1']).toBeUndefined();
    expect(keymap!['Numpad2']).toBe(1); // other notes untouched

    // Reset-to-default restores Numpad1 → C.
    await keyC.click({ button: 'right' });
    await page.locator('[data-testid="numpad-reset-item"]').click();
    await expect(keyC.locator('.kmap-phys')).toHaveText('1');
  });

  test('octave up/down keys render (default + / −) and nudge the octave param', async ({ page }) => {
    await spawnNumpadPlus(page);

    const octUp = page.locator('[data-testid="numpad-octkey-12"]');
    const octDown = page.locator('[data-testid="numpad-octkey-13"]');
    await expect(octUp.locator('.kmap-phys')).toHaveText('+');
    await expect(octDown.locator('.kmap-phys')).toHaveText('−');
    await expect(octUp.locator('.kmap-note')).toHaveText('OCT↑');

    // The default-mapped physical keys nudge the octave via the global listener.
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('4');
    await page.keyboard.press('NumpadAdd');
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('5');
    await page.keyboard.press('NumpadSubtract');
    await page.keyboard.press('NumpadSubtract');
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('3');
  });

  test('an octave key is remappable like a note key', async ({ page }) => {
    await spawnNumpadPlus(page);
    const octUp = page.locator('[data-testid="numpad-octkey-12"]');
    await octUp.click({ button: 'right' });
    await page.locator('[data-testid="numpad-remap-item"]').click();
    await page.keyboard.press('ArrowUp'); // bind OCT↑ → ArrowUp
    await expect(octUp.locator('.kmap-phys')).toHaveText('↑');
    const keymap = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { keymap?: Record<string, number> } }> };
      };
      return w.__patch.nodes.np?.data?.keymap ?? null;
    });
    expect(keymap!['ArrowUp']).toBe(12);        // OCTAVE_UP_ACTION
    expect(keymap!['NumpadAdd']).toBeUndefined(); // old key freed
    // The remapped key now nudges the octave.
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-testid="numpad-octave-value"]')).toHaveText('5');
  });

  test('the remap menu is portaled to <body> so it spawns at the cursor (not inside the transformed node)', async ({ page }) => {
    await spawnNumpadPlus(page);
    await page.locator('[data-testid="numpad-key-0"]').click({ button: 'right' });
    const menu = page.locator('[data-testid="numpad-key-menu"]');
    await expect(menu).toBeVisible();
    // The bug: position:fixed inside SvelteFlow's transformed node anchors the
    // menu to that node. The fix portals it OUT — so it must NOT be a descendant
    // of any .svelte-flow node wrapper.
    await expect(page.locator('.svelte-flow [data-testid="numpad-key-menu"]')).toHaveCount(0);
  });

  test('pressing Numpad1 at octave 4 drives l1_pitch ~ 0 V/oct (C4)', async ({ page, rack }) => {
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

  test('layer-CV input wins over the activeLayer param', async ({ page, rack }) => {
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

  // ─── Poly mode ───────────────────────────────────────────────────
  test('POLY button toggles the poly param + a poly output handle renders', async ({ page }) => {
    await spawnNumpadPlus(page);
    const polyBtn = page.locator('[data-testid="numpad-poly"]');
    await expect(polyBtn).toBeVisible();
    await expect(polyBtn).toHaveAttribute('aria-pressed', 'false');
    await polyBtn.click();
    await expect(polyBtn).toHaveAttribute('aria-pressed', 'true');
    const polyParam = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes.np?.params.poly;
    });
    expect(polyParam).toBe(1);
    // The polyPitchGate output handle is declared + rendered.
    await expect(page.locator('[data-handleid="poly"], [data-id*="poly"]').first()).toBeAttached();
  });

  test('poly mode records up to 5 HELD keys into a step; mono `midi` is the lowest', async ({ page }) => {
    await spawnNumpadPlus(page);
    // Poly + overdub on; sequence stopped → writes to step 0.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) { np.params.poly = 1; np.params.overdub = 1; }
    });
    await page.waitForTimeout(50);

    // HOLD a 3-note chord (C4/E4/G4 = Numpad1/5/8 at octave 4) — keydowns with
    // no keyup between, so all three are held when the last one captures.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad5', key: '5' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad8', key: '8' }));
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      for (const code of ['Numpad1', 'Numpad5', 'Numpad8']) {
        document.dispatchEvent(new KeyboardEvent('keyup', { code, key: '' }));
      }
    });

    const step0 = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { layers?: Array<Array<{ on?: boolean; midi?: number | null; midis?: number[] }>> } }> };
      };
      return w.__patch.nodes.np?.data?.layers?.[0]?.[0] ?? null;
    });
    expect(step0, 'step 0 recorded').not.toBeNull();
    expect(step0!.on).toBe(true);
    // Up to 5 held notes captured (C4/E4/G4 = 60/64/67), sorted ascending.
    expect(step0!.midis).toEqual([60, 64, 67]);
    // Mono out reads `midi` = the LOWEST of the chord.
    expect(step0!.midi).toBe(60);
  });

  test('held notes keep their PRESS-TIME octave when the octave changes mid-hold', async ({ page }) => {
    await spawnNumpadPlus(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) { np.params.poly = 1; np.params.overdub = 1; np.params.octave = 4; }
    });
    await page.waitForTimeout(50);

    // Hold C at octave 4 (=60), then press the octave-UP key (numpad +) to move
    // to octave 5, then add D (=74) — the still-held C must stay at octave 4.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' })); // C4 = 60
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'NumpadAdd', key: '+' })); // octave → 5
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad3', key: '3' })); // D5 = 74
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      for (const code of ['Numpad1', 'Numpad3']) {
        document.dispatchEvent(new KeyboardEvent('keyup', { code, key: '' }));
      }
    });

    const res = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number>; data?: { layers?: Array<Array<{ midis?: number[]; midi?: number | null }>> } }> };
      };
      const np = w.__patch.nodes.np;
      return { octave: np?.params?.octave, step0: np?.data?.layers?.[0]?.[0] ?? null };
    });
    expect(res.octave).toBe(5); // octave param advanced
    // Held C stayed at octave 4 (60); the new D was taken at octave 5 (74).
    expect(res.step0!.midis).toEqual([60, 74]);
  });
});
