import type { ShellExtension } from '$lib/ui/workflow/shell-extensions';
import PhasesBody from './PhasesBody.svelte';
import PhasesTileBody from './PhasesTileBody.svelte';

// Per-node envelope geometry is an editor, not a parameter-derived glyph.
// Both surfaces edit the same graph data; playback belongs to the factory.
export default {
  fullViewBody: PhasesBody,
  tileBody: PhasesTileBody,
} satisfies ShellExtension;
