import { error } from '@sveltejs/kit';
import { moduleManifest } from '$lib/docs/modules-manifest';
import type { EntryGenerator, PageLoad } from './$types';

export const prerender = true;
export const ssr = true;
export const csr = true;

// Tell SvelteKit which [id] values to prerender. Without this the prerender
// pass would still discover them via crawled links from /docs/modules, but
// being explicit keeps prerender-only deploys (Cloudflare Pages static) safe
// even if a stray link is missing.
export const entries: EntryGenerator = () =>
  moduleManifest.modules.map((m) => ({ id: m.type }));

export const load: PageLoad = ({ params }) => {
  const mod = moduleManifest.modules.find((m) => m.type === params.id);
  if (!mod) {
    throw error(404, `Unknown module: ${params.id}`);
  }
  return { mod };
};
