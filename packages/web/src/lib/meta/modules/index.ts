// packages/web/src/lib/meta/modules/index.ts
//
// Auto-registers all meta-domain modules on first import. Symmetric with
// the audio + video barrels so the UI can `import '$lib/meta/modules'`
// and pick up new meta defs without a Canvas edit.

import { registerMetaModule } from '$lib/meta/module-registry';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';
import { stickyDef } from './sticky';

let registered = false;

export function registerMetaModules(): void {
  if (registered) return;
  registered = true;
  registerMetaModule(stickyDef);
  // Refresh the published spec snapshot so window.__moduleSpecs picks up
  // the meta defs the same way the audio + video barrels do.
  exposeModuleSpecsForTests();
}

registerMetaModules();
