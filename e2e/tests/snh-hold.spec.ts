// e2e/tests/snh-hold.spec.ts
//
// Real-source-chain proof for the baked-in gate-sampled SAMPLE & HOLD on the
// pitch CV of the step sequencers (clipplayer / sequencer / polyseqz / cartesian
// share one mechanism; this spec covers SEQUENCER + CLIPPLAYER per the owner's
// explicit ask).
//
// The chain is the one a user builds — the sequencer's PITCH output → a SCOPE's
// ch1 input. SCOPE.read('ch1_last_sample') is the canonical "live CV at the
// scope input" read (see scope.ts), so polling it over a window shows the ACTUAL
// pitch CV the audio thread emits (NOT the lookahead `pitchVOct` mirror).
//
// A SPARSE pattern (a note then a rest) makes the S&H observable:
//   • S&H ON  → the pitch CV is written only on the GATED step, so between gates
//     it HOLDS the note's V/oct. Polled over many loops, the MIN sample never
//     collapses toward 0 — the note voltage is held across the rest.
//   • S&H OFF → the rest rewrites pitch to 0 (continuous/legacy), so the MIN
//     sample drops toward 0 between gates.
//
// The default is ON (the owner spec), so a freshly-spawned sequencer holds.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, seedKriaGate } from './_helpers';

test.describe.configure({ mode: 'parallel' });

/** Read SCOPE's most-recent ch1 analyser sample (live CV at the input). */
async function readScopeCh1(page: Page, scopeNodeId: string): Promise<number | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (node: { id: string; type: string; domain: string }, key: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return null;
    const v = eng.read(node, 'ch1_last_sample');
    return typeof v === 'number' ? v : null;
  }, scopeNodeId);
}

/** Poll ch1 over a window; return the min + max sample seen + the poll count. */
async function ch1MinMaxOverWindow(
  page: Page,
  scopeNodeId: string,
  windowMs: number,
  pollMs = 40,
): Promise<{ min: number; max: number; polls: number }> {
  const deadline = Date.now() + windowMs;
  let min = Infinity;
  let max = -Infinity;
  let polls = 0;
  while (Date.now() < deadline) {
    const v = await readScopeCh1(page, scopeNodeId);
    if (typeof v === 'number') {
      if (v < min) min = v;
      if (v > max) max = v;
      polls++;
    }
    await page.waitForTimeout(pollMs);
  }
  return { min, max, polls };
}

/**
 * Hold until the gated note's V/oct has ACTUALLY ARRIVED at the SCOPE input.
 *
 * ⚠ THIS IS THE ANCHOR THE MIN-ASSERTIONS BELOW CANNOT LIVE WITHOUT. The
 * pitch port is a poly `ConstantSource` created at `offset.value = 0`
 * (`poly.ts` `createPolySender`), and with S&H ON `emitStep` passes
 * `writePitch: false` on every rest — so the port is NEVER written back to 0
 * once a note has landed. `ch1_last_sample` can therefore read EXACTLY 0.000
 * for one reason and one reason only: no gated step has reached the scope YET.
 *
 * That makes a fixed sleep before the window structurally unsound here. These
 * tests assert a MINIMUM over a window, and a minimum has the opposite failure
 * geometry from a peak — ONE cold sample anywhere in the window kills it, no
 * matter how perfect every other sample is. When the sleep expired before the
 * first gated step (a loaded shard need only delay the graph by one clock
 * division), the window opened on the module's pre-note rest state, `min`
 * came back 0.000, and the assertion reported a COLLAPSED HOLD — a product
 * defect that had not happened. `max` passed in the same window, because the
 * note did arrive, just later than the sleep assumed.
 *
 * Anchoring on the observable costs the same wall clock and is a guarantee
 * instead of a probability: after this returns, 0.000 is unreachable unless
 * S&H genuinely stops holding.
 */
async function waitForNoteEstablished(page: Page, scopeNodeId: string): Promise<void> {
  await expect
    .poll(async () => (await readScopeCh1(page, scopeNodeId)) ?? 0, {
      timeout: 15_000,
      message:
        'the gated note must reach the SCOPE input before a min-over-window opens — ' +
        'ch1 never left 0, so the clock/graph/bridge never delivered a gated step',
    })
    .toBeGreaterThan(NOTE_VOCT - 0.15);
}

/** Set running + bpm on every TIMELORDE (creating one if absent). */
async function setTransport(page: Page, running: number, bpm = 80): Promise<void> {
  await page.evaluate(
    ({ run, b }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
        if (tls.length === 0) {
          w.__patch.nodes['tl-snh-test'] = {
            id: 'tl-snh-test', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
            params: { running: run, bpm: b }, data: {},
          } as never;
        } else {
          for (const n of tls) {
            if (!n.params) n.params = {};
            n.params.running = run;
            n.params.bpm = b;
          }
        }
      });
    },
    { run: running, b: bpm },
  );
}

// MIDI 72 = C5 = +1 octave above C4 → 1.0 V/oct. Distinctly non-zero so a held
// value is unambiguously distinguishable from a 0-reset.
const NOTE_VOCT = (72 - 60) / 12; // 1.0

test.describe('baked-in gate-sampled S&H: SEQUENCER pitch → SCOPE', () => {
  /** Spawn sequencer → scope.ch1, set a sparse 2-step pattern (note, rest). */
  async function setup(page: Page, snh: number): Promise<void> {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        // CARTESIAN carries the surviving snh toggle (kria's S&H is baked
        // in). Slow clock so each pad lasts long enough for the SCOPE's
        // ~42 ms analyser ring to settle on the held DC pitch during a rest.
        { id: 'clk', type: 'kria', position: { x: 80, y: 320 }, params: { bpm: 80, running: 1 } },
        {
          id: 'seq',
          type: 'cartesian',
          position: { x: 80, y: 80 },
          params: { snh },
        },
        {
          id: 'scp',
          type: 'scope',
          position: { x: 520, y: 80 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        { id: 'e_clk', from: { nodeId: 'clk', portId: 'gate1' }, to: { nodeId: 'seq', portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
        // pitch (polyPitchGate) → ch1 (audio): the engine resolves poly→audio as
        // lane-0 pitch, so ch1 sees the pad's root-note V/oct.
        {
          id: 'e_pitch',
          from: { nodeId: 'seq', portId: 'pitch' },
          to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'polyPitchGate',
          targetType: 'audio',
        },
      ],
    );
    // Sparse pattern: pad 5 = C5 note (gate on), every other pad a rest.
    // The clocked walk starts at (0,0) and its FIRST edge lands on (1,1) =
    // pad 5, so the note fires inside the settle window and the S&H hold is
    // established before polling begins; the walk then crosses three rests
    // (10, 15, 0) every loop.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['seq'].data = {
          cells: Array.from({ length: 16 }, (_, i) => (
            i === 5
              ? { on: true, midi: 72, chord: 'mono' } // gated note (first pad visited)
              : { on: false, midi: 72, chord: 'mono' } // rest
          )),
        };
      });
    });
    await seedKriaGate(page, 'clk');
    // Bind the bridge + start sounding. The window may only open once the
    // gated note is OBSERVABLE at the scope — see waitForNoteEstablished.
    await waitForNoteEstablished(page, 'scp');
  }

  test('S&H ON (default): pitch CV HOLDS the note across rests (min never collapses to 0)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page, 1);

    // Poll across several loops (80 BPM 16ths, 4-pad walk → 0.75 s/loop).
    const { min, max, polls } = await ch1MinMaxOverWindow(page, 'scp', 2500);
    expect(polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
    // The note voltage is observed (the gate fired).
    expect(max, `note V/oct ~${NOTE_VOCT} reached`).toBeGreaterThan(NOTE_VOCT - 0.15);
    // S&H ON: between gates the pitch HOLDS — the min never collapses toward 0.
    expect(
      min,
      `S&H ON must HOLD the note across rests — min sample (${min.toFixed(3)}) ` +
        `should stay near ${NOTE_VOCT}, not drop toward 0`,
    ).toBeGreaterThan(NOTE_VOCT - 0.2);
    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  test('S&H OFF: pitch CV is continuous — drops toward 0 on rests', async ({ page }) => {
    await setup(page, 0);
    const { min, max, polls } = await ch1MinMaxOverWindow(page, 'scp', 2500);
    expect(polls).toBeGreaterThan(0);
    // The note voltage is still reached on the gated step.
    expect(max, `note V/oct ~${NOTE_VOCT} reached`).toBeGreaterThan(NOTE_VOCT - 0.15);
    // S&H OFF: the rest rewrites pitch to 0, so the min drops well below the note.
    expect(
      min,
      `S&H OFF must DROP toward 0 on a rest — min sample (${min.toFixed(3)}) ` +
        `should fall well below the note ${NOTE_VOCT}`,
    ).toBeLessThan(NOTE_VOCT - 0.5);
  });

  test('S&H ON holds higher than S&H OFF on the same sparse pattern (the contrast)', async ({ page }) => {
    await setup(page, 1);
    const on = await ch1MinMaxOverWindow(page, 'scp', 2000);
    await setup(page, 0);
    const off = await ch1MinMaxOverWindow(page, 'scp', 2000);
    // The held-min (ON) is clearly above the continuous-min (OFF).
    expect(
      on.min,
      `ON min (${on.min.toFixed(3)}) must exceed OFF min (${off.min.toFixed(3)}) — ` +
        `the held pitch never collapses to the rest's 0`,
    ).toBeGreaterThan(off.min + 0.3);
  });
});

test.describe('baked-in gate-sampled S&H: CLIPPLAYER pitch → SCOPE (8 lanes, one global toggle)', () => {
  /** Spawn clipplayer.pitch1 → scope.ch1 + a sparse clip on lane 0. */
  async function setup(page: Page, snh: number): Promise<void> {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [
        { id: 'cp', type: 'clipplayer', position: { x: 80, y: 80 }, params: { stepDiv: 0, octave: 0, gateLength: 0.4, quantize: 0, snh } },
        { id: 'scp', type: 'scope', position: { x: 560, y: 80 }, domain: 'audio', params: { ch1Range: 1 } },
      ],
      [
        {
          id: 'e_pitch1',
          from: { nodeId: 'cp', portId: 'pitch1' },
          to: { nodeId: 'scp', portId: 'ch1' },
          sourceType: 'polyPitchGate',
          targetType: 'audio',
        },
      ],
    );
    // A sparse clip on lane 0 / slot 0: a C5 note at step 0 only, length 2
    // (step 1 is a rest). Launch it (queued[0] = 0). Slow TIMELORDE so each
    // step holds long enough for the analyser to settle.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        // clip index 0 = lane 0, slot 0.
        w.__patch.nodes['cp'].data = {
          clips: {
            0: {
              kind: 'note',
              steps: [{ step: 0, midi: 72, velocity: 100, lengthSteps: 1 }],
              lengthSteps: 2,
              root: 48,
              loop: true,
            },
          },
          queued: [0, null, null, null, null, null, null, null],
        };
      });
    });
    await setTransport(page, 1, 80);
    // Same anchor as the SEQUENCER block: the clip's lane-0 note must be
    // standing at the scope input before a MIN-over-window may open.
    await waitForNoteEstablished(page, 'scp');
  }

  test('S&H ON (default): lane-0 pitch HOLDS across the clip rest', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await setup(page, 1);
    const { min, max, polls } = await ch1MinMaxOverWindow(page, 'scp', 2500);
    expect(polls).toBeGreaterThan(0);
    expect(max, `note V/oct ~${NOTE_VOCT} reached`).toBeGreaterThan(NOTE_VOCT - 0.15);
    expect(
      min,
      `S&H ON: lane-0 pitch HOLDS across the rest — min (${min.toFixed(3)}) near ${NOTE_VOCT}`,
    ).toBeGreaterThan(NOTE_VOCT - 0.2);
    expect(errors.filter((e) => !e.includes('AudioContext'))).toEqual([]);
  });

  test('S&H OFF: lane-0 pitch resets to 0 on the clip rest', async ({ page }) => {
    await setup(page, 0);
    const { min, max, polls } = await ch1MinMaxOverWindow(page, 'scp', 2500);
    expect(polls).toBeGreaterThan(0);
    expect(max, `note V/oct ~${NOTE_VOCT} reached`).toBeGreaterThan(NOTE_VOCT - 0.15);
    expect(
      min,
      `S&H OFF: the rest resets pitch to 0 — min (${min.toFixed(3)}) well below ${NOTE_VOCT}`,
    ).toBeLessThan(NOTE_VOCT - 0.5);
  });
});
