<script lang="ts">
  // PtzcamDeviceBody — the CAMERA BINDING surface, at the head of the dock full
  // view. midiclock's `MidiclockDeviceBody` is the template; the two differences
  // that matter are recorded below.
  //
  // ── WHAT IT CARRIES, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those, an
  // ERROR, or a LAMP:
  //
  //   * THE CAMERA `<select>` — the affordance that cannot be a face cell. Its
  //     roster is `listPtzOutputNames()`, read off the app's live sysex MIDI
  //     access, and it changes when the helper starts or a camera is plugged in.
  //     A `ShellSelectorCell.options` is a pure function of the NODE, so it
  //     would be computed once against a roster that did not exist yet and stay
  //     stale through the async grant. Its painted text is a device NAME, which
  //     is a name — the cameraInput / midiclock precedent.
  //   * THE LAMPS, through `StatusLed`: a static literal caption, a boolean that
  //     IS the picture, and the sentence in `aria-label` / `title`.
  //   * THE PRE-CONNECT HINT — instructional copy in an EMPTY state, which is
  //     the whole content of the plate before a grant (the midiclock licence).
  //   * THE FAULT LINE — an ERROR, `role="alert"`, absent whenever nothing is
  //     wrong. It carries the binding layer's own sentence, which for several
  //     kinds is the only place in the product that says what to DO ("Start the
  //     helper (start_ptz.sh)", "relaunch with --disable-features=MidiMacUmp").
  //
  // ── ⚠ WHAT THE PROMOTION DELETED, AND WHERE IT WENT ───────────────────────
  //
  // ONE readout: the legacy card's mode line, `pan abs · tilt abs · zoom abs`.
  // It is three lamps now (PAN / TILT / ZOOM, lit = VELOCITY), each with its
  // sentence on `aria-label`.
  //
  // ⚠ AND THE LAMP BLOCK IS GUARDED ON `caps`, WHICH IS THE PART A NAIVE PORT
  // GETS WRONG. The underlying fact is THREE-valued per axis (`abs | vel |
  // none`) and it is ABSENT before the handshake. Three unguarded boolean lamps
  // would render pre-bind exactly as they render for a bound NexiGo P610 — all
  // dark — so the face would be asserting "all three axes are positions" about
  // a module that knows nothing about any camera yet. The card hid the row
  // (`{#if modeLine !== null}`); this hides the block, so "unknown" is the
  // ABSENCE of the indicator rather than one of its states. That matters more
  // here than the readout did: the axis mode is the SEMANTICS OF EVERY OTHER
  // CONTROL on the module — whether the knobs are positions or rates, and
  // whether SLEW does anything at all.
  //
  // ⚠ NO CONNECT BUTTON HERE, DELIBERATELY. The gesture is a ranked `action`
  // cell in the band below, which is what puts it on the LANE TILE — the whole
  // point of making it a cell. A second button on the same plate would be one
  // gesture with two affordances and a second thing to keep in sync.
  //
  // ── ⚠ REACTIVITY: SUBSCRIBE AT INIT, NEVER IN AN $effect ───────────────────
  //
  // `PtzcamCardApi` has NO push seam — unlike `MidiclockApi.subscribe`, there is
  // nothing to register a callback with. The only live source is the
  // module-level `ptzMidiVersion` store, and `PtzcamCard.svelte:39-51` records
  // the measurement that neither store auto-subscription sugar nor
  // `$effect(() => store.subscribe(...))` delivered its bumps — every
  // seemingly-working bind was riding incidental xyflow data-prop churn, which
  // a shell body does not have at all. The init-time subscribe + `onDestroy`
  // pattern is what works, and it is also what releases the subscription.
  //
  // ⚠ AND NOTHING HERE MUTATES FROM A READ PATH. `ensureBinding()` bumps the
  // version store, so calling it from inside a `$derived` throws
  // `state_unsafe_mutation` and permanently poisons the deriveds (measured, and
  // the reason `ptz-midi.ts` defers its own bump to a microtask). The deriveds
  // below call only `status()` / `listPorts()` / `selectedPort()`, all of which
  // are pure reads of the current binding.

  import { onDestroy } from 'svelte';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { PtzStatus } from '$lib/audio/ptz-midi';
  import { ptzMidiVersion } from '$lib/audio/ptz-midi';
  import { ptzcamApi, ptzcamSelectPort } from '../ptzcam-cell-actions';
  import {
    ptzcamAxisLamps,
    ptzcamIsBound,
    ptzcamIsProblem,
    ptzcamLinkDetail,
    ptzcamPortOptions,
  } from './ptzcam-status-model';

  let { nodeId }: { nodeId: string } = $props();

  // Mirror the binding-layer version store into rune state — see the header.
  let midiV = $state(0);
  onDestroy(
    ptzMidiVersion.subscribe((n) => {
      midiV = n;
    }),
  );
  /** Bumped by this surface's own gestures so api-backed reads re-run at once
   *  rather than waiting for the store's deferred microtask bump. */
  let revision = $state(0);

  let nodeV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void nodeV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  let status = $derived.by<PtzStatus | null>(() => {
    void midiV;
    void revision;
    void node;
    return ptzcamApi(nodeId)?.status() ?? null;
  });
  let ports = $derived.by<readonly string[]>(() => {
    void midiV;
    void revision;
    void node;
    return ptzcamApi(nodeId)?.listPorts() ?? [];
  });
  let selected = $derived.by<string | null>(() => {
    void midiV;
    void revision;
    void node;
    return ptzcamApi(nodeId)?.selectedPort() ?? null;
  });

  let options = $derived(ptzcamPortOptions(ports, selected));
  let bound = $derived(ptzcamIsBound(status));
  let problem = $derived(ptzcamIsProblem(status));
  let linkDetail = $derived(ptzcamLinkDetail(status));
  let axisLamps = $derived(ptzcamAxisLamps(status?.caps));

  function onChangeCamera(ev: Event): void {
    const value = (ev.currentTarget as HTMLSelectElement).value;
    ptzcamSelectPort(nodeId, value === '' ? null : value);
    revision++;
  }
</script>

<!-- ⚠ THE PROSE IS ON ITS OWN LINE, AND THAT IS A LAYOUT REQUIREMENT RATHER
     THAN A LOOK. `.faceplate-body` is `width: max-content`, so this plate's
     intrinsic width is what the DOCK PANE is sized to — and a single flex ROW
     holding the picker, a wrapping paragraph and the lamps has a max-content
     width equal to all three UNWRAPPED, while the paragraph then paints two
     short lines inside it. MEASURED on the first capture: body 492 px wide,
     rightmost paint (the LINK caption) at 514 against a plate edge of 558 —
     44 px of empty plate against the 40 px ceiling `workflow-shell-faces`
     enforces from the 2026-08-17 ruling ("we do not want useless gray
     horizontal space on cards, ever").
     A COLUMN's max-content is the MAX of its rows, not their sum, so the
     paragraph's width no longer pushes the row out, and the plate stops being
     the widest thing in the faceplate. -->
<div class="ptzcam-device" data-testid="ptzcam-device-body-{nodeId}">
  <div class="row-main">
    <label class="row">
      <span class="cap">Camera</span>
      <select
        data-testid="ptzcam-device-select-{nodeId}"
        value={selected ?? ''}
        onchange={onChangeCamera}
      >
        <option value="">— first camera —</option>
        {#each options as opt (opt.value)}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </label>

    <span class="lamps">
    <StatusLed
      caption="LINK"
      lit={bound}
      detail={linkDetail}
      testid="ptzcam-led-link-{nodeId}"
    />
    {#if axisLamps.length > 0}
      <!-- ⚠ ONLY WHILE `caps` EXISTS — see the header. Absent is "unknown". -->
      <span class="axes" data-testid="ptzcam-axis-lamps-{nodeId}">
        {#each axisLamps as lamp (lamp.axis)}
          {#if lamp.axis === 'pan'}
            <StatusLed caption="PAN" lit={lamp.lit} detail={lamp.detail} testid="ptzcam-led-pan-{nodeId}" />
          {:else if lamp.axis === 'tilt'}
            <StatusLed caption="TILT" lit={lamp.lit} detail={lamp.detail} testid="ptzcam-led-tilt-{nodeId}" />
          {:else}
            <StatusLed caption="ZOOM" lit={lamp.lit} detail={lamp.detail} testid="ptzcam-led-zoom-{nodeId}" />
          {/if}
        {/each}
      </span>
    {/if}
    </span>
  </div>

  {#if problem}
    <p class="err" role="alert" data-testid="ptzcam-fault-{nodeId}">{linkDetail}</p>
  {:else if !bound}
    <!-- The EMPTY STATE: what to do, and why no camera is listed yet. Replaced
         by the lamps the moment a binding exists. -->
    <p class="hint">Press Connect camera to grant MIDI and find the PT-PTZ helper.</p>
  {/if}
</div>

<style>
  /* COLUMN, so the plate's max-content width is the WIDEST ROW rather than the
     sum of a row and a paragraph — see the markup note above. */
  .ptzcam-device {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .hint,
  .err {
    margin: 0;
    font-size: 10px;
    line-height: 1.3;
    max-width: 34ch;
  }
  .hint { color: var(--muted, #888); }
  .err { color: #d66; }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  /* A control CAPTION, typeset the way every other cell caption is. */
  .row .cap {
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    font-size: 9px;
  }
  .row select {
    font-size: 10px;
    padding: 2px 4px;
    max-width: 190px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
  .axes {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
</style>
