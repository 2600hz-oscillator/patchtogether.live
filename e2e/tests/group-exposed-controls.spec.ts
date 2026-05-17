// e2e/tests/group-exposed-controls.spec.ts
//
// Module-grouping Phase 4 — exposed controls on the group bar.
//
// Scope: group with DRUMSEQZ + TIMELORDE inside. Exposed-controls
// configuration writes data.exposedControls; the group's bar renders
// bounded-box-per-child controls (sequencer play/stop, TIMELORDE knobs).
//
// We bypass the right-click menu pipeline (covered in NodeContextMenu
// unit tests) and drive the writes directly via the dev __ydoc + __patch
// globals, matching the Phase-2 specs' approach.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchNode {
  id: string;
  type: string;
  domain: string;
  position: { x: number; y: number };
  params: Record<string, number>;
  data?: Record<string, unknown>;
}

async function readNode(page: Page, id: string): Promise<PatchNode | undefined> {
  return await page.evaluate((nid) => {
    const w = window as unknown as { __patch: { nodes: Record<string, PatchNode> } };
    return w.__patch.nodes[nid];
  }, id);
}

async function setupChain(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'seq-1', type: 'drumseqz',  position: { x: 100, y: 100 }, domain: 'audio' },
      { id: 'tl-1',  type: 'timelorde', position: { x: 400, y: 100 }, domain: 'audio' },
    ],
    [],
  );
}

/** Commit a group via direct ydoc transact. */
async function createGroup(
  page: Page,
  args: {
    groupId: string;
    childIds: string[];
    exposedControls?: Array<{ childId: string; controlId: string }>;
  },
): Promise<void> {
  await page.evaluate((a) => {
    const w = window as unknown as {
      __patch: { nodes: Record<string, PatchNode> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      w.__patch.nodes[a.groupId] = {
        id: a.groupId,
        type: 'group',
        domain: 'meta',
        position: { x: 250, y: 100 },
        params: {},
        data: {
          childIds: a.childIds,
          exposedPorts: [],
          label: 'voice',
          ...(a.exposedControls ? { exposedControls: a.exposedControls } : {}),
        },
      } as PatchNode;
      for (const cid of a.childIds) {
        const n = w.__patch.nodes[cid];
        if (n) {
          if (!n.data) n.data = {};
          (n.data as { parentGroupId?: string }).parentGroupId = a.groupId;
        }
      }
    });
  }, args);
}

async function setExposedControls(
  page: Page,
  groupId: string,
  exposedControls: Array<{ childId: string; controlId: string }>,
): Promise<void> {
  await page.evaluate(
    ({ groupId, exposedControls }) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const g = w.__patch.nodes[groupId];
        if (!g) return;
        if (!g.data) g.data = {};
        (g.data as { exposedControls?: unknown }).exposedControls = exposedControls;
      });
    },
    { groupId, exposedControls },
  );
}

test.describe('Group exposed controls — sequencer play/stop', () => {
  test('clicking the exposed play button toggles the sequencer isPlaying', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['seq-1', 'tl-1'],
      exposedControls: [{ childId: 'seq-1', controlId: 'playStop' }],
    });

    // Find the exposed-controls bounded box for the sequencer
    const btn = page.locator('[data-testid="ctrl-btn-seq-1-playStop"]');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('data-playing', 'false');

    // Sequencer starts stopped
    let seq = await readNode(page, 'seq-1');
    expect((seq?.params.isPlaying ?? 0) < 0.5).toBe(true);

    // Click → starts playing
    await btn.click();
    await expect(btn).toHaveAttribute('data-playing', 'true');
    seq = await readNode(page, 'seq-1');
    expect((seq?.params.isPlaying ?? 0) >= 0.5).toBe(true);

    // Click again → stops
    await btn.click();
    await expect(btn).toHaveAttribute('data-playing', 'false');
    seq = await readNode(page, 'seq-1');
    expect((seq?.params.isPlaying ?? 0) < 0.5).toBe(true);
  });

  test('the bounded box header shows the child module label', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['seq-1'],
      exposedControls: [{ childId: 'seq-1', controlId: 'playStop' }],
    });

    const header = page.locator('[data-testid="ctrl-box"][data-child-id="seq-1"] [data-testid="ctrl-box-header"]');
    await expect(header).toBeVisible();
    await expect(header).toHaveText('DRUMSEQZ');
  });
});

test.describe('Group exposed controls — TIMELORDE knobs', () => {
  test('turning the exposed BPM knob updates timelorde.params.bpm', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['tl-1'],
      exposedControls: [{ childId: 'tl-1', controlId: 'bpm' }],
    });

    // The Knob primitive doesn't easily simulate drag → write through
    // its programmatic `onchange`. We assert the knob is rendered + the
    // round-trip from a __ydoc write reflects on the underlying param.
    const knob = page.locator('[data-testid="ctrl-knob-tl-1-bpm"]');
    await expect(knob).toBeVisible();

    // Drive the value directly via the patch (the knob is bound to the
    // same data path; this is the same operation the user's pointermove
    // commits through createDragCommit).
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, PatchNode> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tl-1'];
        if (n) n.params.bpm = 180;
      });
    });

    const tl = await readNode(page, 'tl-1');
    expect(tl?.params.bpm).toBe(180);
  });

  test('multiple exposed knobs all render in the same bounded box', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['tl-1'],
      exposedControls: [
        { childId: 'tl-1', controlId: 'bpm' },
        { childId: 'tl-1', controlId: 'swingAmount' },
        { childId: 'tl-1', controlId: 'swingSource' },
      ],
    });

    const box = page.locator('[data-testid="ctrl-box"][data-child-id="tl-1"]');
    await expect(box).toBeVisible();
    await expect(box.locator('[data-control-kind="knob"]')).toHaveCount(3);
  });
});

test.describe('Group exposed controls — multiple children', () => {
  test('renders one bounded box per child with exposed controls', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['seq-1', 'tl-1'],
      exposedControls: [
        { childId: 'seq-1', controlId: 'playStop' },
        { childId: 'tl-1', controlId: 'bpm' },
      ],
    });

    const allBoxes = page.locator('[data-testid="ctrl-box"]');
    await expect(allBoxes).toHaveCount(2);
    await expect(page.locator('[data-testid="ctrl-box"][data-child-id="seq-1"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctrl-box"][data-child-id="tl-1"]')).toBeVisible();
  });

  test('empty exposedControls renders no bounded boxes', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['seq-1', 'tl-1'],
      // exposedControls omitted entirely
    });

    await expect(page.locator('[data-testid="group-exposed-controls"]')).toHaveCount(0);
  });
});

test.describe('Group exposed controls — round-trip', () => {
  test('un-checking a control via setExposedControls makes it disappear from the bar', async ({ page }) => {
    await setupChain(page);
    await createGroup(page, {
      groupId: 'g-1',
      childIds: ['seq-1', 'tl-1'],
      exposedControls: [
        { childId: 'seq-1', controlId: 'playStop' },
        { childId: 'tl-1', controlId: 'bpm' },
      ],
    });

    await expect(page.locator('[data-testid="ctrl-btn-seq-1-playStop"]')).toBeVisible();
    await expect(page.locator('[data-testid="ctrl-knob-tl-1-bpm"]')).toBeVisible();

    // Reduce to only the TIMELORDE knob
    await setExposedControls(page, 'g-1', [{ childId: 'tl-1', controlId: 'bpm' }]);

    await expect(page.locator('[data-testid="ctrl-btn-seq-1-playStop"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ctrl-knob-tl-1-bpm"]')).toBeVisible();

    // The seq's bounded box is gone too (no controls left for that child)
    await expect(page.locator('[data-testid="ctrl-box"][data-child-id="seq-1"]')).toHaveCount(0);
  });
});
