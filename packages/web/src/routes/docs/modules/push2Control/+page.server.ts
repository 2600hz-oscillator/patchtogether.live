// Build-time data for the PUSH 2 CONTROL docs page. Operator-style guide, so no
// module-manifest dependency — a bare server load keeps the route prerendering
// like its siblings under the docs subtree's `prerender = true`. The route slug
// equals the module TYPE push2Control, so right-click → "View docs" (which opens
// /docs/modules/<type>) lands here via SvelteKit's static-route precedence over
// the auto [id] page.

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {};
};
