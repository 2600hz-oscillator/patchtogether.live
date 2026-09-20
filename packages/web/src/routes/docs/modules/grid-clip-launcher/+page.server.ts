import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Keep this an HTTP redirect. Prerendering produces an HTML refresh which
// drops the incoming fragment in production preview; browsers preserve it on
// the 308 response. The canonical guide retains the audition/song-mode IDs.
export const prerender = false;
export const load: PageServerLoad = () => redirect(308, '/docs/modules/clipplayer');
