<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  import { onMount } from 'svelte';
  import { skinStore } from '$lib/ui/skins/skin-store.svelte';
  import { ClerkProvider } from 'svelte-clerk';
  import { page } from '$app/state';
  import { ydoc, patch, bindRackspace } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';
  import { createSharedClock } from '$lib/audio/shared-clock.svelte';
  import { setActiveSharedClock } from '$lib/audio/modules/lfo';
  import {
    attemptSpawn as carlAttemptSpawn,
    clearSession as carlClearSession,
    readCarlSession,
    publishLeaderCandidacy as carlPublishCandidacy,
    withdrawLeaderCandidacy as carlWithdrawCandidacy,
    readLeader as carlReadLeader,
  } from '$lib/carl/session-leader-elected';
  import { buildCatalogFromRegistry } from '$lib/carl/catalog';
  import { createCarlController, type CarlController } from '$lib/carl/controller';
  import { evictCarlPatch } from '$lib/carl/driver';
  import {
    attemptSpawn as mikeAttemptSpawn,
    clearSession as mikeClearSession,
    readMikeSession,
    publishLeaderCandidacy as mikePublishCandidacy,
    withdrawLeaderCandidacy as mikeWithdrawCandidacy,
    readLeader as mikeReadLeader,
  } from '$lib/mike/session-leader-elected';
  import { buildCatalogFromRegistry as buildMikeCatalogReg } from '$lib/mike/catalog';
  import { createMikeController, type MikeController } from '$lib/mike/controller';
  import { evictMikePatch } from '$lib/mike/driver';
  import { readBotSession } from '$lib/bot/session-lock';
  import { testHooksEnabled } from '$lib/dev/test-hooks';

  let { data, children } = $props();

  // Apply the user's saved skin (localStorage["pt.skin"]) on EVERY route.
  // The skin-store singleton reads + applies it to <html> in its constructor,
  // but it was previously imported ONLY by canvas components (Canvas /
  // SkinSwitcher / Fader) — so non-canvas routes (dashboard, sign-in, docs)
  // and any hard reload fell back to the default theme. The most visible
  // symptom: deleting a rackspace does a full reload of the dashboard, which
  // re-parsed <html> and dropped the imperatively-applied skin vars. Importing
  // the store here and re-asserting on mount keeps the chosen skin applied
  // app-wide and across reloads. setSkin(current, persist=false) re-applies
  // the already-loaded skin without rewriting localStorage.
  onMount(() => {
    skinStore.setSkin(skinStore.current, false);
  });

  // Stage B PR B-b: expose attachProvider as a dev global so Playwright
  // @collab + @capacity + @auth tests can wire browser contexts to the
  // same Hocuspocus doc without going through Clerk auth on /r/[id].
  // Server validates tokens (PR-D) — tests derive a valid `anon:<code>`
  // via the same dev-only HMAC secret used by lib/server/invites.ts and
  // packages/server/src/auth.ts. Tests can also pass an explicit `token`
  // to drive the rejection paths (e.g. `'clerk:invalid'`).
  //
  // Gated on testHooksEnabled() (NOT bare import.meta.env.DEV): these hooks
  // must also be present in the prebuilt `vite preview` bundle the e2e shards
  // run against (E2E_USE_PREVIEW=1), which is a PROD build where
  // import.meta.env.DEV is false. testHooksEnabled() returns true under DEV
  // *or* when VITE_E2E_HOOKS=1 is baked in at build time (the autotest/dev
  // deploy + the build-web CI job set it). Same gate Canvas.svelte uses for
  // its __patch/__ydoc/__ensureEngine globals — keep them in lockstep, else
  // every @collab/@auth/@clock-sync/livecode spec fails under preview with
  // "__attachProvider is not a function". Plain prod (flag unset) ships this
  // code but never installs the globals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _activeProviderRef: any = null;
  if (testHooksEnabled() && typeof window !== 'undefined') {
    // MUST stay in lockstep with the dev fallback in invites.ts and
    // auth.ts. If you change one, change all three.
    const DEV_INVITE_SECRET = 'dev-only-invite-secret-change-me-x'.padEnd(32, '_');
    const deriveAnonToken = async (docName: string): Promise<string> => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(DEV_INVITE_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(docName));
      let hex = '';
      for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
      return `anon:${hex.slice(0, 16)}`;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__attachProvider = async (rackspaceId: string, token?: string) => {
      // Bind the singleton patch/ydoc to a fresh doc for this rackspace
      // BEFORE attaching the provider. Without this, the dev-on-/ flow
      // (used by e2e specs that simulate multi-rackspace navigation in
      // one tab) would re-attach to the previous rackspace's leftover
      // doc and corrupt the new room — same bug the prod /r/[id] route
      // hits. After bindRackspace, the imported `ydoc` binding points at
      // the freshly created Y.Doc, which is what we hand to attachProvider.
      const bound = bindRackspace(rackspaceId);
      const effectiveToken = token ?? (await deriveAnonToken(rackspaceId));
      let onCapacityRejected: () => void = () => {};
      let onAuthRejected: (r: string) => void = () => {};
      const provider = attachProvider({
        rackspaceId,
        ydoc: bound.ydoc,
        token: effectiveToken,
        debug: true,
        onCapacityRejected: () => onCapacityRejected(),
        onAuthRejected: (reason) => onAuthRejected(reason),
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`provider sync timeout for ${rackspaceId}`)),
          5000,
        );
        onCapacityRejected = () => {
          clearTimeout(timeout);
          reject(new Error('rackspace-full'));
        };
        onAuthRejected = (reason) => {
          clearTimeout(timeout);
          reject(new Error(reason || 'unauthorized'));
        };
        provider.on('synced', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      _activeProviderRef = provider;
      // Also stash on globalThis so Canvas.svelte's provideProviderContext
      // fallback can hand it to descendant cards (DoomCard's awareness
      // wiring etc.) on the public `/` canvas, where the parent doesn't
      // pass a `provider` prop. Dev-only path; prod /r/[id] still owns
      // the prop-based provider.
      (window as unknown as { __provider?: unknown }).__provider = provider;
      // Refresh the __patch / __ydoc globals so tests that switched
      // rackspaces in this tab see the FRESH proxies, not the previous
      // rackspace's. Canvas.svelte sets these inside an $effect that only
      // reruns on remount, which doesn't happen on `/`.
      (window as unknown as { __patch?: unknown }).__patch = bound.patch;
      (window as unknown as { __ydoc?: unknown }).__ydoc = bound.ydoc;
      return provider;
    };

    // Stage B PR B-c: small awareness helpers so @collab tests can publish
    // a presence identity + cursor without needing to plumb the provider
    // reference back through Playwright's evaluate() (HocuspocusProvider
    // doesn't survive structured-clone serialization).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setAwarenessUser = (user: { id: string; displayName: string; color: string }) => {
      const a = _activeProviderRef?.awareness;
      if (!a) return false;
      a.setLocalStateField('user', user);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setAwarenessCursor = (x: number, y: number) => {
      const a = _activeProviderRef?.awareness;
      if (!a) return false;
      a.setLocalStateField('cursor', { x, y });
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__getAwarenessStates = () => {
      const a = _activeProviderRef?.awareness;
      if (!a) return [];
      const out: Array<{ clientId: number; user?: unknown; cursor?: unknown }> = [];
      for (const [clientId, state] of a.getStates()) {
        out.push({ clientId, ...(state as object) });
      }
      return out;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__getLocalClientId = () => {
      return _activeProviderRef?.awareness?.clientID ?? null;
    };

    // Phase 0 of shared-state-sync: dev hook so @clock-sync Playwright
    // tests can spin up a SharedClock against the active provider
    // without needing to render /r/[id] (Clerk-protected). Idempotent —
    // a second call returns the same handle.
    let _sharedClockRef: ReturnType<typeof createSharedClock> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__createSharedClock = () => {
      if (_sharedClockRef) return _sharedClockRef;
      if (!_activeProviderRef) throw new Error('__attachProvider must be called first');
      _sharedClockRef = createSharedClock({ provider: _activeProviderRef, ydoc });
      setActiveSharedClock(_sharedClockRef);
      return _sharedClockRef;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__sharedClock = () => _sharedClockRef;

    // Compute the deterministic phase a SyncedModuleDef LFO instance
    // would produce *now* on this client. Calls through computeStateAt,
    // so it matches the worklet's output to within the smoothing window
    // and verifies that two clients with the same epoch see the same
    // phase. Returns null until the shared clock has converged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__lfoPhase = async (nodeId: string) => {
      const clock = _sharedClockRef;
      if (!clock) return null;
      const sharedNow = clock.sharedTimeNow();
      const epoch = clock.epoch_ms;
      if (sharedNow === null || epoch === null) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch = (window as any).__patch as
        | { nodes: Record<string, { type: string; params?: Record<string, number> }> }
        | undefined;
      const node = patch?.nodes[nodeId];
      if (!node || node.type !== 'lfo') return null;
      const { lfoDef } = await import('$lib/audio/modules/lfo');
      const state = lfoDef.computeStateAt(sharedNow - epoch, node.params ?? { rate: 1 }, () => 0);
      return state.phase;
    };

    // Like __lfoPhase, but evaluates the LFO at a CALLER-SUPPLIED shared
    // time (in ms). The previous helper sampled `clock.sharedTimeNow()`
    // inside each tab — and because each tab's `performance.now()` epoch
    // is independent (CDP latency from Playwright + JS-engine pauses
    // between `Promise.all` legs), two tabs sampling "now" can land
    // 5–10 ms apart in shared-time. At rate=1 Hz, 10 ms is 3.6° of
    // phase — nearly 4× the 1° tolerance the test cares about, so the
    // test was effectively measuring sample-time jitter rather than
    // shared-clock convergence.
    //
    // Passing an EXPLICIT shared-time eliminates that jitter entirely:
    // both tabs do the same arithmetic on the same input, so the only
    // remaining delta is whether their `epoch_ms` agrees (the property
    // we actually want to assert). Returns null until the shared clock
    // has converged + has a published epoch.
    // Rackspace Carl — Approach B dev hooks so e2e tests can drive the
    // session API + leader-election against `/` (no Clerk required).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let _carlController: CarlController | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlAttemptSpawn = (
      ownerUserId: string,
      displayName: string,
      seed?: number,
    ) => {
      return carlAttemptSpawn(ydoc, {
        ownerUserId,
        ownerDisplayName: displayName,
        spawnedAt: Date.now(),
        seed: seed ?? Math.floor(Date.now() % 0x7fffffff),
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlReadSession = () => readCarlSession(ydoc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlClearSession = () => carlClearSession(ydoc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlPublishCandidacy = () => {
      if (!_activeProviderRef?.awareness) return false;
      carlPublishCandidacy(_activeProviderRef.awareness);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlWithdrawCandidacy = () => {
      if (!_activeProviderRef?.awareness) return false;
      carlWithdrawCandidacy(_activeProviderRef.awareness);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlReadLeader = () => carlReadLeader(_activeProviderRef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlStartLoop = (opts?: { seed?: number; baseTickMs?: number }) => {
      if (_carlController) return false;
      const catalog = buildCatalogFromRegistry();
      _carlController = createCarlController({
        catalog,
        driver: { patch, ydoc },
        seed: opts?.seed,
        baseTickMs: opts?.baseTickMs ?? 150,
      });
      _carlController.start();
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlStopLoop = () => {
      _carlController?.stop();
      _carlController = null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__carlEvictPatch = () => evictCarlPatch({ patch, ydoc }, 'carl');

    // ---------- Meticulous Mike dev hooks (mirror of Carl's) ----------
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let _mikeController: MikeController | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeAttemptSpawn = (
      ownerUserId: string,
      displayName: string,
      seed?: number,
    ) => {
      return mikeAttemptSpawn(ydoc, {
        ownerUserId,
        ownerDisplayName: displayName,
        spawnedAt: Date.now(),
        seed: seed ?? Math.floor(Date.now() % 0x7fffffff),
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeReadSession = () => readMikeSession(ydoc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeClearSession = () => mikeClearSession(ydoc);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikePublishCandidacy = () => {
      if (!_activeProviderRef?.awareness) return false;
      mikePublishCandidacy(_activeProviderRef.awareness);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeWithdrawCandidacy = () => {
      if (!_activeProviderRef?.awareness) return false;
      mikeWithdrawCandidacy(_activeProviderRef.awareness);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeReadLeader = () => mikeReadLeader(_activeProviderRef);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeStartLoop = (opts?: { seed?: number; baseTickMs?: number; maxTickMs?: number }) => {
      if (_mikeController) return false;
      const catalog = buildMikeCatalogReg();
      _mikeController = createMikeController({
        catalog,
        driver: { patch, ydoc },
        seed: opts?.seed,
        baseTickMs: opts?.baseTickMs ?? 150,
        maxTickMs: opts?.maxTickMs ?? 400,
      });
      _mikeController.start();
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeStopLoop = () => {
      _mikeController?.stop();
      _mikeController = null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mikeEvictPatch = () => evictMikePatch({ patch, ydoc }, 'mike');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__readBotSession = () => readBotSession(ydoc);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__lfoPhaseAt = async (nodeId: string, sharedTimeMs: number) => {
      const clock = _sharedClockRef;
      if (!clock) return null;
      const epoch = clock.epoch_ms;
      if (epoch === null) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch = (window as any).__patch as
        | { nodes: Record<string, { type: string; params?: Record<string, number> }> }
        | undefined;
      const node = patch?.nodes[nodeId];
      if (!node || node.type !== 'lfo') return null;
      const { lfoDef } = await import('$lib/audio/modules/lfo');
      const state = lfoDef.computeStateAt(sharedTimeMs - epoch, node.params ?? { rate: 1 }, () => 0);
      return state.phase;
    };

    // Rackspace seed hook — wraps POST /api/test/seed-rackspace so e2e specs
    // can spin up a fresh /r/[id] route without a Clerk session. Returns
    // { id, inviteCode } the spec then uses to build /r/<id>?invite=<code>.
    // The server endpoint is gated on RACKSPACE_SEED_ENABLED='1' OR
    // NODE_ENV='development' — neither is set on prod, so this hook can be
    // present even on the public bundle without risk.
    //
    // Optional `envelope` is a PatchEnvelope object (see lib/graph/persistence)
    // whose base64 `update` field is stored verbatim into rack_snapshots so
    // the Hocuspocus relay serves it on first connect. Pass `undefined` for
    // a fresh empty rackspace.
    interface SeedEnvelope { envelopeVersion: number; update: string }
    interface SeedResp { id: string; inviteCode: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__seedRackspace = async (
      envelope?: SeedEnvelope,
      opts?: { name?: string; ownerUserId?: string },
    ): Promise<SeedResp> => {
      const body: Record<string, unknown> = {};
      if (envelope !== undefined) body.envelope = envelope;
      if (opts?.name) body.name = opts.name;
      if (opts?.ownerUserId) body.ownerUserId = opts.ownerUserId;
      const r = await fetch('/api/test/seed-rackspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '<no body>');
        throw new Error(`__seedRackspace failed: ${r.status} ${text.slice(0, 200)}`);
      }
      return (await r.json()) as SeedResp;
    };
  }

  // Clerk's JS bundle is loaded cross-origin from clerk.accounts.dev. The
  // canvas routes are cross-origin isolated for SAB (Faust prereq). We keep
  // ClerkProvider scoped to the auth routes (which carry NO isolation headers)
  // so Clerk's widgets/CDN load unconditionally, leaving the public canvas at
  // `/` free to use SharedArrayBuffer. (The canvas COEP is now `credentialless`
  // rather than `require-corp`, which would also let a no-cors CDN bundle load,
  // but auth simply doesn't need to run on the isolated canvas routes.) Same
  // prefix list hooks.server.ts uses to scope the server handle.
  const AUTH_PREFIXES = ['/dashboard', '/r/', '/sign-in', '/sign-up'];
  let isAuthRoute = $derived(
    AUTH_PREFIXES.some((p) => page.url.pathname === p || page.url.pathname.startsWith(p)),
  );
</script>

{#if isAuthRoute}
  <ClerkProvider {...data}>
    {@render children()}
  </ClerkProvider>
{:else}
  {@render children()}
{/if}
