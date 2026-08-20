<script lang="ts">
  // DockFullView — the bottom-drawer EXPANDED FULL-VIEW (P0.3b re-spec).
  //
  // The owner-approved RACKLINE dock faceplate (fullcard-mocks kit §3/§4 +
  // ux-fullview.html Section B): ONE full-width module faceplate that OWNS the
  // bottom drawer — NOT one more card in DockRail's horizontal card flex. Domain
  // accent lip + glow, grip, title bar (badge + name + "<label> · lane N" sub) +
  // a window-control trio (undock / collapse-to-lane / close), a tab-rail seam
  // (single "MODULE" tab for legacy content — real per-op tabs are P1), and a
  // .page > .editor that mounts the CONTENT at NATIVE scale:
  //   * un-migrated → the module's VERBATIM legacy *Card.svelte via
  //     nodeTypes[node.type], with the SAME plain-mount contract DockCardHost
  //     uses (self-gating PatchPanel outside the flow provider) — carrying the
  //     data-dock-card / data-dock-card-frame anchors + node.id keying so
  //     PickupCable / cardRectOf + the patch menu keep working.
  //   * migrated → <ModuleShell view="dock-full"> (effTier 'dock').
  //
  // PLAIN-MOUNT SAFETY (verbatim from DockCardHost): the card is the SAME
  // component the canvas mounts, fed the same `{ id, data: { node } }`. PatchPanel
  // self-gates outside the provider (guarded useStore): no <Handle> stack mounts
  // here, so the node's ONLY handles + only `.svelte-flow__node[data-id]` element
  // live on its canvas tile — PickupCable + sweep contracts stay unambiguous. The
  // patch MENU still works from the drawer (port rows dispatch document-level
  // events Canvas owns). Rack sizing is replicated by a classed wrapper
  // (dock-rack-sized) that mirrors .svelte-flow__node.rack-sized WITHOUT the
  // .svelte-flow__node class. NO transform/ResizeObserver zoom — native scale.
  //
  // Close / collapse-to-lane both call dockStore.closeFullView(node.id) —
  // closing THIS pane only; a split survivor returns to full width (the
  // module's lane placeholder/shell stays in place — Option #1). The full-view
  // (up to TWO side-by-side panes, owner extension) is the ONE bottom-drawer
  // occupant while open (dock unification: pinned XOR full-view) — ESC closes
  // the whole view, M/E REPLACE it with the pinned drawer (Canvas's dock-key
  // handler → dockStore occupancy). Transient: never a persisted dock ENTRY.
  //
  // The built-in CLIP PLAYER (`pinned-clipplayer`) is one of these panes too
  // (owner 2026-07-26: `c` = expand): a real node with a real def, so it takes
  // the un-migrated branch below (verbatim ClipplayerCard) and the flip key (Tab) flips it to
  // its def-driven RearCard jack field like any other un-migrated occupant.

  import './_dock-faceplate.css';
  import type { Component } from 'svelte';
  import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { domainClassForDef, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
  import { dockFacePlan, type FaceDefLike } from '$lib/ui/workflow/curated-face';
  import { activeDockTab, dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
  import {
    faceHasAnnotations,
    type FaceplateDefLike,
  } from '$lib/ui/workflow/dock-faceplate-model';
  import { isAnnotating, toggleAnnotate } from '$lib/ui/annotate-mode.svelte';
  import ModuleShell from '$lib/ui/modules/ModuleShell.svelte';
  import RearCard from '$lib/ui/workflow/RearCard.svelte';
  import type { RearDefLike } from '$lib/ui/workflow/rear-card-model';

  interface Props {
    /** The full-view node (live snapshot entry — `data` is the live proxy). */
    node: ModuleNode;
    /** The shared glob-driven nodeTypes map (Canvas's). */
    nodeTypes: Record<string, unknown>;
    /** Rack sizing (Canvas's rackSizeByType entry), if the type declares one. */
    rackSize?: { size?: string; hp?: number };
    /** True ⇒ mount the migrated <ModuleShell>; else the verbatim legacy card. */
    migrated: boolean;
    /** Header display name. */
    title: string;
    /** Close the full-view (✕ / ESC). */
    onClose: () => void;
    /** Collapse to lane (keeps the lane tile; same as close in P0.3b). */
    onCollapse: () => void;
    /** Undock → promote to a persisted entry. Omitted in P0.3b (the full-view
     *  was never a persisted entry); shown disabled-free when it lands. */
    onUndock?: () => void;
    /** REAR CARD (RearCard.svelte + rear-card-model.ts): TRUE flips this pane to the flip-side
     *  patch field. Canvas feeds dockStore.fullViewFlipped — the view-global
     *  flip-key (Tab) flip seam — so with the 50/50 split BOTH panes flip together; the
     *  per-pane surface is this prop + the `data-flipped` attr. */
    flipped?: boolean;
  }
  let { node, nodeTypes, rackSize, migrated, title, onClose, onCollapse, onUndock, flipped = false }: Props = $props();

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }
  let def = $derived(
    defLookup(node.type) as
      | (ShellDefLike & { label?: string; inputs?: readonly PortDef[]; params?: readonly ParamDef[] })
      | undefined,
  );

  /** Kit domain class (.audio/.cv/.gate/.video/.poly) — paints the whole face. */
  let domain = $derived(domainClassForDef(def));

  /** Badge initials from the type id (curated def.badge reads better; P1). */
  let badge = $derived(node.type.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??');

  /** Mono sub: "<def label> · lane N" (mock "FM synthesizer · lane 3"). */
  let sub = $derived.by(() => {
    const label = def?.label ?? node.type;
    const d = node.data as { channel?: number; sendSlot?: number } | undefined;
    if (d?.channel != null) return `${label} · lane ${d.channel}`;
    if (d?.sendSlot != null) return `${label} · send ${d.sendSlot}`;
    return label;
  });

  let CardComponent = $derived(nodeTypes[node.type] as Component | undefined);
  let rackU = $derived(rackSize?.size ? parseInt(rackSize.size, 10) || 1 : null);
  let rackHp = $derived(rackSize?.hp ?? 1);

  // ── PF-16: REAL PER-SECTION TABS ────────────────────────────────────────
  //
  // The rail used to be one hard-coded "MODULE" chip with a `real per-op tabs
  // are P1` comment. It becomes the module's own `face.pages`, but ONLY for a
  // face that genuinely cannot be read as one scrolling column — `dockTabPlan`
  // owns that threshold and its measured argument, and BOTH sides go through
  // it (this rail and ModuleShell's band hiding) so they can never disagree
  // about whether a face is tabbed.
  //
  // Un-migrated (legacy-card) occupants keep the single MODULE chip: their
  // content is one verbatim card with no declared sections to tab.
  let tabs = $derived(migrated && def ? dockTabPlan(dockFacePlan(def as FaceDefLike)) : null);
  let requestedTab = $state<string | undefined>(undefined);
  let activeTab = $derived(tabs ? activeDockTab(tabs, requestedTab) : undefined);

  // ── PF-20: THE CONTEXT SIDEBAR — DELETED, 2026-08-19 ────────────────────
  //
  // There is no sidebar column, no `sidebarPlan`, and no `.page.has-sidebar`
  // grid. The owner refused the surface by name — "I DO NOT WANT THESE RIGHT
  // HAND TEXT AREAS I DO NOT WANT EXTRA TEXT. i explicitly already dictated
  // that several times" — and the editor now gets the full width of the page
  // unconditionally, which is what "we reclaim the vertical space" asked for:
  // a tall text column forced the whole `.page` row to its own height.
  //
  // ⚠ Do not re-introduce a second column here for context, presets or
  // measurements. `ModuleFaceHero` in graph/types.ts carries the ruling set and
  // `face-resting-text-source.test.ts` denies the SHAPE, not just this
  // mechanism.

  // ── ANNOTATIONS — the DOCK-LEVEL toggle ─────────────────────────────────
  //
  // Owner (2026-08-02): the section prose "belongs as annotation text but not
  // on the card unless annotation is turned on".
  //
  // WHY THE TOGGLE LIVES HERE, in the pane's title bar:
  //   * It is a PANE-LEVEL VIEW control, the same class of thing as the
  //     undock / collapse / close trio beside it — it changes how this
  //     faceplate is shown, not what the module is. A per-card toggle would
  //     repeat the same switch on every band; a global app-chrome switch would
  //     annotate modules you are not looking at.
  //   * The bar is PANE-FIXED CHROME above `.faceplate-scroll`, so it is
  //     reachable at any pane width and any scroll position. The obvious other
  //     home — the tab rail — is `overflow-x: auto`, so on an 8-band face
  //     (cloudseed) a right-aligned control there scrolls out of reach.
  //   * It is hidden on the REAR flip: the rear card is a patch field with no
  //     prose to annotate, and the bar already swaps its content there.
  //
  // STATE: the EXISTING per-node `annotate-mode.svelte.ts` set — per viewer,
  // keyed by nodeId, NOT `node.data` and NOT the Y.Doc (see the note on
  // ModuleShell's `annotations`, and the dx7-selection precedent). So a
  // rack-mate turning annotations on never touches this view.
  //
  // It renders ONLY for a face that HAS annotation prose. A toggle that
  // reveals nothing is a labelled void — and gating on the DECLARATION (never
  // on a module id) is what
  // makes the affordance appear for adopter #2 without an edit here.
  let annotatable = $derived(migrated && def ? faceHasAnnotations(def as FaceplateDefLike) : false);
  let annotationsOn = $derived(isAnnotating(node.id));
</script>

<div
  class="dock-faceplate"
  data-testid="dock-full-view"
  data-fullview-node={node.id}
  data-flipped={flipped && def ? 'true' : 'false'}
>
  <!-- OCCUPANT SWAP = REMOUNT ({#key node.id}): opening module B while A is
       expanded must tear A's subtree down and mount B's fresh — never morph
       A's mounted card/shell in place with B's node. In-place morphing
       updated the OLD subtree's deriveds with the NEW node mid-flush
       (curated-face closures over the previous def) and, combined with a
       throwing legacy-card init, wedged the faceplate on the previous
       occupant (the "expand B switched nothing" bug). -->
  {#key node.id}
    <!-- CHROME-FIXED FRAME (owner: per-pane ✕ ALWAYS visible): the faceplate
         frame is a column — grip + title bar (with the .win-ctrls trio, incl.
         the pane ✕) are PANE-FIXED chrome, and ONLY the content region below
         them (.faceplate-scroll > .faceplate-body, min-width 900px) scrolls,
         both axes. Pre-fix the WHOLE faceplate lived inside the scroll
         container, so in a 50/50 split pane (~half the 900px kit width) the
         bar scrolled sideways with the content and the ✕ sat past the pane's
         right edge — invisible in BOTH the front and the flipped rear state
         (the owner screenshot: clipped "REA…" chip, no close anywhere). -->
    <div class={`faceplate ${domain}`} data-fullview-domain={domain}>
      <span class="spine" aria-hidden="true"></span>

      <div class="faceplate-grip" data-testid="faceplate-grip" aria-hidden="true"></div>

      <div class="faceplate-bar">
        <div class="face-id">
          <span class="face-badge" aria-hidden="true">{badge}</span>
          <div class="face-who">
            <div class="face-name" title={title}>{title}</div>
            <div class="face-sub">{sub}</div>
          </div>
        </div>
        <div class="face-spacer"></div>
        {#if annotatable && !(flipped && def)}
          <!-- ANNOTATIONS. A real toggle button (`aria-pressed`), not a chip:
               it is the switch that puts the face's authored prose into the
               DOM, so AT must be able to find it and say what state it is in. -->
          <button
            type="button"
            class="annot-btn"
            class:on={annotationsOn}
            data-testid="faceplate-annotations"
            aria-pressed={annotationsOn}
            title="Annotations — show this faceplate's authored notes"
            onclick={() => toggleAnnotate(node.id)}
          >NOTES</button>
        {/if}
        {#if flipped && def}
          <!-- REAR state chip — the title bar's only swap on the flip side
               (the frame reads as the same object, turned around). -->
          <span class="rear-chip" data-testid="rear-chip">REAR · PATCH</span>
        {/if}
        <div class="win-ctrls" data-testid="faceplate-win-ctrls">
          {#if onUndock}
            <button type="button" data-testid="faceplate-undock" title="Undock" aria-label="Undock" onclick={onUndock}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            </button>
          {/if}
          <button type="button" data-testid="faceplate-collapse" title="Collapse to lane" aria-label="Collapse to lane" onclick={onCollapse}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>
          </button>
          <button type="button" data-testid="faceplate-close" title="Close" aria-label="Close" onclick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- CONTENT SCROLL REGION: everything BELOW the chrome — the rear patch
           field or the front tab-rail + control page — scrolls here, both
           axes (the kit's 900px min-width now lives on .faceplate-body, so a
           half-width split pane gets sideways travel WITHOUT taking the title
           bar / ✕ along for the ride). -->
      <div class="faceplate-scroll">
        <div class="faceplate-body">
          {#if flipped && def}
            <!-- REAR CARD (flip key, Tab): the flip-side patch field replaces the
                 tab-rail + control page — patch points only, zero UI controls.
                 The front stays MOUNTED (hidden below) so flipping back never
                 reboots the occupant (scroll/knob state, video previews). -->
            <RearCard nodeId={node.id} def={def as unknown as RearDefLike} />
          {/if}

          <!-- FRONT face: hidden (not unmounted) while flipped. display:contents
               when visible keeps the layout byte-identical to pre-rear-card. -->
          <div class="fp-front" class:fp-front-hidden={flipped && def} data-testid="faceplate-front">
          <!-- Tab rail. A face whose section bands cannot fit one column
               (dockTabPlan) gets REAL per-section tabs; everything else keeps
               the single MODULE chip and scrolls, which is the better trade
               below the threshold. -->
          <div class="tabrail" role="tablist" data-testid="faceplate-tabrail">
            {#if tabs}
              {#each tabs as t (t.id)}
                <!-- `id` + `aria-controls` are the half of the tabs pattern
                     that was missing: without them a screen reader announces
                     eight tabs that control NOTHING, because the band
                     (`role="tabpanel"` on ModuleShell's `.dock-page`) has no
                     way to point back. The band's `aria-labelledby` names this
                     button, so the pairing is stated in both directions. -->
                <button
                  type="button"
                  class="tab"
                  class:on={t.id === activeTab}
                  role="tab"
                  id={`faceplate-tab-${t.id}`}
                  aria-selected={t.id === activeTab}
                  aria-controls={`face-page-${t.id}`}
                  tabindex={t.id === activeTab ? 0 : -1}
                  data-testid={`faceplate-tab-${t.id}`}
                  data-face-tab={t.id}
                  onkeydown={(e) => {
                    // ROVING FOCUS. Arrow keys move between tabs (the pattern's
                    // required interaction); Home/End jump to the ends. Without
                    // this the rail is reachable but not navigable as a tablist.
                    const i = tabs!.findIndex((x) => x.id === activeTab);
                    const n = tabs!.length;
                    let j = -1;
                    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n;
                    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n;
                    else if (e.key === 'Home') j = 0;
                    else if (e.key === 'End') j = n - 1;
                    if (j < 0) return;
                    e.preventDefault();
                    const next = tabs![j]!.id;
                    requestedTab = next;
                    (e.currentTarget as HTMLElement)
                      .parentElement?.querySelector<HTMLElement>(`[data-face-tab="${next}"]`)
                      ?.focus();
                  }}
                  onclick={() => (requestedTab = t.id)}
                ><span class="t1">{t.label}</span></button>
              {/each}
            {:else}
              <div class="tab on" data-testid="faceplate-tab"><span class="t1">MODULE</span></div>
            {/if}
          </div>

          <div class="page">
            <div class="editor" data-testid="faceplate-editor">
              {#if migrated}
                <ModuleShell id={node.id} data={{ node, view: 'dock-full', activePage: activeTab }} />
              {:else}
                <!-- Verbatim legacy card, plain-mount (data-dock-card* anchors +
                     node.id keying carried so PickupCable/cardRectOf + patch menu
                     resolve; PatchPanel self-gates outside the provider). -->
                <section class="fp-card-mount" data-dock-card={node.id} data-dock-type={node.type} data-dock-full="true">
                  <div class="fp-card-frame" data-dock-card-frame>
                    <div
                      class={rackU != null ? 'dock-rack-sized' : 'dock-natural-sized'}
                      style={rackU != null ? `--rack-hp:${rackHp};--rack-u:${rackU}` : undefined}
                    >
                      {#if CardComponent}
                        <CardComponent id={node.id} data={{ node }} />
                      {:else}
                        <div class="fp-missing">unknown module type: {node.type}</div>
                      {/if}
                    </div>
                  </div>
                </section>
              {/if}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  {/key}
</div>

<style>
  /* The full-view faceplate fills ONE pane of Canvas's .dock-fullview-drawer
     (the bottom overlay + 50/50 split container live THERE — dock
     unification: Canvas mounts EITHER that drawer OR the bottom DockRail
     ({#if}/{:else}), never both, and dockStore keeps the pinned M/E/C
     occupant closed while a full-view is up: pinned XOR full-view). Each
     faceplate's .faceplate-scroll is its pane's OWN overflow container —
     both axes — so split panes scroll independently (the kit's 900px
     min-width — now on .faceplate-body — guarantees sideways travel in a
     half-width pane). The FRAME is a column: grip + title bar (with the
     pane ✕) are pane-fixed chrome ABOVE the scroll region, so the ✕ is
     visible + clickable at any pane width and any scroll position, front
     AND flipped (the owner split-view close-button fix). The 4px root
     padding preserves the pre-fix breathing strip below the frame (the old
     .faceplate-scroll padding-bottom — keeps short-content scenes
     pixel-identical). */
  .dock-faceplate {
    /* #1573: match the pane — size to content, never grow. */
    flex: 0 1 auto;
    min-width: 0;
    max-height: min(60vh, 680px);
    display: flex;
    padding-bottom: 4px;
  }
  .faceplate {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .faceplate-scroll {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .fp-card-frame {
    position: relative;
    width: max-content;
    max-width: 100%;
  }
  /* PF-16 — the tabs are real <button role="tab"> elements now (keyboard +
     AT reachable). The kit's `.tab` rule already paints them; these three
     lines only undo the UA button defaults so a tab looks byte-identical to
     the div chip it replaced. */
  button.tab {
    font: inherit;
    appearance: none;
    -webkit-appearance: none;
  }
  /* FRONT face wrapper: layout-transparent when visible (display:contents —
     the pre-rear-card DOM shape is preserved pixel-for-pixel), display:none
     while the rear card is up (state kept, controls GONE). */
  .fp-front {
    display: contents;
  }
  .fp-front.fp-front-hidden {
    display: none;
  }
  /* THE ANNOTATIONS TOGGLE. Same kit `.state-chip.ghost` vocabulary as the
     REAR chip beside it — it sits in the same slot and must read as the same
     class of object — but DIM until pressed, so "off" is legible at a glance
     and "on" lights in the domain hue like every other engaged control. */
  .annot-btn {
    font: inherit;
    font-family: var(--f-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--dim, #9aa3ad);
    background: transparent;
    border: 1px solid var(--line, #2c3037);
    border-radius: 5px;
    padding: 4px 10px;
    margin-right: 8px;
    cursor: pointer;
    flex: 0 0 auto;
    appearance: none;
    -webkit-appearance: none;
  }
  .annot-btn:hover {
    color: var(--text, #eef1f5);
  }
  .annot-btn.on {
    color: var(--domain);
    border-color: var(--domain-d);
  }
  /* REAR · PATCH state chip (kit .state-chip.ghost vocabulary). Shrinkable
     with ellipsis so at split width the CHIP truncates before the ✕ trio
     (flex:none in the kit) ever loses a pixel — the bar never wraps or
     clips its window controls. */
  .rear-chip {
    font-family: var(--f-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 700;
    color: var(--domain);
    background: transparent;
    border: 1px solid var(--domain-d);
    border-radius: 5px;
    padding: 4px 10px;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dock-natural-sized,
  :global(.dock-faceplate .dock-rack-sized) {
    position: relative;
    width: max-content;
  }
  .fp-missing {
    padding: 12px;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
</style>
