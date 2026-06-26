<script lang="ts">
  // AnnotatePopover — the on-canvas counterpart to the doc page's DocHoverPane.
  //
  // PURE PRESENTATIONAL + ANCHORED: given the resolved `hovered` ref (a control
  // key OR a port id + direction), the flat `docIndex`, and the hovered element's
  // viewport rect, it renders the friendly name + authored "what it does" in a
  // dark popover positioned NEXT TO the element (flipping side to stay on-screen).
  // It portals to <body> with position:fixed so it escapes the SvelteFlow
  // viewport transform AND the patch panel's own portaled chrome — the same
  // reason PatchPanel portals. For a CV input with a paramTarget it shows the
  // DUAL context ("modulates {Param} — {what that fader does}"), matching
  // DocHoverPane so the jack and its faceplate control explain to the same prose.
  import type { DocIndex, DocControlEntry, DocPortEntry } from '$lib/docs/doc-index';
  import type { HoverRef } from '$lib/docs/interactive/use-doc-hover.svelte';

  interface Props {
    /** What the user is hovering, or null (→ popover hidden). */
    hovered: HoverRef | null;
    /** Viewport rect of the hovered element, used to anchor the popover. */
    anchor: DOMRect | null;
    /** The flat doc payload to resolve the hovered key/port against. */
    docIndex: DocIndex;
  }

  let { hovered, anchor, docIndex }: Props = $props();

  let control = $derived<DocControlEntry | null>(
    hovered?.kind === 'control' ? (docIndex.controls[hovered.key] ?? null) : null,
  );
  let port = $derived<DocPortEntry | null>(
    hovered?.kind === 'port'
      ? ((hovered.direction === 'input' ? docIndex.inputs : docIndex.outputs)[hovered.id] ?? null)
      : null,
  );

  let visible = $derived(!!anchor && (!!control || !!port));

  /** Plain-language cable label (mirrors DocHoverPane.cableLabel). */
  function cableLabel(cable: string): string {
    switch (cable) {
      case 'audio': return 'audio';
      case 'cv': return 'control voltage (CV)';
      case 'pitch': return 'V/oct pitch';
      case 'gate': return 'gate / trigger';
      case 'polyPitchGate': return 'poly pitch+gate bus';
      case 'image': return 'still image';
      case 'mono-video': return 'mono video';
      case 'video': return 'video';
      default: return cable;
    }
  }

  // ---------------- Anchoring (position:fixed, flip to stay on-screen) -------
  const W = 280; // popover width (matches the CSS max-width)
  const GAP = 10; // gap between the anchored element and the popover
  const MARGIN = 8; // keep this far off every viewport edge

  // Measure our own height so the vertical clamp / flip uses the real size.
  let popEl: HTMLDivElement | null = $state(null);
  let measuredH = $state(160);
  $effect(() => {
    void hovered; void anchor; // re-measure when content/anchor changes
    if (popEl) measuredH = popEl.offsetHeight || measuredH;
  });

  let pos = $derived.by(() => {
    if (!anchor) return { left: 0, top: 0 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer the RIGHT of the element; flip LEFT if it would overflow.
    let left = anchor.right + GAP;
    if (left + W + MARGIN > vw) left = anchor.left - GAP - W;
    // If it still overflows left (narrow element near the right edge), clamp.
    left = Math.max(MARGIN, Math.min(left, vw - W - MARGIN));
    // Vertically align the popover's top to the element's top, clamped on-screen.
    let top = anchor.top;
    top = Math.max(MARGIN, Math.min(top, vh - measuredH - MARGIN));
    return { left, top };
  });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

{#if visible}
  <div use:portal>
    <div
      bind:this={popEl}
      class="annotate-popover"
      data-testid="annotate-popover"
      role="tooltip"
      style:left="{pos.left}px"
      style:top="{pos.top}px"
    >
      {#if control}
        <div class="ap-eyebrow">control</div>
        <h3 class="ap-name" data-testid="annotate-name">{control.name}</h3>
        {#if control.range}
          <div class="ap-meta" data-testid="annotate-range">
            range <code>{control.range}</code>
            {#if control.defaultValue !== undefined && control.defaultValue !== null}
              · default <code>{control.defaultValue}</code>
            {/if}
          </div>
        {/if}
        <p class="ap-desc" data-testid="annotate-desc">{control.desc ?? '—'}</p>
      {:else if port}
        <div class="ap-eyebrow">
          {hovered?.kind === 'port' ? hovered.direction : ''} ·
          <span class="cable cable-{port.cable}">{cableLabel(port.cable)}</span>
        </div>
        <h3 class="ap-name" data-testid="annotate-name">{port.name}</h3>
        <p class="ap-desc" data-testid="annotate-desc">{port.desc ?? port.explain}</p>
        {#if port.paramTarget}
          <div class="ap-dual" data-testid="annotate-dual">
            <div class="ap-dual-head">modulates <strong>{port.paramTarget.name}</strong></div>
            {#if port.paramTarget.desc}
              <p class="ap-dual-desc">{port.paramTarget.desc}</p>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .annotate-popover {
    position: fixed;
    width: 280px;
    max-width: 280px;
    z-index: 1200; /* above the patch panel chrome (1001) */
    background: rgba(14, 17, 22, 0.98);
    border: 1px solid var(--accent-dim, #2bb6c8);
    border-left: 4px solid var(--accent, #2bb6c8);
    border-radius: 6px;
    color: var(--text, #d7e2e6);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 0.7rem 0.85rem 0.8rem;
    font-family: ui-sans-serif, system-ui, sans-serif;
    pointer-events: none; /* never steals hover from the card underneath */
  }
  .ap-eyebrow {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim, #6e7a82);
    margin-bottom: 0.2rem;
  }
  .ap-name {
    margin: 0 0 0.3rem;
    font-size: 1.02rem;
    line-height: 1.2;
    color: var(--text, #eaf2f4);
  }
  .ap-meta {
    font-size: 0.74rem;
    color: var(--text-dim, #6e7a82);
    margin-bottom: 0.4rem;
  }
  .ap-meta code {
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, monospace;
  }
  .ap-desc {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.5;
  }
  .ap-dual {
    margin-top: 0.6rem;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
    border: 1px dashed var(--accent, #2bb6c8);
    background: color-mix(in srgb, var(--accent, #2bb6c8) 10%, transparent);
  }
  .ap-dual-head {
    font-size: 0.74rem;
    color: var(--text-dim, #6e7a82);
    margin-bottom: 0.2rem;
  }
  .ap-dual-head strong {
    color: var(--accent, #2bb6c8);
  }
  .ap-dual-desc {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .cable-cv { color: var(--cable-cv, #b18cff); }
  .cable-gate { color: var(--cable-gate, #ff9f43); }
  .cable-audio { color: var(--cable-audio, #2bb6c8); }
  .cable-pitch { color: var(--cable-pitch, #6cf); }
  .cable-video { color: var(--cable-video, #ff6ad5); }
</style>
