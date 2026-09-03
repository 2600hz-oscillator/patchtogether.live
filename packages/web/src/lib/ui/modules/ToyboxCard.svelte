<script lang="ts">
  // ToyboxCard — the LEGACY host for the TOYBOX console.
  //
  // ⚠ THIS FILE OWNS NO CONTROL. Everything TOYBOX does — the screen, the layer
  // band, the six per-kind editors, the 17-op combine graph, the CV rail, the
  // preset store — lives in `./toybox/ToyboxConsole.svelte`, which the v2
  // faceplate body mounts too. What is left here is the CARD FRAME and nothing
  // else: the rack tile, its stripe, the title, and the PatchPanel that carries
  // the module's external jacks.
  //
  // WHY THE SPLIT. Promotion (2026-09-02) stops both surfaces rendering this
  // card, so every affordance needed a home that is not "the card". COPYING the
  // console into a faceplate body would have been two consoles over one Y.Doc,
  // drifting apart one fix at a time; instead the console is a single component
  // with a `layout` prop, and `toybox-face-model.test.ts` pins that BOTH hosts
  // mount that one file. Its header carries the whole argument.
  //
  // ⚠ WHAT STAYED HERE AND WHY — the part a future reader will want. Svelte
  // scopes CSS per component, so a rule left behind whose element moved stops
  // applying SILENTLY. `.mod-card`, `.stripe` and the two
  // `:global(.svelte-flow__node…)` rules are the only rules in the old
  // stylesheet whose SUBJECT is outside the console's subtree, so they are the
  // only ones that could stay. Everything else moved WHOLE, because several of
  // those rules are PAIRS that die if split:
  //
  //   * the bare `canvas` selector sizes BOTH the preview and the six CV
  //     scopes;
  //   * `.filename`, `.sync-hint`, `.input-error` and `.clear-btn` have no
  //     standalone rules at all — they are styled only through
  //     `.input-picker …` / `.preset-section …` ancestor pairs;
  //   * `.cable-hit:hover + .cable` is a SIBLING combinator, and it is what
  //     makes a combine edge hit-testable and hover-tinted;
  //   * `.graph-wrap { resize: vertical }` IS the graph's resize affordance —
  //     there is no element and no testid for it, so losing the rule would kill
  //     `setCombineViewSize` with every gate still green.
  //
  // The card's PIXELS are unchanged: `layout="card"` renders byte-identical
  // markup inside this same frame, which is what keeps the committed toybox VRT
  // baselines and the twenty `?shell=legacy` toybox specs pointed at the surface
  // they were written for.

  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import { CV_PORT_IDS } from '$lib/video/toybox-cv-routes';
  import ModuleTitle from './ModuleTitle.svelte';
  import ToyboxConsole from './toybox/ToyboxConsole.svelte';

  // The two VIDEO input ports. Ids match the def's inA/inB; the label is the
  // human-facing VID A / VID B.
  const VIDEO_IN_PORTS: ReadonlyArray<{ id: 'inA' | 'inB'; label: string }> = [
    { id: 'inA', label: 'VID A' },
    { id: 'inB', label: 'VID B' },
  ];

  // ---- PatchPanel ports (NO raw side handles — the #767 yellow drill-down
  //      standard). Port `id`s are BYTE-IDENTICAL to the toybox def + the prior
  //      raw <Handle>s (cv1..cv6 / inA / inB / out) so the CV bridge + persisted
  //      edges route unchanged; only the rendering moved into the panel. The 6
  //      generic mod inputs are coloured `cv` (the def widens their cable TYPE to
  //      modsignal, but they're modulation inputs — `cv` is the panel's row
  //      colour, mirroring the old --cable-cv handles); the video I/O is `video`.
  //      These are ONLY the OUTER module ports — the internal combine-graph node
  //      editor's own jacks (SVG, not <Handle>) are untouched. ----
  const inputs: PortDescriptor[] = [
    ...CV_PORT_IDS.map((cvId, i) => ({ id: cvId, label: `IN ${i + 1}`, cable: 'cv' })),
    ...VIDEO_IN_PORTS.map((vp) => ({ id: vp.id, label: vp.label, cable: 'video' })),
  ];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
</script>

<div class="mod-card toybox-card" data-testid="toybox-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TOYBOX" />

  <!-- All EXTERNAL module ports (cv1..cv6 / inA / inB / out) patch through the
       shared yellow drill-down PatchPanel (#767 standard) — NO raw side jacks,
       and the rear-view back panel works when the rack is flipped. PatchPanel's
       host is display:contents, so the card layout below is unchanged. -->
  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- ⚠ `nodeSnapshot` is the xyflow wrapper, and passing it is load-bearing
         rather than tidy: its identity is FRESH on every snapshot, which is the
         dependency every one of the console's per-layer deriveds uses to notice
         a REMOTE or preset write. The live Y proxy's identity is STABLE across
         writes, so a derived that watched that instead would never re-run. The
         faceplate body has no such wrapper and reads `nodeVersion(id)`. -->
    <ToyboxConsole nodeId={id} nodeSnapshot={node} layout="card" />
  </PatchPanel>
</div>

<style>
  .mod-card {
    /* Wide 3-column card (preview + layer editor | combine graph | CV section).
     * Width rounded to a whole-u (180px) rack tile (#759 — 5u = 900px) so the
     * card lands on the rack grid; its inner combine-graph panel stays
     * vertically resizable, so it's a DYNAMIC_SIZED card (no fixed rack tier). */
    width: 900px;
    min-height: 300px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
</style>
