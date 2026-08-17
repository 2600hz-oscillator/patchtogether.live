<script lang="ts">
  // ⛔ MOCK — the proposed DROP-PATCH modal. Nothing in the app opens this.
  //
  // The chrome is new because the thing being designed is new. Everything
  // INSIDE it is the shipped machinery:
  //
  //   * the receiving side is the REAL <RearCard> — the faceplate drawer
  //     backpanel the owner named — mounted with the REAL def, so what you see
  //     is the same holes, bands, domain hues, output rail and compat-dim the
  //     dock full-view already renders. It is not redrawn.
  //   * the carried output drives the REAL `connectDragState.pickup(...)`, so
  //     RearCard's compatibility dim lights the legal holes by itself, through
  //     `rearHoleAcceptsCarry` → `canConnectToPort`. The mock does not colour a
  //     single hole; it hands the shipped component a carry and gets the
  //     shipped answer.
  //   * the row list beside it is `buildDropPlan`, which routes BOTH directions
  //     through `canConnectToPort` with the full port descriptor.
  //
  // So the two halves are an instrument and its negative control: if the panel
  // and the list ever disagreed about a hole, one of them is wrong, and you can
  // see it without reading any code.
  import { onDestroy } from 'svelte';
  import RearCard from '$lib/ui/workflow/RearCard.svelte';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import {
    buildDropPlan,
    invertDirection,
    findRepair,
    type DropDefLike,
    type DropDirection,
    type DropSideInput,
  } from './drop-plan';
  import { REFUSAL_TEXT } from './signal-lattice';

  interface Props {
    /** The faceplate the user dragged. */
    dropped: DropSideInput;
    /** The faceplate it landed on. */
    onto: DropSideInput;
    direction?: DropDirection;
    carriedPortId?: string;
    /** Defs `findRepair` may search when a row is refused. */
    repairCandidates?: readonly DropDefLike[];
    /** Rows already committed in this modal session — the feedback-loop case
     *  builds a patch across TWO Tab states, so committed edges have to survive
     *  the flip or the second half of the loop cannot be seen. */
    committed?: readonly string[];
    /** Static scenes for capture set this false so no global carry is claimed. */
    live?: boolean;
    /** Render the TAB hint as pressed — the scene that shows the flip mid-gesture. */
    tabPressed?: boolean;
  }

  let {
    dropped,
    onto,
    direction = 'downstream',
    carriedPortId,
    repairCandidates = [],
    committed = [],
    live = false,
    tabPressed = false,
  }: Props = $props();

  // The prop is the SCENE's answer; the override is the USER's. Kept as a
  // nullable override rather than a `$state` seeded from the prop so there is
  // no initial-value capture — a scene that re-renders with a new direction
  // still flows through, and a Tab press still wins until the scene changes.
  let dirOverride = $state<DropDirection | null>(null);
  let carriedOverride = $state<string | null>(null);
  let dir = $derived(dirOverride ?? direction);
  let carried = $derived(carriedOverride ?? carriedPortId);

  let plan = $derived(buildDropPlan(dropped, onto, dir, { carriedPortId: carried }));

  /** Edge key for the committed set — direction-free, so a 1→2 edge committed
   *  in the default view is still recognised after the flip. */
  const edgeKey = (fromNode: string, outId: string, intoNode: string, inId: string) =>
    `${fromNode}.${outId}→${intoNode}.${inId}`;

  let committedSet = $derived(new Set(committed));

  // ── THE CARRY ────────────────────────────────────────────────────────────
  // Drive the SHIPPED singleton so RearCard's compat-dim is doing the real
  // work. Guarded by `live` so a page rendering several scenes at once does not
  // have several of them fighting over one global.
  $effect(() => {
    if (!live) return;
    const c = plan.carried;
    if (!c) {
      connectDragState.cancelPickup();
      return;
    }
    connectDragState.pickup({
      nodeId: plan.from.nodeId,
      portId: c.portId,
      handleType: 'source',
      cableType: c.cable,
    });
  });
  onDestroy(() => {
    if (live) connectDragState.cancelPickup();
  });

  function flip() {
    dirOverride = invertDirection(dir);
    carriedOverride = null;
  }

  // ⚠ TAB. This is the third occupancy-guarded owner of the flip key — see the
  // route's notes. The guard is the SAME shape the two shipped owners use
  // (act only while this surface is occupied), and the same `isRackFlipKey`
  // predicate would be imported in a real implementation so the three cannot
  // drift onto different keys. Modifiers are rejected, so Shift-Tab stays
  // native traversal exactly as owner ruling #1629 requires.
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    flip();
  }
</script>

<svelte:window on:keydown={live ? onKey : undefined} />

<div class="drop-modal" data-testid="drop-patch-modal" data-direction={dir}>
  <header class="dm-head">
    <span class="dm-kicker">drop patch</span>
    <div class="dm-flow" data-testid="drop-flow">
      <span class="dm-mod dm-mod-from">{plan.from.label}</span>
      <span class="dm-arrow" aria-hidden="true">▶</span>
      <span class="dm-mod dm-mod-into">{plan.into.label}</span>
    </div>
    <span
      class="dm-tab"
      class:is-pressed={tabPressed}
      data-testid="drop-tab-hint"
      data-direction={dir}
    >
      <kbd>tab</kbd> invert — put <b>{plan.into.label}</b>
      {dir === 'downstream' ? 'upstream' : 'downstream'}
    </span>
  </header>

  <div class="dm-body">
    <!-- ── SOURCE: the carried out ─────────────────────────────────────── -->
    <section class="dm-side dm-source" data-testid="drop-source">
      <h3 class="dm-side-title">
        <span class="dm-side-role">out</span>{plan.from.label}
      </h3>
      {#if plan.carriable.length === 0}
        <p class="dm-empty" data-testid="drop-source-empty">
          no video outputs — nothing to carry in this direction
        </p>
      {:else}
        <ul class="dm-outs">
          {#each plan.carriable as c (c.portId)}
            <li>
              <button
                type="button"
                class="dm-out"
                class:is-carried={plan.carried?.portId === c.portId}
                data-testid="drop-out"
                data-port-id={c.portId}
                data-cable={c.cable}
                data-carried={plan.carried?.portId === c.portId ? 'true' : 'false'}
                onclick={() => (carriedOverride = c.portId)}
              >
                <span class="dm-dot" data-cable={c.cable}></span>
                <span class="dm-out-label">{c.label}</span>
                <span class="dm-cable">{c.cable}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if plan.subset.hiddenOutputs > 0}
          <p class="dm-subset" data-testid="drop-source-subset">
            + {plan.subset.hiddenOutputs} non-video output{plan.subset.hiddenOutputs === 1
              ? ''
              : 's'} not shown
          </p>
        {/if}
      {/if}
    </section>

    <!-- ── TARGET: the REAL backpanel + the derived row list ───────────── -->
    <section class="dm-side dm-target" data-testid="drop-target">
      <h3 class="dm-side-title">
        <span class="dm-side-role">in</span>{plan.into.label}
      </h3>

      {#if plan.rows.length === 0}
        <p class="dm-empty" data-testid="drop-target-empty">
          {plan.into.label} declares no video inputs — this direction has nowhere to land.
          <br />
          <b>tab</b> to patch the other way round.
        </p>
      {:else}
        <ul class="dm-rows">
          {#each plan.rows as row (row.portId)}
            {@const key = plan.carried
              ? edgeKey(plan.from.nodeId, plan.carried.portId, plan.into.nodeId, row.portId)
              : ''}
            {@const isCommitted = committedSet.has(key)}
            {@const repair =
              row.state === 'refused' && plan.carried
                ? findRepair(plan.carried.cable, { id: row.portId, type: row.cable }, repairCandidates)
                : undefined}
            <li>
              <div
                class="dm-row"
                class:is-refused={row.state === 'refused'}
                class:is-committed={isCommitted}
                data-testid="drop-row"
                data-port-id={row.portId}
                data-state={isCommitted ? 'committed' : row.state}
                data-cable={row.cable}
                data-reason={row.reason ?? ''}
              >
                <span class="dm-dot" data-cable={row.cable} data-state={row.state}></span>
                <span class="dm-row-label">{row.label}</span>
                <span class="dm-cable">{row.cable}</span>
                {#if isCommitted}
                  <span class="dm-badge dm-badge-ok" data-testid="drop-row-committed">patched</span>
                {:else if row.state === 'offered'}
                  <span class="dm-badge">{row.viaPortOptIn ? 'accepts' : 'patch'}</span>
                {:else}
                  <span class="dm-badge dm-badge-no" data-testid="drop-row-refused">refused</span>
                {/if}
              </div>
              {#if row.state === 'refused' && row.reason}
                <p class="dm-why" data-testid="drop-row-why">
                  {REFUSAL_TEXT[row.reason]}
                  {#if repair}
                    <span class="dm-repair" data-testid="drop-row-repair">
                      → insert <b>{repair.label}</b>
                      <span class="dm-repair-path">
                        {repair.inPortId} ▸ pick a tap:
                        {#each repair.outPortIds.slice(0, 4) as o, i (o)}<span class="dm-tap"
                            >{o.toUpperCase()}</span
                          >{#if i < Math.min(4, repair.outPortIds.length) - 1}{' '}{/if}{/each}{#if repair.outPortIds.length > 4}
                          <span class="dm-tap dm-tap-more"
                            >+{repair.outPortIds.length - 4}</span
                          >{/if}
                      </span>
                    </span>
                  {/if}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if plan.subset.hiddenCvInputs + plan.subset.hiddenOtherInputs > 0}
        <p class="dm-subset" data-testid="drop-target-subset">
          showing {plan.subset.shownInputs} video input{plan.subset.shownInputs === 1 ? '' : 's'}
          of {plan.subset.shownInputs + plan.subset.hiddenCvInputs + plan.subset.hiddenOtherInputs}
          — {plan.subset.hiddenCvInputs} cv
          {#if plan.subset.hiddenOtherInputs > 0}
            + {plan.subset.hiddenOtherInputs} other
          {/if}
          hidden by the video filter
          <button type="button" class="dm-showall" data-testid="drop-show-all" disabled
            >show all</button
          >
        </p>
      {/if}
    </section>
  </div>

  <!-- ── THE REAL BACKPANEL ──────────────────────────────────────────────
       Mounted with the receiving module's REAL def. Its holes dim themselves
       from the live carry — the mock passes no compat information at all. -->
  <div class="dm-panel" data-testid="drop-rear-panel">
    <div class="dm-panel-cap">
      <span>{plan.into.label} — rear</span>
      <span class="dm-panel-note">the shipped faceplate backpanel, every declared port</span>
    </div>
    <div class="dm-panel-scroll">
      <RearCard nodeId={plan.into.nodeId} def={plan.into.def as never} />
    </div>
  </div>

  <footer class="dm-foot">
    <span class="dm-hint"><kbd>tab</kbd> invert</span>
    <span class="dm-hint"><kbd>enter</kbd> commit</span>
    <span class="dm-hint"><kbd>esc</kbd> cancel</span>
  </footer>
</div>

<style>
  .drop-modal {
    --dm-bg: #14161b;
    --dm-panel: #1b1e25;
    --dm-line: #2b3039;
    --dm-text: #e6e9ef;
    --dm-dim: #8b93a3;
    --dm-ok: #6fd08c;
    --dm-no: #e0645f;
    display: flex;
    flex-direction: column;
    gap: 0;
    width: 100%;
    background: var(--dm-bg);
    border: 1px solid var(--dm-line);
    border-radius: 8px;
    color: var(--dm-text);
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
  }

  .dm-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--dm-line);
    background: #191c22;
  }
  .dm-kicker {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dm-dim);
  }
  .dm-flow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .dm-mod {
    padding: 2px 8px;
    border-radius: 4px;
    background: #232833;
    border: 1px solid var(--dm-line);
  }
  .dm-mod-from {
    border-color: #3f6f8f;
  }
  .dm-mod-into {
    border-color: #7a5a9a;
  }
  .dm-arrow {
    color: var(--dm-dim);
  }
  .dm-tab {
    margin-left: auto;
    color: var(--dm-dim);
    font-size: 11px;
  }
  .dm-tab b {
    color: var(--dm-text);
    font-weight: 500;
  }
  .dm-tab.is-pressed kbd {
    background: var(--dm-text);
    color: var(--dm-bg);
  }
  kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid var(--dm-line);
    border-bottom-width: 2px;
    border-radius: 3px;
    background: #232833;
    font: inherit;
    font-size: 10px;
    color: var(--dm-text);
  }

  .dm-body {
    display: grid;
    grid-template-columns: minmax(150px, 210px) 1fr;
    gap: 0;
  }
  .dm-side {
    padding: 10px 12px;
    min-width: 0;
  }
  .dm-source {
    border-right: 1px solid var(--dm-line);
    background: #171a20;
  }
  .dm-side-title {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .dm-side-role {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dm-dim);
    border: 1px solid var(--dm-line);
    border-radius: 3px;
    padding: 0 4px;
  }

  .dm-outs,
  .dm-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .dm-out {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 4px 7px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: #1e222a;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .dm-out.is-carried {
    border-color: #5b8fb9;
    background: #1f2a34;
  }

  .dm-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 7px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: #1e222a;
  }
  /* ⚠ THE REFUSAL. Present, legible, greyed — never removed. See the route's
     recommendation panel for why hiding was rejected. */
  .dm-row.is-refused {
    opacity: 0.45;
    background: #1a1c21;
  }
  .dm-row.is-committed {
    border-color: var(--dm-ok);
    background: #1b2620;
  }

  .dm-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--dm-dim);
  }
  .dm-dot[data-cable='video'] {
    background: #c77dff;
  }
  .dm-dot[data-cable='mono-video'] {
    background: #9ad6e8;
  }
  .dm-dot[data-cable='image'] {
    background: #ffb570;
  }
  .dm-dot[data-cable='keys'] {
    background: #ff9dd4;
  }

  .dm-out-label,
  .dm-row-label {
    font-size: 11px;
    letter-spacing: 0.03em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dm-cable {
    margin-left: auto;
    font-size: 9.5px;
    color: var(--dm-dim);
  }
  .dm-badge {
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--dm-line);
    color: var(--dm-dim);
    flex: none;
  }
  .dm-badge-ok {
    border-color: var(--dm-ok);
    color: var(--dm-ok);
  }
  .dm-badge-no {
    border-color: var(--dm-no);
    color: var(--dm-no);
  }

  .dm-why {
    margin: 2px 0 6px 22px;
    font-size: 10px;
    line-height: 1.4;
    color: var(--dm-no);
    opacity: 0.85;
  }
  .dm-repair {
    display: block;
    margin-top: 2px;
    color: var(--dm-dim);
  }
  .dm-repair b {
    color: var(--dm-text);
    font-weight: 500;
  }
  .dm-repair-path {
    color: #5f6675;
  }
  .dm-tap {
    display: inline-block;
    margin-right: 3px;
    padding: 0 4px;
    border: 1px solid var(--dm-line);
    border-radius: 3px;
    background: #232833;
    color: var(--dm-text);
    font-size: 9px;
    letter-spacing: 0.06em;
  }
  .dm-tap-more {
    margin-left: 2px;
    color: var(--dm-dim);
  }

  .dm-empty {
    margin: 0;
    padding: 10px;
    border: 1px dashed var(--dm-line);
    border-radius: 4px;
    color: var(--dm-dim);
    font-size: 11px;
    line-height: 1.5;
  }
  .dm-empty b {
    color: var(--dm-text);
  }

  .dm-subset {
    margin: 8px 0 0;
    padding-top: 7px;
    border-top: 1px dotted var(--dm-line);
    font-size: 10px;
    color: var(--dm-dim);
  }
  .dm-showall {
    margin-left: 6px;
    padding: 1px 6px;
    border: 1px solid var(--dm-line);
    border-radius: 3px;
    background: #232833;
    color: var(--dm-dim);
    font: inherit;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .dm-panel {
    border-top: 1px solid var(--dm-line);
    background: var(--dm-panel);
  }
  .dm-panel-cap {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 5px 12px;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dm-dim);
    border-bottom: 1px solid var(--dm-line);
  }
  .dm-panel-note {
    text-transform: none;
    letter-spacing: 0;
    color: #5f6675;
  }
  .dm-panel-scroll {
    max-height: 260px;
    overflow: auto;
    padding: 8px;
  }

  .dm-foot {
    display: flex;
    gap: 14px;
    padding: 6px 12px;
    border-top: 1px solid var(--dm-line);
    background: #191c22;
    font-size: 10px;
    color: var(--dm-dim);
  }
  .dm-hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
</style>
