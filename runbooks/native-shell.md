# Native shell (Electron desktop) — build, run, test

Operating procedures for `apps/desktop` and the native helpers in
`apps/helpers/`. The architecture and what is / is not built are in
[docs/design/native-shell.md](../docs/design/native-shell.md).

`apps/desktop` is a **standalone npm package with its own lockfile** — deliberately
not a root workspace, so web CI installs and the shared root lockfile stay
untouched. Everything below runs through Flox: `flox activate -- …`.

## One-time per checkout

```sh
flox activate -- task desktop:install     # npm install inside apps/desktop
```

## Build and run

```sh
flox activate -- task desktop:build:web   # the web bundle the shell serves
flox activate -- task desktop:dev         # boot the shell against that bundle
```

`desktop:build:web` sets `PT_DESKTOP_BUILD=1`, which switches
`packages/web/svelte.config.js` to **adapter-static** (Cloudflare stays the default
for real deploys), and bakes `VITE_E2E_HOOKS=1`. That makes it the **Tier-A test
bundle the harness drives, not a shipping artifact.**

Two seams in the served bundle are easy to break and were each found the hard way:

- **The SPA fallback.** `/rack` has no prerendered HTML; adapter-static's
  `fallback.html` boots the client router instead.
- **The `__data.json` shim.** The root `+layout.server.ts` makes the client router
  fetch `<route>/__data.json` on SPA navigations. The prerendered root file *is*
  the signed-out payload, so the server answers any data request with it. Without
  the shim, `/rack` renders the client 404 — measured; the first harness run failed
  exactly there.
- **COOP/COEP.** `apps/desktop/src/server.ts` mirrors `packages/web/_headers`:
  `same-origin` + `credentialless`. Diverge and either cross-origin isolation
  (Faust/SharedArrayBuffer) or archivist's cross-origin media breaks.

Env seams (documented defaults in `apps/desktop/src/main.ts`):
`PT_DESKTOP_PORT` (9409 — es9-bridge owns 9209, vst-bridge 9309; `0` = ephemeral,
used by the harness), `PT_DESKTOP_WEB_ROOT`, `PT_DESKTOP_WINDOWED=1` (plain window
instead of fullscreen), `PT_HELPERS=off`, and `PT_HELPER_<ID>_BIN|_ARGS|_PORT` for
injecting stub helper binaries.

## Display-spike hardware review

After `desktop:install` and `desktop:build:web`, run the opener→popup harness
with two physical displays connected and mirroring off:

```sh
flox activate -- task desktop:spike
```

The [spike guide](../apps/desktop/SPIKE-OPENER-DISPLAY.md) explains the automatic
checks, the required physical-output confirmation, and where to record the verdict. `task desktop:spike -- --dry-run`
checks the harness wiring on one display; that result does not validate
cross-display output. The optional `--crash-probe` records the popup's fate after
an opener renderer crash. Use `--display-id=<printed ID>` to select a target. `task desktop:spike:check`
verifies the instrument with real Electron failure controls; `REPEAT=3` repeats
those cases. Hardware validation remains a manual review step.

## Native helpers

The two Swift bridges live **in-tree** — `apps/helpers/es9` (es9-bridge) and
`apps/helpers/nativeapps` (BridgeKit + vst-bridge) — folded in from their
standalone repos with their history on 2026-09-14 (owner: "vst, es9 and etc
should all be in main repo now as part of our native chromium app effort").
There are no submodules to initialize; a helper change is an ordinary PR here.
Each package keeps its own `README.md`, `LICENSE` (MIT) and `.gitignore`
(`.build/`); `apps/helpers/nativeapps/CLAUDE.md` is that package's own agent
notes — the root `AGENTS.md` remains the authority.

```sh
flox activate -- task helpers:build       # macOS only — compiles ONLY, nothing starts
```

Runs `swift build -c release` in each package, plus `make -C tools/pt-ptz`.
`apps/desktop/src/main.ts` (`resolveHelperBinary`) spawns the built binaries
from `apps/helpers/<pkg>/.build/release/` when the shell runs unpackaged.

### Starting and stopping the bridges by hand

```sh
flox activate -- task helpers:start                      # both, detached (es9 9209, vst 9309)
flox activate -- task helpers:es9:start -- --synthetic   # one, with flags (no ES-9 needed)
flox activate -- task helpers:vst:start
flox activate -- task helpers:status                     # listening? which PID? ours? log path
flox activate -- task helpers:stop                       # both; helpers:es9:stop / helpers:vst:stop for one
```

`scripts/helpers.sh` runs the **built** binary detached (`nohup`), building a
missing one first, and keeps the PID, port and log under `.helpers/`
(gitignored, like `.dev-server/`). `start` prints the harness
(`http://127.0.0.1:<port>/`) and protocol (`ws://127.0.0.1:<port>/ws`) URLs
once the socket is bound, and **refuses** — naming the PID — when something
already listens on the port; ports come from `--port N` in the args, else
`PT_HELPER_ES9_PORT` / `PT_HELPER_VST_PORT` (the same seam the shell reads),
else 9209/9309. `stop` sends SIGINT to the recorded PID (both bridges handle
it), escalates TERM → KILL on a bounded wait, then verifies the port is free;
with no PID file it falls back to the port's listener **only when that
listener's executable is this checkout's helper** — anyone else's bridge (the
owner's hardware test, a sibling worktree) is named, not killed
(`HELPERS_FORCE=1` overrides). A start without a stop is the foot-gun the es9
README warns about: a bridge that outlives its terminal is reparented to
launchd and keeps holding the port and the ES-9.

### Secrets gate — run before EVERY push of new or rewritten helper history

This repo is public, and so are the two standalone helper repos the packages
were imported from (frozen at the import commits; archiving them is an owner
action). Run this at the time of the push; never cite a previous run as the
record.

1. `flox activate -- git log -p -- apps/helpers > <scratch>/audit.txt` for
   history written in-tree (the pre-fold history sits behind the second parent
   of each `chore(helpers): fold …` merge and was audited at the fold; in a
   standalone repo use `log -p --all`), then grep
   for keys, tokens, passwords, `.env`, PEM blocks, serial numbers, absolute home
   paths, and user identifiers/emails.
2. Repeat the grep over the working tree, including untracked files
   (`git status --ignored`).
3. Confirm the repo-local `.gitignore` covers local agent state and build output —
   a global gitignore protects only that one machine.
4. Any hit → rewrite history (`git filter-repo` or fresh-init) and **re-run from
   step 1**.
5. Record the run **in the PR body that lands the push** — command, date,
   paraphrased hit list, verdict (AGENTS.md: the PR body is the searchable
   record), written at execution time. Paraphrase — no verbatim quotes or
   profanity in anything that can reach GitHub.

## Tests

```sh
flox activate -- task desktop:e2e                       # the whole desktop harness
flox activate -- task desktop:e2e:one -- supervision    # one spec by filter
```

For `REPEAT=N`, run `npx playwright test <filter> --repeat-each=N` inside
`apps/desktop`.

⚠ **Harness dependencies live in `apps/desktop`, never in `e2e/package.json`.**
That file is a webgl-attest toolchain pin (`scripts/webgl-attest-lib.ts` hashes it
because it pins `@playwright/test` — the renderer/engine version). Any dependency
added there moves the content hash and demands a real-GPU re-attest.

The lane anchor is `Taskfile.yml`'s `desktop:e2e` task: Playwright's `testDir`
globs `apps/desktop/e2e/`, so a new spec joins the lane without editing anything,
but renaming `boot.spec.ts` reddens `scripts/package-workspace-membership.test.ts`.

**There is no desktop job in `.github/workflows/ci.yml`.** Wiring one is a change
to a required check: it needs owner wall-time sign-off first, and the umbrella's
`needs:` and failing `if` must name the job identically — enforced by
`scripts/ci-umbrella-parity.test.ts`, which reads the workflow rather than a
hand-typed list.

## Electron pin bumps

The pin is exact on purpose. At every bump:

1. **Re-check the MidiMacUmp/SysEx exposure.** Without
   `--disable-features=MidiMacUmp`, SysEx reports send success while transmitting
   nothing — Electra flashes and PTZ moves just vanish, with no error.
2. **Re-run the opener→popup probe.** Same-origin `window.open` DOM access under
   `setWindowOpenHandler` is the premise the output-window blit design rests on.
   It passed on the pinned version; a regression re-plans that work.
3. Run `task desktop:e2e` — the boot spec pins `crossOriginIsolated`, an
   AudioContext reaching `running` with zero gestures, zero pageerrors and exactly
   one window, so a moved default reddens there rather than on stage.

## Interim unsigned builds

Until distribution is signed, ad-hoc rebuilds change the binary's identity, so
**macOS TCC grants do not persist across rebuilds** — the operator re-grants
camera/mic each time, and a fresh download needs its quarantine attribute
removed. Camera/mic usage strings ship in the packaging config already; macOS
kills a packaged app on first `getUserMedia` without them, signed or not.

## Owner-machine smoke checklist

Run at every phase boundary. It is the only coverage for what no tier can see —
signed-build TCC, Gatekeeper, real USB/display hotplug, real ES-9, device-callback
underruns.

Boot the app → zero prompts beyond the expected TCC → pre-flight shows every helper
row → bind four cameras and displays → rack plays → SysEx device round-trip
(PTZ/Electra) → load a patch mid-performance (no blink, no silence) → recorderbox
record and Save (no audible dip) → sleep/wake, still running → unplug a display,
outputs re-place → quit clean, then confirm no orphan helper processes are still
running.
