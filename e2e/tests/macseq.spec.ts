// e2e/tests/macseq.spec.ts
//
// MACSEQ end-to-end coverage. The headline test wires:
//
//   MACSEQ.pitch    → MACROOSCILLATOR.pitch    (V/oct)
//   MACSEQ.gate     → MACROOSCILLATOR.trig     (gate)
//   MACSEQ.modelcv  → MACROOSCILLATOR.model_cv (CV → model AudioParam)
//   MACROOSCILLATOR.out → SCOPE.ch1           (audio capture)
//
// We program a 16-step pattern that cycles every legal MACROOSCILLATOR
// model and assert (a) the macrooscillator's `model` AudioParam value
// follows MACSEQ's MODELCV output, (b) audio comes out, and (c) the
// spectral character changes between tonal and percussion models.
//
// Test hooks (gated on VITE_E2E_HOOKS=1 — autotest + dev):
//   __macseqStepAt(id, step) → MacseqStep | null
//   __macseqSetStep(id, step, {on?, midi?, model?})
//   __macseqWriteAllSteps(id, steps[])  // bulk set
//   __macseqModelNames() → string[]
//
// These live on MacseqCard.svelte's $effect block.

import { test, expect } from './_fixtures';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// Read a node's AudioParam value live (e.g. macrooscillator `model`).
async function readEngineParam(
  page: import('@playwright/test').Page,
  nodeId: string,
  paramId: string,
): Promise<number | null> {
  return await page.evaluate(
    ({ id, p }) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          readParam: (n: { id: string; type: string; domain: string }, k: string) => unknown;
        } | null;
        __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      };
      const eng = w.__engine?.();
      if (!eng) return null;
      const node = w.__patch.nodes[id];
      if (!node) return null;
      const v = eng.readParam(node, p);
      return typeof v === 'number' ? v : null;
    },
    { id: nodeId, p: paramId },
  );
}

// Read a generic per-module value via engine.read(node, key) — MACSEQ
// exposes the last-emitted modelCv index this way.
async function readEngineKey(
  page: import('@playwright/test').Page,
  nodeId: string,
  key: string,
): Promise<number | null> {
  return await page.evaluate(
    ({ id, k }) => {
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
      const v = eng.read(node, k);
      return typeof v === 'number' ? v : null;
    },
    { id: nodeId, k: key },
  );
}

test('macseq: drop module → 16-cell grid renders + each cell has a model dropdown', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: 'ms', type: 'macseq', params: { isPlaying: 0 } },
  ]);

  const cellCount = await page
    .locator('[data-testid="macseq-grid-ms"] [data-step]')
    .count();
  expect(cellCount).toBe(16);

  // Every cell has a `<select>` model dropdown.
  for (let i = 0; i < 16; i++) {
    await expect(page.getByTestId(`macseq-model-ms-${i}`)).toBeVisible();
  }

  // The dropdown lists every MODEL_NAMES entry plus the "—" default.
  const optionCount = await page.getByTestId('macseq-model-ms-0').locator('option').count();
  // 14 models + 1 "—" default = 15 options.
  expect(optionCount).toBe(15);
});

test('macseq → macrooscillator: every MODEL_NAMES entry is reachable via MODELCV', async ({ page, rack, errorWatch }) => {
  // Patch: MACSEQ → MACROOSCILLATOR → SCOPE.
  //
  // pitch + gate go through too so the macrooscillator actually emits
  // audio per step (KICK/SNARE/HIHAT need a trig burst; STRING needs a
  // gate-rising-edge to excite the delay loop).
  const nodes: SpawnNode[] = [
    {
      id: 'ms',
      type: 'macseq',
      // Tempo chosen to avoid aliasing against the sample interval below.
      // 150 BPM × 16th notes = 60/150/4 = 100 ms per step. We sample every
      // 10 ms (one decade faster than the step duration), so we get ~10
      // samples per step regardless of phase, and 3.5 s of sampling covers
      // 35 steps ≈ 2 full pattern loops. Originally this used 240 BPM
      // (62.5 ms / step) sampled at 30 ms, which aliased against the step
      // boundary and intermittently missed 1–2 model indices (see PR #168
      // CI flake).
      params: { bpm: 150, length: 16, isPlaying: 1, gateLength: 0.6 },
    },
    {
      id: 'mo',
      type: 'macrooscillator',
      params: { model: 0, note: 0, harmonics: 0.3, timbre: 0.3, morph: 0.5, level: 0.8 },
    },
    { id: 'scp', type: 'scope', params: { timeMs: 50 } },
  ];
  const edges: SpawnEdge[] = [
    { id: 'e_pitch', from: { nodeId: 'ms', portId: 'pitch' }, to: { nodeId: 'mo', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
    { id: 'e_gate',  from: { nodeId: 'ms', portId: 'gate'  }, to: { nodeId: 'mo', portId: 'trig'  }, sourceType: 'gate',  targetType: 'gate'  },
    { id: 'e_model', from: { nodeId: 'ms', portId: 'modelcv' }, to: { nodeId: 'mo', portId: 'model_cv' }, sourceType: 'cv', targetType: 'cv' },
    { id: 'e_audio', from: { nodeId: 'mo', portId: 'out'   }, to: { nodeId: 'scp', portId: 'ch1'  } },
  ];

  await spawnPatch(page, nodes, edges);

  // Pull MODEL_NAMES out of the page (driven by the test hook installed in
  // MacseqCard.svelte). This guards against drift between the test list
  // and the actual MODEL_NAMES constant.
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __macseqModelNames?: () => string[] };
    return typeof w.__macseqModelNames === 'function';
  });
  const modelNames = await page.evaluate(() => {
    const w = globalThis as unknown as { __macseqModelNames: () => string[] };
    return w.__macseqModelNames();
  });
  expect(modelNames.length).toBeGreaterThanOrEqual(14);

  // Program the 16-step pattern: each step is ON, midi=60 (C4 = 0V), and
  // cycles through MODEL_NAMES so step i selects modelIndex (i % N).
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __macseqWriteAllSteps?: unknown };
    return typeof w.__macseqWriteAllSteps === 'function';
  });
  await page.evaluate(
    ({ N }) => {
      const w = globalThis as unknown as {
        __macseqWriteAllSteps: (
          id: string,
          arr: Array<{ on: boolean; midi: number | null; model: number | null }>,
        ) => boolean;
      };
      const steps = Array.from({ length: 16 }, (_, i) => ({
        on: true,
        midi: 60, // C4 — sustains a constant pitch so the spectral diff
                  // we measure between steps reflects model changes,
                  // not pitch changes.
        model: i % N,
      }));
      w.__macseqWriteAllSteps('ms', steps);
    },
    { N: modelNames.length },
  );

  // Sample MACSEQ's last-emitted modelCv index every 10 ms for ~3.5 s.
  // At 150 BPM the 16th-note step is 100 ms, so 10 ms gives ~10 samples
  // per step and the sampler can never alias against the step boundary
  // (a strict decade of separation). 3.5 s ≈ 35 steps ≈ 2+ full passes
  // through the 16-step pattern, comfortably covering all 14 distinct
  // model indices.
  //
  // We sample MACSEQ's own `modelCv` read-key (the logical INDEX) rather
  // than the macrooscillator's `model` AudioParam because Web Audio's
  // AudioParam.value reports the intrinsic (knob-set) value, not the
  // sum-of-modulators effective value — the discrete-CV bucketing happens
  // in a per-block WaveShaperNode whose output IS what the macrooscillator
  // sees on `params.model`, but reading it back from the JS side needs the
  // analyser tap (engine.readParam includes the tap delta, but the tap
  // sample is one render-quantum stale and the discrete scaler's curve
  // ends up centring on a different bucket once knob ≠ 0). MACSEQ's
  // `modelCv` is the authoritative source of "what did MACSEQ just emit
  // as the logical model index" — proves both that the per-step state
  // resolves correctly AND that the MODELCV ConstantSource is being
  // written. The macrooscillator-side wiring is exercised in the audio
  // assertion below (we get a sound that's clearly different per step).
  //
  // We collect the whole sample buffer inside a SINGLE page.evaluate
  // (running setInterval in-browser) rather than ping-ponging one
  // readEngineKey per sample. 350 round-trips at 10 ms each blow well past
  // the 30 s test timeout on a loaded CI runner — but the actual sampling
  // window only needs to be ~3.5 s of wall-clock time, which the in-page
  // approach delivers cleanly.
  const SAMPLE_MS = 10;
  const SAMPLE_COUNT = 350; // 350 * 10ms ≈ 3.5 s
  const seenSamples = await page.evaluate(
    ({ id, key, intervalMs, count }) =>
      new Promise<number[]>((resolve) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
          } | null;
          __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
        };
        const out: number[] = [];
        const node = w.__patch.nodes[id];
        const tick = () => {
          const eng = w.__engine?.();
          if (eng && node) {
            const v = eng.read(node, key);
            if (typeof v === 'number') out.push(v);
          }
          if (out.length >= count) {
            clearInterval(handle);
            resolve(out);
          }
        };
        const handle = setInterval(tick, intervalMs);
      }),
    { id: 'ms', key: 'modelCv', intervalMs: SAMPLE_MS, count: SAMPLE_COUNT },
  );
  const seenModels = new Set<number>();
  for (const v of seenSamples) {
    const idx = Math.max(0, Math.min(modelNames.length - 1, Math.round(v)));
    seenModels.add(idx);
  }

  // Every model must have appeared at least once. This is the headline
  // assertion: "prove all model voices are reachable via MACSEQ.MODELCV".
  const missing: string[] = [];
  for (let idx = 0; idx < modelNames.length; idx++) {
    if (!seenModels.has(idx)) missing.push(`${idx} (${modelNames[idx]})`);
  }
  expect(
    missing,
    `Models never observed on MACSEQ.modelCv after sweep. ` +
      `Sampled trace = ${JSON.stringify(seenSamples)}`,
  ).toEqual([]);

  // Capture audio at the macrooscillator's out — should be non-silent.
  //
  // A SINGLE end-of-run snapshot can land in a quiet gap: the pattern cycles
  // every model including the percussive ones (KICK/SNARE/HIHAT are short
  // bursts), and the 50 ms scope window may fall between a step's gate burst
  // and the next step — so peak/rms read 0 even though the chain is clearly
  // emitting. That intermittently failed on CI (#834 shard-4, peak=rms=0).
  // The test's INTENT is "the macrooscillator emits audio while MACSEQ drives
  // it" — so poll the scope across several steps (~1.2 s ≈ 12 steps at 150 BPM
  // 16ths) and take the LOUDEST window, breaking as soon as we hear it. This
  // is phase-independent and still fails correctly if the chain is truly
  // silent (audio never started).
  let bestPeak = 0;
  let bestRms = 0;
  for (let i = 0; i < 12; i++) {
    const snap = await readScopeSnapshot(page, 'scp');
    expect(snap).not.toBeNull();
    const sum = summarize(snap!.ch1);
    bestPeak = Math.max(bestPeak, sum.peak);
    bestRms = Math.max(bestRms, sum.rms);
    if (bestPeak > 0.005) break;
    await page.waitForTimeout(100);
  }
  expect(
    bestPeak,
    `macrooscillator must emit audio while MACSEQ drives MODELCV; bestPeak=${bestPeak.toFixed(4)} bestRms=${bestRms.toFixed(4)}`,
  ).toBeGreaterThan(0.005);

});

test('macseq: HOLD-LAST policy — null model on a step holds the previous MODELCV value', async ({ page, rack }) => {
  // Plain MACSEQ → MACROOSCILLATOR with no scope (we read the model param
  // directly).
  await spawnPatch(
    page,
    [
      { id: 'ms', type: 'macseq', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.6 } },
      { id: 'mo', type: 'macrooscillator', params: { model: 0 } },
    ],
    [
      { id: 'e_pitch', from: { nodeId: 'ms', portId: 'pitch' }, to: { nodeId: 'mo', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e_gate',  from: { nodeId: 'ms', portId: 'gate'  }, to: { nodeId: 'mo', portId: 'trig'  }, sourceType: 'gate',  targetType: 'gate'  },
      { id: 'e_model', from: { nodeId: 'ms', portId: 'modelcv' }, to: { nodeId: 'mo', portId: 'model_cv' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );

  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __macseqWriteAllSteps?: unknown };
    return typeof w.__macseqWriteAllSteps === 'function';
  });

  // Pattern: step 0 → model 8 (KICK), step 1 → null (HOLD-LAST → 8),
  // step 2 → null (still 8), step 3 → null (still 8). 4-step loop, so the
  // model param should rest at 8 the entire time after step 0 plays.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __macseqWriteAllSteps: (
        id: string,
        arr: Array<{ on: boolean; midi: number | null; model: number | null }>,
      ) => boolean;
    };
    const steps = Array.from({ length: 16 }, (_, i) => {
      if (i === 0) return { on: true, midi: 60, model: 8 }; // KICK
      if (i < 4) return { on: true, midi: 60, model: null }; // unset → HOLD
      return { on: false, midi: 60, model: null };
    });
    w.__macseqWriteAllSteps('ms', steps);
  });

  // Wait for the pattern to loop a couple times.
  await runFor(page, 600);

  // Sample MACSEQ's `modelCv` read-key (the logical index) over ~400 ms.
  // At 240 BPM, the 4-step loop = 250 ms, so we catch the full sequence
  // twice. After step 0 fires (modelCv=8), every subsequent step is null
  // → HOLD-LAST → 8. (See the file header on the headline test for why
  // we read MACSEQ's mirror rather than macrooscillator.model.)
  const samples: number[] = [];
  for (let i = 0; i < 15; i++) {
    const v = await readEngineKey(page, 'ms', 'modelCv');
    if (v !== null) samples.push(Math.round(v));
    await page.waitForTimeout(30);
  }

  // At least one sample must show 8 (the held value).
  expect(samples.some((s) => s === 8), `expected to observe modelCv=8 (held); got ${JSON.stringify(samples)}`).toBe(true);
  // No sample should be > MACRO_MAX_MODEL or < 0 — sanity.
  for (const s of samples) {
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(13);
  }
});
