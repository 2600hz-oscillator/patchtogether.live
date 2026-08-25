<script lang="ts">
  // ELECTRA GRID BODY — the 6×6 board, at the head of the dock full view AND of
  // the workflow DRAWER (`ShellExtension.fullViewBody`).
  //
  // This is `ElectraControlCard.svelte`'s `.ec-grid` block, lifted with its
  // enumeration, its live colour passthrough, its rename flow and EVERY
  // `data-testid` intact. The title bar does NOT come with it (the shell owns
  // that), and neither does the connect button — that is a ranked faceplate cell
  // now (`electra-control-connect-{n}` in shell-cells.ts), which is what puts the
  // flash on the lane tile instead of behind a dock open.
  //
  // ⚠ IT REACHES THE DRAWER, AND THAT IS THE FACT THE WHOLE PROMOTION RESTS ON.
  // `dockFullViewHeadPlan` gates `extBody` on `isFaceplateView(view)`, which is
  // `view !== 'lane'` — and the comment at the site is explicit about why: "the
  // pinned drawer paints the same full faceplate and wants the same head
  // precedence (#1739)". electraControl is the `E` of the M/E/C pin trio with
  // `surface: 'drawer'` and is canvas-hidden, so the drawer is the ONLY surface
  // its always-on instance has. A body that did not paint there would have
  // deleted the module for every workflow user.
  //
  // ⚠ PORTED, NOT REDESIGNED, and that is a design instruction rather than
  // laziness. Three renderers draw this one grid — this body, the legacy card
  // (still live under `?shell=legacy`) and the Push 2's ElectraControl mode
  // (`push-electra-model.ts`) — and every deviation is a place they can disagree
  // about what a slot is called or where it lands on the hardware. The shared
  // `electraSlotLabel` expression is imported for exactly that reason; the card's
  // own comment says "Never re-type it here".
  //
  // ⚠ EVERY `data-testid` IS KEPT DELIBERATELY — `electra-control-grid`,
  // `electra-control-bank-{TOP,MID,BOT}`, `electra-control-slot-{r}-{k}`,
  // `electra-control-stripe-{r}-{k}`, `electra-control-rename-{r}-{k}`,
  // `electra-control-rename-input-{r}-{k}`, and `data-slot` / `data-filled` on
  // every cell. `e2e/tests/electra-control.spec.ts` and
  // `quadralogical-assign.spec.ts` drive all of them against the CARD (both boot
  // `?shell=legacy`), and the new drawer-face spec drives the same ids against
  // this body. One vocabulary, two surfaces, no rename.
  //
  // ⚠ THE SLOT MAP IS MUTATED IN PLACE AND MUST STAY THAT WAY. `setSlotName` is
  // the ONLY writer this component calls, and `$lib/graph/electra-control` does
  // it inside one `ydoc.transact` without rebuilding the map — because "once
  // integrated, spreading it into a fresh object re-integrates already-integrated
  // Y types and Yjs throws 'Type already integrated'". That is a SHIPPED CRASH
  // that already happened once (it broke the second send-to-surface), and its
  // regression is a named unit leg: "a SECOND assign to a DIFFERENT slot does NOT
  // throw". Nothing here spreads `data.slots`.
  //
  // ⚠ THE PRUNE EFFECT MOVES WITH THE BOARD, AND THIS IS THE MOMENT IT COULD
  // SILENTLY STOP FIRING. When a bound source module disappears the slot stops
  // RENDERING (resolveSurfaceParam returns null) but the binding lingers in
  // `node.data`, so the next flash would emit a dead control. The card dropped
  // those on every ydoc tick from an `$effect`; the pure function is exhaustively
  // unit-tested but the fact that ANYTHING CALLS IT was not. It is now, in
  // `electracontrol-face-model.test.ts` — a source leg asserting this body still
  // carries the call, because a body with the effect deleted looks identical at
  // rest and only diverges on a rack somebody edited.
  //
  // ⚠ NO PICTURE IS DRAWN HERE AND NONE MAY BE ADDED. This body's declared role
  // is `control-grid` (`face-rack-status-source.test.ts`), whose predicate
  // requires that it set accessible names and mount no drawing surface — and the
  // predicate GREPS RAW SOURCE and cannot tell code from a comment, so this
  // sentence spells the tag out in words rather than writing it. The reason is
  // not merely the gate: WebGL attest basis membership is derived from CONTENT,
  // so a drawn body would enrol a meta module in the GPU attest and put every
  // future edit to this file on the real-hardware critical path.
  //
  // ⚠ THE SEMANTICS LIVE ON `aria-label`, per the resting-text ruling, and they
  // are built in `./electra-board-model` rather than inline. The visible text on
  // this surface is exhaustively: three BANK LABELS (TOP / MID / BOT) and each
  // filled knob's own CAPTION, painted by `Knob.svelte` from a `label` prop. No
  // value, no measurement, no state word. The firmware coordinate a player
  // actually needs — which control set, which pot — is the accessible name,
  // speakable and assertable and unpainted.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode, ParamDef } from '$lib/graph/types';
  import {
    readElectraData,
    slotIndex,
    bindingAtSlot,
    setSlotName,
    pruneElectraDangling,
    electraSlotLabel,
    ELECTRA_BANKS,
    ELECTRA_KNOBS,
  } from '$lib/graph/electra-control';
  import { resolveSurfaceParam } from '$lib/graph/control-surface-params';
  import { resolveControlColor } from '$lib/graph/control-color';
  import { emptySlotName, boardName } from './electra-board-model';

  let { nodeId }: { nodeId: string } = $props();
  const engineCtx = useEngine();

  // Bounded node-scoped re-derive — the card's `cardVersion` pump, verbatim:
  // own node + every slot-bound SOURCE module + node add/remove. It is what makes
  // a proxied knob track the real knob live, and a remote slot write appear
  // instantly.
  let cardVersion = $derived.by(() => {
    let v = nodeVersion(nodeId) + nodesStructuralVersion();
    const seen = new Set<string>();
    for (const b of Object.values(readElectraData(patch.nodes[nodeId]).slots ?? {})) {
      if (!b || seen.has(b.moduleId)) continue;
      seen.add(b.moduleId);
      v += nodeVersion(b.moduleId);
    }
    return v;
  });

  // AUTO-PRUNE dangling slots — see the header. Conservative, and a no-op when
  // nothing dangles.
  $effect(() => {
    void cardVersion;
    pruneElectraDangling(nodeId);
  });

  let electraData = $derived.by(() => {
    void cardVersion;
    return readElectraData(patch.nodes[nodeId]);
  });

  interface SlotView {
    row: number;
    knob: number;
    slot: number;
    moduleId: string | null;
    paramId: string | null;
    label: string;
    customName: string;
    def: ParamDef | null;
    color: string | null;
  }
  interface BankView {
    label: string;
    rows: SlotView[][];
  }

  // The FIXED 3-bank × 2-row × 6-knob view, ENUMERATED from (row, knob) and
  // never from the data — so the grid is always thirty-six cells and an EMPTY
  // SLOT IS A VISIBLE PLACE rather than an absence. That is what makes the board
  // a board: a player's hands find the same pot in the same position whether or
  // not anything is bound to it, exactly as on the hardware.
  let banks = $derived.by<BankView[]>(() => {
    void cardVersion;
    const d = electraData;
    return ELECTRA_BANKS.map((bank) => {
      const rows: SlotView[][] = bank.rows.map((row) => {
        const cells: SlotView[] = [];
        for (let knob = 1; knob <= ELECTRA_KNOBS; knob++) {
          const slot = slotIndex(row, knob);
          const b = bindingAtSlot(d, slot);
          let def: ParamDef | null = null;
          let label = '';
          let customName = '';
          let color: string | null = null;
          if (b) {
            const sourceNode = patch.nodes[b.moduleId] as ModuleNode | undefined;
            const resolved = sourceNode ? resolveSurfaceParam(sourceNode, b.paramId) : null;
            if (resolved) {
              def = resolved.def;
              customName = typeof b.name === 'string' ? b.name.trim() : '';
              // SHARED name rule — the SAME expression the Push 2's
              // ElectraControl mode renders, so the hardware strip and this knob
              // cannot disagree about what a slot is called. Never re-type it.
              label = electraSlotLabel(b, resolved.def.label ?? b.paramId);
              color = resolveControlColor(sourceNode);
            }
          }
          cells.push({
            row,
            knob,
            slot,
            moduleId: def ? b!.moduleId : null,
            paramId: def ? b!.paramId : null,
            label,
            customName,
            def,
            color,
          });
        }
        return cells;
      });
      return { label: bank.label, rows };
    });
  });

  // DERIVED, never typed — the accessible name's count is read off the live slot
  // map (see `boardName`).
  let assignedCount = $derived.by(() => {
    void cardVersion;
    return Object.values(electraData.slots ?? {}).filter((b) => !!b).length;
  });

  // ── live param read / write (the pointer mechanism) — routed through the
  // adapter so TOYBOX nested params read/write the right node.data location. ──
  function readParam(sourceId: string, paramId: string, def: ParamDef): number {
    void cardVersion;
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) return resolved.get();
    return (live?.params[paramId] ?? def.defaultValue ?? 0) as number;
  }
  function setParam(sourceId: string, paramId: string, value: number) {
    const live = patch.nodes[sourceId] as ModuleNode | undefined;
    const resolved = resolveSurfaceParam(live, paramId);
    if (resolved) { resolved.set(value); return; }
    setNodeParam(sourceId, paramId, value);
  }
  function liveReader(sourceId: string, paramId: string) {
    return () => {
      const live = patch.nodes[sourceId] as ModuleNode | undefined;
      if (!live) return undefined;
      const e = engineCtx.get();
      const fromEngine = e ? e.readParam(live, paramId) : undefined;
      if (typeof fromEngine === 'number') return fromEngine;
      return resolveSurfaceParam(live, paramId)?.get();
    };
  }

  // ── per-slot rename (the Electra custom label) ──
  //
  // ⚠ RAW MARKUP, NOT A CELL, AND THAT IS MECHANICAL. `ShellEntryCell` exists
  // now and would be the right answer for ONE typed field — but a face key
  // resolves to a param id, a `<familyId>-{n}` TEMPLATE, or a legend static, and
  // a family template renders exactly ONE cell however many members it names
  // (#1509). Thirty-six per-slot rename fields are not addressable as cells at
  // all, at any rank. Inside a body they are ordinary markup, which is what the
  // card always had.
  let editing: number | null = $state(null);
  let editValue = $state('');

  function startRename(e: Event, slot: number, current: string) {
    e.stopPropagation();
    editing = slot;
    editValue = current;
  }
  function commitRename() {
    if (editing === null) return;
    setSlotName(nodeId, editing, editValue);
    editing = null;
  }
  function cancelRename() { editing = null; }
  function onRenameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }
</script>

<div
  class="ec-grid nodrag"
  data-testid="electra-control-grid"
  role="group"
  aria-label={boardName(assignedCount)}
>
  {#each banks as bank (bank.label)}
    <div class="ec-bank" data-testid={`electra-control-bank-${bank.label}`}>
      <div class="ec-bank-label">{bank.label}</div>
      {#each bank.rows as cells, ri (ri)}
        <div class="ec-row">
          {#each cells as c (c.slot)}
            <!-- svelte-ignore a11y_no_static_element_interactions — pointer PLUMBING only: the handler stops the
                 surrounding drag so the control inside receives the gesture. No user action happens on this
                 div, so there is nothing to give a keyboard equivalent to. KEPT from the card rather than
                 dropped on reasoning: the drawer is not the XYFlow canvas, but the dock full view and the
                 lane both are, and a guard that is unnecessary on one surface is harmless on all three. -->
            <div
              class="ec-slot"
              class:filled={!!c.def}
              data-testid={`electra-control-slot-${c.row}-${c.knob}`}
              data-slot={c.slot}
              data-filled={c.def ? 'true' : 'false'}
              onpointerdown={(e) => e.stopPropagation()}
            >
              {#if c.def && c.moduleId && c.paramId}
                <!-- PASSTHROUGH colour stripe: the SOURCE module's live control
                     colour, so a glance identifies which source drives each
                     slot. Resolved per render, never a stored copy. -->
                <div
                  class="ec-slot-stripe"
                  data-testid={`electra-control-stripe-${c.row}-${c.knob}`}
                  style:background={`#${c.color}`}
                  aria-hidden="true"
                ></div>
                <Knob
                  value={readParam(c.moduleId, c.paramId, c.def)}
                  min={c.def.min}
                  max={c.def.max}
                  defaultValue={c.def.defaultValue}
                  label={c.label}
                  units={c.def.units}
                  curve={c.def.curve}
                  onchange={(v) => setParam(c.moduleId!, c.paramId!, v)}
                  readLive={liveReader(c.moduleId, c.paramId)}
                  moduleId={c.moduleId}
                  paramId={c.paramId}
                />
                {#if editing === c.slot}
                  <!-- svelte-ignore a11y_autofocus — autofocus is the POINT: this input only exists while a
                     rename is in progress, and it was opened by an explicit user action, so focusing it is
                     what the user just asked for rather than a surprise focus steal on page load. -->
                  <input
                    class="ec-rename nodrag"
                    data-testid={`electra-control-rename-input-${c.row}-${c.knob}`}
                    type="text"
                    bind:value={editValue}
                    maxlength="14"
                    aria-label={`Rename ${c.label}`}
                    autofocus
                    onpointerdown={(e) => e.stopPropagation()}
                    onkeydown={onRenameKey}
                    onblur={commitRename}
                  />
                {:else}
                  <button
                    type="button"
                    class="ec-rename-btn nodrag"
                    data-testid={`electra-control-rename-${c.row}-${c.knob}`}
                    title={`Rename “${c.label}” for the Electra`}
                    aria-label={`Rename ${c.label}`}
                    onpointerdown={(e) => e.stopPropagation()}
                    ondblclick={(e) => startRename(e, c.slot, c.customName)}
                    onclick={(e) => startRename(e, c.slot, c.customName)}
                  >
                    ✎
                  </button>
                {/if}
              {:else}
                <div class="ec-empty" role="img" aria-label={emptySlotName(c.row, c.knob)}>
                  <div class="ec-empty-dial"></div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  /* The board's own internal layout. Six columns is the HARDWARE's geometry, not
     a layout choice — the whole value of the surface is that a pot on screen is
     the pot under the player's hand — so the grid sizes to its content and the
     plate sizes to the grid. That is the ordinary content-sized faceplate the
     width ruling asks for, not an exemption from it: `face-width-source.test.ts`
     polices `_dock-faceplate.css`, the shared width chain, and a component's own
     internal layout is neither in its scope nor should be. */
  .ec-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid #2a2f3a;
    border-radius: 5px;
    background: #0e1015;
    padding: 6px;
    box-sizing: border-box;
    width: max-content;
    max-width: 100%;
  }
  /* Three 2-row banks with a visible separator between them — the Electra's
     three stacked 12-pot control sets. */
  .ec-bank {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    border: 1px dashed #3a4150;
    border-radius: 5px;
    background: rgba(20, 24, 32, 0.5);
  }
  .ec-bank-label {
    font-size: 0.58rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim, #97a3bd);
    pointer-events: none;
  }
  .ec-row {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
  }
  .ec-slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    min-width: 48px;
    min-height: 62px;
    touch-action: none;
  }
  .ec-slot-stripe {
    width: 80%;
    height: 4px;
    border-radius: 2px;
    margin-bottom: 2px;
  }
  /* Empty slot: a dim, inert dial-shaped placeholder so the fixed grid reads as
     a physical control surface (which knob drives what) even when empty. */
  .ec-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    opacity: 0.4;
  }
  .ec-empty-dial {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px dashed #404652;
    background: #14171c;
  }
  /* Defensive label clamp (matches Knob.svelte / the legacy card). */
  .ec-slot :global(.label) {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ec-rename-btn {
    margin-top: 2px;
    font-size: 0.6rem;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid #404652;
    background: rgba(96, 165, 250, 0.1);
    color: var(--text-dim, #aab);
    cursor: pointer;
  }
  .ec-rename-btn:hover { background: rgba(96, 165, 250, 0.22); }
  .ec-rename {
    margin-top: 2px;
    width: 100%;
    max-width: 46px;
    box-sizing: border-box;
    font-size: 0.6rem;
    padding: 1px 3px;
    border-radius: 3px;
    border: 1px solid #6f8bd0;
    background: #0e1015;
    color: var(--text, #e8eaed);
  }
</style>
