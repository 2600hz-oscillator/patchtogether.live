<script lang="ts">
  // /m — the mobile chooser. Two full-height tiles: GLITCH CAM / POCKET
  // MODULAR. Tiles link with data-sveltekit-reload: the patch store is a
  // module-scope SINGLETON (graph/store.ts), so an SPA nav from cam → synth
  // would leak the cam scene's nodes into the synth scene. A full document
  // load gives each experience a fresh doc.
</script>

<svelte:head>
  <title>patchtogether — mobile</title>
</svelte:head>

<div class="chooser">
  <header class="brand">patchtogether <span class="m">mobile</span></header>
  <a
    class="tile cam"
    href="/m/cam"
    data-sveltekit-reload
    data-sveltekit-preload-data="off"
    data-testid="m-tile-cam"
  >
    <span class="tile-title">glitch cam</span>
    <span class="tile-sub">point your camera through a CRT video bender</span>
  </a>
  <a
    class="tile synth"
    href="/m/synth"
    data-sveltekit-reload
    data-sveltekit-preload-data="off"
    data-testid="m-tile-synth"
  >
    <span class="tile-title">pocket modular</span>
    <span class="tile-sub">a matrix-patched synth rack in your pocket</span>
  </a>
</div>

<style>
  .chooser {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom));
    background: #0e1116;
    color: #dbe2ee;
    touch-action: manipulation;
  }
  .brand {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 6px 4px;
  }
  .brand .m {
    color: #8b93a3;
    font-weight: 400;
  }
  .tile {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-end;
    gap: 6px;
    padding: 20px;
    border-radius: 16px;
    border: 1px solid #2a2f3a;
    text-decoration: none;
    color: inherit;
    -webkit-tap-highlight-color: transparent;
  }
  .tile:active {
    filter: brightness(1.2);
  }
  .tile.cam {
    background:
      radial-gradient(120% 90% at 20% 10%, rgba(240, 80, 120, 0.24), transparent 60%),
      linear-gradient(160deg, #171223, #0e1116);
  }
  .tile.synth {
    background:
      radial-gradient(120% 90% at 80% 10%, rgba(79, 140, 255, 0.22), transparent 60%),
      linear-gradient(200deg, #101a22, #0e1116);
  }
  .tile-title {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.01em;
  }
  .tile-sub {
    font-size: 13px;
    color: #8b93a3;
  }
</style>
