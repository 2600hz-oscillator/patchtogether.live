import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';
import { guideFor } from '$lib/docs/module-guides';

// Clean card-FACE images. The VRT-annotated pipeline (e2e/vrt/vrt-annotated.spec.ts)
// writes one CLEAN card screenshot per module to
// e2e/vrt/__annotated__/darwin/{type}.png. We glob the darwin PNGs at Vite build
// time purely to know WHICH modules have a face; the PNG itself is build-COPIED
// into static/docs/module-faces/{type}.png (scripts/copy-doc-faces.sh, wired into
// `task build`) and served as an <img>. Controls are documented from the
// authored, drift-gated `docs.controls` — there is no testid legend any more.
//
// Seven `../` hops: [id] → modules → docs → routes → src → web → packages →
// repo root, then e2e/vrt/__annotated__/darwin/. (Same cross-package glob pattern
// as routes/docs/testing/+page.server.ts — fs.allow in vite.config covers the
// repo root.) darwin is the canonical doc image (linux exists only for CI VRT
// determinism); we never read it here.
const FACE_PNGS = import.meta.glob(
  '../../../../../../../e2e/vrt/__annotated__/darwin/*.png',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>;

/** Set of module `type`s that have a committed card face PNG. */
const FACE_TYPES = new Set(
  Object.keys(FACE_PNGS).map((p) => p.split('/').pop()!.replace(/\.png$/, '')),
);

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

  // Card face: present only when the pipeline has generated a PNG (+ the build
  // copied it). When absent, the page falls back to the abstract IoDiagram.
  const face = FACE_TYPES.has(mod.type)
    ? { src: `/docs/module-faces/${mod.type}.png` }
    : null;

  return {
    mod,
    face,
    guide: guideFor(mod.type),
    prev: prev ? { type: prev.type, label: prev.label } : null,
    next: next ? { type: next.type, label: next.label } : null,
  };
};
