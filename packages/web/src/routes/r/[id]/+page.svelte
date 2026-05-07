<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { UserButton, SignOutButton, getToken, useClerkContext } from 'svelte-clerk';
  import Canvas from '$lib/ui/Canvas.svelte';
  import AudioGate from '$lib/ui/AudioGate.svelte';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
  import { ydoc } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';
  import {
    resolvePresenceUser,
    getOrCreateAnonTabId,
    type PresenceUser,
    type RemotePresence,
  } from '$lib/multiplayer/presence';
  import type { HocuspocusProvider } from '@hocuspocus/provider';
  import {
    createSharedClock,
    type SharedClockHandle,
  } from '$lib/audio/shared-clock.svelte';
  import { setActiveSharedClock } from '$lib/audio/modules/lfo';

  // Audio gate — Bug 2 (B5): F5 / cold-loads land with no AudioContext
  // (autoplay policy) so we render an overlay that boots the engine and
  // resumes the ctx on first click. Hidden whenever the ctx is `running`.
  const audioGate = createAudioGate();

  let { data } = $props();
  let joining = $state(false);
  let joinError: string | null = $state(null);

  // Stage B PR B-c (awareness): resolve a stable presence identity for this
  // session. Authed users pull displayName from Clerk's reactive context;
  // anon users get a per-tab UUID (sessionStorage) → "guest 1234" + a
  // deterministic palette color derived from that UUID.
  const clerkCtx = data.isAnon ? null : useClerkContext();
  const anonId = data.isAnon ? getOrCreateAnonTabId() : null;
  let presenceUser = $derived.by<PresenceUser | null>(() => {
    if (!data.isMember) return null;
    if (data.isAnon) {
      return resolvePresenceUser({ userId: anonId, isAnon: true });
    }
    const u = clerkCtx?.user;
    const displayName =
      u?.fullName ?? u?.username ?? u?.firstName ?? u?.primaryEmailAddress?.emailAddress ?? null;
    return resolvePresenceUser({
      userId: data.currentUserId ?? null,
      displayName,
      isAnon: false,
    });
  });

  // Hocuspocus provider wires the existing Yjs doc to the collaboration
  // server so updates flow between participants. Stage B PR B: no auth
  // verification yet (server stub-accepts any token), no layout split (so
  // dragging on one client moves on the other — PR B-b fixes).
  //
  // Only attach for members; non-members see the join page and shouldn't
  // hold an open WebSocket.
  let provider: HocuspocusProvider | null = $state(null);
  $effect(() => {
    if (!data.isMember) return;
    // PR-D: token is a callback so Hocuspocus pulls a fresh value on every
    // (re)connect. Anon users carry their HMAC-derived invite code; authed
    // users carry their Clerk session JWT. The server's onAuthenticate
    // verifies one or the other and rejects bad tokens.
    const tokenProvider = async (): Promise<string> => {
      if (data.isAnon) {
        // Anon users land here only after page-server.ts validated the
        // ?invite=<code> query. The page load doesn't expose that code in
        // `data` (we don't want anon users redistributing their own URL),
        // so read it back from the URL for the WS handshake.
        const code = new URLSearchParams(window.location.search).get('invite');
        return `anon:${code ?? ''}`;
      }
      // Authed: getToken() returns a fresh JWT (or null if signed out).
      // If null, send an empty `clerk:` token; server will reject and the
      // page navigates to /sign-in via onAuthRejected.
      const jwt = await getToken();
      return `clerk:${jwt ?? ''}`;
    };
    const p = attachProvider({
      rackspaceId: data.rackspace.id,
      ydoc,
      token: tokenProvider,
      debug: import.meta.env.DEV,
      onCapacityRejected: () => {
        // Server returned `rackspace-full`; route to the friendly page.
        // Use replaceState so the browser back button doesn't bounce
        // them right back to a 4/4 doc and re-trigger the rejection.
        goto(`/r/${data.rackspace.id}/full`, { replaceState: true });
      },
      onAuthRejected: (reason) => {
        // Server rejected the token (signed-out user, expired JWT, or
        // — rare — INVITE_SECRET mismatch between web and server). Send
        // the user to /sign-in with the original rackspace URL so they
        // come back here after auth. The HTTP route loader on /r/[id]
        // already validated the page render, so an anon visitor reaching
        // this branch means their invite was good HTTP-side but the
        // server's HMAC disagrees — an ops issue worth surfacing in the
        // sign-in URL via &reason=.
        const here = window.location.pathname + window.location.search;
        goto(
          `/sign-in?redirect_url=${encodeURIComponent(here)}&reason=${encodeURIComponent(reason)}`,
          { replaceState: true },
        );
      },
    });
    provider = p;
    return () => {
      p.destroy();
      provider = null;
    };
  });

  // Phase 0 of the shared-state-sync plan: shared clock attached once
  // the provider is up. The clock observes heartbeats via the same
  // Awareness channel as cursors; LFO + future SyncedModuleDef instances
  // pull the active clock via `setActiveSharedClock`.
  let sharedClock: SharedClockHandle | null = $state(null);
  $effect(() => {
    if (!provider) return;
    const clock = createSharedClock({ provider, ydoc });
    sharedClock = clock;
    setActiveSharedClock(clock);
    return () => {
      setActiveSharedClock(null);
      clock.destroy();
      sharedClock = null;
    };
  });

  const isOwner = $derived(
    !!data.rackspace.ownerUserId &&
      !!data.currentUserId &&
      data.rackspace.ownerUserId === data.currentUserId,
  );

  function resetSession() {
    if (!sharedClock) return;
    const ok = window.confirm(
      'Reset all clocks to zero? Anyone listening will hear a moment of silence as nodes re-align.',
    );
    if (!ok) return;
    sharedClock.resetEpoch();
  }

  // Subscribe to awareness updates so the rack bar can render a dot per
  // currently-connected user. Includes the local user (so the owner sees
  // their own dot too) — distinct from <AwarenessLayer> which filters
  // local out (you don't render your own ghost cursor).
  let allPresences = $state<RemotePresence[]>([]);
  $effect(() => {
    const p = provider;
    if (!p) {
      allPresences = [];
      return;
    }
    const awareness = p.awareness;
    if (!awareness) return;
    const refresh = () => {
      const all: RemotePresence[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        const s = state as { user?: PresenceUser };
        if (!s?.user) continue;
        all.push({ clientId, user: s.user });
      }
      allPresences = all;
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
      <span class="presence-dots" data-testid="presence-dots" aria-label="Active users">
        {#each allPresences as p (p.clientId)}
          <span
            class="presence-dot"
            data-testid="presence-dot"
            data-user-id={p.user.id}
            style:background={p.user.color}
            title={p.user.displayName}
          ></span>
        {/each}
      </span>
      <span class="bar-spacer"></span>
      {#if data.isAnon}
        <button
          class="share sign-in"
          onclick={signInToClaim}
          title="Sign in to claim ownership and save your own racks"
        >
          Sign in
        </button>
      {:else}
        {#if isOwner}
          <button
            class="reset-session"
            data-testid="reset-session"
            onclick={resetSession}
            disabled={!sharedClock}
            title="Re-broadcast a fresh epoch. All time-driven modules snap back to zero."
          >
            Reset session
          </button>
        {/if}
        <button
          class="share"
          onclick={copyShareUrl}
          title="Copy invite URL — recipients can join without signing in"
        >
          Copy invite URL
        </button>
        <SignOutButton redirectUrl="/">
          <button class="signout" title="Sign out">Sign out</button>
        </SignOutButton>
        <UserButton />
      {/if}
    </div>
    <Canvas
      currentUserId={data.currentUserId ?? undefined}
      {provider}
      {presenceUser}
      {audioGate}
    />
    <AudioGate gate={audioGate} />
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
  .presence-dots {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 2px;
  }
  .presence-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3) inset;
  }
  .bar-spacer {
    flex: 1;
  }
  .reset-session {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .reset-session:hover:not(:disabled) {
    background: #2a2f3a;
    color: var(--text);
  }
  .reset-session:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .share {
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
    border-color: var(--cable-cv);
    color: var(--cable-cv);
  }
  .signout {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .signout:hover {
    background: #2a2f3a;
    color: var(--text);
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
