<script lang="ts">
  // ToyboxKeyerConfig — the "Configure keyer" popover for a LUMAKEY / CHROMAKEY
  // combine node (opened from ToyboxNodeMenu's "Configure keyer…" action).
  //
  //   LUMAKEY:   THRESHOLD + SHARPNESS knobs.
  //   CHROMAKEY: THRESHOLD + SHARPNESS knobs + a COLOR PICKER for the key colour
  //              (keyR/keyG/keyB, 0..1 floats; green-screen default).
  //
  // The two knobs are the node's existing `amount` (THRESHOLD) + `soft`
  // (SHARPNESS) params — this is purely a new UI surface over them, relabelled.
  // Every edit writes a single combine-node param IN PLACE via the Yjs mutator
  // (setCombineNodeParam → ydoc.transact(LOCAL_ORIGIN)); never spread-reassign.
  //
  // Clones ToyboxNodeMenu's portal-to-<body> + fixed-div + Esc + viewport-clamp
  // pattern (a transformed svelte-flow ancestor would otherwise mis-place a
  // position:fixed popover and let the bottombar intercept its lower controls).

  import Knob from '$lib/ui/controls/Knob.svelte';
  import {
    OP_PARAMS,
    type ToyboxGraphNode,
    type ToyboxOpKind,
  } from '$lib/video/toybox-combine-graph';

  interface Props {
    open: boolean;
    /** Screen-space anchor (where the menu item was clicked). */
    x: number;
    y: number;
    /** The live keyer node (its `kind` + `params` drive the controls). */
    node: ToyboxGraphNode | undefined;
    /** The keyer's unique display name ("CHROMA 1") for the header. */
    displayName: string;
    /** Set a single float param on the node in place (Yjs LOCAL_ORIGIN). */
    onparam: (paramId: string, value: number) => void;
    /** MIDI-learn host id for the knobs (the TOYBOX module id). */
    moduleId: string;
    onclose: () => void;
  }

  let {
    open = $bindable(false),
    x,
    y,
    node,
    displayName,
    onparam,
    moduleId,
    onclose,
  }: Props = $props();

  let isChroma = $derived(node?.kind === 'chromakey');
  // INVERT is a LUMAKEY-only control: the combine shader flips the keep-test
  // (keep BELOW the threshold instead of above) only for the lumakey op. The
  // `invert` param + shader already exist; this surfaces the toggle in the
  // popover the way the standalone LUMAKEY module exposes its `invert` knob.
  let isLumakey = $derived(node?.kind === 'lumakey');
  let invertOn = $derived(paramVal('invert') > 0.5);
  function toggleInvert(): void {
    onparam('invert', invertOn ? 0 : 1);
  }

  /** Read a live param value off the node, falling back to the schema default. */
  function paramVal(id: string): number {
    const v = node?.params?.[id];
    if (typeof v === 'number') return v;
    const def = node ? OP_PARAMS[node.kind as ToyboxOpKind]?.find((p) => p.id === id) : undefined;
    return def?.default ?? 0;
  }

  // ── COLOR PICKER (chromakey) ── the key colour lives as keyR/keyG/keyB floats
  // (0..1). <input type=color> works in #rrggbb hex, so we convert both ways.
  function clamp01(n: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  }
  function toHex2(n: number): string {
    return Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
  }
  let keyHex = $derived(`#${toHex2(paramVal('keyR'))}${toHex2(paramVal('keyG'))}${toHex2(paramVal('keyB'))}`);

  function onColorInput(ev: Event): void {
    const hex = (ev.target as HTMLInputElement).value; // "#rrggbb"
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    onparam('keyR', clamp01(r));
    onparam('keyG', clamp01(g));
    onparam('keyB', clamp01(b));
  }

  function setThreshold(v: number): void {
    onparam('amount', v);
  }
  function setSharpness(v: number): void {
    onparam('soft', v);
  }

  // Threshold/sharpness schema (range/default) read from OP_PARAMS so the knobs
  // match the side-strip + CV math.
  function def(id: string): { min: number; max: number; default: number } {
    const d = node ? OP_PARAMS[node.kind as ToyboxOpKind]?.find((p) => p.id === id) : undefined;
    return { min: d?.min ?? 0, max: d?.max ?? 1, default: d?.default ?? 0 };
  }
  let thrDef = $derived(def('amount'));
  let sftDef = $derived(def('soft'));

  // Window-level Escape → dismiss (popovers don't take focus; mirror the menu).
  $effect(() => {
    if (!open) return;
    const onWindowKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    window.addEventListener('keydown', onWindowKeydown);
    return () => window.removeEventListener('keydown', onWindowKeydown);
  });

  // Viewport-clamped position (same trick as ToyboxNodeMenu): seed at the anchor,
  // then measure + clamp so the popover never overflows / hides under the footer.
  let popEl = $state<HTMLDivElement | null>(null);
  let posX = $state(0);
  let posY = $state(0);
  $effect(() => {
    if (!open) return;
    void x; void y; void isChroma;
    posX = x;
    posY = y;
    const el = popEl;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const margin = 6;
      const maxX = window.innerWidth - rect.width - margin;
      const maxY = window.innerHeight - rect.height - margin;
      posX = Math.max(margin, Math.min(x, maxX));
      posY = Math.max(margin, Math.min(y, maxY));
    };
    clamp();
    const raf = requestAnimationFrame(clamp);
    return () => cancelAnimationFrame(raf);
  });

  // Portal to <body> (escape the transformed svelte-flow ancestor — see
  // ToyboxNodeMenu.portal for the full rationale).
  function portal(el: HTMLElement) {
    document.body.appendChild(el);
    return { destroy() { el.remove(); } };
  }
</script>

{#if open && node}
  <div use:portal>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="ctx-overlay"
    onclick={onclose}
    oncontextmenu={(e) => { e.preventDefault(); onclose(); }}
    role="presentation"
  ></div>
  <div
    bind:this={popEl}
    class="keyer-pop"
    style:left="{posX}px"
    style:top="{posY}px"
    role="dialog"
    aria-label="Configure keyer"
    data-testid="toybox-keyer-config"
    data-kind={node.kind}
  >
    <div class="keyer-header">{displayName} · keyer</div>

    <div class="keyer-knobs">
      <div class="keyer-knob" data-testid="toybox-keyer-threshold">
        <Knob
          value={paramVal('amount')}
          min={thrDef.min}
          max={thrDef.max}
          defaultValue={thrDef.default}
          label="THRESHOLD"
          curve="linear"
          onchange={setThreshold}
          {moduleId}
          paramId={`combine:${node.id}:amount`}
        />
      </div>
      <div class="keyer-knob" data-testid="toybox-keyer-sharpness">
        <Knob
          value={paramVal('soft')}
          min={sftDef.min}
          max={sftDef.max}
          defaultValue={sftDef.default}
          label="SHARPNESS"
          curve="linear"
          onchange={setSharpness}
          {moduleId}
          paramId={`combine:${node.id}:soft`}
        />
      </div>
    </div>

    {#if isChroma}
      <div class="keyer-color">
        <span class="keyer-color-label">KEY COLOR</span>
        <input
          type="color"
          class="keyer-color-input"
          data-testid="toybox-keyer-color"
          value={keyHex}
          oninput={onColorInput}
          aria-label="key colour"
        />
        <span class="keyer-color-hex" data-testid="toybox-keyer-color-hex">{keyHex}</span>
      </div>
    {/if}

    {#if isLumakey}
      <!-- INVERT (lumakey only): flips the keep-test so the keyer keeps where
           luma is BELOW the threshold instead of above — same as the standalone
           LUMAKEY module's `invert`. Writes the node's `invert` combine param
           in place (CV/MIDI-addressable like the other combine params). -->
      <div class="keyer-invert">
        <span class="keyer-color-label">INVERT</span>
        <button
          type="button"
          role="switch"
          aria-checked={invertOn}
          class="keyer-toggle"
          class:on={invertOn}
          data-testid="toybox-keyer-invert"
          onclick={toggleInvert}
        >{invertOn ? 'ON' : 'OFF'}</button>
      </div>
    {/if}

    <button
      type="button"
      class="keyer-done"
      data-testid="toybox-keyer-done"
      onclick={onclose}
    >Done</button>
  </div>
  </div>
{/if}

<style>
  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
  }
  .keyer-pop {
    position: fixed;
    z-index: 201;
    min-width: 180px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 8px 10px 10px;
    font-size: 0.85rem;
  }
  .keyer-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding-bottom: 8px;
  }
  .keyer-knobs {
    display: flex;
    gap: 14px;
    justify-content: center;
  }
  .keyer-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .keyer-color {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .keyer-color-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  .keyer-color-input {
    width: 34px;
    height: 24px;
    padding: 0;
    border: 1px solid #404652;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }
  .keyer-color-hex {
    font-family: monospace;
    font-size: 0.7rem;
    color: var(--text);
  }
  .keyer-invert {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .keyer-toggle {
    min-width: 44px;
    padding: 3px 10px;
    border: 1px solid #404652;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-dim);
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    cursor: pointer;
  }
  .keyer-toggle.on {
    background: rgba(96, 165, 250, 0.22);
    border-color: rgba(96, 165, 250, 0.6);
    color: var(--text);
  }
  .keyer-toggle:hover,
  .keyer-toggle:focus-visible {
    border-color: rgba(96, 165, 250, 0.6);
    outline: none;
  }
  .keyer-done {
    display: block;
    width: 100%;
    margin-top: 10px;
    padding: 5px 0;
    background: rgba(96, 165, 250, 0.12);
    border: 1px solid #404652;
    border-radius: 4px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .keyer-done:hover,
  .keyer-done:focus-visible {
    background: rgba(96, 165, 250, 0.22);
    outline: none;
  }
</style>
