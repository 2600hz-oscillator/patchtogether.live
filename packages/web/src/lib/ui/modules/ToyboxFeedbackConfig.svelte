<script lang="ts">
  // ToyboxFeedbackConfig — the "Configure feedback" popover for a FEEDBACK
  // combine node (opened from ToyboxNodeMenu's "Configure feedback…" action).
  //
  // Mirrors ToyboxKeyerConfig exactly (portal-to-<body> + fixed-div + Esc +
  // viewport-clamp) so the feedback node is configurable the SAME way the keyer
  // nodes are — discoverable from the right-click menu, not only by selecting
  // the node in the graph.
  //
  //   MODE  — a 12-entry <select> (FEEDBACK_MODES); writes the discrete `mode`.
  //   KNOBS — only the params RELEVANT to the active mode (feedbackParamsForMode)
  //           so the popover stays focused; every knob is MIDI-learnable +
  //           CONTROLSURFACE-syncable via the `combine:<nodeId>:<param>` paramId
  //           convention (same as the per-node knob strip + the keyer popover).
  //
  // Every edit writes a single combine-node param IN PLACE via the Yjs mutator
  // (setCombineNodeParam → ydoc.transact(LOCAL_ORIGIN)); never spread-reassign.

  import Knob from '$lib/ui/controls/Knob.svelte';
  import { OP_PARAMS, type ToyboxGraphNode } from '$lib/video/toybox-combine-graph';
  import {
    FEEDBACK_MODES,
    clampFeedbackMode,
    feedbackParamsForMode,
  } from '$lib/video/toybox-feedback';

  interface Props {
    open: boolean;
    /** Screen-space anchor (where the menu item was clicked). */
    x: number;
    y: number;
    /** The live feedback node (its `params` drive the controls). */
    node: ToyboxGraphNode | undefined;
    /** The node's unique display name ("FBK 1") for the header. */
    displayName: string;
    /** Set the discrete feedback mode (0..11). */
    onmode: (mode: number) => void;
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
    onmode,
    onparam,
    moduleId,
    onclose,
  }: Props = $props();

  let mode = $derived(clampFeedbackMode(node?.params?.mode));
  let knobParams = $derived(
    feedbackParamsForMode(mode)
      .map((pid) => OP_PARAMS.feedback.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p),
  );

  /** Read a live param value off the node, falling back to the schema default. */
  function paramVal(id: string): number {
    const v = node?.params?.[id];
    if (typeof v === 'number') return v;
    return OP_PARAMS.feedback.find((p) => p.id === id)?.default ?? 0;
  }

  // Window-level Escape → dismiss (mirror the keyer popover / node menu).
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

  // Viewport-clamped position (same trick as ToyboxKeyerConfig).
  let popEl = $state<HTMLDivElement | null>(null);
  let posX = $state(0);
  let posY = $state(0);
  $effect(() => {
    if (!open) return;
    void x; void y; void mode;
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
    class="fb-pop"
    style:left="{posX}px"
    style:top="{posY}px"
    role="dialog"
    aria-label="Configure feedback"
    data-testid="toybox-feedback-config"
  >
    <div class="fb-header">{displayName} · feedback</div>

    <label class="fb-mode-row" data-testid="toybox-feedback-config-mode">
      <span class="fb-mode-label">MODE</span>
      <select
        class="fb-mode-select"
        data-testid="toybox-feedback-config-mode-select"
        value={mode}
        onchange={(e) => onmode(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {#each FEEDBACK_MODES as m (m.id)}
          <option value={m.id}>{m.id}. {m.label}</option>
        {/each}
      </select>
    </label>

    <div class="fb-knobs">
      {#each knobParams as p (p.id)}
        <div class="fb-knob" data-testid={`toybox-feedback-knob-${p.id}`}>
          <Knob
            value={paramVal(p.id)}
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
      {/each}
    </div>

    <button
      type="button"
      class="fb-done"
      data-testid="toybox-feedback-config-done"
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
  .fb-pop {
    position: fixed;
    z-index: 201;
    min-width: 200px;
    max-width: 280px;
    background: var(--module-bg);
    border: 1px solid #404652;
    border-radius: 6px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    padding: 8px 10px 10px;
    font-size: 0.85rem;
  }
  .fb-header {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    padding-bottom: 8px;
  }
  .fb-mode-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .fb-mode-label {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  .fb-mode-select {
    flex: 1;
    background: var(--control-bg, #1b1f27);
    color: var(--text);
    border: 1px solid #404652;
    border-radius: 4px;
    padding: 3px 6px;
    font-family: inherit;
    font-size: 0.78rem;
  }
  .fb-knobs {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: center;
  }
  .fb-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .fb-done {
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
  .fb-done:hover,
  .fb-done:focus-visible {
    background: rgba(96, 165, 250, 0.22);
    outline: none;
  }
</style>
