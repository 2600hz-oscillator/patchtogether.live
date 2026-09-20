import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Preserve bookmarks to the old mixed Clip Player / monome guide. Browsers
// retain the old fragment; the canonical guide retains audition/song-mode IDs.
export const load: PageServerLoad = () => redirect(308, '/docs/modules/clipplayer');
