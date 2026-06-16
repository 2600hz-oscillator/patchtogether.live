// Build-time data for the MAPPY docs page. Sourced DIRECTLY from the module
// def (mappyDef) — the auto /docs/modules/[id] manifest is AUDIO-only (its
// import.meta.glob covers ../audio/modules only), so video modules get a
// dedicated, def-driven page like this one. One source of truth for the IO /
// param tables (the def itself); the .svelte adds the MAPPY-specific prose +
// warp diagram.

import type { PageServerLoad } from './$types';
import { mappyDef } from '$lib/video/modules/mappy';

export const prerender = true;

export const load: PageServerLoad = () => {
  return {
    type: mappyDef.type,
    label: mappyDef.label,
    category: mappyDef.category,
    schemaVersion: mappyDef.schemaVersion,
    inputs: mappyDef.inputs.map((p) => ({ id: p.id, type: p.type })),
    outputs: mappyDef.outputs.map((p) => ({ id: p.id, type: p.type })),
    params: mappyDef.params.map((p) => ({
      id: p.id,
      label: p.label,
      min: p.min ?? null,
      max: p.max ?? null,
      defaultValue: p.defaultValue ?? null,
    })),
  };
};
