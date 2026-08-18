<script lang="ts">
  // The DROP-PATCH modal. SHIPPED since #1781 — `Canvas.svelte` opens it when
  // one card is dropped onto another; `/dev/video-patch-drop` still mounts the
  // same component as static scenes for review. (This header used to read
  // "MOCK — nothing in the app opens this", which stopped being true at #1781.)
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
    isRackFlipKey,
    isTypingTarget,
    flipKeyOwner,
    setFlipKeyOccupancy,
  } from '$lib/graph/workflow-pins';
  import {
    buildDropPlan,
    invertDirection,
    findRepair,
    DROP_REFUSAL_TEXT,
    dropEdgeKey,
    type DropDefLike,
    type DropDirection,
    type DropEdge,
    type DropSideInput,
  } from './drop-plan';

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
    /**
     * Static scenes for capture set this false so no global carry is claimed.
     * `live` also gates the KEYBOARD and COMMIT: a live modal is the one the
     * user is actually in, and there is only ever one.
     */
    live?: boolean;
    /** Render the TAB hint as pressed — the scene that shows the flip mid-gesture. */
    tabPressed?: boolean;
    /**
     * #1838: the backpanel's STARTING state. False everywhere the user is —
     * the owner asked for collapsed-by-default. The reference page's scenes
     * exist to SHOW the backpanel ("one carry, eight panels"), so they pass
     * true and keep demonstrating what their prose claims.
     */
    rearOpen?: boolean;
    /** Commit the staged set. ONE call per modal session — see the note on
     *  `stage` below for why the session, not the click, is the unit. */
    onCommit?: (edges: DropEdge[]) => void;
    /** Dismiss. `keepPosition` distinguishes "I meant to patch, never mind"
     *  from "I actually meant to move the card there". */
    onCancel?: (opts: { keepPosition: boolean }) => void;
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
    rearOpen = false,
    onCommit,
    onCancel,
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
    dropEdgeKey({ fromNode, fromPort: outId, intoNode, intoPort: inId });

  let committedSet = $derived(new Set(committed));

  // ── THE COLLAPSE ─────────────────────────────────────────────────────────
  // Compatible rows shown; refused rows behind a summary that CARRIES ITS
  // COUNT. A bare chevron would be indistinguishable from "nothing here",
  // which is the exact failure the dimmed-not-hidden recommendation exists to
  // prevent — so the count is not decoration, it is the whole affordance.
  let offeredRows = $derived(plan.rows.filter((r) => r.state === 'offered'));
  let refusedRows = $derived(plan.rows.filter((r) => r.state === 'refused'));
  let deadOuts = $derived(plan.carriable.filter((c) => !c.reaches));
  let liveOuts = $derived(plan.carriable.filter((c) => c.reaches));

  // ⚠ AUTO-EXPAND WHEN THERE IS NOTHING ELSE TO SHOW. Collapsing the only
  // content leaves a blank panel, which reads as "this module has no inputs" —
  // the failure mode again, arrived at from the other direction. So the
  // disclosure defaults closed EXCEPT when closing it would empty the panel.
  // Nullable override, not `$state` seeded from a value, so a scene that
  // re-renders with a different plan still flows through.
  let refusedOpenOverride = $state<boolean | null>(null);
  let refusedOpen = $derived(refusedOpenOverride ?? offeredRows.length === 0);
  let deadOutsOpenOverride = $state<boolean | null>(null);
  let deadOutsOpen = $derived(deadOutsOpenOverride ?? liveOuts.length === 0);

  // ── THE BACKPANEL COLLAPSE (#1838) ───────────────────────────────────────
  // owner, 2026-08-18: "i would also like this content collapsed by default,
  // with a chevron to expand it? hiding the unpatchable connections by
  // default. this was part of the original spec"
  //
  // The backpanel shows EVERY declared port, and for any given carry most of
  // them are dimmed and unpatchable — reference material, not an answer. The
  // upper half is the answer ("what can I actually do with this drop"), so
  // that stays open and this closes.
  //
  // ⚠ SAME IDIOM as the refusal disclosure, deliberately, because the owner's
  // "part of the original spec" IS `▸ 29 not compatible`: chevron + COUNT +
  // what is behind it. A bare chevron is indistinguishable from "nothing
  // here" — the reader would lose the fact that a backpanel exists at all,
  // which is strictly worse than the clutter it replaced.
  //
  // ⚠ NO AUTO-EXPAND, unlike `refusedOpen` / `deadOutsOpen`. That rule exists
  // because collapsing the ONLY content leaves a blank panel; it does not
  // apply here, because the offered rows, the refusal disclosure and the
  // census always render above this and closing it can never empty the modal.
  // The owner asked for collapsed-by-default and there is no case that
  // contradicts it, so this is a plain default rather than a nullable
  // override.
  //
  // ⚠ STATE LIVES HERE, per modal open — the same nullable-override shape as
  // `dirOverride` / `refusedOpenOverride`: the PROP is the scene's answer, the
  // override is the USER's. It dies with the component, and the component
  // unmounts with the modal, so every drop starts collapsed for free.
  // Transient view state never goes near the Y.Doc or node data (standing
  // rule); there is nothing to persist.
  let rearOpenOverride = $state<boolean | null>(null);
  let rearShown = $derived(rearOpenOverride ?? rearOpen);

  /** Every declared port on the receiving side — DERIVED off the same census
   *  the rows came from. `declaredInputs + declaredOutputs` is the backpanel's
   *  own population, so the header cannot disagree with what expanding shows. */
  let rearPortCount = $derived(plan.census.declaredInputs + plan.census.declaredOutputs);

  // ── STAGING ──────────────────────────────────────────────────────────────
  // Clicking a row STAGES an edge; Enter commits every staged edge at once.
  // The unit of undo is the modal SESSION, not the click — a half-applied
  // patch set is the failure mode, and the same atomic-apply requirement the
  // randomizer has. Staging is what makes that possible without needing an
  // undo-transaction grouping trick.
  let staged = $state<DropEdge[]>([]);
  let stagedKeys = $derived(new Set(staged.map(dropEdgeKey)));

  function toggleStage(intoPort: string) {
    if (!live || !plan.carried) return;
    const e: DropEdge = {
      fromNode: plan.from.nodeId,
      fromPort: plan.carried.portId,
      intoNode: plan.into.nodeId,
      intoPort,
    };
    const k = dropEdgeKey(e);
    if (committedSet.has(k)) return; // already patched — not re-stageable
    staged = stagedKeys.has(k) ? staged.filter((s) => dropEdgeKey(s) !== k) : [...staged, e];
  }

  function commit() {
    if (!live || staged.length === 0) return;
    onCommit?.(staged);
    staged = [];
  }

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

  // ── TAB: THE THIRD OWNER, AND WHY IT NEEDS NO EDIT ELSEWHERE ─────────────
  // The previous round found the hazard and could only write it down: each
  // flip-key owner's guard hard-coded the others, so a third claimant meant
  // editing every existing guard with nothing failing if you forgot — and the
  // symptom is the phase-divergence bug 7e21befe2 already fixed once by hand.
  //
  // That is now structural rather than a comment. Precedence lives in ONE
  // ordered list (`FLIP_KEY_CLAIMANTS`, workflow-pins.ts); this surface
  // REGISTERS its occupancy and asks only about itself. The two shipped guards
  // in Canvas.svelte were rewritten the same way and no longer name anybody.
  //
  // Three defects from the mock are also fixed here: it re-typed `'Tab'`
  // instead of importing the shared predicate (they could drift onto different
  // keys), it had no `isTypingTarget` guard (Tab inside a field would be
  // eaten), and it never registered at all.
  $effect(() => {
    if (!live) return;
    return setFlipKeyOccupancy('drop-modal', () => true);
  });

  function onKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target)) return;
    if (isRackFlipKey(e)) {
      // Ask only about ourselves. Modifiers are already rejected by
      // isRackFlipKey, so Shift-Tab stays native traversal per ruling #1629.
      if (flipKeyOwner() !== 'drop-modal') return;
      e.preventDefault();
      flip();
      return;
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel?.({ keepPosition: false });
    }
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
          {plan.from.label} declares no outputs — nothing to carry in this direction
        </p>
      {:else}
        <ul class="dm-outs">
          {#each liveOuts as c (c.portId)}
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

        <!-- Outputs that reach NOTHING on the receiving side. Not illegal —
             just useless for this drop, which is a different sentence and so
             gets its own group rather than being merged with "refused". -->
        {#if deadOuts.length > 0}
          <div class="dm-more" data-testid="drop-source-more" data-open={deadOutsOpen}>
            <button
              type="button"
              class="dm-more-sum"
              data-testid="drop-source-more-toggle"
              data-count={deadOuts.length}
              aria-expanded={deadOutsOpen}
              onclick={() => (deadOutsOpenOverride = !deadOutsOpen)}
            >
              <span class="dm-chev" aria-hidden="true">{deadOutsOpen ? '▾' : '▸'}</span>
              <span class="dm-more-n">{deadOuts.length}</span>
              reach nothing on {plan.into.label}
            </button>
            {#if deadOutsOpen}
              <ul class="dm-outs dm-outs-dead">
                {#each deadOuts as c (c.portId)}
                  <li>
                    <button
                      type="button"
                      class="dm-out is-dead"
                      class:is-carried={plan.carried?.portId === c.portId}
                      data-testid="drop-out"
                      data-port-id={c.portId}
                      data-cable={c.cable}
                      data-reaches="false"
                      onclick={() => (carriedOverride = c.portId)}
                    >
                      <span class="dm-dot" data-cable={c.cable}></span>
                      <span class="dm-out-label">{c.label}</span>
                      <span class="dm-cable">{c.cable}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}
    </section>

    <!-- ── TARGET: the REAL backpanel + the derived row list ───────────── -->
    <section class="dm-side dm-target" data-testid="drop-target">
      <h3 class="dm-side-title">
        <span class="dm-side-role">in</span>{plan.into.label}
      </h3>

      {#snippet rowItem(row: (typeof plan.rows)[number])}
        {@const key = plan.carried
          ? edgeKey(plan.from.nodeId, plan.carried.portId, plan.into.nodeId, row.portId)
          : ''}
        {@const isCommitted = committedSet.has(key)}
        {@const isStaged = stagedKeys.has(key)}
        {@const repair =
          row.state === 'refused' && plan.carried
            ? findRepair(plan.carried.cable, { id: row.portId, type: row.cable }, repairCandidates)
            : undefined}
        <li>
          <button
            type="button"
            class="dm-row"
            class:is-refused={row.state === 'refused'}
            class:is-committed={isCommitted}
            class:is-staged={isStaged}
            disabled={row.state === 'refused' || isCommitted || !live}
            data-testid="drop-row"
            data-port-id={row.portId}
            data-state={isCommitted ? 'committed' : isStaged ? 'staged' : row.state}
            data-cable={row.cable}
            data-reason={row.reason ?? ''}
            onclick={() => toggleStage(row.portId)}
          >
            <span class="dm-dot" data-cable={row.cable} data-state={row.state}></span>
            <span class="dm-row-label">{row.label}</span>
            <span class="dm-cable">{row.cable}</span>
            {#if isCommitted}
              <span class="dm-badge dm-badge-ok" data-testid="drop-row-committed">patched</span>
            {:else if isStaged}
              <span class="dm-badge dm-badge-stage" data-testid="drop-row-staged">staged</span>
            {:else if row.state === 'offered'}
              <span class="dm-badge">{row.viaPortOptIn ? 'accepts' : 'patch'}</span>
            {:else}
              <span class="dm-badge dm-badge-no" data-testid="drop-row-refused">refused</span>
            {/if}
          </button>
          {#if row.state === 'refused' && row.reason}
            <p class="dm-why" data-testid="drop-row-why">
              {DROP_REFUSAL_TEXT[row.reason]}
              {#if repair}
                <span class="dm-repair" data-testid="drop-row-repair">
                  → insert <b>{repair.label}</b>
                  <span class="dm-repair-path">
                    {repair.inPortId} ▸ pick a tap:
                    {#each repair.outPortIds.slice(0, 4) as o, i (o)}<span class="dm-tap"
                        >{o.toUpperCase()}</span
                      >{#if i < Math.min(4, repair.outPortIds.length) - 1}{' '}{/if}{/each}{#if repair.outPortIds.length > 4}
                      <span class="dm-tap dm-tap-more">+{repair.outPortIds.length - 4}</span
                      >{/if}
                  </span>
                </span>
              {/if}
            </p>
          {/if}
        </li>
      {/snippet}

      {#if plan.rows.length === 0}
        <p class="dm-empty" data-testid="drop-target-empty">
          {plan.into.label} declares no inputs — this direction has nowhere to land.
          <br />
          <b>tab</b> to patch the other way round.
        </p>
      {:else}
        {#if offeredRows.length > 0}
          <ul class="dm-rows">
            {#each offeredRows as row (row.portId)}{@render rowItem(row)}{/each}
          </ul>
        {/if}

        <!-- ⚠ THE COLLAPSE. Summary carries its COUNT — never a bare chevron,
             which would be indistinguishable from "nothing here". Open by
             default only when closing it would leave the panel blank. -->
        {#if refusedRows.length > 0}
          <div class="dm-more" data-testid="drop-target-more" data-open={refusedOpen}>
            <button
              type="button"
              class="dm-more-sum"
              data-testid="drop-refused-toggle"
              data-count={refusedRows.length}
              aria-expanded={refusedOpen}
              onclick={() => (refusedOpenOverride = !refusedOpen)}
            >
              <span class="dm-chev" aria-hidden="true">{refusedOpen ? '▾' : '▸'}</span>
              <span class="dm-more-n">{refusedRows.length}</span>
              not compatible
            </button>
            {#if refusedOpen}
              <ul class="dm-rows dm-rows-refused">
                {#each refusedRows as row (row.portId)}{@render rowItem(row)}{/each}
              </ul>
            {/if}
          </div>
        {/if}

        <!-- The identity that makes the collapse honest, stated in the UI and
             derived from the same plan the rows came from. -->
        <p class="dm-census" data-testid="drop-census">
          {plan.census.offeredInputs} of {plan.census.declaredInputs} declared inputs take
          <b>{plan.carried?.cable ?? '—'}</b>
        </p>
      {/if}
    </section>
  </div>

  <!-- ── THE REAL BACKPANEL ──────────────────────────────────────────────
       Mounted with the receiving module's REAL def. Its holes dim themselves
       from the live carry — the mock passes no compat information at all.

       #1838: COLLAPSED BY DEFAULT behind the same counted disclosure the
       refusals use. The cap is the control, so the header still says WHAT is
       hidden and HOW MUCH of it — the count is the affordance, not decor. -->
  <div class="dm-panel" data-testid="drop-rear-panel" data-open={rearShown}>
    <div class="dm-panel-cap">
      <button
        type="button"
        class="dm-panel-toggle"
        data-testid="drop-rear-toggle"
        data-count={rearPortCount}
        aria-expanded={rearShown}
        onclick={() => (rearOpenOverride = !rearShown)}
      >
        <span class="dm-chev" aria-hidden="true">{rearShown ? '▾' : '▸'}</span>
        <span class="dm-more-n">{rearPortCount}</span>
        ports — {plan.into.label} rear
      </button>
      <span class="dm-panel-note">the shipped faceplate backpanel, every declared port</span>
    </div>
    {#if rearShown}
      <div class="dm-panel-scroll">
        <RearCard nodeId={plan.into.nodeId} def={plan.into.def as never} />
      </div>
    {/if}
  </div>

  <footer class="dm-foot">
    <span class="dm-hint"><kbd>tab</kbd> invert</span>
    <span class="dm-hint"><kbd>enter</kbd> commit</span>
    <span class="dm-hint"><kbd>esc</kbd> cancel</span>
    {#if live}
      <span class="dm-foot-right">
        <!-- ⚠ DECISION 3's escape hatch. The card SNAPS BACK on drop, so the
             default dismissal restores nothing — it already happened. This is
             the way out for a drop that really was a move: it is explicit,
             labelled, and never the default. -->
        <button
          type="button"
          class="dm-act"
          data-testid="drop-cancel-keep"
          onclick={() => onCancel?.({ keepPosition: true })}>leave it there</button
        >
        <button
          type="button"
          class="dm-act"
          data-testid="drop-cancel"
          onclick={() => onCancel?.({ keepPosition: false })}>cancel</button
        >
        <button
          type="button"
          class="dm-act dm-act-go"
          data-testid="drop-commit"
          data-staged={staged.length}
          disabled={staged.length === 0}
          onclick={commit}
        >
          patch {staged.length || ''}
        </button>
      </span>
    {/if}
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
  .dm-row:disabled {
    cursor: default;
  }
  .dm-row.is-staged {
    border-color: #d8a657;
    background: #262117;
  }

  /* ── THE COLLAPSE ─────────────────────────────────────────────────────
     A summary row that reads as a control, with its COUNT as the largest
     thing in it. The count is the affordance: "▸ 29 not compatible" and a
     bare "▸" are the same pixel budget and completely different sentences. */
  .dm-more {
    margin-top: 6px;
  }
  .dm-more-sum {
    display: flex;
    align-items: baseline;
    gap: 6px;
    width: 100%;
    padding: 4px 7px;
    border: 1px solid var(--dm-line);
    border-radius: 4px;
    background: #191c22;
    color: var(--dm-dim);
    font: inherit;
    font-size: 10.5px;
    text-align: left;
    cursor: pointer;
  }
  .dm-more-sum:hover {
    background: #1e222a;
    color: var(--dm-text);
  }
  .dm-chev {
    width: 9px;
    flex: none;
    color: var(--dm-dim);
  }
  .dm-more-n {
    color: var(--dm-text);
    font-size: 12px;
    font-weight: 600;
  }
  .dm-rows-refused,
  .dm-outs-dead {
    margin-top: 4px;
    padding-left: 9px;
    border-left: 1px dotted var(--dm-line);
  }
  .dm-out.is-dead {
    opacity: 0.5;
  }
  .dm-census {
    margin: 8px 0 0;
    padding-top: 7px;
    border-top: 1px dotted var(--dm-line);
    font-size: 10px;
    color: var(--dm-dim);
  }
  .dm-census b {
    color: var(--dm-text);
    font-weight: 500;
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
  /* #1838: the cap IS the disclosure control. Typography is inherited from
     .dm-panel-cap so the collapsed header reads as the same cap it replaced —
     only the chevron and the count are added. */
  .dm-panel-toggle {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-align: left;
    cursor: pointer;
  }
  .dm-panel-toggle:hover {
    color: var(--dm-text);
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
  .dm-foot-right {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .dm-act {
    padding: 2px 9px;
    border: 1px solid var(--dm-line);
    border-radius: 3px;
    background: #232833;
    color: var(--dm-dim);
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .dm-act:hover:not(:disabled) {
    color: var(--dm-text);
  }
  .dm-act-go:not(:disabled) {
    border-color: var(--dm-ok);
    color: var(--dm-ok);
  }
  .dm-act:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
