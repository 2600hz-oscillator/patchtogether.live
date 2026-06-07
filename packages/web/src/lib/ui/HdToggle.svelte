<script lang="ts">
  // HdToggle — a pill button in Canvas.svelte's topbar `.actions`, next to
  // <SkinSwitcher/>. Flips the global HD render mode (hdStore). HD renders every
  // video module's internal FBOs at a viewport-derived ~1080-line resolution
  // instead of the default 640×480; OFF is byte-for-byte identical to today.
  //
  // HD is a DEVICE/GPU capability (a 4090 wants it; a laptop/M-series may not),
  // persisted per-browser in localStorage, NOT synced to collaborators. Default
  // OFF. A `webglcontextlost` auto-revert (wired in Canvas) can flip this back
  // to OFF if the GPU runs out of memory — the badge reflects that.
  //
  // Visual: a small pill mirroring the SkinSwitcher trigger, lit when ON. A
  // tooltip warns it needs a strong GPU. data-testid="hd-toggle" for e2e.
  import { hdStore } from '$lib/ui/hd-store.svelte';

  // Optional badge surfaced by Canvas when the engine auto-reverted HD after a
  // WebGL context loss, so the user knows why HD flipped off on its own.
  let { reverted = false }: { reverted?: boolean } = $props();

  let on = $derived(hdStore.on);
  let res = $derived(hdStore.res);

  function toggle() {
    hdStore.toggle();
  }
</script>

<button
  type="button"
  class="hd-toggle"
  class:on
  class:reverted
  data-testid="hd-toggle"
  aria-pressed={on}
  data-hd-on={on}
  title={reverted
    ? 'HD was auto-disabled after the GPU ran out of memory (WebGL context lost). Click to re-enable.'
    : on
      ? `HD render ON — internal resolution ${res.width}×${res.height}. Click to return to 640×480 (SD). Heavy on the GPU.`
      : 'HD render OFF (640×480). Click for ~1080-line internal resolution at your display aspect. Needs a strong GPU.'}
  onclick={toggle}
>
  <span class="dot" aria-hidden="true"></span>
  <span class="label">HD</span>
  {#if reverted}
    <span class="badge" data-testid="hd-reverted-badge" aria-hidden="true">!</span>
  {/if}
</button>

<style>
  .hd-toggle {
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
  .hd-toggle:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .hd-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .hd-toggle.on {
    color: var(--text);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-dim);
  }
  .hd-toggle.reverted {
    border-color: var(--cable-gate, #f87171);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
    box-shadow: 0 0 0 1px var(--border-strong);
  }
  .hd-toggle.on .dot {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
  }
  .label {
    font-weight: 700;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--cable-gate, #f87171);
    color: #000;
    font-size: 0.65rem;
    font-weight: 800;
    line-height: 1;
  }
</style>
