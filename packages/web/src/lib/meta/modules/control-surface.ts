// packages/web/src/lib/meta/modules/control-surface.ts
//
// CONTROL SURFACE — an abstract control panel. Instantiate it and it starts
// as a small blank square. Right-click any MIDI-assignable knob/fader on any
// module and choose "Send to <surface>" — a POINTER to that control appears
// on the surface, grouped (dotted border + label) under its source module.
// Controls from collapsed groups keep working because the pointer drives the
// source node's live param directly. A lock/unlock toggle freezes or frees
// the grouped boxes for rearranging (the surface is a mini-graph of itself).
//
// Meta domain: no engine binding, no ports, no params. All state lives on
// node.data (see $lib/graph/control-surface.ts).
//
// Inputs: none. Outputs: none. Params: none.

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const controlSurfaceDef: MetaModuleDef = {
  type: 'controlSurface',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'meta',
  label: 'CONTROL SURFACE',
  category: 'tools',
  card: 'ControlSurfaceCard',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
