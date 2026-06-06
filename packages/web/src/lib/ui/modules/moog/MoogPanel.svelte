<script lang="ts">
  // MoogPanel — the SHARED beige Moog faceplate wrapper for the Moog
  // System 55 / 35 clone module family (.myrobots/MOOG/). This is the
  // intrinsic, always-on Moog look (per the plan's resolved decision:
  // "beige Moog panel is the intrinsic always-on look") — it does NOT
  // depend on the active UI skin.
  //
  // REUSE CONTRACT (read this before adding the next Moog module):
  //   Every Moog card wraps its body in <MoogPanel>:
  //
  //     <MoogPanel {id} {data} defaultLabel="moogafakkin 921 VCO">
  //       <PatchPanel nodeId={id} {inputs} {outputs}>
  //         …knobs / switches…
  //       </PatchPanel>
  //     </MoogPanel>
  //
  //   MoogPanel renders the card chrome (beige faceplate + black engraved
  //   title plate + the editable ModuleTitle) and re-binds the shared
  //   control CSS variables (--module-bg / --text / --border / --accent /
  //   …) to Moog-era beige/black values *scoped to this card*, so the
  //   stock Knob / Fader / PatchPanel controls inherit the faceplate
  //   palette automatically — no per-control restyling needed. New Moog
  //   slices get the look for free by wrapping their body here.
  //
  //   Props:
  //     id / data        — the SvelteFlow NodeProps passthrough (for the title).
  //     defaultLabel     — fallback module name shown on the title plate.
  //     width            — faceplate width in px (default 240; wider modules
  //                        like a future 960 mixer pass their own).
  //     children         — the card body (a PatchPanel + controls).
  import type { Snippet } from 'svelte';
  import ModuleTitle from '../ModuleTitle.svelte';

  interface Props {
    id: string;
    // NodeProps `data` is loosely typed at the card boundary; ModuleTitle
    // owns the precise shape. Pass it straight through.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    defaultLabel: string;
    width?: number;
    children?: Snippet;
  }

  let { id, data, defaultLabel, width = 240, children }: Props = $props();
</script>

<div class="moog-panel" style:width="{width}px" data-moog-panel>
  <!-- Black engraved title plate, Moog-era style. -->
  <div class="moog-title-plate">
    <ModuleTitle {id} {data} {defaultLabel} />
  </div>
  <div class="moog-body">
    {@render children?.()}
  </div>
</div>

<style>
  /*
   * The beige Moog faceplate. We re-bind the shared control CSS variables
   * (consumed by Knob / Fader / PatchPanel / ModuleTitle) to the Moog
   * palette, scoped to this card only — so every nested control inherits
   * the beige/black era look without per-control overrides. This is the
   * single place the Moog look is defined; later slices reuse it verbatim.
   */
  .moog-panel {
    /* ---- Moog faceplate palette (scoped re-binds of the shared tokens) ---- */
    /* Brushed-beige aluminium faceplate. */
    --module-bg: #d8cbb0;
    --module-bg-deep: #c4b696;
    /* Engraved-black text + walnut/black trim. */
    --text: #1c1812;
    --text-dim: #5a5040;
    --text-on-accent: #d8cbb0;
    --border: #6b5d44;
    --border-strong: #3d3424;
    --divider: #b6a684;
    /* Vintage amber accent (the era's panel-lamp / indicator hue), not the
     * default cyan — keeps the Moog cards visually distinct + on-theme. */
    --accent: #b5651d;
    --accent-dim: #8a4e16;
    --accent-glow: rgba(181, 101, 29, 0.4);

    background:
      /* Subtle brushed-metal vertical streaks. */
      repeating-linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.04) 0px,
        rgba(255, 255, 255, 0.04) 1px,
        rgba(0, 0, 0, 0.03) 2px,
        rgba(0, 0, 0, 0.03) 3px
      ),
      linear-gradient(180deg, #ddd0b6 0%, #d2c4a6 100%);
    border: 2px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text);
    padding-bottom: 14px;
    position: relative;
    /* Walnut end-cheek shadow + soft drop. */
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      inset 0 -2px 4px rgba(0, 0, 0, 0.18),
      0 3px 10px rgba(0, 0, 0, 0.4);
    transition: box-shadow 80ms ease-out, border-color 80ms ease-out;
  }
  :global(.svelte-flow__node:hover) .moog-panel {
    border-color: var(--accent-dim);
  }
  :global(.svelte-flow__node.selected) .moog-panel {
    border-color: var(--accent);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.35),
      0 0 0 1px var(--accent-glow),
      0 3px 10px rgba(0, 0, 0, 0.4);
  }

  /* Black engraved title plate at the top of the faceplate. */
  .moog-title-plate {
    background: linear-gradient(180deg, #232019 0%, #15120d 100%);
    border-bottom: 1px solid var(--border-strong);
    border-radius: 2px 2px 0 0;
    padding: 4px 8px 5px;
    /* The ModuleTitle text must read against the black plate; override the
     * scoped --text just for the plate so the title is the engraved-cream
     * Moog logotype colour rather than the body's dark engraving.
     *
     * `color: var(--text)` is REQUIRED here, not just the token re-bind:
     * ModuleTitle's text is `color: inherit`, and without an explicit color
     * declaration the plate inherits the *computed* dark color from
     * `.moog-panel { color: var(--text) }` (evaluated there as #1c1812) — the
     * re-bound --text never gets re-evaluated, so the title rendered
     * dark-on-dark. Setting color here re-evaluates --text to the cream. */
    --text: #e8dcc0;
    --text-dim: #b6a684;
    color: var(--text);
  }

  .moog-body {
    padding-top: 8px;
  }

  /*
   * Control labels — engraved-black, NOT washed-out dim.
   *
   * BUG (every Moog card): the stock Knob / Fader render their caption as
   * `<div class="label">` coloured `var(--text-dim)`, and the per-card
   * switch captions (.sync-label / .range-label / .mode-label) do the same.
   * On the dark default skin --text-dim (#888) is a legible secondary grey,
   * but MoogPanel re-binds --text-dim to the faceplate's muted beige-brown
   * (#5a5040) so those labels wash straight into the brushed-beige
   * faceplate (only ~5:1 over the lightest brushed-metal streak) and read
   * as "missing". On a real Moog faceplate the control engravings are
   * BLACK, so the captions should use the engraved --text (#1c1812, ~11:1),
   * not the dim token.
   *
   * We can't just darken --text-dim wholesale: the SAME token is consumed
   * by the patch-panel popover (which has its OWN dark background), where a
   * dark dim tone would vanish dark-on-dark — i.e. it'd only move the bug.
   * So we re-point the on-faceplate control captions specifically to the
   * engraved --text. Scoped to .moog-body so the dark popover is untouched.
   *
   * :global() because the Knob/Fader `.label` is scoped to those control
   * components and the switch captions are scoped to each card; this is the
   * single shared place the Moog faceplate dresses its nested controls, so
   * every Moog card (921 / 904A / 902 / 911 / CP3 + future slices) gets the
   * visible labels for free — same intent as the token re-binds above.
   */
  .moog-body :global(.knob-wrap .label),
  .moog-body :global(.fader-wrap .label),
  .moog-body :global(.sync-label),
  .moog-body :global(.range-label),
  .moog-body :global(.mode-label) {
    color: var(--text);
  }

  /*
   * Patch-panel labels — the OTHER half of the dark-on-dark bug.
   *
   * The faceplate re-binds --text/--text-dim to dark engraved tones for the
   * beige plate, but the patch panel pops out on its OWN near-black field
   * (`.patch-panel { background: rgba(14,17,22,.97); color: var(--text) }`),
   * so those dark tokens cascade in and the port-row labels + section headers
   * render dark-on-dark (the "921b has no labels" report — it's every Moog
   * card). #560 mistakenly assumed the popover was "untouched"; it inherits
   * the faceplate token re-binds.
   *
   * Re-point the tokens to the engraved-cream pair JUST for the patch-panel
   * subtree — exactly what .moog-title-plate does for the dark title plate.
   * `.patch-panel` already declares `color: var(--text)` so the re-bind takes
   * effect on the row labels (color: inherit); --text-dim covers the subgroup
   * titles + port counts.
   */
  .moog-body :global(.patch-panel) {
    --text: #e8dcc0;
    --text-dim: #b6a684;
  }
</style>
