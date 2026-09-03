# P0 execution notes — 2026-09-03

**RESOLVED 2026-09-03 (addendum, same day):** the owner GO landed (build-brief
"OWNER GO" section: PUBLIC MIT, copyright "Copyright (c) 2026 2600hz-oscillator",
repos `2600hz-oscillator/patchtogether-{es9,nativeapps}`) and P0 executed under
the second review's binding conditions: bundle refreshed post-LICENSE-commit,
stale nativeapps license prose fixed pre-initial-commit, secrets gate re-run at
push time (record: `p0-secrets-gate.md` beside this file), both repos created
and pushed (es9 main 7977ecc; nativeapps main e854480), submodules added at
`apps/helpers/{es9,nativeapps}` pinned to those SHAs, and the issue-7 loose
artifacts vendored into `apps/helpers/edge-scripts/` (audited, parameterized).
The body below is the predecessor's pre-go record, kept verbatim as evidence.

**Status: PAUSED on owner hold.** Mid-execution the owner ordered: no GitHub repo
creation, no pushes (helper repos or submodule branch) until a fresh plan review
completes. Read-only work and local prep finished; everything below is staged,
nothing is committed or pushed. Resume requires explicit owner go.

This file deliberately paraphrases Apple/machine identifiers — this repo is PUBLIC
and `.myrobots/` is tracked. Exact values live in the sibling repos' files named
below, outside this repo.

## 1. PTZ + Edge helper artifacts — FOUND (nothing needs building fresh)

| artifact | path | notes |
|---|---|---|
| Edge launch w/ MidiMacUmp flag | `~/Documents/workspace/scratch/start_edge.sh` | kills stragglers first (flag silently dropped if any Edge process alive); `--scratch` throwaway-profile variant |
| Edge fullscreen policy (defaults) | `~/Documents/workspace/scratch/edge_defaults.sh` | `AutomaticFullscreenAllowedForUrls` via `defaults write com.microsoft.Edge` |
| Edge MANAGED policy (root, raw plist) | `~/Documents/workspace/patchtogether.browser/tier0-edge-policy.sh` | fullscreen + popups via `/Library/Managed Preferences/` raw XML (`defaults write` there silently no-ops — measured); covers per-PR pages.dev preview origins; localhost any-port |
| PTZ helper launcher | `~/Documents/workspace/scratch/start_ptz.sh` | finds/builds in-tree `tools/pt-ptz`, probe + single-instance guard; a tracked near-twin already exists at `tools/pt-ptz/start_ptz.sh` |
| PTZ research/spec | `~/Documents/workspace/scratch/ptzcam-research.md` | NexiGo P610 UVC-PTZ research, hardware probe procedure, VISCA/Web Serial fallback |
| PTZ helper itself | `tools/pt-ptz/` (IN-TREE, tracked) | confirmed present: pt-ptz.c, Makefile, README, start_ptz.sh, built binary |
| display probe | `~/Documents/workspace/patchtogether.browser/probe/display-probe.html` | present-display experiments |

Not found in `../patchtogether.native` (pre-Electron .app direction, no ptz/edge/helper
code at top levels) or `../doom_viz` / `../doom` (see §4). `../es9scratch` holds only a
standalone-mixer setup note. Vendoring candidates for `tools/edge-browser/`:
start_edge.sh + edge_defaults.sh + tier0-edge-policy.sh (all three are operative for
the still-supported browser path; audit on the way in — tier0 script contains only
public origins, no secrets, on first read).

## 2. Helper repos — audit verdicts + prep state (staged, NOT committed, NOT pushed)

### ../patchtogether.es9 — VERDICT: CLEAN, cleared to push (on owner go)
- `git log -p --all` (5 commits) audited: no keys/tokens/passwords/.env/PEM/serials/
  absolute home paths/emails. Only hits: benign prose ("pairing token" design note,
  route-parsing "token" identifiers) and standard Claude co-author trailers.
- Author identity on all commits is pseudonymous (`bluebox timmy`, loopback email) —
  no real user identifier.
- Working tree: the one machine-specific file is `.claude/settings.local.json`
  (absolute home path inside) — previously protected ONLY by the global gitignore;
  repo-local `.gitignore` now covers `.claude/settings.local.json` + `.myrobots/`
  (staged). MIT LICENSE (copyright 2026 2600hz-oscillator) staged.
- Backup done FIRST: `~/Documents/workspace/backups/patchtogether.es9-20260903.bundle`
  (git bundle --all).
- Remaining on go: commit staged, create PUBLIC `2600hz-oscillator/patchtogether-es9`,
  re-run gate per build-brief §3 with record at
  `.myrobots/<date>-helper-secrets-gate-patchtogether-es9.md`, push.

### ../patchtogether.nativeapps — VERDICT: CLEAN, cleared to push (on owner go)
- Zero commits; exact initial-commit candidate staged explicitly (no `git add -A`):
  .gitignore, CLAUDE.md, LICENSE (MIT, staged new), Package.swift, README.md,
  Sources/ (BridgeKit, VSTBridgeCore, vst-bridge), Tests/, docs/vst-bridge-design.md.
- Tree grep: no keys/tokens/passwords/.env/serials/absolute paths/emails. CLAUDE.md
  reviewed in full — sibling-relative paths only, publishable (flag to owner: it is
  agent instructions; drop from the initial commit if unwanted in public).
- Same repo-local ignores appended. `git config user.*` is the pseudonymous identity.
- Remaining on go: initial commit, create PUBLIC
  `2600hz-oscillator/patchtogether-nativeapps`, gate record, push.

## 3. Submodules — DRAFTED, blocked on the pushes existing

Planned (task directive): paths `apps/helpers/es9` + `apps/helpers/nativeapps`, branch
`feat/native-shell-p0` in a worktree off `origin/main`, https URLs in `.gitmodules`,
pinned to the pushed SHAs. Draft commands (run inside the worktree, all via flox):

```sh
task worktree:guard
git worktree add ../wt-native-shell-p0 -b feat/native-shell-p0 origin/main
git -C ../wt-native-shell-p0 submodule add \
  https://github.com/2600hz-oscillator/patchtogether-es9.git apps/helpers/es9
git -C ../wt-native-shell-p0 submodule add \
  https://github.com/2600hz-oscillator/patchtogether-nativeapps.git apps/helpers/nativeapps
# verify pinned SHAs match the audited push SHAs, then commit
```

**CI verification (done, read-only): web CI never clones submodules.** No workflow
under `.github/workflows/` sets a `submodules:` key on any `actions/checkout` step
(15 checkout uses in ci.yml alone, grep across all 15 workflow files: zero hits);
actions/checkout defaults to `submodules: false`. Adding `.gitmodules` therefore
changes nothing for Linux CI. Zero workflow-file changes needed or made.

Non-gating `helpers:protocol-diff` parity report (plan §4.8): browser twins are
`packages/web/src/lib/audio/es9/es9-protocol.ts` + `packages/web/src/lib/audio/vst/vst-protocol.ts`;
Swift sources `apps/helpers/es9/Sources/ES9Core/BridgeProtocol.swift` +
`apps/helpers/nativeapps/Sources/BridgeKit/{BridgeWire,MidiWire}.swift` +
`Sources/VSTBridgeCore/VSTProtocol.swift`. Deferred to the same branch (needs the
submodules present to diff against); keep it report-only per the no-new-gates ruling.

## 4. Signing recon (owner answer 4: reuse ../doomviz / ../p10entrancer setup)

- **`../doom_viz` has NO signing setup.** It contains only a JUCE build artefact tree
  (`build/DoomViz_artefacts/AU/DoomViz.component` — codesign reports it is NOT signed)
  and empty resources/test dirs; no project source, no electron-builder, no
  entitlements, no export config. `../doom` is the id Software linuxdoom source drop.
  The reusable setup lives entirely in p10entrancer + this machine's keychain.
- **`../p10entrancer` is the working precedent** (XcodeGen iOS/App Store app):
  - `project.yml`: `CODE_SIGN_STYLE: Automatic` + `DEVELOPMENT_TEAM` set (the Apple
    team; exact ID in that file and in `ExportOptions.plist` — not copied here).
  - `ExportOptions.plist`: app-store method, automatic signing, same team.
  - `scripts/asc_testflight.py` + `asc_appstore_submit.py`: App Store Connect API
    automation via JWT — the private `.p8` key lives OUTSIDE any repo at
    `~/.appstoreconnect/private_keys/` (two AuthKey files present on this machine);
    only the key id + issuer id constants are in the scripts. No Apple ID password
    anywhere. `scripts/deploy.sh` is device-deploy (xcodegen + xcodebuild), not
    signing infra.
- **Keychain (this machine): a valid "Developer ID Application" identity EXISTS for
  the same team** (verified via `security find-identity -v -p codesigning`; also an
  "Apple Development" cert under a second personal team). This is the exact identity
  class Electron notarized distribution needs — no new Apple enrollment required.
- **How P7 reuses it:** electron-builder mac target with the existing Developer ID
  identity (`CSC_NAME`/identity by team), `hardenedRuntime: true`, entitlements file
  (new — neither sibling has one; p10entrancer is automatic-signing iOS, no
  .entitlements on disk), and `notarytool` fed by the EXISTING App Store Connect API
  key (`--key ~/.appstoreconnect/private_keys/AuthKey_<id>.p8 --key-id <id>
  --issuer <issuer>` — or an electron-builder `APPLE_API_KEY*` env triple). Nothing
  to copy into any repo; P7 wires env vars to the files already on the owner's
  machine. Open question for P7 remains only the distribution channel (DMG direct vs
  anything store-shaped — the ASC scripts prove store tooling exists if wanted).

## 5. Battery / branch state

No inet.modular tree changes were made (submodule work blocked on the pause →
lint/typecheck battery deferred to when the branch actually exists). No worktree
created yet — `task worktree:guard` first when resuming.
