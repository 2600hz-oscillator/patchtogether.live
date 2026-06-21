// Build-time data for the LAUNCHPAD CONTROL docs page. Operator-style guide, so
// no module-manifest dependency — but we keep a server load so the route
// prerenders like its siblings under the docs subtree's `prerender = true`. The
// route slug equals the (kept) module TYPE launchpadControlLeft — after the L/R
// cards were consolidated into one module the type string is unchanged — so
// right-click → "View docs" (which opens /docs/modules/<type>) lands here via
// SvelteKit's static-route precedence over the auto [id] page.

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {};
};
