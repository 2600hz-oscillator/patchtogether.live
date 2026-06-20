// Build-time data for the LAUNCHPAD CONTROL · RIGHT docs page. Mirrors the LEFT
// page (shared guide); kept so the route prerenders under the docs subtree's
// `prerender = true`. Slug == the module TYPE (launchpadControlRight) so
// right-click → "View docs" (which opens /docs/modules/<type>) lands here.

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {};
};
