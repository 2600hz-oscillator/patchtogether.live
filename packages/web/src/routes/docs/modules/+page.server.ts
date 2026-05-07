// /docs/modules — module catalog gallery. Static, prerendered.

import type { PageServerLoad } from './$types';
import { manifest } from '$lib/docs/modules-manifest';

export const load: PageServerLoad = () => {
  return { manifest };
};
