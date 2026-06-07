// e2e/tests/_helpers.ts
//
// Shared test helpers for spawning arbitrary modules + edges via the dev-mode
// `__patch` and `__ydoc` window globals (Canvas.svelte exposes these in dev).

import { expect, type Page, type APIRequestContext } from '@playwright/test';

export interface SpawnNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  params?: Record<string, number>;
  /** Phase 0 video spike — when omitted, defaults to 'audio'. Tests that
   *  spawn video modules (LINES, OUTPUT) pass 'video' explicitly. The
   *  io-spec consistency test infers it from the registered module def
   *  by reading window.__moduleSpecs first; see that test's spawnPatch
   *  call for the pattern. The 'meta' domain covers non-engine cards
   *  (sticky notes, future paper-like utilities). */
  domain?: 'audio' | 'video' | 'meta';
}

export interface SpawnEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

/**
 * Match the Playwright/CDP errors thrown when the page's execution context
 * is torn down out-of-band during an `evaluate` / `waitForFunction` — most
 * commonly because Vite's HMR client lost its websocket under CPU pressure
 * (parallel-worker stress) and triggered a full reload (`[vite] connecting...`),
 * or because a navigation interrupted an in-flight evaluate. None of these
 * indicate a test-logic failure: the page recovers on its own, we just have
 * to redo the page-side work after it does.
 */
function isTransientPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Execution context was destroyed') ||
    msg.includes('Target closed') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('frame was detached') ||
    msg.includes('Cannot find context with specified id')
  );
}

/**
 * Spawn a set of nodes + edges into the patch graph atomically.
 * Requires the dev-only window globals (Canvas exposes them under `import.meta.env.DEV`).
 *
 * The whole sequence (wait-for-globals → ensureEngine → transact → wait-for-DOM)
 * is wrapped in a bounded retry loop so the helper survives a Vite-HMR full
 * reload mid-spawn: under `--workers=4 --repeat-each=10`+ stress, the dev
 * server's HMR websocket occasionally drops and reconnects, which destroys
 * the page's execution context out from under an in-flight `page.evaluate`.
 * Each retry re-waits for `__ensureEngine` to be re-bound by Canvas's $effect
 * after the reload, then restarts the sequence from scratch. Pre-existing
 * latent flake; Playwright's CI `retries: 1` masked it but it still slowed
 * stress runs. The retry is *not* a band-aid for an avoidable race — HMR
 * reload is async to the test and outside the helper's control; handling it
 * here is the correct seam.
 */
export async function spawnPatch(
  page: Page,
  nodes: SpawnNode[],
  edges: SpawnEdge[] = [],
  /** Override the post-transact "node mounted in the DOM" wait. Defaults to
   *  5000ms. WebGL-heavy cards (b3ntb0x's 8×-oversampled NTSC chain,
   *  mandleblot's GPU fractal) FIRST-paint far slower on CI's SwiftShader
   *  software renderer — even slower at 1024×768 (#662, 2.56× the pixels) —
   *  so the generic 5s readiness wait isn't enough to mount them. Callers
   *  iterating every module (modules.spec.ts) bump this for known-heavy types
   *  whose deep render is covered by a dedicated heavy-lane spec. */
  opts?: { mountTimeout?: number }
): Promise<void> {
  const mountTimeout = opts?.mountTimeout ?? 5000;
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Bootstrap the engine directly via the dev __ensureEngine global. We
      // intentionally don't click "Load example" — its auto-playing Sequencer
      // races spawnPatch's clear-then-add and leaves stale DOM. The browser
      // launch flag --autoplay-policy=no-user-gesture-required (in
      // playwright.config.ts) lets AudioContext start without a user gesture,
      // so no click is needed.
      await page.waitForFunction(() => {
        const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
        return typeof w.__ensureEngine === 'function';
      });
      await page.evaluate(async () => {
        const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
        await w.__ensureEngine();
      });

      // Clear + rebuild the patch in a single page.evaluate to avoid race conditions
      // with the auto-reconciler. We bypass the Clear button (which has been seen
      // to flake under Playwright when the topbar re-renders mid-click) and mutate
      // the patch graph directly via the dev-mode window globals.
      await page.evaluate(
        ({ nodes, edges }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          w.__ydoc.transact(() => {
            for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
            for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
            for (const n of nodes) {
              w.__patch.nodes[n.id] = {
                id: n.id,
                type: n.type,
                domain: (n as { domain?: string }).domain ?? 'audio',
                position: n.position ?? { x: 100, y: 100 },
                params: n.params ?? {},
              };
            }
            for (const e of edges) {
              w.__patch.edges[e.id] = {
                id: e.id,
                source: e.from,
                target: e.to,
                sourceType: e.sourceType ?? 'audio',
                targetType: e.targetType ?? 'audio',
              };
            }
          });
        },
        { nodes, edges }
      );

      // Wait for Svelte Flow to render the requested nodes. Assert by node ID
      // (SvelteFlow tags each wrapper with `data-id="<nodeId>"`) rather than a
      // TOTAL-count equality: a synced rackspace auto-spawns the singleton
      // TIMELORDE clock, and in the 2-context @collab flow that auto-spawn can
      // land AFTER spawnPatch's clear+rebuild transact (the provider-sync poll
      // in Canvas fires on its own cadence). Under the prebuilt `vite preview`
      // bundle the app boots fast enough that this race is deterministic, so a
      // strict `=== nodes.length` saw `doom + timelorde` (2 ≠ 1) and timed
      // out. Waiting for the exact requested IDs is both race-proof AND more
      // precise — it verifies the nodes we asked for actually mounted, instead
      // of trusting a count that an auto-spawned node can spuriously satisfy.
      await page.waitForFunction(
        (ids) =>
          ids.every((id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) !== null),
        nodes.map((n) => n.id),
        { timeout: mountTimeout }
      );
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientPageError(err) || attempt === MAX_ATTEMPTS) throw err;
      // HMR full-reload tore down the context. Wait for the new document to
      // be parsed (so __ensureEngine can re-bind via Canvas's $effect) before
      // retrying. networkidle is too strict here (HMR ws stays open).
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  // Unreachable — the loop either returns or throws — but TypeScript can't
  // see that, and we want a useful message if it ever does fall through.
  throw lastErr ?? new Error('spawnPatch: exhausted retries with no error captured');
}

// ---------------- TOYBOX collapsible-section helpers ----------------
//
// TOYBOX's COMBINE GRAPH + CV/MOD sections default OPEN in the wide 3-column
// card. Specs that previously clicked the toggle to OPEN now must be idempotent
// (a blind click would CLOSE an already-open section). These ensure the section
// is open without depending on its current state.

/** Ensure a TOYBOX section is OPEN: only click the toggle when the section's
 *  content (`contentTestId`) isn't already visible. Safe to call whatever the
 *  default open-state is. */
export async function ensureToyboxSectionOpen(
  page: Page,
  toggleTestId: string,
  contentTestId: string,
): Promise<void> {
  const content = page.locator(`[data-testid="${contentTestId}"]`);
  if (await content.isVisible().catch(() => false)) return;
  // Cold SwiftShader (CI + local --use-angle=swiftshader) can take well over 5s
  // to FIRST-paint the toybox card. Several sections (the combine editor) are
  // open-by-default — clicking the toggle on a not-yet-rendered-but-open section
  // would CLOSE it, then the old 5s wait timed out on now-hidden content (the
  // systemic toybox setup flake). So give the content a generous window to appear
  // naturally first; only toggle if it is genuinely still collapsed after that.
  const appeared = await content
    .waitFor({ state: 'visible', timeout: 12_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) return;
  await page.locator(`[data-testid="${toggleTestId}"]`).click({ force: true, noWaitAfter: true });
  await content.waitFor({ state: 'visible', timeout: 15_000 });
}

/** Ensure the COMBINE GRAPH editor section is open (its SVG is visible). */
export async function ensureCombineOpen(page: Page): Promise<void> {
  await ensureToyboxSectionOpen(page, 'toybox-combine-toggle', 'toybox-graph-svg');
}

/**
 * Right-click a combine-graph node until its context menu opens. The single
 * right-click can land before a freshly-added node is interactive on cold
 * SwiftShader (the node map re-renders async), so the menu intermittently fails
 * to open — the dominant toybox-node-menu / keyer-config flake. Retrying the
 * (right-click → assert menu) pair makes it deterministic. Returns once the menu
 * is visible; throws (with the node id) if it never opens within the budget.
 */
export async function openToyboxNodeMenu(page: Page, nodeId: string): Promise<void> {
  const node = page.locator(`[data-testid="toybox-gnode-${nodeId}"]`);
  await node.waitFor({ state: 'visible', timeout: 15_000 });
  const menu = page.locator('[data-testid="toybox-node-menu"]');
  await expect(
    async () => {
      await node.click({ button: 'right', force: true, noWaitAfter: true });
      await expect(menu).toBeVisible({ timeout: 3_000 });
    },
    `node menu for ${nodeId} should open on right-click`,
  ).toPass({ timeout: 20_000 });
}

/** Ensure the CV/MOD section is open (its rows are visible). */
export async function ensureCvOpen(page: Page): Promise<void> {
  await ensureToyboxSectionOpen(page, 'toybox-cv-toggle', 'toybox-cv-rows');
}

// ---------------- Rackspace seed helper ----------------
//
// Spec tests that target `/r/[id]` need a real rackspace row in the database;
// the route's +page.server.ts loader 404s otherwise. Before this helper,
// every such spec was either skip-pending-Clerk-seed or had to mock the
// loader, which left whole integration paths uncovered (Codex coverage
// finding #8).
//
// `seedRackspace(page, envelope?)` calls the dev-only POST /api/test/seed-rackspace
// endpoint (gated server-side on RACKSPACE_SEED_ENABLED='1' OR NODE_ENV=development;
// see routes/api/test/seed-rackspace/+server.ts) and returns the URL ready
// for `page.goto`. The URL includes the HMAC-derived `?invite=<code>` query
// string so anon visitors flow through /r/[id]/+page.server.ts's
// unauthed-with-invite path — no Clerk session required.
//
// Optional `envelope` is a PatchEnvelope object (from
// packages/web/src/lib/graph/persistence.ts) whose `update` field is stored
// into rack_snapshots; the Hocuspocus relay serves it on first connect so
// the rack appears pre-populated. Omit for a fresh empty rack.
export interface SeedEnvelope {
  envelopeVersion: number;
  update: string;
}

export interface SeededRackspace {
  /** Bare rackspace id (e.g. `r_abc23xy7`). */
  id: string;
  /** HMAC-derived invite code for anon access. */
  inviteCode: string;
  /** Full path to navigate to: `/r/<id>?invite=<code>`. */
  url: string;
}

/**
 * Seed a fresh rackspace via the test-only API and return navigation info.
 *
 * The page argument is used as a convenient `request` carrier so the call
 * inherits Playwright's baseURL + any configured httpCredentials
 * (beta-gate basic auth on the autotest tier). Doesn't navigate the page.
 */
export async function seedRackspace(
  page: Page,
  envelope?: SeedEnvelope,
  opts?: { name?: string; ownerUserId?: string },
): Promise<SeededRackspace> {
  return seedRackspaceVia(page.request, envelope, opts);
}

/** Same as seedRackspace but accepts a raw APIRequestContext (e.g. from
 *  a non-Page test scope, like @collab specs that share one request ctx). */
export async function seedRackspaceVia(
  request: APIRequestContext,
  envelope?: SeedEnvelope,
  opts?: { name?: string; ownerUserId?: string },
): Promise<SeededRackspace> {
  const body: Record<string, unknown> = {};
  if (envelope !== undefined) body.envelope = envelope;
  if (opts?.name) body.name = opts.name;
  if (opts?.ownerUserId) body.ownerUserId = opts.ownerUserId;
  const resp = await request.post('/api/test/seed-rackspace', {
    data: body,
    // Always send a JSON content-type so SvelteKit's body parser picks the
    // right path even when body is `{}`.
    headers: { 'content-type': 'application/json' },
  });
  if (!resp.ok()) {
    const text = await resp.text().catch(() => '<no body>');
    throw new Error(`seedRackspace: ${resp.status()} ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { id?: unknown; inviteCode?: unknown };
  if (typeof json.id !== 'string' || typeof json.inviteCode !== 'string') {
    throw new Error(`seedRackspace: malformed response: ${JSON.stringify(json)}`);
  }
  return {
    id: json.id,
    inviteCode: json.inviteCode,
    url: `/r/${json.id}?invite=${json.inviteCode}`,
  };
}

/** Read a status-bar field value (e.g., readStatus(page, 'nodes') → '5'). */
export async function readStatus(page: Page, field: string): Promise<string> {
  const text = (await page.locator('.bottombar').textContent()) ?? '';
  const m = text.match(new RegExp(`${field}\\s*(\\S+)`));
  return m?.[1] ?? '';
}

/**
 * Take a STICKY, focus-independent keyboard claim on a DOOM card, then VERIFY
 * the runtime actually claims keys before any are dispatched.
 *
 * DETERMINISTIC CLAIM (the @collab marine-move de-flake — shared by all DOOM-MP
 * specs): we do NOT rely on a DOM click/`.focus()`. In a 2-context Playwright
 * test only ONE page holds focus/activeElement; the backgrounded page's
 * document.activeElement stays on <body>, so a focus-based capture leaves
 * shouldClaimKey()'s focus-within branch false, the dispatched keydown is
 * silently dropped, and the marine never moves. Instead we invoke the card's
 * `forceClaimKeyboard()` dev hook (the SAME latchKeyboard() the "Click to
 * capture keyboard" onclick fires) which flips kbLatched=true — honoured by
 * shouldClaimKey() REGARDLESS of focus/foreground — then POLL
 * getState().shouldClaimKey === true to confirm the claim landed before keys
 * are dispatched. Works identically on the foreground and the background page.
 * (Real users still click to capture; that path is unchanged.)
 */
export async function claimKeyboard(page: Page, id: string, timeout = 5000): Promise<void> {
  await page.evaluate(
    (nid) =>
      (
        globalThis as unknown as {
          __doomCards?: Record<string, { forceClaimKeyboard?: () => void }>;
        }
      ).__doomCards?.[nid]?.forceClaimKeyboard?.(),
    id,
  );
  // Poll until the runtime confirms the claim landed (focus-independent). On
  // failure we fall through: the dispatch still runs so the spec's own
  // assertion surfaces a clear signal rather than a silent no-op.
  await page
    .waitForFunction(
      (nid) =>
        (
          globalThis as unknown as {
            __doomCards?: Record<string, { getState: () => { shouldClaimKey: boolean } }>;
          }
        ).__doomCards?.[nid]?.getState().shouldClaimKey === true,
      id,
      { timeout },
    )
    .catch(() => {});
}
