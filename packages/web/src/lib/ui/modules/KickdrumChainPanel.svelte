<script lang="ts">
  // KickdrumChainPanel — the design mock's RIGHT SIDEBAR, in one shell cell.
  //
  // Four blocks, in the mock's order:
  //   1. the module's own title + hint  ("LAYERED KICK · SUB + BODY + CLICK")
  //   2. the SIGNAL FLOW diagram        (SUB/BODY/CLICK → DRIVE·HARD → …)
  //   3. the generator / bus-stage LEGEND + the STEREO CROSSOVER visual
  //   4. the five PRESETS, which SELECT
  //
  // ⚠ IT IS A PANEL, NOT A RAIL — YET. The mock docks this column to the right
  // of the control bands; the shell has no sidebar slot today, so it renders as
  // a wide `panel` cell at the head of the faceplate (the generic PF-14 seam,
  // the same one dx7's operator map uses). Nothing in this component knows
  // where it is mounted: when the faceplate platform's sidebar slot lands, the
  // whole file moves into it unchanged and only the def's face declaration
  // changes. That is deliberate — special-casing the shell for one module is
  // what produced the face the owner rejected.
  //
  // ⚠ NO `control-<paramId>` TESTIDS (shell-cells rule 1). The preset rows
  // write params through the normal commit path but they are not a param
  // themselves; their own testid namespace is `kickdrum-preset-*`, and the
  // active id on `node.data.kickPreset` is the parity sweep's probe.
  //
  // Every string in blocks 2 and 3 comes from `kickdrum-face-model`, where it
  // is tied to the DSP (the flow order is the worklet's chain; the 120 Hz
  // crossover is grepped out of the worklet source by the model's test). None
  // of it is re-typed here.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { kickdrumDef } from '$lib/audio/modules/kickdrum';
  import {
    KICKDRUM_FLOW,
    KICKDRUM_LEGEND,
    KICKDRUM_PRESETS,
    kickdrumCrossover,
  } from './kickdrum-face-model';
  import { kickdrumPresetId, selectKickdrumPreset } from './kickdrum-preset-actions';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  /**
   * ⚠ THE VERSION IS CARRIED IN THE RESULT, and it must be.
   *
   * `patch.nodes[id]` is a STABLE SyncedStore proxy, so a `$derived.by` that
   * reads `nodeVersion(id)` and then returns the proxy BARE is `===` to its own
   * previous value — Svelte suppresses the invalidation and every downstream
   * `$derived` keeps its stale answer. Caught here by the e2e: recalling a
   * preset stamped all twenty-four params (the TUNE readout moved to 62 Hz) and
   * the preset row never lit up, because `activePreset` had not re-run.
   *
   * ModuleShell hit exactly this with the DX7 preset chip and solved it the
   * same way (`liveCell`): make the TICK the identity, so `.n` re-projects on
   * every bump.
   */
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] }));

  let activePreset = $derived(kickdrumPresetId(live.n));

  /** WIDTH drives the crossover picture — the def owns the default. */
  let crossover = $derived.by(() => {
    const v = live.n?.params?.width;
    const width =
      typeof v === 'number' ? v : kickdrumDef.params.find((p) => p.id === 'width')!.defaultValue;
    return kickdrumCrossover(width);
  });
</script>

<div class="chain" data-testid="kickdrum-chain">
  <!-- 1 · EYEBROW + HINT. The dock header prints the node's NAME and the band
       header prints the module's TITLE (`layered kick · sub + body + click`);
       this adds the descriptive HINT, which is what a player opening an
       unfamiliar module needs and what neither of the other two says.
       ⚠ The hint is a LITERAL here, not read from the def: `face` has no hint
       field yet. It is one of the strings the faceplate platform's title/hint
       block should own — see the file header. -->
  <header>
    <p class="eyebrow">voice</p>
    <h3>signal chain</h3>
    <p class="hint">three decoupled generators through one serial bus</p>
  </header>

  <!-- 2 · SIGNAL FLOW. TRANSLATE draws as a BRANCH because it is one: it taps a
       copy of the RAW sub pre-drive and rejoins ahead of the EQ. Drawing it
       inline would teach that turning it up excites the driven, EQ'd signal —
       the opposite of why it survives a phone speaker. -->
  <section class="flow" aria-label="signal flow">
    <ol>
      {#each KICKDRUM_FLOW as stage (stage.id)}
        <li
          class="stage"
          class:generator={stage.kind === 'generator'}
          class:bus={stage.kind === 'bus'}
          class:out={stage.kind === 'out'}
          class:parallel={stage.parallel}
          data-testid={`kickdrum-flow-${stage.id}`}
          title={stage.note}
        >
          <span class="name">{stage.id}</span>
          {#if stage.parallel}<span class="branch" aria-label="parallel branch">∥</span>{/if}
        </li>
      {/each}
    </ol>
  </section>

  <!-- 3 + 4 · LEGEND / CROSSOVER beside the PRESET list.
       Side by side rather than stacked because the dock pane folds at ~425 px
       on a 720p display and the preset rows are the half that must be REACHED,
       not just seen: stacking put them below the fold, which is the difference
       between a roster that selects and a roster that decorates. -->
  <div class="foot">
    <div class="foot-col">
      <section class="legend" aria-label="stage legend">
        {#each KICKDRUM_LEGEND as l (l.kind)}
          <p class:generator={l.kind === 'generator'} class:bus={l.kind === 'bus'} title={l.note}>
            <span class="swatch" aria-hidden="true"></span>
            <span class="lab">{l.label}</span>
          </p>
        {/each}
      </section>

      <section
        class="xover"
        aria-label="stereo crossover"
        data-testid="kickdrum-crossover"
        title="the low end stays phase-coherent; only the click widens"
      >
        <p class="cap">stereo crossover</p>
        <div class="bar" style={`--spread:${crossover.spread}`}>
          <span class="mono">{crossover.monoLabel}</span>
          <span class="wide">{crossover.wideLabel}</span>
        </div>
      </section>
    </div>

    <!-- PRESETS. They SELECT: each row stamps its calibrated values through the
         ordinary param path (undoable, shared over collab, editable straight
         afterwards) and records itself on `node.data.kickPreset` so the row that
         was last recalled stays lit. That record is a history of the last
         RECALL, not a claim that the patch is still pristine — which is what a
         hardware preset button does and what a producer expects. -->
    <section class="presets" aria-label="presets">
      <p class="cap">presets</p>
      <ul>
        {#each KICKDRUM_PRESETS as p (p.id)}
          <li>
            <button
              type="button"
              class:active={activePreset === p.id}
              aria-pressed={activePreset === p.id}
              data-testid={`kickdrum-preset-${p.id}`}
              title={`${p.label} · ${p.note}`}
              onclick={() => selectKickdrumPreset(nodeId, p.id)}
            >
              <span class="p-name">{p.label}</span>
              <span class="p-note">{p.note}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  </div>
</div>

<style>
  /* A COLUMN, capped: it is the mock's right sidebar, and a sidebar that grows
     to half the faceplate is not one. The cap also leaves the hero graph the
     room it needs — the two panels share one flex row today, and the graph is
     the cell that gets unreadable when it is squeezed. */
  .chain {
    display: grid;
    gap: 8px;
    width: 100%;
    max-width: 430px;
    padding: 6px 8px;
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 4px;
    background: rgb(255 255 255 / 0.02);
  }

  header {
    display: grid;
    gap: 1px;
  }
  .eyebrow {
    margin: 0;
    font-size: 8px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.38);
  }
  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.9);
  }
  .hint {
    margin: 0;
    font-size: 9px;
    line-height: 1.35;
    color: rgb(255 255 255 / 0.5);
  }

  /* FLOW — a wrapping chain of chips with a `›` between them, so the diagram
     survives any pane width instead of clipping the tail of the chain (which
     is where OUT L·R lives, i.e. the answer to "where does this end up"). */
  .flow ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 3px 4px;
    align-items: center;
  }
  .stage {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 5px;
    font-size: 8px;
    letter-spacing: 0.07em;
    border-radius: 2px;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .stage + .stage::before {
    content: '›';
    position: absolute;
    left: -4px;
    color: rgb(255 255 255 / 0.28);
  }
  .stage.generator {
    color: var(--domain, #4dd6c1);
    border-color: color-mix(in srgb, var(--domain, #4dd6c1) 45%, transparent);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 12%, transparent);
  }
  .stage.bus {
    color: rgb(255 255 255 / 0.72);
    border-color: rgb(255 255 255 / 0.16);
    background: rgb(255 255 255 / 0.04);
  }
  .stage.out {
    color: #f0a44a;
    border-color: rgb(240 164 74 / 0.45);
    background: rgb(240 164 74 / 0.1);
  }
  /* The one PARALLEL stage: dashed, and it carries a branch mark. */
  .stage.parallel {
    border-style: dashed;
  }
  .branch {
    color: rgb(255 255 255 / 0.45);
  }

  /* One ROW, not two: the legend is two words and a gloss, and the dock pane
     folds at ~425px on a 720p display — every row it does not spend is a row
     the PRESET list gets, and a preset you have to scroll to is decoration. */
  .legend {
    display: flex;
    flex-wrap: wrap;
    column-gap: 10px;
    row-gap: 1px;
  }
  .legend p {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: 8px;
    color: rgb(255 255 255 / 0.45);
  }
  .swatch {
    width: 7px;
    height: 7px;
    border-radius: 1px;
    flex: 0 0 auto;
    align-self: center;
  }
  .legend .generator .swatch {
    background: var(--domain, #4dd6c1);
  }
  .legend .bus .swatch {
    background: rgb(255 255 255 / 0.3);
  }
  .legend .lab {
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: rgb(255 255 255 / 0.7);
  }

  .foot {
    display: grid;
    grid-template-columns: 1fr minmax(120px, 0.85fr);
    gap: 8px;
    align-items: start;
  }
  .foot-col {
    display: grid;
    gap: 6px;
    align-content: start;
    min-width: 0;
  }

  .cap {
    margin: 0 0 2px;
    font-size: 8px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgb(255 255 255 / 0.38);
  }

  /* CROSSOVER — one bar split at the worklet's own 120 Hz. The MONO side is
     solid because it is exactly that; the WIDE side's opacity tracks WIDTH, so
     a producer at width 0 sees a bar that is visibly not widening anything. */
  .xover .bar {
    display: grid;
    grid-template-columns: 1fr 2fr;
    height: 14px;
    border-radius: 2px;
    overflow: hidden;
    border: 1px solid rgb(255 255 255 / 0.1);
  }
  .xover .mono,
  .xover .wide {
    display: grid;
    place-items: center;
    font-size: 7px;
    letter-spacing: 0.07em;
    white-space: nowrap;
  }
  .xover .mono {
    background: color-mix(in srgb, var(--domain, #4dd6c1) 34%, transparent);
    color: rgb(255 255 255 / 0.85);
  }
  .xover .wide {
    background: color-mix(
      in srgb,
      #f0a44a calc(12% + var(--spread, 0) * 40%),
      transparent
    );
    color: rgb(255 255 255 / 0.8);
  }

  .presets ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 2px;
  }
  .presets button {
    appearance: none;
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6px;
    padding: 3px 6px;
    font: inherit;
    font-size: 9px;
    letter-spacing: 0.06em;
    color: rgb(255 255 255 / 0.72);
    background: rgb(255 255 255 / 0.03);
    border: 1px solid rgb(255 255 255 / 0.08);
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
  }
  .presets button:hover {
    background: rgb(255 255 255 / 0.09);
    color: rgb(255 255 255 / 0.95);
  }
  .presets button.active {
    border-color: color-mix(in srgb, var(--domain, #4dd6c1) 65%, transparent);
    background: color-mix(in srgb, var(--domain, #4dd6c1) 16%, transparent);
    color: #fff;
  }
  .p-name {
    font-weight: 700;
  }
  .p-note {
    color: rgb(255 255 255 / 0.45);
    font-variant-numeric: tabular-nums;
  }
</style>
