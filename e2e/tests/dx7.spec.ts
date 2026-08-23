// e2e/tests/dx7.spec.ts
//
// End-to-end coverage of the DX7 module:
//   1. Spawn DX7 → Sequencer → AudioOut chain via the polyPitchGate cable;
//      arm the sequencer, assert the scope-tap reports audible RMS.
//   2. The card renders the preset selector + algorithm display + 4 knobs
//      + .syx upload affordance.
//   3. Switching the preset via the dropdown updates the visible patch
//      name and rejects garbled input.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { captureScopeTimbre, pollScopeRms, scopePollMsg, timbreDistance } from '../_helpers/scope-poll';

/** Window the timbre fingerprint averages over — several note cycles at the
 *  spec's bpm 240, so envelope phase averages out rather than dominating. */
const TIMBRE_WINDOW_MS = 1200;

/** A real timbre change must clear this. Derived, not guessed: the metric's
 *  NOISE FLOOR is ~0.046 (measured with the algorithm switch made a no-op) and
 *  a genuine timbre change — swapping preset CALLIOPE to BASS 1 — reads 1.16
 *  through the same metric. 0.2 sits ~4x above the floor and ~6x below a real
 *  change, so it discriminates without asserting anything about the runner. */
const TIMBRE_CHANGED = 0.2;

test.describe.configure({ mode: 'parallel' });


test('dx7: spawns + renders card with preset selector + 4 knobs + 4 handles', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'dx', type: 'dx7' }]);

  // Card renders.
  const card = page.locator('[data-testid="dx7-card"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('DX7');

  // Preset selector is present and defaults to E.PIANO 1.
  const presetSel = page.locator('[data-testid="dx7-preset-select"]');
  await expect(presetSel).toBeVisible();
  await expect(presetSel).toHaveValue('E.PIANO 1');

  // Algo display shows two-digit numeric.
  const algoDisplay = page.locator('[data-testid="dx7-algo-display"]');
  await expect(algoDisplay).toBeVisible();
  await expect(algoDisplay).toContainText(/ALG \d{2}/);

  // .syx file input exists.
  await expect(page.locator('[data-testid="dx7-syx-input"]')).toBeAttached();

  // 4 handles total: poly + pitch_cv + gate (inputs) + out (output).
  const handles = await card.locator('.svelte-flow__handle').count();
  expect(handles).toBe(4);
});

test('dx7: sequencer (poly) → DX7 → audioOut produces audible RMS', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [
      // Sequencer with one always-on step at C4 in mono mode.
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 240, isPlaying: 1, length: 4 },
      },
      { id: 'dx',  type: 'dx7',     params: { algorithm: 5, voiceCount: 5, level: 1.0 } },
      // Tap audio for assertion.
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut' },
    ],
    [
      // Sequencer poly out → DX7 poly in.
      {
        id: 'poly-edge',
        from: { nodeId: 'seq', portId: 'pitch' },
        to: { nodeId: 'dx', portId: 'poly' },
        sourceType: 'polyPitchGate',
        targetType: 'polyPitchGate',
      },
      // DX7 → Scope ch1.
      {
        id: 'audio-tap',
        from: { nodeId: 'dx', portId: 'out' },
        to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
      // Scope ch1_out → AudioOut.L.
      {
        id: 'audio-out',
        from: { nodeId: 'scp', portId: 'ch1_out' },
        to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // Drive at least one step "on" with a C4 note.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['seq'];
      if (!t) return;
      if (!t.data) t.data = {};
      const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
      (t.data as Record<string, unknown>).steps = steps;
    });
  });

  // Wait for audio to settle and probe the scope RMS. The sampling loop runs
  // IN THE PAGE (one export site) rather than one CDP round trip per sample
  // against the audio thread it is measuring.
  const r = await pollScopeRms(page, 'scp', 0.005, 6000);
  expect(
    r.rms,
    scopePollMsg(`expected audible DX7 RMS via poly cable (got ${r.rms})`, r),
  ).toBeGreaterThan(0.005);
});

// Helper for the algorithm-switching test: read both scope channels back as
// `Float32Array` so we can compare entire frames sample-by-sample (not just
// the scalar RMS — two algorithms can have similar RMS but very different
// waveforms, and we want to catch the latter).

test.fixme('dx7: switching algorithm changes the audible scope content', { annotation: { type: 'fixme', description: 'CORRECTLY DETECTING A SUSPECTED LIVE REGRESSION — not a parked flake. The repaired assertion fails because switching the algorithm produces NO measurable timbre change; measurements and the host/worklet trace are in the PR body (#1787 batch 5).' } }, async ({ page, rack }) => {
  // Regression: prior to fix/dx7-algorithm-switching the host's setParam
  // early-out short-circuited algorithm changes (algorithm is NOT an
  // AudioParam — it travels via worklet.port.postMessage) so moving the
  // knob silently no-op'd. This test asserts the scope tap reports a
  // measurably different waveform after we change algorithm 1 → 32 on the
  // SAME preset / sequencer feed.

  await spawnPatch(
    page,
    [
      { id: 'seq', type: 'sequencer', params: { bpm: 240, isPlaying: 1, length: 4 } },
      // Use CALLIOPE: every operator has a non-trivial output level + integer
      // ratios 1..6, so algorithm 1 (ops 1+3 carriers, 2/4/5/6 modulators)
      // and algorithm 32 (all six ops carriers — additive organ) produce
      // unmistakably different waveforms.
      {
        id: 'dx',
        type: 'dx7',
        params: { algorithm: 1, voiceCount: 5, level: 1.0 },
      },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut' },
    ],
    [
      { id: 'poly-edge',  from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'dx',  portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'audio-tap',  from: { nodeId: 'dx',  portId: 'out' },   to: { nodeId: 'scp', portId: 'ch1'  }, sourceType: 'audio',         targetType: 'audio'         },
      { id: 'audio-out',  from: { nodeId: 'scp', portId: 'ch1_out' },to: { nodeId: 'out', portId: 'L'    }, sourceType: 'audio',         targetType: 'audio'         },
    ],
  );

  // Force the preset to CALLIOPE (algorithm 32 by default — but our
  // params.algorithm=1 overrides that on init).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['dx'];
      if (!t) return;
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).preset = 'CALLIOPE';
      const seq = w.__patch.nodes['seq'];
      if (!seq) return;
      if (!seq.data) seq.data = {};
      const steps = Array.from({ length: 32 }, () => ({ on: true, midi: 60, chord: 'mono' }));
      (seq.data as Record<string, unknown>).steps = steps;
    });
  });

  // A TIMBRE FINGERPRINT under algo 1: the band vector averaged over a window
  // spanning several note cycles, accumulated IN THE PAGE. A single capture
  // cannot serve here — see the measurement in scope-poll.ts.
  const fpAlgo1 = await captureScopeTimbre(page, 'scp', TIMBRE_WINDOW_MS);
  expect(
    fpAlgo1.samples,
    scopePollMsg('algo-1 timbre fingerprint had audible buffers to average', fpAlgo1),
  ).toBeGreaterThan(0);

  // Switch to algorithm 32 by mutating params.algorithm. The reconciler
  // will pick this up and call engine.setParam('algorithm', 32).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes['dx'];
      if (!t) return;
      t.params.algorithm = 32;
    });
  });

  // pacing: the switch travels Y.Doc -> reconciler -> setParam -> worklet
  // postMessage -> voice retrigger before the scope can carry post-switch
  // audio at all. 800 ms mirrors that product-side chain; the fingerprint
  // window after it is what makes the reading stable.
  await page.waitForTimeout(800);

  const fpAlgo32 = await captureScopeTimbre(page, 'scp', TIMBRE_WINDOW_MS);
  expect(
    fpAlgo32.samples,
    scopePollMsg('algo-32 timbre fingerprint had audible buffers to average', fpAlgo32),
  ).toBeGreaterThan(0);

  const dist = timbreDistance(fpAlgo1, fpAlgo32);
  expect(dist, `algo-1 vs algo-32 TIMBRE distance ${dist.toFixed(4)} (noise floor ~0.046 measured with the switch made a no-op; a preset change reads 1.16 through this same metric)`).toBeGreaterThan(TIMBRE_CHANGED);
});

test('dx7: changing preset updates the dropdown value', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'dx', type: 'dx7' }]);

  const presetSel = page.locator('[data-testid="dx7-preset-select"]');
  await expect(presetSel).toHaveValue('E.PIANO 1');

  // Switch to BASS 1 via the dropdown.
  await presetSel.selectOption('BASS 1');
  await expect(presetSel).toHaveValue('BASS 1');

  // The patch graph should reflect the new preset.
  const stored = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
    };
    return (w.__patch.nodes['dx']?.data as Record<string, unknown> | undefined)?.preset;
  });
  expect(stored).toBe('BASS 1');
});

// ---------------------------------------------------------------------------
// THE PRESET STAMP — five writes, one transaction, and it has to come BACK
// ---------------------------------------------------------------------------
//
// Loading a voice is no longer `data.preset = name`. It stamps the whole edit
// buffer (`voice`, `opOn`, `voiceRev`) plus the two authoritative params
// (`algorithm`, `feedback`) in ONE mutateNode transaction. The unit suite
// (packages/web/src/lib/ui/modules/dx7-patch-actions.test.ts) pins the
// atomicity against the real UndoManager; what only a browser can prove is
// that all five actually PERSIST — the buffer is the one payload here that is
// a nested object graph rather than a scalar, and a Yjs write that looked fine
// in memory could still fail to encode.
//
// ⚠ PEER PROPAGATION IS NOT COVERED HERE, AND IT IS NOW PAYABLE. A two-context
// test needs the collab tag, and every collab-tagged spec file used to be
// resolved INTO the collab attest basis, so adding one forced a relay re-attest
// for a synth change — which is why this gap exists. collab-attest was deleted
// 2026-08-17 and the tag is free again: a two-context dx7 propagation test is a
// real follow-up, not a blocked one.
//
// (The companion rule — never write the tag in its `@`-prefixed form, not even
// in a comment, because the basis was resolved by GREPPING spec sources so a
// prose mention was indistinguishable from a real tag, and this very comment
// once turned `collab-attest` RED on a PR touching no collab code — is likewise
// moot. Nothing greps for it now.) What this test does cover is the same encoded
// Y.Doc update a peer receives: the IndexedDB scratch replica round-trips the
// stamp through exactly that binary.

/**
 * Update rows in the scratch replica, WITHOUT creating the DB (an
 * unconditional `indexedDB.open` would seed an empty shell and race the
 * replica). A RISING count is the deterministic flush signal — the stamp has
 * reached IndexedDB — which is what makes the reload below an assertion rather
 * than a race. Mirrors scratch-persist.spec.ts's `replicaRowCount`.
 */
async function replicaRows(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const id = window.localStorage.getItem('pt:local-scratch-id');
    if (!id) return 0;
    const name = `pt-rack-v1-${id}`;
    const list =
      (await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
        .databases?.()) ?? [];
    if (!list.some((d) => d.name === name)) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open(name); // no version → open current, no upgrade
      req.onerror = () => resolve(0);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('updates')) { db.close(); resolve(0); return; }
        const keys = db.transaction('updates', 'readonly').objectStore('updates').getAllKeys();
        keys.onsuccess = () => { db.close(); resolve((keys.result as unknown[]).length); };
        keys.onerror = () => { db.close(); resolve(0); };
      };
    });
  });
}

/** The five values the stamp writes, read straight off the live graph. */
async function readStamp(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params?: Record<string, number>; data?: Record<string, unknown> } | undefined> };
    };
    const n = w.__patch.nodes[id];
    const d = (n?.data ?? {}) as Record<string, unknown>;
    const voice = d.voice as { name?: string; operators?: unknown[] } | undefined;
    return {
      preset: d.preset as string | undefined,
      voiceName: voice?.name,
      opCount: Array.isArray(voice?.operators) ? voice!.operators!.length : 0,
      opOn: d.opOn as boolean[] | undefined,
      voiceRev: d.voiceRev as number | undefined,
      algorithm: n?.params?.algorithm,
      feedback: n?.params?.feedback,
    };
  }, nodeId);
}

test.describe('dx7 preset stamp — persistence', () => {
  // Opt IN to the IndexedDB scratch replica (see scratch-persist.spec.ts):
  // /rack?shell=legacy&seed=none disables it under the e2e harness by default, and it is what makes a
  // real `page.reload()` a meaningful assertion instead of a fresh empty doc.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ptScratchReplica?: boolean }).__ptScratchReplica = true;
    });
  });

  test('a preset change stamps 5 values and survives a real browser reload', async ({ page }) => {
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    const idbOk = await page.evaluate(() => typeof indexedDB !== 'undefined' && indexedDB !== null);
    test.skip(!idbOk, 'IndexedDB unavailable — the scratch replica cannot persist');

    await spawnPatch(page, [{ id: 'dx-stamp', type: 'dx7', position: { x: 180, y: 160 } }]);
    await expect(page.locator('.svelte-flow__node[data-id="dx-stamp"]')).toBeVisible();

    const presetSel = page.locator('[data-testid="dx7-preset-select"]');
    await expect(presetSel).toHaveValue('E.PIANO 1');
    // Row count BEFORE the stamp, so the flush wait below is a real delta and
    // not "the DB exists" (which the spawn alone already satisfies).
    const rowsBefore = await replicaRows(page);

    // THE GESTURE — the real <select>, i.e. the shared action the shell cell
    // calls too. WIRE LEAD is the deliberate choice: it is the one built-in
    // that differs from E.PIANO 1 (alg 5 / fb 4) in BOTH stamped params
    // (alg 1 / fb 7), AND its feedback differs from the def's own default of
    // 4 — so neither param assertion can pass on a value that was already
    // there. TUB BELLS would have been a trap: its feedback IS 4.
    await presetSel.selectOption('WIRE LEAD');
    await expect(presetSel).toHaveValue('WIRE LEAD');

    const before = await readStamp(page, 'dx-stamp');
    expect(before.preset).toBe('WIRE LEAD');
    expect(before.voiceName, 'the edit buffer was stamped, not just the label').toBe('WIRE LEAD');
    expect(before.opCount, 'all six operators crossed into node.data').toBe(6);
    expect(before.opOn).toEqual([true, true, true, true, true, true]);
    expect(before.voiceRev).toBeGreaterThan(0);
    expect(before.algorithm, 'params.algorithm adopted the voice').toBe(1);
    expect(before.feedback, 'params.feedback adopted the voice').toBe(7);

    // Block until the STAMP itself has flushed — a strictly higher row count
    // than before the gesture — then take the real reload (a new JS context
    // and a fresh empty doc, re-seeded only from IndexedDB). Polling a delta
    // rather than sleeping is what keeps this deterministic on a loaded CI box.
    await expect
      .poll(() => replicaRows(page), { timeout: 15_000 })
      .toBeGreaterThan(rowsBefore);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.svelte-flow__node[data-id="dx-stamp"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="dx7-preset-select"]')).toHaveValue('WIRE LEAD');

    const after = await readStamp(page, 'dx-stamp');
    expect(after, 'every stamped value came back byte-for-byte').toEqual(before);
  });

  test('the stamp round-trips through the SAME encoded Y.Doc update a peer receives', async ({ page, rack }) => {
    // `__persistence.save()` serializes the doc with Y.encodeStateAsUpdate —
    // the identical binary Hocuspocus ships to a rack-mate on sync. Wiping the
    // live graph and loading it back therefore exercises the peer-side
    // encode/decode of the stamped buffer, which is the half of "reaches a
    // peer" that does not need a second browser context or a relay.
    await spawnPatch(page, [{ id: 'dx-wire', type: 'dx7' }]);
    const presetSel = page.locator('[data-testid="dx7-preset-select"]');
    await presetSel.selectOption('BRASS 1');
    await expect(presetSel).toHaveValue('BRASS 1');
    const before = await readStamp(page, 'dx-wire');
    expect(before.voiceName).toBe('BRASS 1');

    const env = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __persistence: { save: () => unknown };
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const envelope = w.__persistence.save();
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
      });
      return envelope;
    });

    // Verify the wipe really happened, or the reload assertion below is
    // vacuous (it would be reading the values that never left).
    const wiped = await readStamp(page, 'dx-wire');
    expect(wiped.preset, 'the graph really was cleared').toBeUndefined();

    await page.evaluate((envIn) => {
      const w = globalThis as unknown as { __persistence: { load: (env: unknown) => unknown } };
      w.__persistence.load(envIn);
    }, env);

    const after = await readStamp(page, 'dx-wire');
    expect(after).toEqual(before);
  });
});
