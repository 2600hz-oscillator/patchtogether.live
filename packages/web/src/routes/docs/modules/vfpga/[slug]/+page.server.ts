// Per-VFPGA docs subpage. Enumerates every bundled VFPGA's docSlug at build time
// (so each prerenders under the docs subtree's `prerender = true`) and serves
// the spec's model / controls / I-O / CV-gate roles / usage from the registry.

import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { listVfpgaSpecs } from '$lib/video/vfpga/registry';

export const entries: EntryGenerator = () => {
  return listVfpgaSpecs().map((s) => ({ slug: s.docSlug }));
};

export const load: PageServerLoad = ({ params }) => {
  const spec = listVfpgaSpecs().find((s) => s.docSlug === params.slug);
  if (!spec) throw error(404, `Unknown VFPGA: ${params.slug}`);
  return {
    spec: {
      id: spec.id,
      name: spec.name,
      doc: spec.doc,
      videoIn: spec.videoIn,
      videoOut: spec.videoOut,
      cvRoles: spec.cvRoles ?? [],
      gateRoles: spec.gateRoles ?? [],
      params: spec.params ?? [],
    },
  };
};
