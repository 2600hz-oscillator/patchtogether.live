// e2e/tests/rackspace-persistence.spec.ts
//
// End-to-end coverage for the rackspace-persistence audit (see
// .myrobots/plans/rackspace-persistence.md). The audit's claim is:
// "every asset stored under node.data already rides the Y.Doc, so the
// .imp.json export envelope captures everything by construction." This
// spec pins that claim from the browser side by:
//
//   1. Building a rack with PICTUREBOX bytes + DX7 user SYX bank +
//      sequencer step data + a custom node.data field.
//   2. Exporting an envelope via the dev __persistence.save() helper.
//   3. Wiping the live patch.
//   4. Importing the envelope back via __persistence.load().
//   5. Asserting every asset survived byte-for-byte.
//
// We DON'T test the Hocuspocus snapshot path here (that needs a running
// server + Postgres + a real /r/<id> page). The unit-test side covers
// envelope round-trip; the e2e Save-button test in save-load.spec.ts
// covers the file-download path. This spec adds the asset-payload
// dimension that neither of those exercises.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

interface PatchEnvelope {
  envelopeVersion: number;
  savedAt: string;
  moduleSchemas: Record<string, number>;
  update: string;
}

/**
 * Read the current contents of __patch.nodes as a plain JSON-cloned object,
 * stripping any Yjs proxies so we can compare structurally.
 */
async function readNodesSnapshot(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
    };
    return JSON.parse(JSON.stringify(w.__patch.nodes));
  });
}

test('rackspace-persistence: PICTUREBOX bytes + DX7 SYX + sequencer steps survive export → clear → import', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Spawn one of each "asset-bearing" module type. The spawnPatch helper
  // bypasses the palette + per-user cap (single-user dev mode); we set
  // node.data directly afterwards.
  await spawnPatch(
    page,
    [
      { id: 'pb', type: 'picturebox', domain: 'video' },
      { id: 'dx', type: 'dx7' },
      {
        id: 'seq',
        type: 'sequencer',
        params: { bpm: 180, length: 8, isPlaying: 0, gateLength: 0.4 },
      },
    ],
    [],
  );

  // Stamp realistic asset payloads onto node.data.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      // ---- PICTUREBOX: a chunky base64 payload (~24 KB of base64 text).
      const seed = Array.from({ length: 4096 }, (_, i) =>
        String.fromCharCode((i * 31 + 7) & 0xff),
      ).join('');
      const imageBytes = btoa(seed).repeat(4);
      const pb = w.__patch.nodes['pb'];
      if (pb) {
        pb.data = {
          imageBytes,
          imageMime: 'image/jpeg',
          imageName: 'photo.jpg',
          creatorId: 'user_e2e',
        };
      }
      // ---- DX7: 32-voice user bank (DX7Voice-shaped) + selected preset.
      const userPatches = Array.from({ length: 32 }, (_, i) => ({
        name: `USER ${String(i).padStart(2, '0')}`,
        algorithm: (i % 32) + 1,
        feedback: i % 8,
        operators: Array.from({ length: 6 }, (_, opIdx) => ({
          r: [99 - opIdx, 50, 30, 60],
          l: [99, 70, 50, 0],
          ratio: opIdx === 0 ? 1 : opIdx + 1,
          level: 99 - opIdx * 8,
          detune: 7,
          detuneFactor: 1.0,
          velocitySens: 4,
          fixedMode: false,
        })),
        pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
        lfo: { speed: 35, delay: 0, pmd: 0, amd: 0, sync: false, waveform: 0, pitchModSens: 0 },
        transpose: 24,
      }));
      const dx = w.__patch.nodes['dx'];
      if (dx) {
        dx.data = { preset: 'USER 03', userPatches };
      }
      // ---- Sequencer: 8 steps with notes (proves the existing path
      // also keeps working under our new test).
      const seq = w.__patch.nodes['seq'];
      if (seq) {
        seq.data = {
          steps: [
            { on: true, midi: 60 }, { on: true, midi: 67 },
            { on: false, midi: null }, { on: true, midi: 72 },
            { on: true, midi: 67 }, { on: false, midi: null },
            { on: true, midi: 65 }, { on: true, midi: 64 },
          ],
        };
      }
    });
  });

  // Snapshot pre-export.
  const before = await readNodesSnapshot(page);

  // Save → clear → load round-trip.
  const env = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __persistence: { save: () => unknown; load: (env: unknown) => unknown };
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    const envelope = w.__persistence.save();
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
    return envelope as PatchEnvelope;
  });

  // Quick envelope-shape sanity (covered more thoroughly in save-load.spec).
  expect(env.envelopeVersion).toBe(1);
  expect(typeof env.savedAt).toBe('string');
  expect(env.update.length).toBeGreaterThan(1000); // fat: bytes + 32 voices

  // Verify we actually cleared.
  const cleared = await readNodesSnapshot(page);
  expect(Object.keys(cleared)).toHaveLength(0);

  // Re-import and assert each asset class.
  await page.evaluate((envIn) => {
    const w = globalThis as unknown as {
      __persistence: { load: (env: unknown) => unknown };
    };
    w.__persistence.load(envIn);
  }, env);

  const after = await readNodesSnapshot(page);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

  // ---- PICTUREBOX bytes preserved ----
  const pbBefore = (before as Record<string, { data: { imageBytes: string; imageName: string; creatorId: string } }>)['pb'];
  const pbAfter = (after as Record<string, { data: { imageBytes: string; imageName: string; creatorId: string } }>)['pb'];
  expect(pbAfter).toBeDefined();
  expect(pbAfter.data.imageBytes.length).toBe(pbBefore.data.imageBytes.length);
  expect(pbAfter.data.imageBytes).toBe(pbBefore.data.imageBytes);
  expect(pbAfter.data.imageName).toBe('photo.jpg');
  expect(pbAfter.data.creatorId).toBe('user_e2e');

  // ---- DX7 SYX bank preserved ----
  const dxAfter = (after as Record<string, { data: { preset: string; userPatches: Array<{ name: string; algorithm: number; operators: Array<{ r: number[]; level: number }> }> } }>)['dx'];
  expect(dxAfter).toBeDefined();
  expect(dxAfter.data.preset).toBe('USER 03');
  expect(dxAfter.data.userPatches).toHaveLength(32);
  expect(dxAfter.data.userPatches[0]?.name).toBe('USER 00');
  expect(dxAfter.data.userPatches[31]?.name).toBe('USER 31');
  expect(dxAfter.data.userPatches[3]?.algorithm).toBe(4);
  // Per-op structural integrity.
  expect(dxAfter.data.userPatches[0]?.operators).toHaveLength(6);
  expect(dxAfter.data.userPatches[0]?.operators[0]?.r).toEqual([99, 50, 30, 60]);
  expect(dxAfter.data.userPatches[0]?.operators[5]?.level).toBe(99 - 5 * 8);

  // ---- Sequencer steps preserved ----
  const seqAfter = (after as Record<string, { data: { steps: Array<{ on: boolean; midi: number | null }> } }>)['seq'];
  expect(seqAfter).toBeDefined();
  expect(seqAfter.data.steps).toHaveLength(8);
  expect(seqAfter.data.steps[0]).toEqual({ on: true, midi: 60 });
  expect(seqAfter.data.steps[3]).toEqual({ on: true, midi: 72 });
});

test('rackspace-persistence: docs page renders with the persistence overview', async ({
  page,
}) => {
  // The docs subtree is statically prerendered; this just proves the page
  // is wired into the docs index and not 404'ing.
  await page.goto('/docs/rackspace-persistence');
  await expect(page.locator('h1')).toContainText('rackspace persistence');
  // Spot-check a few headings so a future rename of the page can't silently
  // strip its core sections.
  await expect(page.locator('h2')).toContainText(['tl;dr']);
  await expect(page.getByText('the three tiers')).toBeVisible();
  await expect(page.getByText('the .imp.json envelope')).toBeVisible();
});
