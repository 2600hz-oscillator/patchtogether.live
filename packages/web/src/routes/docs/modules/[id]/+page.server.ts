// /docs/modules/[id] — per-module page. Prerendered for every module type
// in the registry via the `entries()` export below.

import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { manifest } from '$lib/docs/modules-manifest';

export const entries: EntryGenerator = () => {
  return manifest.modules.map((m) => ({ id: m.type }));
};

export const load: PageServerLoad = ({ params }) => {
  const mod = manifest.modules.find((m) => m.type === params.id);
  if (!mod) {
    throw error(404, `No module registered with type "${params.id}"`);
  }
  return { mod };
};
