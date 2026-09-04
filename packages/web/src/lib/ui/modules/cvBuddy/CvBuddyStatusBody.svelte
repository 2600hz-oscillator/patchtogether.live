<script lang="ts">
  // CvBuddyStatusBody — the RACK-GLOBAL STATUS surface for CV BUDDY and CV
  // BUDDY MINI, at the head of the dock full view.
  //
  // ⚠ ONE body for BOTH kinds, exactly like the legacy `CvBuddyBody` it carries
  // forward, and for the same reason its header gives: the two modules differ
  // by one jack, they share ONE ES-9 slot pool, and two copies of this would be
  // two truths about who owns jack 1 — drift invisible until a user noticed one
  // plate telling the truth and the other not. `face.extension: 'cvBuddy'` is
  // declared by BOTH defs, so both resolve here.
  //
  // ── WHAT IT PAINTS, AND WHY EACH PART IS ALLOWED TO ────────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those or a
  // PICTURE:
  //
  //   * THE SLOT NAME (`JACKS 1-3`) paints, as a NAME. It is the owner's own
  //     disambiguation test made literal — two CV Buddies on a rack are
  //     otherwise IDENTICAL plates, and the jacks they own is the only thing
  //     that tells them apart. A player looking at two open faceplates has no
  //     other way to know which one is wired to the voice they can hear.
  //   * THE LAMPS are PICTURES, through `StatusLed`: a static caption, a
  //     boolean, and the measurement in `aria-label`/`title`. `clockSkips` is a
  //     COUNT, and a count may not paint — so the count reaches the title and
  //     the lamp carries "any / none". That is the eurorack panel idiom, and it
  //     is strictly MORE informative at rest than the card's `0 skipped`: the
  //     card had to argue that a zero must always render or "healthy" and "not
  //     instrumented" would look identical, and a lamp that is PRESENT AND DARK
  //     says exactly that with no text at all.
  //   * NOTHING ELSE. The card's two ES-9 prose sentences and its
  //     "PPQN / clock is driven by the first CV Buddy" hint do not paint here.
  //     The first two collapse into the ROUTED lamp (see the comment at that
  //     collapse); the third is replaced by STRUCTURE — `face.rackStatus`
  //     removes the clock band from a non-primary plate entirely, so there is
  //     no dead control left needing a sentence to explain it.
  //
  // ── ⚠ THIS BODY IS WHY THE CLOCK BAND MAY BE HIDDEN AT ALL ────────────────
  //
  // `rackStatusPlan` refuses to suppress a band unless `dockFullViewHeadPlan`
  // says a module body is painting. `cvBuddy` has exactly TWO params and both
  // are clock params, so on a non-primary instance the suppressed band IS the
  // entire control surface — this component is the whole of what that plate
  // shows, and a bug that stopped it painting would turn a faceplate blank.
  // `cv-buddy-face.spec.ts` asserts the non-primary plate still paints.

  import { patch } from '$lib/graph/store';
  import { nodeVersion, nodesStructuralVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    allocateCvBuddySlots,
    type CvBuddyAlloc,
    type CvBuddyInstance,
  } from '$lib/audio/cv-buddy/slot-alloc';
  import type { CvBuddyClockState, CvBuddyClockHealth } from '$lib/audio/modules/cv-buddy';
  import {
    cvBuddyRouted,
    cvBuddyRoutedDetail,
    cvBuddyLateLampLit,
    cvBuddySkipDetail,
    cvBuddySlotDetail,
    cvBuddySlotName,
    type CvBuddyClockDriver,
  } from './cv-buddy-status-model';

  let { nodeId }: { nodeId: string } = $props();

  const engineCtx = useEngine();

  let structuralV = $derived(nodesStructuralVersion());
  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  // BOTH kinds — they share one ES-9 jack pool, so the slot this plate reports
  // depends on every CV Buddy on the rack, mini or not.
  let instances = $derived.by<CvBuddyInstance[]>(() => {
    void structuralV;
    const out: CvBuddyInstance[] = [];
    for (const n of Object.values(patch.nodes)) {
      const t = (n as { type?: string } | undefined)?.type;
      if (t === 'cvBuddy') out.push({ id: (n as { id: string }).id, kind: 'full' });
      else if (t === 'cvBuddyMini') out.push({ id: (n as { id: string }).id, kind: 'mini' });
    }
    return out;
  });

  let es9Present = $derived.by<boolean>(() => {
    void structuralV;
    for (const n of Object.values(patch.nodes)) {
      if (n && (n as { type?: string }).type === 'es9') return true;
    }
    return false;
  });

  let alloc = $derived<CvBuddyAlloc | undefined>(allocateCvBuddySlots(instances).get(nodeId));
  let ownsClock = $derived(alloc?.ownsClock === true);

  // Every STRING this surface can produce comes from the pure model beside this
  // file — including the ones that are never painted. An unpainted string that
  // is wrong is invisible to a VRT baseline and to a human reviewing one, so
  // they are decided where a unit test can read them. The UNROUTED / CONTENDED
  // collapse and its action-identity argument live there too, at the function
  // where the collapse actually happens.
  let slotName = $derived<string | null>(cvBuddySlotName(alloc));
  let slotDetail = $derived<string>(cvBuddySlotDetail(alloc));
  let routed = $derived(cvBuddyRouted(es9Present, alloc));
  let routedDetail = $derived<string>(cvBuddyRoutedDetail(es9Present, alloc));

  // ── the late-tick counter, as a LAMP ──────────────────────────────────────
  //
  // The ES-9 card shows `xruns` (bridge starvation); this shows the clock
  // pulses a LATE scheduler tick could not place (main-thread stall). The two
  // together are what make "the clock is unstable" diagnosable — they have
  // opposite fixes.
  //
  // Only the clock owner has a clock at all, so only the owner polls. On every
  // other instance the lamp does not render: there is no measurement, and a
  // permanently dark lamp for a thing that cannot happen is noise.
  let clockSkips = $state(0);
  // WHICH mechanism drives the jacks (read('clockHealth').driver): the same
  // stall shows as a lost pulse under 'main' and as an ABSORBED stall under
  // 'worklet' (the audio-thread clock kept emitting) — the lamp's detail
  // sentence must not claim a loss that did not happen, and the lamp must not
  // LIGHT for one either. Under 'worklet' the painted state follows
  // workletSkips (real holes only), which is what keeps a resting faceplate
  // deterministic under VRT: the shadow skips counter tracks the RUNNER'S
  // load average, and a boot that stalls >200 ms would otherwise capture a
  // lit lamp (PR #2343, vrt-strict shard 10, face-cvBuddy-dock).
  let clockDriver = $state<CvBuddyClockDriver>('main');
  let workletSkips = $state(0);
  $effect(() => {
    if (!ownsClock) {
      clockSkips = 0;
      workletSkips = 0;
      return;
    }
    const poll = () => {
      const e = engineCtx.get();
      const n = node;
      if (!e || !n) return;
      const st = e.read(n, 'state') as CvBuddyClockState | undefined;
      if (st && typeof st.skips === 'number') clockSkips = st.skips;
      const h = e.read(n, 'clockHealth') as CvBuddyClockHealth | undefined;
      if (h && (h.driver === 'worklet' || h.driver === 'main')) clockDriver = h.driver;
      if (h && typeof h.workletSkips === 'number') workletSkips = h.workletSkips;
    };
    poll();
    // 1 Hz: a cumulative counter, not a meter. Fast polling would buy nothing,
    // and this runs per open CV Buddy faceplate.
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  });

  let skipDetail = $derived<string>(cvBuddySkipDetail(clockSkips, clockDriver, workletSkips));
  let lateLit = $derived<boolean>(cvBuddyLateLampLit(clockDriver, clockSkips, workletSkips));
</script>

<div class="cv-buddy-status" data-testid="cv-buddy-status-{nodeId}">
  {#if slotName}
    <span
      class="slot-name"
      data-testid="cv-buddy-slot-name-{nodeId}"
      title={slotDetail}
      aria-label={slotDetail}>{slotName}</span
    >
  {/if}
  <span class="lamps">
    <StatusLed
      caption="ROUTED"
      lit={routed}
      detail={routedDetail}
      testid="cv-buddy-led-routed-{nodeId}"
    />
    {#if ownsClock}
      <StatusLed
        caption="LATE"
        lit={lateLit}
        tone="warn"
        detail={skipDetail}
        testid="cv-buddy-led-late-{nodeId}"
      />
    {/if}
  </span>
</div>

<style>
  .cv-buddy-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
  /* The slot name is a NAME, so it is typeset like one — the same weight and
     tracking the section labels use, not the mono of a value chip. */
  .slot-name {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.8px;
    color: var(--fg, #ddd);
  }
  .lamps {
    display: inline-flex;
    align-items: center;
    gap: 12px;
    margin-left: auto;
  }
</style>
