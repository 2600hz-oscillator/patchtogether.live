// packages/web/src/lib/doom/doom-input-mode.test.ts
//
// The input-mode rule (owner-approved): a DOOM node listens to the
// keyboard ONLY when no CV-gate input is patched; the instant a cv-gate
// jack has an incoming edge, the keyboard goes inert (CV-only). DoomCard's
// shouldClaimKey() short-circuits to false on this predicate.
//
// #353 per-player: ports are now per-slot groups (p1_up … p4_alt). The
// node-wide `isCvGatePatched` flips on ANY slot's group; `isOwnSlotCvGatePatched`
// is the per-viewer rule — your keyboard is gated only by YOUR OWN slot's CV,
// never another player's.

import { describe, it, expect } from 'vitest';
import {
  isCvGatePatched,
  isOwnSlotCvGatePatched,
  type IncomingEdgeLike,
} from './doom-input-mode';
import { CV_GATE_PORT_IDS, cvGatePortIdForSlot } from './doomkeys';

const edge = (nodeId: string, portId: string): IncomingEdgeLike => ({
  target: { nodeId, portId },
});

describe('isCvGatePatched — node-wide cv-gate detection (per-slot ports)', () => {
  it('no edges → not patched (keyboard active)', () => {
    expect(isCvGatePatched([], 'doom-1')).toBe(false);
  });

  it('an edge into a per-slot cv-gate input of THIS node → patched', () => {
    expect(isCvGatePatched([edge('doom-1', 'p1_left')], 'doom-1')).toBe(true);
    expect(isCvGatePatched([edge('doom-1', 'p3_space')], 'doom-1')).toBe(true);
  });

  it('every per-slot cv-gate port id individually flips it on', () => {
    for (let slot = 0; slot < 4; slot++) {
      for (const base of CV_GATE_PORT_IDS) {
        const portId = cvGatePortIdForSlot(slot, base);
        expect(isCvGatePatched([edge('doom-1', portId)], 'doom-1'), portId).toBe(true);
      }
    }
  });

  it('a LEGACY bare port id (pre-migration) does NOT match (must be migrated first)', () => {
    expect(isCvGatePatched([edge('doom-1', 'up')], 'doom-1')).toBe(false);
  });

  it('an edge into a DIFFERENT doom node does NOT patch this one', () => {
    expect(isCvGatePatched([edge('doom-OTHER', 'p1_up')], 'doom-1')).toBe(false);
  });

  it('an edge into a non-cv-gate port (audio/video ports) does NOT patch', () => {
    const edges = [edge('doom-1', 'out'), edge('doom-1', 'audio_l'), edge('doom-1', 'audio_r')];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(false);
  });

  it('patched when ANY one of several edges hits a cv-gate input', () => {
    const edges = [
      edge('doom-1', 'out'),
      edge('synth-2', 'cutoff'),
      edge('doom-1', 'p2_space'), // the one that counts
    ];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(true);
  });

  it('tolerates null/undefined holes in the edge list', () => {
    expect(isCvGatePatched([null, undefined, edge('doom-1', 'p4_ctrl')], 'doom-1')).toBe(true);
    expect(isCvGatePatched([null, undefined], 'doom-1')).toBe(false);
  });
});

describe('isOwnSlotCvGatePatched — per-viewer keyboard-vs-CV precedence (#353)', () => {
  it('a spectator (slot null) is never CV-patched (owns no group)', () => {
    expect(isOwnSlotCvGatePatched([edge('doom-1', 'p1_up')], 'doom-1', null)).toBe(false);
  });

  it("your OWN slot's group CV gates your keyboard", () => {
    expect(isOwnSlotCvGatePatched([edge('doom-1', 'p1_up')], 'doom-1', 0)).toBe(true);
    expect(isOwnSlotCvGatePatched([edge('doom-1', 'p2_left')], 'doom-1', 1)).toBe(true);
  });

  it("ANOTHER player's slot CV does NOT gate your keyboard", () => {
    // P1's cable into p2_up must not make P1 (slot 0) go inert.
    expect(isOwnSlotCvGatePatched([edge('doom-1', 'p2_up')], 'doom-1', 0)).toBe(false);
    // And vice versa: slot 1 is not gated by slot 0's group.
    expect(isOwnSlotCvGatePatched([edge('doom-1', 'p1_up')], 'doom-1', 1)).toBe(false);
  });

  it('mixed: only the matching own-slot edge counts', () => {
    const edges = [edge('doom-1', 'p1_up'), edge('doom-1', 'p3_space')];
    expect(isOwnSlotCvGatePatched(edges, 'doom-1', 0)).toBe(true); // p1_up
    expect(isOwnSlotCvGatePatched(edges, 'doom-1', 1)).toBe(false); // no p2 edge
    expect(isOwnSlotCvGatePatched(edges, 'doom-1', 2)).toBe(true); // p3_space
  });
});
