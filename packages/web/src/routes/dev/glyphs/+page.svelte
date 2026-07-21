<script lang="ts">
  // DEV-ONLY showcase for the live glyph primitives (VuMeter + ScopeScreen).
  // Renders every mode with DRIVEN demo data so the components can be eyeballed
  // in isolation, off any module card. Gated to `testHooksEnabled()` (DEV OR
  // VITE_E2E_HOOKS=1) — a static notice replaces it in a REAL production build,
  // but it stays reachable in the `vite preview` bundle the CI e2e shards run
  // against (VITE_E2E_HOOKS=1 is baked in there), so live-glyphs.spec.ts can
  // assert the waveform trace on CI, not just against the local dev server.
  import { onMount } from 'svelte';
  import VuMeter from '$lib/ui/controls/VuMeter.svelte';
  import ScopeScreen from '$lib/ui/controls/ScopeScreen.svelte';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  const isDev = testHooksEnabled();

  // A slowly-swept demo level (0..1) for the meters — a triangle LFO so you can
  // watch the segments climb + the peak hold trail.
  let t = $state(0);
  onMount(() => {
    if (!isDev) return;
    let raf = 0;
    const start = performance.now();
    const loop = () => {
      t = (performance.now() - start) / 1000;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });
  // triangle 0..1 at ~0.2 Hz
  const demoLevel = $derived(Math.abs(((t * 0.4) % 2) - 1));
  function getDemoLevel() {
    return demoLevel;
  }

  // A live-ish waveform buffer: a moving sine whose amplitude follows the LFO,
  // so the WAVE screen shows a non-flat, animated trace.
  function getDemoSamples(): Float32Array {
    const n = 1024;
    const buf = new Float32Array(n);
    const amp = 0.2 + 0.8 * demoLevel;
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * 3 * i) / n + t * 4);
    return buf;
  }

  // Interactive envelope + wave controls.
  let attack = $state(0.05);
  let decay = $state(0.2);
  let sustain = $state(0.6);
  let release = $state(0.4);
  let morph = $state(0);
</script>

<svelte:head>
  <title>glyph showcase · dev</title>
</svelte:head>

{#if !isDev}
  <p class="notice">This showcase is available in development builds only.</p>
{:else}
  <div class="page" data-testid="glyph-showcase">
    <h1>Live glyph primitives</h1>
    <p class="lede">VuMeter + ScopeScreen, driven with demo signals. Refactor visual language.</p>

    <section>
      <h2>VuMeter</h2>
      <div class="row">
        <div class="cell">
          <VuMeter getLevel={getDemoLevel} segments={12} testid="show-vu-vert" />
          <span class="cap">vertical · 12</span>
        </div>
        <div class="cell">
          <VuMeter getLevel={getDemoLevel} segments={20} length={140} testid="show-vu-tall" />
          <span class="cap">vertical · 20</span>
        </div>
        <div class="cell">
          <VuMeter getLevel={getDemoLevel} segments={16} orientation="horizontal" length={180} testid="show-vu-horiz" />
          <span class="cap">horizontal · 16</span>
        </div>
        <div class="cell">
          <VuMeter level={demoLevel} segments={12} peakHold={false} testid="show-vu-static" />
          <span class="cap">reactive prop · no peak</span>
        </div>
      </div>
    </section>

    <section>
      <h2>ScopeScreen — waveform (live)</h2>
      <div class="row">
        <div class="cell">
          <ScopeScreen mode="waveform" getSamples={getDemoSamples} width={200} height={90} testid="show-scope-waveform" />
          <span class="cap">live analyser trace</span>
        </div>
      </div>
    </section>

    <section>
      <h2>ScopeScreen — envelope</h2>
      <div class="row">
        <div class="cell">
          <ScopeScreen mode="envelope" {attack} {decay} {sustain} {release} width={220} height={100} testid="show-scope-envelope" />
          <span class="cap">ADSR curve</span>
        </div>
        <div class="controls">
          <label>attack <input type="range" min="0.001" max="2" step="0.001" bind:value={attack} /> {attack.toFixed(3)}s</label>
          <label>decay <input type="range" min="0.001" max="2" step="0.001" bind:value={decay} /> {decay.toFixed(3)}s</label>
          <label>sustain <input type="range" min="0" max="1" step="0.01" bind:value={sustain} /> {sustain.toFixed(2)}</label>
          <label>release <input type="range" min="0.001" max="2" step="0.001" bind:value={release} /> {release.toFixed(3)}s</label>
        </div>
      </div>
    </section>

    <section>
      <h2>ScopeScreen — wave</h2>
      <div class="row">
        <div class="cell">
          <ScopeScreen mode="wave" {morph} width={200} height={90} testid="show-scope-wave" />
          <span class="cap">saw ↔ pulse morph</span>
        </div>
        <div class="controls">
          <label>morph <input type="range" min="0" max="1" step="0.01" bind:value={morph} /> {morph.toFixed(2)}</label>
        </div>
      </div>
    </section>
  </div>
{/if}

<style>
  .page {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 24px 80px;
    color: var(--text, #e6e8ec);
    font-family: system-ui, sans-serif;
  }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .lede { color: var(--text-dim, #9aa0ae); margin: 0 0 24px; }
  h2 { font-size: 0.9rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim, #9aa0ae); margin: 28px 0 12px; }
  .row { display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .cell .cap { font-size: 0.72rem; color: var(--text-dim, #9aa0ae); }
  .controls { display: flex; flex-direction: column; gap: 6px; font-size: 0.75rem; color: var(--text-dim, #9aa0ae); min-width: 240px; }
  .controls label { display: flex; align-items: center; gap: 8px; }
  .controls input { flex: 1; }
  .notice { padding: 48px; text-align: center; color: #9aa0ae; }
</style>
