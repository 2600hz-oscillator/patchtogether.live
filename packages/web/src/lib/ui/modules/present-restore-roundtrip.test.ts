// Save → envelope → load, across the persistence boundary.
//
// The unit tests in present-bindings.test.ts and screen-identity.test.ts were
// green through FOUR shipped defects, because every one of them lived in the
// SEAM rather than in the logic: the write recorded [], the load skipped
// restore, an armed write clobbered the envelope, and finally the loader never
// applied the settings map at all. Nothing that tests one module in isolation
// can see any of those. This file drives the real makeEnvelope →
// loadEnvelopeIntoStore path and asserts on what survives it.

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  loadEnvelopeIntoStore,
  readVideoAspectFromDoc,
  writeVideoAspectToDoc,
  type LivePatch,
} from '$lib/graph/persistence';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';
import {
  planRestore,
  readPresentBindings,
  readPresentBindingsFromUpdate,
  writePresentBindings,
  type LiveScreen,
  type PresentBinding,
} from './present-bindings';
import type { ScreenDescriptor } from './screen-identity';

const throwingFactory = (): never => {
  throw new Error('factory should not be called from a persistence test');
};

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  return { store: store as unknown as LivePatch, ydoc: getYjsDoc(store) };
}

// The owner's rig (Edge 151 / macOS). The projector reports NO label.
const RETINA: ScreenDescriptor = {
  label: 'Built-in Retina Display', isInternal: true,
  width: 1512, height: 982, dpr: 2, left: 0, top: 0,
};
const PROJECTOR: ScreenDescriptor = {
  label: '', isInternal: false,
  width: 1920, height: 1080, dpr: 1, left: 1512, top: 0,
};
const RIG: LiveScreen[] = [
  { id: 'primary', descriptor: RETINA },
  { id: 'display-1', descriptor: PROJECTOR },
];

const BINDING: PresentBinding = { nodeId: 'workflow-videoOut', screen: PROJECTOR };

beforeAll(() => {
  registerVideoModule({
    type: 'videoOut',
    domain: 'video',
    label: 'VIDEOOUT',
    category: 'output',
    inputs: [],
    outputs: [],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  } satisfies VideoModuleDef);
});

/** A patch presenting one output on the projector, saved the way the app saves. */
function savedPatch() {
  const src = freshPatch();
  src.ydoc.transact(() => {
    src.store.nodes['workflow-videoOut'] = {
      id: 'workflow-videoOut',
      type: 'videoOut',
      domain: 'video',
      position: { x: 40, y: 80 },
      params: {},
    } as ModuleNode;
  });
  writeVideoAspectToDoc(src.ydoc, '16:9');
  writePresentBindings(src.ydoc, [BINDING]);
  return parseEnvelope(serializeEnvelope(makeEnvelope(src.ydoc)));
}

describe('present bindings across a real save/load', () => {
  it('survives the envelope and resolves to the attached projector', () => {
    const env = savedPatch();
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(result.nodesLoaded).toBe(1);

    const saved = readPresentBindingsFromUpdate(env.update);
    expect(saved).toEqual([BINDING]);

    const loadedNodeIds = Object.keys(dest.store.nodes);
    expect(planRestore(saved, RIG, loadedNodeIds)).toEqual([
      { nodeId: 'workflow-videoOut', screenId: 'display-1' },
    ]);
  });

  it('THE TRAP: the loader copies ONE named settings key and drops the rest', () => {
    // loadEnvelopeIntoStore materialises the envelope in a throwaway doc, then
    // writes exactly `videoAspect` into the live settings map BY NAME before
    // copying nodes + edges across. It is an ALLOWLIST OF ONE, not a settings
    // merge — so presentBindings never lands, and a Canvas reading the LIVE doc
    // on an envelope load sees the PREVIOUS patch's bindings (nothing, on a
    // fresh rack). That shipped; only a real save/load could show it.
    //
    // If presentBindings is ever added to that allowlist this goes red on the
    // first assertion, which is an IMPROVEMENT: drop the
    // readPresentBindingsFromUpdate argument at Canvas's envelope load sites and
    // read the live doc uniformly, the way the mount path already does.
    const env = savedPatch();
    const dest = freshPatch();
    const result = loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    expect(readPresentBindings(dest.ydoc)).toEqual([]);
    expect(readVideoAspectFromDoc(dest.ydoc)).toBe('16:9');
    expect(result.videoAspect).toBe('16:9');
  });

  it('re-saving a restored patch keeps the binding, so it survives generations', () => {
    const first = savedPatch();
    const dest = freshPatch();
    loadEnvelopeIntoStore(first, dest.ydoc, dest.store);
    // What Canvas does once restore resolves: write the live set back.
    writePresentBindings(dest.ydoc, readPresentBindingsFromUpdate(first.update));
    const second = parseEnvelope(serializeEnvelope(makeEnvelope(dest.ydoc)));
    expect(readPresentBindingsFromUpdate(second.update)).toEqual([BINDING]);
  });

  it('drops a binding whose module did not survive the load', () => {
    const env = savedPatch();
    const dest = freshPatch();
    loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    delete dest.store.nodes['workflow-videoOut'];
    const saved = readPresentBindingsFromUpdate(env.update);
    expect(planRestore(saved, RIG, Object.keys(dest.store.nodes))).toEqual([]);
  });

  it('restores nothing, and loses nothing, when the projector is not attached', () => {
    const env = savedPatch();
    const dest = freshPatch();
    loadEnvelopeIntoStore(env, dest.ydoc, dest.store);
    const saved = readPresentBindingsFromUpdate(env.update);
    expect(planRestore(saved, [RIG[0]], Object.keys(dest.store.nodes))).toEqual([]);
    // The envelope still holds it — an unplugged projector must not erase the rig.
    expect(readPresentBindingsFromUpdate(env.update)).toEqual([BINDING]);
  });

  it('a patch saved before the feature existed loads with no bindings and no throw', () => {
    const src = freshPatch();
    src.ydoc.transact(() => {
      src.store.nodes['workflow-videoOut'] = {
        id: 'workflow-videoOut', type: 'videoOut', domain: 'video',
        position: { x: 0, y: 0 }, params: {},
      } as ModuleNode;
    });
    const env = parseEnvelope(serializeEnvelope(makeEnvelope(src.ydoc)));
    const dest = freshPatch();
    expect(loadEnvelopeIntoStore(env, dest.ydoc, dest.store).nodesLoaded).toBe(1);
    expect(readPresentBindingsFromUpdate(env.update)).toEqual([]);
  });
});
