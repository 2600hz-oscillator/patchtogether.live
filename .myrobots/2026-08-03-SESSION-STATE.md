# 2026-08-03 — SESSION STATE AND HANDOFF

**Read this first if you are picking up work.** It records what landed, what is in
flight, what is blocked and why, and the decisions the owner made — so the next
session does not re-derive them or repeat corrected mistakes.

Companion files written the same day:
- `2026-08-03-MODULE-AUDIT-INVENTORY.md` — all 178 defects across 18 audited modules
- `2026-08-03-BLIND-GATES-FOUND.md` — every gate found unable to see its own subject

---

## 0. THE LINE IN THE SAND (owner directive, end of session)

> "modules we have not actually started building yet are going to wait for the next
> session… agents in flight doing fixes and design etc should finish, but we wont
> build any more faceplates we have not already started"

**So: do NOT start new faceplate work or new audit batches from this file alone.**
Finish what is listed as in-flight in §3. New batches need the owner to say go.

---

## 1. WHAT MERGED (20 PRs)

| PR | what it fixed |
|---|---|
| #1316 | samsloop recorder was silent; tomtom strike stuck in the Y.Doc permanently |
| #1319 | Playwright `--global-timeout` guard so a killed shard stops destroying its own evidence |
| #1321 | score tied-gate: an ordering race, not a timing bug (see §5) |
| #1322 | scaffolder leaked a blank line per `--undo` into a shared registry file (200 already committed) |
| #1323 | twotracks OUT L and OUT R were the SAME graph edge — fake stereo |
| #1324 | two exemption ratchets carrying 5 slots of silent pre-authorisation |
| #1325 | the frames-vs-milliseconds gate was UNSOUND, not merely tight |
| #1327 | heavy-GL budget was flat for 74 of 78 modules while looking derived |
| #1328 | snaredrum's roll sizzle panned OPPOSITE the hand that struck it |
| #1329 | emit sweep worst plan 980 s → 300 s, −78 s CI wall-time |
| #1332 | faces batch 3 — 4 faceplates + horizontal band packing across 20 faces |
| #1333 | `vrt-update.yml` re-validation never ran for single-platform dispatch |
| #1334 | warrensspectrum MASSPASS — the second of three VST engines |
| #1335 | P0: a 1-second hash check timing out inside a 2-minute npm install |
| #1336 | behavioral sweep measured against a control it could not reproduce |
| #1338 | the face-batch process encoded as two repository skills |
| #1339 | Push LEGEND was on CC 28; the owner's button is **CC 48** |
| #1341 | unpatch test PASSED every assertion and was killed 0.77 s late |
| #1343 | **five stereo modules rendered OUT R at digital silence for every mono patch** |
| #1314 | cube MORPH was a bit-exact no-op at spawn |

## 2. OPEN PRs — both need HARDWARE, not CI

| PR | state | what the owner must check |
|---|---|---|
| **#1340** Push ELECTRA CONTROL mode | `CLEAN`, all required checks green | CC 49 is the labelled "Shift"; CC 27 is the button above channel 8; **where CC 15 physically sits** |
| **#1342** MIDI ownership + Electra crosstalk | `CLEAN`, all required checks green | Push + Electra connected, turn a Push encoder; the Electra's **input** port names (the fix rests on `/electra/i` matching an input — unverified) |

**Merge #1342 first.** Its Electra fix is a live crosstalk bug; testing #1340's
encoders is cleaner once a Push knob is known not to be moving an Electra parameter.

---

## 3. IN FLIGHT AT SESSION END — let these finish

Seven agents, all instructed to push-and-report, not merge.

| work | modules | notes |
|---|---|---|
| fix | **rings, timelorde** | rings ODD silent at default; timelorde SWING does not swing |
| fix | **treeohvox, wavecel** | envelopes bypassed; ⚠ shared helpers `poly-osc-sum.ts` / `wavetable-osc.ts` also feed cube, dx7, pentemelodica — blast radius must be enumerated |
| fix | **cofefve, charlottes-echos** | ⚠ shared `analog-delay-core.ts`; must branch AFTER #1343 (it did land) |
| fix | **samsloop** | START/END regression, owner-reported. **Regression hunt first, fix second** |
| fix | **the mono-normal gate** | the gate shipped in #1343 sees 7 of 10 normals (30 % blind) — see §6 |
| feat | **twotracks** | rate/speed CV in for both reels, owner HIGH PRIORITY |

**If any of these did not produce a PR, that is the first thing to check.**

---

## 4. OWNER DECISIONS MADE THIS SESSION — do not re-litigate

1. **Sound changes merge on green.** Measured DSP fixes with negative-controlled
   tests do not need owner preview. Report what landed afterward.
2. **Face PRs auto-merge on green.**
3. **`face.title` stays annotation-only.** It is a category word; the dock title bar
   already paints the module NAME. *"Two names on one panel was the actual complaint."*
4. **samsloop-class modules: build the platform shell cell FIRST.** A file-loader /
   recorder shell cell that reaches the dock is a platform PR. Until it exists, an
   agent's only correct answer for samsloop is **do not promote** — promoting it
   removes the only ways to get audio in.
5. **Warren's Spectrum engine order: MASSPASS first (done, #1334), then WAVETABLE.**

---

## 5. THINGS I GOT WRONG — recorded so they are not repeated

Four hypotheses of mine were disproven by measurement. The consistent shape: I reached
for the dramatic explanation; the real one was a number nobody had re-derived.

| I claimed | the truth | how it was settled |
|---|---|---|
| shard 8 died from a browser crash | a **test-timeout overrun** — screenshot AND video were captured on both attempts, impossible against a dead target | 1152-line log, zero crash markers |
| `runFor` (a wall-clock wait) was the pathology | the failing call was `runFor(page, 100)` — a 100 ms wait that merely happened to be where the clock ran out. The real defect was a **flat budget wearing a scaled costume** | `Math.max(90_000, ports*2000+30_000)` binds only above 31 ports |
| main was red because a face threw during shell boot | the page mounted in **828 ms with zero pageerrors**; the PR had **outgrown a sweep budget** (adopter roster 1 → 5) | measured both arms |
| main was red from the docs-only skills merge | that job belonged to a **different run** (#1336's). I read a job ID against the wrong run, then invented a `paths-ignore` bug from my own misattribution — `ci.yml` ran **0 times** for that commit, exactly as designed | run/job IDs re-checked |
| a MIDI LANE silently kills the Push's inbound stream | **FALSE.** `requestMIDIAccess()` returns a distinct `MIDIAccess` per call; `a1.inputs.get(id) === a2.inputs.get(id)` is false for all 6 ports, so a destructive sweep over one access leaves another's handler installed | measured in Chrome with the Push attached |
| `face.title` always paints | **FALSE.** `facePageHeader(def, annotations = false)` returns `null` before reading anything — title included | `dock-faceplate-model.ts:86-95` |
| `engineMode` shipped declared-but-SPECTRAL-only | **FALSE.** `git grep engineMode` returned nothing repo-wide; the plan described something that never shipped | the def header still said "STILL ABSENT" |

**The lesson worth carrying: check the boring thing first.** A number, a budget, a
timeout, a job ID. The interesting explanation was wrong every single time.

---

## 6. THE MONO-NORMAL GATE IS BLIND — highest-priority open defect

`packages/dsp/src/mono-normal-not-defeated.test.ts` shipped in #1343 as the
deny-by-default guard against a sixth module joining the OUT-R-silence class.

**Batch 3 ran the shipped detector verbatim over all 63 files in `packages/dsp/src`:
7 found, 3 real normals MISSED — 30 %.** Two are stereovca's
(`packages/dsp/src/stereovca.ts:65-66`, `const inR = inRRaw ?? inLBuf;`), one is
`samsloop-tap.ts:67`. The regex at `:83` matches one expression on one line and
cannot see the same normal expressed through intermediate consts.

Also: `e2e/tests/stereo-mono-normal.spec.ts`'s SUTS roster is **hand-maintained and
omits stereovca**, so nothing in any lane can see stereovca's right channel.

A fix agent was dispatched for this at session end. **Verify it landed.**

---

## 6b. LATE FINDINGS — after the first draft of this file

### The samsloop regression was OURS, same day (#1316 → fixed in #1353)

The owner reported START inert, END blanking the clip, playback stopping — and was
right that it had worked before. **Breaking commit `bbba5b5d` (#1316), merged ~12 h
earlier.** Its new record branch does:

```ts
postBuffer(f32, src.sample.rate);                                  // NEW in #1316
if (ld.sampleLength !== f32.length) ld.sampleLength = f32.length;  // NEW in #1316
```

`postBuffer` calls `postMessage(msg, [f32.buffer])`, which **TRANSFERS the ArrayBuffer
and detaches every view onto it**. One line later `f32.length` is `0`, so every
recording persisted `sampleLength = 0`. The upload branch measures a different,
un-transferred array — which is why this was record-path-only and the upload e2e
stayed green.

**One cause, three symptoms**, because the card sizes both window faders with
`max={Math.max(1, sampleLength)}` — a `0` there is a **[0,1] slider on a 39 680-frame
take**. Dragging START to 80 % set it to **0.7999998 of a sample**. END wrote ≤1 → a
one-sample window → DC → silence. The highlight band is `end / samples.length` wide,
so it collapsed: band px **12387 → 0**. "Black" *is* the band losing its width.

Fix shape worth copying: `postSampleBuffer` captures the frame count **before** the
transfer and returns it, so the correct number is the only one available after the
call. **The mistake becomes unwritable, not merely fixed once.**

### ~~`E2E_PORT` DOES NOT ISOLATE VRT/e2e~~ — **RETRACTED 2026-08-04. THIS WAS FALSE.**

**`E2E_PORT` DOES isolate.** It has since **#1216 (2026-07-28)**, whose title is
literally *"make E2E_PORT actually isolate — e2e:one and vrt:one ignored it"* —
a week BEFORE I claimed to have found the hole. Both Taskfile targets compute
`PORT="${E2E_PORT:-5173}"` and export `E2E_BASE_URL`, and `scripts/dev-server.sh`
passes `--port "$PORT" --strictPort`.

**Why my "proof" was worthless.** I edited `wavecelDef.label` to a sentinel and
concluded, when the VRT still passed, that the capture came from another server.
It did not. **The card never renders `def.label`** —
`WavecelCard.svelte:216` is `<ModuleTitle {id} {data} defaultLabel="WAVECEL" />`,
and `ModuleTitle` routes through `node.data.name`. My perturbation was
**invisible to the image**, so a passing VRT was the CORRECT result.

This is the exact failure CLAUDE.md warns about, committed by the person who
wrote the warning down four hours earlier: *"Negative-control the INSTRUMENT,
not just the code — perturb the thing it claims to measure and confirm the
number moves."* I never checked that the sentinel reached a pixel. A metric
blind to the dimension under test returns a clean number, and I read that clean
number as a finding.

**How it was settled**: served source on the isolated port contained the
sentinel (so the server WAS mine), then `WavecelCard.svelte:216` showed the
title comes from a hardcoded string. Both halves needed; either alone is
ambiguous.

**The ONE narrow thing that IS true**, and is not the above: with **no server
already running**, Playwright's own `webServer` boots on its config's port
(5173 / 4173) and does not consult `E2E_PORT`. The documented workflow — start
your own server, then run against it — isolates correctly. So:

> Start your own dev server on your own port FIRST (`npm run dev -w packages/web
> -- --port N --strictPort`), then `E2E_PORT=N task vrt:one -- …`. Do not rely
> on the auto-boot path to honour `E2E_PORT`.

**A real (smaller) defect found while disproving the fake one.** 190 cards pass
a **hardcoded** `defaultLabel="…"` rather than deriving it from the def — the
same second-source-of-truth class as the AnalogVcoCard `min={0}` range bug. At
least one genuinely disagrees: `clocked-runner.ts` declares `label: 'clocked'`
while `ClockedRunnerCard.svelte` shows `'clockedRunner'`. ⚠ My first scan
reported "17 mismatches"; most were artifacts of my own comparison (HTML
entities — `CHARLOTTE&#39;S ECHOS` vs `charlotte's echos` — and case, `LFO` vs
`lfo`). **The 17 is NOT a verified number.** Anyone picking this up must
re-derive it with entity decoding and case folding before quoting it.

### The mono-normal gate was 46 % blind, not 30 %

Corrected figures: the real population is **13** normals, not 10. Shipped detector
found **7**; **6 missed (46 %)**. Beyond stereovca ×2 and `samsloop-tap.ts:67`, also
missed: `ringback.ts:72`, `recorderbox-capture.ts:53`, and `twotracks.ts:606` (a
**computed** index, `inputs[inputOffset + 1]`).

Two things that finding surfaced:
- **The blindness was masking a crash.** `factoryFor()` assumed same-basename;
  samsloop-tap's factory is `samsloop.ts` and recorderbox-capture's is a *video*
  module — the gate would have thrown ENOENT the moment it could see either.
- **The fix's own first draft had the same defect one level down**:
  `defeatReason()` used `blankNonCode()`, which blanks string literals, so the
  `'discrete'` search could never fire and the channel-defeat leg was silently dead.
  Caught only because the negative-control matrix required every spelling to go red.

Fixed in **#1351**. Note: this repo has **no AST-gate precedent** — zero uses of the
TypeScript compiler API, and `module-manifest.ts:9-16` documents a decision against it.
Coverage is instead made *provable* by a residual audit: 13 normal / 42 default /
399 not-input / **0 unclassified**.

### OPEN, UNFIXED, DELIBERATELY — carry these forward

| item | evidence | why not fixed |
|---|---|---|
| **`cube` has wavecel's exact envelope bypass** | `cube.ts:405` `base_vol` default 1; `:753` `readFrame(…) * baseVol * level` | `poly-osc-sum.ts` was left untouched precisely so cube and pentemelodica would not move. Needs its own PR |
| **`cloudseed` — a THIRD stereo-silence mechanism** | `cloudseed.ts:1510-11` reads `inputs[0]`/`inputs[1]` with **no `??` at all** — a mono patch leaves `inR` undefined | a *missing* normal, not a defeated one; audio behaviour change needing an owner ear + ART re-pin. Carried as a named ledger row in #1351 |
| **`buildCvCurve`'s LUT is 4096 points — EVEN** → **FIXED in #1358, but MY NUMBER WAS WRONG** | `0.000733` was **an artifact of the measuring tool**, not the audio: it is `curve[2048]`, a **nearest-index** read (how this repo's own test helper sampled curves). A real `WaveShaperNode` **interpolates**, and for `linear` the straddling samples are exact negatives → `twotracks.rate_cv` renders **exactly 0.0**, confirmed in a real Chromium `OfflineAudioContext`. **The port I cited as the flagship example was never affected.** The even-table premise was right only where the delta is NOT odd-symmetric about zero, and there it is worse than I said: **`discrete` mode, 16/17 ports, lands on a HALF-INTEGER — not a legal bucket.** `macrooscillator.model_cv` idled on model **6.5** of 0–13; 8× `mixmstrs.chN_compEnable` **booleans idled at 0.5**, between off and on. `linear`-at-range-end (74 ports, 0.0061 %) and `log` (39 ports, ≤1.1e-5 %) are cosmetic — below float32 param resolution. **130 of 317 ports affected → 0** | Fixed structurally (`CURVE_LEN` 4096 → 4097) so the guarantee holds by construction for every mode, not by accident of symmetry. Endpoints verified unshifted: **0 of 317** ports disagree at `cv=±1`. No ART/e2e consumer, so no baseline moves. ⚠ Bonus: `swolevco`'s `buildVoctCurve` had the identical defect, with a docstring claiming "at v=0V: curve = 0" **and a test asserting the artifact as acceptable** |
| ~~**Three `packages/dsp` tests have thin timeout headroom**~~ **← CLOSED 2026-08-04: NOT A DEFECT** | Re-measured at load **2.19** (was 10.95 when contaminated): **61 files / 1131 tests, 0 failures.** Slowest single test in `snaredrum-dsp` is **1334 ms** against vitest's **5000 ms** budget — **3.7× headroom**. `tidy-vco-dsp.sonic-range` 6511 ms / 27 tests, `warrensspectrum-masspass` 2481 ms / 23 tests | the "load" was 16 CPU burners I leaked. ⚠ I also had the UNIT wrong: vitest's 5000 ms default is **per TEST**, not per file, so `snaredrum`'s 8932 ms *file* total was never near any budget. Nothing to fix |
| **samsloop faders are not cross-clamped** | END can be dragged below START → silent one-sample window, no on-screen explanation | pre-existing; the clamp is a behaviour call for the owner. Flagged for the revamp |
| **`vrt-meta.test.ts` barrel-import test** | 3.3–3.6 s against vitest's 5 s default; timed out once under contention | same thin-headroom class |

### ⚠ I LEAKED 16 CPU BURNERS AND THEN MEASURED AGAINST THEM

**The single worst instrument failure of the session, and it ran for 5 h 41 m.**

Two of my own earlier commands deliberately loaded the box to reproduce a
CI-contention flake:

```sh
for i in $(seq 1 8); do (while :; do :; done) & done
BURNERS=$(jobs -p)
... playwright ... | head -20      # ← the pipeline that never returned
kill $BURNERS 2>/dev/null          # ← THIS LINE NEVER RAN
```

Both invocations leaked all 8. Sixteen spinners, `PPID 1` (orphaned), **~172
minutes of CPU each**, holding a 10-core box at **~990 % total** — roughly 8.5
cores — for nearly six hours.

**Everything measured on this machine during that window is suspect**, and at
least four "findings" trace directly to it:

- The three `packages/dsp` "thin timeout headroom" tests. They pass in
  isolation and fail "under concurrent load" — but the load was 85 % artificial.
  **Three separate agents reported this independently**, which read as
  corroboration and was actually three agents measuring the same contamination.
- The `vrt-meta` barrel-import test at 3.3–3.6 s against a 5 s default.
- The `flox activate` "waiting for another activation" stalls, and the watch
  task that gave up after ~50 min.
- My earlier "Edge has settled to 4.6 %" reading, and the agent sweep that
  aliased against a ~4 s oscillation — that oscillation is what a starved
  scheduler looks like.

**The lesson is the one already in CLAUDE.md, applied to myself: I injected the
confounder, forgot it, and then read its effects as properties of the code.**
A negative control would have caught it in one step — re-run the "slow" test
with the load removed. I never did, because I did not know the load was there.

**Two rules that would have prevented it:**

1. **Never leak a load generator.** `kill $BURNERS` after a pipeline containing
   `| head -N` is unreachable whenever the pipeline hangs — `head` closing the
   pipe does not reliably end the upstream. Use a `trap` on EXIT, or write the
   PIDs to a file and reap them from a separate command that always runs.
2. **Before attributing ANY timing result to "load", enumerate what is actually
   running.** `ps -A -o %cpu,etime,command | sort -rn | head` costs one command.
   An `ELAPSED` of 5 h on a test-shaped process is not contention, it is a leak.

⚠ **`ps` %CPU on macOS is a lifetime average, not instantaneous** — a spinner
and a busy-then-idle process can print the same number. Confirm with
`top -l 2` and read `STATE`.

---

### ⚠ AN ATTEST'S PRECONDITION IS "NO OTHER BROWSER IS RENDERING" — NOT "load is low"

**I nearly quarantined a healthy test over this.** Worth reading before touching
`webgl:attest` or `grand:attest`.

`task webgl:attest` on the cube branch refused: **193 passed, 1 failed** —
`toybox-feedback.spec.ts:227`, unrelated to the change, which passes **3/3 in
isolation**. I checked the box was quiet by **load average** and **free
dev-server ports**, saw both clean, and concluded the failure must be the
already-tracked "flaky toybox WebGL tests in the attest basis" item. I
recommended **quarantining that spec out of the basis** so cube could land.

That would have removed a working test from the gate. The owner corrected it in
one line — *"you didn't have exclusive gpu use, now you do"* — and the re-run on
a genuinely exclusive box **PASSED**, 0 failures.

**Both my checks were blind to the actual precondition.** Two agents were still
finishing their own Chromium runs. Load average and a free port say the **CPU**
is idle; they say **nothing** about whether another browser holds the **GPU**.

- **Check the right thing**: enumerate the contenders, don't read a scalar —
  `ps -A -o comm | grep -ciE "chromium|chrome-headless|playwright"` must be
  **0**, plus no dev server on 5173/4173. A load average cannot express this.
- Contrast with the **grand-attest** the same session, where the pre-flight's
  own `load(1m)` refusal was CORRECT (16 leaked burners, a real CPU problem).
  Same-looking symptom, different resource, opposite conclusion. **Name which
  resource you are claiming is free.**
- ⚠ `toybox-feedback.spec.ts` is **NOT known-flaky on this evidence**. If you
  find it red in an attest, check for other browsers before believing it. The
  tracked "flaky toybox" item is not corroborated by this run.
- Consistent with the standing rule: a refusal is worth more than a green run.
  It refused, and it was right to; my reading of *why* was what was wrong.

---

## 7. STANDING OPERATIONAL FACTS

- **Port 5173 is the owner's dev server. `task e2e:serve` binds it BY DEFAULT** — an
  agent tripped on this. Always pass an explicit other port.
- **Worktrees are OVER the hard cap (11 of 10).** `git worktree remove` was blocked by
  the permission classifier. Reuse merged-branch checkouts; do not create new ones.
- **`task worktree:guard`'s liveness detection does not see in-session agents** — it
  reported `live: 0` while three agents were working. This once caused a live agent's
  worktree to be reaped. Never trust it for automated removal.
- **Attest pre-flight samples `ps` ONCE** and is therefore unreliable in both
  directions — see issue #1331. A co-tenant oscillating 3.5 %→87 % on a ~4 s period
  reads as quiet or busy depending purely on when you look. Sample at irregular
  offsets, immediately before the run.
- **A cancelled GitHub job may be a TIMED-OUT job.** `webgl-attest` has
  `timeout-minutes: 5`, ran 5m16s, and reported as `cancelled` — which is why it read
  as collateral rather than the cause of a red main.
