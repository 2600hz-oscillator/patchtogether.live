// packages/web/src/lib/meta/modules/group.ts
//
// GROUP! — collapses N modules into a single card. Meta-domain (no engine
// binding); rendered as a single GroupCard on the canvas, with handles
// derived dynamically from `data.exposedPorts` (see GroupData in
// $lib/graph/group-projection). The reconciler's snapshot-projection step
// rewrites edges pointing at exposed-port handles → the underlying child
// ports, so the engine never sees groups.
//
// The def's static `inputs`/`outputs` are empty; cards read the dynamic
// per-instance port list from node.data.exposedPorts.
//
// Inputs: none on the def (dynamically projected per-instance from
//   data.exposedPorts → child module input ports).
// Outputs: none on the def (same — dynamically projected).
// Params: none (children's params remain on the children; group exposes
//   them via exposedControls).

import type { MetaModuleDef } from '$lib/meta/module-registry';
import type { ModuleNode } from '$lib/graph/types';
import type { GroupData, ExposedPort } from '$lib/graph/group-projection';

export const groupDef: MetaModuleDef = {
  type: 'group',
  palette: { top: 'Hybrid', sub: 'Hybrid' },
  domain: 'meta',
  label: 'group',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],
};

export interface MakeGroupArgs {
  id: string;
  position: { x: number; y: number };
  childIds: string[];
  exposedPorts: ExposedPort[];
  label?: string;
}

/**
 * Build a GROUP! ModuleNode from the create-group action's payload.
 * Centralized so the Yjs transact callsite stays compact + so tests can
 * assemble the same shape without copy-pasting field names.
 */
export function makeGroupNode(args: MakeGroupArgs): ModuleNode {
  const data: GroupData = {
    childIds: args.childIds,
    exposedPorts: args.exposedPorts,
  };
  if (args.label) data.label = args.label;
  return {
    id: args.id,
    type: 'group',
    domain: 'meta',
    position: args.position,
    params: {},
    data: data as unknown as Record<string, unknown>,
  };
}
