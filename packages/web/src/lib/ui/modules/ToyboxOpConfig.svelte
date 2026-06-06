<script lang="ts">
  // ToyboxOpConfig — the generic "Configure" popover for ANY combine op node that
  // isn't a keyer or feedback (the 12 batch ops: over/tile/mirror/displace/
  // bitbend/biocells/exquisite/framedelay/channeldesync/flowsmear/dreammelt/
  // datamosh, plus the legacy fade/map). Mirrors ToyboxFeedbackConfig exactly
  // (portal-to-<body> + fixed-div + Esc + viewport-clamp) so every op is
  // configurable the SAME way the keyer + feedback nodes are — discoverable from
  // the right-click "Configure…" action, not only by selecting the node.
  //
  //   Each OP_PARAMS entry renders as a Knob (continuous) OR a <select>
  //   (DISCRETE enum params with an `options` list — e.g. mirror.mode,
  //   bitbend.op — so the user lands cleanly on "OR" instead of nudging a knob).
  //   Every control is MIDI-learnable + CONTROLSURFACE-syncable via the
  //   `combine:<nodeId>:<param>` paramId convention (identical to the side strip
  //   + the keyer/feedback popovers), so right-click → MIDI-map + → Send to
  //   control surface work for all 12 ops (audit #82 follow-up).
  //
  // Every edit writes a single combine-node param IN PLACE via the Yjs mutator
  // (onparam → setCombineNodeParam → ydoc.transact(LOCAL_ORIGIN)); never spread-
  // reassign.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { OP_PARAMS, type ToyboxGraphNode, type ToyboxOpKind } from '$lib/video/toybox-combine-graph';

  interface Props {
    open: boolean;
    /** Screen-space anchor (where the menu item was clicked). */
    x: number;
    y: number;
    /** The live op node (its `params` drive the controls). A fresh snapshot is
     *  passed by the card so swapping an enum re-renders (the #60 stale-derived
     *  gotcha). */
    node: ToyboxGraphNode | undefined;
    /** The node's unique display name ("MOSH 1") for the header. */
    displayName: string;
    /** Set a single float param on the node in place (Yjs LOCAL_ORIGIN). */
    onparam: (paramId: string, value: number) => void;
    /** MIDI-learn / CONTROLSURFACE host id (the TOYBOX module id). */
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

  let params = $derived(node && node.kind !== 'source' && node.kind !== 'output'
    ? OP_PARAMS[node.kind as ToyboxOpKind] ?? []
    : []);

  /** Read a live param value off the node, falling back to the schema default. */
  function paramVal(id: string, def: number): number {
    const v = node?.params?.[id];
    return typeof v === 'number' ? v : def;
  }

  // Window-level Escape → dismiss (mirror the feedback / keyer popover).
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

  // Viewport-clamped position (same trick as ToyboxFeedbackConfig).
  let popEl = $state<HTMLDivElement | null>(null);
  let posX = $state(0);
  let posY = $state(0);
  $effect(() => {
    if (!open) return;
    void x; void y; void params;
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

  // Portal to <body> (escape the transformed svelte-flow ancestor).
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
    class="op-pop"
    style:left="{posX}px"
    style:top="{posY}px"
    role="dialog"
    aria-label="Configure op"
    data-testid="toybox-op-config"
  >
    <div class="op-header">{displayName} · {node.kind}</div>

    <div class="op-knobs">
      {#each params as p (p.id)}
        {#if p.options}
          <!-- DISCRETE enum param → a <select> (a knob can't land on "OR"). -->
          <label class="op-enum-row" data-testid={`toybox-op-config-enum-${p.id}`}>
            <span class="op-enum-label">{p.label}</span>
            <select
              class="op-enum-select"
              data-testid={`toybox-op-config-select-${p.id}`}
              value={Math.round(paramVal(p.id, p.default))}
              onchange={(e) => onparam(p.id, Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {#each p.options as label, i (label)}
                <option value={i}>{i}. {label}</option>
              {/each}
            </select>
          </label>
        {:else}
          <div class="op-knob" data-testid={`toybox-op-config-knob-${p.id}`}>
            <Knob
              value={paramVal(p.id, p.default)}
              min={p.min}
              max={p.max}
              defaultValue={p.default}
              label={p.label}
              curve="linear"
              onchange={(v) => onparam(p.id, v)}
              {moduleId}
              paramId={`combine:${node.id}:${p.id}`}
            />
          </div>
        {/if}
      {/each}
    </div>

    <button
      type="button"
      class="op-done"
      data-testid="toybox-op-config-done"
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
  .op-pop {
    position: fixed;
    z-index: 201;
    min-width: 200px;
    max-width: 300px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 8px 10px 10px;
    font-size: 0.85rem;
  }
  .op-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding-bottom: 8px;
  }
  .op-knobs {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: center;
    align-items: flex-end;
  }
  .op-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .op-enum-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 100%;
  }
  .op-enum-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  .op-enum-select {
    background: var(--control-bg, #1b1f27);
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 0.78rem;
  }
  .op-done {
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
  .op-done:hover,
  .op-done:focus-visible {
    background: rgba(96, 165, 250, 0.22);
    outline: none;
  }
</style>
