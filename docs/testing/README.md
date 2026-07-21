# Testing punch-list, gating truth & roadmap-to-zero

This is the human-readable companion to
[`test-ledger.generated.md`](./test-ledger.generated.md) — the **generated**,
freshness-gated 3-bucket ledger of everything turned off, opted out, or
non-gating across the test suites. The ledger's counts are a pure function of the
committed source tree (no dates, no manifest, no git), so they **cannot go
stale**: a new skip or exemption fails the `unit`-lane gate
(`scripts/test-ledger.test.ts`) until a human regenerates and notices —
`flox activate -- task test:ledger` to check, `task test:ledger:accept` to re-pin.

> This replaced the old dated "Test Reconciliation" changelog + its GitHub Pages
> report (`docs/test-reconciliation/`, deleted). A dated changelog is stale the
> moment it is written; a generated artifact is not.

For counts + itemized lists always read the ledger — this file is the **prose**:
what actually gates a PR, and the plan to drive Bucket 1 to zero.

---

## What actually gates a PR (the load-bearing answer)

Source of truth: `.github/workflows/ci.yml`. Branch ruleset **16042163** requires
exactly **2 status-check contexts** (verified against the live ruleset — see
`.claude/skills/pr-workflow.md`):

1. **`typecheck + unit + ART + E2E`** — the `ci` umbrella job (an aggregator).
2. **`vrt-strict (visual regression — strict subset)`** — the deterministic
   pure-DOM VRT subset.

The umbrella is `if: always()` and fails (blocking merge) when **any** job named
in its failing `if [[ … ]]` is not `success`. Those jobs — all effectively
REQUIRED — are:

`actionlint · typecheck · unit · dsp-build · build-web · art · build · e2e ·
webgl-smoke · webgl-attest · behavioral-smoke`

Notable specifics:

- **`behavioral-smoke` GATES** every PR — the fast REQUIRED subset that greps 7
  rock-solid core signal-path modules
  (`adsr|analogVco|filter|lfo|noise|stereovca|vca`), validated 3× locally.
- **The full `behavioral-coverage` sweep does NOT gate** — `continue-on-error:
  true`, not in the umbrella `needs:`, and runs only on main-push / dispatch /
  `behavioral`-labeled PRs. Its per-module delta thresholds are still being tuned
  and a premature 1× gate flaked on `moog911`; it needs a proper 3× flake-purge
  before it can re-gate. **So: behavioral is _partially_ gating — the bulletproof
  core slice blocks merge; the ~168-module sweep is informational.**
- **`webgl-attest` GATES** (re-armed 2026-06-11, Phase 4) — a WebGL-path change
  without a re-run `task webgl:attest` fails it. `webgl-smoke` gates too.
- **`per-module-per-port` handle/emit/drive** runs inside the required `e2e` job
  (the sweep is not among `e2e`'s `--grep-invert` exclusions), so it gates
  transitively.
- **`collab-attest` and `grand-attest`** sit in the umbrella `needs:` + `env:` but
  are deliberately absent from the failing `if` — waited-on, **non-gating**
  (collab-attest un-gated 2026-06-28; grand-attest informational-first).
- **`vrt`** (full canvas) is `continue-on-error: true`; only `vrt-strict` gates.
- **`collab`** (@collab multi-context) is un-gated pending a flake-purge.

The exact informational-lane list + `ci.yml` line anchors are in
[Bucket 3 of the ledger](./test-ledger.generated.md).

---

## Roadmap to zero skips (Bucket 1)

Every Bucket-1 entry is backlog: **fix (assert real behavior) or delete
(worthless)** — there is no permanent-exempt bucket. Current items (see the ledger
for exact `file:line`):

| Item | Kind | Why it's hard | Path to zero |
| --- | --- | --- | --- |
| `treeohvox-parity` (×2) | unit `describe.skip` | Open303 binary parity needs a hand-produced reference WAV; run manually. | Generate the reference WAV as a checked-in fixture and un-skip, or delete if the DSP-core tests already pin the behavior. |
| `edges` — raising THICKNESS increases edge pixels | e2e `test.fixme` (task #106) | Times out (~150 s) under CI's SwiftShader software renderer — the per-frame Sobel readback is redundant while quarantined. | Real-GPU CI lane, or a reduced-capture / longer-wait variant; behavior is already covered by `edges.test.ts` + `edges.spec.ts`. |
| `in-card-title` — rename in A appears in B | e2e `test.fixme` (task #101) | `@collab` relay-contention peer-sync timeout on the single-process Hocuspocus relay. | Relay stability work (Wave-2 CI-native @collab smoke); re-enable once the relay converges under load. |
| `recorderbox` — real VCO+ACIDWARP → crash-recoverable MP4 | e2e `test.fixme` (task #105) | CI's headless Chrome reports H.264 support but the OS lacks a hardware encoder → the encode never completes. | Gate on a capability probe (`isConfigSupported()`) and confirm green ON CI, or a real-encoder lane. |
| `toybox` | spawn-smoke `QUARANTINE` (task #102) | SwiftShader software-renderer timeout (heavy WebGL) on the per-module spawn. | Real-GPU CI lane; the module has dedicated VRT + bespoke e2e coverage. |

Two throughlines dominate: **CI's SwiftShader software renderer** (edges / toybox —
a real-GPU lane retires them) and **relay contention** (in-card-title — the
@collab de-flake wave). Neither is "flaky test tolerated"; each is a tracked
infra-capability gap with a concrete re-enable path.

## Reducing Bucket 2 (coverage exemptions)

Bucket 2 entries are deliberate auto-enrollment opt-outs — a module skipped from a
UNIVERSAL sweep still carries dedicated coverage elsewhere. They are **counted and
itemized so drift is visible**, not treated as invisible. Per repo doctrine the
**behavioral** exemptions (`BEHAVIORAL_MODULE_EXEMPT` / `BEHAVIORAL_SWEEP_EXEMPT`)
are ALSO tracked-to-zero backlog (reconcile = fix or delete); the biggest levers:

- a **real-GPU CI lane** re-enters the video-sink SwiftShader class
  (`cellshade` / `chromakey` / `outlines` / `edges` …) and the heavy-mount
  ray-march modules;
- a **per-transient peak metric** + **per-channel sinks** re-enter the pulse-train
  and per-channel-on-summed-mix cases (`moog911a`, `mixmstrs`, `aquaTank`);
- the VRT `VRT baseline pending` entries clear as `vrt-update.yml` captures
  darwin/linux baselines.

The opt-**IN** ratchets (`STRICT_DOCS`, `STRICT_VRT_MODULES`) are the inverse: the
more members the better. They only grow (every new module ships into them; any
module incidentally touched is promoted — the boy-scout rule).

## Scope note

The CI-gate configuration itself and any new/skipped tests are **out of scope**
for this ledger PR — it only measures + documents the current state. Changing what
gates (e.g. arming `grand-attest`, re-gating the full behavioral sweep) or clearing
a Bucket-1 skip are deliberate follow-up PRs, each with its own flake-purge.
