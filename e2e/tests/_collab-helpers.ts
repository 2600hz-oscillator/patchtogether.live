// e2e/tests/_collab-helpers.ts
//
// Multi-context test harness for the multi-user (@collab) flow. Wired in
// Phase 2 so that Phase 4 (Hocuspocus + WebRTC mesh) lands with the test
// infrastructure already in place — at that point we flip `test.skip` to
// `test` and the asserts come alive.
//
// Each call opens N independent browser contexts on the same canvasId. Each
// context has its own cookie jar, localStorage, and AudioContext, so they
// behave like separate "users on different machines" sharing one canvas.

import type { Browser, Page, BrowserContext } from '@playwright/test';

// ---------------------------------------------------------------------------
// Cross-context sync budget (the @collab de-flake — task #69).
//
// The @collab lane's chronic CI flake was NOT a real multiplayer regression: a
// cross-context Yjs update (A mutates → relay → B observes) is CORRECT but can
// be SLOW when the single-process Hocuspocus relay's event loop is starved by
// the co-tenant CPU load on a contended GitHub-Actions runner (DOOM WASM, vite
// preview, two browser contexts all share 2–4 vCPU). A flat short budget
// (4s/5s/8s) on the `expect.poll(...)` that waits for B to see A's change then
// times out on a slow-but-correct sync → the whole spec eventually trips its
// test timeout. The relay is already isolated PER CI JOB (Playwright boots its
// own `npm run dev -w packages/server` on :1235 + a per-job Postgres service),
// so there is no shared-relay contention to remove — the fix is to give every
// cross-context CONVERGENCE poll a generous, DETERMINISTIC budget so a correct
// sync that arrives late still passes, while a genuinely-broken sync (never
// converges) still fails at the budget.
//
// SYNC_BUDGET_MS is that single budget. It stays comfortably BELOW each spec's
// test timeout (default 30s; the heavier collab specs set 60s) so a failing
// poll surfaces as a clear assertion failure (not an opaque test timeout). 20s
// gives the relay ~5–10× the headroom a calm relay needs (~1–4s observed)
// without approaching the 30s default.
export const SYNC_BUDGET_MS = 20_000;

// Poll cadence for the convergence waits: back off quickly so we don't hammer
// the (possibly-starved) relay with cross-context `evaluate` round-trips, but
// stay responsive enough that a fast converge returns promptly.
export const SYNC_POLL_INTERVALS = [100, 250, 500, 1000];

// (The CollabSession/openCollab Phase-2 harness was pruned as unreferenced —
// LoC campaign row 16. Every @collab spec rolls its own two-context setup on
// the seeded-rackspace flow instead; the shared constants above are what
// they actually import from this file.)
