// e2e/tests/numpad-plus.spec.ts
//
// NUMPAD+ ENGINE TRUTH, end to end.
//
// Every test here is about the ENGINE rather than any painted surface: they
// dispatch real document KeyboardEvents and read `__patch` / `__engine` back.
// The panel-driving twins — the step grid, the keymap caps, POLY, the octave
// pair — live in `numpad-plus-face.spec.ts`.
//
// The keypad capture is surface-independent: the `keydown`/`keyup` listener is
// installed by the FACTORY and torn down in `dispose()`, never by a mounted
// surface, which is why nothing about rendering can unplug it.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** The rack, for the tests whose subject is the ENGINE. No faceplate cell is
 *  touched: the module's keyboard capture and its recording path are in the
 *  factory. */
async function spawnNumpadPlusShell(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'np', type: 'numpadPlus', position: { x: 200, y: 200 } }]);
  await expect(
    page.locator('.svelte-flow__node[data-id="np"] [data-testid="module-shell"]'),
    'the promoted module renders its FACE on the default shell, not a placeholder',
  ).toBeVisible();
}

/**
 * The readiness signal for a param written straight into the patch graph: the
 * module's ENGINE NODE exists.
 *
 * ⚠ IT REPLACES A CARD-CLASS READ, and the replacement is stronger rather than
 * merely surface-independent. The old signal watched the card's toggle light,
 * which answers "did Svelte re-render". The question that actually matters is
 * whether the FACTORY can see the write — and it reads `livePatch.nodes[id]
 * .params` directly on every tick and on every keydown, so once the node is
 * materialised the read is synchronous with the write. `activeLayer` is the one
 * engine key that is always a number, so it doubles as "the handle answers".
 */
const engineReady = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const eng = w.__engine?.();
          const np = w.__patch.nodes.np;
          if (!eng || !np) return null;
          const v = eng.read(np, 'activeLayer');
          return typeof v === 'number' ? v : null;
        }),
      { timeout: 10_000, message: 'the NUMPAD+ engine node never materialised' },
    )
    .not.toBeNull();

/** Step 0 of layer 0, as the module has committed it to node.data. */
const readStep0 = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: {
        nodes: Record<
          string,
          { data?: { layers?: Array<Array<{ on?: boolean; midi?: number | null; midis?: number[] }>> } }
        >;
      };
    };
    return w.__patch.nodes.np?.data?.layers?.[0]?.[0] ?? null;
  });

// ═══════════════════════════════════════════════════════════════════════════
// THE ENGINE-TRUTH TESTS — on the DEFAULT SHELL, which is the renderer every
// player actually gets. None of these touches a card or a faceplate cell: they
// dispatch real document KeyboardEvents and read the graph and the engine back.
// ═══════════════════════════════════════════════════════════════════════════
test.describe('NUMPAD+ — the ENGINE, on the default (faceplate) shell', () => {
  test('pressing Numpad1 at octave 4 drives l1_pitch ~ 0 V/oct (C4)', async ({ page, rack }) => {
    await page.goto('/rack?seed=none');
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
    await expect(
      page.locator('.svelte-flow__node[data-id="np"] [data-testid="module-shell"]'),
      'the FACE renders in the lane — no card, and no placeholder tile',
    ).toBeVisible();
    await engineReady(page);

    // Dispatch keydown directly on document — same reason as the
    // OVERDUB test (Playwright's keyboard events route through the
    // focused element + can be lost without an editable focus). The
    // module listens at the document level with capture phase, so it
    // sees these directly.
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' }));
    });

    const pitchSample = () =>
      page.evaluate(() => {
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

    // C4 = MIDI 60 = 0 V/oct. setTargetAtTime smoothing means the sampled value
    // converges exponentially toward 0 — assert it lands well within ±0.1 V/oct
    // (±1.2 semitones). Polling replaces a `waitForTimeout(250)` guess at how
    // long that convergence takes on this machine.
    //
    // A missing snapshot maps to NaN rather than being skipped: the old form
    // read once, and its `if (pitch !== null)` guard meant a scope that had not
    // produced a buffer yet silently asserted NOTHING. NaN fails every
    // comparison, so "the instrument did not look" now keeps polling and then
    // fails loudly instead of passing.
    await expect
      .poll(
        async () => {
          const p = await pitchSample();
          return p === null ? Number.NaN : Math.abs(p);
        },
        {
          timeout: 5_000,
          message: '|l1_pitch| in V/oct should smooth to ~0 for C4 (NaN = no scope buffer read)',
        },
      )
      .toBeLessThan(0.1);

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Numpad1', key: '1' }));
    });
  });

  test('OVERDUB writes the pressed note into the active layer step 0 at start of bar', async ({ page }) => {
    await spawnNumpadPlusShell(page);
    await engineReady(page);

    // Force overdub on directly in the patch graph. The factory re-reads
    // `livePatch.nodes[id].params` on every keydown, so once the engine node
    // exists this write is visible to it synchronously — no rerender to wait on.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) np.params.overdub = 1;
    });

    // Dispatch keydown directly on the document (capture-phase listener
    // sees it regardless of focused element).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad3', key: '3' }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { code: 'Numpad3', key: '3' }));
    });
    // The recorded step IS the subject — wait for it, not for 150 ms.
    await expect
      .poll(async () => (await readStep0(page))?.on ?? false, {
        timeout: 5_000,
        message: 'overdub should write the pressed note into layer 0 / step 0',
      })
      .toBe(true);

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

  test('⚠ RUNNING THE TRANSPORT DOES NOT STARVE THE PAGE — and the tempo is the clock’s', async ({ page }) => {
    // THE DEFECT THIS PINS, which nothing in the fleet had ever exercised
    // because `isPlaying` defaults to 0 and every existing test drove KEYS
    // rather than the transport. `tick()`'s internal-clock branch scheduled
    // into a 200 ms lookahead and "bumped" `nextStepCtxTime` from
    // `stepStartCtxTime`, which `advanceStep` had just re-anchored to NOW — so
    // the bump recomputed the same value and the loop SPUN for 75 ms of wall
    // clock on every ~25 ms scheduler tick.
    //
    // ⚠ THE ASSERTION IS A RATIO, NOT A FRAME RATE. An absolute fps floor is a
    // different number on every renderer (SwiftShader vs a real GPU) and on
    // every runner load, so it would be a different assertion per machine.
    // Running-vs-stopped on the SAME page in the SAME session is
    // renderer-independent by construction, and it is a real POSITIVE control
    // rather than only a negative one: the stopped window proves the instrument
    // can read a healthy page at all.
    //
    // Measured on this branch, both windows, same page: 7.9 fps running against
    // 120.5 stopped BEFORE the fix (a 15x collapse); 120.7 against 120.6 after.
    //
    // ⚠ THE ACCUMULATOR IS INSIDE THE PAGE. A Playwright-side poll would be one
    // round-trip per sample on the same main thread as the subject, so a
    // starved page and a page nobody looked at are indistinguishable from the
    // output.
    await spawnNumpadPlusShell(page);
    await engineReady(page);

    const sample = (running: number) =>
      page.evaluate(async (run) => {
        const w = globalThis as unknown as {
          __engine: () => { read: (n: unknown, k: string) => unknown };
          __patch: { nodes: Record<string, { params: Record<string, number> }> };
        };
        const n = w.__patch.nodes.np!;
        const e = w.__engine();
        n.params.isPlaying = run;
        const t0 = performance.now();
        let frames = 0;
        let advances = 0;
        let prev = e.read(n, 'stepIndex');
        await new Promise<void>((done) => {
          const loop = () => {
            frames += 1;
            const s = e.read(n, 'stepIndex');
            if (s !== prev) { advances += 1; prev = s; }
            if (performance.now() - t0 < 1500) requestAnimationFrame(loop);
            else done();
          };
          requestAnimationFrame(loop);
        });
        const elapsedMs = performance.now() - t0;
        n.params.isPlaying = 0;
        return { frames, advances, elapsedMs, fps: frames / (elapsedMs / 1000), stepsPerSec: advances / (elapsedMs / 1000) };
      }, running);

    const stopped = await sample(0);
    const running = await sample(1);
    const ratio = running.fps / stopped.fps;
    expect(
      ratio,
      `the RUNNING transport must not starve the page. fps running ${running.fps.toFixed(1)} ` +
        `(${running.frames} frames / ${running.elapsedMs.toFixed(0)} ms) vs stopped ` +
        `${stopped.fps.toFixed(1)} (${stopped.frames} frames) — ratio ${ratio.toFixed(3)}. ` +
        'Units: rendered frames per second, measured IN the page. The pre-fix value was 0.066.',
    ).toBeGreaterThan(0.5);
    // The stopped window is the POSITIVE control on the instrument: if it could
    // not read a healthy page, the ratio above would be meaningless.
    expect(stopped.frames, 'the instrument saw a healthy page at all').toBeGreaterThan(20);

    // And the tempo is the AUDIO CLOCK's, not the scheduler tick's. 120 BPM in
    // 16ths is exactly 8 steps/s; before the boundary accumulated, each step was
    // charged its own 125 ms plus however late the ~25 ms tick noticed it, which
    // measured 6.98 steps/s — a systematic 13% slow drift, i.e. 120 BPM playing
    // at about 105. Banded rather than pinned, because a loaded runner can miss
    // a transition the rAF sampler never woke for.
    expect(
      running.stepsPerSec,
      `120 BPM in 16ths is 8 steps/s; observed ${running.stepsPerSec.toFixed(2)} ` +
        `(${running.advances} advances / ${running.elapsedMs.toFixed(0)} ms)`,
    ).toBeGreaterThan(7.0);
  });

  test('layer-CV input wins over the activeLayer param', async ({ page, rack }) => {
    // JOYSTICK pinned to x=0.75 → cv 0.75 → round(0.75*4) = 3 → L4.
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
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

    const activeLayer = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const eng = w.__engine?.();
        const np = w.__patch.nodes.np;
        if (!eng || !np) return -1;
        return eng.read(np, 'activeLayer') as number;
      });

    // The CV tap has to be read by the module before it can win over the param;
    // "has it been read yet" is the question, so ask it repeatedly rather than
    // sleeping 150 ms and asking once.
    await expect
      .poll(activeLayer, {
        timeout: 5_000,
        message: 'layer CV 0.75 → round(0.75×4) = 3 (L4) must win over activeLayer=0',
      })
      .toBe(3);
  });

  test('poly mode records up to 5 HELD keys into a step; mono `midi` is the lowest', async ({ page }) => {
    await spawnNumpadPlusShell(page);
    await engineReady(page);
    // Poly + overdub on; sequence stopped → writes to step 0.
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) { np.params.poly = 1; np.params.overdub = 1; }
    });
    await polyChordBody(page);
  });

  test('held notes keep their PRESS-TIME octave when the octave changes mid-hold', async ({ page }) => {
    await spawnNumpadPlusShell(page);
    await engineReady(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      const np = w.__patch.nodes.np;
      if (np) { np.params.poly = 1; np.params.overdub = 1; np.params.octave = 4; }
    });
    await heldOctaveBody(page);
  });
});

// ── the two POLY-RECORDING bodies, shared by the engine tests above ────────
//
// Extracted rather than duplicated. Their readiness signal is `engineReady`,
// which asks whether the engine NODE exists — the question that actually
// matters, since the factory re-reads `livePatch.nodes[id].params` on every
// keydown. A render-completion signal would only answer "did Svelte repaint".

/** HOLD a 3-note chord and prove all three landed in the step before release. */
async function polyChordBody(page: Page): Promise<void> {
  // C4/E4/G4 = Numpad1/5/8 at octave 4 — keydowns with no keyup between, so all
  // three are held when the last one captures.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad5', key: '5' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad8', key: '8' }));
  });
  // The capture must have LANDED before the keyup, or the chord is released out
  // from under it. "It has landed" is observable — three midis on the step — so
  // wait for that rather than for a duration.
  await expect
    .poll(async () => (await readStep0(page))?.midis?.length ?? 0, {
      timeout: 5_000,
      message: 'all three HELD keys should be captured into the step before release',
    })
    .toBe(3);
  await page.evaluate(() => {
    for (const code of ['Numpad1', 'Numpad5', 'Numpad8']) {
      document.dispatchEvent(new KeyboardEvent('keyup', { code, key: '' }));
    }
  });

  const recorded = await readStep0(page);
  expect(recorded, 'step 0 recorded').not.toBeNull();
  expect(recorded!.on).toBe(true);
  // Up to 5 held notes captured (C4/E4/G4 = 60/64/67), sorted ascending.
  expect(recorded!.midis).toEqual([60, 64, 67]);
  // Mono out reads `midi` = the LOWEST of the chord.
  expect(recorded!.midi).toBe(60);
}

/** A note held across an octave change keeps its PRESS-TIME pitch. */
async function heldOctaveBody(page: Page): Promise<void> {
  // Hold C at octave 4 (=60), then press the octave-UP key (numpad +) to move to
  // octave 5, then add D (=74) — the still-held C must stay at octave 4.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', key: '1' })); // C4 = 60
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'NumpadAdd', key: '+' })); // octave → 5
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad3', key: '3' })); // D5 = 74
  });
  await expect
    .poll(async () => (await readStep0(page))?.midis?.length ?? 0, {
      timeout: 5_000,
      message: 'both held keys should be captured before release',
    })
    .toBe(2);
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
}
