# Cross-machine audio-drift test

Two-runner extension of the same-machine harness in `e2e/audio-drift/`.
Each runner is a separate `ubuntu-latest` GitHub Actions VM; both connect to
the same rackspace on `autotest.patchtogether.live` via the share-URL invite
flow; their captured audio is compared in a third coordinator job.

This addresses the same-machine harness's caveat:

> Same-machine bias: real cross-machine drift could be 5–10× worse. Numbers
> are a lower bound; would benefit from a Tailscale + two-laptop follow-up.

## How it works

1. `setup-rack` — emits the rack URL (`https://autotest.patchtogether.live/r/<id>?invite=<code>`) and the scenario list as job outputs. Reads two repo secrets (`AUTOTEST_TEST_RACK_ID`, `AUTOTEST_TEST_RACK_INVITE`) and a third (`AUTOTEST_BETA_GATE_PASS`) for the basic-auth gate.
2. `runner-a` — Author. Loads the rack URL, authors the scenario's patch via the `__patch` + `__ydoc` hooks, waits a few seconds for the listener to converge, captures audio, uploads `audio-drift-<scenario>-author.pcm` + `.json`.
3. `runner-b` — Listener. Loads the rack URL, waits for the patch to appear in its local engine (Yjs sync), captures audio, uploads `audio-drift-<scenario>-listener.pcm` + `.json`.
4. `compare` — Downloads both runners' artifacts, aligns by wall-clock timestamp, runs the same metrics as the local harness (Pearson, spectral correlation, RMS diff, phase drift), writes a CSV + Markdown report and posts a step summary.

The matrix dimension is per-scenario, so we get N pairs of `runner-a` + `runner-b` jobs in parallel; each pair owns one scenario.

## Triggering

Manual:

```sh
flox activate -- gh workflow run audio-drift-cross-machine.yml \
  -f scenarios=01-static-vco,04-sequenced \
  -f seconds=5
```

Or via the Actions tab → "Audio drift — cross-machine" → Run workflow.

Scheduled: runs every Monday at 06:00 UTC.

## Expected runtime

5 scenarios × (3 min Playwright per runner pair, plus install) ≈ 5–7 minutes wall-clock with parallel matrix. Compare job adds another minute.

## Reading the report

Artifacts of the comparison job: `audio-drift-cross-machine-<run-id>`. Inside:

- `audio-drift-cross-machine-results.csv` — one row per scenario; suitable for diffing across runs.
- `audio-drift-cross-machine-report.md` — human-readable report.
- `audio-drift-cross-machine-summary.json` — `{ scenarios: [...], counts: {yes, with-caveats, no}, headline }`.

The "Acceptable" column uses a looser bar than the same-machine harness because **two real users on different machines never sample-align** — the only meaningful question is "do they hear the same musical content?". Cross-machine criteria:

| Acceptable | spectralPearsonAvg | phaseDrift μs/sec |
|---|---|---|
| yes | ≥ 0.85 | ≤ 500 |
| with-caveats | ≥ 0.70 | (any) |
| no | < 0.70 | (any) |

Compare to the same-machine bar (≥ 0.98 spectral for static; ≥ 0.9 for clocked); the cross-machine bar is intentionally looser because cross-machine samples will never be byte-identical even on infinite compute.

## One-time setup — repo secrets

The workflow needs three repo secrets:

| Secret | Value |
|---|---|
| `AUTOTEST_BETA_GATE_PASS` | already set (used by live-smoke) |
| `AUTOTEST_TEST_RACK_ID` | a rackspace ID on autotest |
| `AUTOTEST_TEST_RACK_INVITE` | the matching invite code |

To populate the rack secrets:

1. Sign into `https://autotest.patchtogether.live/sign-in` (basic-auth gate creds, then a Clerk test user).
2. Create a rackspace (Dashboard → New rackspace).
3. Open the rack and click "Copy invite URL".
4. The URL has the form `https://autotest.patchtogether.live/r/<id>?invite=<code>`. Set `AUTOTEST_TEST_RACK_ID = <id>` and `AUTOTEST_TEST_RACK_INVITE = <code>` in repo Settings → Secrets and variables → Actions.

The same rackspace is reused across runs; each runner authors a fresh patch into it. Old patch state is overwritten by the author at the start of each scenario. If the rackspace ever falls off the 4-rack-per-user cap or the invite changes, regenerate.

## Local validation

You can dry-run the runner against a local stack:

```sh
flox activate -- task dev          # in one shell
# in another:
AUDIO_DRIFT_SCENARIO=01-static-vco \
AUDIO_DRIFT_ROLE=author \
AUDIO_DRIFT_RACK_URL='http://localhost:5173/r/local-test?invite=...' \
AUDIO_DRIFT_OUT_DIR=/tmp/drift-a \
  flox activate -- task audio-drift:cross-machine:runner
```

For a true two-process test, run `runner` twice with different roles + output dirs, then run `compare`:

```sh
AUDIO_DRIFT_A_DIR=/tmp/drift-a \
AUDIO_DRIFT_B_DIR=/tmp/drift-b \
AUDIO_DRIFT_OUT_DIR=/tmp/drift-cmp \
  flox activate -- task audio-drift:cross-machine:compare
```

## Subtleties (from the brief)

- **Time alignment.** Each runner records `Date.now()` at sample 0 (`startedAtMs` in the metadata JSON). The comparator trims the front of whichever buffer started earlier so the aligned slices begin at the same wall-clock instant. Without this, two same-content recordings would show low time-correlation purely from start offset.
- **Hocuspocus connection ordering.** The author's run gets a 3 s headstart (configurable via `AUDIO_DRIFT_AUTHOR_HEADSTART_MS`) between authoring + recording, so the listener's Yjs sync has time to converge. The listener also blocks on the patch being present in its local engine before recording.
- **Network determinism.** Runners are typically in the same Azure region but on different physical hosts. RTT to autotest's CF + Fly is captured per-runner via `ping` and stored alongside the PCM for inspection. Runs from different regions will produce visibly different timing — note the runner's region/IP in the metadata.
- **Chromium audio quirks.** Headless Chromium uses the same audio backend as the same-machine harness; same `--autoplay-policy=no-user-gesture-required` flag. The audio gate (`AudioGate.svelte`) is a B5 follow-up; the runner clicks `body` to satisfy it.
