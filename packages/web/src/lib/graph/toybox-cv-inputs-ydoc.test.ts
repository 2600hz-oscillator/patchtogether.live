// packages/web/src/lib/graph/toybox-cv-inputs-ydoc.test.ts
//
// REAL-Y.Doc regression tests for the TOYBOX per-input scale/offset mutator
// (node.data.cvInputs). Runs against the SAME syncedStore + Y.Doc the live
// patch uses, so cvInputs entries become real Y.Maps once written — the way to
// catch the "Type already integrated" trap if a scale/offset edit ever spread
// an already-integrated entry. Includes a 2nd-set-survives + a peer-isolation
// (sync to a fresh Y.Doc) case. Mirrors toybox-cv-routes-ydoc.test.ts
// ([[yjs-save-load-real-ydoc]]).

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { patch, ydoc } from '$lib/graph/store';
import { setCvInput, setCvScale, setCvOffset, readCvInputs } from './toybox-cv-inputs';
import type { ModuleNode } from './types';

const TID = 'toybox-cvinputs-ydoc-test';

function makeToybox(): void {
  patch.nodes[TID] = {
    id: TID,
    type: 'toybox',
    domain: 'video',
    position: { x: 0, y: 0 },
    params: {},
    data: {},
  } as unknown as ModuleNode;
}

afterEach(() => {
  delete patch.nodes[TID];
});

describe('toybox cvInputs — real Y.Doc mutator', () => {
  it('sets scale + offset for an input IN PLACE (creates the map first)', () => {
    makeToybox();
    expect(() => setCvInput(TID, 'cv1', -0.5, 0.3)).not.toThrow();
    expect(readCvInputs(patch.nodes[TID]).cv1).toMatchObject({ scale: -0.5, offset: 0.3 });
  });

  it('SURVIVES a 2nd set on the same input (the integrate trap)', () => {
    makeToybox();
    setCvInput(TID, 'cv1', 1, 0);
    expect(() => setCvInput(TID, 'cv1', 0.25, 0.75)).not.toThrow();
    expect(readCvInputs(patch.nodes[TID]).cv1).toMatchObject({ scale: 0.25, offset: 0.75 });
  });

  it('setCvScale / setCvOffset mutate a single scalar field in place', () => {
    makeToybox();
    setCvInput(TID, 'cv2', 1, 0);
    expect(() => setCvScale(TID, 'cv2', -1)).not.toThrow();
    expect(() => setCvOffset(TID, 'cv2', 0.5)).not.toThrow();
    expect(readCvInputs(patch.nodes[TID]).cv2).toMatchObject({ scale: -1, offset: 0.5 });
  });

  it('setCvScale / setCvOffset create an entry with defaults when none exists', () => {
    makeToybox();
    setCvScale(TID, 'cv3', 0.4); // no entry yet → fresh entry, default offset 0
    expect(readCvInputs(patch.nodes[TID]).cv3).toMatchObject({ scale: 0.4, offset: 0 });
    setCvOffset(TID, 'cv4', 0.8); // no entry yet → fresh entry, default scale +1
    expect(readCvInputs(patch.nodes[TID]).cv4).toMatchObject({ scale: 1, offset: 0.8 });
  });

  it('sets MULTIPLE distinct inputs without throwing', () => {
    makeToybox();
    expect(() => {
      setCvInput(TID, 'cv1', 1, 0);
      setCvInput(TID, 'cv2', -0.5, 0.5);
      setCvInput(TID, 'cv6', 0, 1);
    }).not.toThrow();
    const inputs = readCvInputs(patch.nodes[TID]);
    expect(inputs.cv1).toMatchObject({ scale: 1, offset: 0 });
    expect(inputs.cv2).toMatchObject({ scale: -0.5, offset: 0.5 });
    expect(inputs.cv6).toMatchObject({ scale: 0, offset: 1 });
  });

  it('PEER-ISOLATION: a cvInputs write syncs to a fresh peer doc + stays per-port', () => {
    makeToybox();
    setCvInput(TID, 'cv1', -0.5, 0.25);
    setCvInput(TID, 'cv2', 1, 0.9);

    // Sync the live doc's state into a fresh peer Y.Doc (a remote rack-mate).
    // SyncedStore nests data as real Y types, so navigate via toJSON() on the
    // synced peer (the authoritative cross-peer view).
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));

    const peerNodes = peer.getMap('nodes').toJSON() as Record<
      string,
      { data?: { cvInputs?: Record<string, { scale: number; offset: number }> } }
    >;
    const peerInputs = peerNodes[TID]?.data?.cvInputs;
    expect(peerInputs).toBeTruthy();
    // The two ports' values are isolated (no cross-port bleed).
    expect(peerInputs!.cv1).toMatchObject({ scale: -0.5, offset: 0.25 });
    expect(peerInputs!.cv2).toMatchObject({ scale: 1, offset: 0.9 });
    peer.destroy();
  });

  it('readCvInputs returns {} for a node with no cvInputs', () => {
    makeToybox();
    expect(readCvInputs(patch.nodes[TID])).toEqual({});
  });
});
