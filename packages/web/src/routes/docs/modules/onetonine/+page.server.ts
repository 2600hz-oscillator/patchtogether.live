// Build-time data for the ONE TO NINE docs page. Sourced DIRECTLY from the
// module def (oneToNineDef) — the auto /docs/modules/[id] manifest is
// AUDIO-only, so video modules get a dedicated, def-driven page like this. One
// source of truth for the IO / param tables (the def itself); the .svelte adds
// the splitter-specific prose + numbered-grid diagram.

import type { PageServerLoad } from './$types';
import { oneToNineDef } from '$lib/video/modules/onetonine';

export const prerender = true;

export const load: PageServerLoad = () => {
  return {
    type: oneToNineDef.type,
    label: oneToNineDef.label,
    category: oneToNineDef.category,
    schemaVersion: oneToNineDef.schemaVersion,
    inputs: oneToNineDef.inputs.map((p) => ({ id: p.id, type: p.type })),
    outputs: oneToNineDef.outputs.map((p) => ({ id: p.id, type: p.type })),
    params: oneToNineDef.params.map((p) => ({
      id: p.id,
      label: p.label,
      min: p.min ?? null,
      max: p.max ?? null,
      defaultValue: p.defaultValue ?? null,
    })),
  };
};
