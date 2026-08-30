<script lang="ts">
  // Es9BridgeBody — the LINK STATUS strip at the head of the ES-9 dock full
  // view.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those or a
  // LAMP:
  //
  //   * THREE LAMPS, through `StatusLed`: a static literal caption, a boolean
  //     that IS the picture, and the measurement in `aria-label` / `title`.
  //     Nothing about their state reaches a text node.
  //   * THE EMPTY-STATE HINT — instructional copy in a state that has no other
  //     content, which `MidiclockDeviceBody.svelte` permits by name (*"the
  //     empty state is the whole content of the plate before a grant"*). Here
  //     the empty state is "no helper process is running", which is a
  //     different world from a permission prompt and needs its own sentence.
  //
  // ⚠ NO CONNECT BUTTON HERE. Both gestures are RANKED ACTION CELLS in the band
  // below, which is what puts them on the LANE TILE too — the whole point of
  // making them cells. A second button on the same plate would be one gesture
  // with two affordances.
  //
  // ⚠ NO DEVICE PICKER EITHER, and unlike the MIDI binders that is not a
  // constraint being worked around: `maxInstances: 1` and the native app
  // accepts a single client, so there is exactly one device and no roster to
  // choose from.
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE EACH FINDING WENT ─────────────
  //
  // The legacy card painted a state word and two derived rows. None is gone as
  // INFORMATION; all are gone as TEXT:
  //
  //   `stateLabel` — a seven-way string switch about the module, painted
  //     outside every control. It is the BRIDGE lamp, with the exact failure
  //     named in `aria-label`. The narrowing (eight states onto two) is stated
  //     in `es9-status-model.ts` rather than hidden.
  //
  //   `{rate} kHz · {in}×{out} · rtt {n} ms` — three derived numbers and a
  //     measurement with a decimal, i.e. the deleted readout verbatim. They
  //     compose into the BRIDGE lamp's sentence. Nothing is lost: the rate is
  //     always the engine's own context rate (the bridge may run at no other),
  //     and 16×16 is a constant of the hardware.
  //
  //   `xruns {u}/{o}` — a COUNT, which may not paint. It is the XRUN lamp, and
  //     this is the one removal with a downstream dependant: `cvBuddy`'s
  //     shipped faceplate names the ES-9's xruns as the other half of "the
  //     clock is unstable". See `es9XrunDetail`.
  //
  //   `Jacks driven by CV Buddy: …` — a derived LIST, and the card undersold
  //     it as "purely informational". It is the CV BUDDY lamp, because the
  //     jacks it names have their `out{N}_class` overwritten by a janitor and
  //     a plate that hid that would be showing eight editable cells of which
  //     three are not.
  //
  // ⚠ THIS BODY OWNS ITS SUBSCRIPTION AND RELEASES IT, and it SUBSCRIBES
  // rather than polling `es9Snapshot`. `bridge-owner` keeps listeners OUTSIDE
  // the entries precisely so a view may pre-date the connection — the
  // owner-reported showstopper was a view that looked the entry up, found
  // nothing and never subscribed at all. `subscribeEs9` delivers the current
  // snapshot synchronously, so there is nothing a poll would add.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import {
    es9Snapshot,
    subscribeEs9,
    type Es9OwnerSnapshot,
  } from '$lib/audio/es9/bridge-owner';
  import { allocateCvBuddySlots, type CvBuddyInstance } from '$lib/audio/cv-buddy/slot-alloc';
  import {
    es9BridgeDetail,
    es9BridgeLit,
    es9CvBuddyDetail,
    es9CvBuddyLit,
    es9XrunDetail,
    es9XrunLit,
  } from './es9-status-model';

  let { nodeId }: { nodeId: string } = $props();

  // svelte-ignore state_referenced_locally -- SEED only. The $effect below
  // re-reads es9Snapshot(nodeId) from the live id and subscribes, so this
  // initial value is replaced before the first paint that could show a stale one.
  let snap = $state<Es9OwnerSnapshot>(es9Snapshot(nodeId));

  let unsubscribe: (() => void) | null = null;
  $effect(() => {
    const id = nodeId;
    unsubscribe?.();
    unsubscribe = subscribeEs9(id, (s) => { snap = s; });
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  });
  onDestroy(() => { unsubscribe?.(); });

  // Which physical out jacks a CV Buddy is currently auto-driving. Derived from
  // the PATCH — the same allocator the reconciler runs, read the same way the
  // legacy card read it, so the lamp cannot disagree with the janitor.
  let cvbStructuralV = $derived(nodesStructuralVersion());
  let cvBuddyJacks = $derived.by<string[]>(() => {
    void cvbStructuralV;
    const insts: CvBuddyInstance[] = [];
    for (const n of Object.values(patch.nodes)) {
      const t = (n as { type?: string } | undefined)?.type;
      if (t === 'cvBuddy') insts.push({ id: (n as { id: string }).id, kind: 'full' });
      else if (t === 'cvBuddyMini') insts.push({ id: (n as { id: string }).id, kind: 'mini' });
    }
    const slots = new Set<number>();
    for (const a of allocateCvBuddySlots(insts).values()) {
      slots.add(a.pitchSlot); slots.add(a.gateSlot);
      if (a.velSlot != null) slots.add(a.velSlot); // MINI has none
      if (a.runSlot != null) slots.add(a.runSlot);
      if (a.clockSlot != null) slots.add(a.clockSlot);
    }
    return [...slots]
      .sort((x, y) => x - y)
      .map((s) => (s === 7 ? '7 (run)' : s === 8 ? '8 (clock)' : String(s)));
  });

  let bridgeDetail = $derived<string>(es9BridgeDetail(snap));
  let xrunDetail = $derived<string>(es9XrunDetail(snap));
  let cvbDetail = $derived<string>(es9CvBuddyDetail(cvBuddyJacks));
  let linkUp = $derived<boolean>(es9BridgeLit(snap));
</script>

<div class="es9-bridge" data-testid="es9-bridge-body-{nodeId}">
  {#if !linkUp}
    {#if !snap.supported}
      <p class="hint" data-testid="es9-unsupported-{nodeId}">
        This browser context has no SharedArrayBuffer. Open the rack from a
        cross-origin-isolated origin.
      </p>
    {:else}
      <p class="hint">Run the es9-bridge app (Chromium required), then press Connect.</p>
    {/if}
  {/if}

  <span class="lamps">
    <StatusLed
      caption="BRIDGE"
      lit={linkUp}
      detail={bridgeDetail}
      testid="es9-led-bridge-{nodeId}"
    />
    <StatusLed
      caption="XRUN"
      lit={es9XrunLit(snap)}
      tone="warn"
      detail={xrunDetail}
      testid="es9-led-xrun-{nodeId}"
    />
    <StatusLed
      caption="CV BUDDY"
      lit={es9CvBuddyLit(cvBuddyJacks)}
      detail={cvbDetail}
      testid="es9-led-cvbuddy-{nodeId}"
    />
  </span>
</div>

<style>
  .es9-bridge {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .hint {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
    color: var(--muted, #888);
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
