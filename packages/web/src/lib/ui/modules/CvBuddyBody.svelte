<script lang="ts">
  // CvBuddyBody — the SHARED card body for CV BUDDY and CV BUDDY MINI.
  //
  // ⚠ ONE body on purpose. The two modules differ by a single port (velocity)
  // and one line of slot text; everything else — the slot readout, the
  // owner-only clock section, the ES-9 presence mirror, the styling — is
  // identical. Two copies would drift, and the drift would be invisible until a
  // user noticed one card telling the truth and the other not.
  //
  // It shows:
  //   * the three note INPUTS (gate / pitch / velocity) and five note/transport
  //     OUTPUTS (pitchCv / gate / velCv / run / clock) as PatchPanel handles,
  //   * which ES-9 jacks THIS instance owns (id-sorted: 1-3, or 4-6, or none),
  //   * a CLOCK section (PPQN + offset + "run → jack 7 · clock → jack 8") shown
  //     ONLY on the clock-owner (id-smallest) instance,
  //   * an ES-9 presence mirror that prompts the user to add an ES-9 + run the
  //     es9-bridge helper when none is in the rack.
  //
  // All cross-node state (instance ordering, ES-9 presence) is derived reactively
  // from the live patch via nodesStructuralVersion(); this instance's params via
  // nodeVersion(id).

  import type { NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import type { ModuleNode } from '$lib/graph/types';
  import { patch } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import {
    allocateCvBuddySlots,
    type CvBuddyAlloc,
    type CvBuddyInstance,
    type CvBuddyKind,
  } from '$lib/audio/cv-buddy/slot-alloc';
  import {
    CV_BUDDY_PPQN_CHOICES,
    CV_BUDDY_DEFAULT_PPQN,
    cvBuddyDef,
    type CvBuddyClockState,
    type CvBuddyClockHealth,
  } from '$lib/audio/modules/cv-buddy';
  import {
    cvBuddyLateLampLit,
    cvBuddySkipDetail,
    type CvBuddyClockDriver,
  } from './cvBuddy/cv-buddy-status-model';
  import { cardParams } from './card-kit';
  import ModuleTitle from './ModuleTitle.svelte';

  // Only the two fields this body actually uses. Demanding the whole NodeProps
  // shape would force each thin card wrapper to forward xyflow internals
  // (zIndex, dragging, selected…) it has no reason to know about.
  let { id, data, kind = 'full' }: {
    id: string;
    data: NodeProps['data'];
    kind?: CvBuddyKind;
  } = $props();
  const isMini = $derived(kind === 'mini');
  let node = $derived(data?.node as ModuleNode);

  // cardParams MUST be called during component init (it reads the Svelte engine
  // context). We only want `engineCtx`; this body sets its params directly.
  const { engineCtx } = cardParams(cvBuddyDef, () => id, () => node);

  // Reactive graph reads.
  let structuralV = $derived(nodesStructuralVersion());
  let cardV = $derived(nodeVersion(id));

  // BOTH kinds — they share one ES-9 jack pool, so the slot this card reports
  // depends on every CV Buddy on the rack, mini or not.
  let cvBuddyInstances = $derived.by<CvBuddyInstance[]>(() => {
    void structuralV;
    const insts: CvBuddyInstance[] = [];
    for (const n of Object.values(patch.nodes)) {
      const t = (n as { type?: string } | undefined)?.type;
      if (t === 'cvBuddy') insts.push({ id: (n as { id: string }).id, kind: 'full' });
      else if (t === 'cvBuddyMini') insts.push({ id: (n as { id: string }).id, kind: 'mini' });
    }
    return insts;
  });
  let es9Present = $derived.by<boolean>(() => {
    void structuralV;
    for (const n of Object.values(patch.nodes)) {
      if (n && (n as { type?: string }).type === 'es9') return true;
    }
    return false;
  });

  let alloc = $derived<CvBuddyAlloc | undefined>(allocateCvBuddySlots(cvBuddyInstances).get(id));
  let ownsClock = $derived(alloc?.ownsClock === true);

  let slotLabel = $derived.by(() => {
    if (!alloc) return 'No free ES-9 slots';
    return alloc.velSlot == null
      ? `Jacks ${alloc.pitchSlot}–${alloc.gateSlot} (pitch/gate)`
      : `Jacks ${alloc.pitchSlot}–${alloc.velSlot} (pitch/gate/vel)`;
  });

  // This instance's params (reactive).
  let ppqn = $derived<number>((void cardV, node?.params?.ppqn ?? CV_BUDDY_DEFAULT_PPQN));
  let offsetMs = $derived<number>((void cardV, node?.params?.clockOffsetMs ?? 0));

  function onChangePpqn(ev: Event): void {
    const v = Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10);
    if (Number.isFinite(v)) setNodeParam(id, 'ppqn', v);
  }
  function onChangeOffset(ev: Event): void {
    const v = Number.parseFloat((ev.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v)) setNodeParam(id, 'clockOffsetMs', v);
  }

  // ---- late-tick counter, the other half of the clock-stability instrument ----
  //
  // The ES-9 card already shows `xruns` (bridge starvation). This shows the
  // pulses a LATE scheduler tick could not place (main-thread stall). The two
  // together are what make "the clock is unstable" diagnosable: they have
  // opposite fixes, and until now only one of them was on screen.
  //
  // A ZERO IS INFORMATION and is always rendered. Hiding it until non-zero
  // would make "healthy" and "not instrumented" look identical — the exact
  // ambiguity that cost this bug its first round of guessing.
  // ⚠ THE PAINTED NUMBER MUST BE DETERMINISTIC AT REST. The shadow `skips`
  // counter tracks main-thread stalls — i.e. the RUNNER'S load average — and
  // under the cv-clock worklet driver (every real browser, #2338) those
  // stalls cost NOTHING at the jack. Painting them made this readout (and the
  // face's LATE lamp — PR #2343, vrt-strict shard 10) flip boot-to-boot on a
  // contended VRT shard. So what PAINTS is the count of pulses actually LOST
  // at the jack (`workletSkips` under the worklet driver; `skips` under the
  // main driver, where every skip IS a loss), and the stall count keeps its
  // full sentence in the title via the same shared model the face uses.
  let clockSkips = $state(0);
  let clockDriver = $state<CvBuddyClockDriver>('main');
  let workletSkips = $state(0);
  $effect(() => {
    if (!ownsClock) return; // only the owner instance has a clock at all
    const poll = () => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const st = e.read(node, 'state') as CvBuddyClockState | undefined;
      if (st && typeof st.skips === 'number') clockSkips = st.skips;
      const h = e.read(node, 'clockHealth') as CvBuddyClockHealth | undefined;
      if (h && (h.driver === 'worklet' || h.driver === 'main')) clockDriver = h.driver;
      if (h && typeof h.workletSkips === 'number') workletSkips = h.workletSkips;
    };
    poll();
    // 1 Hz: a cumulative counter, not a meter. Fast polling would buy nothing
    // and this runs per CV Buddy card on screen.
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  });

  // What PAINTS: losses at the jack (deterministically 0 at rest); what the
  // TITLE says: the full stall/loss story, driver-aware, from the one shared
  // model so this card and the faceplate can never tell two different truths.
  let lostCount = $derived<number>(clockDriver === 'worklet' ? workletSkips : clockSkips);
  let lateWarn = $derived<boolean>(cvBuddyLateLampLit(clockDriver, clockSkips, workletSkips));
  let skipTitle = $derived<string>(cvBuddySkipDetail(clockSkips, clockDriver, workletSkips));

  // Port lists follow the KIND — a mini has no velocity jack at all, which is
  // the whole reason it costs two ES-9 outputs instead of three.
  const inputs: PortDescriptor[] = $derived([
    { id: 'gate', label: 'GATE', cable: 'gate' as const },
    { id: 'pitch', label: 'PITCH', cable: 'cv' as const },
    ...(isMini ? [] : [{ id: 'velocity', label: 'VEL', cable: 'cv' as const }]),
  ]);
  const outputs: PortDescriptor[] = $derived([
    { id: 'pitchCv', label: 'PITCH CV', cable: 'cv' as const },
    { id: 'gate', label: 'GATE', cable: 'gate' as const },
    ...(isMini ? [] : [{ id: 'velCv', label: 'VEL CV', cable: 'cv' as const }]),
    { id: 'run', label: 'RUN', cable: 'gate' as const },
    { id: 'clock', label: 'CLOCK', cable: 'gate' as const },
  ]);
</script>

<div class="mod-card cv-buddy-card" class:mini={isMini}>
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <ModuleTitle {id} {data} defaultLabel={isMini ? "CV BUDDY MINI" : "CV BUDDY"} />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <div class="readout" data-testid="cv-buddy-slots-{id}">
        <span class="lbl">SLOTS</span>
        <span class="val">{slotLabel}</span>
      </div>

      {#if ownsClock}
        <div class="clock-section" data-testid="cv-buddy-clock-{id}">
          <label class="row">
            <span class="lbl">PPQN</span>
            <select onchange={onChangePpqn} value={String(ppqn)}>
              {#each CV_BUDDY_PPQN_CHOICES as p (p)}
                <option value={String(p)}>{p}</option>
              {/each}
            </select>
          </label>
          <label class="row">
            <span class="lbl">OFFSET</span>
            <input
              type="range"
              min="-20"
              max="20"
              step="0.5"
              value={offsetMs}
              oninput={onChangeOffset}
            />
            <span class="val mono">{offsetMs.toFixed(1)} ms</span>
          </label>
          <div class="hint">run → jack 7 · clock → jack 8</div>
          <div
            class="readout skips"
            class:warn={lateWarn}
            data-testid="cv-buddy-skips-{id}"
            title={skipTitle}
          >
            <span class="lbl">LATE</span>
            <span class="val mono">{lostCount} skipped</span>
          </div>
        </div>
      {:else}
        <div class="hint muted">
          {#if alloc}
            PPQN / clock is driven by the first CV Buddy (this instance follows).
          {:else}
            Inert — the first two CV Buddies own the ES-9 jacks.
          {/if}
        </div>
      {/if}

      <div class="es9-mirror" class:ok={es9Present} data-testid="cv-buddy-es9-{id}">
        {#if es9Present}
          <span class="dot lit"></span>
          <span class="mirror-text">ES-9 in rack — outputs route to its jacks. Run the es9-bridge helper to hear them.</span>
        {:else}
          <span class="dot"></span>
          <span class="mirror-text">No ES-9 in rack — add an ES-9 module and run the es9-bridge helper.</span>
        {/if}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .cv-buddy-card { width: 230px; }
  .cv-buddy-card .body {
    padding: 10px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cv-buddy-card .lbl {
    min-width: 46px;
    color: var(--muted, #aaa);
    font-weight: 600;
    letter-spacing: 0.5px;
    font-size: 10px;
  }
  .cv-buddy-card .val { font-size: 10px; color: var(--fg, #eee); }
  .cv-buddy-card .mono { font-family: var(--mono, ui-monospace, monospace); }
  .cv-buddy-card .readout {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
  }
  .cv-buddy-card .clock-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
  }
  .cv-buddy-card .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
  }
  .cv-buddy-card .row select {
    flex: 1;
    font-size: 10px;
    padding: 2px 4px;
    background: var(--panel, #222);
    color: var(--fg, #eee);
    border: 1px solid var(--border, #444);
    border-radius: 2px;
  }
  .cv-buddy-card .row input[type='range'] { flex: 1; }
  .cv-buddy-card .hint {
    font-size: 10px;
    color: var(--cable-cv, #6cf);
    line-height: 1.3;
  }
  .cv-buddy-card .hint.muted { color: var(--muted, #888); }
  /* Sized to match the SLOTS readout, not shrunk into the hint text below it.
     This is the card's FAULT indicator — the thing the owner scans mid-take
     while a hardware clock misbehaves — so it gets the same legibility as the
     other readout on the card. Muted while healthy: present, not shouting. */
  .cv-buddy-card .readout.skips { color: var(--muted, #888); }
  .cv-buddy-card .readout.skips.warn {
    color: var(--warn, #e6b800);
    border-color: var(--warn, #e6b800);
  }
  .cv-buddy-card .es9-mirror {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 10px;
    color: var(--muted, #888);
    line-height: 1.3;
  }
  .cv-buddy-card .es9-mirror.ok { color: var(--fg, #ccc); }
  .cv-buddy-card .mirror-text { flex: 1; }
  .cv-buddy-card .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border, #444);
    flex: 0 0 auto;
    margin-top: 2px;
  }
  .cv-buddy-card .dot.lit {
    background: var(--cable-cv, #6cf);
    box-shadow: 0 0 6px var(--cable-cv, #6cf);
  }
</style>
