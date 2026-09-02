<script lang="ts">
  // CONTROL SURFACE LANE TILE — the live strip, and the PRUNE's new home.
  //
  // ⚠ THE PRUNE IS THE REASON THIS COMPONENT EXISTS, and it is HERE rather than
  // in the fullViewBody deliberately. `pruneSurfaceDangling` had exactly ONE
  // production caller in the tree — the legacy card's `$effect` — and
  // controlSurface is in neither half of `HEADLESS_MOUNT_LANE_TYPES`, so
  // promotion silently stops it with every registry test green (the ES-9
  // card-only-side-effect shape: a dangling binding lingers in node.data and
  // the next Electra flash emits a dead control). The lane tile is the surface
  // that is mounted whenever the node is on canvas; the dock body mounts only
  // while a human has the full view open. `ModuleShell` gates `tileBody` on
  // `!extBody`, so when the dock body IS painting, the lane tile still mounts
  // this one — the two are counterparts, never siblings, and the effect runs
  // in exactly one place per surface.
  //
  // ⚠ THE STRIP IS THE PER-NODE GLANCE the glyph slot cannot give (a shell
  // extension glyph carries no nodeId): one SVG swatch per bound SOURCE module,
  // in first-seen group order, each filled with that source's LIVE control
  // colour (resolveControlColor — passthrough, never stored). It is the same
  // colour language the board's stripes and the source's own knobs speak, so
  // the tile answers "what is on this surface" at a glance. SVG rather than
  // CSS-background divs for the electraControl reason: the dock width gate's
  // ink sweep sees svg boxes and is blind to painted div backgrounds.
  //
  // ⚠ NO VALUE, NO COUNT, NO STATE WORD IS PAINTED. The derived counts live on
  // the strip's aria-label (the electra boardName licence). The EMPTY state
  // paints the one-line instruction naming the right-click "Send to …" gesture
  // — the module's only discovery path (the midiclock empty-state licence),
  // and the resting picture the VRT face scenes capture.

  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import { readSurfaceData, groupBindingsByModule } from '$lib/graph/control-surface';
  import { pruneSurfaceDangling } from '$lib/graph/control-surface-params';
  import { resolveControlColor } from '$lib/graph/control-color';

  let { nodeId }: { nodeId: string } = $props();

  // The card's bounded version pump, verbatim — own node + every bound SOURCE
  // (a source colour/rename bump must repaint the strip) + node add/remove
  // (the prune cares about deletions).
  let tileVersion = $derived.by(() => {
    let v = nodeVersion(nodeId) + nodesStructuralVersion();
    const seen = new Set<string>();
    for (const b of readSurfaceData(patch.nodes[nodeId]).bindings ?? []) {
      if (seen.has(b.moduleId)) continue;
      seen.add(b.moduleId);
      v += nodeVersion(b.moduleId);
    }
    return v;
  });

  // AUTO-PRUNE dangling proxied controls — the card's effect, moved onto the
  // surface that outlives it. Conservative (never prunes a not-yet-loaded
  // source) and a no-op when nothing dangles.
  $effect(() => {
    void tileVersion;
    pruneSurfaceDangling(nodeId);
  });

  interface StripGroup {
    moduleId: string;
    color: string;
    count: number;
  }

  let strip = $derived.by<StripGroup[]>(() => {
    void tileVersion;
    const out: StripGroup[] = [];
    for (const g of groupBindingsByModule(readSurfaceData(patch.nodes[nodeId]).bindings ?? [])) {
      const sourceNode = patch.nodes[g.moduleId] as ModuleNode | undefined;
      if (!sourceNode) continue;
      out.push({ moduleId: g.moduleId, color: resolveControlColor(sourceNode), count: g.bindings.length });
    }
    return out;
  });

  let total = $derived(strip.reduce((n, g) => n + g.count, 0));
  let surfaceTitle = $derived.by(() => {
    void tileVersion;
    return readSurfaceData(patch.nodes[nodeId]).name ?? 'Control Surface';
  });
</script>

<div class="cs-tile" data-testid={`cs-tile-${nodeId}`}>
  {#if strip.length === 0}
    <div class="cs-tile-empty" data-testid={`cs-tile-empty-${nodeId}`}>
      Right-click a control → “Send to {surfaceTitle}”.
    </div>
  {:else}
    <svg
      class="cs-tile-strip"
      data-testid={`cs-tile-strip-${nodeId}`}
      role="img"
      aria-label={`${surfaceTitle} — ${total} controls from ${strip.length} modules; expand to operate them`}
      viewBox={`0 0 ${strip.length * 20} 10`}
      preserveAspectRatio="none"
    >
      {#each strip as g, i (g.moduleId)}
        <rect
          data-testid={`cs-tile-swatch-${nodeId}-${g.moduleId}`}
          x={i * 20 + 1}
          y="2"
          width="18"
          height="6"
          rx="2"
          fill={`#${g.color}`}
        />
      {/each}
    </svg>
  {/if}
</div>

<style>
  .cs-tile {
    width: 100%;
    padding: 2px 6px 4px;
    box-sizing: border-box;
  }
  .cs-tile-empty {
    border: 1px dashed #3a4150;
    border-radius: 4px;
    color: var(--text-dim, #8a93a6);
    font-size: 0.6rem;
    line-height: 1.25;
    text-align: center;
    padding: 4px 5px;
  }
  .cs-tile-strip {
    display: block;
    width: 100%;
    height: 12px;
  }
</style>
