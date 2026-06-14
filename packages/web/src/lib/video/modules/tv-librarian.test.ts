// packages/web/src/lib/video/modules/tv-librarian.test.ts
//
// Locks down TV LIBRARIAN's module-def shape (mirrors videobox.test.ts). No
// factory/runtime execution — that needs WebGL + a real hls.js-driven <video>,
// covered by the network-mocked e2e.

import { describe, expect, it } from 'vitest';
import { tvLibrarianDef } from './tv-librarian';
import { getVideoModuleDef } from '$lib/video/module-registry';
// Side-effect import auto-registers every video def (including ours).
import '$lib/video/modules';

describe('tvLibrarianDef — module def shape', () => {
  it('registers under type "tvLibrarian" with lowercase label + sources category', () => {
    expect(tvLibrarianDef.type).toBe('tvLibrarian');
    expect(tvLibrarianDef.domain).toBe('video');
    expect(tvLibrarianDef.label).toBe('tv librarian');
    // Hard standard: module labels MUST be lowercase (card CSS uppercases).
    expect(tvLibrarianDef.label).toBe(tvLibrarianDef.label.toLowerCase());
    expect(tvLibrarianDef.category).toBe('sources');
    expect(tvLibrarianDef.schemaVersion).toBe(1);
  });

  it('is discoverable through the video registry (glob auto-registration)', () => {
    expect(getVideoModuleDef('tvLibrarian')).toBe(tvLibrarianDef);
  });

  it('declares next/random trigger inputs routed through synthetic params', () => {
    const inputs = tvLibrarianDef.inputs;
    expect(inputs.map((i) => i.id)).toEqual(['next', 'random']);
    for (const inp of inputs) {
      expect(inp.type).toBe('gate');
      // edge:'trigger' = fire ONCE per rising edge (next/random channel hop).
      expect(inp.edge).toBe('trigger');
    }
    expect(inputs.find((i) => i.id === 'next')?.paramTarget).toBe('cv_next');
    expect(inputs.find((i) => i.id === 'random')?.paramTarget).toBe('cv_random');
  });

  it('declares video + stereo audio outputs and the two gate outputs with correct edge semantics', () => {
    const outs = tvLibrarianDef.outputs.map((o) => ({ id: o.id, type: o.type, edge: o.edge }));
    expect(outs).toEqual([
      { id: 'video',           type: 'video', edge: undefined },
      { id: 'audio_l',         type: 'audio', edge: undefined },
      { id: 'audio_r',         type: 'audio', edge: undefined },
      // channel_changed fires once per tune (trigger); stream_online holds high
      // while playing (gate) — declared edge matters for downstream consumers.
      { id: 'channel_changed', type: 'gate',  edge: 'trigger' },
      { id: 'stream_online',   type: 'gate',  edge: 'gate' },
    ]);
  });

  it('exposes a gain param + the two hidden synthetic edge-detector params', () => {
    const ids = tvLibrarianDef.params.map((p) => p.id);
    expect(ids).toContain('gain');
    expect(ids).toContain('cv_next');
    expect(ids).toContain('cv_random');
  });
});
