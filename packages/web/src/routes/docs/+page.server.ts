import type { PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';

// Build-time only — every /docs/* page is prerendered (see +layout.ts).
// The manifest is computed once during `vite build` and serialized into
// the static HTML, so the runtime never has to parse module sources.
export const load: PageServerLoad = () => {
  const manifest = buildModuleManifest();
  return {
    moduleCount: manifest.moduleCount,
  };
};
