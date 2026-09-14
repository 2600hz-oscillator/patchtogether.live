// File → "Export patch (current state only)" — the history-free .ptperf.zip.
//
// The menu row drives the REAL export handler (exportPerformanceZipStateOnly →
// buildPerformanceZipBytes(true) → savePerformanceZip), captured through a
// stubbed showSaveFilePicker so no native dialog opens. Asserted:
//   1. the row produces a performance zip (with the state-only default name);
//   2. after an aged session it is SMALLER than the default export of the
//      same rack (the point of the feature) — behind a negative control that
//      the aging really left history the default export carries;
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

  // The un-aged default export: the negative control's baseline. Building it
  // reads the live doc without writing to it (makePortableEnvelope works on a
  // throwaway copy), so it leaves no history of its own.
  const fullBefore = await page.evaluate(async () => {
    const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
    return (await w.__perfZip.export()).length;
  });

  // Age the doc with 600 transactions shaped like a real session: a module
  // added and removed (one transaction in three) interleaved with knob-drag
  // writes. Net-zero on STATE — the last write pins tune at a known value so
  // the round-trip assertion pins real state, not luck — but the CRDT history
  // it leaves is what the default export carries and the state-only sheds.
  //
  // ⚠ WHY NOT 600 KNOB WRITES ON ONE KEY. That shape flaked CI (run
  // 34889639648: "state-only zip (847 B) must undercut the history-carrying
  // export (847 B)"). Yjs merges consecutive same-key tombstones into ONE
  // struct (Item.mergeWith — same client, adjacent clocks, both deleted,
  // ContentDeleted lengths add), so 600 — or 6,000 — sets of `params.tune`
  // encode to 13 bytes of history. The ~50 B that still separated the two
  // exports was makePortableEnvelope's own x/y re-set, and the live doc's
  // random uint32 clientID is written as a varint once per struct reference:
  // a draw below 2^28 (1 in 16) is a byte narrower on ~43 references and
  // erased that gap. The assertion was a coin flip on a random id, not a test
  // of history. A scratch node on a NEW key has no left neighbour (origin =
  // null), so its tombstone can never merge — 200 of them are ~6 KB of
  // history no id draw can hide. The negative control below is what pins
  // this: a fixture Yjs can fold away fails there, by name.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    for (let t = 0; t < 600; t++) {
      w.__ydoc.transact(() => {
        if (t % 3 === 0) {
          // Add + remove in ONE transaction: Yjs raises no key event for an
          // entry inserted and deleted in the same transaction, so the
          // reconciler never sees the scratch module — only its tombstone stays.
          const id = `scratch-${t}`;
          w.__patch.nodes[id] = {
            id,
            type: 'analogVco',
            domain: 'audio',
            position: { x: t, y: t },
            params: { tune: t % 36 },
          } as never;
          delete w.__patch.nodes[id];
        } else {
          w.__patch.nodes['vco']!.params.tune = t % 36;
        }
      });
    }
    w.__ydoc.transact(() => {
      w.__patch.nodes['vco']!.params.tune = 5;
    });
  });

  // Stub the save dialog: capture the suggested name + written bytes.
  //
  // ⚠ `write` APPENDS — it does not assign. A real
  // `FileSystemWritableFileStream.write(chunk)` writes at the stream's current
  // position and advances it, so N calls produce one concatenated file. This
  // stub used to do `bytes = Array.from(d)`, which is only equivalent while the
  // producer happens to make exactly ONE call — and the export path now streams
  // the archive in bounded chunks (so a big save neither duplicates the whole
  // archive in memory nor blocks the main thread in one stretch). The
  // assignment silently kept the LAST chunk, i.e. the end of the central
  // directory, and the round-trip below then failed with "missing
  // performance.json" against a perfectly good save.
  //
  // Modelling the real API is the fix; asserting a single write would pin a
  // property of the OLD writer that the browser never guaranteed.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __stateOnlySave?: {
        name: string | null;
        bytes: number[] | null;
        writes: number;
        closed: boolean;
      };
      showSaveFilePicker?: unknown;
    };
    w.__stateOnlySave = { name: null, bytes: null, writes: 0, closed: false };
    (w as { showSaveFilePicker: unknown }).showSaveFilePicker = async (o?: { suggestedName?: string }) => {
      w.__stateOnlySave!.name = o?.suggestedName ?? null;
      return {
        createWritable: async () => ({
          write: async (d: Uint8Array) => {
            const s = w.__stateOnlySave!;
            s.writes++;
            s.bytes = s.bytes ? s.bytes.concat(Array.from(d)) : Array.from(d);
          },
          // ⚠ `closed` IS THE COMPLETION SIGNAL, and the reason the poll below
          // does not watch `bytes.length`. With a chunked writer the byte count
          // is non-zero after the FIRST chunk, so polling on it would read a
          // half-written archive and fail the round-trip intermittently — a
          // fixture racing the product, not a product bug. `close()` is the
          // only point at which a real file is complete.
          close: async () => {
            w.__stateOnlySave!.closed = true;
          },
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

  // Wait for the stream to CLOSE, not for the first byte — see the stub.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as unknown as { __stateOnlySave?: { closed: boolean } }).__stateOnlySave
              ?.closed ?? false,
        ),
      { message: 'state-only export closed the save stream (the file is complete)' },
    )
    .toBe(true);

  const stateOnly = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __stateOnlySave: { name: string | null; bytes: number[]; writes: number };
      __perfZip: { export: () => Promise<Uint8Array> };
    };
    const full = await w.__perfZip.export();
    return {
      name: w.__stateOnlySave.name,
      size: w.__stateOnlySave.bytes.length,
      writes: w.__stateOnlySave.writes,
      fullSize: full.length,
    };
  });
  expect(stateOnly.name).toBe('performance-state.ptperf.zip');
  // The save reached the picker at all. Chunk COUNT is deliberately not
  // asserted here — a small state-only manifest may legitimately be one chunk,
  // and the chunking contract is pinned in performance-zip.test.ts where the
  // payload can be made large enough for the assertion to mean something.
  expect(stateOnly.writes, 'the export wrote through the save stream').toBeGreaterThan(0);
  expect(stateOnly.size, 'the captured archive is non-empty').toBeGreaterThan(0);
  // NEGATIVE CONTROL on the fixture: the aging must have left history the
  // default export carries — more of it than the whole rack state weighs — so
  // a write shape Yjs can merge away (see the aging comment) fails HERE
  // instead of turning the assertion below into a coin flip.
  const grew = stateOnly.fullSize - fullBefore;
  expect(
    grew,
    `aging grew the default export by ${grew} B (${fullBefore} B → ${stateOnly.fullSize} B); that history must outweigh the state-only zip (${stateOnly.size} B)`,
  ).toBeGreaterThan(stateOnly.size);
  expect(
    stateOnly.size,
    `state-only zip (${stateOnly.size} B) must undercut the history-carrying export (${stateOnly.fullSize} B; un-aged ${fullBefore} B)`,
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
