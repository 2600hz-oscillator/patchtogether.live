<script lang="ts">
  // RearCard — the RACKLINE flip-side PATCH FIELD.
  //
  // Every declared port = ONE hole. #1800 gave BOTH rails the SAME compact
  // labelled row the OUTPUTS list already had, and lays the groups out as
  // COLUMNS instead of stacking full-width bands:
  //
  //   owner, 2026-08-17 — "[the OUTPUTS list] is cool but [the INPUTS bands]
  //   is wasteful. everything should be done in the output style list" /
  //   "we want to do intelligent authored grouping of inputs and outputs,
  //   with different sections as coumns i think."
  //
  // A band claiming a full card row for three jacks was the waste; a column of
  // rows is the fix, and the reclaimed horizontal space is where the other
  // sections go. Grouping is AUTHORED on the def (`face.rear.groups`, now with
  // a `direction`) over a derived default — see rear-card-model.ts.
  //
  // ── DIRECTION WITHOUT COLOUR ────────────────────────────────────────────
  // COLOR MEANS CABLE DOMAIN AND NOTHING ELSE: holes take the RACKLINE domain
  // tokens mapped off the live --cable-* palette (pitch → cv-green + a '1v/oct'
  // tag), so the same port type is the same hue on BOTH rails. Direction is
  // carried by FOUR non-colour channels — zone, section glyph, ROW MIRROR
  // (`.rj.out` reverses the row so the jack rides the outer edge) and the
  // inverted output tile. They are DECLARED in `rear-direction.ts` and gated by
  // `rear-direction.test.ts`, which also asserts the inverse: no
  // direction-qualified selector in this file may assign the domain hue.
  //
  // ⚠ The row MARKUP is a single snippet for both rails — one grammar in the
  // source, not just on screen. The mirror is `flex-direction: row-reverse`,
  // so there is exactly one place a row can drift from itself.
  //
  // ── PATCHING IS THE SHIPPED SEAM, VERBATIM ──────────────────────────────
  // Each hole is the same `back-jack` button contract the legacy back panel
  // uses (testids + patchpanel:jackclick / patchpanel:carrycommit CustomEvents,
  // bubbled to document; Canvas owns commitCarriedEdge + validateEdge;
  // PickupCable draws the ghost). A rear patch is the SAME validated edge with
  // the SAME port ids as a front patch. #1800 changed LAYOUT ONLY — not one
  // line of the seam below moved.
  //
  // COMPATIBILITY DIM: while a cable is carried, holes a commit would reject
  // drop to ~35% opacity (pure-derived from connectDragState.pickupSource via
  // canConnectToPort; no seam change).
  import {
    rearFieldPlan,
    rearHoleAcceptsCarry,
    rearZoneColumns,
    type RearDefLike,
    type RearHole,
    type RearSection,
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

  // ---- carry state: source pulse + compatibility dim ----
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

  /** BALANCED COLUMN MODE — see `.zone-cols.balanced`. CSS multicol balances
   *  column heights (no orphan last row), but a section wider than one column
   *  would overflow it, so the zone only takes that mode when every section in
   *  it is one column wide. Derived from the plan, never guessed. */
  function balanced(sections: readonly RearSection[]): boolean {
    return sections.every((s) => s.columns === 1);
  }

  /** Does this hole carry a stereo image the picker can split? A collapsed hole
   *  says so directly; an uncollapsed one is asked of the def (a rail that
   *  shows only one leg of a pair still has the image). */
  function hasStereoImage(hole: RearHole): boolean {
    if (hole.stereoSiblingPortId) return true;
    return stereoPairForPort(def as StereoPairDefLike, hole.portId, hole.direction) !== null;
  }
</script>

<!-- ONE ROW GRAMMAR. The same snippet renders an input and an output; `.rj.out`
     mirrors it (row-reverse + right-aligned label) so the jack always rides the
     row's OUTER edge, and inverts its chrome. Nothing here branches on
     direction to pick a COLOUR. -->
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
    <span class="hole" aria-hidden="true"></span>
    <span class="lab" data-testid="jack-label"
      >{hole.label}{#if hole.audioRate}<span class="ar" title="audio-rate">~</span>{/if}{#if hole.edge}<span
          class="edge"
          aria-hidden="true">{hole.edge === 'trigger' ? '▲' : '▬'}</span
        >{/if}{#if hole.pitch}<span class="voct">1v/oct</span>{/if}{#if remotes.length > 1}<span
          class="fan">+{remotes.length - 1}</span
        >{/if}</span
    >
    {#if patched}<span class="ep">{hole.direction === 'input' ? '←' : '→'} {remoteName(remotes[0])}</span>{/if}
  </button>
{/snippet}

<!-- A SECTION IS A COLUMN: a heading plus a single list of rows. Both rails use
     it; `data-direction` is the machine-readable half of the ZONE channel. -->
{#snippet sectionCol(sec: RearSection)}
  <!-- `--cols` is the section's DERIVED width in columns (rear-card-model:
       `rearSectionColumns`). It drives both the section's own width and the
       `column-count` its row list flows into, from ONE number — so the box and
       the rows inside it cannot disagree about how wide the group is. -->
  <section
    class="rsec"
    data-testid="rear-section"
    data-section-id={sec.id}
    data-direction={sec.direction}
    data-columns={sec.columns}
    style={`--cols:${sec.columns}`}
  >
    <header class="rsec-head">
      {#if sec.direction === 'input'}
        <span class="rsec-dir" aria-hidden="true">←</span>
        <span class="rsec-name">{sec.label}</span>
      {:else}
        <span class="rsec-name">{sec.label}</span>
        <span class="rsec-dir" aria-hidden="true">→</span>
      {/if}
    </header>
    <div class="rsec-rows">
      {#each sec.holes as hole (hole.portId)}
        {@render jack(hole)}
      {/each}
      {#each sec.clusters as cluster (cluster.label)}
        <div class="rcluster">{cluster.label}</div>
        {#each cluster.holes as hole (hole.portId)}
          {@render jack(hole)}
        {/each}
      {/each}
    </div>
  </section>
{/snippet}

<div class="rear-card" data-testid="rear-card" data-rear-node={nodeId} bind:this={hostEl}>
  <div class="rear-page" class:dense={plan.dense}>
    <div class="rear-zones">
      {#if plan.inputs.length > 0}
        <div class="rear-zone in" data-testid="rear-zone" data-direction="input">
          <div
            class="zone-cols"
            class:balanced={balanced(plan.inputs)}
            style={`--zcols:${rearZoneColumns(plan.inputs.length, 'input', plan.dense)}`}
          >
            {#each plan.inputs as sec (sec.id)}
              {@render sectionCol(sec)}
            {/each}
          </div>
        </div>
      {/if}
      {#if plan.outputs.length > 0}
        <div class="rear-zone out" data-testid="rear-zone" data-direction="output">
          <div
            class="zone-cols"
            class:balanced={balanced(plan.outputs)}
            style={`--zcols:${rearZoneColumns(plan.outputs.length, 'output', plan.dense)}`}
          >
            {#each plan.outputs as sec (sec.id)}
              {@render sectionCol(sec)}
            {/each}
          </div>
        </div>
      {/if}
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

         --rc-s  SPACE — hole diameter, padding, gaps, row height, chrome.
         --rc-t  TYPE  — every font-size, PLUS the widths whose job is to
                 contain text (--rc-col-min/max). LEGIBILITY floors this at
                 0.9: 10px x 0.6 = 6px is not a readable uppercase mono label.
                 Measured over all 1242 rear labels in the registry, intrinsic
                 width at 9px: median 35.8px, p95 71.5px, max 95.3px — so a
                 column must keep ~80px of label room to truncate no more often
                 than it does today.

       Sub-glyph marks (~, the trigger/gate ticks, the fan-out badge) are
       ALREADY at the 8px legibility floor and deliberately do NOT scale. */
    --rc-s: 0.6;
    --rc-t: 0.9;

    --rc-hole: calc(26px * var(--rc-s));
    /* A SECTION COLUMN, floored by the label + jack it must hold and capped so
       one wide label cannot stretch the whole card (#1800: "we do not want
       useless gray horizontal space on cards, ever"). */
    --rc-col-min: calc(140px * var(--rc-t));
    --rc-col-max: calc(200px * var(--rc-t));
    --rc-gap: calc(14px * var(--rc-s));
    color: var(--rc-ink);
    /* The field is exactly as wide as its columns need. `.faceplate-body`
       relaxes its 900px kit floor for us (`:has(.rear-card)` in
       _dock-faceplate.css) so this is not immediately overridden. */
    width: max-content;
    max-width: 100%;
  }
  /* DOMAIN SETTERS — the ONLY place `--rcd` is assigned, and every selector
     here is direction-FREE by construction. That is the invariant
     rear-direction.test.ts asserts: colour means cable domain, so the same
     port type must resolve to the same hue on either rail. */
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

  /* ---- field surface: the two direction ZONES + the "back of the unit" wash
     (legacy back panel's diagonal hatch at RACKLINE opacity) ---- */
  .rear-page {
    display: flex;
    flex-direction: column;
    background: repeating-linear-gradient(135deg, rgba(0, 0, 0, 0.14) 0 2px, rgba(0, 0, 0, 0) 2px 8px);
  }
  .rear-zones {
    display: flex;
    align-items: stretch;
  }
  /* CHANNEL: ZONE. Inputs left, outputs right, parted by a rule. The outputs
     zone never stretches — it is as wide as the sections in it, which is the
     "width must be earned" rule applied to the rail that used to be a fixed
     170px whatever it held. */
  .rear-zone {
    padding: calc(10px * var(--rc-s)) calc(14px * var(--rc-s)) calc(14px * var(--rc-s));
    min-width: 0;
  }
  .rear-zone.in {
    flex: 0 1 auto;
  }
  .rear-zone.out {
    flex: 0 0 auto;
    border-left: 1px solid var(--rc-line);
    background: linear-gradient(180deg, #12161e, #0e1219);
  }

  /* ---- SECTIONS AS COLUMNS. A wrapping row of content-width columns: they
     never stretch (no grey filler inside a column) and they never overflow
     sideways (they wrap to a new band of columns instead). ---- */
  /* ⚠ `--zcols` IS LOAD-BEARING LAYOUT, not a taste knob. The card is
     `width: max-content`, and NEITHER of the two modes below has a usable
     intrinsic width: a `flex-wrap` row asked for max-content never wraps (every
     column on one line), and a multicol asked for max-content collapses to ONE
     column — that second one was MEASURED, not predicted, and turned tidyVco's
     field into a 287x929 ribbon. `--zcols` (rear-card-model `rearZoneColumns`,
     the one home for the caps) is the definite bound both modes resolve
     against. */
  .zone-cols {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    align-content: flex-start;
    gap: calc(4px * var(--rc-s)) var(--rc-gap);
    max-width: calc(var(--rc-col-max) * var(--zcols) + var(--rc-gap) * (var(--zcols) - 1));
  }
  /* BALANCED MODE — used when every section in the zone is one column wide,
     which is almost every module.
     ⚠ MEASURED, not preferred: `flex-wrap` is GREEDY, so tidyVco's six
     single-column groups packed 5 + 1 and left its last group alone beside
     ~600 px of empty hatch — the owner's "useless gray horizontal space", moved
     rather than removed. CSS multicol BALANCES column heights instead, so the
     same six groups fill evenly and there is no orphan row. It cannot be the
     only mode: a multi-column section is wider than a multicol column and would
     overflow it, so a zone containing one falls back to the wrap above. The
     switch is DERIVED from the plan (`sec.columns`), never guessed. */
  .zone-cols.balanced {
    display: block;
    width: calc(var(--rc-col-min) * var(--zcols) + var(--rc-gap) * (var(--zcols) - 1));
    max-width: none;
    column-count: var(--zcols);
    column-gap: var(--rc-gap);
  }
  .zone-cols.balanced > .rsec {
    break-inside: avoid;
    width: auto;
    max-width: none;
    min-width: 0;
  }
  /* ONE SECTION = ONE COLUMN, until its own content earns another. A section
     stays shrink-to-fit at `--cols: 1` (so a three-jack group is three jacks
     wide, not a reserved slot), and takes an exact multi-column box above that
     — a thirty-row group is the case where the OLD full-width band was
     space-efficient, and a single tall column would have been the regression. */
  .rsec {
    flex: 0 1 auto;
    min-width: var(--rc-col-min);
    max-width: calc(var(--rc-col-max) * var(--cols, 1) + var(--rc-gap) * (var(--cols, 1) - 1));
    padding: calc(6px * var(--rc-s)) 0 calc(8px * var(--rc-s));
  }
  .rsec[data-columns='1'] {
    width: max-content;
  }
  .rsec:not([data-columns='1']) {
    width: calc(var(--rc-col-max) * var(--cols) + var(--rc-gap) * (var(--cols) - 1));
  }
  .rsec:not([data-columns='1']) .rsec-rows {
    column-count: var(--cols);
    column-gap: var(--rc-gap);
  }
  /* Multicol may break anywhere it likes; a row split down the middle or a
     cluster heading orphaned at a column foot are both real. */
  .rsec-rows .rj {
    break-inside: avoid;
  }
  .rsec-rows .rcluster {
    break-inside: avoid;
    break-after: avoid;
  }
  .rsec-head {
    display: flex;
    align-items: baseline;
    gap: calc(8px * var(--rc-s));
    margin-bottom: calc(5px * var(--rc-s));
    padding-bottom: calc(4px * var(--rc-s));
    border-bottom: 1px solid var(--rc-line);
    font-size: calc(11px * var(--rc-t));
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--rc-dim);
    font-weight: 650;
  }
  .rsec-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* CHANNEL: SECTION GLYPH — a literal ← / →, legible with no legend, no hue
     and no colour vision. Pushed to the heading's OUTER edge so it points the
     same way the rows below it are mirrored. */
  .rsec-dir {
    color: var(--rc-faint);
    font-family: var(--rc-mono);
    font-size: calc(11px * var(--rc-t));
    flex: none;
  }
  .rsec[data-direction='output'] .rsec-name {
    margin-left: auto;
  }
  /* BLOCK flow, not flex-column: a multi-column section (`--cols` > 1) needs
     CSS multicol on this box, and multicol does not fragment a flex container.
     Row spacing therefore rides on the rows themselves. */
  .rsec-rows {
    display: block;
  }
  .rsec-rows > * {
    margin-bottom: calc(2px * var(--rc-s));
  }
  .rcluster {
    margin: calc(5px * var(--rc-s)) 0 calc(1px * var(--rc-s));
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

  /* ---- THE ROW: one grammar, jack + label ---------------------------------
     THE WHOLE ROW — label, hole, and the space between them — is one <button>;
     the hole is a decorative <span> inside it. Owner 2026-08-11: "the whole
     text area should be clickable, no reason to force it to just be the jack."
     See rear-card-hit-target.spec.ts — it clicks the LABEL (never the hole) and
     asserts the carry starts. */
  .rj {
    appearance: none;
    border: 1px solid transparent;
    font: inherit;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: calc(9px * var(--rc-s));
    padding: calc(4px * var(--rc-s)) calc(6px * var(--rc-s));
    border-radius: calc(7px * var(--rc-s));
    cursor: pointer;
    background: transparent;
    color: var(--rc-ink);
    text-align: left;
    width: 100%;
    position: relative;
  }
  /* CHANNEL: ROW MIRROR. The one channel that survives a single row seen in
     isolation — the jack rides the OUTER edge of the field, so an output's
     socket is on the right and an input's on the left, and the label reads
     inward from it. Geometry only: no hue, no chrome, no extra pixels. */
  .rj.out {
    flex-direction: row-reverse;
    text-align: right;
  }
  /* Row-level hover: the whole row washes + rings in its domain hue and the
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
    flex: 1 1 auto;
    font-family: var(--rc-mono);
    font-size: calc(10px * var(--rc-t));
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rc-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .rj .lab .ar {
    color: var(--rcd);
    font-weight: 700;
    margin-left: calc(3px * var(--rc-s));
  }
  /* The ▲/▬ ticks and the 1v/oct tag are ALREADY at the 8px legibility floor;
     they do not take --rc-t. (10px x 0.9 = 9px for the label they sit beside,
     so the size relationship still reads as "mark, not word".) */
  .rj .lab .edge {
    color: var(--rcd);
    font-size: 8px;
    margin-left: calc(3px * var(--rc-s));
  }
  .rj .lab .voct {
    color: var(--rcd);
    font-size: 8px;
    letter-spacing: 0.02em;
    text-transform: none;
    margin-left: calc(3px * var(--rc-s));
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
    flex: 0 1 auto;
    min-width: 0;
    font-family: var(--rc-mono);
    font-size: calc(9px * var(--rc-t));
    letter-spacing: 0.03em;
    color: var(--rcd);
    background: var(--rcd-soft);
    border: 1px solid var(--rcd-d);
    border-radius: calc(4px * var(--rc-s));
    padding: 0 calc(6px * var(--rc-s));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* carry source — dashed domain pulse (the ghost cable's dash vocabulary),
     anchored to the HOLE so it is scale-correct by construction. */
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

  /* CHANNEL: TILE CHROME — an output row is a filled, bordered tile with its
     socket sunk into a collar; an input row is open on the card ground. A
     LUMINANCE difference, not a hue one: the fill is whatever domain hue the
     row already carries, so the same port type is the same colour on both
     rails (asserted by rear-direction.test.ts). */
  .rj.out {
    background: var(--rcd-wash);
    border-color: var(--rcd-d);
  }
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

  /* ---- THE HIGH-PORT-COUNT STEP (plan.dense) ------------------------------
     Columns are the primary answer — the same rows in N columns are 1/N the
     height, and height is the axis that overflowed. Past REAR_DENSE_ROWS the
     rows also tighten and the endpoint chip drops its TEXT.

     ⚠ NOTHING IS HIDDEN. This replaces band-collapse, which kept a band's
     holes OUT OF THE DOM until you clicked its header — i.e. patch points
     behind a disclosure, on a card whose only patch surface this is. Every
     hole here stays rendered, hit-testable and patchable, and the remote it is
     wired to is still on the row's `title` and in its aria-label. */
  .dense .rj {
    padding: calc(2px * var(--rc-s)) calc(5px * var(--rc-s));
    gap: calc(7px * var(--rc-s));
  }
  .dense .rj .ep {
    display: none;
  }
  .dense .rsec {
    padding-bottom: calc(5px * var(--rc-s));
  }

  /* ---- footer: domain legend + interaction hint ----
     ⚠ `width: 0; min-width: 100%` is deliberate. The card is `width:
     max-content`, so ANY child that will not wrap becomes the width floor —
     and this row of legend + hint is ~740px of text that would have set the
     card's width for a two-jack module and filled the difference with exactly
     the grey space this redesign exists to remove. Zero width takes it out of
     the intrinsic-size calculation; 100% min-width then stretches it back to
     whatever the JACK FIELD decided, where its own flex-wrap can take over. */
  .rear-foot {
    width: 0;
    min-width: 100%;
    /* explicit: the padding below must sit INSIDE the 100%, or the footer
       overhangs the card it was just told not to widen. */
    box-sizing: border-box;
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
