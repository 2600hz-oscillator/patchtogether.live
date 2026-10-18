// PHASES on the shipping shell. Pure-model tests own sample-accurate curve
// and transport math; these tests own gestures, durable graph writes, actual
// gate/CV cables, and the worklet-to-face live-state bridge.
import { test, expect, type Page } from './_fixtures';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { settle } from '../_helpers/frames';
import { frameMember } from '../vrt/_shell-faces';
import {
  describeScopeWindow,
  readScopePeakOverWindow,
  setNodeParams,
} from './_module-coverage-helpers';
import {
  PHASES_EDITED,
  clickPhasePoint,
  dragPhaseShape,
  openPhasesDock,
  phaseScreenPoint,
  phasesLane,
  readPhases,
  readPhasesLaneLayout,
  seedPhases,
} from './_phases-helpers';

const NODE = 'ph';
const SCOPE = 'ph-scope';

test.describe.configure({ mode: 'default', timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  // Nothing here measures video pixels. Pause unrelated video production so
  // audio observation and DOM interaction do not compete with SwiftShader.
  await installRenderSmokeHooks(page);
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
});

test('compact and full lane controls leave space for the selected envelope editor and jack rail', async ({ page, errorWatch }) => {
  await spawnPatch(page, [{ id: NODE, type: 'phases', position: { x: 180, y: 100 } }]);
  await seedPhases(page, NODE, PHASES_EDITED);
  const lane = phasesLane(page, NODE);
  for (const [tier, zoom] of [['compact', 0.45], ['full', 0.7]] as const) {
    await frameMember(page, NODE, zoom, tier);
    await clickPhasePoint(page, lane.getByTestId(`phases-editor-${NODE}`), 0.43, 0.98);
    await expect(lane.getByTestId(`phases-shape-${NODE}`)).toHaveAttribute('aria-valuenow', '0.5');
    await settle(page);
    const layout = await readPhasesLaneLayout(lane);
    expect(layout.cells.map((cell) => cell.key), `${tier}: the actual ranked controls render`).toEqual(['length', 'loop', 'polarity']);
    expect(layout.problems, `${tier}: ${JSON.stringify(layout)}`).toEqual([]);
  }

  // Positive control: reproduce the old kind of spill by moving a real
  // control into the editor while it remains inside the outer tile. An
  // outer-tile-only check stays green; this same production-box probe must
  // reject the overlap. Restore the untouched style before the final check.
  const control = lane.locator('.tile-body [data-cell-kind="param"]').first();
  const priorStyle = await control.getAttribute('style');
  const before = await readPhasesLaneLayout(lane);
  const dy = before.editor.top + 4 - before.cells[0]!.box.bottom;
  await control.evaluate((element, delta) => {
    const zoom = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.svelte-flow__viewport')!).transform).a;
    (element as HTMLElement).style.transform = `translateY(${delta / zoom}px)`;
  }, dy);
  try {
    const overlapping = await readPhasesLaneLayout(lane);
    expect(overlapping.cells[0]!.box.top).toBeGreaterThan(overlapping.shell.top);
    expect(overlapping.cells[0]!.box.bottom).toBeLessThan(overlapping.shell.bottom);
    expect(overlapping.problems, 'the probe must reject a control overlapping the editor').toContain('control length overlaps editor');
  } finally {
    await control.evaluate((element, original) => {
      if (original === null) element.removeAttribute('style');
      else element.setAttribute('style', original);
    }, priorStyle);
  }
  expect((await readPhasesLaneLayout(lane)).problems).toEqual([]);
});

test('stroke clicks split phases; vertices drag vertically; deletion preserves the left phase shape', async ({ page, errorWatch }) => {
  await spawnPatch(page, [{ id: NODE, type: 'phases', position: { x: 180, y: 100 } }]);
  const dock = await openPhasesDock(page, NODE);
  const editor = dock.getByTestId(`phases-editor-${NODE}`);
  const vertices = editor.locator(`[data-testid^="phases-vertex-${NODE}-"]`);
  const phases = editor.locator(`[data-testid^="phases-phase-${NODE}-"]`);
  await expect(vertices).toHaveCount(2);
  await expect(phases).toHaveCount(1);
  const initialY = Number(await vertices.first().getAttribute('data-y'));
  expect(initialY).toBeGreaterThanOrEqual(0);
  expect(initialY).toBeLessThanOrEqual(1);
  await expect(vertices.last(), 'a fresh envelope is a horizontal straight line').toHaveAttribute('data-y', String(initialY));
  await expect(dock.getByTestId(`phases-zero-${NODE}`)).toHaveCount(0);

  // A stroke click ADDS; the background of its vertical phase band SELECTS.
  await clickPhasePoint(page, editor, 0.35, initialY);
  await expect(vertices).toHaveCount(3);
  await expect(phases).toHaveCount(2);
  const inserted = (await readPhases(page, NODE))[1]!;
  const vertex = editor.getByTestId(`phases-vertex-${NODE}-1`);
  const from = await phaseScreenPoint(editor, inserted.x, inserted.y);
  const to = await phaseScreenPoint(editor, 0.8, 0.86);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect(vertex).toHaveAttribute('data-y', /0\.8/);
  const dragged = (await readPhases(page, NODE))[1]!;
  expect(dragged.x, 'horizontal mouse motion must not alter phase timing').toBe(inserted.x);
  expect(dragged.y).toBeCloseTo(0.86, 2);

  // Grab away from the vertex center, then leave the plot. Clamping cursor
  // coordinates before applying the relative drag delta strands the vertex a
  // few pixels short of either rail; only the final level should be clamped.
  for (const rail of [
    { offset: 3, outsideY: -0.2, expected: 0 },
    { offset: -3, outsideY: 1.2, expected: 1 },
  ]) {
    const current = (await readPhases(page, NODE))[1]!;
    const grab = await phaseScreenPoint(editor, current.x, current.y);
    const outside = await phaseScreenPoint(editor, current.x, rail.outsideY);
    await page.mouse.move(grab.x, grab.y + rail.offset);
    await page.mouse.down();
    await page.mouse.move(outside.x, outside.y, { steps: 5 });
    await page.mouse.up();
    await expect(vertex, 'an off-center grab can still reach the exact voltage rail').toHaveAttribute('data-y', String(rail.expected));
  }

  await clickPhasePoint(page, editor, 0.76, 0.98);
  await expect(phases.nth(1)).toHaveAttribute('data-selected', 'true');
  const shape = dock.getByTestId(`phases-shape-${NODE}`);
  await expect(shape).toHaveAttribute('aria-valuenow', '0');
  await dragPhaseShape(page, shape, 1);
  await expect(shape).toHaveAttribute('aria-valuenow', '1');

  await clickPhasePoint(page, editor, 0.16, 0.98);
  await expect(phases.first()).toHaveAttribute('data-selected', 'true');
  await expect(shape, 'each phase starts with its own linear shape').toHaveAttribute('aria-valuenow', '0');
  await dragPhaseShape(page, shape, 0.5);
  await expect(shape).toHaveAttribute('aria-valuenow', '0.5');
  const shaped = await readPhases(page, NODE);
  expect(shaped[0]!.shape).toBeCloseTo(0.5, 5);
  expect(shaped[1]!.shape, 'editing the left phase preserves the right curve').toBe(1);

  await vertex.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete vertex', exact: true }).click();
  await expect(vertices).toHaveCount(2);
  await expect(phases).toHaveCount(1);
  const merged = await readPhases(page, NODE);
  expect(merged, 'deleting a vertex retains both outer endpoints and the left curve').toEqual([
    shaped[0],
    shaped[2],
  ]);
  await expect(shape).toHaveAttribute('aria-valuenow', '0.5');
});

test('polarity changes the zero reference without changing geometry, and mode buttons write durable params', async ({ page, errorWatch }) => {
  await spawnPatch(page, [{ id: NODE, type: 'phases', position: { x: 180, y: 100 } }]);
  await seedPhases(page, NODE, PHASES_EDITED);
  const dock = await openPhasesDock(page, NODE);
  const editor = dock.getByTestId(`phases-editor-${NODE}`);
  await expect(editor.locator(`[data-testid^="phases-vertex-${NODE}-"]`)).toHaveCount(PHASES_EDITED.length);
  const before = await readPhases(page, NODE);
  const beforePaths = await editor.locator('path').evaluateAll((paths) => paths.map((path) => path.getAttribute('d')));
  expect(beforePaths.length, 'the geometry probe actually sees envelope paths').toBeGreaterThan(0);

  await dock.getByTestId('control-polarity').click();
  await expect(dock.getByTestId('control-polarity')).toHaveAttribute('aria-checked', 'true');
  // A horizontal SVG line has a zero-height geometry box, so Playwright's
  // visibility predicate rejects it even when its stroke is painted. Presence
  // owns this DOM leg; the bipolar VRT owns the red stroke's rendered pixels.
  await expect(editor.getByTestId(`phases-zero-${NODE}`)).toHaveCount(1);
  expect(await readPhases(page, NODE), 'polarity must not rewrite vertices or phase shapes').toEqual(before);
  expect(await editor.locator('path').evaluateAll((paths) => paths.map((path) => path.getAttribute('d'))),
    'the exact plotted paths survive a polarity switch').toEqual(beforePaths);

  await dock.getByTestId('control-loop').click();
  await dock.getByTestId('control-reverse').click();
  await expect(dock.getByTestId('control-loop')).toHaveAttribute('aria-checked', 'true');
  await expect(dock.getByTestId('control-reverse')).toHaveAttribute('aria-checked', 'true');
  const params = await page.evaluate((id) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
    return { ...w.__patch.nodes[id]!.params };
  }, NODE);
  expect(params).toMatchObject({ loop: 1, polarity: 1, reverse: 1 });

  const length = dock.getByTestId('control-length');
  await expect(length).toHaveAttribute('aria-valuemin', '0.05');
  await expect(length).toHaveAttribute('aria-valuemax', '30');
  expect(Number(await length.getAttribute('aria-valuenow'))).toBeCloseTo(0.05, 5);
  await dock.getByTestId('control-polarity').click();
  await expect(editor.getByTestId(`phases-zero-${NODE}`)).toHaveCount(0);
  expect(await readPhases(page, NODE)).toEqual(before);
});

test('the editor permits 24 phases, refuses a 25th, and keeps its endpoint anchors', async ({ page, errorWatch }) => {
  await spawnPatch(page, [{ id: NODE, type: 'phases', position: { x: 180, y: 100 } }]);
  // Twenty-three phases, with a wide last phase to make both clicks clearly
  // distinct from a vertex hit target even at a compact screen size.
  const points = [
    ...Array.from({ length: 23 }, (_, i) => ({ x: i * 0.03, y: 0.3, shape: 0 })),
    { x: 1, y: 0.3, shape: 0 },
  ];
  await seedPhases(page, NODE, points);
  const dock = await openPhasesDock(page, NODE);
  const editor = dock.getByTestId(`phases-editor-${NODE}`);
  const vertices = editor.locator(`[data-testid^="phases-vertex-${NODE}-"]`);
  await expect(vertices).toHaveCount(24);
  await clickPhasePoint(page, editor, 0.8, 0.3);
  await expect(vertices).toHaveCount(25);
  await clickPhasePoint(page, editor, 0.93, 0.3);
  await settle(page);
  await expect(vertices).toHaveCount(25);
  expect((await readPhases(page, NODE)).length).toBe(25);

  await vertices.first().click({ button: 'right' });
  const remove = page.getByRole('menuitem', { name: 'Delete vertex', exact: true });
  if (await remove.count()) await expect(remove, 'endpoint deletion must be unavailable').toBeDisabled();
  await clickPhasePoint(page, editor, 0.9, 0.95);
  const retained = await readPhases(page, NODE);
  expect(retained[0]).toMatchObject({ x: 0, y: 0.3 });
  expect(retained.at(-1)).toMatchObject({ x: 1, y: 0.3 });
});

interface PlaybackState {
  position: number;
  playing: boolean;
  loop: boolean;
  reverse: boolean;
  effectiveLength: number;
  lengthCvPatched: boolean;
  modeRevision?: number;
}

/** Observe production worklet telemetry IN THE PAGE. The timeout is only a
 * failure bound; readiness is the named state. Returning the observed record
 * keeps a later runner round trip from sampling a different playback frame. */
async function waitForPlayback(
  page: Page,
  want: Partial<PlaybackState>,
  afterModeRevision?: number,
): Promise<PlaybackState> {
  const result = await page.waitForFunction(({ id, expected, afterRevision }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (domain: string) => { read: (id: string, key: string) => unknown } };
    };
    const state = w.__engine().getDomain('audio').read(id, 'state') as PlaybackState | undefined;
    if (!state) return false;
    // Mode fields are intentionally optimistic in the factory. A newer
    // worklet acknowledgement proves a face click reached the audio thread.
    if (afterRevision !== undefined && (state.modeRevision ?? 0) <= afterRevision) return false;
    return Object.entries(expected).every(([key, value]) => key === 'effectiveLength'
      ? Math.abs(state.effectiveLength - (value as number)) < 0.00001
      : state[key as keyof PlaybackState] === value)
      ? { ...state }
      : false;
  }, { id: NODE, expected: want, afterRevision: afterModeRevision });
  return await result.jsonValue() as PlaybackState;
}

async function waitForSourceGateLow(page: Page): Promise<void> {
  await page.waitForFunction((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      __engine: () => { read: (node: unknown, key: string) => unknown };
    };
    const snapshot = w.__engine().read(w.__patch.nodes[id], 'snapshot') as { ch2?: Float32Array } | undefined;
    if (!snapshot?.ch2?.length) return false;
    return snapshot.ch2.subarray(-128).every((value) => Math.abs(value) < 0.001);
  }, SCOPE);
}

async function routeManualGate(page: Page, port: 'trigger' | 'phase_trigger' | 'loop' | 'reverse'): Promise<void> {
  await setNodeParams(page, 'ph-source', { pos_x: 0 });
  await waitForSourceGateLow(page);
  await page.evaluate(({ nodeId, portId }) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (f: () => void) => void };
    };
    w.__ydoc.transact(() => {
      // A shipping re-patch removes one cable and creates another. The audio
      // reconciler treats existing IDs as connected, so replacing endpoints
      // under the same ID would only change the drawing, not the live wire.
      for (const edgeId of Object.keys(w.__patch.edges)) {
        if (edgeId.startsWith('ph-gate-target')) delete w.__patch.edges[edgeId];
      }
      const edgeId = `ph-gate-target-${portId}`;
      w.__patch.edges[edgeId] = {
        id: edgeId,
        source: { nodeId: 'ph-gate', portId: 'gate' },
        target: { nodeId, portId },
        sourceType: 'gate', targetType: 'gate',
      };
    });
  }, { nodeId: NODE, portId: port });
  await settle(page);
}

async function spawnWiredPhases(page: Page): Promise<void> {
  await spawnPatch(page, [
    { id: NODE, type: 'phases', position: { x: 180, y: 100 }, params: { length: 0.2 } },
    { id: 'ph-source', type: 'joystick', position: { x: 430, y: 100 }, params: { pos_x: 0, pos_y: 0 } },
    { id: 'ph-gate', type: 'gatemaiden', position: { x: 620, y: 100 }, params: { gateLen: 0.005, trigShape: 1 } },
    { id: SCOPE, type: 'scope', position: { x: 820, y: 100 } },
  ], [
    { id: 'ph-manual-cv', from: { nodeId: 'ph-source', portId: 'x' }, to: { nodeId: 'ph-gate', portId: 'in' }, sourceType: 'cv', targetType: 'gate' },
    { id: 'ph-gate-target', from: { nodeId: 'ph-gate', portId: 'gate' }, to: { nodeId: NODE, portId: 'trigger' }, sourceType: 'gate', targetType: 'gate' },
    { id: 'ph-out', from: { nodeId: NODE, portId: 'phase_cv' }, to: { nodeId: SCOPE, portId: 'ch1' }, sourceType: 'cv', targetType: 'audio' },
    { id: 'ph-gate-probe', from: { nodeId: 'ph-gate', portId: 'gate' }, to: { nodeId: SCOPE, portId: 'ch2' }, sourceType: 'gate', targetType: 'audio' },
  ]);
  await seedPhases(page, NODE, [
    { x: 0, y: 0, shape: 0 },
    { x: 0.4, y: 0.25, shape: 0 },
    { x: 1, y: 1, shape: 0 },
  ]);
  await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (domain: string) => { ctx: AudioContext } };
    };
    await w.__engine().getDomain('audio').ctx.resume();
  });
  await waitForPlayback(page, { position: 0, playing: false });
}

test('an unpatched Phases runs its real playhead from the face Trigger and Loop controls', async ({ page, errorWatch }) => {
  await spawnPatch(page, [{
    id: NODE, type: 'phases', position: { x: 180, y: 100 }, params: { length: 0.6 },
  }]);
  await seedPhases(page, NODE, [{ x: 0, y: 0, shape: 0 }, { x: 1, y: 1, shape: 0 }]);
  const dock = await openPhasesDock(page, NODE);
  await dock.getByTestId(`phases-trigger-${NODE}`).click();
  await waitForPlayback(page, { playing: true });
  const playhead = dock.getByTestId(`phases-playhead-${NODE}`);
  await expect(playhead).toHaveAttribute('data-running', 'true');
  await waitForPlayback(page, { playing: false, position: 1 });
  await expect(playhead).toHaveAttribute('data-position', '1');

  // There is no downstream consumer anywhere in this graph. A worklet culled
  // without an output connection cannot satisfy either transport observation.
  await dock.getByTestId('control-loop').click();
  await waitForPlayback(page, { loop: true, playing: true });
  await expect(playhead).toHaveAttribute('data-running', 'true');
});

test('real gate cables trigger and retrigger phases; Phase CV reaches the scope and reverse ends at the first vertex', async ({ page, errorWatch }) => {
  await spawnWiredPhases(page);
  const before = await readScopePeakOverWindow(page, SCOPE, 150);
  expect(before.peak, `initial endpoint is zero; ${describeScopeWindow(before)}`).toBeLessThan(0.01);

  await setNodeParams(page, 'ph-source', { pos_x: 1 });
  await waitForPlayback(page, { position: 1, playing: false });
  const after = await readScopePeakOverWindow(page, SCOPE, 3000, { untilPeak: 0.95 });
  expect(after.peak, `a real rising gate played the envelope to its held final voltage; ${describeScopeWindow(after)}`).toBeGreaterThan(0.95);
  await settle(page);
  await waitForPlayback(page, { position: 1, playing: false });

  // From a completed one-shot, Phase Trigger restarts the last phase, whose
  // left edge is x=.4. A global restart would report playing near zero.
  await routeManualGate(page, 'phase_trigger');
  await setNodeParams(page, NODE, { length: 2 });
  await setNodeParams(page, 'ph-source', { pos_x: 1 });
  const phaseRestart = await waitForPlayback(page, { playing: true });
  expect(phaseRestart.position, 'Phase Trigger begins the current phase, not the entire envelope').toBeGreaterThanOrEqual(0.4);
  expect(phaseRestart.position).toBeLessThan(1);
  await waitForPlayback(page, { position: 1, playing: false });

  const dock = await openPhasesDock(page, NODE);
  await dock.getByTestId('control-reverse').click();
  await expect(dock.getByTestId('control-reverse')).toHaveAttribute('aria-checked', 'true');
  await routeManualGate(page, 'trigger');
  await setNodeParams(page, NODE, { length: 0.2 });
  await setNodeParams(page, 'ph-source', { pos_x: 1 });
  await waitForPlayback(page, { position: 0, playing: false, reverse: true });
  await expect(dock.getByTestId(`phases-playhead-${NODE}`)).toHaveAttribute('data-position', '0');
  await page.waitForFunction((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { read: (node: unknown, key: string) => unknown };
    };
    const snapshot = w.__engine().read(w.__patch.nodes[id], 'snapshot') as { ch1?: Float32Array } | undefined;
    return !!snapshot?.ch1?.length && snapshot.ch1.subarray(-128).every((value) => Math.abs(value) < 0.001);
  }, SCOPE);
});

test('external Loop and Reverse edges update the live buttons; clicking a live button turns that mode off', async ({ page, errorWatch }) => {
  await spawnWiredPhases(page);
  const dock = await openPhasesDock(page, NODE);
  for (const mode of ['loop', 'reverse'] as const) {
    await routeManualGate(page, mode);
    await setNodeParams(page, 'ph-source', { pos_x: 1 });
    const gateOn = await waitForPlayback(page, { [mode]: true });
    const control = dock.getByTestId(`control-${mode}`);
    await expect(control).toHaveAttribute('aria-checked', 'true');
    const stored = await page.evaluate(({ id, key }) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } };
      return w.__patch.nodes[id]!.params[key] ?? 0;
    }, { id: NODE, key: mode });
    expect(stored, 'external edges change runtime mode without rewriting saved panel intent').toBe(0);

    // Regression control: flipping the STORED zero would write one again and
    // leave the displayed mode on. This must flip the EFFECTIVE live mode.
    await control.click();
    await waitForPlayback(page, { [mode]: false }, gateOn.modeRevision ?? 0);
    await expect(control).toHaveAttribute('aria-checked', 'false');
  }
});

test('Length CV overrides both extremes of the knob, and unplugging restores the knob', async ({ page, errorWatch }) => {
  await spawnWiredPhases(page);
  const dock = await openPhasesDock(page, NODE);
  const length = dock.getByTestId('control-length');
  await setNodeParams(page, NODE, { length: 30 });
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (f: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.edges['ph-length'] = {
        id: 'ph-length', source: { nodeId: 'ph-source', portId: 'y' },
        target: { nodeId: id, portId: 'length_cv' }, sourceType: 'cv', targetType: 'cv',
      };
    });
  }, NODE);
  await waitForPlayback(page, { effectiveLength: 0.05, lengthCvPatched: true });
  await expect(length, 'the motorized knob displays the effective patched minimum').toHaveAttribute('aria-valuenow', /^0\.05/);
  expect(Number(await length.getAttribute('aria-valuenow'))).toBeCloseTo(0.05, 5);
  await setNodeParams(page, 'ph-source', { pos_y: 1 });
  await waitForPlayback(page, { effectiveLength: 30, lengthCvPatched: true });
  await setNodeParams(page, NODE, { length: 0.05 });
  await settle(page);
  await waitForPlayback(page, { effectiveLength: 30, lengthCvPatched: true });
  await expect(length, 'stored minimum cannot attenuate the patched maximum').toHaveAttribute('aria-valuenow', '30');

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (f: () => void) => void };
    };
    w.__ydoc.transact(() => { delete w.__patch.edges['ph-length']; });
  });
  await waitForPlayback(page, { effectiveLength: 0.05, lengthCvPatched: false });
  await expect(length).toHaveAttribute('aria-valuenow', /^0\.05/);
});
