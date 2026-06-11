// Build-time data for the vfpga-runner VFPGA index page. Lists the bundled
// VFPGA catalog (glob-collected from $lib/video/vfpga/registry) so the index
// never drifts from what the "load preset…" menu offers. Prerenders like its
// siblings under the docs subtree's `prerender = true`.

import type { PageServerLoad } from './$types';
import { listVfpgaSpecs } from '$lib/video/vfpga/registry';

export const load: PageServerLoad = () => {
  return {
    vfpgas: listVfpgaSpecs().map((s) => ({
      id: s.id,
      name: s.name,
      doc: s.doc,
      docSlug: s.docSlug,
      videoIn: s.videoIn,
      videoOut: s.videoOut,
      cvRoles: (s.cvRoles ?? []).length,
      gateRoles: (s.gateRoles ?? []).length,
      params: (s.params ?? []).length,
    })),
  };
};
