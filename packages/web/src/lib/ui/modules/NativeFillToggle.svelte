<script lang="ts">
  // NativeFillToggle — per-source fit/fill control for video SOURCE cards.
  //
  // Modelled on p10entrancer's PadFillModeToggle.swift. Two visual states:
  //   - NATIVE: when the source's native aspect already matches the OUTPUT
  //     aspect (within tolerance) there's nothing to fit, so we show a
  //     non-interactive green "N" badge instead of the toggle.
  //   - Otherwise a toggle whose label shows the CURRENT mode:
  //       - FILL (cover-crop): fills the canvas, cropping the long axis.
  //       - LETTERBOX (contain): fits inside the canvas with black bars.
  //     Neither mode ever distorts the source aspect.
  //
  // The mode is a discrete `fillMode` PARAM on the source node (0 = letterbox,
  // 1 = fill) — so it persists in the Y.Doc, rides save/load + the performance
  // bundle, and syncs across collaborators via the standard param machinery.
  //
  // The output aspect is read live from videoAspectStore so the Native badge
  // appears/disappears as the user toggles 4:3 ↔ 16:9 (e.g. a 16:9 source is
  // Native in 16:9, fit-able in 4:3).

  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';
  import { aspectRatio } from '$lib/video/video-res';
  import { isNativeAspect } from '$lib/video/video-res';

  let {
    fillMode,
    srcAspect,
    onchange,
  }: {
    /** The current fillMode param value (0 = letterbox, 1 = fill). */
    fillMode: number;
    /** The source's native aspect (width / height). */
    srcAspect: number;
    /** Persist a new fillMode value (0 | 1) onto the node param. */
    onchange: (v: number) => void;
  } = $props();

  let outputAspect = $derived(aspectRatio(videoAspectStore.aspect));
  let native = $derived(isNativeAspect(srcAspect, outputAspect));
  let isFill = $derived(fillMode >= 0.5);

  function toggle(): void {
    onchange(isFill ? 0 : 1);
  }
</script>

{#if native}
  <span
    class="fit-native"
    data-testid="source-fit-native"
    title="Native aspect — source matches the output ({videoAspectStore.aspect}); no fit needed."
    aria-label="Native aspect ratio"
  >N</span>
{:else}
  <button
    type="button"
    class="fit-toggle"
    class:fill={isFill}
    data-testid="source-fit-toggle"
    data-fill-mode={isFill ? 'fill' : 'letterbox'}
    aria-pressed={isFill}
    title={isFill
      ? 'FILL (cover-crop) — fills the output, cropping the off-axis. Click to LETTERBOX.'
      : 'LETTERBOX — fits inside the output with bars. Click to FILL (cover-crop).'}
    onclick={toggle}
  >Fit: {isFill ? 'Fill' : 'Letterbox'}</button>
{/if}

<style>
  .fit-native {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #16a34a;
    color: #fff;
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    font-weight: 800;
    line-height: 1;
    user-select: none;
  }
  .fit-toggle {
    font-family: inherit;
    font-size: 0.65rem;
    padding: 2px 7px;
    border-radius: 2px;
    cursor: pointer;
    background: #14171f;
    color: var(--text);
    border: 1px solid var(--border);
    letter-spacing: 0.02em;
  }
  .fit-toggle:hover { border-color: var(--accent-dim); }
  .fit-toggle.fill {
    border-color: var(--cable-video);
    color: var(--text);
  }
  .fit-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
</style>
