<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import { readRemotePresence, type RemotePresence } from '$lib/multiplayer/presence';

  interface Props {
    provider: HocuspocusProvider | null;
  }
  let { provider }: Props = $props();

  let remotes = $state<RemotePresence[]>([]);

  $effect(() => {
    const p = provider;
    if (!p) {
      remotes = [];
      return;
    }
    const awareness = p.awareness;
    if (!awareness) return;
    const refresh = () => {
      remotes = readRemotePresence(awareness, awareness.clientID);
    };
    refresh();
    awareness.on('change', refresh);
    awareness.on('update', refresh);
    return () => {
      awareness.off('change', refresh);
      awareness.off('update', refresh);
    };
  });

  onDestroy(() => {
    remotes = [];
  });
</script>

<div class="awareness-layer" data-testid="awareness-layer" aria-hidden="true">
  {#each remotes as r (r.clientId)}
    {#if r.cursor}
      <div
        class="remote-cursor"
        data-testid="remote-cursor"
        data-user-id={r.user.id}
        data-client-id={r.clientId}
        style:transform="translate({r.cursor.x}px, {r.cursor.y}px)"
        style:--cursor-color={r.user.color}
      >
        <svg
          class="cursor-arrow"
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2 2 L14 9 L8 10 L6 15 Z"
            fill="var(--cursor-color)"
            stroke="#0e1116"
            stroke-width="1"
            stroke-linejoin="round"
          />
        </svg>
        <span class="name-pill" data-testid="remote-cursor-name">{r.user.displayName}</span>
      </div>
    {/if}
  {/each}
</div>

<style>
  .awareness-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 5;
  }
  .remote-cursor {
    position: absolute;
    top: 0;
    left: 0;
    transition: transform 80ms linear;
    will-change: transform;
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .cursor-arrow {
    flex: 0 0 auto;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
  }
  .name-pill {
    position: relative;
    margin-top: 14px;
    margin-left: -2px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--cursor-color);
    color: #0e1116;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.7rem;
    line-height: 1;
    white-space: nowrap;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }
</style>
