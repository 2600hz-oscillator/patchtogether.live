// Edited PHASES states supplement the default compact/dock shell baselines.
// SVG geometry is deterministic. The one transport scene plays a REAL reverse
// one-shot to its exact endpoint before freezing, so no synthetic playhead or
// timestamp-selected animation frame can conceal an incorrect runtime state.
// Linux CI authors canonical snapshots; local captures are diagnostic only.
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  assertFaceAudioFrozen,
  awaitCaptureBoxSettled,
  bootWithFace,
  foldViewportFor,
  frameMember,
  freezeFaceAudio,
  openDock,
  settle,
  unfoldDockPane,
} from './_shell-faces';
import { resumeAudioContext } from './vrt-audio-freeze';
import { setNodeParams } from '../tests/_module-coverage-helpers';
import {
  PHASES_EDITED,
  clickPhasePoint,
  phasesLane,
  readPhases,
  readPhasesLaneLayout,
  seedPhases,
} from '../tests/_phases-helpers';

test.describe.configure({ mode: 'default', timeout: 90_000 });

async function editedFace(page: Page): Promise<{ id: string; face: Locator; editor: Locator }> {
  await page.setViewportSize(foldViewportFor('phases'));
  const id = await bootWithFace(page, 'phases');
  await frameMember(page, id, 0.7, 'full');
  const face = await openDock(page, id, 1);
  await unfoldDockPane(page);
  await seedPhases(page, id, PHASES_EDITED);
  const editor = face.getByTestId(`phases-editor-${id}`);
  await expect(editor.locator(`[data-testid^="phases-vertex-${id}-"]`)).toHaveCount(PHASES_EDITED.length);
  return { id, face, editor };
}

async function capture(page: Page, face: Locator, name: string, menu?: Locator): Promise<void> {
  await freezeFaceAudio(page, name);
  await page.mouse.move(0, 0);
  await settle(page);
  await assertFaceAudioFrozen(page, name);
  await awaitCaptureBoxSettled(face, name);
  if (menu) {
    // The menu is portaled, so a face-only crop may cut off its right edge.
    // Capture the measured union, including its shadow, and prove that the
    // complete menu is in the viewport before comparing pixels.
    const faceBox = await face.boundingBox();
    const menuBox = await menu.boundingBox();
    if (!faceBox || !menuBox) throw new Error('Phases menu scene has an unmeasurable capture surface');
    const viewport = page.viewportSize()!;
    const x = Math.max(0, Math.floor(Math.min(faceBox.x, menuBox.x - 8)));
    const y = Math.max(0, Math.floor(Math.min(faceBox.y, menuBox.y - 8)));
    const right = Math.ceil(Math.max(faceBox.x + faceBox.width, menuBox.x + menuBox.width + 8));
    const bottom = Math.ceil(Math.max(faceBox.y + faceBox.height, menuBox.y + menuBox.height + 8));
    expect(right, 'the menu capture is fully inside the viewport').toBeLessThanOrEqual(viewport.width);
    expect(bottom, 'the menu capture is fully inside the viewport').toBeLessThanOrEqual(viewport.height);
    await expect(page).toHaveScreenshot(`${name}.png`, {
      clip: { x, y, width: right - x, height: bottom - y }, maxDiffPixels: 0,
    });
    return;
  }
  await expect(face).toHaveScreenshot(`${name}.png`, { maxDiffPixels: 0 });
}

test('phases-full-selected: lane controls and the shape editor fit at compact and full tiers', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await bootWithFace(page, 'phases');
  await seedPhases(page, id, PHASES_EDITED);
  const lane = phasesLane(page, id);
  for (const [tier, zoom] of [['compact', 0.45], ['full', 0.7]] as const) {
    await frameMember(page, id, zoom, tier);
    await clickPhasePoint(page, lane.getByTestId(`phases-editor-${id}`), 0.43, 0.98);
    await expect(lane.getByTestId(`phases-shape-${id}`)).toHaveAttribute('aria-valuenow', '0.5');
    await settle(page);
    const layout = await readPhasesLaneLayout(lane);
    expect(layout.cells.map((cell) => cell.key)).toEqual(['length', 'loop', 'polarity']);
    expect(layout.problems, `${tier}: ${JSON.stringify(layout)}`).toEqual([]);
  }
  await capture(page, lane, 'phases-full-selected');
  expect(errors).toEqual([]);
});

test('phases-unipolar-concave: selected curve and independent neighboring shapes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { id, face, editor } = await editedFace(page);
  await clickPhasePoint(page, editor, 0.43, 0.98);
  await expect(editor.getByTestId(`phases-phase-${id}-1`)).toHaveAttribute('data-selected', 'true');
  await expect(face.getByTestId(`phases-shape-${id}`)).toHaveAttribute('aria-valuenow', '0.5');
  await expect(editor.getByTestId(`phases-zero-${id}`)).toHaveCount(0);
  await capture(page, face, 'phases-unipolar-concave');
  expect(errors).toEqual([]);
});

test('phases-bipolar-reverse: center zero and a real reverse playhead at the terminal endpoint', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { id, face, editor } = await editedFace(page);
  await setNodeParams(page, id, { polarity: 1, reverse: 1, length: 0.6 });
  expect((await resumeAudioContext(page)).state).toBe('running');
  await page.waitForFunction((nodeId) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (domain: string) => { read: (id: string, key: string) => unknown } };
    };
    return (w.__engine().getDomain('audio').read(nodeId, 'state') as { reverse?: boolean } | undefined)?.reverse === true;
  }, id);
  await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __engine: () => { write: (node: unknown, key: string, value: unknown) => void };
    };
    w.__engine().write(w.__patch.nodes[nodeId], 'trigger', null);
  }, id);
  // Observe the active pass first: the initial stopped position is also zero,
  // and accepting it would produce a plausible but unexercised reverse scene.
  await page.waitForFunction((nodeId) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (domain: string) => { read: (id: string, key: string) => unknown } };
    };
    const state = w.__engine().getDomain('audio').read(nodeId, 'state') as { playing: boolean; position: number } | undefined;
    return state?.playing && state.position > 0;
  }, id);
  await page.waitForFunction((nodeId) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (domain: string) => { read: (id: string, key: string) => unknown } };
    };
    const state = w.__engine().getDomain('audio').read(nodeId, 'state') as { playing: boolean; position: number } | undefined;
    return state?.playing === false && state.position === 0;
  }, id);
  // The moving circle leaves different retained SVG edge rasters depending on
  // which audio frames were painted. Reopen the real dock after the observed
  // endpoint to render the same graph and runtime state on a fresh surface.
  // Three fresh mounts were byte-identical; the old retained surface varied at
  // two pixels above the unchanged comparator's antialiasing band.
  await freezeFaceAudio(page, 'reverse endpoint before dock reopen');
  await phasesLane(page, id).getByTestId('shell-open-dock').click();
  await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
  await openDock(page, id, 1);
  await unfoldDockPane(page);
  await clickPhasePoint(page, editor, 0.8, 0.98);
  await expect(editor.getByTestId(`phases-zero-${id}`)).toHaveCount(1);
  await expect(editor.getByTestId(`phases-playhead-${id}`)).toHaveAttribute('data-position', '0');
  await expect(editor.getByTestId(`phases-playhead-${id}`)).toHaveAttribute('data-running', 'false');
  await expect(editor.getByTestId(`phases-playhead-${id}`)).toHaveAttribute('data-direction', 'reverse');
  await expect(face.getByTestId('control-reverse')).toHaveAttribute('aria-checked', 'true');
  expect(await readPhases(page, id), 'polarity and playback do not move the drawing').toEqual(PHASES_EDITED);
  await capture(page, face, 'phases-bipolar-reverse');
  expect(errors).toEqual([]);
});

test('phases-delete-vertex: context menu and the resulting merged left curve', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { id, face, editor } = await editedFace(page);
  await editor.getByTestId(`phases-vertex-${id}-2`).click({ button: 'right' });
  const remove = page.getByRole('menuitem', { name: 'Delete vertex', exact: true });
  await expect(remove).toBeVisible();
  await capture(page, face, 'phases-delete-menu', page.getByTestId(`phases-vertex-menu-${id}`));
  await remove.click();
  await expect(editor.locator(`[data-testid^="phases-vertex-${id}-"]`)).toHaveCount(3);
  expect(await readPhases(page, id)).toEqual([PHASES_EDITED[0], PHASES_EDITED[1], PHASES_EDITED[3]]);
  await clickPhasePoint(page, editor, 0.65, 0.98);
  await expect(face.getByTestId(`phases-shape-${id}`)).toHaveAttribute('aria-valuenow', '0.5');
  await capture(page, face, 'phases-merged-left-curve');
  expect(errors).toEqual([]);
});
