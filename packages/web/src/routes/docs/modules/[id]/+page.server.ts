import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';
import { guideFor } from '$lib/docs/module-guides';

// SvelteKit prerender enumerator — declares every [id] value to bake into
// static HTML at build time. Without this, the prerender step would skip
// dynamic routes (or, worse, error out under `prerender = true`).
export const entries: EntryGenerator = () => {
  return buildModuleManifest().modules.map((m) => ({ id: m.type }));
};

export const load: PageServerLoad = ({ params }) => {
  const manifest = buildModuleManifest();
  const mod = manifest.modules.find((m) => m.type === params.id);
  if (!mod) {
    throw error(404, `Unknown module: ${params.id}`);
  }
  // Sibling links — neighbors within the same category for nav.
  const sameCat = manifest.modules.filter((m) => m.category === mod.category);
  const idx = sameCat.findIndex((m) => m.type === mod.type);
  const prev = idx > 0 ? sameCat[idx - 1] : null;
  const next = idx >= 0 && idx < sameCat.length - 1 ? sameCat[idx + 1] : null;
  return {
    mod,
    guide: guideFor(mod.type),
    prev: prev ? { type: prev.type, label: prev.label } : null,
    next: next ? { type: next.type, label: next.label } : null,
  };
};
