// packages/web/src/lib/graph/retired-type-migration.test.ts
//
// THE MIGRATION GATE for the 2026-08-02 module swap: `callsine` and
// `warrenspectrum` were deleted and WARREN'S SPECTRUM (`warrensspectrum`)
// replaces them. The two predecessors take OPPOSITE paths on purpose, and
// this file asserts both — a test that only covered the alias would prove
// nothing about the drop, and vice versa.
//
//   ALIAS leg (`callsine`)       → the node SURVIVES at its saved id and
//                                  position, retyped, params reset, and
//                                  exactly the four ports whose semantics
//                                  match keep their cables.
//   DROP  leg (`warrenspectrum`) → the node is ABSENT, every one of its
//                                  cables is gone, and the user is TOLD.
//
// It runs against a COMMITTED fixture (`__fixtures__/retired-warrenspectrum
// .imp.json`) rather than a patch built in-process, because after this PR the
// two retired types no longer have defs at all — a rack carrying them can
// only come from a file, which is exactly the situation under test.
//
// ⚠ WHAT THIS CANNOT COVER, stated rather than papered over: the fixture is
// authored, then frozen. It proves the LOADER handles a retired type; it does
// not prove the fixture resembles any real user's rack. That gap is
// unclosable in-repo.
//
// ── THE NEGATIVE CONTROLS (run manually at authoring time, recorded in the
//    PR, and partly PERMANENT below) ──
//   * Empty `RETIRED_TYPE_ALIASES` → the ALIAS assertions must go red,
//     specifically the node-presence one. If they stayed green the fixture
//     never contained a `callsine` node and the whole leg proves nothing.
//   * Add `warrenspectrum` to the table → the DROP assertions must go red.
//     Without that leg "we chose not to alias it" would silently become
//     "someone aliased it and nothing noticed". `drops EVERY warrenspectrum
//     cable (exact count)` and `RETIRED_TYPE_ALIASES must not grow a
//     warrenspectrum entry` are the permanent versions of this control.

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadEnvelopeIntoStore,
  parseEnvelope,
  RETIRED_TYPE_ALIASES,
  RETIRED_TYPE_ALIAS_NOTES,
  type LivePatch,
  type LoadDiagnostic,
} from './persistence';
import { summarizeLoadDiagnostics } from './load-diagnostics';
import {
  warrensspectrumDef,
  WARRENSSPECTRUM_ALIASED_PORT_IDS,
} from '$lib/audio/modules/warrensspectrum';
import type { ModuleNode, Edge } from './types';

const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/retired-warrenspectrum.imp.json', import.meta.url),
);

/** The `warrenspectrum` cables in the fixture. Asserted EXACTLY (not `>= 1`)
 *  so an accidental future alias entry — which would make some of them
 *  survive — turns this red instead of quietly passing. */
const WARRENSPECTRUM_EDGE_IDS = [
  'e-ws-in',
  'e-ws-send3',
  'e-ws-ret3',
  'e-ws-send5',
  'e-ws-ret5',
  'e-ws-ping',
  'e-ws-out',
] as const;

function freshPatch(): { ydoc: Y.Doc; store: LivePatch } {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  return { ydoc: getYjsDoc(store), store: store as unknown as LivePatch };
}

describe('retired module types — the callsine ALIAS and the warrenspectrum DROP', () => {
  let diagnostics: LoadDiagnostic[];
  let nodes: Record<string, ModuleNode | undefined>;
  let edges: Record<string, Edge | undefined>;

  beforeAll(async () => {
    // Register the REAL registries — the loader resolves `warrensspectrum`,
    // `analogVco`, `kria`, `lfo`, `delay` and `audioOut` from them, so this
    // test exercises the shipped contract rather than a stub of it.
    await import('$lib/audio/modules');
    await import('$lib/video/modules');
    await import('$lib/meta/modules');

    const dest = freshPatch();
    const env = parseEnvelope(readFileSync(FIXTURE, 'utf8'));
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    diagnostics = result.diagnostics;
    nodes = dest.store.nodes;
    edges = dest.store.edges;
  });

  // ── ALIAS leg ──────────────────────────────────────────────────────────

  it('ALIAS: the callsine node SURVIVES, with its original id and position', () => {
    const n = nodes['cs-1'];
    expect(
      n,
      'the aliased node is missing — either RETIRED_TYPE_ALIASES lost its ' +
        'callsine entry, or the fixture never contained a callsine node ' +
        '(in which case this whole leg is vacuous)',
    ).toBeDefined();
    expect(n!.id).toBe('cs-1');
    expect(n!.position).toEqual({ x: 420, y: 40 });
  });

  it('ALIAS: the node is retyped to the replacement module', () => {
    expect(nodes['cs-1']!.type).toBe('warrensspectrum');
    expect(RETIRED_TYPE_ALIASES['callsine']).toBe('warrensspectrum');
  });

  it('ALIAS: params are DROPPED, not mapped — the node loads at the new defaults', () => {
    // Asserted against the DEF, never against literals, so a default change
    // cannot silently pass. `callsine`'s macros (model/note/harmonics/timbre/
    // morph/level) are Plaits controls over a spectral engine; not one of them
    // is a spectral quantity, so reinterpreting any of them would be worse
    // than resetting it.
    const stored = nodes['cs-1']!.params ?? {};
    expect(Object.keys(stored), 'no stored param may survive the alias').toEqual([]);
    for (const p of warrensspectrumDef.params) {
      const effective = stored[p.id] ?? p.defaultValue;
      expect(effective, `${p.id} must resolve to its declared default`).toBe(p.defaultValue);
    }
  });

  it('ALIAS: exactly the four semantically-matching ports keep their cables', () => {
    // Per-edge BY PORT ID, never by count — a count would pass if the wrong
    // four survived.
    const survivors: Record<string, string> = {
      'e-audio_in': 'audio_in',
      'e-pitch': 'pitch',
      'e-gate': 'gate',
      'e-out': 'out',
    };
    for (const [edgeId, portId] of Object.entries(survivors)) {
      const e = edges[edgeId];
      expect(e, `${edgeId} (port ${portId}) must survive the alias`).toBeDefined();
      const port = e!.source.nodeId === 'cs-1' ? e!.source.portId : e!.target.portId;
      expect(port).toBe(portId);
    }
    // And the four are exactly the ids the def promises.
    expect([...WARRENSSPECTRUM_ALIASED_PORT_IDS].sort()).toEqual(
      ['audio_in', 'gate', 'out', 'pitch'].sort(),
    );
  });

  it('ALIAS: the Plaits macro CVs DIE, each with its own diagnostic', () => {
    for (const edgeId of ['e-morph_cv', 'e-note_cv']) {
      expect(edges[edgeId], `${edgeId} must NOT survive — the port is gone`).toBeUndefined();
      const d = diagnostics.find((x) => x.nodeId === edgeId);
      expect(d, `${edgeId} must carry its own diagnostic`).toBeDefined();
      expect(d!.reason).toMatch(/invalid edge dropped/);
    }
  });

  it('ALIAS: the diagnostic says the module now ANALYSES audio — the silent-node trap', () => {
    // callsine declared `chainWiring: { role: 'source' }`: it was a VOICE.
    // Warren's Spectrum is an EFFECT. A migrated node with nothing patched
    // into audio_in is SILENT, and that is the one failure this migration can
    // still produce — so the wording must say so, not just "controls reset".
    const d = diagnostics.filter((x) => x.type === 'callsine');
    expect(d, 'exactly one diagnostic should name the migrated type').toHaveLength(1);
    expect(d[0]!.nodeId).toBe('cs-1');
    expect(d[0]!.reason).toBe(RETIRED_TYPE_ALIAS_NOTES['callsine']);
    expect(d[0]!.reason).toMatch(/audio_in/);
    expect(d[0]!.reason).toMatch(/ANALYSES/);
  });

  // ── DROP leg ───────────────────────────────────────────────────────────

  it('DROP: the warrenspectrum node is ABSENT', () => {
    expect(nodes['ws-1']).toBeUndefined();
    expect(
      Object.values(nodes).some((n) => n?.type === 'warrenspectrum'),
      'no node may carry the retired type',
    ).toBe(false);
  });

  it('DROP: one unknown-type diagnostic names warrenspectrum', () => {
    const d = diagnostics.filter((x) => x.type === 'warrenspectrum');
    expect(d).toHaveLength(1);
    expect(d[0]!.nodeId).toBe('ws-1');
    expect(d[0]!.reason).toBe('module type not registered in this build');
  });

  it('DROP: EVERY warrenspectrum cable is gone (exact count — the anti-alias control)', () => {
    for (const id of WARRENSPECTRUM_EDGE_IDS) {
      expect(edges[id], `${id} must be dropped with its node`).toBeUndefined();
    }
    const orphaned = diagnostics.filter((d) => d.reason === 'edge references a dropped node');
    expect(
      orphaned.map((d) => d.nodeId).sort(),
      'exactly the 7 warrenspectrum cables, no more and no fewer — if someone ' +
        'adds a warrenspectrum entry to RETIRED_TYPE_ALIASES this count collapses',
    ).toEqual([...WARRENSPECTRUM_EDGE_IDS].sort());
  });

  it('DROP: RETIRED_TYPE_ALIASES must NOT grow a warrenspectrum entry', () => {
    expect(
      Object.keys(RETIRED_TYPE_ALIASES),
      'warrenspectrum shares 0 of its 43 ports and 0 of its 16 params with the ' +
        'replacement contract; an aliased node would keep no cable and no value — ' +
        'a different instrument wearing the old node\'s id. The drop is deliberate.',
    ).toEqual(['callsine']);
  });

  // ── Shared: the negative control on the migration itself ───────────────

  it('the unrelated node and its cables are untouched', () => {
    const vco = nodes['vco-1'];
    expect(vco).toBeDefined();
    expect(vco!.type).toBe('analogVco');
    expect(vco!.position).toEqual({ x: 40, y: 40 });
    expect(vco!.params).toEqual({ tune: 7, fine: -12 });
    const control = edges['e-control'];
    expect(control, 'the vco→audioOut control cable must survive intact').toBeDefined();
    expect(control!.source).toEqual({ nodeId: 'vco-1', portId: 'triangle' });
    expect(control!.target).toEqual({ nodeId: 'out-1', portId: 'R' });
  });

  // ── The user-facing half ───────────────────────────────────────────────

  it('the load is SUMMARISED for the user, naming both outcomes', () => {
    // Until this shipped, every one of these diagnostics reached `console.warn`
    // and nothing else: 18 previously-deleted module types have been degrading
    // "gracefully" into a rack that silently lost nodes and cables.
    const summary = summarizeLoadDiagnostics(diagnostics);
    expect(summary, 'a load that dropped a node MUST produce a notice').not.toBeNull();
    expect(summary!).toMatch(/warrenspectrum/);
    expect(summary!).toMatch(/could not be loaded/);
    expect(summary!).toMatch(/migrated from callsine/);
    expect(summary!).toMatch(/9 cables removed/); // 7 orphaned + 2 invalid
  });
});
