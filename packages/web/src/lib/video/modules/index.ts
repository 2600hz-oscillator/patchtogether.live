// packages/web/src/lib/video/modules/index.ts
//
// Auto-registers all Phase 0 video modules on first import. Mirrors
// packages/web/src/lib/audio/modules/index.ts so the registration entry
// points are symmetric across domains; UI just imports both barrels.

import { registerVideoModule } from '$lib/video/module-registry';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';
import { linesDef } from './lines';
import { videoOutDef } from './video-out';

let registered = false;

export function registerVideoModules(): void {
  if (registered) return;
  registered = true;
  registerVideoModule(linesDef);
  registerVideoModule(videoOutDef);
  // Re-expose module specs so the (audio + video) combined snapshot
  // lands on window.__moduleSpecs. The audio barrel already calls this
  // after registering its own defs; we redo it here so the e2e
  // io-spec-consistency suite (which iterates over the published
  // specs) sees the video defs too.
  exposeModuleSpecsForTests();
}

registerVideoModules();
