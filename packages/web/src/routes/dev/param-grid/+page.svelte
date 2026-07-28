<script lang="ts">
  // DEV-ONLY showcase for <ParamGrid> — the PF-15 chip + portaled grid popover.
  // Gated to `testHooksEnabled()` (DEV OR VITE_E2E_HOOKS=1) exactly like the
  // sibling /dev/glyphs showcase, so it stays reachable in the `vite preview`
  // bundle the CI e2e shards run against and a static notice replaces it in a
  // real production build.
  //
  // WHY A SHOWCASE AND NOT A FACE. ParamGrid is a PLATFORM primitive that lands
  // one PR before its first consumer (dx7's algorithm picker), so there is no
  // module whose `face.paramCells` could exercise it yet. The properties worth
  // pinning are the ones that are easy to break and expensive to discover
  // later — that the popover really is PORTALED out of its host (an absolutely
  // positioned one is clipped to nothing by `.rl-tile { overflow: hidden }` and
  // mispositioned under SvelteFlow's transformed pane), that the CHIP and not
  // the portaled radiogroup carries `control-<paramId>` (a testid inside the
  // portal drops the param out of faces-parity's dock multiset and reads as a
  // LOST control), and that picking commits + closes. `param-grid.spec.ts`
  // asserts all three here; PR 4 inherits a primitive that already works.
  import ParamGrid from '$lib/ui/controls/ParamGrid.svelte';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  const isDev = testHooksEnabled();

  // A 32-step discrete range with a declared formatter — the DX7 algorithm
  // shape, without the DX7.
  let algorithm = $state(5);
  const algFormat = (v: number) => `ALG ${String(Math.round(v)).padStart(2, '0')}`;

  // A short DECLARED roster, to prove `options` wins over the derived range.
  let mode = $state(0);
  const MODE_OPTIONS = [
    { value: 0, label: 'LP', title: 'low pass' },
    { value: 1, label: 'HP', title: 'high pass' },
    { value: 2, label: 'BP', title: 'band pass' },
  ];
</script>

<svelte:head>
  <title>param grid showcase · dev</title>
</svelte:head>

{#if !isDev}
  <p class="notice">This showcase is available in development builds only.</p>
{:else}
  <main>
    <h1>ParamGrid</h1>

    <!-- The `overflow: hidden` box is the POINT: it reproduces the RACKLINE
         tile that clipped an absolutely-positioned popover to nothing. -->
    <section class="host" data-testid="grid-host">
      <ParamGrid
        value={algorithm}
        min={1}
        max={32}
        label="algorithm"
        format={algFormat}
        paramId="algorithm"
        moduleId="showcase"
        onchange={(v) => (algorithm = v)}
      />
    </section>
    <p class="readout" data-testid="algorithm-value">{algorithm}</p>

    <section class="host" data-testid="mode-host">
      <ParamGrid
        value={mode}
        min={0}
        max={2}
        options={MODE_OPTIONS}
        label="mode"
        paramId="mode"
        moduleId="showcase"
        onchange={(v) => (mode = v)}
      />
    </section>
    <p class="readout" data-testid="mode-value">{mode}</p>
  </main>
{/if}

<style>
  main { padding: 24px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  h1 { font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
  /* The clipping host the portal has to escape. */
  .host { overflow: hidden; padding: 8px; border: 1px solid var(--border, #2c3037); border-radius: 6px; }
  .readout { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; color: var(--text-dim); }
  .notice { padding: 24px; font-family: var(--mono, ui-monospace, monospace); }
</style>
