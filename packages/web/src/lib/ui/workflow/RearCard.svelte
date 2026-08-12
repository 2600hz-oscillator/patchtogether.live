<script lang="ts">
  // RearCard — the RACKLINE flip-side PATCH FIELD (rear-card-spec.md).
  //
  // The dock full-view's rear face: every declared port = ONE hole, grouped
  // into full-width input BANDS (mirroring the face's pages) + a fixed,
  // visually INVERTED right OUTPUTS rail. No knobs, no menus — all patch
  // points flat and visible; the >60-hole pathology fallback is band-collapse
  // (a band folds to its header + jack-count pill), never a cascade.
  //
  // PATCHING reuses the shipped click-click carry seam VERBATIM: each hole is
  // the same `back-jack` button contract the legacy back panel uses (testids +
  // patchpanel:jackclick / patchpanel:carrycommit CustomEvents, bubbled to
  // document; Canvas owns commitCarriedEdge + validateEdge; PickupCable draws
  // the ghost — its dock-anchor fallback already ships). A rear patch is the
  // SAME validated edge with the SAME port ids as a front patch.
  //
  // One NEW interaction: COMPATIBILITY DIM — while a cable is carried, holes
  // a commit would reject drop to ~35% opacity (pure-derived from
  // connectDragState.pickupSource via canConnectToPort; no seam change).
  //
  // Direction is TRIPLE-CODED (rail position + inverted output tiles + ←/→
  // band glyphs) so COLOR means cable domain only: holes take the 5 RACKLINE
  // domain tokens (mapped off the live --cable-* palette exactly like the
  // dock faceplate kit; pitch → cv-green + a '1v/oct' tag). Live cable hues
  // are untouched — committed cables still render on the canvas edge layer;
  // the rear shows seated plugs (domain fill + endpoint chip).
  import { untrack } from 'svelte';
  import {
    rearFieldPlan,
    rearHoleAcceptsCarry,
    type RearDefLike,
    type RearHole,
  } from './rear-card-model';
  import { connectDragState } from '$lib/ui/connect-drag-state.svelte';
  import { stereoPairForPort, type StereoPairDefLike } from '$lib/graph/stereo-pairs';
  import { canConnectToPort, type CableType } from '$lib/graph/types';
  import { portConnections } from '$lib/ui/port-patch-helpers';
  import { remoteEndpointsTitle } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import { nodeVersion, edgesVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    nodeId: string;
    def: RearDefLike;
  }
  let { nodeId, def }: Props = $props();

  let plan = $derived(rearFieldPlan(def));

  // ---- live patch status (same pump recipe as PatchPanel's back panel) ----
  let edgeVersion = $derived(edgesVersion() + nodesStructuralVersion() + nodeVersion(nodeId));

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }

  let connections = $derived.by(() => {
    void edgeVersion;
    for (const e of Object.values(patch.edges)) {
      if (!e?.source || !e?.target) continue;
      if (e.source.nodeId === nodeId) void nodeVersion(e.target.nodeId);
      else if (e.target.nodeId === nodeId) void nodeVersion(e.source.nodeId);
    }
    return portConnections(
      patch.edges,
      nodeId,
      patch.nodes as Record<string, ModuleNode | undefined>,
      defLookup,
    );
  });

  /** A COLLAPSED stereo hole answers for BOTH its legs — a legacy rack whose
   *  only cable sits on the R leg must still show the hole as plugged, or the
   *  jack reads empty and its right-click falls through to the wrong menu. */
  function remotesFor(hole: RearHole): string[] {
    const map = hole.direction === 'input' ? connections.inputs : connections.outputs;
    const mine = map.get(hole.portId) ?? [];
    const sib = hole.stereoSiblingPortId;
    if (!sib) return mine;
    const theirs = map.get(sib) ?? [];
    if (theirs.length === 0) return mine;
    return [...new Set([...mine, ...theirs])];
  }

  /** "DisplayName.PORT" → the display name (the chip shows WHO, not which
   *  port — the title/aria carries the full remote strings). */
  function remoteName(remote: string): string {
    const i = remote.lastIndexOf('.');
    return (i > 0 ? remote.slice(0, i) : remote).toLowerCase();
  }

  function holeTitle(hole: RearHole, remotes: string[]): string {
    const parts: string[] = [hole.label];
    if (hole.pitch) parts[0] += ' (1v/oct)';
    if (hole.doc) parts.push(hole.doc);
    // Both directions name EVERY remote — a collapsed stereo hole is one hole
    // over two ports and can be fed by two different sources. This used to
    // print only `remotes[0]` on an input; see `remoteEndpointsTitle`.
    const endpoints = remoteEndpointsTitle(hole.direction, remotes);
    if (endpoints) parts.push(endpoints);
    return parts.join(' — ');
  }

  // ---- carry state: source pulse + compatibility dim (spec §2.2) ----
  let carried = $derived(
    connectDragState.mode === 'pickup' && !connectDragState.pickupVirtual
      ? connectDragState.pickupSource
      : connectDragState.mode === 'pickup'
        ? connectDragState.pickupSource // virtual carry: sentinel ids, still dims
        : null,
  );

  /** The carried INPUT's own `accepts` widening (rewire dim needs the source
   *  input port's def) — resolved off the live graph, pure-derived. */
  let carriedAccepts = $derived.by((): readonly string[] | undefined => {
    const src = carried;
    if (!src || src.handleType !== 'target') return undefined;
    void edgeVersion;
    const node = patch.nodes[src.nodeId] as ModuleNode | undefined;
    if (!node) return undefined;
    const d = defLookup(node.type);
    return d?.inputs?.find((p) => p.id === src.portId)?.accepts as readonly string[] | undefined;
  });

  let acceptsById = $derived.by(() => {
    const m = new Map<string, readonly string[] | undefined>();
    for (const p of def.inputs ?? []) m.set(p.id, p.accepts);
    return m;
  });

  function isCarrySource(hole: RearHole): boolean {
    const src = carried;
    if (!src) return false;
    return (
      src.nodeId === nodeId &&
      src.portId === hole.portId &&
      (src.handleType === 'source') === (hole.direction === 'output')
    );
  }

  /** data-compat: absent when idle; 'source' on the picked hole; 'ok' on holes
   *  a commit would accept; 'dim' (≈35% opacity) on holes it would reject. */
  function compatOf(hole: RearHole): 'source' | 'ok' | 'dim' | undefined {
    const src = carried;
    if (!src) return undefined;
    if (isCarrySource(hole)) return 'source';
    const ok = rearHoleAcceptsCarry(
      hole,
      hole.direction === 'input' ? acceptsById.get(hole.portId) : undefined,
      { handleType: src.handleType, cableType: src.cableType, accepts: carriedAccepts },
      (s, d) => canConnectToPort(s as CableType, d as { type: CableType; accepts?: readonly CableType[] }),
    );
    return ok ? 'ok' : 'dim';
  }

  // ---- the carry seam (VERBATIM contract: PatchPanel.jackInteract, rear path) ----
  let hostEl: HTMLDivElement | null = $state(null);

  function onHoleClick(hole: RearHole): void {
    const host = hostEl;
    if (!host) return;
    if (connectDragState.mode === 'pickup') {
      host.dispatchEvent(
        new CustomEvent('patchpanel:carrycommit', {
          bubbles: true,
          detail: { nodeId, portId: hole.portId, direction: hole.direction },
        }),
      );
      return;
    }
    host.dispatchEvent(
      new CustomEvent('patchpanel:jackclick', {
        bubbles: true,
        detail: { nodeId, portId: hole.portId, direction: hole.direction, side: 'left' },
      }),
    );
  }

  /** RIGHT-CLICK → UNPATCH. A rear hole is the ONLY affordance a lane-hosted
   *  card has for a cable it never drew by hand (the lane auto-wires a poly
   *  instrument's POLY input, and there is no clickable cable object in the
   *  dock view), so a PATCHED hole opens the shared unpatch menu — Canvas owns
   *  the menu + the removal, exactly like the carry seam above. An UNPATCHED
   *  hole is left completely alone (no preventDefault) so its right-click
   *  behaviour is byte-identical to before. */
  function onHoleContextMenu(e: MouseEvent, hole: RearHole): void {
    const host = hostEl;
    if (!host) return;
    if (remotesFor(hole).length === 0) {
      // UNPATCHED stereo OUTPUT → the "patch only L / only R" picker, the same
      // Canvas-owned menu the front panel's output rows open. Parity matters:
      // the rear card is the ONLY patch surface a dock full-view card has.
      // Anything else is left completely alone (no preventDefault), so every
      // other rear-hole right-click behaves exactly as before.
      if (hole.direction !== 'output' || !hasStereoImage(hole)) return;
      e.preventDefault();
      e.stopPropagation();
      host.dispatchEvent(
        new CustomEvent('patchpanel:portmenu', {
          bubbles: true,
          detail: { nodeId, portId: hole.portId, direction: 'output', x: e.clientX, y: e.clientY },
        }),
      );
      return;
    }
    // A collapsed hole names whichever leg actually holds a cable (preferring
    // the left); Canvas expands the removal to the whole leg group.
    const sib = hole.stereoSiblingPortId;
    const map = hole.direction === 'input' ? connections.inputs : connections.outputs;
    const portId = sib && (map.get(hole.portId)?.length ?? 0) === 0 ? sib : hole.portId;
    e.preventDefault();
    e.stopPropagation();
    host.dispatchEvent(
      new CustomEvent('patchpanel:jackcontextmenu', {
        bubbles: true,
        detail: {
          nodeId,
          portId,
          direction: hole.direction,
          x: e.clientX,
          y: e.clientY,
        },
      }),
    );
  }

  /** Does this hole carry a stereo image the picker can split? A collapsed hole
   *  says so directly; an uncollapsed one is asked of the def (a rail that
   *  shows only one leg of a pair still has the image). */
  function hasStereoImage(hole: RearHole): boolean {
    if (hole.stereoSiblingPortId) return true;
    return stereoPairForPort(def as StereoPairDefLike, hole.portId, hole.direction) !== null;
  }

  // ---- band collapse (pathology fallback only — spec §1.5) ----
  // Session-scoped per-band expansion; bands start collapsed only when the
  // field exceeds the threshold. State resets with the component (per-open).
  let expandedBands = $state<Set<string>>(new Set());
  function bandOpen(id: string): boolean {
    return !plan.collapse || expandedBands.has(id);
  }
  function toggleBand(id: string): void {
    if (!plan.collapse) return;
    untrack(() => {
      const next = new Set(expandedBands);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      expandedBands = next;
    });
  }
</script>

{#snippet jack(hole: RearHole)}
  {@const remotes = remotesFor(hole)}
  {@const patched = remotes.length > 0}
  {@const compat = compatOf(hole)}
  <button
    type="button"
    class={`rj ${hole.domain}`}
    class:out={hole.direction === 'output'}
    class:patched
    class:carrying={compat === 'source'}
    class:dim={compat === 'dim'}
    data-testid="back-jack"
    data-port-id={hole.portId}
    data-stereo-sibling={hole.stereoSiblingPortId}
    data-direction={hole.direction}
    data-patched={patched ? 'true' : 'false'}
    data-domain={hole.domain}
    data-compat={compat}
    title={holeTitle(hole, remotes)}
    aria-label={`patch ${hole.label} ${hole.direction}`}
    onclick={() => onHoleClick(hole)}
    oncontextmenu={(e) => onHoleContextMenu(e, hole)}
  >
    {#if hole.direction === 'output'}
      <span class="hole" aria-hidden="true"></span>
      <span class="col">
        <span class="lab" data-testid="jack-label"
          >{hole.label}{#if remotes.length > 1}<span class="fan">+{remotes.length - 1}</span>{/if}</span
        >
        {#if patched}<span class="ep">→ {remoteName(remotes[0])}</span>{/if}
      </span>
    {:else}
      <span class="lab" data-testid="jack-label">
        {hole.label}
        {#if hole.audioRate}<span class="ar" title="audio-rate">~</span>{/if}
        {#if hole.edge}<span class="edge" aria-hidden="true">{hole.edge === 'trigger' ? '▲' : '▬'}</span>{/if}
        {#if hole.pitch}<span class="voct">1v/oct</span>{/if}
      </span>
      <span class="hole" aria-hidden="true"></span>
      {#if patched}<span class="ep">← {remoteName(remotes[0])}</span>{/if}
    {/if}
  </button>
{/snippet}

<!-- The full-card jack field: input bands (full width, incl. the middle the
     legacy flip wasted) + the fixed inverted OUTPUTS rail. -->
<div
  class="rear-card"
  data-testid="rear-card"
  data-rear-node={nodeId}
  bind:this={hostEl}
>
  <div class="rear-page" class:dense-rail={plan.denseRail}>
    <div class="rear-main">
      {#each plan.bands as band (band.id)}
        <section class="rband" data-testid="rear-band" data-band-id={band.id}>
          {#if plan.collapse}
            <button
              type="button"
              class="rband-head as-button"
              data-testid="rear-band-toggle"
              aria-expanded={bandOpen(band.id)}
              onclick={() => toggleBand(band.id)}
            >
              <span class="dir" aria-hidden="true">←</span>
              <span class="bname">{band.label}</span>
              <span class="pill"
                >{band.holes.length + band.clusters.reduce((n, c) => n + c.holes.length, 0)} jacks</span
              >
            </button>
          {:else}
            <header class="rband-head">
              <span class="dir" aria-hidden="true">←</span>
              <span class="bname">{band.label}</span>
              {#if band.holes.some((h) => h.audioRate) || band.clusters.some((c) => c.holes.some((h) => h.audioRate))}
                <span class="tag">~ = audio-rate</span>
              {/if}
              {#if band.holes.some((h) => h.edge) || band.clusters.some((c) => c.holes.some((h) => h.edge))}
                <span class="tag">▲ trigger · ▬ gate</span>
              {/if}
            </header>
          {/if}
          {#if bandOpen(band.id)}
            <div class="rgrid">
              {#each band.holes as hole (hole.portId)}
                {@render jack(hole)}
              {/each}
              {#each band.clusters as cluster (cluster.label)}
                <div class="rcluster">{cluster.label}</div>
                {#each cluster.holes as hole (hole.portId)}
                  {@render jack(hole)}
                {/each}
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>

    <div class="rear-rail" data-testid="rear-rail">
      <header class="rband-head">
        <span class="dir" aria-hidden="true">→</span>
        <span class="bname">outputs</span>
      </header>
      <div class="rail-cells">
        {#each plan.outputs as hole (hole.portId)}
          {@render jack(hole)}
        {/each}
      </div>
    </div>

    <div class="rear-foot">
      <div class="legend" aria-hidden="true">
        <span><i class="sw audio"></i> audio</span>
        <span><i class="sw cv"></i> cv</span>
        <span><i class="sw gate"></i> gate</span>
        <span><i class="sw poly"></i> poly</span>
        <span><i class="sw video"></i> video</span>
        <span class="vocab">~ audio-rate · ▲ trigger · ▬ gate-level</span>
      </div>
      <div class="hint">
        <b>click</b> pick up · <b>click again</b> patch · <b>esc</b> drop · <b>tab</b> flip front
      </div>
    </div>
  </div>
</div>

<style>
  /* RACKLINE tokens — the same live-palette mapping the dock faceplate kit
     uses (self-contained so the card stays buildable standalone; inside
     .dock-faceplate the values coincide with the kit's by construction). */
  .rear-card {
    --rc-audio: var(--cable-audio, #38d3c8);
    --rc-cv: var(--cable-cv, #7bd66a);
    --rc-gate: var(--cable-gate, #f2c14e);
    --rc-video: var(--cable-video, #b57bff);
    --rc-poly: var(--cable-polyPitchGate, #ff7bc2);
    --rc-ink: #eef1f5;
    --rc-dim: #9aa2ad;
    --rc-faint: #646c77;
    --rc-line: #2c3037;
    --rc-inset: #0a0c0f;
    --rc-mono: var(--f-mono, ui-monospace, 'SF Mono', Menlo, Consolas, monospace);

    /* ── SCALE ────────────────────────────────────────────────────────────
       Owner 2026-08-11: "these are pretty massive … we could show a lot more
       if we reduce size on the patch panel view 40%". The goal is DENSITY, so
       EVERY geometric literal below goes through a dial — a shrunken hole
       marooned in the old whitespace would save nothing.

       TWO dials, and the split is the whole finding: a box that has to hold a
       WORD cannot shrink as fast as the space around it.

         --rc-s  SPACE — hole diameter, padding, gaps, row height, rail chrome.
                 0.6 is the ask, delivered in full.
         --rc-t  TYPE  — every font-size, PLUS the two widths whose job is to
                 contain text (--rc-cell-min, --rc-rail-w). LEGIBILITY floors
                 this at 0.9: 10px x 0.6 = 6px is not a readable uppercase
                 mono label, and a 0.6 cell would ellipsize labels the old
                 cell showed in full. Measured over all 1242 rear labels in
                 the registry, intrinsic width at 9px: median 35.8px,
                 p95 71.5px, max 95.3px — so the cell must keep ~80px of label
                 room to truncate no more often than it does today.

       Widening the SPACE dial was cheap and widening the TYPE dial was not,
       which is also why this is the right place to spend: at 1280x720 the
       field overflowed VERTICALLY 2.7x (954px of content in a 352px viewport)
       and did not overflow horizontally at all.

       Sub-glyph marks (~, the trigger/gate ticks, the fan-out badge) are
       ALREADY at the 8px legibility floor and deliberately do NOT scale. */
    --rc-s: 0.6;
    --rc-t: 0.9;

    /* rear geometry (spec Appendix A), all dialled */
    --rc-hole: calc(26px * var(--rc-s));
    --rc-cell-min: calc(96px * var(--rc-t));
    --rc-rail-w: calc(170px * var(--rc-t));
    color: var(--rc-ink);
  }
  /* domain setters — hole ring + derived shades per cell */
  .rj.audio { --rcd: var(--rc-audio); }
  .rj.cv { --rcd: var(--rc-cv); }
  .rj.gate { --rcd: var(--rc-gate); }
  .rj.video { --rcd: var(--rc-video); }
  .rj.poly { --rcd: var(--rc-poly); }
  .rj {
    --rcd-d: color-mix(in srgb, var(--rcd) 34%, #0e1013);
    --rcd-soft: color-mix(in srgb, var(--rcd) 10%, transparent);
    --rcd-wash: color-mix(in srgb, var(--rcd) 20%, transparent);
    --rcd-glow: color-mix(in srgb, var(--rcd) 42%, transparent);
    --rcd-on: color-mix(in srgb, var(--rcd) 22%, #05070a);
  }
  .sw.audio { background: var(--rc-audio); }
  .sw.cv { background: var(--rc-cv); }
  .sw.gate { background: var(--rc-gate); }
  .sw.video { background: var(--rc-video); }
  .sw.poly { background: var(--rc-poly); }

  /* ---- field surface: two-zone grid + the diagonal-hatch "back of the
     unit" wash (legacy back panel's gradient at RACKLINE opacity) ---- */
  .rear-page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--rc-rail-w);
    background: repeating-linear-gradient(135deg, rgba(0, 0, 0, 0.14) 0 2px, rgba(0, 0, 0, 0) 2px 8px);
  }
  .rear-page.dense-rail {
    --rc-rail-w: calc(220px * var(--rc-t));
    --rc-hole: calc(22px * var(--rc-s));
  }
  .rear-main {
    padding: calc(6px * var(--rc-s)) calc(22px * var(--rc-s)) calc(18px * var(--rc-s));
    min-width: 0;
  }

  /* ---- group band (kit .section grammar) ---- */
  .rband {
    padding: calc(13px * var(--rc-s)) 0 calc(15px * var(--rc-s));
    border-top: 1px solid var(--rc-line);
  }
  .rband:first-of-type {
    border-top: none;
    padding-top: calc(8px * var(--rc-s));
  }
  .rband-head {
    display: flex;
    align-items: baseline;
    gap: calc(10px * var(--rc-s));
    margin-bottom: calc(10px * var(--rc-s));
    font-size: calc(12px * var(--rc-t));
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--rc-dim);
    font-weight: 650;
  }
  .rband-head .dir {
    color: var(--rc-faint);
    font-family: var(--rc-mono);
    font-size: calc(11px * var(--rc-t));
  }
  .rband-head .tag {
    margin-left: auto;
    font-family: var(--rc-mono);
    font-size: calc(10px * var(--rc-t));
    color: var(--rc-faint);
    text-transform: none;
    letter-spacing: 0.02em;
  }
  .rband-head .tag + .tag {
    margin-left: calc(12px * var(--rc-s));
  }
  .rband-head.as-button {
    appearance: none;
    border: none;
    background: transparent;
    width: 100%;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: var(--rc-dim);
    text-transform: uppercase;
  }
  .rband-head .pill {
    margin-left: auto;
    font-family: var(--rc-mono);
    font-size: calc(10px * var(--rc-t));
    color: var(--rc-faint);
    border: 1px solid var(--rc-line);
    border-radius: 999px;
    padding: 1px calc(8px * var(--rc-s));
    text-transform: none;
  }

  /* rigid raster: cells align across bands, wrap at 50/50 width for free */
  .rgrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--rc-cell-min), 1fr));
    gap: calc(6px * var(--rc-s)) calc(8px * var(--rc-s));
    align-items: start;
  }
  .rcluster {
    grid-column: 1 / -1;
    margin: calc(4px * var(--rc-s)) 0 calc(-2px * var(--rc-s));
    display: flex;
    align-items: center;
    gap: calc(8px * var(--rc-s));
    font-family: var(--rc-mono);
    font-size: calc(9px * var(--rc-t));
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--rc-faint);
  }
  .rcluster::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--rc-line);
    opacity: 0.7;
  }

  /* ---- jack cell: the whole cell is the button ----------------------------
     THE WHOLE CELL — label, hole, and the space between them — has always been
     one <button>; the hole is a decorative <span> inside it. What was wrong was
     the AFFORDANCE: the only conspicuous hover cue was the hole scaling 12%,
     with a 3%-white cell wash nobody can see, so a control that accepted a
     click anywhere LOOKED like a 26px circle. Owner 2026-08-11: "the whole text
     area should be clickable, no reason to force it to just be the jack."
     The hit area did not move; the cue moved onto it, which matters more now
     the hole is 15.6px. See rear-card-hit-target.spec.ts — it clicks the LABEL
     (never the hole) and asserts the carry starts. */
  .rj {
    appearance: none;
    border: none;
    font: inherit;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: calc(5px * var(--rc-s));
    padding: calc(7px * var(--rc-s)) calc(4px * var(--rc-s)) calc(6px * var(--rc-s));
    border-radius: calc(8px * var(--rc-s));
    cursor: pointer;
    background: transparent;
    color: var(--rc-ink);
    min-height: calc(64px * var(--rc-s));
    position: relative;
  }
  /* Row-level hover: the whole cell washes + rings in its domain hue and the
     label lifts to full ink, so the live area and the visible area are the
     same shape. */
  .rj:hover {
    background: var(--rcd-soft);
    box-shadow: inset 0 0 0 1px var(--rcd-d);
  }
  .rj:hover .lab {
    color: var(--rc-ink);
  }
  .rj:focus-visible {
    outline: 2px solid var(--rcd);
    outline-offset: 1px;
  }
  .rj .lab {
    font-family: var(--rc-mono);
    font-size: calc(10px * var(--rc-t));
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rc-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    display: inline-flex;
    align-items: baseline;
    gap: calc(3px * var(--rc-s));
    justify-content: center;
  }
  .rj .lab .ar {
    color: var(--rcd);
    font-weight: 700;
  }
  /* The ▲/▬ ticks and the 1v/oct tag are ALREADY at the 8px legibility floor;
     they do not take --rc-t. (10px x 0.9 = 9px for the label they sit beside,
     so the size relationship still reads as "mark, not word".) */
  .rj .lab .edge {
    color: var(--rcd);
    font-size: 8px;
  }
  .rj .lab .voct {
    color: var(--rcd);
    font-size: 8px;
    letter-spacing: 0.02em;
    text-transform: none;
  }

  /* the hole — recessed socket, domain ring */
  .rj .hole {
    width: var(--rc-hole);
    height: var(--rc-hole);
    border-radius: 50%;
    flex: none;
    /* containing block for the carry pulse ring (.rj.carrying .hole::after) */
    position: relative;
    background: radial-gradient(circle at 50% 42%, #181d25 0 40%, #04060a 46% 100%);
    border: 2px solid var(--rcd);
    box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 255, 255, 0.05);
    transition: transform 120ms ease, box-shadow 120ms ease;
  }
  .rj:hover .hole {
    transform: scale(1.12);
    box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.9), 0 0 12px var(--rcd-glow);
  }
  /* patched — the plug seats + endpoint chip */
  .rj.patched .hole {
    background: radial-gradient(circle at 50% 42%, var(--rcd) 0 46%, #04060a 54% 100%);
    box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.6), 0 0 10px var(--rcd-glow);
  }
  .rj .ep {
    font-family: var(--rc-mono);
    font-size: calc(9px * var(--rc-t));
    letter-spacing: 0.03em;
    color: var(--rcd);
    background: var(--rcd-soft);
    border: 1px solid var(--rcd-d);
    border-radius: calc(4px * var(--rc-s));
    padding: 0 calc(6px * var(--rc-s));
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* carry source — dashed domain pulse (the ghost cable's dash vocabulary).
     Anchored to the HOLE, not to the cell: it used to be a ::after on .rj at
     `top: 38px` with a `.rj.out` override at `left: 23px`, two magic numbers
     that encoded the OLD cell geometry and would have silently drifted off the
     socket the moment --rc-s moved. Riding the hole's own box is scale-correct
     by construction and drops the override. */
  .rj.carrying .hole::after {
    content: '';
    position: absolute;
    inset: -40%;
    border-radius: 50%;
    border: 2px dashed var(--rcd);
    opacity: 0.8;
    animation: rc-carry-pulse 1.4s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes rc-carry-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.95;
    }
  }
  /* compatibility dim — invalid targets recede while a cable is carried */
  .rj.dim {
    opacity: 0.32;
    filter: saturate(0.4);
  }

  /* ---- OUTPUTS rail: fixed right column, inverted domain tiles ---- */
  .rear-rail {
    border-left: 1px solid var(--rc-line);
    background: linear-gradient(180deg, #12161e, #0e1219);
    padding: calc(14px * var(--rc-s)) calc(12px * var(--rc-s)) calc(18px * var(--rc-s));
    display: flex;
    flex-direction: column;
  }
  .rear-rail .rband-head {
    margin-bottom: calc(8px * var(--rc-s));
  }
  .rail-cells {
    display: flex;
    flex-direction: column;
    gap: calc(8px * var(--rc-s));
  }
  .dense-rail .rail-cells {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: calc(6px * var(--rc-s));
  }
  .rj.out {
    flex-direction: row;
    justify-content: flex-start;
    gap: calc(10px * var(--rc-s));
    text-align: left;
    background: var(--rcd-wash);
    border: 1px solid var(--rcd-d);
    border-radius: calc(8px * var(--rc-s));
    padding: calc(9px * var(--rc-s)) calc(10px * var(--rc-s));
    min-height: 0;
    width: 100%;
  }
  /* The output tile already washed on hover; keep it and add the same
     whole-cell ring + label lift the input cells now get, so BOTH shapes say
     "this entire tile is the control". */
  .rj.out:hover {
    background: color-mix(in srgb, var(--rcd) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--rcd);
  }
  .rj.out .hole {
    border-color: transparent;
    background: var(--rc-inset);
    box-shadow: inset 0 0 0 calc(3px * var(--rc-s)) var(--rcd), inset 0 0 6px rgba(0, 0, 0, 0.8);
  }
  .rj.out.patched .hole {
    background: radial-gradient(circle at 50% 42%, var(--rcd) 0 38%, var(--rc-inset) 46% 100%);
    box-shadow: inset 0 0 0 calc(3px * var(--rc-s)) var(--rcd), 0 0 10px var(--rcd-glow);
  }
  .rj.out .col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: calc(2px * var(--rc-s));
    min-width: 0;
  }
  .rj.out .lab {
    color: var(--rc-ink);
  }
  .rj .fan {
    font-family: var(--rc-mono);
    font-size: 8.5px; /* already at the legibility floor — does not scale */
    color: var(--rcd-on);
    font-weight: 800;
    background: var(--rcd);
    border-radius: 999px;
    padding: 0 calc(5px * var(--rc-s));
    margin-left: calc(4px * var(--rc-s));
  }
  /* ---- footer: domain legend + interaction hint ---- */
  .rear-foot {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: calc(18px * var(--rc-s));
    flex-wrap: wrap;
    padding: calc(9px * var(--rc-s)) calc(16px * var(--rc-s)) calc(11px * var(--rc-s));
    background: #14171b;
    border-top: 1px solid var(--rc-line);
  }
  .legend {
    display: flex;
    gap: calc(14px * var(--rc-s));
    flex-wrap: wrap;
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--rc-s));
    font-size: calc(10px * var(--rc-t));
    color: var(--rc-dim);
    font-family: var(--rc-mono);
    letter-spacing: 0.04em;
  }
  .legend .sw {
    width: calc(9px * var(--rc-s));
    height: calc(9px * var(--rc-s));
    border-radius: calc(3px * var(--rc-s));
  }
  .legend .vocab {
    color: var(--rc-faint);
  }
  .hint {
    margin-left: auto;
    font-family: var(--rc-mono);
    font-size: calc(10px * var(--rc-t));
    color: var(--rc-faint);
    letter-spacing: 0.04em;
  }
  .hint b {
    color: var(--rc-dim);
    font-weight: 600;
  }

  @media (prefers-reduced-motion: reduce) {
    .rj.carrying .hole::after {
      animation: none;
    }
    .rj .hole {
      transition: none;
    }
  }
</style>
