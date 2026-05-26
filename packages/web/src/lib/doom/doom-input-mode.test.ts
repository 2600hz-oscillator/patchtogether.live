// packages/web/src/lib/doom/doom-input-mode.test.ts
//
// The input-mode rule (owner-approved): a DOOM node listens to the
// keyboard ONLY when no CV-gate input is patched; the instant any cv-gate
// jack has an incoming edge, the keyboard goes inert (CV-only). DoomCard's
// shouldClaimKey() short-circuits to false on this predicate.

import { describe, it, expect } from 'vitest';
import { isCvGatePatched, type IncomingEdgeLike } from './doom-input-mode';
import { CV_GATE_PORT_IDS } from './doomkeys';

const edge = (nodeId: string, portId: string): IncomingEdgeLike => ({
  target: { nodeId, portId },
});

describe('isCvGatePatched — keyboard inert iff a cv-gate jack is patched', () => {
  it('no edges → not patched (keyboard active)', () => {
    expect(isCvGatePatched([], 'doom-1')).toBe(false);
  });

  it('an edge into a cv-gate input of THIS node → patched (keyboard inert)', () => {
    const edges = [edge('doom-1', 'left')];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(true);
  });

  it('every cv-gate port id individually flips it on', () => {
    for (const port of CV_GATE_PORT_IDS) {
      expect(isCvGatePatched([edge('doom-1', port)], 'doom-1')).toBe(true);
    }
  });

  it('an edge into a DIFFERENT doom node does NOT patch this one', () => {
    const edges = [edge('doom-OTHER', 'up')];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(false);
  });

  it('an edge into a non-cv-gate port (e.g. the audio/video ports) does NOT patch', () => {
    const edges = [edge('doom-1', 'out'), edge('doom-1', 'audio_l'), edge('doom-1', 'running')];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(false);
  });

  it('patched when ANY one of several edges hits a cv-gate input', () => {
    const edges = [
      edge('doom-1', 'out'),
      edge('synth-2', 'cutoff'),
      edge('doom-1', 'space'), // the one that counts
    ];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(true);
  });

  it('tolerates null/undefined holes in the edge list', () => {
    const edges = [null, undefined, edge('doom-1', 'ctrl')];
    expect(isCvGatePatched(edges, 'doom-1')).toBe(true);
    expect(isCvGatePatched([null, undefined], 'doom-1')).toBe(false);
  });
});
