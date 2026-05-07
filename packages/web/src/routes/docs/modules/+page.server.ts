import type { PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';

export const load: PageServerLoad = () => {
  return {
    manifest: buildModuleManifest(),
  };
};
