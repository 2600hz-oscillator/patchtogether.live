<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './global.css';
  import '$lib/ui/modules/_module-card.css';
  import { ClerkProvider } from 'svelte-clerk';
  import { page } from '$app/state';
  import { ydoc, patch } from '$lib/graph/store';
  import { attachProvider } from '$lib/multiplayer/provider';
  import { createSharedClock } from '$lib/audio/shared-clock.svelte';
  import { setActiveSharedClock } from '$lib/audio/modules/lfo';
  import {
    attemptSpawn as carlAttemptSpawn,
    clearSession as carlClearSession,
    readCarlSession,
  } from '$lib/carl/session-ephemeral';
  import { buildCatalogFromRegistry } from '$lib/carl/catalog';
  import { createCarlController, type CarlController } from '$lib/carl/controller';
  import { evictCarlPatch } from '$lib/carl/driver';

  let { data, children } = $props();

  // Stage B PR B-b: expose attachProvider as a dev global so Playwright
  // @collab + @capacity + @auth tests can wire browser contexts to the
  // same Hocuspocus doc without going through Clerk auth on /r/[id].
  // Server validates tokens (PR-D) — tests derive a valid `anon:<code>`
  // via the same dev-only HMAC secret used by lib/server/invites.ts and
  // packages/server/src/auth.ts. Tests can also pass an explicit `token`
  // to drive the rejection paths (e.g. `'clerk:invalid'`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _activeProviderRef: any = null;
  if (import.meta.env.DEV && typeof window !== 'undefined') {
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
      const effectiveToken = token ?? (await deriveAnonToken(rackspaceId));
      let onCapacityRejected: () => void = () => {};
      let onAuthRejected: (r: string) => void = () => {};
      const provider = attachProvider({
        rackspaceId,
        ydoc,
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
    // Rackspace Carl — Approach A dev hooks so e2e tests can drive the
    // session API + tick loop against `/` (no Clerk required).
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
    (window as any).__carlStartLoop = (opts?: { seed?: number; baseTickMs?: number }) => {
      if (_carlController) return false;
      const catalog = buildCatalogFromRegistry();
      _carlController = createCarlController({
        catalog,
        driver: { patch, ydoc },
        seed: opts?.seed,
        baseTickMs: opts?.baseTickMs ?? 150, // faster in tests
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
  }

  // Clerk's JS bundle is loaded cross-origin from clerk.accounts.dev. With
  // COEP=require-corp on every page (Faust prereq), the browser refuses to
  // load it unless the CDN sends Cross-Origin-Resource-Policy headers — and
  // Clerk's CDN doesn't. So we only mount ClerkProvider on routes that
  // actually need auth, leaving the public canvas at `/` free to use SAB.
  // Same prefix list as hooks.server.ts uses to scope the server handle.
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
