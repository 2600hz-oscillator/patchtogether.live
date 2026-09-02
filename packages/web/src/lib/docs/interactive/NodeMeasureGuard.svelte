<script lang="ts">
  // NodeMeasureGuard — re-drives xyflow's node measurement until it actually
  // lands, and reports the node's OWN readiness upward.
  //
  // WHY THIS EXISTS (the /docs/modules/[id] "card is permanently invisible" bug)
  //
  // xyflow measures a node exactly TWICE, and both attempts are one-shot:
  //   1. NodeWrapper's first-render `$effect` schedules ONE
  //      `requestAnimationFrame(() => store.updateNodeInternals(...))`.
  //   2. NodeRenderer's shared `ResizeObserver` delivers ONE callback when the
  //      node element is first observed.
  //
  // `updateNodeInternals` (store/index.js → @xyflow/system) DROPS an update,
  // silently and without retrying, when either
  //   * `domNode` has no `.xyflow__viewport` yet, or
  //   * `getDimensions(el)` reads `offsetWidth`/`offsetHeight` as 0
  //     (`doUpdate = !!(dimensions.width && dimensions.height && …)`).
  //
  // A dropped pair is PERMANENT: the element's real size never changes
  // afterwards, so the ResizeObserver never fires a second time. `node.measured`
  // stays undefined → `nodeHasDimensions()` is false → NodeWrapper renders
  // `style:visibility="hidden"` forever, and `fitView` never resolves (the
  // viewport keeps its identity `translate(0px, 0px) scale(1)` transform).
  //
  // The card is then in the DOM, laid out, with a real bounding box — and
  // invisible. Every faceplate control inside it is `hidden`, so a doc reader
  // sees a blank slate panel and Playwright sees an element that resolves but
  // never becomes visible.
  //
  // The docs sandbox is the surface where this is reachable: unlike the rack
  // canvas, it mounts SvelteFlow LAZILY into an already-live page (behind the
  // dynamic card-map + xyflow import), so the two measurement attempts land in
  // a frame the page did not control.
  //
  // The guard re-drives measurement from inside the flow context until the node
  // reports itself measured — the node's own observable, not a proxy for it —
  // and is bounded so a genuinely zero-size card cannot spin forever.

  import { useUpdateNodeInternals } from '@xyflow/svelte';

  interface Props {
    /** Flow node id to keep measured. */
    id: string;
    /** Fired once the node reports measured dimensions (xyflow un-hides it). */
    onmeasured?: () => void;
  }

  let { id, onmeasured }: Props = $props();

  const updateNodeInternals = useUpdateNodeInternals();

  // Give xyflow's own two attempts a couple of frames before intervening, so
  // the happy path costs nothing (it exits on frame 1-2, having done one
  // querySelector and no re-measure at all).
  const GRACE_FRAMES = 2;
  // Re-drive every Nth frame rather than every frame: `updateNodeInternals`
  // defers its own work by one `requestAnimationFrame`, so hammering it each
  // frame only stacks pending callbacks.
  const RETRY_EVERY_FRAMES = 4;
  // Bound in FRAMES + ATTEMPTS, never in milliseconds: this is renderer-paced
  // work, so a frame budget survives a starved CPU that a wall-clock budget
  // would not — the SAME reason the e2e waits are frame- or state-based. 150
  // attempts is 600 frames, and it only ever runs while the node is still
  // unmeasured (i.e. while the card is invisible and the page is visibly
  // broken); a healthy mount never reaches attempt 1.
  const MAX_ATTEMPTS = 150;

  $effect(() => {
    let raf = 0;
    let frames = 0;
    let attempts = 0;

    const tick = () => {
      const el = document.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${id}"]`);
      // `style.visibility` is exactly what NodeWrapper writes from
      // `nodeHasDimensions(node)`, so it IS the node's measured state — not a
      // correlate of it.
      if (el && el.style.visibility !== 'hidden') {
        onmeasured?.();
        return;
      }
      if (attempts >= MAX_ATTEMPTS) return;
      if (el && frames >= GRACE_FRAMES && frames % RETRY_EVERY_FRAMES === 0) {
        updateNodeInternals(id);
        attempts += 1;
      }
      frames += 1;
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>
