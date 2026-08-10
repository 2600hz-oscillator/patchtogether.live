<script lang="ts">
  // DEV-ONLY showcase for <ColorField> — the packed-RGB colour cell.
  // Gated to `testHooksEnabled()` (DEV OR VITE_E2E_HOOKS=1) exactly like the
  // sibling /dev/param-grid and /dev/glyphs showcases, so it stays reachable in
  // the `vite preview` bundle the CI e2e shards run against and a static notice
  // replaces it in a real production build.
  //
  // WHY A SHOWCASE AND NOT A FACE. ColorField is a PLATFORM primitive landing
  // one PR before its first consumer (wavesculpt's face), so no
  // `face.paramCells['x'] = 'color'` exists to exercise it through
  // faces-parity — a fact `param-cell-coverage.test.ts` makes the platform
  // DECLARE rather than discover. This page is the substitute that test names,
  // and it pins the properties a unit test structurally cannot see:
  //
  //   1. the `<input type="color">` IS the visible swatch — one element that is
  //      both operable and paintable, not a decorative <span> over a hidden
  //      input (the legacy WavesculptCard shape, where `toBeVisible()` on the
  //      swatch proves nothing about the input);
  //   2. it carries `control-<paramId>`, so the param stays inside
  //      faces-parity's exact dock multiset;
  //   3. THE WITNESS FOLLOWS THE COMMITTED VALUE, NOT THE PICKER. The
  //      `severed` host below deliberately drops the write — the input is
  //      real, the swatch paints, and nothing is committed — which is exactly
  //      what a decorative colour control looks like from the outside. Its
  //      witness must stay put while the live one moves. That is the negative
  //      control for the parity probe's third leg, run in a browser on every
  //      e2e sweep rather than asserted once at authoring time.
  //   4. the RANGE comes from the props (i.e. from the def), so a pick past a
  //      narrowed `max` clamps instead of writing through.
  import { onMount } from 'svelte';
  import ColorField from '$lib/ui/controls/ColorField.svelte';
  import { PACKED_RGB_MAX, packedToHex } from '$lib/ui/controls/color-field-model';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  const isDev = testHooksEnabled();

  // HYDRATION SIGNAL — the param-grid precedent. This route is
  // server-rendered, so the input is PAINTED a beat before Svelte attaches its
  // handler; a gesture in that window is silently swallowed. That was a real
  // `--repeat-each=3` flake there, and it is a by-construction signal rather
  // than a wall-clock budget.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  /** The wavesculpt RED default — a normal, committing cell. */
  let live = $state(0xff3333);

  /**
   * ⚠ THE SEVERED CELL. Same component, same props, `onchange` DISCARDED — the
   * shape of a colour control that renders and writes nothing. `attempts`
   * proves the handler really did fire, so "severed" is distinguishable from
   * "never driven": without it, a spec that failed to reach the input at all
   * would satisfy the same assertions.
   */
  const SEVERED_VALUE = 0x33ff4d;
  let severedAttempts = $state(0);

  /** A def-narrowed span: 0..0x0000ff. A pick above it must CLAMP. */
  const CLAMPED_MAX = 0x0000ff;
  let clamped = $state(0x000010);
</script>

<svelte:head>
  <title>color field showcase · dev</title>
</svelte:head>

{#if !isDev}
  <p class="notice">This showcase is available in development builds only.</p>
{:else}
  <main data-testid="color-field-page" data-hydrated={hydrated}>
    <h1>ColorField</h1>

    <section class="host" data-testid="live-host">
      <ColorField
        value={live}
        min={0}
        max={PACKED_RGB_MAX}
        label="R.Col"
        paramId="red_color"
        onchange={(v) => (live = v)}
      />
    </section>
    <p class="readout" data-testid="live-packed">{live}</p>
    <p class="readout" data-testid="live-expected-hex">{packedToHex(live)}</p>

    <!-- THE NEGATIVE CONTROL: identical render, no commit. -->
    <section class="host" data-testid="severed-host">
      <ColorField
        value={SEVERED_VALUE}
        min={0}
        max={PACKED_RGB_MAX}
        label="G.Col"
        paramId="grn_color"
        onchange={() => (severedAttempts += 1)}
      />
    </section>
    <p class="readout" data-testid="severed-packed">{SEVERED_VALUE}</p>
    <p class="readout" data-testid="severed-attempts">{severedAttempts}</p>

    <!-- RANGE FROM THE DEF: a narrowed span that a pick must clamp into. -->
    <section class="host" data-testid="clamped-host">
      <ColorField
        value={clamped}
        min={0}
        max={CLAMPED_MAX}
        label="B.Col"
        paramId="blu_color"
        onchange={(v) => (clamped = v)}
      />
    </section>
    <p class="readout" data-testid="clamped-packed">{clamped}</p>
    <p class="readout" data-testid="clamped-max">{CLAMPED_MAX}</p>
  </main>
{/if}

<style>
  main { padding: 24px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  h1 { font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim); }
  .host { padding: 8px; border: 1px solid var(--border, #2c3037); border-radius: 6px; }
  .readout { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; color: var(--text-dim); }
  .notice { padding: 24px; font-family: var(--mono, ui-monospace, monospace); }
</style>
