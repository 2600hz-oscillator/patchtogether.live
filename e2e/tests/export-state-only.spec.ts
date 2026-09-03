// e2e/tests/export-state-only.spec.ts
//
// File → "Export patch (current state only)" — the history-free .ptperf.zip.
//
// The menu row drives the REAL export handler (exportPerformanceZipStateOnly →
// buildPerformanceZipBytes(true) → savePerformanceZip), captured through a
// stubbed showSaveFilePicker so no native dialog opens. Asserted:
//   1. the row produces a performance zip (with the state-only default name);
//   2. after an aged session it is SMALLER than the default export of the
//      same rack (the point of the feature);
//   3. it loads back through the real zip-load path and reproduces the
//      rack's nodes + edges exactly.
//
// SHELL-READY: engine seams + File menu chrome only — no card-internal DOM.

import { test, expect, fileMenuClick } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('export state-only: menu row produces a smaller zip that round-trips the rack', async ({
  page,
  rack,
}) => {
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco' },
      { id: 'out', type: 'audioOut', params: { master: 0.4 } },
    ],
    [
      { id: 'e1', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'L' } },
      { id: 'e2', from: { nodeId: 'vco', portId: 'sine' }, to: { nodeId: 'out', portId: 'R' } },
    ],
  );

  // Age the doc: 600 knob-drag-shaped transactions. The last write puts tune
  // at a known value so the round-trip assertion pins real state, not luck.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    for (let t = 0; t < 600; t++) {
      w.__ydoc.transact(() => {
        w.__patch.nodes['vco'].params.tune = t % 36;
      });
    }
    w.__ydoc.transact(() => {
      w.__patch.nodes['vco'].params.tune = 5;
    });
  });

  // Stub the save dialog: capture the suggested name + written bytes.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __stateOnlySave?: { name: string | null; bytes: number[] | null };
      showSaveFilePicker?: unknown;
    };
    w.__stateOnlySave = { name: null, bytes: null };
    (w as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o?: { suggestedName?: string }) => {
      w.__stateOnlySave!.name = o?.suggestedName ?? null;
      return {
        createWritable: async () => ({
          write: async (d: Uint8Array) => {
            w.__stateOnlySave!.bytes = Array.from(d);
          },
          close: async () => {},
        }),
      };
    };
  });

  const before = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: unknown; edges: unknown } };
    return JSON.parse(JSON.stringify({ nodes: w.__patch.nodes, edges: w.__patch.edges })) as {
      nodes: Record<string, unknown>;
      edges: Record<string, unknown>;
    };
  });

  await fileMenuClick(page, 'workflow-file-save-performance-state-only');

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __stateOnlySave?: { bytes: number[] | null } }).__stateOnlySave
              ?.bytes?.length ?? 0,
        ),
      { message: 'state-only export wrote zip bytes through the save picker' },
    )
    .toBeGreaterThan(0);

  const stateOnly = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __stateOnlySave: { name: string | null; bytes: number[] };
      __perfZip: { export: () => Promise<Uint8Array> };
    };
    const full = await w.__perfZip.export();
    return { name: w.__stateOnlySave.name, size: w.__stateOnlySave.bytes.length, fullSize: full.length };
  });
  expect(stateOnly.name).toBe('performance-state.ptperf.zip');
  expect(
    stateOnly.size,
    `state-only zip (${stateOnly.size} B) must undercut the history-carrying export (${stateOnly.fullSize} B)`,
  ).toBeLessThan(stateOnly.fullSize);

  // Round-trip: clear the rack, load the captured state-only zip back through
  // the real zip-load path, and the materialized graph must be identical.
  await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __stateOnlySave: { bytes: number[] };
      __perfZip: { load: (b: Uint8Array) => Promise<void> };
      __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
      for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
    });
    await w.__perfZip.load(new Uint8Array(w.__stateOnlySave.bytes));
  });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
          return Object.keys(w.__patch.nodes).length;
        }),
      { message: 'loaded state-only zip repopulates the rack' },
    )
    .toBe(2);

  const after = await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: unknown; edges: unknown } };
    return JSON.parse(JSON.stringify({ nodes: w.__patch.nodes, edges: w.__patch.edges })) as {
      nodes: Record<string, unknown>;
      edges: Record<string, unknown>;
    };
  });
  expect(after.nodes).toEqual(before.nodes);
  expect(after.edges).toEqual(before.edges);
});
