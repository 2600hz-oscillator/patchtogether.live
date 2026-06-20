// Build-time data for the LAUNCHPAD CONTROL · LEFT docs page. Operator-style
// guide (shared with the RIGHT page), so no module-manifest dependency — but we
// keep a server load so the route prerenders like its siblings under the docs
// subtree's `prerender = true`. The route slug equals the module TYPE
// (launchpadControlLeft) so right-click → "View docs" (which opens
// /docs/modules/<type>) lands here via SvelteKit's static-route precedence over
// the auto [id] page.

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {};
};
