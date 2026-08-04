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

### ⚠ `E2E_PORT` DOES NOT ISOLATE VRT/e2e — the dev server always binds 5173

`packages/web/vite.config.ts` declares no `server.port`, so
`npm run dev -w packages/web` **always binds 5173**. `E2E_PORT` only rewrites
Playwright's *client* URL. An "isolated-port" VRT run therefore captures **from
whatever answers 5173**.

**Proved**: a card label edited to `ZZZZ` and confirmed live in the file;
`E2E_PORT=5199 task vrt:one -- wavecel` **passed at threshold 0 / ratio 0**, and a
forced re-capture wrote a **byte-identical** PNG.

Consequences for anyone giving agents port instructions:
- "Use a non-5173 port" works for unit tests and for a plain dev server. For **VRT and
  e2e it is partly fiction** — the capture may come from another process entirely.
- Worktree copies of `Taskfile.yml` carry a comment: *"HONOUR E2E_PORT — … this line
  used to NOT, which made `E2E_PORT=N task e2e:one` actively dangerous."* Someone hit
  this before. **Check whether that fix is on main.**
- **#1350 (wavecel) expects VRT red on CI.** If it returns green, treat it as the
  sub-tolerance case: `git rm` the baseline, then dispatch `vrt-update.yml`.

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
| **`buildCvCurve`'s LUT is 4096 points — EVEN** | `cv = 0` lands between samples and reads **0.000733**, a ≤0.0015× offset on a patched-but-idle cable | shared by **every** `cvScale` port in the repo; not folded into an atomic module PR |
| **Three `packages/dsp` tests have thin timeout headroom** | `snaredrum-dsp`, `tidy-vco-dsp.sonic-range`, `warrensspectrum-masspass` — all 5000 ms vitest timeouts under concurrent load, **all pass in isolation** (masspass: 23/23, one test at 2935 ms) | reported independently by **three** agents. Same class as the 27 e2e tests #1341 budgeted, different lane |
| **samsloop faders are not cross-clamped** | END can be dragged below START → silent one-sample window, no on-screen explanation | pre-existing; the clamp is a behaviour call for the owner. Flagged for the revamp |
| **`vrt-meta.test.ts` barrel-import test** | 3.3–3.6 s against vitest's 5 s default; timed out once under contention | same thin-headroom class |

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
