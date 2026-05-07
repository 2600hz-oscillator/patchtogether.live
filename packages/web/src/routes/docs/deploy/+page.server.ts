import type { PageServerLoad } from './$types';

// No data needed; this loader exists so the route honors `prerender = true`
// from +layout.ts. Returning {} is a valid prerender entrypoint.
export const load: PageServerLoad = () => ({});
