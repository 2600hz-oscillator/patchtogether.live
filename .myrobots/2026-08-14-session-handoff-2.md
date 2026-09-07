# Session handoff — 2026-08-14 (~11:20 local), unwinding at owner request near session limit

State written for the NEXT session. Verify against the board before acting.

## Open PRs — 4, ALL mid-CI with ZERO failures at handoff; MERGE ON GREEN

| PR | branch | what | notes |
|---|---|---|---|
| **#1610** | `fix/e2e-typecheck` | #1499 e2e typecheck + coverage guard | Carries its own webgl attestation `89de4749` + collab `7aabed4d`. Refreshed onto post-#1625 main, 0/0 typecheck. Its previously-red vrt shard should pass now that the #1623 TOCTOU fix is in its tree. |
| **#1611** | `fix/audioin-doom-node-lifetime` | #1590 audioIn (the IRREVERSIBLE `t.stop()` row) | Attestations committed: collab `d19cd984`, webgl `d0353edd`. PENDING entries for both new collapse specs union-resolved. |
| **#1626** | `feat/moduleshell-extension-registry` | #1512 extension registry (agent-built) | VRT verdict is CI's (acceptance: green with ZERO re-pins — check the bot committed nothing). LEG-05 #1516 already cites the seam. |
| **#1627** | `fix/blood-log-routing` | #1548 blood severity router | Red-on-clean-main → green, deterministic at any boot speed. |

⚠ **UNION-TREE ATTEST RULE for #1610/#1611**: whichever merges SECOND owes a
webgl hash re-check on its merged tree (both move the webgl basis: #1610 via
`e2e/vrt/**` configs, #1611 via `e2e/playwright.config.ts`). Run
`task webgl:attest:check` after merging main in; if the hash moved, mint on the
GPU (owner has granted GPU use). Same possibly for collab (#1611's config edit).

## Branches READY, waiting for PR slots (max 4 open)

1. `fix/dead-myrobots-pointers` — #1562 done: 60 dead pointers re-pointed/dropped
   across 172 files, tree-wide gate in `scripts/agent-context.test.ts` (NC
   verified). Full verification in the commit message.
2. `fix/launchpad-carveout-anchored` — #1579 done: registered id + registry-anchored
   gate, NC verified. ⚠ UI change — **owner preview requested before merge**
   (the Launchpad surface now renders its real card in the lane).

## #1502 — CORRECTED STATE (agent finished before the limit; report verified honest)

Most of the issue's Stage A ALREADY LANDED on main via #1560
(`scripts/e2e-report-audit.mjs` + merge-reports wiring, `--fail-on-flaky` is
the prepared flip). The flake tail is #1569's (nine tests, not two; two already
fixed). Branch `feat/e2e-flaky-skip-surfacing` (pushed, one commit `5101e866`)
holds the RETRIES falsification: the env is the flox installer's `retries: 3`
input exported via $GITHUB_ENV — nothing deletable in-repo; comment corrected,
collab hash byte-identical. REMAINING (designed in the agent's report + posted
on #1502): fix 4 anonymous skip sites (edges.spec:135, recorderbox.spec:491,
modules.spec toybox, doom-audio-output ×2 — the last loses a reason it passes,
likely beforeEach placement, unverified), then the per-lane skip-reason budget
anchored against a runtimeSkipInventory() in test-reconciliation, audit
artifact upload, behavioral-lane audit step, ledger skip section, delete
behavioral-watchdog.mjs:103's flaky→passed mapping. merge-reports is NOT in
the `ci` umbrella — audit reds stage visible-not-blocking there.

## Merged this session (12 PRs)

#1598 wavesculpt/timelorde · #1603 layers transition-sampling · #1601 CI critical
path (measured 19.8→17.8 min, #1595 closed with data) · #1599→ earlier session ·
#1608 attest server identity (#1597) · #1609 collab-nightly root cause (#1500) ·
#1613 layers cyclic clock (#1612) · #1615 identity-probe ipv4 (#1614) · #1618
doom node-lifetime (#1590+#1617, completes the #1583 epic 12/12) · #1619 e2e
timings accept loop (#1600) · #1621 producer readiness (#1620, + #1571 guard
ride-along) · #1622 120s fixture (#1577 + reopened #1553) · #1624 warning gate
(#1549+#1602 — **svelte-check is now 0-warning, --fail-on-warnings ARMED**) ·
#1625 restored-boot TOCTOU (#1623) · #1607 rack flip (earlier today).

## Standing facts that will bite otherwise

- **typecheck baseline is now 0 ERRORS 0 WARNINGS** (armed gate, #1624). Any
  branch predating it must merge main and re-triage its warnings.
- **The #1600 freshness gate reddens every branch that adds an e2e spec** until
  the spec has a PENDING_FIRST_MEASUREMENT entry (scripts/e2e-shard-plan.mjs)
  or `task e2e:timings:accept -- <run-id>` runs on a green main run containing
  it. TWO entries are pending now (doom + audio-input collapse specs) — accept
  a fresh run after #1611 merges and DELETE both entries.
- **GPU attests**: pre-flight refuses on load/co-tenants (MTGA/Discord/Edge were
  all seen today) — the refusals were CORRECT every time; wait for quiet rather
  than override. Mid-run co-tenant abort exists too. Before any attest:
  `pkill -f workerd-darwin-arm64`, check no stray vite servers, and NEVER
  switch the checkout under a deferred attest (a drift-guard `git branch
  --show-current` check inside the chain is the pattern that works —
  the wrong-branch attest run earlier today was my own checkout-switch).
- **card-producer-lifetime under the attest's parallel pass**: fixed by #1620's
  readiness gate (merged). If it ever reds again solo-green, that discrimination
  recipe is in #1620.
- **Worktrees**: purged 20 → 1 this session (everything WIP-committed + pushed
  first). The one remaining: `wf_77318311-e2d-2` — REMOVABLE now (#1624 merged;
  branch fully landed). The #1502 agent's worktree may also linger — check
  `git worktree list`, WIP-push anything dirty before removing.
- **Local Postgres** for collab attests: port **54320**
  (`postgresql://postgres@localhost:54320/patchtogether_test`).
- Board: **30 open issues** at handoff. Non-legacy queue after the PR slate:
  #1606 (shell-parity classify), #1536 (/r/[id] e2e), #1523 (waitForTimeout
  burn-down), #1543 (Svelte AI tooling), #1616 (doom-controls LED flake),
  #1502 stage B (the two named flakes), #1524/#1525/#1526 hygiene, CI-machinery
  trio #1503/#1504/#1507, #1544. Legacy chain (LEG-*) after that per owner path.
- No crons armed. No loop armed.
