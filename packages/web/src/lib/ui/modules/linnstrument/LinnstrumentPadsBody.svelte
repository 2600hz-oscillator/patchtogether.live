<script lang="ts">
  // THE THREE JOYSTICK PADS, at the head of the dock full view — the
  // LinnStrument's R / G / B pairs as three DOM pads, plus the LINK lamp and
  // one lamp per musical region.
  //
  // ── WHAT IT IS ────────────────────────────────────────────────────────────
  //
  // Each pad is `JoystickPadBody.svelte`'s pad, once per selector: jump-to-
  // point on pointerdown, pointer capture, the Y flip (drag UP = +y),
  // `lostpointercapture` recovery, double-click re-centre, no snap-back
  // (#1963 "1 - persist"). The one difference is WHERE a drag goes: not to a
  // param write of its own but to `linnstrumentSetPair`, which dispatches a
  // `set_pair` intent into the runtime's reducer — the SAME reducer the
  // hardware finger, the ranked cells and patch hydration feed — so the dot,
  // the CV jack and the device's LEDs read one state. The pad's border burns
  // while its selector is on, which is the selection shown as a colour mark
  // rather than a second toggle over the ranked `sel_*` cell.
  //
  // ── ⚠ THIS BODY IS NOT A CELL (the joystick shape) ────────────────────────
  //
  // `pos_*` rank as ordinary knob cells; at the dock they render in the bands
  // BELOW this body and are the parity-credited controls. These pads are the
  // module's own ADDITIONAL surface, so they emit NO `data-control-params`,
  // NO `control-*` anchor and NO `data-cell-*` attribute. Pinned in
  // `linnstrument-face-model.test.ts`.
  //
  // ── ⚠ NO RESTING TEXT ─────────────────────────────────────────────────────
  //
  // No values, no state words, no sentences: the live pair and whether the
  // pad is selected are each pad's `aria-label` (role="application" has no
  // aria-valuetext), the link and voice facts are `StatusLed.detail`, and the
  // only painted text is a caption (R / G / B, LINK / KEYS / PAD, the target
  // pickers' option names). The device ROSTER cannot be a cell (midi-lane.ts
  // 525-529: it lives behind requestMIDIAccess and differs per machine) — and
  // here the bound source is the ONE app-wide LinnStrument source, so the LINK
  // lamp names it; there is no per-node roster to pick from.
  //
  // ⚠ NO CANVAS: DOM only, so the body stays out of the WebGL attest basis and
  // the `control-grid` body role holds. NO SCREEN SWITCH and NO WATCH MARK:
  // domain audio; `markWatched` is a VideoEngine concept.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import { SELECTORS, type SelectorId } from '$lib/midi/linnstrument/types';
  import { positionParamId, selectorParamId } from '$lib/audio/modules/linnstrument-runtime';
  import type { LinnstrumentSnapshot } from '$lib/audio/modules/linnstrument';
  import {
    linnstrumentApi,
    linnstrumentFlush,
    linnstrumentSetPair,
    linnstrumentSetTarget,
    linnstrumentTargets,
  } from '../linnstrument-cell-actions';

  let { nodeId }: { nodeId: string } = $props();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>((void cardV, patch.nodes[nodeId] as ModuleNode | undefined));

  // The runtime's change notifications, mirrored into rune state.
  let rev = $state(0);
  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    void node;
    const api = linnstrumentApi(nodeId);
    if (!api) return;
    unsubscribe?.();
    unsubscribe = api.subscribe(() => {
      rev++;
    });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => {
    unsubscribe?.();
  });

  let snap = $derived<LinnstrumentSnapshot | null>((void rev, void cardV, linnstrumentApi(nodeId)?.state() ?? null));

  const clamp = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);
  function paramNum(id: string, fallback: number): number {
    const v = node?.params?.[id];
    return typeof v === 'number' ? v : fallback;
  }
  /** The pair a pad shows: the runtime's state when it is up, else the params. */
  function pairOf(s: SelectorId): { x: number; y: number } {
    if (snap) return snap.selection.pairs[s];
    return { x: clamp(paramNum(positionParamId(s, 'x'), 0)), y: clamp(paramNum(positionParamId(s, 'y'), 0)) };
  }
  function selectedOf(s: SelectorId): boolean {
    if (snap) return snap.selection.mask[s];
    return paramNum(selectorParamId(s), s === 'r' ? 1 : 0) >= 0.5;
  }

  // ── Pads ──
  let padEls: Record<SelectorId, HTMLDivElement | null> = { r: null, g: null, b: null };
  let dragging = $state<SelectorId | null>(null);

  function writeFromPointer(s: SelectorId, ev: PointerEvent): void {
    const el = padEls[s];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    linnstrumentSetPair(nodeId, s, clamp(px * 2 - 1), clamp(-(py * 2 - 1)));
  }
  function onPointerDown(s: SelectorId, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    dragging = s;
    padEls[s]?.setPointerCapture(ev.pointerId);
    writeFromPointer(s, ev);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onPointerMove(s: SelectorId, ev: PointerEvent): void {
    if (dragging !== s) return;
    writeFromPointer(s, ev);
  }
  function onPointerUp(s: SelectorId, ev: PointerEvent): void {
    if (dragging !== s) return;
    dragging = null;
    // Gesture end: the final value lands durably (the write-storm rule's
    // "final value on gesture end"). No snap-back.
    linnstrumentFlush(nodeId);
    try {
      padEls[s]?.releasePointerCapture(ev.pointerId);
    } catch {
      /* */
    }
  }
  function onLostCapture(s: SelectorId): void {
    if (dragging !== s) return;
    dragging = null;
    linnstrumentFlush(nodeId);
  }
  function onDblClick(s: SelectorId): void {
    linnstrumentSetPair(nodeId, s, 0, 0);
    linnstrumentFlush(nodeId);
  }

  const fmt = (v: number): string => v.toFixed(2);
  function padLabel(s: SelectorId): string {
    const p = pairOf(s);
    return `${s.toUpperCase()} pad: X ${fmt(p.x)}, Y ${fmt(p.y)}, ${selectedOf(s) ? 'following the pad finger' : 'holding'}`;
  }
  function dotLeft(s: SelectorId): number {
    return ((pairOf(s).x + 1) / 2) * 100;
  }
  function dotTop(s: SelectorId): number {
    return ((-pairOf(s).y + 1) / 2) * 100;
  }

  // ── Lamps ──
  let linkLit = $derived(!!snap && snap.session.state !== 'disconnected');
  let linkDetail = $derived.by(() => {
    if (!snap) return 'engine not up yet';
    if (snap.session.state === 'disconnected') return 'no LinnStrument bound — CONNECT grants Web MIDI and binds the port named like a LinnStrument (in the native shell: the one picked on rig setup)';
    const src = snap.source ? `${snap.source.id} (${snap.source.kind})` : 'unnamed source';
    // `userMode` is the instrument's OWN readback (NRPN 245), never our write.
    return `${src}, ${snap.session.userMode ? 'user firmware mode confirmed by the instrument' : 'user firmware mode requested, not yet confirmed by the instrument'}, session ${snap.session.epoch}`;
  });
  function regionDetail(region: 'keys' | 'pad'): string {
    if (!snap) return 'engine not up yet';
    const n = snap.active[region];
    const a = snap.arp[region];
    const arp = a.enabled ? `arp ${a.params.direction}${a.running ? `, playing ${a.playing ?? '—'}` : ', waiting for a note'}${a.params.latch ? ', hold' : ''}` : 'arp off';
    return `${n} voice${n === 1 ? '' : 's'} held, ${arp}, ${snap.counters.rejected} rejected, ${snap.counters.steals} stolen`;
  }
  let keysLit = $derived(!!snap && (snap.active.keys > 0 || snap.arp.keys.running));
  let padLit = $derived(!!snap && (snap.active.pad > 0 || snap.arp.pad.running));

  // ── D15 targets (RECOMMENDATION, opt-in, default unbound) ──
  let targets = $derived(linnstrumentTargets(node));
  let joysticks = $derived.by(() => {
    void cardV;
    const out: { id: string; label: string }[] = [];
    for (const [id, n] of Object.entries(patch.nodes)) {
      if ((n as { type?: string } | undefined)?.type === 'joystick') out.push({ id, label: `joystick ${id.slice(0, 4)}` });
    }
    return out;
  });
  function onChangeTarget(s: SelectorId, ev: Event): void {
    const v = (ev.currentTarget as HTMLSelectElement).value || null;
    linnstrumentSetTarget(nodeId, s, v);
  }
</script>

<div class="linn-body" data-testid="linnstrument-face-body-{nodeId}" data-node-id={nodeId}>
  <div class="pads">
    {#each SELECTORS as s (s)}
      <div class="pad-col" data-selector={s}>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
             — role="application" is the role for a 2-D manipulation surface that OWNS its pointer handling. -->
        <div
          class="pad nodrag {s}"
          class:selected={selectedOf(s)}
          bind:this={padEls[s]}
          role="application"
          tabindex="-1"
          aria-label={padLabel(s)}
          data-testid="linnstrument-face-pad-{s}"
          data-selected={selectedOf(s) ? '1' : '0'}
          onpointerdown={(ev) => onPointerDown(s, ev)}
          onpointermove={(ev) => onPointerMove(s, ev)}
          onpointerup={(ev) => onPointerUp(s, ev)}
          onlostpointercapture={() => onLostCapture(s)}
          onpointercancel={(ev) => onPointerUp(s, ev)}
          ondblclick={() => onDblClick(s)}
        >
          <div class="crosshair-h"></div>
          <div class="crosshair-v"></div>
          <div
            class="dot"
            class:active={dragging === s}
            style="left: {dotLeft(s)}%; top: {dotTop(s)}%;"
            data-testid="linnstrument-face-dot-{s}"
          ></div>
        </div>
        <div class="pad-row">
          <span class="cap">{s.toUpperCase()}</span>
          <select
            class="target"
            aria-label="{s.toUpperCase()} mirrors joystick"
            value={targets[s] ?? ''}
            onchange={(ev) => onChangeTarget(s, ev)}
            data-testid="linnstrument-face-target-{s}"
          >
            <option value="">—</option>
            {#each joysticks as j (j.id)}
              <option value={j.id}>{j.label}</option>
            {/each}
          </select>
        </div>
      </div>
    {/each}
  </div>

  <div class="row">
    <StatusLed caption="LINK" lit={linkLit} tone="accent" detail={linkDetail} testid="linnstrument-face-led-link-{nodeId}" />
    <StatusLed caption="KEYS" lit={keysLit} tone="accent" detail={regionDetail('keys')} testid="linnstrument-face-led-keys-{nodeId}" />
    <StatusLed caption="PAD" lit={padLit} tone="accent" detail={regionDetail('pad')} testid="linnstrument-face-led-pad-{nodeId}" />
  </div>
</div>

<style>
  .linn-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0 4px;
  }
  .pads {
    display: flex;
    gap: 10px;
  }
  .pad-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .pad {
    position: relative;
    width: 120px;
    height: 120px;
    background: #0c0e14;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 3px;
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  .pad:active {
    cursor: grabbing;
  }
  /* The app pastels the design record names (ui-specification.md palette):
     rose / sage / periwinkle. Selection is the border burning. */
  .pad.r.selected { border-color: #dda7b1; box-shadow: 0 0 6px rgba(221, 167, 177, 0.5); }
  .pad.g.selected { border-color: #afccb4; box-shadow: 0 0 6px rgba(175, 204, 180, 0.5); }
  .pad.b.selected { border-color: #b1c2e2; box-shadow: 0 0 6px rgba(177, 194, 226, 0.5); }
  .crosshair-h,
  .crosshair-v {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    pointer-events: none;
  }
  .crosshair-h { left: 0; right: 0; top: 50%; height: 1px; transform: translateY(-0.5px); }
  .crosshair-v { top: 0; bottom: 0; left: 50%; width: 1px; transform: translateX(-0.5px); }
  .dot {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--cable-cv);
    border: 1px solid #fff;
    transform: translate(-50%, -50%);
    box-shadow: 0 0 8px rgba(120, 200, 255, 0.4);
    pointer-events: none;
  }
  .pad.r .dot { background: #dda7b1; }
  .pad.g .dot { background: #afccb4; }
  .pad.b .dot { background: #b1c2e2; }
  .dot.active { box-shadow: 0 0 14px rgba(120, 200, 255, 0.8); }
  .pad-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    letter-spacing: 0.08em;
  }
  .cap { opacity: 0.8; }
  .target {
    font: inherit;
    font-size: 10px;
    background: #0c0e14;
    color: inherit;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 3px;
    max-width: 88px;
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: center;
  }
</style>
