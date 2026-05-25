// Build-time data for the DOOM multiplayer docs page. No module-manifest
// dependency is needed (this page is an operator-style reference, not an
// auto-generated port table), but we keep a server load so the route
// prerenders like its siblings under `prerender = true`.

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {};
};
