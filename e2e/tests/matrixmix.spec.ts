// e2e/tests/matrixmix.spec.ts
//
// MATRIXMIX — the full live patch-matrix loop against the REAL graph store:
//   1. spawn the matrix + two real modules (ADSR + VCA).
//   2. pick ADSR on the X axis + VCA on the Y axis from the dropdowns →
//      the grid materializes (jacks become rows/cols).
//   3. a legal cell (ADSR.env cv-out  ×  VCA.cv cv-in) is clickable →
//      clicking it CREATES the edge in patch.edges via the SHARED
//      validateEdge seam, and the cell flips to a filled "direct" dot.
//   4. patch a CONFLICT from OUTSIDE the matrix (a 3rd module → VCA.cv) and
//      assert the matrix reflects it LIVE: a different legal cell whose input
//      is now taken reads as inputTaken (red ✕) without any matrix interaction.
//
// This exercises the real source→matrix→graph chain (not the pure core in
// isolation): the card reads patch.edges every render, classifies cells, and
// writes through createMatrixEdge → validateEdge → patch.edges, the same path
// the drag-connect + patch-to flows use.

import { test, expect, loadVoiceDemo } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const MM = 'mm-1';
const ADSR = 'adsr-1'; // X axis: outputs env (cv), env_inv (cv); inputs gate/attack/decay/sustain/release
const VCA = 'vca-1'; // Y axis: inputs audio (audio), cv (cv); outputs audio/audio_inv (audio)
const LFO = 'lfo-1'; // 3rd module — its phase0 (cv) feeds the conflict edge into VCA.cv

// Edge ids follow the canonical `e-<src>-<srcPort>-<dst>-<dstPort>` convention
// (matrixEdgeId) — the matrix addresses the SAME edge the drag/patch-to paths do.
const LEGAL_EDGE_ID = `e-${ADSR}-env-${VCA}-cv`;

async function readEdges(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, unknown> } };
    return { ...w.__patch.edges };
  });
}

/** A connectivity fingerprint of the patch — sorted "src.port→dst.port" strings,
 *  edge-id-independent so it survives a re-patch that addresses the same wire by
 *  a different id. Used to assert the undo round-trip lands on the EXACT start. */
function normEdges(edges: Record<string, unknown>): string[] {
  return Object.values(edges)
    .map((e) => {
      const x = e as { source: { nodeId: string; portId: string }; target: { nodeId: string; portId: string } };
      return `${x.source.nodeId}.${x.source.portId}→${x.target.nodeId}.${x.target.portId}`;
    })
    .sort();
}

/** Current LOCAL_ORIGIN undo-stack depth (dev hook exposed by Canvas). */
function undoDepth(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __undoManager: { undoStack: unknown[] } }).__undoManager.undoStack.length,
  );
}

async function setup(page: Page): Promise<void> {
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [
    { id: MM, type: 'matrixMix', position: { x: 520, y: 80 }, domain: 'meta' },
    { id: ADSR, type: 'adsr', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: VCA, type: 'vca', position: { x: 60, y: 340 }, domain: 'audio' },
    { id: LFO, type: 'lfo', position: { x: 60, y: 560 }, domain: 'audio' },
  ]);
}

/** The matrix's DOCK grid (the lifted body — same `matrixmix-*` testids the
 *  card emitted): open the tile's dock full view and return the faceplate
 *  locator every grid read scopes under. Axes are picked on the LANE tile's
 *  ranked selector cells first (pickAxis below — the popup primitive). */
async function openGrid(page: Page, nodeId: string) {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  await expect(faceplate.getByTestId('matrixmix-grid')).toBeVisible();
  return faceplate;
}

test('select both axes → click a legal cell creates the edge + a dot; an external conflict shows live', async ({
  page,
}) => {
  await setup(page);

  // Pick ADSR on X, VCA on Y — on the lane tile's ranked selector cells (the
  // card's <select>s died with the card; the face's popup is the gesture).
  await pickAxis(page, 'shell-cell-matrixmix-x', 'ADSR');
  await pickAxis(page, 'shell-cell-matrixmix-y', 'VCA');

  // The dock grid materializes; the empty prompt is gone.
  const card = await openGrid(page, MM);
  await expect(card.locator('[data-testid="matrixmix-empty"]')).toHaveCount(0);

  // The legal cell: row = VCA.cv (cv input), col = ADSR.env (cv output).
  // testid pattern: matrixmix-cell-<rowDir>-<rowPort>-<colDir>-<colPort>.
  const legalCell = card.locator(
    '[data-testid="matrixmix-cell-input-cv-output-env"]',
  );
  await expect(legalCell).toBeVisible();
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
  // No edge exists yet.
  expect(await readEdges(page)).not.toHaveProperty(LEGAL_EDGE_ID);

  // Click it → createMatrixEdge runs through the shared validateEdge seam.
  await legalCell.click();

  // The edge now exists in the live patch, with the right endpoints + types.
  await expect
    .poll(async () => Object.keys(await readEdges(page)))
    .toContain(LEGAL_EDGE_ID);
  const edges = await readEdges(page);
  const created = edges[LEGAL_EDGE_ID] as {
    source: { nodeId: string; portId: string };
    target: { nodeId: string; portId: string };
    sourceType: string;
    targetType: string;
  };
  expect(created.source).toEqual({ nodeId: ADSR, portId: 'env' });
  expect(created.target).toEqual({ nodeId: VCA, portId: 'cv' });
  expect(created.sourceType).toBe('cv');
  expect(created.targetType).toBe('cv');

  // The cell re-classifies LIVE to a filled "direct" dot (cable colour).
  await expect(legalCell).toHaveAttribute('data-kind', 'direct');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toBeVisible();

  // ── Unpatch: clicking the now-GREEN (direct) cell REMOVES the edge ─────────
  // The same cell is now a direct connection between the two matrixed modules.
  // Clicking it toggles it OFF — removeMatrixEdge deletes that exact edge, and
  // the cell flips back to a clickable empty (legalEmpty) cell with no dot.
  await legalCell.click();
  await expect
    .poll(async () => Object.keys(await readEdges(page)))
    .not.toContain(LEGAL_EDGE_ID);
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toHaveCount(0);

  // ── Live external conflict ───────────────────────────────────────────────
  // Patch LFO.phase0 (cv out) → VCA.audio (audio... NO). Use a DIFFERENT legal
  // target so we don't collide with the cell we just made: feed VCA's `cv`
  // input is already taken by us, so instead we prove the LIVE-reflect on a
  // cell whose input becomes externally taken. Patch LFO.phase0 → VCA.cv would
  // REPLACE our edge; to show inputTaken cleanly, first remove our edge, then
  // add the external one, then re-read the same cell.
  await page.evaluate(
    ({ legalId, lfo, vca }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        // Remove the matrix-made edge so the cell's input is free…
        delete w.__patch.edges[legalId];
        // …then patch a THIRD module (LFO.phase0 cv-out) into VCA.cv from
        // OUTSIDE the matrix entirely (no matrix interaction).
        const id = `e-${lfo}-phase0-${vca}-cv`;
        w.__patch.edges[id] = {
          id,
          source: { nodeId: lfo, portId: 'phase0' },
          target: { nodeId: vca, portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        };
      });
    },
    { legalId: LEGAL_EDGE_ID, lfo: LFO, vca: VCA },
  );

  // The SAME cell now reads inputTaken (red ✕) — the matrix reflected the
  // external patch live, with no click on the matrix.
  await expect(legalCell).toHaveAttribute('data-kind', 'inputTaken');
  await expect(legalCell.locator('[data-testid="matrixmix-dot"]')).toHaveCount(0);
});

test('RED ✕ (inputTaken) is clickable: cancel no-ops; accept REPLACES the foreign source, and ONE undo restores it', async ({
  page,
}) => {
  await setup(page);
  await pickAxis(page, 'shell-cell-matrixmix-x', 'ADSR');
  await pickAxis(page, 'shell-cell-matrixmix-y', 'VCA');
  const card = await openGrid(page, MM);

  // External conflict from OUTSIDE the matrix: LFO.phase0 (cv) → VCA.cv.
  const foreignId = `e-${LFO}-phase0-${VCA}-cv`;
  await page.evaluate(
    ({ foreignId, lfo, vca }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges[foreignId] = {
          id: foreignId,
          source: { nodeId: lfo, portId: 'phase0' },
          target: { nodeId: vca, portId: 'cv' },
          sourceType: 'cv',
          targetType: 'cv',
        };
      });
    },
    { foreignId, lfo: LFO, vca: VCA },
  );

  // The cell (VCA.cv input × ADSR.env output) now reads inputTaken (RED ✕).
  const cell = card.locator('[data-testid="matrixmix-cell-input-cv-output-env"]');
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
  const matrixId = `e-${ADSR}-env-${VCA}-cv`;

  // CANCEL the confirm → nothing changes (foreign intact, no matrix edge).
  page.once('dialog', (d) => d.dismiss());
  await cell.click();
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
  expect(Object.keys(await readEdges(page))).toContain(foreignId);
  expect(Object.keys(await readEdges(page))).not.toContain(matrixId);

  // Isolate the next op as its own undo entry (so the captureTimeout can't
  // coalesce it with the earlier axis-pick edits), then ACCEPT the confirm.
  await page.evaluate(() =>
    (window as unknown as { __undoManager: { stopCapturing: () => void } }).__undoManager.stopCapturing(),
  );
  page.once('dialog', (d) => d.accept());
  await cell.click();

  // The foreign cable is REPLACED by the matrix edge — one atomic transaction.
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(matrixId);
  expect(Object.keys(await readEdges(page))).not.toContain(foreignId);
  await expect(cell).toHaveAttribute('data-kind', 'direct');

  // ONE Cmd-Z reverts the WHOLE displacing re-patch: matrix edge removed AND
  // the foreign edge restored (createMatrixEdge did remove+add in ONE txn).
  await page.evaluate(() =>
    (window as unknown as { __undoManager: { undo: () => void } }).__undoManager.undo(),
  );
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(foreignId);
  expect(Object.keys(await readEdges(page))).not.toContain(matrixId);
  await expect(cell).toHaveAttribute('data-kind', 'inputTaken');
});

test('GRAY ✕ (outputFanout) is clickable: accept ADDS a cable, the foreign consumer stays', async ({ page, rack }) => {
  await spawnPatch(page, [
    { id: MM, type: 'matrixMix', position: { x: 520, y: 80 }, domain: 'meta' },
    { id: 'vco-1', type: 'analogVco', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: VCA, type: 'vca', position: { x: 60, y: 340 }, domain: 'audio' },
    { id: 'out-1', type: 'audioOut', position: { x: 60, y: 560 }, domain: 'audio' },
  ]);
  await pickAxis(page, 'shell-cell-matrixmix-x', 'ANALOGVCO');
  await pickAxis(page, 'shell-cell-matrixmix-y', 'VCA');
  const card = await openGrid(page, MM);

  // External consumer: VCO.sine (audio out) → OUT.L, so VCO.sine fans out.
  const foreignId = 'e-vco-1-sine-out-1-L';
  await page.evaluate(
    ({ foreignId }) => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges[foreignId] = {
          id: foreignId,
          source: { nodeId: 'vco-1', portId: 'sine' },
          target: { nodeId: 'out-1', portId: 'L' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    },
    { foreignId },
  );

  // Cell (VCA.audio input × VCO.sine output): the output already fans out → GRAY ✕.
  const cell = card.locator('[data-testid="matrixmix-cell-input-audio-output-sine"]');
  await expect(cell).toHaveAttribute('data-kind', 'outputFanout');
  const matrixId = `e-vco-1-sine-${VCA}-audio`;

  // ACCEPT → the matrix edge is ADDED; the foreign consumer is UNTOUCHED.
  page.once('dialog', (d) => d.accept());
  await cell.click();
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(matrixId);
  expect(Object.keys(await readEdges(page))).toContain(foreignId); // still there — additive
  await expect(cell).toHaveAttribute('data-kind', 'direct');
});

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 7 recovered-on-retry observation(s) across 4 SHA(s) / 3 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: the matrix's undo integrity — unpatch and re-patch from the grid, then Cmd-Z back to the EXACT starting patch; partial undo through the shared validateEdge seam leaves a silently different graph.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('Sequenced VCO: matrix unpatch + re-patch, then Cmd-Z all the way back to the exact starting patch', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 7 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rack }) => {
  // CI-load robustness: loads a 5-module example then drives a long multi-step
  // matrix patch/unpatch + full Cmd-Z undo chain (each step polls the edge
  // store). The flat 30s default timed out under CI load (main run 1b897a3c,
  // cleared on rerun → flake, not a real break). Give it room.
  test.setTimeout(90_000);

  // Load the REAL "Sequenced VCO" example (5 modules, 6 edges) — the example
  // load is a single NON-undoable transaction, so it is the undo FLOOR.
  await loadVoiceDemo(page);
  await expect
    .poll(async () => Object.keys(await readEdges(page)).length, { timeout: 20_000 })
    .toBe(6);
  await page.waitForFunction(
    () => document.querySelector('.svelte-flow__node[data-id="vd-out"]') !== null,
    undefined,
    { timeout: 20_000 },
  );

  const startEdges = normEdges(await readEdges(page));
  expect(startEdges).toHaveLength(6);

  // Inject a MATRIXMIX node + stop the auto-playing sequencer — BOTH via a
  // non-LOCAL_ORIGIN (floor) write so neither lands on the undo stack.
  await page.evaluate(() => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      (w.__patch.nodes as Record<string, unknown>)['mm-x'] = {
        id: 'mm-x',
        type: 'matrixMix',
        domain: 'meta',
        position: { x: 1500, y: 60 },
        params: {},
        data: {},
      };
      if (w.__patch.nodes['vd-seq']) w.__patch.nodes['vd-seq'].params.running = 0;
    });
  });
  const card = page.locator('[data-testid="matrixmix-card"][data-node-id="mm-x"]');
  await expect(card).toBeVisible();

  // SEAL the undo floor: close any open capture group (e.g. the auto-spawned
  // TIMELORDE singleton) so our matrix edits below form FRESH, discrete undo
  // entries instead of coalescing into a pre-existing one.
  const seal = () =>
    page.evaluate(() =>
      (window as unknown as { __undoManager: { stopCapturing: () => void } }).__undoManager.stopCapturing(),
    );
  await seal();

  const x = card.locator('[data-testid="matrixmix-x-select"]');
  const y = card.locator('[data-testid="matrixmix-y-select"]');

  // NB we deliberately operate on MONO cables (cv / pitch), not the VCA→AUDIO-OUT
  // stereo pair — patching one side of a stereo pair auto-wires the other, which
  // would confound a per-cell unpatch assertion.

  // ── Unpatch + RE-PATCH via the matrix (ADSR × VCA) ──
  await x.selectOption('vd-adsr');
  await y.selectOption('vd-vca');
  await seal();
  // unpatch adsr.env → vca.cv (a direct cable)
  await card.locator('[data-testid="matrixmix-cell-input-cv-output-env"]').click();
  await seal();
  // make a NEW patch: adsr.env_inv → vca.cv (the freed input)
  await card.locator('[data-testid="matrixmix-cell-input-cv-output-env_inv"]').click();
  await seal();
  // ── Cross-pair unpatch (SEQ × VCO): drop seq.pitch → vco.pitch ──
  await x.selectOption('vd-seq');
  await y.selectOption('vd-vco');
  await seal();
  await card.locator('[data-testid="matrixmix-cell-input-pitch-output-pitch"]').click();
  await seal();

  // The matrix WORKS: the new cable exists, the unpatched ones are gone, the
  // untouched ones remain.
  // ⚠ #1569: this poll used to collapse all seven conditions into ONE bare
  // boolean — its two CI failures reported `expect(false).toBe(true)` and
  // nothing else, which is undiagnosable from the blob report. Poll a
  // DESCRIPTION instead: green is 'OK', red prints exactly which conditions
  // are unmet plus the live edge set it saw.
  await expect
    .poll(async () => {
      const ids = Object.keys(await readEdges(page));
      const conditions: [string, boolean][] = [
        ['new patch e-vd-adsr-env_inv-vd-vca-cv PRESENT', ids.includes('e-vd-adsr-env_inv-vd-vca-cv')],
        ['unpatched e-vd-adsr-env-vd-vca-cv GONE', !ids.includes('e-vd-adsr-env-vd-vca-cv')],
        ['unpatched e-vd-seq-pitch-vd-vco-pitch GONE', !ids.includes('e-vd-seq-pitch-vd-vco-pitch')],
        ['untouched e-vd-seq-gate-vd-adsr-gate PRESENT', ids.includes('e-vd-seq-gate-vd-adsr-gate')],
        ['untouched e-vd-vco-sine-vd-vca-audio PRESENT', ids.includes('e-vd-vco-sine-vd-vca-audio')],
        ['untouched stereo e-vd-vca-audio-vd-out-L PRESENT', ids.includes('e-vd-vca-audio-vd-out-L')],
        ['untouched stereo e-vd-vca-audio-vd-out-R PRESENT', ids.includes('e-vd-vca-audio-vd-out-R')],
      ];
      const unmet = conditions.filter(([, ok]) => !ok).map(([label]) => label);
      return unmet.length === 0
        ? 'OK'
        : `UNMET: ${unmet.join('; ')} — live edges: [${ids.sort().join(', ')}]`;
    })
    .toBe('OK');

  // ── Hit Cmd-Z (the REAL keybinding) until we're back at the starting point ──
  const startKey = JSON.stringify(startEdges);
  let guard = 0;
  while (guard++ < 30 && JSON.stringify(normEdges(await readEdges(page))) !== startKey) {
    const before = await undoDepth(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => undoDepth(page), { timeout: 5000 }).toBeLessThan(before);
  }

  // Back to the EXACT starting patch — same 6 wires, same endpoints.
  expect(normEdges(await readEdges(page))).toEqual(startEdges);
});


// ── THE FACEPLATE, DRIVEN FOR REAL ──────────────────────────────────────────
//
// ⚠ EVERY TEST ABOVE BOOTS `?shell=legacy` AND IS THEREFORE BLIND TO THE FACE.
// That is not an oversight in them — they were written against the card and the
// card still ships — but it means promotion could have landed a completely dead
// faceplate with this entire file green. (The same is true of
// `workflow-dock.spec.ts`'s matrixmix fixture, which also boots `?shell=legacy`
// and needed no edit for exactly that reason.) This test is the other half: the
// DEFAULT renderer, which is what a player actually gets.
//
// It asserts the three things promotion is responsible for and nothing else:
//
//   1. THE LANE TILE ANSWERS "WHICH TWO MODULES" — the argument for ranking the
//      axis pickers at all. Before promotion this cost a dock full-view open,
//      because an un-migrated matrixMix rendered a placeholder tile.
//   2. THE CELLS WRITE THE GRAPH through the same two functions the card's
//      `<select>`s call, asserted at `node.data`, not at the DOM. A selector
//      that only re-labels itself is indistinguishable from a dead one.
//   3. THE GRID BODY IS ALIVE IN THE DOCK, including the `aria-label` that
//      carries a cell's entire meaning. The visual is a coloured dot or a ✕;
//      the SENTENCE is the semantics, and under the resting-text ruling the
//      sentence must live in the accessible name rather than in painted text —
//      so the accessible name is what a face spec has to read.

/** Pick an option in a shell SELECTOR cell by its visible label. The face's
 *  selector is the RACKLINE popup primitive, not a native `<select>`, so
 *  `selectOption` does not apply: click the chip, then the `role="option"`. */
async function pickAxis(page: Page, cellTestId: string, label: string): Promise<void> {
  await page.getByTestId(cellTestId).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

/** The matrix node's persisted axis selections, read off the LIVE graph. */
async function readAxes(page: Page, nodeId: string): Promise<{ x?: string; y?: string }> {
  return await page.evaluate((id) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, { data?: { xAxisModuleId?: string; yAxisModuleId?: string } }> };
    };
    const d = w.__patch.nodes[id]?.data ?? {};
    return { x: d.xAxisModuleId, y: d.yAxisModuleId };
  }, nodeId);
}

test('FACE: the lane tile ranks both axis pickers, they write the graph, and the dock body patches', async ({ page }) => {
  // The DEFAULT renderer — no `?shell=legacy`. This is the one test in this file
  // that sees a ModuleShell instead of MatrixMixCard.
  await page.goto('/rack?seed=none');
  // A FAILURE BOUND, not the gate: the first navigation on a cold dev server
  // compiles the whole route graph on demand.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  await spawnPatch(page, [
    { id: MM, type: 'matrixMix', position: { x: 520, y: 80 }, domain: 'meta' },
    { id: ADSR, type: 'adsr', position: { x: 60, y: 80 }, domain: 'audio' },
    { id: VCA, type: 'vca', position: { x: 60, y: 340 }, domain: 'audio' },
  ]);

  // ── 1. THE TILE IS A FACEPLATE, NOT THE PLACEHOLDER ──────────────────────
  const laneNode = page.locator(`.svelte-flow__node[data-id="${MM}"]`);
  const shell = laneNode.getByTestId('module-shell');
  await expect(shell, 'a promoted meta module renders its curated face in the lane').toBeVisible();
  await expect(shell).toHaveAttribute('data-shell-type', 'matrixMix');
  await expect(
    laneNode.getByTestId('module-shell-placeholder'),
    'and NOT the un-migrated placeholder this promotion replaced',
  ).toHaveCount(0);
  // The legacy card is not in the lane at all under the default renderer.
  await expect(laneNode.locator('[data-testid="matrixmix-card"]')).toHaveCount(0);

  // ── 2. BOTH RANKED CELLS PAINT, AND THEY READ THE UNSET STATE ────────────
  // ⚠ PRESENCE, not "the face resolved": a face that ranks controls and renders
  // none of them is a real shipped shape (`joystick`), and for this module it
  // would mean a blank tile — the exact outcome `order: []` would have produced.
  const xCell = shell.getByTestId('shell-cell-matrixmix-x');
  const yCell = shell.getByTestId('shell-cell-matrixmix-y');
  await expect(xCell, 'the X axis cell reaches the lane tile').toBeVisible();
  await expect(yCell, 'the Y axis cell reaches the lane tile').toBeVisible();
  // The accessible name carries tag + current value — the resting-text ruling's
  // "speakable and assertable but unpainted" home for exactly this.
  await expect(xCell).toHaveAttribute('aria-label', /pick a module/);

  // ── 3. THE CELLS WRITE THE GRAPH ─────────────────────────────────────────
  // ⚠ ASSERTED AT `node.data`, NOT AT THE DOM. A cell whose `onchange` were
  // wired to nothing would still re-label itself from its own local state and
  // look perfectly alive.
  expect(await readAxes(page, MM), 'a fresh matrix has neither axis').toEqual({ x: undefined, y: undefined });
  await pickAxis(page, 'shell-cell-matrixmix-x', 'ADSR');
  await pickAxis(page, 'shell-cell-matrixmix-y', 'VCA');
  await expect
    .poll(() => readAxes(page, MM), { message: 'both axis writes land on the node' })
    .toEqual({ x: ADSR, y: VCA });

  // ── 4. THE DOCK BODY IS THE GRID, AND IT IS LIVE ─────────────────────────
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  const grid = faceplate.getByTestId('matrixmix-grid');
  await expect(grid, 'the fullViewBody extension mounts the cross-point field').toBeVisible();
  await expect(
    faceplate.getByTestId('matrixmix-empty'),
    'and the empty-state hint is gone now that both axes name a module',
  ).toHaveCount(0);

  // The legal cell: row = VCA.cv (cv input), col = ADSR.env (cv output). Same
  // testids the card emits — the body was lifted, not rewritten.
  const legalCell = faceplate.getByTestId('matrixmix-cell-input-cv-output-env');
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
  // ⚠ THE ARIA IS THE SEMANTICS. The pixels are a dot or a ✕; this sentence is
  // the only place the cell says what clicking it would DO, and the ruling puts
  // it in the accessible name rather than in painted face text.
  await expect(legalCell).toHaveAttribute('aria-label', /patch ENV out . CV in/);
  expect(await readEdges(page)).not.toHaveProperty(LEGAL_EDGE_ID);

  // Click it → the edge materialises through the SHARED validateEdge seam, and
  // the cell re-classifies live.
  await legalCell.click();
  await expect.poll(async () => Object.keys(await readEdges(page))).toContain(LEGAL_EDGE_ID);
  await expect(legalCell).toHaveAttribute('data-kind', 'direct');
  await expect(legalCell.getByTestId('matrixmix-dot')).toBeVisible();
  await expect(
    legalCell,
    'and the sentence follows the state — a static aria-label would be a dead readout',
  ).toHaveAttribute('aria-label', /connected \(click to unpatch\)/);

  // Unpatch from the same cell, so the body's WRITE path is proven in both
  // directions rather than only in the direction that adds.
  await legalCell.click();
  await expect.poll(async () => Object.keys(await readEdges(page))).not.toContain(LEGAL_EDGE_ID);
  await expect(legalCell).toHaveAttribute('data-kind', 'legalEmpty');
});
