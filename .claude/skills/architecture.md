---
name: architecture
description: High-level system architecture. Multi-domain (audio + video) modular synth; SvelteKit on Cloudflare Pages + Workers; Hocuspocus + Y.Doc multiplayer; AudioWorklet DSP; WebGL2 video. Read before deep work in a new area.
---

# System architecture

## Product

patchtogether.live — multiplayer, browser-based modular synthesizer + video
synth. Users spawn modules, patch cables, and play together in shared
"rackspaces." AGPL-3.0-or-later (relicensed from MIT 2026-05-19 to unlock
direct ports of GPL-licensed synth code like Helm, Surge, etc.).

## Top-level layout

Monorepo, npm workspaces, go-task orchestrator:

```
packages/
  web/        — SvelteKit app (the UI, patch canvas, module Cards, sync client)
  server/     — multiplayer Y.Doc sync server (Hocuspocus, runs on Fly.io)
  dsp/        — AudioWorklet processors; one .ts per module → one .js bundle
  art/        — Audio Regression Test scenarios (Vitest)
e2e/          — Playwright (E2E + VRT) + chaos bots
art/          — ART scenario folders (sometimes mirrored at top level)
.github/workflows/ — CI, deploy, chaos cron
```

## Multi-domain (audio + video) from day 1

Modules are categorized as audio, video, or hybrid. The graph carries multiple
cable types (`audio`, `cv`, `pitch`, `gate`, `midi`, `video`, `trigger`, etc.).
Port compatibility lives in `packages/web/src/lib/graph/types.ts`. Hybrid
modules (wavesculpt, etc.) consume both domains.

Audio path: Web Audio API + AudioWorklets. DSP code in `packages/dsp/` builds
to worklet bundles; each module that needs DSP has one top-level `.ts` file
there (auto-discovered by the build). Shared helpers go in
`packages/dsp/src/lib/` (excluded from the worklet-entry glob).

Video path: WebGL2. Each video module has its own GL context per Card.
Inter-module video is one canvas's drawing buffer blitted into another's
texture via `VideoEngine.blitOutputToDrawingBuffer(sourceNodeId)`. There is
no centralized video graph — each Card pulls upstream content frame-by-frame.

## Front-end

- **SvelteKit** (Svelte 5 with runes — `$state`, `$derived`, `$effect`).
- **xyflow** for the patch canvas (Svelte port).
- **Y.Doc + SyncedStore** for CRDT state. The patch (modules + cables + per-module data) lives in Y.Doc; all UI reactivity reads from it.
- **Clerk** for auth (publishable key in client, secret key in CF Workers env).
- **Vite** as the bundler. Some module Cards `import 'something.wasm?url'` against `packages/dsp/dist/` — which is why `task vrt` `deps: [dsp:build]`.

## Multiplayer (Hocuspocus + Y.Doc)

The sync server (`packages/server/`) runs Hocuspocus. Clients connect over
WebSocket via `VITE_SERVER_WS_URL`:
- `wss://patchtogether-server-autotest.fly.dev` (autotest tier)
- `wss://patchtogether-server-dev.fly.dev` (dev tier)
- production URL (in workflow env)

Each rackspace is a separate Y.Doc, identified by URL. Anyone with a
rackspace link can join (anonymous join allowed by design). Per-rackspace cap
is 4 total (owner + 3 others).

For tests (especially E2E), the server is either real (against autotest tier)
or in-process (the spec spins up a local Hocuspocus to test multi-client
behavior). Look for `Hocuspocus` import in test setup files for the exact
pattern in use.

## Persistence

- **Y.Doc state** — per-rackspace, persisted via Hocuspocus' database adapter
  (currently Postgres via Neon, accessed from CF Workers via the HTTP `neon`
  template tag — NOT `pg` package, NOT WebSocket Pool; both fail from
  Workers).
- **Saved groups / patches** — separate HTTP API (`/api/saved-groups`)
  storing user-saved patch subgraphs.

## Build → Deploy

`task build` → Vite builds `packages/web/.svelte-kit/cloudflare/` →
`wrangler pages deploy` uploads to Cloudflare Pages. No native packaging.
See `deploy-pipeline` skill for tier mapping + triggers.

## Test layers

See `running-tests` and `testing-conventions` skills. Brief:
- typecheck → unit (Vitest) → ART (audio regression, Vitest) → VRT (visual
  regression, Playwright + LFS PNGs) → E2E (Playwright) → live smoke
  (Playwright @smoke against real URL).

## Module registry pattern

Modules are eagerly registered at app start. The 6 shared registry files
that must accept an entry for each module are listed in `coding-conventions`
and `module-development`. The eager-load pattern is filed as a perf issue
(#213) — phase 2 candidate for lazy-loading work.

## Key non-obvious constraints

- **Wrangler version pinning matters** — v3 inferred CF account from API
  token, v4 doesn't. The `CLOUDFLARE_ACCOUNT_ID` secret must be set
  explicitly (it is now, as of 2026-05-19; was previously missing).
- **Cables stay in front of nodes during drag** (intentional CSS). Don't
  "fix" this — see memory `feedback_cable_drag_zorder`.
- **Sync layer reverts edits + creates `*" N".ts` junk** on certain files.
  Commit-immediately-after-edit mitigates; junk files stay untracked.
- **VRT is required**; some modules opt out via `EXEMPT_BASELINE_PAIRS`
  in `e2e/vrt/vrt.spec.ts` when their render is non-deterministic
  (animated 3D, CRT feedback, etc.).
