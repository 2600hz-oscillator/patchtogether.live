<script lang="ts">
  // DocHoverPane — the RIGHT column of the interactive virtual-module doc page.
  //
  // PURE PRESENTATIONAL: given the resolved `hovered` ref (a control key OR a
  // port id + direction) + the flat `docIndex`, it renders name / cable type /
  // range / authored desc for whatever the user is hovering on the live card to
  // the LEFT. With nothing hovered it shows the module's behavioral explanation
  // (the default / empty state). For a CV input that modulates a param it shows
  // the DUAL context — "modulates {Param} — {what that fader does}" — so the CV
  // jack and its faceplate control resolve to the same authored prose.
  //
  // It owns NO state and reaches into NO store; the hover action + the page own
  // resolution. This keeps it trivially unit/VRT-friendly and SSR-safe (the
  // prerendered HTML can render the default explanation with no JS).
  import type { DocIndex, DocControlEntry, DocPortEntry } from '$lib/docs/doc-index';
  import type { HoverRef } from './use-doc-hover.svelte';

  interface Props {
    /** What the user is hovering, or null (→ default explanation). */
    hovered: HoverRef | null;
    /** The flat doc payload to resolve the hovered key/port against. */
    docIndex: DocIndex;
  }

  let { hovered, docIndex }: Props = $props();

  // Resolve the hovered ref to a control or a port entry.
  let control = $derived<DocControlEntry | null>(
    hovered?.kind === 'control' ? (docIndex.controls[hovered.key] ?? null) : null,
  );
  let port = $derived<DocPortEntry | null>(
    hovered?.kind === 'port'
      ? ((hovered.direction === 'input' ? docIndex.inputs : docIndex.outputs)[hovered.id] ?? null)
      : null,
  );

  /** Plain-language cable label (mirrors io-explain.cableTypeLabel, trimmed). */
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
</script>

<aside class="doc-hover-pane" data-testid="doc-hover-pane">
  {#if control}
    <!-- A FACEPLATE CONTROL (knob / fader / family member / button). -->
    <div class="pane-card" data-pane-kind="control" data-pane-key={control.key}>
      <div class="pane-eyebrow">control</div>
      <h3 class="pane-name" data-testid="pane-name">{control.name}</h3>
      {#if control.range}
        <div class="pane-meta" data-testid="pane-range">
          range <code>{control.range}</code>
          {#if control.defaultValue !== undefined && control.defaultValue !== null}
            · default <code>{control.defaultValue}</code>
          {/if}
        </div>
      {/if}
      <p class="pane-desc" data-testid="pane-desc">{control.desc ?? '—'}</p>
    </div>
  {:else if port}
    <!-- A PATCH PORT (input or output jack from the open panel). -->
    <div
      class="pane-card"
      data-pane-kind="port"
      data-pane-key={port.id}
      data-pane-direction={hovered?.kind === 'port' ? hovered.direction : ''}
    >
      <div class="pane-eyebrow">
        {hovered?.kind === 'port' ? hovered.direction : ''} · <span class="cable cable-{port.cable}">{cableLabel(port.cable)}</span>
      </div>
      <h3 class="pane-name" data-testid="pane-name">{port.name}</h3>
      <p class="pane-desc" data-testid="pane-desc">{port.desc ?? port.explain}</p>
      {#if port.paramTarget}
        <!-- CV → PARAM DUAL CONTEXT: the jack modulates a faceplate control. -->
        <div class="pane-dual" data-testid="pane-dual">
          <div class="dual-head">
            modulates <strong>{port.paramTarget.name}</strong>
          </div>
          {#if port.paramTarget.desc}
            <p class="dual-desc">{port.paramTarget.desc}</p>
          {/if}
        </div>
      {/if}
      <div class="pane-explain" data-testid="pane-explain">{port.explain}</div>
    </div>
  {:else}
    <!-- DEFAULT / EMPTY STATE: the module's behavioral overview. This is what
         the PRERENDERED (no-JS) HTML carries — readable without the live card. -->
    <div class="pane-card pane-default" data-pane-kind="default">
      <div class="pane-eyebrow">about this module</div>
      <p class="pane-desc pane-explanation" data-testid="pane-default-explanation">
        {docIndex.explanation ?? 'Hover a control or open the patch panel and hover a jack to see what it does.'}
      </p>
      <div class="pane-hint">Hover a control, or open the patch panel and hover a jack.</div>
    </div>
  {/if}
</aside>

<style>
  .doc-hover-pane {
    position: sticky;
    top: 1rem;
    align-self: start;
  }
  .pane-card {
    border: 1px solid var(--doc-border-dim, #062b32);
    border-left-width: 4px;
    border-left-color: var(--doc-accent, #2bb6c8);
    border-radius: 6px;
    padding: 0.9rem 1rem 1rem;
    background: color-mix(in srgb, var(--doc-accent, #2bb6c8) 5%, transparent);
    min-height: 8rem;
  }
  .pane-eyebrow {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--doc-fg-dim, #6e7a82);
    margin-bottom: 0.25rem;
  }
  .pane-name {
    margin: 0 0 0.35rem;
    font-size: 1.15rem;
    line-height: 1.2;
  }
  .pane-meta {
    font-size: 0.78rem;
    color: var(--doc-fg-dim, #6e7a82);
    margin-bottom: 0.5rem;
  }
  .pane-meta code,
  .pane-eyebrow .cable {
    font-variant-numeric: tabular-nums;
  }
  .pane-desc {
    margin: 0;
    line-height: 1.55;
  }
  .pane-explanation {
    font-size: 1.0em;
  }
  .pane-dual {
    margin-top: 0.85rem;
    padding: 0.6rem 0.7rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--doc-accent, #2bb6c8) 9%, transparent);
    border: 1px dashed var(--doc-accent, #2bb6c8);
  }
  .dual-head {
    font-size: 0.8rem;
    color: var(--doc-fg-dim, #6e7a82);
    margin-bottom: 0.25rem;
  }
  .dual-head strong {
    color: var(--doc-accent, #2bb6c8);
  }
  .dual-desc {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.5;
  }
  .pane-explain {
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--doc-border-dim, #062b32);
    font-size: 0.78rem;
    color: var(--doc-fg-dim, #6e7a82);
  }
  .pane-hint {
    margin-top: 0.75rem;
    font-size: 0.74rem;
    color: var(--doc-fg-dim, #6e7a82);
    opacity: 0.8;
  }
  .cable-cv { color: var(--cable-cv, #b18cff); }
  .cable-gate { color: var(--cable-gate, #ff9f43); }
  .cable-audio { color: var(--cable-audio, #2bb6c8); }
</style>
