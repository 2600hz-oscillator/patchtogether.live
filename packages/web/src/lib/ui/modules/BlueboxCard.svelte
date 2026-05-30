<script lang="ts">
  // BlueboxCard — DTMF dialer with phreaker buttons.
  //
  // 12-key keypad in standard phone layout:
  //   1 2 3
  //   4 5 6
  //   7 8 9
  //     0
  //   BLUEBOX  REDBOX
  //
  // Each button is a press-and-hold: pointerdown writes 1.0 to the
  // matching btn_* param + setParam-pushes it to the engine for
  // low-latency tone-on; pointerup writes 0 and tones-off. Patch a gate
  // cable into a button's `gate_<name>` input port to drive it
  // externally — the worklet ORs the two sources, so either path can
  // hold the button "down".
  //
  // No envelope / no AD on the button: the worklet ramps over ~1 ms at
  // the edge to kill the click, but otherwise the tones are bare
  // on-off sines.

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch } from '$lib/graph/store';
  import {
    blueboxDef,
    BLUEBOX_BUTTON_NAMES,
    BLUEBOX_DIGIT_LETTERS,
    buttonGateId,
    buttonParamId,
    type BlueboxButtonName,
  } from '$lib/audio/modules/bluebox';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  /**
   * Press a button — write 1.0 to the param store entry (so other peers
   * + the store see the held state) AND push directly to the engine for
   * immediate audio response (the store→engine reconciler would otherwise
   * add a frame or two of latency).
   */
  function pressBtn(name: BlueboxButtonName) {
    const pid = buttonParamId(name);
    const t = patch.nodes[id];
    if (t) t.params[pid] = 1;
    const e = engineCtx.get();
    if (e && node) e.setParam(node, pid, 1);
  }

  function releaseBtn(name: BlueboxButtonName) {
    const pid = buttonParamId(name);
    const t = patch.nodes[id];
    if (t) t.params[pid] = 0;
    const e = engineCtx.get();
    if (e && node) e.setParam(node, pid, 0);
  }

  // Pointer handlers — pointerdown + pointerup; we also release on
  // pointerleave so the user dragging off the button releases cleanly,
  // and on the `pointercancel` event so a system gesture (e.g. iOS
  // overscroll) doesn't leave a tone stuck on.
  function onDown(name: BlueboxButtonName) {
    return (ev: PointerEvent) => {
      // Capture the pointer so we still receive pointerup even if the
      // user drags off the button before releasing — otherwise a
      // dragged release leaves the tone on indefinitely.
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      pressBtn(name);
    };
  }
  function onUp(name: BlueboxButtonName) {
    return (ev: PointerEvent) => {
      try {
        (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch { /* no-op if not captured */ }
      releaseBtn(name);
    };
  }
  function onCancel(name: BlueboxButtonName) {
    return () => releaseBtn(name);
  }

  /** Whether a given button is currently "held" per the live param
   *  value — drives the visual pressed state. */
  function isHeld(name: BlueboxButtonName): boolean {
    return (node?.params?.[buttonParamId(name)] ?? 0) >= 0.5;
  }

  // Inputs: 12 gate ports, in BLUEBOX_BUTTON_NAMES order.
  const inputs: PortDescriptor[] = BLUEBOX_BUTTON_NAMES.map((name) => ({
    id: buttonGateId(name),
    cable: 'gate' as const,
  }));
  const outputs: PortDescriptor[] = [{ id: 'out', cable: 'audio' as const }];

  // The 4-row × 3-col digit grid is laid out as the standard phone
  // keypad — row 1: 1 2 3 / row 2: 4 5 6 / row 3: 7 8 9 / row 4: _ 0 _.
  // We render row 4 with a centered single "0" key (no * / # — the
  // spec asked for digits 0-9 only).
  const DIGIT_ROWS: BlueboxButtonName[][] = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
  ];
</script>

<div class="mod-card bluebox-card" data-testid="bluebox-card">
  <div class="stripe" style="background: var(--cable-audio);"></div>
  <ModuleTitle {id} {data} defaultLabel="BLUEBOX" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="keypad">
      {#each DIGIT_ROWS as row}
        <div class="row">
          {#each row as digit}
            <button
              type="button"
              class="key digit"
              class:held={isHeld(digit)}
              data-testid={`bluebox-key-${digit}`}
              onpointerdown={onDown(digit)}
              onpointerup={onUp(digit)}
              onpointerleave={onUp(digit)}
              onpointercancel={onCancel(digit)}
            >
              <span class="digit-num">{digit}</span>
              <span class="digit-letters" data-testid={`bluebox-letters-${digit}`}>{BLUEBOX_DIGIT_LETTERS[digit] ?? ''}</span>
            </button>
          {/each}
        </div>
      {/each}
      <div class="row zero-row">
        <span class="key-spacer"></span>
        <button
          type="button"
          class="key digit"
          class:held={isHeld('0')}
          data-testid="bluebox-key-0"
          onpointerdown={onDown('0')}
          onpointerup={onUp('0')}
          onpointerleave={onUp('0')}
          onpointercancel={onCancel('0')}
        >
          <span class="digit-num">0</span>
          <span class="digit-letters" data-testid="bluebox-letters-0">{BLUEBOX_DIGIT_LETTERS['0'] ?? ''}</span>
        </button>
        <span class="key-spacer"></span>
      </div>
      <div class="row phreaker-row">
        <button
          type="button"
          class="key phreaker bluebox"
          class:held={isHeld('bluebox')}
          data-testid="bluebox-key-bluebox"
          onpointerdown={onDown('bluebox')}
          onpointerup={onUp('bluebox')}
          onpointerleave={onUp('bluebox')}
          onpointercancel={onCancel('bluebox')}
        >BLUEBOX</button>
        <button
          type="button"
          class="key phreaker redbox"
          class:held={isHeld('redbox')}
          data-testid="bluebox-key-redbox"
          onpointerdown={onDown('redbox')}
          onpointerup={onUp('redbox')}
          onpointerleave={onUp('redbox')}
          onpointercancel={onCancel('redbox')}
        >REDBOX</button>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  /* The card hosts: 12 gate handles down the left (one per button),
     one audio out on the right, and the 4-row keypad + 1-row phreaker
     strip in the body. Sized wide enough that a 3-column digit row +
     two BLUEBOX/REDBOX side-by-side phreaker keys both fit without
     wrapping. */
  .bluebox-card {
    width: 280px;
    min-height: 360px;
  }
  .keypad {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 12px;
  }
  .keypad .row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
  }
  .keypad .row.phreaker-row {
    grid-template-columns: 1fr 1fr;
    margin-top: 4px;
  }
  .keypad .row.zero-row {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .keypad .row.zero-row .key-spacer {
    visibility: hidden;
  }
  .key {
    appearance: none;
    background: var(--bg-elev, #2a2a2a);
    color: var(--text, #ddd);
    border: 1px solid var(--border, #444);
    border-radius: 4px;
    padding: 8px 0 6px;
    font-family: var(--font-display, inherit);
    font-size: 1.1rem;
    letter-spacing: 0.04em;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none; /* keep pointerdown gestures from being eaten by scroll */
    transition: background 30ms ease, transform 30ms ease;
  }
  /* Digit buttons stack a large number over a small phone-letters strip
     (ABC under "2", DEF under "3", …). 1 + 0 keep an empty letters span
     so every key has the same height + the row grid stays aligned. */
  .key.digit {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    line-height: 1;
  }
  .key.digit .digit-num {
    font-size: 1.25rem;
    font-weight: 600;
  }
  .key.digit .digit-letters {
    font-size: 0.6rem;
    letter-spacing: 0.18em;
    opacity: 0.7;
    /* Reserve the line-height even when empty (1, 0) so digit keys all
       share a single height regardless of letter content. */
    min-height: 0.7rem;
  }
  .key.digit.held .digit-letters {
    opacity: 0.85;
  }
  .key:hover {
    background: var(--bg-elev-hover, #333);
  }
  .key:active,
  .key.held {
    background: var(--cable-audio, #88f);
    color: #111;
    transform: translateY(1px);
  }
  .key.phreaker {
    font-size: 0.78rem;
    padding: 14px 0;
    letter-spacing: 0.12em;
  }
  .key.phreaker.bluebox {
    border-color: #5b8df0;
  }
  .key.phreaker.redbox {
    border-color: #f06060;
  }
</style>
