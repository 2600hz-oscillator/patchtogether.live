<script lang="ts">
  // CofefveEchoTrainPanel — the faceplate's HERO: the echo train the CURRENT
  // settings will actually produce.
  //
  // ⚠ NOT A TRACE. Every stem is computed from the live params through the
  // shipping DSP's own loop arithmetic (`cofefve-face-model`), so it is what
  // the module is ABOUT TO DO rather than a reading of what came out. That
  // matters here more than on most modules, because this one's `scope` glyph is
  // a live trace of an INSERT — a flat line on a silent rack, which is exactly
  // when a player is setting a delay up. The picture is legible at rest.
  //
  // ⚠ AND IT IS THE ONE SURFACE THAT CAN SHOW A DEAD CONTROL AS DEAD. The WOW
  // ripple over the train is drawn only while WOW AMOUNT is above 0. At the
  // shipped default the ripple is greyed and captioned `wow off`, so the
  // picture SAYS the motion section is asleep instead of drawing a steady train
  // that looks like a working one. Seven of this module's twenty-three controls
  // do nothing at the factory default, five of them bit-exactly; refusing to paint them as
  // working is this faceplate's whole job.
  //
  // ⚠ WHAT IT DELIBERATELY DOES NOT DRAW: a number for the SYNCED spacing. When
  // SYNC is on the DSP replaces TIME with `beatPeriod × division`, and the beat
  // period is bridged in from the host (TIMELORDE / MIDI clock) — it is not a
  // param and no pure model can read it. So the train keeps drawing TIME and
  // the caption says `SYNC — spacing follows the beat`, which is true, rather
  // than a guessed tempo, which would not be.
  //
  // ⚠ THIS PANEL EMITS NO `control-<paramId>` TESTID (shell-cells rule 1). Its
  // one writable affordance is the time WINDOW, which is PRIVATE VIEW STATE
  // (component state, never `node.data`: zooming your own plot must not zoom
  // every collaborator's screen or dirty the patch) — the kickdrum precedent.
  // That is also its declared operability probe: the button drives the axis
  // ticks, which a dead button cannot change.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    asleepControls,
    cofefveFaceParams,
    echoSpacingText,
    echoTrain,
    stereoSkewS,
    syncEngaged,
    wowDepth,
    fmtSeconds,
    ECHO_WINDOWS,
    windowTicks,
  } from './cofefve-face-model';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /** ⚠ THE VERSION IS CARRIED IN THE RESULT (the ModuleShell `liveCell`
   *  pattern). `patch.nodes[id]` is a stable SyncedStore proxy, so a derived
   *  that bumps on `nodeVersion(id)` and returns it BARE is `===` to its
   *  previous value and the picture freezes at first render. */
  let live = $derived.by(() => ({
    v: nodeVersion(nodeId),
    n: patch.nodes[nodeId] as ModuleNode | undefined,
  }));

  let p = $derived(cofefveFaceParams((id) => live.n?.params?.[id]));

  /** COMPONENT STATE — see the header. Also the declared operability probe. */
  let windowIdx = $state(0);
  let windowS = $derived(ECHO_WINDOWS[windowIdx] ?? ECHO_WINDOWS[0]!);

  let hits = $derived(echoTrain(p, windowS));
  let depth = $derived(wowDepth(p));
  let skewS = $derived(stereoSkewS(p));
  let asleep = $derived(asleepControls(p));

  // Plot box, in the SVG's own user units. Fixed so the picture's vertical
  // scale never re-normalises — a train that rescaled itself would look
  // identical at every feedback setting, which is the one thing it is drawn to
  // show.
  const W = 320;
  const H = 96;
  const PAD_L = 6;
  const PAD_R = 6;
  const BASE_Y = H - 16;
  const TOP_Y = 8;

  function x(t: number): number {
    return PAD_L + (t / windowS) * (W - PAD_L - PAD_R);
  }
  function y(level: number): number {
    return BASE_Y - Math.max(0, Math.min(1, level)) * (BASE_Y - TOP_Y);
  }

  /** The WOW ripple as an SVG path across the plot — the sine that warps the
   *  read time, drawn at its live depth and rate. Greyed at depth 0. */
  let ripple = $derived.by(() => {
    const amp = 6 * (depth / 0.5) || 0;
    const cycles = Math.max(0.25, p.lfoFrequency * windowS);
    const pts: string[] = [];
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      const px = PAD_L + u * (W - PAD_L - PAD_R);
      const py = TOP_Y - 2 + Math.sin(u * cycles * Math.PI * 2) * (depth > 0 ? amp : 2);
      pts.push(`${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return pts.join(' ');
  });
</script>

<div class="echo" data-testid="cofefve-echo">
  <svg
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    role="img"
    aria-label="the echo train this patch produces: {hits.length - 1} repeats spaced {echoSpacingText(
      p,
    )} apart{depth > 0 ? ', with wow' : ', wow off'}"
  >
    <!-- The WOW ripple: live at depth, a flat grey rule at 0. -->
    <path class="ripple" class:off={depth === 0} d={ripple} />
    <!-- The baseline the stems stand on. -->
    <line class="base" x1={PAD_L} y1={BASE_Y} x2={W - PAD_R} y2={BASE_Y} />
    {#each hits as h (h.n)}
      {#if skewS > 0}
        <!-- SPLIT into two stems: STEREO skews the two read times apart by
             2 × |offset| × TIME, so the left repeat lands early and the right
             late. Drawn as two stems rather than one, because "the image is
             wide" is a fact about WHEN, not about level. -->
        <line class="stem l" x1={x(h.tL)} y1={BASE_Y} x2={x(h.tL)} y2={y(h.level)} />
        <line class="stem r" x1={x(h.tR)} y1={BASE_Y} x2={x(h.tR)} y2={y(h.level)} />
      {:else}
        <line
          class="stem"
          class:dry={h.n === 0}
          class:inv={h.inverted}
          x1={x(h.tL)}
          y1={BASE_Y}
          x2={x(h.tL)}
          y2={y(h.level)}
        />
      {/if}
    {/each}
  </svg>

  <!-- ⚠ THE TICK ROW IS THE PANEL'S OPERABILITY PROBE TARGET. Its text is
       computed from the window, so a WINDOW button that did nothing cannot
       change it — a real liveness assertion rather than a button relabelling
       itself. `cofefve-face-model.test.ts` asserts no two windows can ever
       render the same tick row. -->
  <div class="axis" data-testid="cofefve-echo-axis">
    {#each windowTicks(windowS) as t (t)}<span>{fmtSeconds(t)}</span>{/each}
  </div>

  <div class="foot">
    <span class="cap" data-testid="cofefve-echo-caption">
      {#if syncEngaged(p)}SYNC — spacing follows the beat{:else}{hits.length - 1} repeats · {echoSpacingText(p)} apart{/if}
    </span>
    <span class="cap" class:warn={depth === 0}>{depth > 0 ? `wow ${(depth * 100).toFixed(0)} %` : 'wow off'}</span>
    <span class="cap" class:warn={skewS === 0}>{skewS > 0 ? `L/R ${fmtSeconds(skewS)}` : 'mono image'}</span>
    <span class="cap" class:warn={asleep.length > 0}>{asleep.length > 0 ? `${asleep.length} asleep` : 'all live'}</span>
    <button
      type="button"
      class="win"
      data-testid="cofefve-echo-window"
      title="How much time the plot shows. Your screen only: this is not shared or saved."
      onclick={() => (windowIdx = (windowIdx + 1) % ECHO_WINDOWS.length)}
    >{fmtSeconds(windowS)}</button>
  </div>
</div>

<style>
  .echo {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  svg {
    width: 100%;
    height: 96px;
    display: block;
    background: var(--panel-plot-bg, rgba(0, 0, 0, 0.28));
    border-radius: 4px;
  }
  .base {
    stroke: var(--text-muted, #8fa8a0);
    stroke-width: 1;
    opacity: 0.5;
  }
  .stem {
    stroke: var(--cable-audio, #6fd3b8);
    stroke-width: 2.5;
    stroke-linecap: round;
  }
  .stem.dry {
    stroke: var(--text, #e2ecea);
    stroke-width: 3.5;
  }
  .stem.inv {
    stroke-dasharray: 3 2;
  }
  .stem.l {
    stroke: var(--cable-audio, #6fd3b8);
    stroke-width: 2;
  }
  .stem.r {
    stroke: var(--cable-cv, #d8a657);
    stroke-width: 2;
  }
  .ripple {
    fill: none;
    stroke: var(--cable-cv, #d8a657);
    stroke-width: 1.5;
  }
  .ripple.off {
    stroke: var(--text-muted, #8fa8a0);
    opacity: 0.25;
    stroke-dasharray: 2 3;
  }
  .axis {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    font-family: var(--font-mono, monospace);
    font-size: 0.5rem;
    color: var(--text-muted, #8fa8a0);
    padding: 0 6px;
  }
  .axis span {
    text-align: left;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono, monospace);
    font-size: 0.55rem;
    color: var(--text-muted, #8fa8a0);
  }
  .cap.warn {
    color: var(--warn, #d8a657);
  }
  .win {
    margin-left: auto;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 1px 5px;
    cursor: pointer;
  }
</style>
