// e2e/tests/combinations.spec.ts
//
// Multi-module patches — verify the engine can instantiate and connect
// realistic signal chains without exploding.

import { test, expect } from '@playwright/test';
import { spawnPatch, readStatus } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('chain: VCO → Filter → Audio Out plays with no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco', position: { x: 50, y: 100 } },
      { id: 'flt', type: 'filter',    position: { x: 350, y: 100 } },
      { id: 'out', type: 'audioOut',  position: { x: 650, y: 100 }, params: { master: 0.2 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' },   to: { nodeId: 'flt', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'flt', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  expect(await readStatus(page, 'nodes')).toBe('3');
  expect(await readStatus(page, 'edges')).toBe('2');
  expect(await readStatus(page, 'ctx')).toBe('running');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('chain: ADSR-shaped voice (VCO + ADSR → VCA → Audio Out)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco' },
      { id: 'env', type: 'adsr' },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'out', type: 'audioOut', params: { master: 0.2 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e2', from: { nodeId: 'env', portId: 'env' }, to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e3', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  expect(await readStatus(page, 'nodes')).toBe('4');
  expect(await readStatus(page, 'edges')).toBe('3');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('chain: VCO → Mixer (one channel) → Reverb → Audio Out', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco' },
      { id: 'mix', type: 'mixer' },
      { id: 'rev', type: 'reverb' },
      { id: 'out', type: 'audioOut', params: { master: 0.2 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' },   to: { nodeId: 'mix', portId: 'in1' } },
      { id: 'e2', from: { nodeId: 'mix', portId: 'audio' }, to: { nodeId: 'rev', portId: 'audio' } },
      { id: 'e3', from: { nodeId: 'rev', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  expect(await readStatus(page, 'nodes')).toBe('4');
  expect(await readStatus(page, 'edges')).toBe('3');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('chain: Sequencer → VCO → VCA (gated by ADSR) → Audio Out plays a riff', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      // Pre-populate steps so the sequencer plays something
      {
        id: 'seq', type: 'sequencer',
        params: { bpm: 240, length: 4 },
        position: { x: 50, y: 50 },
      },
      { id: 'vco', type: 'analogVco' },
      { id: 'env', type: 'adsr', params: { attack: 0.005, decay: 0.05, sustain: 0.6, release: 0.1 } },
      { id: 'vca', type: 'vca', params: { base: 0, cvAmount: 1 } },
      { id: 'out', type: 'audioOut', params: { master: 0.2 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'vco', portId: 'pitch' }, sourceType: 'pitch', targetType: 'pitch' },
      { id: 'e2', from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'env', portId: 'gate' },  sourceType: 'gate', targetType: 'gate' },
      { id: 'e3', from: { nodeId: 'vco', portId: 'saw' },   to: { nodeId: 'vca', portId: 'audio' } },
      { id: 'e4', from: { nodeId: 'env', portId: 'env' },   to: { nodeId: 'vca', portId: 'cv' }, sourceType: 'cv', targetType: 'cv' },
      { id: 'e5', from: { nodeId: 'vca', portId: 'audio' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  expect(await readStatus(page, 'nodes')).toBe('5');
  expect(await readStatus(page, 'edges')).toBe('5');

  // Sequencer's grid renders one page (16 cell-slots) at a time post-pages
  // PR. Data array is 128 wide; user navigates pages via the < / > buttons.
  await expect(page.locator('.svelte-flow__node-sequencer .cell-slot')).toHaveCount(16);

  expect(errors, errors.join('; ')).toEqual([]);
});

test('sequencer: clicking the gate button toggles its visual on-state', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(page, [{ id: 'seq', type: 'sequencer' }]);

  // Each step's gate is the .gate button under its NoteEntry. Click the first.
  const gate0 = page.locator('[data-testid="seq-gate-seq-0"]');
  await expect(gate0).not.toHaveClass(/\bon\b/);
  await gate0.click();
  await expect(gate0, 'gate should toggle on after click').toHaveClass(/\bon\b/);
});

test('chain: VCO → Scope → Audio Out — Scope passes through', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco' },
      { id: 'scp', type: 'scope' },
      { id: 'out', type: 'audioOut', params: { master: 0.2 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'saw' },     to: { nodeId: 'scp', portId: 'ch1' } },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' } },
    ]
  );

  // Scope card has a canvas — confirm it's there.
  await expect(
    page.locator('.svelte-flow__node-scope canvas'),
    'scope canvas'
  ).toBeVisible();

  expect(await readStatus(page, 'nodes')).toBe('3');
  expect(await readStatus(page, 'edges')).toBe('2');
  expect(errors, errors.join('; ')).toEqual([]);
});
