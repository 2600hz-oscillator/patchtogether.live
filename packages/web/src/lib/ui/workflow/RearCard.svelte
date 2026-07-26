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
  import { canConnectToPort, type CableType } from '$lib/graph/types';
  import { portConnections } from '$lib/ui/port-patch-helpers';
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

  function remotesFor(hole: RearHole): string[] {
    const map = hole.direction === 'input' ? connections.inputs : connections.outputs;
    return map.get(hole.portId) ?? [];
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
    if (remotes.length > 0) {
      parts.push(hole.direction === 'input' ? `← FROM ${remotes[0]}` : `→ TO ${remotes.join(', ')}`);
    }
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
    if (remotesFor(hole).length === 0) return;
    const host = hostEl;
    if (!host) return;
    e.preventDefault();
    e.stopPropagation();
    host.dispatchEvent(
      new CustomEvent('patchpanel:jackcontextmenu', {
        bubbles: true,
        detail: {
          nodeId,
          portId: hole.portId,
          direction: hole.direction,
          x: e.clientX,
          y: e.clientY,
        },
      }),
    );
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
        <span class="lab"
          >{hole.label}{#if remotes.length > 1}<span class="fan">+{remotes.length - 1}</span>{/if}</span
        >
        {#if patched}<span class="ep">→ {remoteName(remotes[0])}</span>{/if}
      </span>
    {:else}
      <span class="lab">
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
          {#if hole.pairWithPrev}
            <div class="pair-tie" aria-hidden="true">stereo pair</div>
          {/if}
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
    /* rear geometry (spec Appendix A) */
    --rc-hole: 26px;
    --rc-cell-min: 96px;
    --rc-rail-w: 170px;
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
    --rc-rail-w: 220px;
    --rc-hole: 22px;
  }
  .rear-main {
    padding: 6px 22px 18px;
    min-width: 0;
  }

  /* ---- group band (kit .section grammar) ---- */
  .rband {
    padding: 13px 0 15px;
    border-top: 1px solid var(--rc-line);
  }
  .rband:first-of-type {
    border-top: none;
    padding-top: 8px;
  }
  .rband-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 10px;
    font-size: 12px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--rc-dim);
    font-weight: 650;
  }
  .rband-head .dir {
    color: var(--rc-faint);
    font-family: var(--rc-mono);
    font-size: 11px;
  }
  .rband-head .tag {
    margin-left: auto;
    font-family: var(--rc-mono);
    font-size: 10px;
    color: var(--rc-faint);
    text-transform: none;
    letter-spacing: 0.02em;
  }
  .rband-head .tag + .tag {
    margin-left: 12px;
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
    font-size: 10px;
    color: var(--rc-faint);
    border: 1px solid var(--rc-line);
    border-radius: 999px;
    padding: 1px 8px;
    text-transform: none;
  }

  /* rigid raster: cells align across bands, wrap at 50/50 width for free */
  .rgrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--rc-cell-min), 1fr));
    gap: 6px 8px;
    align-items: start;
  }
  .rcluster {
    grid-column: 1 / -1;
    margin: 4px 0 -2px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--rc-mono);
    font-size: 9px;
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

  /* ---- jack cell: the whole ~96×64 cell is the button (>44px hit floor) ---- */
  .rj {
    appearance: none;
    border: none;
    font: inherit;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 7px 4px 6px;
    border-radius: 8px;
    cursor: pointer;
    background: transparent;
    color: var(--rc-ink);
    min-height: 64px;
    position: relative;
  }
  .rj:hover {
    background: rgba(255, 255, 255, 0.03);
  }
  .rj:focus-visible {
    outline: 2px solid var(--rcd);
    outline-offset: 1px;
  }
  .rj .lab {
    font-family: var(--rc-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rc-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    display: inline-flex;
    align-items: baseline;
    gap: 3px;
    justify-content: center;
  }
  .rj .lab .ar {
    color: var(--rcd);
    font-weight: 700;
  }
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
    font-size: 9px;
    letter-spacing: 0.03em;
    color: var(--rcd);
    background: var(--rcd-soft);
    border: 1px solid var(--rcd-d);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* carry source — dashed domain pulse (the ghost cable's dash vocabulary) */
  .rj.carrying::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 38px;
    width: 40px;
    height: 40px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    border: 2px dashed var(--rcd);
    opacity: 0.8;
    animation: rc-carry-pulse 1.4s ease-in-out infinite;
    pointer-events: none;
  }
  .rj.out.carrying::after {
    left: 23px;
    top: 50%;
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
    padding: 14px 12px 18px;
    display: flex;
    flex-direction: column;
  }
  .rear-rail .rband-head {
    margin-bottom: 8px;
  }
  .rail-cells {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dense-rail .rail-cells {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .rj.out {
    flex-direction: row;
    justify-content: flex-start;
    gap: 10px;
    text-align: left;
    background: var(--rcd-wash);
    border: 1px solid var(--rcd-d);
    border-radius: 8px;
    padding: 9px 10px;
    min-height: 0;
    width: 100%;
  }
  .rj.out:hover {
    background: color-mix(in srgb, var(--rcd) 28%, transparent);
  }
  .rj.out .hole {
    border-color: transparent;
    background: var(--rc-inset);
    box-shadow: inset 0 0 0 3px var(--rcd), inset 0 0 6px rgba(0, 0, 0, 0.8);
  }
  .rj.out.patched .hole {
    background: radial-gradient(circle at 50% 42%, var(--rcd) 0 38%, var(--rc-inset) 46% 100%);
    box-shadow: inset 0 0 0 3px var(--rcd), 0 0 10px var(--rcd-glow);
  }
  .rj.out .col {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  }
  .rj.out .lab {
    color: var(--rc-ink);
  }
  .rj .fan {
    font-family: var(--rc-mono);
    font-size: 8.5px;
    color: var(--rcd-on);
    font-weight: 800;
    background: var(--rcd);
    border-radius: 999px;
    padding: 0 5px;
    margin-left: 4px;
  }
  .pair-tie {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -4px 2px;
    font-family: var(--rc-mono);
    font-size: 8.5px;
    color: var(--rc-faint);
    letter-spacing: 0.1em;
  }
  .pair-tie::before,
  .pair-tie::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--rc-line);
  }
  .dense-rail .pair-tie {
    display: none; /* 2-col rail: the tie row would break the grid */
  }

  /* ---- footer: domain legend + interaction hint ---- */
  .rear-foot {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
    padding: 9px 16px 11px;
    background: #14171b;
    border-top: 1px solid var(--rc-line);
  }
  .legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .legend span {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--rc-dim);
    font-family: var(--rc-mono);
    letter-spacing: 0.04em;
  }
  .legend .sw {
    width: 9px;
    height: 9px;
    border-radius: 3px;
  }
  .legend .vocab {
    color: var(--rc-faint);
  }
  .hint {
    margin-left: auto;
    font-family: var(--rc-mono);
    font-size: 10px;
    color: var(--rc-faint);
    letter-spacing: 0.04em;
  }
  .hint b {
    color: var(--rc-dim);
    font-weight: 600;
  }

  @media (prefers-reduced-motion: reduce) {
    .rj.carrying::after {
      animation: none;
    }
    .rj .hole {
      transition: none;
    }
  }
</style>
