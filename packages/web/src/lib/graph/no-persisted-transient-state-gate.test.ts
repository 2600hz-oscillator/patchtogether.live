// packages/web/src/lib/graph/no-persisted-transient-state-gate.test.ts
//
// PART A #2 of the schema/persistence cleanup — the "NO PERSISTED TRANSIENT
// STATE" gate. See .myrobots/schema_cleanup_proposal_260606.md §5 (the
// persist-transient-state class) + §6 Phase 0.
//
// THE PRINCIPLE (proposal §5): live / CV state is transient DISPLAY state,
// recomputed on load from what is actually patched — it is NEVER persisted. A
// patch stores TOPOLOGY + AUTHORED/SEQUENCED values, not a moment-in-time sample
// of a value a CV edge / surface / gamepad is actively driving. Persisting that
// sample is exactly the bug class that froze QUADRALOGICAL's gamepad joystick
// position into a permanent CV offset on reload (fixed by #1023), and it is the
// same root principle as the TOYBOX per-frame ydoc write-storm
// ([[cv-modulation-live-store-write-storm]], PR #719).
//
// THE INVARIANT this gate locks: driving a `cvScale` param through the video CV
// bridge (the real engine path: engine.tickCvBridges → video-engine handle
// setParam) for N frames produces ZERO Y.Doc updates and NEVER mutates the
// stored param. The modulated value flows to the render handle, not the synced
// store.
//
// DATA-DRIVEN so LATER cleanup phases can extend coverage: add a row to CASES.
// If you discover a module that DOES persist transient state (a per-frame poll
// writing node params into the store, or a CV self-target param written on
// drag), DO NOT fix it here — record it for the later persisted-transient-state
// phase and add its (fixed) row to CASES then.
//
// Uses a REAL syncedStore + Y.Doc — never a mock ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { quadralogicalDef } from '$lib/video/modules/quadralogical';
import { chromaDef } from '$lib/video/modules/chroma';
import { buildCvBridgeMapping, mapCvBridgeValue } from '$lib/video/cv-bridge-map';
import type { ModuleNode, Edge, ParamDef, PortDef } from './types';
import type { LivePatch } from './persistence';

const FRAMES = 180;

interface TransientCase {
  module: string;
  domain: 'video';
  inputs: readonly PortDef[];
  params: readonly ParamDef[];
  /** cvScale param ids driven per-frame through the CV bridge. */
  cvParams: string[];
}

const CASES: TransientCase[] = [
  // The reported bug's module: pos_x/pos_y are CV SELF-targets (paramTarget ===
  // id) AND draggable/persisted params. #1023 routed the live poll to the
  // video-engine handle, never the store. This row locks it forever.
  {
    module: 'quadralogical',
    domain: 'video',
    inputs: quadralogicalDef.inputs,
    params: quadralogicalDef.params,
    cvParams: ['pos_x', 'pos_y'],
  },
  // A "clean" cvScale param on a DIFFERENT module (CHROMA's hue): a normal
  // CV-modulated knob with a linear cvScale hint. Driving it must likewise never
  // write the store.
  {
    module: 'chroma',
    domain: 'video',
    inputs: chromaDef.inputs,
    params: chromaDef.params,
    cvParams: ['hue'],
  },
];

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

describe('no persisted transient state — CV/live modulation of a cvScale param never writes the synced store', () => {
  for (const c of CASES) {
    for (const paramId of c.cvParams) {
      it(`${c.module}.${paramId}: ${FRAMES} frames of CV → ZERO ydoc updates + stored param unchanged`, () => {
        const { store, ydoc } = freshPatch();
        const nodeId = `${c.module}-n`;
        ydoc.transact(() => {
          store.nodes[nodeId] = {
            id: nodeId,
            type: c.module,
            domain: c.domain,
            position: { x: 0, y: 0 },
            params: {}, // default — the driven param is unset
          } as unknown as ModuleNode;
        });

        const input = c.inputs.find((i) => i.id === paramId);
        expect(input, `${c.module} declares a CV input for ${paramId}`).toBeTruthy();
        const mapping = buildCvBridgeMapping(
          input,
          paramId,
          c.params,
          store.nodes[nodeId]!.params as unknown as Record<string, number>,
        );

        // Route each sampled frame to a FAKE video-engine handle — the REAL
        // path (engine.tickCvBridges → handle.setParam), NEVER the store.
        const handleWrites: Array<[string, number]> = [];
        const handle = { setParam: (id: string, v: number) => handleWrites.push([id, v]) };

        let updates = 0;
        const onUpdate = () => {
          updates += 1;
        };
        ydoc.on('update', onUpdate);
        try {
          for (let f = 0; f < FRAMES; f++) {
            const cv = Math.sin(f / 5); // a moving driver sweeping the full range
            handle.setParam(mapping.targetParamId, mapCvBridgeValue(mapping, cv));
          }
        } finally {
          ydoc.off('update', onUpdate);
        }

        expect(handleWrites.length).toBe(FRAMES); // modulation reached the handle
        expect(updates).toBe(0); // …and NOTHING was synced to the Y.Doc
        // The stored param is untouched — the modulated value never persisted.
        expect(
          (store.nodes[nodeId]!.params as Record<string, number>)[paramId],
        ).toBeUndefined();
      });
    }
  }
});
