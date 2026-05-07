// /docs (index) — load the catalog manifest count for the landing page.
// Pure static; prerendered via the parent layout's `prerender = true`.

import type { PageServerLoad } from './$types';
import { manifest } from '$lib/docs/modules-manifest';

export const load: PageServerLoad = () => {
  return {
    moduleCount: manifest.moduleCount,
  };
};
