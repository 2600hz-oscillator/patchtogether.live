// packages/web/src/lib/meta/modules/sticky.ts
//
// STICKY — paper-style sticky note. Editable textarea, corner-drag resize,
// Yjs-synced text. No engine binding; no ports. Lives in the "meta"
// domain so the reconciler skips it.
//
// Inputs: none.
// Outputs: none.
// Params: none. (Text + size live on node.data.)

import type { MetaModuleDef } from '$lib/meta/module-registry';

export const stickyDef: MetaModuleDef = {
  type: 'sticky',
  domain: 'meta',
  label: 'STICKY',
  category: 'tools',
  inputs: [],
  outputs: [],
  params: [],
  schemaVersion: 1,
};
