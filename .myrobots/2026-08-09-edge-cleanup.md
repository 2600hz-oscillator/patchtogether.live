# EDGE CLEANUP — declare every gate-cable port, then DELETE the ledger

**Owner directive, 2026-08-09, verbatim intent:** *"i don't want any
UNDECLARED_EDGE_CEILING, i don't want any undeclared edges, i want a single
sweep that cleans all the fucking garbage up, makes sure everything is declared
and defined, that tests asserting zero undeclared edges pass."* Absolute top
priority after #1432 merges.

This plan is written to be executed by FRESH agents with no session context.
Everything an implementer needs is in this file or at a cited path. Where this
plan and the code disagree, the code is right — re-verify, then correct this
file in the same PR.

---

## 0 · Definition of DONE

1. Every gate-cable port on every module def declares `edge: 'trigger' | 'gate'`.
2. `packages/web/src/lib/docs/undeclared-edge-ledger.ts` is **deleted**.
3. `UNDECLARED_EDGE_CEILING` appears **nowhere** in the tree (`git grep` = 0 hits).
4. The trigger/gate check in `module-docs-lint.test.ts` is **unconditional
   deny**: a gate-cable port without `edge` is RED. No ledger consult, no
   exemption list, no counter. A permanent negative-control leg proves the
   check fires (synthetic def, undeclared gate port → red).
5. `contract-lock.txt` re-pinned once via `task docs:accept`, diff reviewed.
6. All gates green on the final commit; the 4 rear-card VRT baselines
   reconciled (see §5.3); ONE WebGL re-attest for cube+wavesculpt (§5.4).
7. **No replacement counter of any kind.** If you find yourself writing a
   number that a future merge could make stale, stop — that is the disease
   this PR exists to cure (§7).

## 1 · What `PortDef.edge` actually is (verified 2026-08-09, re-verify)

Consumers — the complete list; confirmed by grep on main @ `2ec5eb1d`:

| consumer | file | effect of declaring |
|---|---|---|
| contract signature | `packages/web/src/lib/docs/contract-signature.ts:85` (`edge=<v>`) | `contract-lock.txt` line change per port → ONE `task docs:accept` re-pin |
| generated docs | `packages/web/src/lib/docs/io-explain.ts:104-135` | adds "trigger — fires once per rising edge" (or gate equivalent) to the port's generated sentence. `module-docs.generated.ts` is a gitignored build artifact — nothing to commit |
| rear-card glyph | `packages/web/src/lib/ui/workflow/RearCard.svelte:292,334` | jack gains `▲` (trigger) or `▬` (gate); a band-level legend row appears when any hole in the band has `edge` |
| vocabulary lint | `module-docs-lint.test.ts` | the port's authored prose is now CHECKED for trigger/gate coherence (this is the point) |

**Read by NOTHING in the audio path.** `grep -rn "port\.edge" packages/web/src/lib/audio packages/dsp/src` returns zero non-test hits. Declaring `edge` changes **no audio behavior**: no ART baseline can move, no per-port e2e drive signal changes, no engine branch exists. The scout MUST re-run these greps and halt if that has changed.

**Not in the collab basis** (module defs are outside `COLLAB_DIR_ROOTS`). **Two defs ARE in the WebGL attest basis**: `cube` (1 port) and `wavesculpt` (4 ports) via `AUDIO_WEBGL_MODULE_DEFS` — a real contract-field edit there legitimately moves the WebGL hash → §5.4.

## 2 · The debt (main @ `2ec5eb1d`; 275 after #1432 merges)

55 modules / 276 pairs, per-module counts:

```
buggles(3) cartesian(3) clipplayer(8) clouds(1) cube(1) doom(29) drummergirl(1)
drumseqz(11) flipper(4) fourplexer(4) frogger(8) gamepad(12) gibribbon(11)
illogic(4) kria(4) macrooscillator(1→0 in #1432) macseq(15) marbles(3)
midiCvBuddy(1) midiLane(2) midiOutBuddy(1) midiclock(3) modtris(7) moog911(1)
moog911a(4) moog912(1) moog956(1) moog960(4) moog961(7) moog962(1) moog993(5)
nibbles(3) numpadPlus(5) outlines(2) picturebox(1) polyseqz(8) pong(2) qbrt(1)
sampleHold(1) samsloop(1) score(8) sequencer(15) shapegen(1) skifree(1)
slewSwitch(3) synesthesia(16) timelorde(16) twotracks(6) vfpgaRunner(4)
videobox(1) videovarispeed(5) wavecel(1) wavesculpt(4) writeseq(9) rings(1)
```

**295 of the original 299 ports already carry authored doc prose naming the
semantic** (measured when the ledger was created — `undeclared-edge-ledger.ts`
header). This is not 276 unknowns; it is ~272 known answers that were never
typed into the contract, plus a handful needing a DSP read.

## 3 · The classification rule

**The DSP consumer is the truth. Prose is evidence. The repo definition
(CLAUDE.md "Triggers vs gates") is the vocabulary:**

- `edge: 'trigger'` — the consumer acts ONCE per rising edge and ignores how
  long the level stays high: clock, reset, strike, sync, start/stop, S&H,
  step-advance, game-input press.
- `edge: 'gate'` — the consumer is level-sensitive / reacts to both edges:
  ADSR sustain, VCA hold, poly note-on/off, run/hold inputs, anything whose
  prose says "while high".

Per port, in order:
1. Read the authored `docs.inputs.<port>` prose. If it plainly says fires/
   advances/resets/strikes *per pulse* → trigger; *while high / held /
   sustains* → gate. Record the quote.
2. Confirm against the consumer: worklet per-sample `prev<TH && cur>=TH` or
   `createEdgeCounter` use → trigger; reads the held level → gate. Record
   file:line.
3. Prose and DSP disagree → **DSP wins, fix the prose in the same commit**,
   and list the contradiction in the PR body (this is a real finding — the
   whole reason the vocabulary check exists).
4. Neither settles it (~4 ports expected) → read the DSP until it does. Never
   guess; never leave it undeclared.

Known freebie: `qbrt.ping` is a documented trigger — its def header, its DSP
(`qbrt.dsp:14`, textbook rising-edge detector), and its prose all agree
(ledger header, "THE ONE ENTRY THAT ALREADY HAS AN IN-SOURCE TODO").

⚠ **Do NOT change any consumer.** CLAUDE.md: "Do NOT convert a gate consumer
to edge-only." This sweep declares what IS; it changes no behavior. If a
consumer looks wrong (level-read where prose promises edge), declare what the
DSP does, fix the prose, and file the behavior question in the PR body —
behavior changes are separate owner-approved PRs.

## 4 · Phases

### Phase 0 — SCOUT + CLASSIFICATION TABLE (read-only; one agent)

No source edits. Deliverable: `.myrobots/2026-08-09-edge-cleanup-table.md`,
one row per pair:

```
| module | port | edge | evidence: prose (quote) | evidence: DSP (file:line, one clause) | confidence |
```

`confidence` ∈ CLEAR (prose+DSP agree) / DSP-ONLY (no prose signal) /
CONTRADICTION (prose vs DSP disagree — cite both).

Also re-verify and record in the table header:
- the consumer list in §1 is still exact (`grep -rn "\.edge" packages/web/src/lib/ui/workflow/RearCard.svelte packages/web/src/lib/docs/contract-signature.ts packages/web/src/lib/docs/io-explain.ts`)
- behavior-neutrality greps from §1 still return zero
- which of the 4 rear-VRT modules (`dx7`, `sixstrum`, `tidyVco`, `vca` under
  `e2e/vrt/__screenshots__/workflow-rear-card.spec.ts/`) appear in the debt map
- cube + wavesculpt are still the only WebGL-basis defs in the map
  (`AUDIO_WEBGL_MODULE_DEFS` in `scripts/webgl-attest-lib.ts`)
- count the pairs; expected 275 post-#1432 — if different, say why before
  proceeding.

### Phase 1 — APPLY (one branch, one agent, table locked first)

Branch `fix/declare-all-edges`. Owner reviews the TABLE before this phase
starts, or delegates that review — either way the table is frozen input.

1. Declare `edge:` on every port, straight from the table. Alphabetical by
   module, one commit per ~10 modules (bisectable, and a WIP commit cadence
   that survives a destroyed worktree — `git stash` does NOT save new files).
2. Fix prose on CONTRADICTION rows (DSP wins).
3. `flox activate -- task docs:accept` ONCE at the end; review the diff —
   every changed line should be an `edge=` addition or a corrected sentence.
   Anything else = stop and explain.
4. Gates: `task typecheck` · `task test:one -- module-docs-lint` ·
   `task test:one -- contract-lock` · full web `unit` lane · the 4 rear VRT
   scenes locally (§5.3) · `REPEAT=3` on changed tests.

### Phase 2 — DELETE THE MECHANISM (same branch)

1. Delete `packages/web/src/lib/docs/undeclared-edge-ledger.ts`.
2. In `module-docs-lint.test.ts`: remove the ledger import and the ceiling
   assertions; the trigger/gate check becomes unconditional — every gate-cable
   port must declare `edge`, full stop.
3. Add the permanent negative control: a synthetic def with one undeclared
   gate port must turn the check red (and a declared one must pass) — both
   legs, every run, per the repo's negative-control-both-directions standard.
4. `git grep -i "undeclared_edge\|undeclared-edge"` → the only hits are this
   plan and history. `git grep "UNDECLARED_EDGE_CEILING"` → zero.
5. Encode the standard (§7) into `.claude/skills/blind-gates.md` +
   `CLAUDE.md` in this same PR (repo convention: standards land with in-flight
   work).

### Phase 3 — ATTEST + LAND (same branch, last)

1. cube + wavesculpt edits moved the WebGL hash — legitimately. On the owner's
   machine (coordinator has it): `env WEBGL_ATTEST_ALLOW_BUSY=1 flox activate
   -- task webgl:attest` after killing stale dev servers on 5173/4173 and
   clearing `node_modules/.vite` (stale-bundle false-refusal is a known trap).
   Commit the attestation. Verify hash stability: compute before/after edits,
   only those two defs move it.
2. Full CI green on the final commit; merge per the final-commit rule.

## 5 · Traps — every one was HIT this week; do not rediscover them

1. **Sub-tolerance VRT.** The rear-card glyph is small. If a rear baseline
   diff lands UNDER tolerance, the gate passes against a stale image AND
   `--update-snapshots` refuses to rewrite it. Measure each of the 4 rear
   scenes' printed pixel diff; over budget → `--update-snapshots` rewrites;
   under → `git rm` the DARWIN baseline + recapture locally, and for LINUX
   let the bot capture (a `git rm`'d linux PNG is an undeclared platform gap
   until the bot lands — pair-remove or dispatch same-PR per CLAUDE.md).
2. **A `git rm`-ed baseline is silently recreated by ANY later VRT run**
   (`updateSnapshots: 'missing'` default). `git status` for untracked PNGs
   after every VRT run in the window.
3. **Bot pushes don't fire CI**, and its follow-on runs land in
   `action_required` — approve them; push a real commit after; verify a run
   actually started on the final SHA.
4. **`task vrt` honors `E2E_PORT` only since #1425** — you are post-fix, but
   verify the server you hit is your worktree (`lsof -a -p $(lsof -ti :PORT)
   -d cwd`) before trusting any sweep.
5. **No `git stash`, ever** (shared stack; loses untracked files). WIP commits.
6. **This PR touches 55 defs + `contract-lock.txt`** — it conflicts with ANY
   concurrent module PR. Land it in a quiet window (now: the face wave is
   drained once #1432 merges). Nothing else touching defs may run in parallel.
7. **`e2e/package.json` and other TOOLCHAIN_PIN_FILES are hashed wholesale** —
   touch nothing in them.
8. **contract-lock.txt merge conflict** → take main + re-run `task docs:accept`,
   never hand-merge a golden.

## 6 · Model recommendation (owner asked)

- **Phase 0 (classification): Opus.** 275 semantic judgments; a wrong one
  ships a wrong contract that the vocabulary lint then *enforces*. This is
  the phase where errors compound.
- **Phase 1–2 (apply + delete): Sonnet is acceptable** — the table is frozen
  input and the work is mechanical — **but Opus preferred** if available,
  because the exits (docs:accept diff review, rear-VRT reconciliation,
  negative-control legs) are exactly where cheaper passes went wrong this
  week. If Sonnet runs it: any deviation from the table, any unexplained
  docs:accept line, any CONTRADICTION row it can't resolve mechanically →
  stop and report, don't improvise.
- **Phase 3 (attest): runs on the owner's machine** — coordinator executes.

## 7 · Why this existed and why it must never happen again (encode)

The ledger was created 2026-08-02 for a real reason: the vocabulary check had
`if (!p.edge) continue`, which silently skipped 299 of 362 ports (83% of its
subject). Inverting to deny-by-default was right. **Everything after that was
wrong:**

- The 299 were parked in a LEDGER with a hand-typed count instead of being
  FIXED — even though 295 of them already had prose naming the answer. The
  debt was mechanically payable in one sweep on day one.
- The hand-typed count (`UNDECLARED_EDGE_CEILING`) then auto-merged WRONG in a
  parallel wave, 3 of 3 branches, in silence (7→8+7→8 merging to 8 when truth
  was 9; 289−1 and 289−12 merging to either when truth was 276). Every agent
  paid a re-count tax; one clean-and-wrong merge shipped.
- The number needed a paragraph of comments to explain. **A number that needs
  a warning label is the wrong mechanism.**

The rules, going into `blind-gates` + CLAUDE.md in Phase 2:

1. **Pay mechanically-payable debt; never inventory it.** A ledger of known
   answers is deferred typing, not engineering.
2. **A ratchet is for debt you genuinely cannot pay now** (needs hardware, an
   owner decision, a re-attest window). Even then the count is DERIVED from
   the artifact — a typed literal in a shared file is a merge hazard by
   construction.
3. **Any migration counter ships with its own deletion criteria** — the
   condition under which the mechanism is removed, stated in the file, or the
   scaffolding outlives the building.

## 8 · Acceptance checklist (owner-facing)

- [ ] `git grep UNDECLARED_EDGE_CEILING` → 0
- [ ] `undeclared-edge-ledger.ts` deleted
- [ ] every gate-cable port declares `edge` (the lint proves it, unconditionally)
- [ ] negative control red/green both legs, permanent
- [ ] contract-lock re-pinned once, diff = only `edge=` lines + corrected prose
- [ ] 4 rear VRT baselines reconciled, file counts = predictions
- [ ] ONE WebGL re-attest (cube, wavesculpt), hash verified stable otherwise
- [ ] standards encoded in blind-gates + CLAUDE.md
- [ ] CI green on final commit; no behavior change anywhere (zero ART motion)
