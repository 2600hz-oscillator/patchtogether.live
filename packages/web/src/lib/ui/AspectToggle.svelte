<script lang="ts">
  // AspectToggle — a pill in Canvas.svelte's topbar `.actions`, next to
  // <SkinSwitcher/>. Flips the OUTPUT aspect (videoAspectStore) between
  // 4:3 (1024×768) and 16:9 (1366×768).
  //
  // Unlike the reverted #653 HD toggle (which tore down + rebuilt the whole
  // engine and broke the output), this drives an IN-PLACE buffer realloc via
  // VideoEngine.setResolution — the patched OUTPUT survives the switch. The
  // aspect persists in the patch Y.Doc settings, so it rides save/load +
  // performance export + multiplayer sync.
  //
  // Visual: a small pill mirroring the SkinSwitcher trigger, lit when 16:9.
  // data-testid="aspect-toggle".
  import { videoAspectStore } from '$lib/ui/video-aspect-store.svelte';

  let aspect = $derived(videoAspectStore.aspect);
  let isWide = $derived(videoAspectStore.isWide);
  let res = $derived(videoAspectStore.engineRes);

  function toggle(): void {
    videoAspectStore.toggle();
  }
</script>

<button
  type="button"
  class="aspect-toggle"
  class:on={isWide}
  data-testid="aspect-toggle"
  aria-pressed={isWide}
  data-video-aspect={aspect}
  title={isWide
    ? `Output aspect 16:9 (${res.width}×${res.height}). Click for 4:3 (1024×768).`
    : `Output aspect 4:3 (${res.width}×${res.height}). Click for 16:9 (1366×768).`}
  onclick={toggle}
>
  <span class="dot" aria-hidden="true"></span>
  <span class="label">{aspect}</span>
</button>

<style>
  .aspect-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--surface-2);
    color: var(--text-dim);
    border: 1px solid var(--border-strong);
    padding: 0.35rem 0.7rem;
    font-size: 0.8rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .aspect-toggle:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .aspect-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .aspect-toggle.on {
    color: var(--text);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-dim);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
    box-shadow: 0 0 0 1px var(--border-strong);
  }
  .aspect-toggle.on .dot {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }
  .label {
    font-weight: 700;
    min-width: 2.4em;
    text-align: center;
  }
</style>
