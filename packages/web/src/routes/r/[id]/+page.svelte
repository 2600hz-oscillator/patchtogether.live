<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { UserButton } from 'svelte-clerk';
  import Canvas from '$lib/ui/Canvas.svelte';
  import { ydoc } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';
  import type { HocuspocusProvider } from '@hocuspocus/provider';

  let { data } = $props();
  let joining = $state(false);
  let joinError: string | null = $state(null);

  // Hocuspocus provider wires the existing Yjs doc to the collaboration
  // server so updates flow between participants. Stage B PR B: no auth
  // verification yet (server stub-accepts any token), no layout split (so
  // dragging on one client moves on the other — PR B-b fixes).
  //
  // Only attach for members; non-members see the join page and shouldn't
  // hold an open WebSocket.
  let provider: HocuspocusProvider | null = null;
  $effect(() => {
    if (!data.isMember) return;
    const p = attachProvider({
      rackspaceId: data.rackspace.id,
      ydoc,
      // TODO(stage-b-pr-c): pass Clerk session token here once the server
      // wires Clerk verification in onAuthenticate.
      token: 'stub',
      debug: import.meta.env.DEV,
    });
    provider = p;
    return () => {
      p.destroy();
      provider = null;
    };
  });
  onDestroy(() => {
    provider?.destroy();
  });

  async function join() {
    joining = true;
    joinError = null;
    try {
      const res = await fetch(`/api/rackspaces/${data.rackspace.id}/join`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        joinError = body?.message ?? `Join failed: ${res.status}`;
        return;
      }
      // Reload so the server-side load function re-checks membership.
      window.location.reload();
    } catch (e) {
      joinError = e instanceof Error ? e.message : String(e);
    } finally {
      joining = false;
    }
  }

  async function copyShareUrl() {
    // For owners/members we share an invite URL (?invite=<code>) so the
    // recipient doesn't need to sign in. Bare URL still works for users
    // who have a Clerk account and want to be added as a member.
    const base = `${window.location.origin}${window.location.pathname}`;
    const url = data.inviteCode ? `${base}?invite=${data.inviteCode}` : window.location.href;
    await navigator.clipboard.writeText(url);
  }

  function signInToClaim() {
    // Send the user back to the same URL after sign-in (with invite intact)
    // so the reload re-enters this page authed and they can request membership.
    const here = window.location.pathname + window.location.search;
    goto(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
</script>

<svelte:head><title>{data.rackspace.name || 'Rackspace'} — patchtogether.live</title></svelte:head>

{#if data.isMember}
  <!-- Member or anon-via-invite: render the canvas. The currentUserId
       prop is null for anon, which Canvas interprets as single-user mode
       for layouts (anon users share the default position). The shared
       graph (nodes/edges/params) syncs for everyone. -->
  <div class="rackspace-shell">
    <div class="rackspace-bar">
      {#if data.isAnon}
        <span class="anon-badge" title="Guest viewer">guest</span>
      {:else}
        <a href="/dashboard" class="back">← Dashboard</a>
      {/if}
      <span class="rackspace-name">{data.rackspace.name || 'Untitled'}</span>
      <span class="rackspace-id">{data.rackspace.id}</span>
      <span class="member-count">
        {data.rackspace.memberCount}/{data.rackspace.maxMembers} members
      </span>
      {#if data.isAnon}
        <button
          class="share sign-in"
          onclick={signInToClaim}
          title="Sign in to claim ownership and save your own racks"
        >
          Sign in
        </button>
      {:else}
        <button
          class="share"
          onclick={copyShareUrl}
          title="Copy invite URL — recipients can join without signing in"
        >
          Copy invite URL
        </button>
        <UserButton />
      {/if}
    </div>
    <Canvas currentUserId={data.currentUserId ?? undefined} />
  </div>
{:else}
  <!-- Non-member: prompt to join, or show "full" -->
  <div class="join-page">
    <div class="join-card">
      <h1>Join "{data.rackspace.name || 'this rackspace'}"</h1>
      <p class="meta">
        {data.rackspace.memberCount}/{data.rackspace.maxMembers} members ·
        rackspace ID: <code>{data.rackspace.id}</code>
      </p>

      {#if data.rackspace.memberCount >= data.rackspace.maxMembers}
        <p class="full-msg">
          This rackspace is full ({data.rackspace.maxMembers} members max).
        </p>
        <a href="/dashboard">Back to dashboard</a>
      {:else}
        <button class="primary" onclick={join} disabled={joining}>
          {joining ? 'Joining…' : 'Join rackspace'}
        </button>
        {#if joinError}
          <p class="error">{joinError}</p>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .rackspace-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
  }
  .rackspace-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 16px;
    border-bottom: 1px solid #2a2f3a;
    font-size: 0.8rem;
  }
  .back {
    color: var(--text-dim);
    text-decoration: none;
  }
  .back:hover {
    color: var(--text);
  }
  .rackspace-name {
    font-weight: 500;
  }
  .rackspace-id,
  .member-count {
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .share {
    margin-left: auto;
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .share:hover {
    background: #353a47;
  }
  .share.sign-in {
    margin-left: auto;
    border-color: var(--cable-cv);
    color: var(--cable-cv);
  }
  .anon-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    background: #14171c;
    border: 1px solid #404652;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .join-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    color: var(--text);
    padding: 2rem;
  }
  .join-card {
    border: 1px solid #2a2f3a;
    border-radius: 6px;
    padding: 32px;
    max-width: 400px;
    width: 100%;
  }
  .join-card h1 {
    margin-top: 0;
    font-size: 1.2rem;
  }
  .join-card .meta {
    color: var(--text-dim);
    font-size: 0.85rem;
    margin-bottom: 24px;
  }
  .join-card code {
    font-family: ui-monospace, monospace;
    background: #14171c;
    padding: 1px 5px;
    border-radius: 2px;
  }
  .full-msg {
    color: var(--cable-gate);
  }
  button.primary {
    background: var(--cable-cv);
    color: #1a1d23;
    border: none;
    padding: 10px 20px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: 500;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error {
    color: var(--cable-gate);
    margin-top: 12px;
    font-size: 0.85rem;
  }
</style>
