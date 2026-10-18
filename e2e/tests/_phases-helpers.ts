import { expect, type Locator, type Page } from '@playwright/test';

export interface PhaseVertex {
  x: number;
  y: number;
  shape: number;
}

/** Deliberately asymmetric: polarity, direction and per-phase curves all
 * produce distinguishable states. These are test inputs, not a DSP mirror. */
export const PHASES_EDITED: readonly PhaseVertex[] = [
  { x: 0, y: 0.12, shape: 0 },
  { x: 0.24, y: 0.9, shape: 0.5 },
  { x: 0.62, y: 0.3, shape: 1 },
  { x: 1, y: 0.74, shape: 0 },
];

export function phasesLane(page: Page, nodeId: string): Locator {
  return page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
}

export async function openPhasesDock(page: Page, nodeId: string): Promise<Locator> {
  const lane = phasesLane(page, nodeId);
  await expect(lane).toBeVisible();
  await lane.getByTestId('shell-open-dock').click();
  const dock = page.getByTestId('dock-full-view').locator(
    `[data-testid="module-shell"][data-shell-node="${nodeId}"][data-shell-tier="dock"]`,
  );
  await expect(dock).toBeVisible();
  await expect(dock.getByTestId(`phases-editor-${nodeId}`)).toBeVisible();
  return dock;
}

export async function seedPhases(page: Page, nodeId: string, vertices: readonly PhaseVertex[]): Promise<void> {
  await page.evaluate(({ id, points }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (f: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const node = w.__patch.nodes[id];
      if (!node) throw new Error(`Phases fixture node ${id} is absent`);
      if (!node.data) node.data = {};
      node.data.vertices = points;
    });
  }, { id: nodeId, points: vertices.map((point) => ({ ...point })) });
}

export async function readPhases(page: Page, nodeId: string): Promise<PhaseVertex[]> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { vertices?: PhaseVertex[] } }> };
    };
    const points = w.__patch.nodes[id]?.data?.vertices;
    if (!points) throw new Error(`Phases ${id} has no persisted vertices`);
    return points.map(({ x, y, shape }) => ({ x, y, shape }));
  }, nodeId);
}

/** Convert through the actual SVG transform, including the lane's zoom.
 * Bounds are published by the editor that owns the geometry; the test never
 * repeats its padding or assumes that its CSS box equals its viewBox. */
export async function phaseScreenPoint(editor: Locator, x: number, y: number): Promise<{ x: number; y: number }> {
  return editor.evaluate((element, value) => {
    const svg = element as SVGSVGElement;
    const read = (name: string): number => {
      const raw = svg.getAttribute(`data-plot-${name}`);
      if (raw === null || !Number.isFinite(Number(raw))) {
        throw new Error(`Phases editor lacks a numeric data-plot-${name}`);
      }
      return Number(raw);
    };
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error('Phases editor has no screen transform');
    const point = svg.createSVGPoint();
    point.x = read('left') + value.x * read('width');
    point.y = read('top') + (1 - value.y) * read('height');
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, { x, y });
}

export async function clickPhasePoint(page: Page, editor: Locator, x: number, y: number): Promise<void> {
  const point = await phaseScreenPoint(editor, x, y);
  await page.mouse.click(point.x, point.y);
}

/** The shared knob uses 200 CSS px for one normalized turn. Driving an
 * actual pointer is necessary here: a graph write cannot prove the selected
 * phase's knob targets that phase. */
export async function dragPhaseShape(page: Page, knob: Locator, delta: number): Promise<void> {
  await knob.scrollIntoViewIfNeeded();
  const box = await knob.boundingBox();
  if (!box) throw new Error('Phase Shape knob has no visible box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - delta * 200, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
}

/** Read the actual painted controls as well as their grid cells. A cell may
 * remain inside the outer tile while its knob/caption spills into the editor;
 * checking only the tile boundary is structurally blind to that defect. */
export async function readPhasesLaneLayout(shell: Locator) {
  return shell.evaluate((root) => {
    const need = (selector: string): Element => {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`Phases layout probe cannot find ${selector}`);
      return element;
    };
    const box = (element: Element) => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    type Box = ReturnType<typeof box>;
    const shellBox = box(root);
    const body = box(need('.tile-body'));
    const editor = box(need('.phases-editor-wrap'));
    const grid = box(need('.phases-grid'));
    const toolbar = box(need('.editor-controls'));
    const toolbarItems = [...root.querySelectorAll('.editor-controls button, .editor-controls .knob-wrap')].map(box);
    const rail = box(need('[data-testid="lane-jack-rail"]'));
    const cells = [...root.querySelectorAll('.tile-body [data-cell-kind="param"]')].map((element) => ({
      key: element.getAttribute('data-cell-key') ?? '(unnamed)',
      box: box(element),
      painted: [...element.querySelectorAll('.knob-wrap, .toggle-ctl, .fader-wrap')].map(box),
    }));
    const problems: string[] = [];
    // Subpixel rounding allowance, not a layout or screenshot tolerance.
    const epsilon = 0.5;
    const inside = (name: string, child: Box, parent: Box): void => {
      if (!(child.width > 0 && child.height > 0)) problems.push(`${name} has no painted area`);
      if (child.left < parent.left - epsilon || child.right > parent.right + epsilon
        || child.top < parent.top - epsilon || child.bottom > parent.bottom + epsilon) {
        problems.push(`${name} exceeds its containing surface`);
      }
    };
    for (const [name, rectangle] of [['body', body], ['editor', editor], ['jack rail', rail]] as const) {
      inside(name, rectangle, shellBox);
    }
    inside('grid', grid, editor);
    inside('editor toolbar', toolbar, editor);
    for (const rectangle of toolbarItems) inside('editor toolbar control', rectangle, toolbar);
    if (grid.bottom > toolbar.top + epsilon) problems.push('grid overlaps editor toolbar');
    if (editor.bottom > rail.top + epsilon) problems.push('editor overlaps jack rail');
    if (!cells.length) problems.push('the control probe saw no cells');
    for (const cell of cells) {
      inside(`control ${cell.key}`, cell.box, body);
      if (!cell.painted.length) problems.push(`control ${cell.key} has no painted primitive`);
      for (const rectangle of [cell.box, ...cell.painted]) {
        if (rectangle.top < body.top - epsilon) problems.push(`control ${cell.key} crosses the body top`);
        if (rectangle.bottom > editor.top + epsilon) problems.push(`control ${cell.key} overlaps editor`);
      }
      for (const rectangle of cell.painted) inside(`painted control ${cell.key}`, rectangle, body);
    }
    return { tier: root.getAttribute('data-shell-tier'), shell: shellBox, body, editor, grid, toolbar, toolbarItems, rail, cells, problems };
  });
}
