<!--
  WaveformGlyph.svelte — small inline SVG icon showing the shape of a
  waveform. Used next to faders that morph across waveforms (LFO shape,
  Cartesian-embedded LFO shape) so the user sees what they're dragging into.
-->
<script lang="ts">
  interface Props {
    kind: 'sine' | 'tri' | 'saw' | 'square';
    size?: number;
    /** When true, render with the active-waveform highlight color. */
    active?: boolean;
  }
  let { kind, size = 16, active = false }: Props = $props();

  // SVG paths drawn in a 24x24 viewBox so all four glyphs share the same
  // proportions. Each waveform fills horizontally edge-to-edge with one
  // complete cycle starting + ending at zero crossings.
  const PATHS: Record<Props['kind'], string> = {
    sine:   'M 0 12 Q 3 1, 6 12 T 12 12 Q 15 1, 18 12 T 24 12',
    tri:    'M 0 12 L 6 2 L 12 12 L 18 22 L 24 12',
    saw:    'M 0 22 L 0 22 L 12 2 L 12 22 L 24 2 L 24 22',
    square: 'M 0 22 L 0 4 L 12 4 L 12 22 L 24 22 L 24 4',
  };
</script>

<svg
  class="glyph"
  class:active
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
>
  <path d={PATHS[kind]} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>

<style>
  .glyph {
    color: var(--text-dim);
    flex-shrink: 0;
    transition: color 0.08s ease-out;
  }
  .glyph.active {
    color: var(--cable-cv);
  }
</style>
