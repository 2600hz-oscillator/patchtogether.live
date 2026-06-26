import { error } from '@sveltejs/kit';
import type { EntryGenerator, PageServerLoad } from './$types';
import { buildModuleManifest } from '$lib/docs/module-manifest';
import { guideFor } from '$lib/docs/module-guides';
import { resolveLegend, type LegendEntry } from '$lib/docs/control-doc-resolver';
import { buildDocIndex } from '$lib/docs/doc-index';
import { INTERACTIVE_DOC_MODULES } from '$lib/docs/interactive/interactive-doc-modules';

// NUMBERED card-FACE legends. The VRT pipeline (e2e/vrt/vrt-annotated.spec.ts)
// writes one {type}.legend.json (number → stable test id) per module under
// e2e/vrt/__annotated__/, plus the numbered face PNG. We glob the legends at
// Vite build time and RESOLVE each number to its authored `docs.controls` blob
// (control-doc-resolver) so the page renders a numbered KEY of authored content,
// not raw test ids. The PNG is build-COPIED into
// static/docs/module-faces/{type}.png (scripts/copy-doc-faces.sh) and served as
// an <img>.
//
// Seven `../` hops: [id] → modules → docs → routes → src → web → packages →
// repo root, then e2e/vrt/__annotated__/. (Same cross-package glob pattern as
// routes/docs/testing/+page.server.ts — fs.allow in vite.config covers the
// repo root.)
interface FaceLegend {
  type: string;
  platform: string;
  controls: LegendEntry[];
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

  // Numbered face + resolved KEY: present only when the pipeline has generated a
  // legend (+ the build copied the PNG). Each numbered control resolves to its
  // authored `docs.controls` blob. When absent, the page falls back to the
  // abstract IoDiagram + the authored controls table.
  const legend = LEGEND_BY_TYPE[mod.type] ?? null;
  const face = legend
    ? {
        src: `/docs/module-faces/${mod.type}.png`,
        controls: resolveLegend(legend.controls, { params: mod.params, docs: mod.docs }),
      }
    : null;

  // Interactive virtual-module payload (the redesign): a flat, client-resolvable
  // doc index + the minimal def shape the live card needs to seed a sandbox
  // node. PRERENDER-SAFE — buildDocIndex is pure (no live-registry import). The
  // live card only mounts for prototype modules in INTERACTIVE_DOC_MODULES; all
  // others keep the static numbered-face primary view.
  const docIndex = buildDocIndex(mod);
  const interactive = INTERACTIVE_DOC_MODULES.has(mod.type);
  const defLite = {
    type: mod.type,
    domain: 'audio' as const,
    params: mod.params.map((p) => ({ id: p.id, defaultValue: p.defaultValue })),
  };

  return {
    mod,
    face,
    docIndex,
    interactive,
    defLite,
    guide: guideFor(mod.type),
    prev: prev ? { type: prev.type, label: prev.label } : null,
    next: next ? { type: next.type, label: next.label } : null,
  };
};
