<script lang="ts">
  // ClapHeroPanel — the faceplate's HERO VISUALISATION: the BURST train drawn
  // against the ROOM tail on one time axis.
  //
  // ⚠ NOT A TRACE. Every point comes from `clap-face-model`, which computes the
  // two envelopes through the WORKLET'S OWN control laws (`clapSpreadMs` /
  // `clapPulseCount` / `clapTailMs`) off the LIVE param values — so the picture
  // says what the voice WILL do before anything has struck it, which is what a
  // `scope` glyph on a silent drum cannot do.
  //
  // ⚠ THE POINT OF THE PICTURE is WHERE the room starts: it fires at the LAST
  // onset, (PULSES − 1) × SPREAD after the strike, NOT at the strike — so at
  // low SNAP this voice has a hard silent pre-delay that no control on the
  // panel is named after.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the plot WINDOW, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: zooming your own plot must not
  // re-zoom every collaborator's screen or dirty the patch).

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    clapGraph,
    clapVoiceParams,
    type ClapVoiceParams,
  } from './clap-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the whole picture freezes at first render. */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let voice = $derived.by<ClapVoiceParams>(() =>
    clapVoiceParams((id) => {
      const v = live.n?.params?.[id];
      return typeof v === 'number' ? v : undefined;
    }),
  );

  /** 250 ms covers the default voice; 900 ms covers the longest room TAIL's
   *  maximum. COMPONENT STATE — see the header. */
  const WINDOWS_MS = [250, 900] as const;
  let windowMs = $state<number>(WINDOWS_MS[0]);
  let graph = $derived(clapGraph(voice, windowMs));

  const PLOT_W = 100;
  const PLOT_H = 100;

  function series(key: 'burst' | 'room'): string {
    return graph.points
      .map((p) => `${(p.x * PLOT_W).toFixed(2)},${((1 - p[key]) * PLOT_H).toFixed(2)}`)
      .join(' ');
  }

  let burstArea = $derived(`0,${PLOT_H} ${series('burst')} ${PLOT_W},${PLOT_H}`);

  /** Evenly-spaced ticks — this axis is LINEAR in time (unlike kickdrum's
   *  warped one), so the round numbers fall where they say they do. */
  let ticks = $derived(
    [0.25, 0.5, 0.75].map((x) => ({ x, ms: Math.round(x * windowMs) })),
  );
</script>

<div class="clap-hero" data-testid="clap-hero">
  <svg
    viewBox="0 0 {PLOT_W} {PLOT_H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="the burst train and the room tail over the first {windowMs} ms after the strike"
  >
    {#each ticks as t (t.x)}
      <line class="grid" x1={t.x * PLOT_W} x2={t.x * PLOT_W} y1="0" y2={PLOT_H} />
    {/each}
    <polygon class="burst-fill" points={burstArea} />
    <polyline class="burst" points={series('burst')} />
    <polyline class="room" points={series('room')} />
    {#if graph.roomX !== null}
      <line
        class="room-on"
        x1={graph.roomX * PLOT_W}
        x2={graph.roomX * PLOT_W}
        y1="0"
        y2={PLOT_H}
      />
    {/if}
    {#if graph.voiceX !== null}
      <line
        class="voice-end"
        x1={graph.voiceX * PLOT_W}
        x2={graph.voiceX * PLOT_W}
        y1="0"
        y2={PLOT_H}
      />
    {/if}
  </svg>

  <div class="axis">
    <!-- ⚠ THE AXIS ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its labels are
         computed from the window, so a WINDOW button that did nothing cannot
         change them — which is what makes the `text` probe on this element a
         real liveness assertion rather than a button relabelling itself. -->
    <span class="axis-ticks" data-testid="clap-graph-axis">
      <span>0</span>
      {#each ticks as t (t.x)}<span>{t.ms} ms</span>{/each}
    </span>
    <button
      type="button"
      class="win"
      data-testid="clap-graph-window"
      title="Plot window — flip to {windowMs === WINDOWS_MS[0]
        ? WINDOWS_MS[1]
        : WINDOWS_MS[0]} ms (a long room outruns the short view). Your screen only: this is not shared or saved."
      onclick={() => (windowMs = windowMs === WINDOWS_MS[0] ? WINDOWS_MS[1] : WINDOWS_MS[0])}
    >{windowMs} ms</button>
  </div>

  <div class="key">
    <span class="k-burst">burst · the hands</span>
    <span class="k-room">room · fires at the last onset</span>
  </div>
</div>

<style>
  .clap-hero {
    width: 100%;
    display: grid;
    grid-template-rows: 1fr auto auto;
    gap: 3px;
  }

  .clap-hero svg {
    width: 100%;
    height: 104px;
    display: block;
    background: rgb(0 0 0 / 0.35);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 3px;
  }

  /* The traces stroke in the module's DOMAIN hue (the spine cable colour the
     shell sets on the tile). `vector-effect` keeps a 1px stroke 1px wide under
     the non-uniform viewBox scale. */
  .burst,
  .room,
  .room-on,
  .voice-end {
    fill: none;
    vector-effect: non-scaling-stroke;
  }
  .burst {
    stroke: var(--domain, #4dd6c1);
    stroke-width: 1.5;
  }
  .burst-fill {
    fill: color-mix(in srgb, var(--domain, #4dd6c1) 18%, transparent);
    stroke: none;
  }
  .room {
    stroke: #f0a44a;
    stroke-width: 1.25;
    stroke-dasharray: 3 2;
  }
  .room-on {
    stroke: #f0a44a;
    stroke-width: 1;
    stroke-dasharray: 1 3;
    opacity: 0.55;
  }
  .voice-end {
    stroke: rgb(255 255 255 / 0.3);
    stroke-width: 1;
    stroke-dasharray: 2 2;
  }
  .grid {
    stroke: rgb(255 255 255 / 0.07);
    stroke-width: 1;
  }

  .axis {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9px;
    color: rgb(255 255 255 / 0.42);
    font-variant-numeric: tabular-nums;
  }
  .axis-ticks {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .axis-ticks > span {
    text-align: left;
  }

  .win {
    appearance: none;
    background: rgb(255 255 255 / 0.06);
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 1px 5px;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .win:hover {
    background: rgb(255 255 255 / 0.12);
  }

  .key {
    display: flex;
    gap: 10px;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .k-burst {
    color: var(--domain, #4dd6c1);
  }
  .k-room {
    color: #f0a44a;
  }
</style>
