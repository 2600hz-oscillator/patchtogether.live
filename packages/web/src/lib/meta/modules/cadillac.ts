// packages/web/src/lib/meta/modules/cadillac.ts
//
// CADILLAC — a singleton meta module that drives across the canvas from
// right to left at a constant 300 px/s and deletes every audio + video
// module its hit-box runs over. TIMELORDE (the rack's undeletable system
// clock) is passed through silently — any future `undeletable: true`
// module inherits the same immunity.
//
// Why "meta": no engine binding, no ports, no params. The car is purely
// a visual + Yjs-graph mutation effect driven by an overlay component.
// The overlay reads spawn time + spawner clientId from this node's
// `data` and computes the car's position deterministically — no
// per-frame awareness traffic for the car (see memory note
// `relay-single-process-and-drift`).
//
// Inputs: none.
// Outputs: none.
// Params: none. (Spawn metadata lives on node.data:
//   - spawnerClientId: number  (awareness.clientID of the user who spawned)
//   - spawnedAtMs:     number  (Date.now() at spawn))
//
// maxInstances: 1 — the palette filters at-cap modules out. Two
// near-simultaneous spawns can still race past the gate and produce
// two cars; that's fine (rare, harmless, the second car just drives
// its own pass).

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const cadillacDef: MetaModuleDef = {
  type: 'cadillac',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'meta',
  label: 'cadillac',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],
  maxInstances: 1,
};
