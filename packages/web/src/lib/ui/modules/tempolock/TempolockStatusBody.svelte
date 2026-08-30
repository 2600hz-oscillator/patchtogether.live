<script lang="ts">
  // TempolockStatusBody — the STATUS surface for TEMPOLOCK, at the head of
  // the dock full view: a LOCK lamp and a BEAT lamp, nothing else.
  //
  // ── WHAT IT PAINTS, AND WHY EACH PART IS ALLOWED TO ───────────────────────
  //
  // The resting-text rulings permit the module NAME, section LABELS, control
  // CAPTIONS and option/landmark NAMES. Everything here is one of those or a
  // PICTURE:
  //
  //   * THE LAMPS are PICTURES, through `StatusLed`: a static caption, a
  //     boolean, and the measurement in `aria-label`/`title`. The tracked BPM
  //     is a derived VALUE and may not paint — TIMELORDE's face deleted its
  //     own BPM footer under the same rulings — so it lives on the LOCK
  //     lamp's detail, which is speakable, assertable and hoverable. The
  //     late-tick skip COUNT rides the BEAT lamp's detail (the cvBuddy LATE
  //     discipline).
  //   * NOTHING ELSE. No mode word, no tempo chip, no sentence.
  //
  // Every string comes from the pure model beside this file
  // (tempolock-status-model.ts) — an unpainted string that is wrong is
  // invisible to a VRT baseline, so the strings are decided where a unit test
  // can read them.
  //
  // POLLING: 150 ms. The BEAT lamp's `lit` window is ~150 ms of the engine
  // snapshot's `beatRecent`, so this cadence catches every beat at the bands'
  // slowest tempo while staying far from rAF-per-frame cost; LOCK and the
  // detail strings change at most a few times a minute. At rest (fresh spawn,
  // nothing patched) the tracker is cold, both lamps are dark and the details
  // are static — which is what makes the dock VRT scene deterministic.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { StatusLed } from '$lib/ui/controls';
  import type { ModuleNode } from '$lib/graph/types';
  import type { TempolockState } from '$lib/audio/modules/tempolock';
  import {
    tempolockBeatDetail,
    tempolockBeatLit,
    tempolockLockDetail,
    tempolockLockLit,
  } from './tempolock-status-model';

  let { nodeId }: { nodeId: string } = $props();

  const engineCtx = useEngine();

  let cardV = $derived(nodeVersion(nodeId));
  let node = $derived<ModuleNode | undefined>(
    (void cardV, patch.nodes[nodeId] as ModuleNode | undefined),
  );

  let state = $state<TempolockState | null>(null);
  $effect(() => {
    const poll = () => {
      const e = engineCtx.get();
      const n = node;
      if (!e || !n) return;
      const st = e.read(n, 'state') as TempolockState | undefined;
      state = st ?? null;
    };
    poll();
    const timer = setInterval(poll, 150);
    return () => clearInterval(timer);
  });
</script>

<div class="tempolock-status" data-testid="tempolock-status-{nodeId}">
  <StatusLed
    caption="LOCK"
    lit={tempolockLockLit(state)}
    detail={tempolockLockDetail(state)}
    testid="tempolock-led-lock-{nodeId}"
  />
  <StatusLed
    caption="BEAT"
    lit={tempolockBeatLit(state)}
    detail={tempolockBeatDetail(state)}
    testid="tempolock-led-beat-{nodeId}"
  />
</div>

<style>
  .tempolock-status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 10px;
    border: 1px solid var(--border, #333);
    border-radius: 3px;
    background: var(--panel, #1b1b1b);
  }
</style>
