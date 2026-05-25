<script lang="ts">
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { UserButton, SignOutButton, getToken, useClerkContext } from 'svelte-clerk';
  import Canvas from '$lib/ui/Canvas.svelte';
  import AudioGate from '$lib/ui/AudioGate.svelte';
  import FeedbackBox from '$lib/ui/FeedbackBox.svelte';
  import { createAudioGate } from '$lib/audio/audio-gate.svelte';
  import { ydoc, patch } from '$lib/graph/store';
  import { makeEnvelope } from '$lib/graph/persistence';
  import { attachProvider } from '$lib/multiplayer/provider';
  import { createCarlController, type CarlController } from '$lib/carl/controller';
  import { buildCatalogFromRegistry } from '$lib/carl/catalog';
  import {
    attemptSpawn as attemptCarlSpawn,
    clearSession as clearCarlSession,
    observeSession as observeCarlSession,
    publishLeaderCandidacy,
    withdrawLeaderCandidacy,
    observeLeader,
    type CarlSessionRecord,
    type CarlLeaderInfo,
  } from '$lib/carl/session-leader-elected';
  import { evictCarlPatch } from '$lib/carl/driver';
  import { createMikeController, type MikeController } from '$lib/mike/controller';
  import { buildCatalogFromRegistry as buildMikeCatalog } from '$lib/mike/catalog';
  import {
    attemptSpawn as attemptMikeSpawn,
    clearSession as clearMikeSession,
    observeSession as observeMikeSession,
    publishLeaderCandidacy as publishMikeCandidacy,
    withdrawLeaderCandidacy as withdrawMikeCandidacy,
    observeLeader as observeMikeLeader,
    type MikeSessionRecord,
    type MikeLeaderInfo,
  } from '$lib/mike/session-leader-elected';
  import { evictMikePatch } from '$lib/mike/driver';
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
      // Publish rack ownership so per-module arbiter election (DOOM host /
      // player-0) prefers the owner over a lex-min tiebreak.
      isRackOwner:
        !!data.rackspace.ownerUserId &&
        !!data.currentUserId &&
        data.rackspace.ownerUserId === data.currentUserId,
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

  // ---------- Rackspace Carl (Approach B: Leader-Elected) ----------
  //
  // - Spawn/86 buttons are visible ONLY for authed users (data.isAnon=false).
  // - At most one Carl per rackspace; exclusivity = `active` flag in
  //   the carlSession Y.Map.
  // - Tick loop runs in the LEADER's tab. Leader = lowest awareness
  //   clientID among peers who have published a carlLeader candidacy
  //   field. Election re-runs on every awareness change, so when the
  //   current leader's tab closes, the next-lowest takes over within
  //   the awareness GC window (~30 s by default; we don't accelerate
  //   it here, the natural cadence is fine for a musical bot).
  // - Any participant (not just the spawner) can 86 Carl.
  let carlSession = $state<CarlSessionRecord | null>(null);
  let carlLeader = $state<CarlLeaderInfo>({
    leaderClientId: null,
    isLocalLeader: false,
    candidates: [],
  });
  let carlController: CarlController | null = $state(null);

  // Subscribe to session changes.
  $effect(() => {
    if (!data.isMember) return;
    return observeCarlSession(ydoc, (rec) => {
      carlSession = rec;
    });
  });

  // Subscribe to leader changes via Y.Awareness.
  $effect(() => {
    if (!provider) return;
    return observeLeader(provider, (info) => {
      carlLeader = info;
    });
  });

  // Whenever a session is active AND we have a provider, publish our
  // candidacy for the election. When the session goes inactive or our
  // provider tears down, withdraw.
  $effect(() => {
    if (!provider?.awareness) return;
    if (!carlSession?.active) return;
    publishLeaderCandidacy(provider.awareness as unknown as Parameters<typeof publishLeaderCandidacy>[0]);
    return () => {
      if (provider?.awareness) {
        withdrawLeaderCandidacy(provider.awareness as unknown as Parameters<typeof withdrawLeaderCandidacy>[0]);
      }
    };
  });

  // The actual tick loop runs only on the elected leader.
  $effect(() => {
    if (!carlSession?.active) return;
    if (!carlLeader.isLocalLeader) return;
    const catalog = buildCatalogFromRegistry();
    const ctrl = createCarlController({
      catalog,
      driver: { patch, ydoc },
      seed: carlSession.seed,
      baseTickMs: 600,
    });
    ctrl.start();
    carlController = ctrl;
    return () => {
      ctrl.stop();
      carlController = null;
    };
  });

  function spawnCarl() {
    if (!data.currentUserId) return;
    if (carlSession?.active) return;
    const displayName = presenceUser?.displayName ?? data.currentUserId.slice(0, 8);
    const seed = Math.floor(Date.now() % 0x7fffffff);
    attemptCarlSpawn(ydoc, {
      ownerUserId: data.currentUserId,
      ownerDisplayName: displayName,
      spawnedAt: Date.now(),
      seed,
    });
  }

  function evictCarl() {
    if (!carlSession?.active) return;
    // Stop our own controller if we're the leader (the effect tears
    // down anyway once carlSession.active flips, but stopping eagerly
    // closes the 1-tick window where a pending intent might race the
    // eviction wipe).
    carlController?.stop();
    evictCarlPatch({ patch, ydoc }, 'carl');
    clearCarlSession(ydoc);
  }

  // ---------- Meticulous Mike (sibling bot) ----------
  //
  // Same leader-elected session pattern as Carl, but uses a separate
  // awareness candidacy field (`mikeLeader`) and the shared bot lock for
  // mutual exclusion: spawning Mike while Carl is active is refused at
  // the bot-lock layer, and the UI gates the Spawn button so it's not
  // even clickable in that state.
  let mikeSession = $state<MikeSessionRecord | null>(null);
  let mikeLeader = $state<MikeLeaderInfo>({
    leaderClientId: null,
    isLocalLeader: false,
    candidates: [],
  });
  let mikeController: MikeController | null = $state(null);

  $effect(() => {
    if (!data.isMember) return;
    return observeMikeSession(ydoc, (rec) => {
      mikeSession = rec;
    });
  });

  $effect(() => {
    if (!provider) return;
    return observeMikeLeader(provider, (info) => {
      mikeLeader = info;
    });
  });

  $effect(() => {
    if (!provider?.awareness) return;
    if (!mikeSession?.active) return;
    publishMikeCandidacy(provider.awareness as unknown as Parameters<typeof publishMikeCandidacy>[0]);
    return () => {
      if (provider?.awareness) {
        withdrawMikeCandidacy(provider.awareness as unknown as Parameters<typeof withdrawMikeCandidacy>[0]);
      }
    };
  });

  $effect(() => {
    if (!mikeSession?.active) return;
    if (!mikeLeader.isLocalLeader) return;
    const catalog = buildMikeCatalog();
    const ctrl = createMikeController({
      catalog,
      driver: { patch, ydoc },
      seed: mikeSession.seed,
      // In production Mike pauses 5–15 s between actions (deliberate
      // pacing — see lib/mike/controller.ts).
    });
    ctrl.start();
    mikeController = ctrl;
    return () => {
      ctrl.stop();
      mikeController = null;
    };
  });

  function spawnMike() {
    if (!data.currentUserId) return;
    if (mikeSession?.active) return;
    if (carlSession?.active) return; // belt + suspenders; the bot lock would refuse anyway
    const displayName = presenceUser?.displayName ?? data.currentUserId.slice(0, 8);
    const seed = Math.floor(Date.now() % 0x7fffffff);
    attemptMikeSpawn(ydoc, {
      ownerUserId: data.currentUserId,
      ownerDisplayName: displayName,
      spawnedAt: Date.now(),
      seed,
    });
  }

  function evictMike() {
    if (!mikeSession?.active) return;
    mikeController?.stop();
    evictMikePatch({ patch, ydoc }, 'mike');
    clearMikeSession(ydoc);
  }

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
      {#if carlSession}
        <span
          class="carl-indicator"
          data-testid="carl-indicator"
          title={`Carl spawned by ${carlSession.ownerDisplayName} at ${new Date(carlSession.spawnedAt).toLocaleTimeString()} — currently ticking on clientID ${carlLeader.leaderClientId ?? '?'}${carlLeader.isLocalLeader ? ' (this tab)' : ''}`}
        >
          <span
            class="carl-dot"
            class:carl-dot-leader={carlLeader.isLocalLeader}
            aria-hidden="true"
          ></span>
          Carl by {carlSession.ownerDisplayName}
        </span>
      {/if}
      {#if mikeSession}
        <span
          class="mike-indicator"
          data-testid="mike-indicator"
          title={`Mike spawned by ${mikeSession.ownerDisplayName} at ${new Date(mikeSession.spawnedAt).toLocaleTimeString()} — currently ticking on clientID ${mikeLeader.leaderClientId ?? '?'}${mikeLeader.isLocalLeader ? ' (this tab)' : ''}`}
        >
          <span
            class="mike-dot"
            class:mike-dot-leader={mikeLeader.isLocalLeader}
            aria-hidden="true"
          ></span>
          Mike by {mikeSession.ownerDisplayName}
        </span>
      {/if}
      <span class="bar-spacer"></span>
      {#if !data.isAnon}
        {#if !carlSession}
          <button
            class="carl-btn carl-spawn"
            data-testid="carl-spawn-button"
            onclick={spawnCarl}
            disabled={!!mikeSession}
            title={mikeSession
              ? 'Only one bot at a time — 86 Mike first if you want Carl instead.'
              : 'Spawn Carl — a chaos musician bot that plays with the patch. Anyone in the rack can stop him; he keeps ticking as long as at least one of you is here.'}
          >
            spawn carl
          </button>
        {:else}
          <button
            class="carl-btn carl-evict"
            data-testid="carl-evict-button"
            onclick={evictCarl}
            title="Stop Carl and remove his modules"
          >
            86 carl
          </button>
        {/if}
        {#if !mikeSession}
          <button
            class="mike-btn mike-spawn"
            data-testid="mike-spawn-button"
            onclick={spawnMike}
            disabled={!!carlSession}
            title={carlSession
              ? 'Only one bot at a time — 86 Carl first if you want Mike instead.'
              : 'Spawn Mike — a meticulous musician bot that slowly assembles a tidy, in-key patch. Anyone in the rack can stop him.'}
          >
            spawn mike
          </button>
        {:else}
          <button
            class="mike-btn mike-evict"
            data-testid="mike-evict-button"
            onclick={evictMike}
            title="Stop Mike and remove his modules"
          >
            86 mike
          </button>
        {/if}
      {/if}
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
        {#if data.currentUserId}
          <span class="feedback-slot">
            <FeedbackBox
              rackId={data.rackspace.id}
              getPatchJson={() => makeEnvelope(ydoc)}
            />
          </span>
        {/if}
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
  .carl-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 3px;
    background: #14171c;
    border: 1px solid #404652;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .carl-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--cable-gate, #f97316);
    opacity: 0.5;
  }
  /* Subtle "this tab is the active ticker" cue — bright glow on the
     leader's screen, dim everywhere else. */
  .carl-dot-leader {
    opacity: 1;
    box-shadow: 0 0 6px var(--cable-gate, #f97316);
  }
  .carl-btn {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .carl-btn:hover {
    background: #353a47;
  }
  .carl-btn.carl-spawn {
    border-color: var(--cable-gate, #f97316);
    color: var(--cable-gate, #f97316);
  }
  .carl-btn.carl-evict {
    border-color: var(--cable-cv, #3b82f6);
    color: var(--cable-cv, #3b82f6);
  }
  .carl-btn:disabled,
  .mike-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Mike's indicator + buttons. Mike uses a green tint to differentiate
     from Carl's orange; the "leader glow" rule mirrors Carl's dot. */
  .mike-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 3px;
    background: #14171c;
    border: 1px solid #404652;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
  }
  .mike-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
    opacity: 0.5;
  }
  .mike-dot-leader {
    opacity: 1;
    box-shadow: 0 0 6px #22c55e;
  }
  .mike-btn {
    background: #2a2f3a;
    color: var(--text);
    border: 1px solid #404652;
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .mike-btn:hover:not(:disabled) {
    background: #353a47;
  }
  .mike-btn.mike-spawn {
    border-color: #22c55e;
    color: #22c55e;
  }
  .mike-btn.mike-evict {
    border-color: #f59e0b;
    color: #f59e0b;
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
