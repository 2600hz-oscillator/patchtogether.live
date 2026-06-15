# `ci-collab-attest/` — @collab local-relay test attestations ("semaphore")

This folder holds **owner self-attestations** that the full multi-user `@collab`
test set was run **on a fresh, dedicated, uncontended relay + DB locally** for a
given collab-content state. Each file is named by the deterministic **collab
content-hash** and is committed alongside the PR that changed the collab surface.
It is the **@collab analogue of `ci-webgl-attest/`** — read that folder's README
for the shared honor-system framing.

## Why this exists

The `@collab` multi-context CI lane is **flaky and slow** (~6.5-8 min): the
in-memory Hocuspocus relay is single-process and buckles under CI's 10-parallel-
shard contention, so the DOOM-MP specs defensively `test.skip(true,'…relay
flake…')` → **green-but-vacuous**. It was made **informational** (removed from
the required `ci` umbrella ~2026-06-06) for exactly this reason.

**Key insight that makes attest-and-skip work for collab:** *locally you control
the relay.* `task collab:attest` boots a **fresh, dedicated** relay + Postgres
with **zero shard contention**, so multiplayer sync actually converges reliably
(unlike CI's contended relay). So we run `@collab` where the relay behaves, pin a
content-hash, and CI gates on a cheap ~2-min **verify** of the committed
attestation:

- **match** → the collab surface is unchanged-or-attested → CI trusts the local
  calm-relay run, the slow @collab lane stays per-PR-informational.
- **no match** → a collab/sync/relay path changed without re-attesting → CI
  **fails** (once required) with `run: flox activate -- task collab:attest`.

## What is HONEST about this (read before trusting it)

The **one robust property** is: *editing a hashed collab file forces a re-attest
or CI fails* — it removes the "I edited the relay/sync layer and forgot to
re-test multiplayer" **accidental-staleness** failure mode for in-basis files.

It is **NOT anti-forgery and NOT a security control.** Every field in the JSON is
hand-writable. Acceptable **because the repo is contribution-locked to the
owner** (owner-only merge; fork-PR Actions require owner approval) → this is an
**owner self-attestation = single-trusted-actor model**.

### The meaningful-gate guard (what makes a LOCAL pass non-vacuous)

A `@collab` spec `test.skip(true,'…')`s for two distinct reasons:

- **relay/sync vacuity** — `relay flake`, `sync did not reach`, `roster sync did
  not seat`, `never saw/took`, `mpLive sync …`. On a **fresh dedicated relay**
  these MUST NOT happen; if one does, the local run proved nothing about
  multiplayer. The runner treats ANY such skip as a **HARD FAILURE** and refuses
  to write an attestation.
- **asset/resource** — `DOOM WASM not built`, `DOOM1.WAD missing`, `SNES ROM`,
  `resource-constrained`, `failed to load … within`. These are legitimate
  environmental skips; the runner **pre-flights** the DOOM/WAD assets so they
  don't fire, and reports any that do.

The classifier (`isRelayVacuitySkip` in `scripts/collab-attest-lib.ts`) is the
single source of truth and is exercised by a guard unit test
(`packages/web/src/lib/multiplayer/collab-attest-basis.test.ts`).

### CAVEAT (differs from webgl-attest)

For WebGL, a local **real GPU** is strictly *superior* to CI's SwiftShader, so a
local pass strictly dominates. For collab, a calm local relay is merely **less
contended** than CI's — a calm local pass **can mask an under-load multiplayer
race**. Mitigation: the **nightly backstop** (`.github/workflows/collab-nightly.yml`)
runs the FULL real `@collab` lane on CI every day (and on `workflow_dispatch`),
so contention regressions still surface daily while the per-PR path stays fast.

## The content-hash basis

Computed by `scripts/collab-attest-hash.sh` (→ `scripts/collab-attest-lib.ts`)
over the **collab-relevant source/spec/toolchain paths only** — NOT `git HEAD`,
so it survives squash-merge / rebase / amend. The basis (`COLLAB_PATHS`):

- `packages/server/src/**` **except `**/*.test.ts`** — the Hocuspocus relay
  (auth, capacity/slots, snapshot persistence, reaper, heartbeat).
- `packages/web/src/lib/multiplayer/**` **except `**/*.test.ts`** — the client
  sync / presence / roster / awareness / layouts / clock-sync layer.
- The syncedStore glue + synced mutation surface
  (`graph/store.ts`, `persistence.ts`, `snapshot.ts`, `mutate.ts`, `duplicate.ts`).
- The DOOM multiplayer sync layer (`doom-netcode`, `doom-lockstep`,
  `doom-roster`, `doom-presence`, `doom-session`, `doom-host-authority`,
  `doom-awareness-signature`, `doom-gating`, `doom-player-identity`).
- The `@collab`/`@capacity` **specs** (resolved by scanning `e2e/tests` for the
  tag — the same selector the lane greps) + the shared e2e helpers + config.
- The **DB schema** (`db/schema/001_init.sql`, `003_saved_groups.sql`) — the
  relay's auth/membership/persistence gates run real SQL; a schema change changes
  collab behavior.
- **Toolchain pins** (`packages/server/package.json` → @hocuspocus/yjs/pg,
  `packages/web/package.json`, `e2e/package.json`, `.flox/env/manifest.toml`).

A guard unit test (`collab-attest-basis.test.ts`) asserts the basis resolves to a
non-trivial set and that the relay-vacuity classifier matches the real spec skip
reasons — so the basis/classifier can't silently rot.

## How to (re-)attest

```sh
# Bring up a local Postgres + export DATABASE_URL (e.g. a docker pg or a dev DB):
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/patchtogether_test

flox activate -- task collab:attest:check    # do I even need to re-attest?
flox activate -- task collab:attest          # fresh relay+DB run; writes <hash>.json
git add ci-collab-attest/<hash>.json && git commit   # commit it WITH your PR
```

The runner asserts the DB + relay are actually up, pre-flights the DOOM assets,
runs the `@collab` specs at `--workers=2` with `retries=0`, and **refuses to
write** unless every spec genuinely passed with **zero** relay-vacuity skips.

## Do NOT hand-edit these files

They are machine-written. Hand-editing defeats even the accidental-staleness
property. Growth is fine (~700 bytes JSON each, not LFS). The only file that MUST
exist for the verify job to stay green is the one matching main's current
`COLLAB_PATHS` hash.

## Migration / retirement

Retire this scheme the day the CI relay is no longer contention-flaky (e.g. a
dedicated single-tenant relay machine or a P2P/WebRTC sync that removes the
single-process bottleneck): re-gate the real `@collab` lane in the `ci` umbrella,
then delete the `collab-attest` job, `scripts/collab-attest*`, the
`collab:attest*` Taskfile targets, this folder, and the nightly backstop (one
cleanup PR). See `.myrobots/plans/collab-attest-2026-06-15.md`.
