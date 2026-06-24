import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';
import { guideFor } from '$lib/docs/module-guides';

// Numbered-control DEVICE-FACE legends (docs-overhaul §4a). The VRT-annotated
// pipeline (e2e/vrt/vrt-annotated.spec.ts) writes one {type}.legend.json per
// module under e2e/vrt/__annotated__/. We glob them at Vite build time so the
// prerendered doc page can render the numbered legend table beside the face
// PNG. The PNG itself is build-COPIED into static/docs/module-faces/{type}.png
// (scripts/copy-doc-faces.sh, wired into `task build`), served as an <img>.
//
// Seven `../` hops: [id] → modules → docs → routes → src → web → packages →
// repo root, then e2e/vrt/__annotated__/. (Same cross-package glob pattern as
// routes/docs/testing/+page.server.ts — fs.allow in vite.config covers the
// repo root.)
interface FaceLegend {
  type: string;
  platform: string;
  controls: Array<{ n: number; testid: string; kind: string; label: string; units?: string }>;
}
const FACE_LEGENDS = import.meta.glob('../../../../../../../e2e/vrt/__annotated__/*.legend.json', {
  eager: true,
}) as Record<string, { default: FaceLegend } | FaceLegend>;

/** type → legend, keyed off the JSON's own `type` field (robust to the path). */
const LEGEND_BY_TYPE: Record<string, FaceLegend> = {};
for (const mod of Object.values(FACE_LEGENDS)) {
  const legend = (mod as { default?: FaceLegend }).default ?? (mod as FaceLegend);
  if (legend && legend.type) LEGEND_BY_TYPE[legend.type] = legend;
}

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

  // Numbered face: present only when the annotated pipeline has generated a
  // legend (+ the build copied the PNG). When absent, the page falls back to
  // the abstract IoDiagram.
  const legend = LEGEND_BY_TYPE[mod.type] ?? null;
  const face = legend
    ? { src: `/docs/module-faces/${mod.type}.png`, controls: legend.controls }
    : null;

  return {
    mod,
    face,
    guide: guideFor(mod.type),
    prev: prev ? { type: prev.type, label: prev.label } : null,
    next: next ? { type: next.type, label: next.label } : null,
  };
};
