# edge-scripts — vendored browser-path helper artifacts

Operative scripts and research for the still-supported BROWSER path (Edge on
macOS) and the PTZ camera helper, vendored into the tree during native-shell P0
(2026-09-03) because they previously lived in unversioned single-point-of-loss
locations. Each file was secrets-audited on the way in (no keys, tokens,
credentials, or machine identifiers; absolute home paths genericized or
parameterized — see per-file notes).

| file | provenance | notes |
|---|---|---|
| `start_edge.sh` | `~/Documents/workspace/scratch/` (untracked) | Launches Edge with `--disable-features=MidiMacUmp` (Chromium ≥152 macOS SysEx regression — send() succeeds, nothing transmits). Kills straggler Edge processes first because the flag is silently dropped if ANY Edge process is alive. Vendored change: Edge binary overridable via `EDGE_BIN`. |
| `edge_defaults.sh` | `~/Documents/workspace/scratch/` (untracked) | User-level `defaults write com.microsoft.Edge` re-assert of `AutomaticFullscreenAllowedForUrls` (gesture-free `requestFullscreen` for the present sink). Observed to vanish 2026-08-29. Pins `localhost:5173`; `tier0-edge-policy.sh` is the broader any-port variant. Vendored verbatim. |
| `tier0-edge-policy.sh` | `~/Documents/workspace/patchtogether.browser/` (NOT a git repo) | Root-only MANAGED policy (raw plist into `/Library/Managed Preferences/` — `defaults write` there exits 0 and writes NOTHING, measured 2026-08-26). Grants gesture-free fullscreen AND popups for prod/dev/per-PR-preview origins plus any-port localhost. The per-projector-click killer. Public origins only; vendored verbatim. |
| `start_ptz.sh` | `~/Documents/workspace/scratch/` (untracked) | Foreground launcher for the in-tree `tools/pt-ptz` helper (probe, single-instance guard, build-if-missing). Vendored change: repo root derived from the script's own location (override `PT_REPO` / `PTZ_BIN`) instead of a hardcoded home path; a machine-local worktree candidate path was dropped. A near-twin (the pre-parameterization version) is tracked at `tools/pt-ptz/start_ptz.sh`. |
| `ptzcam-research.md` | `~/Documents/workspace/scratch/` (untracked) | NexiGo P610 UVC-PTZ research: hardware probe procedure, `getUserMedia` pan/tilt/zoom constraint path, VISCA/Web Serial fallback. Feeds P5's camera panel design. Vendored change: two absolute checkout paths genericized. |

Related, NOT here:

- `tools/pt-ptz/` — the PTZ helper itself (C source, Makefile, launcher twin);
  in-tree and tracked all along.
- `apps/helpers/es9` + `apps/helpers/nativeapps` — the Swift bridge helpers,
  added as submodules in the same P0 pass.
