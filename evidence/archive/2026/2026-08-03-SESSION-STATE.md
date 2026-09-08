# 2026-08-03 — what survived the session

**The status half of this file is gone.** The 20-PR merge table, the two
hardware-blocked open PRs (#1340, #1342 — both merged), the seven in-flight
agents (all seven produced merged PRs), and the mono-normal-gate defect (§6,
landed #1351) were all discharged by 2026-08-09 and verified against the merge
log. What is left is the part that is not a status: owner decisions, corrected
hypotheses, two operational warnings that each cost hours, and the one ledger row
still deliberately open.

Companion files written the same day:
`2026-08-03-MODULE-AUDIT-INVENTORY.md`, `2026-08-03-BLIND-GATES-FOUND.md`.

---

## Owner decisions — do not re-litigate

> **The line in the sand, end of session:** *"modules we have not actually
> started building yet are going to wait for the next session… agents in flight
> doing fixes and design etc should finish, but we wont build any more
> faceplates we have not already started"*

1. **Sound changes merge on green.** Measured DSP fixes with negative-controlled
   tests do not need owner preview. Report what landed afterward.
2. **Face PRs auto-merge on green.**
3. **`face.title` stays annotation-only.** It is a category word; the dock title
   bar already paints the module NAME. *"Two names on one panel was the actual
   complaint."*
4. **samsloop-class modules: build the platform shell cell FIRST.** A file-loader
   / recorder shell cell that reaches the dock is a platform PR. Until it exists,
   an agent's only correct answer for samsloop is **do not promote** — promoting
   it removes the only ways to get audio in.
5. **Warren's Spectrum engine order: MASSPASS first (#1334), then WAVETABLE.**

---

## Things I got wrong — recorded so they are not repeated

Four hypotheses disproven by measurement. The consistent shape: I reached for the
dramatic explanation; the real one was a number nobody had re-derived.

| I claimed | the truth | how it was settled |
|---|---|---|
| shard 8 died from a browser crash | a **test-timeout overrun** — screenshot AND video were captured on both attempts, impossible against a dead target | 1152-line log, zero crash markers |
| `runFor` (a wall-clock wait) was the pathology | the failing call was `runFor(page, 100)` — a 100 ms wait that merely happened to be where the clock ran out. The real defect was a **flat budget wearing a scaled costume** | `Math.max(90_000, ports*2000+30_000)` binds only above 31 ports |
| main was red because a face threw during shell boot | the page mounted in **828 ms with zero pageerrors**; the PR had **outgrown a sweep budget** (adopter roster 1 → 5) | measured both arms |
| main was red from the docs-only skills merge | that job belonged to a **different run**. I read a job ID against the wrong run, then invented a `paths-ignore` bug from my own misattribution — `ci.yml` ran **0 times** for that commit, exactly as designed | run/job IDs re-checked |
| a MIDI LANE silently kills the Push's inbound stream | **FALSE.** `requestMIDIAccess()` returns a distinct `MIDIAccess` per call; `a1.inputs.get(id) === a2.inputs.get(id)` is false for all 6 ports, so a destructive sweep over one access leaves another's handler installed | measured in Chrome with the Push attached |
| `face.title` always paints | **FALSE.** `facePageHeader(def, annotations = false)` returns `null` before reading anything — title included | `dock-faceplate-model.ts:86-95` |
| `engineMode` shipped declared-but-SPECTRAL-only | **FALSE.** `git grep engineMode` returned nothing repo-wide; the plan described something that never shipped | the def header still said "STILL ABSENT" |

**The lesson worth carrying: check the boring thing first.** A number, a budget,
a timeout, a job ID. The interesting explanation was wrong every single time.

---

## The samsloop regression was OURS, same day (#1316 → fixed in #1353)

Kept for the fix SHAPE, which is worth copying.

The owner reported START inert, END blanking the clip, playback stopping. Breaking
commit `bbba5b5d` (#1316), merged ~12 h earlier, whose new record branch did:

```ts
postBuffer(f32, src.sample.rate);                                  // NEW in #1316
if (ld.sampleLength !== f32.length) ld.sampleLength = f32.length;  // NEW in #1316
```

`postBuffer` calls `postMessage(msg, [f32.buffer])`, which **TRANSFERS the
ArrayBuffer and detaches every view onto it**. One line later `f32.length` is
`0`, so every recording persisted `sampleLength = 0`. The upload branch measures a
different, un-transferred array — which is why this was record-path-only and the
upload e2e stayed green.

**One cause, three symptoms**, because the card sizes both window faders with
`max={Math.max(1, sampleLength)}` — a `0` there is a **[0,1] slider on a
39 680-frame take**. Dragging START to 80 % set it to **0.7999998 of a sample**.
END wrote ≤1 → a one-sample window → DC → silence. The highlight band is
`end / samples.length` wide, so it collapsed: band px **12387 → 0**. "Black" *is*
the band losing its width.

**The fix shape:** `postSampleBuffer` captures the frame count **before** the
transfer and returns it, so the correct number is the only one available after the
call. **The mistake becomes unwritable, not merely fixed once.**

---

## ⚠ `E2E_PORT` DOES isolate — my "proof" that it did not was worthless

Retracted 2026-08-04. Kept because the *way* it was wrong is the repo's most
expensive recurring mistake, committed by the person who had written the warning
down four hours earlier.

`E2E_PORT` has isolated since **#1216**, whose title is literally *"make E2E_PORT
actually isolate — e2e:one and vrt:one ignored it"*. I edited `wavecelDef.label`
to a sentinel and concluded, when the VRT still passed, that the capture came
from another server. It did not. **The card never renders `def.label`** —
`WavecelCard.svelte:216` passes a hardcoded `defaultLabel="WAVECEL"`, and
`ModuleTitle` routes through `node.data.name`. My perturbation was **invisible to
the image**, so a passing VRT was the CORRECT result. *Negative-control the
INSTRUMENT: confirm the sentinel reaches a pixel.*

**The ONE narrow thing that IS true:** with **no server already running**,
Playwright's own `webServer` boots on its config's port (5173 / 4173) and does not
consult `E2E_PORT`. So start your own dev server on your own port FIRST, then run
against it. Do not rely on the auto-boot path to honour `E2E_PORT`.

**A real (smaller) defect found while disproving the fake one — STILL OPEN.**
~190 cards pass a **hardcoded** `defaultLabel="…"` rather than deriving it from
the def — the same second-source-of-truth class as the AnalogVcoCard range bug.
At least one genuinely disagrees: `clocked-runner.ts` declares `label: 'clocked'`
while `ClockedRunnerCard.svelte` shows `'clockedRunner'`. ⚠ My first scan reported
"17 mismatches"; most were artifacts of my own comparison (HTML entities —
`CHARLOTTE&#39;S ECHOS` vs `charlotte's echos` — and case, `LFO` vs `lfo`). **The
17 is NOT a verified number.** Anyone picking this up must re-derive it with
entity decoding and case folding before quoting it.

---

## Still open, deliberately

**samsloop faders are not cross-clamped.** END can be dragged below START → a
silent one-sample window, with no on-screen explanation. Playback itself is safe
(`clampWindow` forces `end ≥ start + 1`); the inverted-drag UX is a **behaviour
call for the owner**. This is the one surviving row of the session's defect
ledger — `cube`'s envelope bypass (#1360), `cloudseed`'s third stereo-silence
mechanism, and `buildCvCurve`'s even LUT (#1358) all closed.

**One instrument lesson from the `buildCvCurve` entry, which outlived the bug.**
The figure I first reported (`0.000733` of idle offset) was **an artifact of the
measuring tool, not the audio**: it is `curve[2048]`, a **nearest-index** read —
how this repo's own test helper sampled curves. A real `WaveShaperNode`
*interpolates*, and for `linear` the straddling samples are exact negatives, so
the port I cited as the flagship example rendered **exactly 0.0** and was never
affected. The even-table premise was right only where the delta is not
odd-symmetric about zero — and there it was **worse** than I said: in `discrete`
mode the idle lands on a HALF-INTEGER, not a legal bucket. `macrooscillator.model_cv`
idled on model **6.5** of 0–13; 8× `mixmstrs.chN_compEnable` **booleans idled at
0.5**, between off and on.

---

## ⚠ I LEAKED 16 CPU BURNERS AND THEN MEASURED AGAINST THEM

**The single worst instrument failure of the session, and it ran for 5 h 41 m.**

```sh
for i in $(seq 1 8); do (while :; do :; done) & done
BURNERS=$(jobs -p)
... playwright ... | head -20      # ← the pipeline that never returned
kill $BURNERS 2>/dev/null          # ← THIS LINE NEVER RAN
```

Both invocations leaked all 8. Sixteen spinners, `PPID 1` (orphaned), **~172
minutes of CPU each**, holding a 10-core box at **~990 %** for nearly six hours.
At least four "findings" trace directly to it — three `packages/dsp` "thin timeout
headroom" tests (**reported independently by three agents, which read as
corroboration and was three agents measuring the same contamination**), a
`vrt-meta` barrel-import timing, the `flox activate` stalls, and an agent sweep
that aliased against a ~4 s oscillation that is simply what a starved scheduler
looks like. Re-measured clean: **61 files / 1131 tests, 0 failures**, slowest
single test 1334 ms against vitest's 5000 ms — **3.7× headroom**, nothing to fix.
(I also had the UNIT wrong: vitest's 5000 ms default is **per TEST**, not per file.)

1. **Never leak a load generator.** `kill $BURNERS` after a pipeline containing
   `| head -N` is unreachable whenever the pipeline hangs. Use a `trap` on EXIT,
   or write the PIDs to a file and reap them from a command that always runs.
2. **Before attributing ANY timing result to "load", enumerate what is running.**
   `ps -A -o %cpu,etime,command | sort -rn | head` costs one command. An `ELAPSED`
   of 5 h on a test-shaped process is not contention, it is a leak.

⚠ **`ps` %CPU on macOS is a lifetime average, not instantaneous** — a spinner and
a busy-then-idle process print the same number. Confirm with `top -l 2`, read `STATE`.

---

## ⚠ AN ATTEST'S PRECONDITION IS "NO OTHER BROWSER IS RENDERING" — NOT "load is low"

**I nearly quarantined a healthy test over this.** Read before touching
`webgl:attest` or `grand:attest`. (It bit again on 2026-08-07, exactly as written.)

`task webgl:attest` refused: **193 passed, 1 failed** — `toybox-feedback.spec.ts:227`,
unrelated to the change, which passes **3/3 in isolation**. I checked the box was
quiet by **load average** and **free dev-server ports**, saw both clean, and
recommended **quarantining that spec out of the basis**. That would have removed a
working test from the gate. The owner corrected it in one line — *"you didn't have
exclusive gpu use, now you do"* — and the re-run on a genuinely exclusive box
**PASSED**, 0 failures. Two agents had still been finishing their own Chromium runs.

- **Check the right thing**: enumerate the contenders, don't read a scalar —
  `ps -A -o comm | grep -ciE "chromium|chrome-headless|playwright"` must be **0**,
  plus no dev server on 5173/4173. A load average cannot express this.
- Contrast with the **grand-attest** the same session, where the pre-flight's own
  `load(1m)` refusal was CORRECT (16 leaked burners, a real CPU problem).
  Same-looking symptom, different resource, opposite conclusion. **Name which
  resource you are claiming is free.**
- ⚠ `toybox-feedback.spec.ts` is **NOT known-flaky on this evidence.**

---

## Standing operational facts

- **Port 5173 is the owner's dev server. `task e2e:serve` binds it BY DEFAULT** —
  an agent tripped on this. Always pass an explicit other port.
- **`task worktree:guard`'s liveness detection does not see in-session agents** —
  it reported `live: 0` while three agents were working, and once caused a live
  agent's worktree to be reaped. Never trust it for automated removal.
- **Attest pre-flight samples `ps` ONCE** and is therefore unreliable in both
  directions — see issue #1331. A co-tenant oscillating 3.5 %→87 % on a ~4 s
  period reads as quiet or busy depending purely on when you look. Sample at
  irregular offsets, immediately before the run.
- **A cancelled GitHub job may be a TIMED-OUT job.** `webgl-attest` has
  `timeout-minutes: 5`, ran 5m16s, and reported as `cancelled` — which is why it
  read as collateral rather than the cause of a red main.
