<script lang="ts">
  // CADILLAC overlay — renders the car (a sprite) driving across the
  // canvas + emits ephemeral explosion divs at hit points. MUST be
  // rendered as a child of `<SvelteFlow>` so `useSvelteFlow()` resolves.
  //
  // Determinism contract: the car's position is a pure function of
  // (now - spawnedAtMs, speed, startX). Every connected client computes
  // the same position from the same Yjs node.data, so we never broadcast
  // car positions via awareness (memory `relay-single-process-and-drift`).
  //
  // Mutation ownership: ONLY the spawner writes deletes. We compare
  // `data.spawnerClientId` to `provider.awareness.clientID` — non-spawner
  // clients just animate the car for visual coherence. (In single-user /
  // no-provider mode, we always own the writes.)
  //
  // Snapshot subscription follows the PR #432 rebind contract:
  // subscribe via `getDefaultSnapshotBus()` so a rackspace switch
  // re-points the bus at the new doc without losing our subscriber.
  import { onMount } from 'svelte';
  import { useSvelteFlow } from '@xyflow/svelte';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import { getDefaultSnapshotBus, type PatchSnapshot } from '$lib/graph/snapshot';
  import { patch, ydoc, LOCAL_ORIGIN } from '$lib/graph/store';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import {
    currentX,
    leftmostOtherX,
    hits,
    shouldSelfDestruct,
    type OtherNode,
  } from '$lib/cadillac/collision';

  interface Props {
    provider?: HocuspocusProvider | null;
  }

  let { provider = null }: Props = $props();

  const CADILLAC_TYPE = 'cadillac';
  // Car dimensions in flow-space. Sprite is 750x187; we render at half
  // size so the car fits a typical module-spaced canvas without looking
  // cartoonishly huge.
  const CAR_W = 375;
  const CAR_H = 94;
  const SPEED_PX_PER_SEC = 300;
  const EXPLOSION_LIFE_MS = 600;

  const bus = getDefaultSnapshotBus();
  const flow = useSvelteFlow();

  let snapshot = $state.raw<PatchSnapshot>(bus.current());
  // Ephemeral explosions — id => screen-space center, mounted-at-ms.
  // Keyed each block so Svelte's keyed-each can clean up DOM properly.
  let explosions = $state<{ id: string; x: number; y: number; t: number }[]>([]);
  // Tick counter forces a re-eval of derived position values from rAF.
  let frameTick = $state(0);

  $effect(() => {
    const off = bus.subscribe((snap) => {
      snapshot = snap;
    });
    return () => off();
  });

  // rAF loop — runs whenever a CADILLAC node exists. Cheap when none;
  // the loop's first read of `snapshot.nodes` short-circuits.
  let rafHandle = 0;
  onMount(() => {
    function tick() {
      frameTick++;
      rafHandle = requestAnimationFrame(tick);
    }
    rafHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafHandle);
  });

  type CadillacNode = {
    id: string;
    position: { x: number; y: number };
    data: { spawnerClientId?: number; spawnedAtMs?: number; [k: string]: unknown };
  };

  // Find every cadillac in the snapshot. There should be at most one
  // (singleton enforced via maxInstances + palette filter) but we live
  // with the rare race-spawn case by handling N>=0 uniformly.
  const cadillacs = $derived.by<CadillacNode[]>(() => {
    void frameTick; // keep this derived running each rAF
    const out: CadillacNode[] = [];
    for (const n of snapshot.nodes) {
      if (n.type === CADILLAC_TYPE) {
        const data = (n.data ?? {}) as Record<string, unknown>;
        out.push({
          id: n.id,
          position: { x: n.position.x, y: n.position.y },
          data: data as CadillacNode['data'],
        });
      }
    }
    return out;
  });

  // Per-cadillac render state — current screen-space rect + whether
  // we (this client) own writes.
  const carRenders = $derived.by(() => {
    void frameTick;
    const now = Date.now();
    return cadillacs.map((car) => {
      const spawnedAtMs = car.data.spawnedAtMs ?? now;
      const startX = car.position.x;
      const xFlow = currentX(now, spawnedAtMs, SPEED_PX_PER_SEC, startX);
      const yFlow = car.position.y;
      let screen: { x: number; y: number; w: number; h: number } | null = null;
      try {
        const tl = flow.flowToScreenPosition({ x: xFlow, y: yFlow });
        const br = flow.flowToScreenPosition({ x: xFlow + CAR_W, y: yFlow + CAR_H });
        screen = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
      } catch {
        // useSvelteFlow can throw transiently during teardown; render
        // nothing this frame.
        screen = null;
      }
      const ownsWrites =
        provider?.awareness?.clientID === car.data.spawnerClientId ||
        provider == null;
      return {
        id: car.id,
        car,
        xFlow,
        yFlow,
        screen,
        ownsWrites,
        spawnedAtMs,
      };
    });
  });

  // Side-effect: collision check + delete + self-destruct. Only the
  // spawner runs this; remote clients just watch.
  $effect(() => {
    void frameTick;
    if (cadillacs.length === 0) return;
    const now = Date.now();
    for (const r of carRenders) {
      if (!r.ownsWrites) continue;
      const car = r.car;
      // Gather "others" — every snapshot node that isn't a cadillac
      // and isn't undeletable. Pull measured size from xyflow so the
      // collision rectangles match what the user sees.
      const others: OtherNode[] = [];
      const undeletableIds = new Set<string>();
      for (const n of snapshot.nodes) {
        if (n.id === car.id) continue;
        if (n.type === CADILLAC_TYPE) continue;
        const def = defLookup(n.type);
        if (def?.undeletable) {
          undeletableIds.add(n.id);
          continue;
        }
        const internal = (() => {
          try {
            return flow.getInternalNode(n.id);
          } catch {
            return undefined;
          }
        })();
        const w = internal?.measured?.width;
        const h = internal?.measured?.height;
        others.push({
          id: n.id,
          position: { x: n.position.x, y: n.position.y },
          width: w,
          height: h,
        });
      }

      const carAABB = { x: r.xFlow, y: r.yFlow, width: CAR_W, height: CAR_H };
      const victims = hits(carAABB, others);
      if (victims.length > 0) {
        ydoc.transact(() => {
          for (const vid of victims) {
            // Edges first — same pattern as Canvas.deleteNode so the
            // engine sees a clean disconnect before disposal.
            for (const [eid, edge] of Object.entries(patch.edges)) {
              if (!edge) continue;
              if (edge.source?.nodeId === vid || edge.target?.nodeId === vid) {
                delete patch.edges[eid];
              }
            }
            delete patch.nodes[vid];
          }
        }, LOCAL_ORIGIN);
        // Render explosions at each victim's screen-space center.
        for (const vid of victims) {
          const internal = flow.getInternalNode(vid);
          const w = internal?.measured?.width ?? 80;
          const h = internal?.measured?.height ?? 80;
          // Use the *flow* position from the snapshot rather than
          // internals.positionAbsolute, since we've just deleted the
          // node and xyflow's internals may already be torn down.
          const snapNode = snapshot.nodes.find((n) => n.id === vid);
          const cx = (snapNode?.position.x ?? 0) + w / 2;
          const cy = (snapNode?.position.y ?? 0) + h / 2;
          try {
            const pt = flow.flowToScreenPosition({ x: cx, y: cy });
            explosions = [
              ...explosions,
              { id: `${vid}-${now}`, x: pt.x, y: pt.y, t: now },
            ];
          } catch {
            /* ignore — overlay teardown */
          }
        }
        // Prune expired explosions on every emit.
        explosions = explosions.filter((e) => now - e.t < EXPLOSION_LIFE_MS);
      } else {
        // No-op except prune expired explosions (cheap).
        if (explosions.length > 0) {
          const fresh = explosions.filter((e) => now - e.t < EXPLOSION_LIFE_MS);
          if (fresh.length !== explosions.length) explosions = fresh;
        }
      }

      // Self-destruct check.
      const lm = leftmostOtherX(
        others.map((o) => ({ id: o.id, position: o.position })),
        car.id,
        undeletableIds,
      );
      if (
        shouldSelfDestruct({
          now,
          spawnedAtMs: r.spawnedAtMs,
          currentCarX: r.xFlow,
          leftmost: lm,
        })
      ) {
        ydoc.transact(() => {
          // Cadillac has no edges (no ports) but defend anyway.
          for (const [eid, edge] of Object.entries(patch.edges)) {
            if (!edge) continue;
            if (
              edge.source?.nodeId === car.id ||
              edge.target?.nodeId === car.id
            ) {
              delete patch.edges[eid];
            }
          }
          delete patch.nodes[car.id];
        }, LOCAL_ORIGIN);
      }
    }
  });

  // Union-typed def lookup — mirrors Canvas's defLookup so the
  // undeletable read works for every domain.
  function defLookup(type: string):
    | { undeletable?: boolean }
    | undefined {
    return (
      getModuleDef(type) ??
      getVideoModuleDef(type) ??
      getMetaModuleDef(type)
    );
  }
</script>

<div class="cadillac-overlay" data-testid="cadillac-overlay" aria-hidden="true">
  {#each carRenders as r (r.id)}
    {#if r.screen}
      <img
        class="cadillac-car"
        data-testid="cadillac-car"
        data-cadillac-id={r.id}
        src="/img/cadillac.png"
        alt=""
        style="left:{r.screen.x}px; top:{r.screen.y}px; width:{r.screen.w}px; height:{r.screen.h}px;"
      />
    {/if}
  {/each}
  {#each explosions as e (e.id)}
    <div
      class="cadillac-explosion"
      data-testid="cadillac-explosion"
      style="left:{e.x}px; top:{e.y}px;"
    >
      💥
    </div>
  {/each}
</div>

<style>
  .cadillac-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* Sit above the SvelteFlow node layer (z-index ~5) and below
       toolbars/menus (z-index ~50). */
    z-index: 20;
    overflow: hidden;
  }
  .cadillac-car {
    position: absolute;
    user-select: none;
    -webkit-user-drag: none;
    /* The PNG carries its own alpha; no extra mask needed. */
    image-rendering: auto;
    filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.35));
  }
  .cadillac-explosion {
    position: absolute;
    font-size: 64px;
    line-height: 1;
    transform: translate(-50%, -50%);
    animation: cadillac-explosion-fade 600ms ease-out forwards;
    text-shadow: 0 0 12px rgba(255, 200, 0, 0.9);
    pointer-events: none;
  }
  @keyframes cadillac-explosion-fade {
    0% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(0.7);
    }
    30% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.2);
    }
    100% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(1.6);
    }
  }
</style>
