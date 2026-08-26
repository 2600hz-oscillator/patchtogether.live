<script lang="ts">
  // ScoreSlotsPanel — QUICKSAVE, as a PF-14 panel cell.
  //
  // ⚠ THIS IS NOT A CONVENIENCE. FOUR DECLARED INPUT PORTS DEPEND ON IT.
  // `queue1_cv … queue4_cv` are four of SCORE's eleven inputs, documented as
  // "queues saved pattern slot N", and their engine path bottoms out at
  // `data.slots[queued]`. `data.slots` is written by exactly one thing in the
  // repo — `handleSlotClick`, driven by `QuicksaveControls.svelte`, which until
  // this PR was mounted only by the legacy card. Promotion without a quicksave
  // surface would leave those four ports firing, resolving a slot, finding it
  // empty and clearing `queuedSlot`: declared, documented and permanently inert.
  //
  // ⚠ ONE PANEL, NOT THREE CELLS. This is nine buttons implementing a
  // mode-THEN-target interaction over `node.data.slots`. Decomposing it into a
  // mode selector plus four actions would be four cells for one widget, four
  // more control families, and would still need somewhere to show WHICH slots
  // hold a pattern. It is "one picture-you-edit inside the generic face", which
  // is the panel kind's own description — and the component already exists and
  // is already unit-tested (`transport-card.test.ts`,
  // `transport-helpers.test.ts`). Reuse it; do not re-implement it.
  //
  // ⚠ TWO THINGS ARE HIDDEN FROM THE SHARED COMPONENT HERE, both for the
  // one-control-one-place rule rather than for looks:
  //   * its "QUICKSAVE" caption — the panel cell already prints `quicksave` as
  //     its own control caption, and two stacked labels are a restatement.
  //   * its PLAY button — `isPlaying` is a RANKED CELL on this face (rank 2),
  //     so a second play button on the same plate is the same control twice.
  //     RESET is kept: it has no other home on either surface, and it is not
  //     merely `isPlaying = 0` (it clears any queued slot and re-arms the
  //     transport if it was running).
  // The legacy card passes neither flag, so its surface is byte-unchanged.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    handleSlotClick,
    readLastLoadedSlot,
    readPendingMode,
    readQueuedSlot,
    readSlots,
    setPendingMode,
    setQueuedSlot,
  } from '$lib/audio/modules/transport-card';
  import { SLOT_KEYS, type PendingMode, type SlotKey } from '$lib/audio/modules/transport-helpers';
  import { createScoreTransportDeps } from '$lib/audio/modules/score-transport-deps';
  import { scoreSlotsAriaLabel } from './score-aria';

  const { nodeId }: { nodeId: string } = $props();

  let version = $derived(nodeVersion(nodeId));
  let node = $derived((void version, patch.nodes[nodeId] as ModuleNode | undefined));

  // ⚠ EXTRACTED, NOT COPIED — see `score-transport-deps.ts`. Its `nodeId` getter
  // records a real bug (a reused component instance writing this sequencer's
  // slots into another node), and a second copy is that bug waiting to come back
  // in a file nobody associates with it.
  const deps = createScoreTransportDeps(() => nodeId);

  let slots = $derived((void version, readSlots(node)));
  let pendingMode = $derived<PendingMode>((void version, readPendingMode(node)));
  let queuedSlot = $derived<SlotKey | null>((void version, readQueuedSlot(node)));
  let lastLoadedSlot = $derived<SlotKey | null>((void version, readLastLoadedSlot(node)));
  let isPlaying = $derived((void version, (node?.params.isPlaying ?? 0) >= 0.5));

  let filled = $derived(SLOT_KEYS.filter((k) => slots[k] !== null));
  let aria = $derived(scoreSlotsAriaLabel(filled, queuedSlot, lastLoadedSlot, pendingMode));

  function onSetMode(m: PendingMode) { setPendingMode(deps, m); }
  function onSlotClick(k: SlotKey) { handleSlotClick(deps, k); }
  function onPlayToggle() { setNodeParam(nodeId, 'isPlaying', isPlaying ? 0 : 1); }
  function onReset() {
    const wasPlaying = isPlaying;
    setQueuedSlot(deps, null);
    setNodeParam(nodeId, 'isPlaying', 0);
    if (wasPlaying) requestAnimationFrame(() => setNodeParam(nodeId, 'isPlaying', 1));
  }
</script>

<!-- ⚠ THE STATE IS IN THE ACCESSIBLE NAME, NOT IN INK. Which slots hold a
     pattern, which one is queued and which was last loaded were legible on the
     card only as colour; here they are also speakable and assertable, which is
     what the face specs read. Nothing new is painted. -->
<div class="score-slots" data-testid={`score-slots-${nodeId}`} role="group" aria-label={aria}>
  <QuicksaveControls
    {nodeId}
    {slots}
    {pendingMode}
    {queuedSlot}
    {lastLoadedSlot}
    {isPlaying}
    showLabel={false}
    showPlay={false}
    faceTestidBase="score-slots"
    {onSetMode}
    {onSlotClick}
    {onPlayToggle}
    {onReset}
  />
</div>

<style>
  .score-slots {
    display: block;
    width: 100%;
  }
</style>
