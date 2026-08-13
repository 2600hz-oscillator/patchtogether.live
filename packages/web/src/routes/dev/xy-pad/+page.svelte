<script lang="ts">
  // DEV-ONLY showcase for <XyPad> AS A FACE CELL — the 2-D pad param cell.
  // Gated to `testHooksEnabled()` (DEV OR VITE_E2E_HOOKS=1) exactly like the
  // sibling /dev/color-field, /dev/param-grid and /dev/glyphs showcases, so it
  // stays reachable in the `vite preview` bundle the CI e2e shards run against
  // and a static notice replaces it in a real production build.
  //
  // WHY A SHOWCASE AND NOT A FACE. `xy` is a PLATFORM cell kind landing one PR
  // before its first consumer — no shipped def declares `face.xyPads`, so
  // faces-parity never enters its `driveCell` arm. `param-cell-coverage.test.ts`
  // makes the platform DECLARE that gap rather than discover it on the first
  // face PR's red shard, and names this page as what covers the primitive
  // meanwhile.
  //
  // FOUR properties, every one of them invisible to a unit test:
  //
  //   1. ONE DRAG MOVES BOTH AXES. This is the whole reason the kind exists and
  //      the only property that distinguishes it from two knobs. Two dials can
  //      reach every value this pad can; they cannot reach them TOGETHER.
  //   2. IT DECLARES WHAT IT COVERS. `data-control-params` carries both axis
  //      ids, which is how faces-parity's exact dock multiset survives a
  //      control that is one element over two params. Without it a faced pad
  //      reads as two LOST controls.
  //   3. ⚠ THE WITNESS FOLLOWS THE COMMITTED VALUES, NOT THE DOT. The pad moves
  //      its own dot synchronously during a drag (it owns the gesture so a poll
  //      cannot fight it), so "the dot moved" is true of a pad whose writes go
  //      nowhere. The `severed` host below is the same component with both
  //      handlers discarded — the shape of a live-looking dead control — and
  //      its witness must stay put while the live one moves. That is the
  //      negative control for property 1, run in a browser on every sweep
  //      rather than argued once in a comment.
  //   4. PER-AXIS RANGES CLAMP. The two axes take INDEPENDENT ranges and this
  //      is the primitive the backdraft regression is named after: the card
  //      passed literal ±1 against a def declaring ±0.2, so the pad wrote
  //      values the contract forbids and the model clamped them silently. A
  //      narrowed axis here must clamp inside the primitive.
  import { onMount } from 'svelte';
  import XyPad from '$lib/ui/controls/XyPad.svelte';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  const isDev = testHooksEnabled();

  // HYDRATION SIGNAL — the param-grid / color-field precedent. This route is
  // server-rendered, so the pad is PAINTED a beat before Svelte attaches its
  // pointer handlers; a gesture in that window is silently swallowed. That was
  // a real `--repeat-each=3` flake on the sibling showcases, and this is a
  // by-construction signal rather than a wall-clock budget.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  /** A normal, committing pad over two independent ranges. */
  let liveX = $state(0);
  let liveY = $state(0);

  /**
   * ⚠ THE SEVERED PAD. Same component, same props, both handlers DISCARDED —
   * the shape of a 2-D control that renders, tracks the cursor and writes
   * nothing. `severedAttempts` proves the handlers really did fire, so
   * "severed" stays distinguishable from "never driven": without it, a spec
   * that failed to reach the pad at all would satisfy the same assertions.
   */
  let severedAttempts = $state(0);

  /** A def-narrowed axis pair: x is ±0.2 (backdraft's real camTilt span), y is
   *  ±0.5 (its camPos span). A drag to the corner must CLAMP to these. */
  const NARROW_X = 0.2;
  const NARROW_Y = 0.5;
  let clampX = $state(0);
  let clampY = $state(0);
</script>

<svelte:head>
  <title>xy pad cell showcase · dev</title>
</svelte:head>

{#if !isDev}
  <p class="notice">This showcase is available in development builds only.</p>
{:else}
  <main data-testid="xy-pad-page" data-hydrated={hydrated}>
    <h1>xy pad cell</h1>

    <section data-testid="live-host">
      <h2>live</h2>
      <XyPad
        xValue={liveX}
        yValue={liveY}
        xMin={-1}
        xMax={1}
        yMin={-1}
        yMax={1}
        xLabel="X"
        yLabel="Y"
        onXChange={(v) => (liveX = v)}
        onYChange={(v) => (liveY = v)}
        size={96}
        moduleId="showcase"
        xParamId="liveX"
        yParamId="liveY"
      />
      <!-- THE WITNESS: derived from the COMMITTED values, never from the dot. -->
      <p data-testid="live-witness">{liveX.toFixed(4)} / {liveY.toFixed(4)}</p>
    </section>

    <section data-testid="severed-host">
      <h2>severed</h2>
      <XyPad
        xValue={0}
        yValue={0}
        xMin={-1}
        xMax={1}
        yMin={-1}
        yMax={1}
        xLabel="X"
        yLabel="Y"
        onXChange={() => severedAttempts++}
        onYChange={() => severedAttempts++}
        size={96}
        moduleId="showcase"
        xParamId="sevX"
        yParamId="sevY"
      />
      <p data-testid="severed-witness">{(0).toFixed(4)} / {(0).toFixed(4)}</p>
      <p data-testid="severed-attempts">{severedAttempts}</p>
    </section>

    <section data-testid="clamped-host">
      <h2>clamped</h2>
      <XyPad
        xValue={clampX}
        yValue={clampY}
        xMin={-NARROW_X}
        xMax={NARROW_X}
        yMin={-NARROW_Y}
        yMax={NARROW_Y}
        xLabel="X"
        yLabel="Y"
        onXChange={(v) => (clampX = v)}
        onYChange={(v) => (clampY = v)}
        size={96}
        moduleId="showcase"
        xParamId="clampX"
        yParamId="clampY"
      />
      <p data-testid="clamped-witness">{clampX.toFixed(4)} / {clampY.toFixed(4)}</p>
      <p data-testid="clamped-bounds">{NARROW_X} / {NARROW_Y}</p>
    </section>
  </main>
{/if}

<style>
  main {
    display: flex;
    gap: 32px;
    padding: 24px;
    flex-wrap: wrap;
    font-family: system-ui, sans-serif;
  }
  h1 {
    flex-basis: 100%;
    font-size: 16px;
  }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    opacity: 0.7;
  }
  p {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .notice {
    padding: 24px;
    font-family: system-ui, sans-serif;
  }
</style>
