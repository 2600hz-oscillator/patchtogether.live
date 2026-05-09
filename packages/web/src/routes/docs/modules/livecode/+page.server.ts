// Build-time data for the LIVECODE docs page. Pulls the same module
// manifest used by /docs/modules so the per-module port reference at the
// bottom of the page is auto-generated from the registry — there is no
// second source of truth.

import type { PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';

export const load: PageServerLoad = () => {
  const manifest = buildModuleManifest();
  return {
    manifest,
  };
};
