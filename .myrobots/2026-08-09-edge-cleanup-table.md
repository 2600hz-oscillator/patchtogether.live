# EDGE CLEANUP — PHASE 0 CLASSIFICATION TABLE

Phase 0 deliverable of `.myrobots/2026-08-09-edge-cleanup.md`. **Read-only pass —
no source file was modified.** Every `(module, port)` pair in
`packages/web/src/lib/docs/undeclared-edge-ledger.ts` is classified
`edge: 'trigger' | 'gate'` with prose + DSP evidence.

Branch `docs/edge-cleanup-table`, base `origin/main` @ `f831ff0d`.

> **Phase 1 treats this table as FROZEN INPUT.** If a row looks wrong, re-do
> that row's evidence — do not override it silently.

**Result: all 276 pairs classified — 195 `trigger`, 81 `gate`; 266 CLEAR,
4 DSP-ONLY, 6 CONTRADICTION. Nothing undetermined.** Details in §5.

---

## 1 · HEADER BLOCK — re-verification of the plan's claims

### 1.1 Live pair count — **276**, not 275

```
modules 55   pairs 276
```
(derived by parsing `UNDECLARED_EDGE_DEBT`; matches `UNDECLARED_EDGE_CEILING = 276`
at `undeclared-edge-ledger.ts:136`.)

**Why it is not 275:** the plan predicts 275 "after #1432 merges". **#1432 is
still OPEN** (`gh pr view 1432` → `state: OPEN, mergedAt: null` —
*"feat(faces): macrooscillator — fourteen engines…"*), so `macrooscillator.trig`
is still in the ledger and still undeclared. **The table classifies it anyway**
(row present, `trigger`). If #1432 lands before Phase 1, that row is already
satisfied and Phase 1 skips it — nothing else moves.

### 1.2 Behaviour-neutrality — **VERIFIED, zero hits** ✅

```sh
grep -rn "port\.edge\|\.edge ===" packages/web/src/lib/audio packages/dsp/src \
  | grep -v "\.test\." | grep -v ledger | grep -v edge-detect
# → no output (exit 1)
```
The plan's core safety argument holds: **declaring `edge` cannot change audio.**
(The `\.edge` hits that do exist under `lib/audio` are `entry.edge` /
`edge.id` — *graph* edges in `engine.ts`/`reconciler.ts` — and
`ln.edge.scan(...)` in `midi-out-buddy.ts`, which is an edge-*detector* object,
not a `PortDef` field. Neither is `PortDef.edge`.)

### 1.3 Consumer list — **the plan's list is INCOMPLETE (4 named, 6 real)** ⚠

Every consumer named in §1 of the plan is still present and still at the cited
line:

| plan's claim | verified |
|---|---|
| `contract-signature.ts:85` | ✅ `if (p.edge) parts.push(\`edge=${p.edge}\`);` |
| `io-explain.ts:104-135` | ✅ `explainEdge` at 104-108, call site at **134-135** |
| `RearCard.svelte:292,334` | ✅ 292 = the `▲`/`▬` glyph, 334 = the band legend row |
| `module-docs-lint` | ✅ vocabulary clause at `:268-278`, deny clause at `:283-…` |

**But three more non-test readers of `PortDef.edge` exist that the plan does not
name.** None is in the audio path, so §1.2 still holds — but the plan says the
list is "the complete list", and it is not:

| extra consumer | line | effect |
|---|---|---|
| `io-explain.ts` **second** call site | **172-173**, inside `explainOutputPort` | an OUTPUT port's generated sentence also gains the edge clause. The plan's `104-135` range misses it — **this matters**, because 118 of the 276 pairs are OUTPUTS |
| `packages/web/src/lib/docs/doc-index-from-def.ts:41` | `edge: p.edge` | copies `edge` into the `ManifestPort` the doc index renders (feeds `io-explain`) |
| `packages/web/src/lib/dev/module-specs.ts:157` | `if (p.edge) out.edge = p.edge;` | dev-only module-spec snapshot |

(`module-manifest.ts:960` `if (edge) port.edge = edge;` is the `?raw` regex
parser *writing* the field, not a def reader — listed for completeness.)

**Consequence for Phase 1:** the doc-page diff will be larger than "inputs
only". This changes no gate and no artifact that is committed
(`module-docs.generated.ts` is a gitignored build artifact), so it is a scope
note, not a blocker.

### 1.4 Rear-card VRT baselines — **ZERO of the 4 are in the debt map** ✅

Scenes under `e2e/vrt/__screenshots__/workflow-rear-card.spec.ts/{darwin,linux}/`:
`rear-dx7.png`, `rear-sixstrum.png`, `rear-tidyVco.png`, `rear-vca.png`.

None of `dx7` / `sixstrum` / `tidyVco` / `vca` is a key in
`UNDECLARED_EDGE_DEBT`. **Phase 1 adds no `▲`/`▬` glyph to any of the four
pinned rear scenes, so all 8 baselines should be byte-identical.**

⚠ Two caveats Phase 1 must not skip:
- `RearCard.svelte:334` adds a **band-level legend row** when *any* hole in the
  band declares `edge`. All four modules already have declared-edge ports
  (`sixstrum.strum{n}`/`mute{n}`, `tidyVco.gate`, and the `dx7`/`vca` faces), so
  the legend state should not flip — **but verify by rendering, not by
  reasoning.** A legend row appearing/disappearing is a large diff; a glyph is a
  small one, and CLAUDE.md's sub-tolerance trap applies to the small case.
- "Expected zero diff" is the *prediction*. Run the four scenes and **count the
  files**, per the "green dispatch that committed nothing is a RED FLAG" rule.

### 1.5 WebGL attest basis — ⚠ **THIS ROW WAS WRONG. 11 files, not 2.**

> **Corrected during Phase 1 by measurement.** The original text is kept below
> because *how* it was wrong is the point.

~~`AUDIO_WEBGL_MODULE_DEFS` (`scripts/webgl-attest-lib.ts:66-70`) = `cube.ts`,
`hypercube.ts`, `wavesculpt.ts`. Of those, `cube` (1 pair) and `wavesculpt`
(4 pairs) are in the debt map; `hypercube` is not. So exactly **5 pairs across
2 files** move the WebGL hash.~~

That checked ONE list and reported it as the basis. `resolveWebglBasis()` rule
(1) walks **all of `packages/web/src/lib/video`** (minus `*.test.ts`) into the
hash wholesale, so every video module def in the debt map is in the basis as
well — `AUDIO_WEBGL_MODULE_DEFS` is only rule (3).

Measured on the Phase-1 branch, `bash scripts/webgl-attest-hash.sh --list`
intersected with `git diff --name-only origin/main...HEAD`: **11 files** —
`cube.ts`, `wavesculpt.ts`, and `doom / gibribbon / nibbles / outlines /
picturebox / shapegen / vfpga-runner / videobox / videovarispeed`. Hashes:
main `620fa1b3…` (= the committed attestation), branch `dad522d9…`, and
reverting exactly those 11 to main's content restores `620fa1b3…`, so the
delta is those files and nothing else.

Still ONE re-attest in Phase 3 — but the expected basis delta is 11 files, and
the acceptance line "hash verified stable otherwise" cannot be read as "only
two defs moved it".

**The lesson, and it is this table's own subject one level up:** a
consumer/basis audit that resolves a single named list will confidently report
that list's contents as the whole answer. Anchor to the ARTIFACT — here,
`--list` — not to the constant that looks like it enumerates it.

---

## 2 · Method

Per the plan §3 and CLAUDE.md "Triggers vs gates":

- **trigger** — the consumer acts ONCE per rising edge and ignores how long the
  level stays high. For an OUTPUT: a **fixed-width** pulse per event.
- **gate** — level-sensitive, reacts to both edges. For an OUTPUT: a level held
  for a musically-meaningful, **variable** span (note length, step × gate-length,
  held key).

`confidence`:
- **CLEAR** — prose and DSP agree.
- **DSP-ONLY** — no usable prose signal for the *choice* (here: the prose
  deliberately declines to pick a semantic).
- **CONTRADICTION** — the prose's deciding clause names one semantic and the DSP
  does the other. **DSP wins**; both are cited. Phase 1 fixes the prose.

Line numbers are `main @ f831ff0d`. Paths are repo-relative.

---

## 3 · THE TABLE

### buggles (3)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| buggles | burst (out) | trigger | "fires a cluster of 3–7 closely-spaced **trigger pulses** on a woggle event" | `packages/web/src/lib/audio/modules/buggles.ts:392-394` — `setValueAtTime(1, t0); setValueAtTime(0, t1)` in a loop, `t1 = t0 + BURST_PULSE_MS/1000`, `BURST_PULSE_MS = 4` (`:141`) — fixed width | CLEAR |
| buggles | clock (out) | trigger | "**pulses (~5 ms)** on every woggle event — a chaotic clock you can use to **trigger** sequencers" | `buggles.ts:382-383` — `setValueAtTime(1, now); setValueAtTime(0, now + CLOCK_PULSE_MS/1000)`, `CLOCK_PULSE_MS = 5` (`:139`) | CLEAR |
| buggles | external_clock (in) | trigger | "its **rising edges** replace the internal woggle clock — **each pulse fires one** woggle event" | `buggles.ts:335-338` — `if (lastExtSample < 0.5 && s >= 0.5) { edge = true; lastExtEdgeT = ctx.currentTime; }` — width never read | CLEAR |

### cartesian (3)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| cartesian | clock (in **and** out) | trigger | in: "each **rising edge advances** the cursor one pad"; out: "A **short ~10 ms pulse** fired on every cursor advance" | in `cartesian.ts:419` — `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:277-278` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| cartesian | gate (out) | gate | "then back low **after the fraction of the step set by the gate-length control**" | `cartesian.ts:373-374` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + gateOff)`, `gateOff` = gateLength × step duration | CLEAR |
| cartesian | lfo_clock (in) | trigger | "the **time between successive rising edges** sets the LFO's base rate" | `cartesian.ts:303-310` — `if (lfoLastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)` records `tHere`; the high duration is never read | CLEAR |

### clipplayer (8)

DSP for all eight is the same seam: `clipplayer.ts:1416-1417`
`ln.gateSrc.offset.setValueAtTime(1, atTime); …setValueAtTime(0, atTime + gateOff)`
(also `:1063-1064`), where `gateOff` is the **note / tie span**, not a fixed pulse.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| clipplayer | gate1 (out) | gate | "goes **high while** a note in lane 1's clip plays (its width set by GATE; **tied/held notes stay high across their span**); low on rests" | `clipplayer.ts:1416-1417` — note-span-derived `gateOff` | CLEAR |
| clipplayer | gate2 (out) | gate | "**high while** lane 2's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate3 (out) | gate | "**high while** lane 3's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate4 (out) | gate | "**high while** lane 4's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate5 (out) | gate | "**high while** lane 5's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate6 (out) | gate | "**high while** lane 6's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate7 (out) | gate | "**high while** lane 7's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |
| clipplayer | gate8 (out) | gate | "**high while** lane 8's notes play, low on rests" | same seam, `clipplayer.ts:1416-1417` | CLEAR |

### clouds (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| clouds | freeze_gate (in) | trigger | "toggles FREEZE **on each rising edge**: high-going flips the buffer" | `packages/dsp/src/clouds.ts:293-296` — `if (gateCombined >= 0.5 && this.lastFreezeGate < 0.5) { this.latchedFreeze = !this.latchedFreeze; }` — a latch toggle; hold duration is irrelevant | CLEAR |

### cube (1) — ⚠ WebGL attest basis

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| cube | trigger (in) | gate | "**while the level is high** the ADSR **holds open** (attack→decay→sustain) and **on the falling edge it releases**" | `packages/dsp/src/cube.ts:664-666` — `if (trigGate && !this.prevTrigGate) this.env[0]!.triggerSoft(true); else if (!trigGate && this.prevTrigGate) this.env[0]!.triggerSoft(false);` — **both** edges | CLEAR |

### doom (29)

All 29 are OUTPUTS driven by one emitter: `packages/web/src/lib/video/modules/doom.ts:724-730`
— `const EVT_PULSE_S = 0.01; function pulseGate(src, portId) { … src.offset.setValueAtTime(1, t); src.offset.setValueAtTime(0, t + EVT_PULSE_S); }`
— dispatched at `:741-765` (event stream) and `:1055-1076` (direct). A **fixed
10 ms pulse per event**, never a held level. Prose for every one is the same
shape: *"a 10 ms HIGH pulse when \<event\>"*.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| doom | evt_door (out) | trigger | "Door gate: **a 10 ms HIGH pulse** when a door opens (EV_DoDoor / EV_VerticalDoor)" | `doom.ts:724-730` `pulseGate`, `EVT_PULSE_S = 0.01`; dispatch `:743` | CLEAR |
| doom | evt_gun_p1 (out) | trigger | "Weapon-fire gate for player 1: **a 10 ms HIGH pulse** each time slot 1 fires its weapon" | `doom.ts:724-730`; dispatch `:748` | CLEAR |
| doom | evt_gun_p2 (out) | trigger | "Weapon-fire gate for player 2: **a 10 ms HIGH pulse** each time slot 2 fires its weapon" | `doom.ts:724-730`; dispatch `:748` | CLEAR |
| doom | evt_gun_p3 (out) | trigger | "Weapon-fire gate for player 3: **a 10 ms HIGH pulse** each time slot 3 fires its weapon" | `doom.ts:724-730`; dispatch `:748` | CLEAR |
| doom | evt_gun_p4 (out) | trigger | "Weapon-fire gate for player 4: **a 10 ms HIGH pulse** each time slot 4 fires its weapon" | `doom.ts:724-730`; dispatch `:748` | CLEAR |
| doom | evt_kill (out) | trigger | "Any-monster kill gate: **a 10 ms HIGH pulse** each time a counted monster dies" | `doom.ts:724-730`; dispatch `:741`, `:1055` | CLEAR |
| doom | evt_kill_arachnotron (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when an Arachnotron is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_baron (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Baron of Hell is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_caco (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Cacodemon is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_chainguy (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Chaingunner is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_cyber (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when the Cyberdemon is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_demon (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Demon (pinky) is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_imp (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when an Imp is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_keen (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Commander Keen is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_knight (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Hell Knight is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_lostsoul (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Lost Soul is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_mancubus (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Mancubus is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_pain (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Pain Elemental is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_revenant (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Revenant is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_shotguy (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Shotgunner is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_spectre (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Spectre is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_spidermind (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when the Spider Mastermind is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_vile (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when an Arch-Vile is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_wolfss (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Wolfenstein SS is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_kill_zombieman (out) | trigger | "Typed kill gate: **a 10 ms HIGH pulse** when a Zombieman is killed" | `doom.ts:724-730`; dispatch `:755`/`:1070` | CLEAR |
| doom | evt_p1_dies (out) | trigger | "Death gate: **a 10 ms HIGH pulse** when player 1's marine dies" | `doom.ts:724-730`; dispatch `:765`/`:1076` | CLEAR |
| doom | evt_p2_dies (out) | trigger | "Death gate: **a 10 ms HIGH pulse** when player 2's marine dies" | `doom.ts:724-730`; dispatch `:765`/`:1076` | CLEAR |
| doom | evt_p3_dies (out) | trigger | "Death gate: **a 10 ms HIGH pulse** when player 3's marine dies" | `doom.ts:724-730`; dispatch `:765`/`:1076` | CLEAR |
| doom | evt_p4_dies (out) | trigger | "Death gate: **a 10 ms HIGH pulse** when player 4's marine dies" | `doom.ts:724-730`; dispatch `:765`/`:1076` | CLEAR |

### drummergirl (1) — ⚠ CONTRADICTION

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| drummergirl | gate (in) | **gate** | `drummergirl.ts:289`: "The trigger: a rising edge fires exactly one drum hit… **its level isn't sustained, only the rising edge matters**, so hit length is set by the Decay control **rather than how long the gate stays high**." | `packages/dsp/src/drummergirl.dsp:76-84` — `env(g) = en.adsr(attackOf, decayKnob, sustainOf(shapeKnob), releaseOf, g)`, `process(gate) = mixed(gate) * env(gate) * volumeKnob`. `en.adsr` **holds at `sustainOf(shape)` while `g` is high and releases only on the fall**, and `sustainAt` (`drummergirl.dsp:35-37`) is **non-zero for 7 of 16 shapes** (0.02 … **0.5**). Corroborated in-file by `drummergirl.ts:77-79`: *"the audition itself must be a HELD gate, not a one-shot: `en.adsr` is LEVEL-sensitive here (it holds at `sustainOf(shape)` while the gate is high and releases only when the gate reaches 0)"* | **CONTRADICTION** |

### drumseqz (11)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| drumseqz | clock (in **and** out) | trigger | in: "each **rising edge advances** the shared playhead exactly one step"; out: "A **short ~10 ms pulse** fired on every step advance" | in `drumseqz.ts:581` — `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:378-379` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| drumseqz | gate1 (out) | gate | "goes **high** on each lit step of row 1…, **staying high for the fraction of the step** set by the gate-length control" | `drumseqz.ts:451-452` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac)` | CLEAR |
| drumseqz | gate2 (out) | gate | "Track 2's gate — **high** on each lit step of row 2, **shaped by the gate-length control**" | `drumseqz.ts:451-452` (same loop, `t = 1`) | CLEAR |
| drumseqz | gate3 (out) | gate | "Track 3's gate — **high** on each lit step of row 3, **shaped by the gate-length control**" | `drumseqz.ts:451-452` (same loop, `t = 2`) | CLEAR |
| drumseqz | gate4 (out) | gate | "Track 4's gate — **high** on each lit step of row 4, **shaped by the gate-length control**" | `drumseqz.ts:451-452` (same loop, `t = 3`) | CLEAR |
| drumseqz | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the current run state)" | `transport-cv.ts:107` `createRisingEdgeDetector(0.5)` + `:121` `p.detector.scan(p.buf, start, p.buf.length)` | CLEAR |
| drumseqz | queue1_cv (in) | trigger | "A **rising edge** queues quicksave slot 1" | `transport-cv.ts:107,121` | CLEAR |
| drumseqz | queue2_cv (in) | trigger | "A **rising edge** queues quicksave slot 2" | `transport-cv.ts:107,121` | CLEAR |
| drumseqz | queue3_cv (in) | trigger | "A **rising edge** queues quicksave slot 3" | `transport-cv.ts:107,121` | CLEAR |
| drumseqz | queue4_cv (in) | trigger | "A **rising edge** queues quicksave slot 4" | `transport-cv.ts:107,121` | CLEAR |
| drumseqz | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to step 1 and **restarts** the loop" | `transport-cv.ts:107,121` | CLEAR |

### flipper (4) — ⚠ 2 CONTRADICTIONS

The whole module is `packages/dsp/src/lib/flipper-dsp.ts:28-40`. Per sample:
`const combined = in1 > in2 ? in1 : in2; const high = combined >= FLIPPER_THRESHOLD;`
— the rising edge only **selects** the route (`if (high && !this.wasHigh)`),
while the **held level is mirrored to the selected output for its full width**
(`return this.routeToFlip ? [combined, 0] : [0, combined]`) and both outputs
drop on the fall (`if (!high) return [0, 0]`). The file's own docstring
(`:24-25`): *"while a gate is high it is mirrored to the currently-selected
output (so the trigger keeps the input's width)"*. That is level-sensitive and
both-edge reactive → **gate**, on all four ports.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| flipper | flip (out) | gate | "goes high on the 1st, 3rd, 5th… incoming edge and low otherwise. Driven from a single clock it is **a half-rate gate**" | `flipper-dsp.ts:38-39` — mirrors `combined` for its full width; `[0,0]` while the input is low | CLEAR |
| flipper | flop (out) | gate | "the inverse phase of FLIP, so **exactly one of the two is high at any time**" | `flipper-dsp.ts:38-39` (same return) | CLEAR |
| flipper | in1 (in) | **gate** | "A toggle input: **each rising edge flips** the active output from FLIP to FLOP or back." — trigger vocabulary only; never mentions the level | `flipper-dsp.ts:30` `const high = combined >= FLIPPER_THRESHOLD;` read **every sample**; `:38` `if (!high) return [0,0]` reacts to the FALL; `:39` relays the held level | **CONTRADICTION** |
| flipper | in2 (in) | **gate** | "A second toggle input: **each rising edge advances** the same FLIP/FLOP alternation as IN 1" — trigger vocabulary only | `flipper-dsp.ts:29-30` — `in2` enters the same `combined` OR and the same per-sample level read; `:38-39` | **CONTRADICTION** |

### fourplexer (4)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| fourplexer | gate1 (in) | trigger | "Clock/advance for output 1: **each rising edge steps** OUT 1's selector to the next input" | `packages/dsp/src/fourplexer.ts:151` — `if (g > 0.5 && this.prevGate[o]! <= 0.5) {` (state `:95`) | CLEAR |
| fourplexer | gate2 (in) | trigger | "Clock/advance for output 2: **each rising edge steps** OUT 2's selector to the next input" | `packages/dsp/src/fourplexer.ts:151` (same per-output loop, `o = 1`) | CLEAR |
| fourplexer | gate3 (in) | trigger | "Clock/advance for output 3: **each rising edge steps** OUT 3's selector to the next input" | `packages/dsp/src/fourplexer.ts:151` (`o = 2`) | CLEAR |
| fourplexer | gate4 (in) | trigger | "Clock/advance for output 4: **each rising edge steps** OUT 4's selector to the next input" | `packages/dsp/src/fourplexer.ts:151` (`o = 3`) | CLEAR |

### frogger (8)

Inputs: `frogger.ts:200-205` — `detectRisingEdge(lastUp, u)` … one per port, off a
32-sample analyser tap (`makeGateTap`, `:131-143`).
Outputs: `frogger.ts:158-165` `pulseGateNTimes` — `GATE_PULSE_S = 0.005` (`:68`),
fixed width, repeated N times for N simultaneous events.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| frogger | dead_gate (out) | trigger | "**Fires a single 5 ms pulse** each time the frog dies… **A trigger** you can route to a crash sound" | `frogger.ts:158-165` `pulseGateNTimes`, `GATE_PULSE_S = 0.005` | CLEAR |
| frogger | down_gate (in) | trigger | "Move the frog DOWN one row **on each rising edge** — one hop… **per pulse**" | `frogger.ts:201` `detectRisingEdge(lastDown, d)` | CLEAR |
| frogger | home_gate (out) | trigger | "**Fires a 5 ms pulse** each time the frog reaches a home pad — … it emits that many **distinct staggered pulses**" | `frogger.ts:158-165`, N-pulse loop | CLEAR |
| frogger | left_gate (in) | trigger | "Move the frog LEFT one column **on each rising edge** — one hop **per pulse**" | `frogger.ts:202` `detectRisingEdge(lastLeft, l)` | CLEAR |
| frogger | level_gate (out) | trigger | "**Fires a single 5 ms pulse** each time a level is cleared… Use it as a progression **trigger**" | `frogger.ts:158-165` | CLEAR |
| frogger | right_gate (in) | trigger | "Move the frog RIGHT one column **on each rising edge** — one hop **per pulse**" | `frogger.ts:203` `detectRisingEdge(lastRight, r)` | CLEAR |
| frogger | start_gate (in) | trigger | "**Start a fresh game on each rising edge**… after that, **pulse** this to restart at any time" | `frogger.ts:204` `detectRisingEdge(lastStart, s)` | CLEAR |
| frogger | up_gate (in) | trigger | "Move the frog UP one row **on each rising edge**… (the move only fires on the gate's **leading edge, so a held-high gate hops once, not continuously**)" | `frogger.ts:200` `detectRisingEdge(lastUp, u)` | CLEAR |

### gamepad (12)

All twelve are OUTPUTS written from the LIVE held button state on every poll:
`gamepad.ts:1232-1236` — `const pressed = … !!reading.buttons[control.index]?.pressed …; v = pressed ? 1 : 0;`
then `:1250` `sources[o.id]!.offset.setValueAtTime(v, ctx.currentTime)`. No pulse
width anywhere; release writes 0.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| gamepad | a (out) | gate | "The A face button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` — live pressed state, re-written each poll | CLEAR |
| gamepad | b (out) | gate | "The B face button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | back (out) | gate | "The Back / Select button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | dd (out) | gate | "D-pad down as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | dl (out) | gate | "D-pad left as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | dr (out) | gate | "D-pad right as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | du (out) | gate | "D-pad up as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | lb (out) | gate | "Left bumper as a gate: **1 while the button is held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | rb (out) | gate | "Right bumper as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | start (out) | gate | "The Start button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | x (out) | gate | "The X face button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |
| gamepad | y (out) | gate | "The Y face button as a gate: **1 while held, 0 when released**" | `gamepad.ts:1232-1236` + `:1250` | CLEAR |

### gibribbon (11)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| gibribbon | a (in) | trigger | "The A player button (**rising edge = a trigger**): **on the edge** it judges the nearest in-window LOOP event" | `gibribbon.ts:903` — `const ev = detectEdge(buttonEdges[btn], value);` (`$lib/doom/cv-gate-edge`) | CLEAR |
| gibribbon | b (in) | trigger | "The B player button (**rising edge / trigger**): judges the nearest in-window JUMP event **on the edge**" | `gibribbon.ts:903` `detectEdge(buttonEdges[btn], value)` | CLEAR |
| gibribbon | clock (in) | trigger | "declared gate-typed but **EDGE-detected, i.e. a trigger**. **Each rising edge advances** the ribbon one authoritative beat" | `gibribbon.ts:890` — `const ev = detectEdge(clockEdge, value);` | CLEAR |
| gibribbon | evt_fire (out) | trigger | "A **~10 ms gate pulse** when the marine FIRES" | `gibribbon.ts:372-377` `pulseGate`, `GATE_PULSE_S = 0.01` (`:87`); dispatch `:405` | CLEAR |
| gibribbon | evt_gameover (out) | trigger | "A **~10 ms gate pulse fired once** when the marine reaches GAME OVER" | `gibribbon.ts:372-377`; dispatch `:407` | CLEAR |
| gibribbon | evt_hit (out) | trigger | "A **~10 ms gate pulse** on every successful clear… for **triggering** hit feedback" | `gibribbon.ts:372-377`; dispatch `:403` | CLEAR |
| gibribbon | evt_kill (out) | trigger | "A **~10 ms gate pulse** when an enemy DIES" | `gibribbon.ts:372-377`; dispatch `:406` | CLEAR |
| gibribbon | evt_miss (out) | trigger | "A **~10 ms gate pulse** on every missed event" | `gibribbon.ts:372-377`; dispatch `:404` | CLEAR |
| gibribbon | gate (in) | gate | "The beat gate, **read as a sampled level** (gate, **high above 0.5**), **not edge-judged**" | `gibribbon.ts:894` — `clockTick(state, cv, params.gate > 0.5)` — the level is sampled at the beat; `gate` is never passed to `detectEdge` | CLEAR |
| gibribbon | x_btn (in) | trigger | "The X player button (**rising edge / trigger**): judges the nearest in-window IMP event **on the edge**" | `gibribbon.ts:903` `detectEdge(buttonEdges[btn], value)` | CLEAR |
| gibribbon | y_btn (in) | trigger | "The Y player button (**rising edge / trigger**): judges the nearest in-window ZOMBIE event **on the edge**" | `gibribbon.ts:903` `detectEdge(buttonEdges[btn], value)` | CLEAR |

### illogic (4)

All four outputs come from a `WaveShaperNode` whose curve is
`illogic.ts:95-107` `thresholdCurve` → `curve[i] = x >= threshold ? 1 : 0`,
applied **per sample** to a continuous input. There is no edge state anywhere in
the module; the pure helpers (`illogicMath.and/or/not`, `:71-83`) are
memory-less functions of the instantaneous levels.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| illogic | and (out) | gate | "goes **high (1) only while BOTH are above threshold**, otherwise low. A clean gate" | `illogic.ts:95-107` `thresholdCurve` (per-sample, stateless); `illogicMath.and` `:71-73` | CLEAR |
| illogic | nand (out) | gate | "**high (1) unless both** inputs 1 and 2 are above threshold, **in which case it goes low**" | `illogic.ts:95-107`; `illogicMath.nand` `:74-76` | CLEAR |
| illogic | not (out) | gate | "**high (1) while input 1 is below threshold, low while it is high** — an inverted gate of channel 1" | `illogic.ts:95-107`; `illogicMath.not` `:81-83` | CLEAR |
| illogic | or (out) | gate | "**high (1) while EITHER is above threshold**, low only when both are below" | `illogic.ts:95-107`; `illogicMath.or` `:77-79` | CLEAR |

### kria (4)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| kria | gate1 (out) | gate | "the **duration lane sets how wide it stays high** and the ratchet lane subdivides it into 1–4 re-hits" | `kria.ts:274-280` — `const gateOff = stepDur * durFrac; g.setValueAtTime(1, at); g.setValueAtTime(0, at + gateOff);` (ratchet branch `:282-289`) | CLEAR |
| kria | gate2 (out) | gate | "Track 2's gate, **shaped by track 2's duration**, probability and ratchet lanes" | `kria.ts:274-280` (same emitter, `t = 1`) | CLEAR |
| kria | gate3 (out) | gate | "Track 3's gate, **shaped by track 3's duration**, probability and ratchet lanes" | `kria.ts:274-280` (`t = 2`) | CLEAR |
| kria | gate4 (out) | gate | "Track 4's gate, **shaped by track 4's duration**, probability and ratchet lanes" | `kria.ts:274-280` (`t = 3`) | CLEAR |

### macrooscillator (1) — ⚠ also being declared by open PR #1432

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| macrooscillator | trig (in) | trigger | "It is **sampled per-edge, so it fires once per pulse**; **hold it high**… and the model simply **free-runs**" | `packages/dsp/src/macrooscillator.ts:1494` — `if (trig >= 0.5 && this.lastGate < 0.5) {` (state `:1445`) | CLEAR |

### macseq (15)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| macseq | clock (in **and** out) | trigger | in: "each **rising edge advances** the playhead exactly one step"; out: "A **short ~10 ms pulse** on every step advance" | in `macseq.ts:378` `createEdgeCounter({ ctx, analyser })` (`$lib/audio/edge-detect`, import `:70`); out `:390-391` `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| macseq | gate (out) | gate | "Goes **high** on each ON step… **how long it stays high** within the step is set by the gate-length control" | `macseq.ts:546-547` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac)` | CLEAR |
| macseq | next_cv (in) | trigger | "A **rising edge** latches a 'move to the next filled slot' request" | `transport-cv.ts:107,121` (extended port set, `:61`) | CLEAR |
| macseq | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the run state)" | `transport-cv.ts:107,121` | CLEAR |
| macseq | prev_cv (in) | trigger | "A **rising edge** latches a 'move to the previous filled slot' request" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue1_cv (in) | trigger | "A **rising edge** queues pattern slot 1" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue2_cv (in) | trigger | "A **rising edge** queues pattern slot 2" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue3_cv (in) | trigger | "A **rising edge** queues pattern slot 3" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue4_cv (in) | trigger | "A **rising edge** queues pattern slot 4" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue5_cv (in) | trigger | "A **rising edge** queues pattern slot 5" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue6_cv (in) | trigger | "A **rising edge** queues pattern slot 6" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue7_cv (in) | trigger | "A **rising edge** queues pattern slot 7" | `transport-cv.ts:107,121` | CLEAR |
| macseq | queue8_cv (in) | trigger | "A **rising edge** queues pattern slot 8" | `transport-cv.ts:107,121` | CLEAR |
| macseq | random_cv (in) | trigger | "A **rising edge** latches a 'jump to a random filled slot' request" | `transport-cv.ts:107,121` | CLEAR |
| macseq | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to step 1 and **restarts** the loop" | `transport-cv.ts:107,121` | CLEAR |

### marbles (3)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| marbles | clk (out) | trigger | "The master **clock** output that **paces** both sections — patch it out to **clock** other modules in time" | `marbles.ts:155` — `clk[i] = masterPhase < 0.5 ? 1 : 0` — a 50 %-duty **clock train**; consumers edge-detect it (the repo's clock convention). No note/step semantics attach to its high time | CLEAR |
| marbles | t1 (out) | gate | "First random **gate** from the T section, firing per the selected model's logic, bias and jitter" | `marbles.ts:150` `t1[i] = gateBuf[0] ? 1 : 0` ← `packages/dsp/src/marbles-core.ts:317-319` — high while `outputPhase < this.pulseWidth`, a **model-chosen VARIABLE width** (`randomPulseWidth` `:690-693` → `0.05 + 0.9 × mean` of the step) | CLEAR |
| marbles | t2 (out) | gate | "Second random **gate** from the T section — complementary or independent of t1 depending on the model" | `marbles.ts:151` `t2[i] = gateBuf[1] ? 1 : 0` ← `marbles-core.ts:317-319` (same variable-width path) | CLEAR |

### midiCvBuddy (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| midiCvBuddy | gate (out) | gate | "**Stays high while at least one key is held** and low when all keys are released" | `midi-cv-buddy.ts:429` `gateSrc.offset.setValueAtTime(1, eventTime)` on note-on; `:577` `setValueAtTime(0, t)` when the held stack empties; the 3 ms retrigger dip at `:475-480` is deliberate (`setValueAtTime(0, t)` then `(1, t + 0.003)`) — no fixed pulse width anywhere | CLEAR |

### midiLane (2)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| midiLane | gate (out) | gate | "**High while any key** on this lane's channel(s) **is held**, with a brief retrigger dip" | `midi-lane.ts:414` `gateSrc.offset.setValueAtTime(1, eventTime)`; `:606-607` `setValueAtTime(0, t)` on release; retrigger dip `:523-525` | CLEAR |
| midiLane | note_gate (out) | trigger | "A gate that **fires** when the SPECIFIC MIDI note number… arrives… patch it into a drum voice's **strike or any trigger input**" | `midi-lane.ts:502-504` — `setValueAtTime(1, t); setValueAtTime(0, t + NOTE_GATE_PULSE_S)`, `NOTE_GATE_PULSE_S = 0.006` (`:243`) — **fixed 6 ms regardless of the note's length** | CLEAR |

### midiOutBuddy (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| midiOutBuddy | gate (in) | gate | "a **rising edge sends a MIDI Note On**…, and the **following falling edge sends the matching Note Off**" | `midi-out-buddy.ts:547` `gateEdge.scan(...)` for rises **plus** `:552-558` an explicit falling-edge scan (`if (prev >= GATE_THRESHOLD && cur < GATE_THRESHOLD) fell = true`), resolved against the held `lastGateLevel` at `:565-572`. Both edges + the level → note-on/note-off | CLEAR |

### midiclock (3)

All three are OUTPUTS through one emitter: `midiclock.ts:238-239`
`src.offset.setValueAtTime(1, t); src.offset.setValueAtTime(0, t + GATE_PULSE_S)`,
`GATE_PULSE_S = 0.005` (`:67`).

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| midiclock | clock (out) | trigger | "A **short ~5 ms pulse** whose **rising edge fires once** every N incoming MIDI ticks" | `midiclock.ts:238-239`, `GATE_PULSE_S = 0.005` (`:67`) | CLEAR |
| midiclock | midistart (out) | trigger | "A **one-shot pulse** whose **rising edge fires** the instant a MIDI Start message (0xFA) arrives" | `midiclock.ts:238-239` | CLEAR |
| midiclock | midistop (out) | trigger | "A **one-shot pulse** whose **rising edge fires** when a MIDI Stop message (0xFC) arrives" | `midiclock.ts:238-239` | CLEAR |

### modtris (7)

Inputs: `modtris.ts:186-192` — `detectRisingEdge(lastRotateL, rL)` etc., one per port.
Outputs: `modtris.ts:158-162` — `GATE_PULSE_S = 0.005` (`:55`), N staggered fixed-width pulses.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| modtris | drop_fast (in) | trigger | "Hard/fast-drop the current piece **on each rising edge**… **per pulse**" | `modtris.ts:188` `detectRisingEdge(lastDropFast, dF)` | CLEAR |
| modtris | line_cleared (out) | trigger | "**Fires a 5 ms pulse for each line cleared** — a Tetris… emits FOUR **distinct staggered pulses**" | `modtris.ts:158-162`, `GATE_PULSE_S = 0.005` | CLEAR |
| modtris | move_l (in) | trigger | "Move the current piece one column LEFT **on each rising edge** — **one cell per pulse**" | `modtris.ts:189` `detectRisingEdge(lastMoveL, mL)` | CLEAR |
| modtris | move_r (in) | trigger | "Move the current piece one column RIGHT **on each rising edge** — **one cell per pulse**" | `modtris.ts:190` `detectRisingEdge(lastMoveR, mR)` | CLEAR |
| modtris | overfill (out) | trigger | "**Fires a single 5 ms pulse** when the well overfills… an end-of-run **trigger**" | `modtris.ts:158-162` | CLEAR |
| modtris | rotate_l (in) | trigger | "Rotate… counter-clockwise **on each rising edge** — one quarter-turn per pulse (**acts on the leading edge only, so a held gate rotates once**)" | `modtris.ts:186` `detectRisingEdge(lastRotateL, rL)` | CLEAR |
| modtris | rotate_r (in) | trigger | "Rotate the current piece clockwise **on each rising edge** — **one quarter-turn per pulse**" | `modtris.ts:187` `detectRisingEdge(lastRotateR, rR)` | CLEAR |

### moog911 (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog911 | gate (in) | gate | "the envelope **holds at the sustain level while the gate stays high**, and the **falling edge starts the FINAL DECAY (T3)**" | `packages/dsp/src/lib/moog911-eg-dsp.ts:75-80` — `if (gateHigh && !this.prevGate) { this.stage = ATTACK } else if (!gateHigh && this.prevGate) { … RELEASE }` — both edges; `SUSTAIN: 3 // holding Esus while gated` (`:24`, `:10`) | CLEAR |

### moog911a (4)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog911a | out1 (out) | trigger | "a **short (~1 ms) trigger pulse emitted once**, DELAY 1 seconds after its trigger arrived" | `packages/dsp/src/moog911a.ts:70` — `new DualTriggerDelay(Math.round(TRIGGER_DELAY_PULSE_S * this.sr))` — a fixed pulse-width constructor argument | CLEAR |
| moog911a | out2 (out) | trigger | "Delay 2's output: **a short trigger pulse**, DELAY 2 seconds after delay 2 was triggered" | `packages/dsp/src/moog911a.ts:70` (same `DualTriggerDelay`, second channel) | CLEAR |
| moog911a | trig1 (in) | trigger | "A **rising edge** here starts delay 1's countdown…; **it fires once per edge, not while held**" | `packages/dsp/src/moog911a.ts:76` — *"only changes the armed countdown at the instant of a rising edge"* | CLEAR |
| moog911a | trig2 (in) | trigger | "**Trigger input** for delay 2 — used only in OFF mode" (same countdown seam as TRIG 1) | `packages/dsp/src/moog911a.ts:70,76` (`DualTriggerDelay`, channel 2) | CLEAR |

### moog912 (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog912 | gate (out) | gate | "Goes **high (~1) while the followed envelope is above the detection threshold** … and **low (~0) when it falls quiet**" | `moog912.ts:102-106` `buildGateCurve` — `curve[i] = x >= threshold ? 1 : 0`, applied as a WaveShaper to the smoothed envelope **continuously** (`:180` *"Gate: a steep step on the env"*); `GATE_THRESHOLD = 0.1` (`:80`) | CLEAR |

### moog956 (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog956 | gate (out) | gate | "Gate that **stays HIGH (1.0) the entire time you are touching the ribbon** and drops to 0 when you lift off — a **hold-while-pressed** gate" | `moog956.ts:138` — `gateSrc.offset.setValueAtTime(live.gate, ctx.currentTime)` — the live touch state, written on press AND release; no pulse width | CLEAR |

### moog960 (4)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog960 | clock (in) | trigger | "each **rising edge advances** the column pointer exactly one step" | `moog960.ts:245` *"Count rising edges that arrived on a gate port since the last tick"* → `:364` *"one column per observed rising edge"* | CLEAR |
| moog960 | clock_out (out) | trigger | "A **short (~10 ms) pulse** fired on every column advance" | `moog960.ts:295-296` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| moog960 | start (in) | trigger | "A **rising edge starts** the sequencer running from column 1" | `moog960.ts:348` — *"Transport gates: a rising edge on start runs; on stop halts"*, drained through the `:245` rising-edge counter | CLEAR |
| moog960 | stop (in) | trigger | "A **rising edge halts** the sequencer" | `moog960.ts:348` (same counter) | CLEAR |

### moog961 (7) — ⚠ 3 CONTRADICTIONS

All seven live in `packages/dsp/src/lib/trigger-convert-dsp.ts` `step()` (`:87-135`),
called per sample from `packages/dsp/src/moog961.ts:119-131`.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog961 | s_in (in) | **gate** | "**A trigger input** (the 'S' format): it passes straight through to BOTH v_out1 and v_out2" | `trigger-convert-dsp.ts:108,116` — `const sHigh = sIn >= GATE_THRESHOLD;` … `const vTrig = sHigh ? 1 : audioRising ? 1 : 0;` with the in-source comment `:110-112`: *"v_out1 / v_out2 are driven HIGH **while the external S-trigger is held** (format passthrough)… We **mirror the s_in gate for its full width** (duration-matched, like FLIPPER)"* | **CONTRADICTION** |
| moog961 | s_out_a (out) | gate | "Mirrors v_in_a with its incoming width — **high while v_in_a is high** (a width-preserving gate pass-through)" | `trigger-convert-dsp.ts:120` — `const sOutA = vInA >= GATE_THRESHOLD ? 1 : 0;` (stateless per-sample level) | CLEAR |
| moog961 | s_out_b (out) | gate | "a pulse of **exactly SWITCH-ON TIME seconds**… so you can standardize ragged triggers to **a known gate length**" | `trigger-convert-dsp.ts:129-134` — a countdown one-shot of `switchOnTime` s. `SWITCH_ON_TIME_DEFAULT = 0.2` (`:31`), range **0.04–4 s** (`moog961.ts:65`) — 40× `TRIGGER_PULSE_S` (5 ms) and 4× `DEFAULT_GATE_LEN_S` (50 ms), i.e. a **gate length**, not a strike | CLEAR |
| moog961 | v_in_a (in) | gate | "**A gate input** (the 'V' format)… it passes through carrying its OWN width — **while v_in_a is high, s_out_a is high**" | `trigger-convert-dsp.ts:120` — per-sample level read, no edge state | CLEAR |
| moog961 | v_in_b (in) | trigger | "**each rising edge fires a FIXED-WIDTH one-shot**…, **regardless of how long v_in_b stays high**" | `trigger-convert-dsp.ts:123-128` — `const vbHigh = vInB >= GATE_THRESHOLD; if (vbHigh && !this.vbWasHigh) { this.bPulseRemaining = this.pulseSamples(switchOnTimeSec); }` | CLEAR |
| moog961 | v_out1 (out) | **gate** | "**A trigger output** fired by either the audio level detector… or the s_in pass-through" | `trigger-convert-dsp.ts:115-116` — `const vTrig = sHigh ? 1 : audioRising ? 1 : 0; const vOut1 = vTrig;` — HIGH **for the full width of a held s_in**; the audio branch contributes only a single-sample tick, so the dominant path is level-mirroring | **CONTRADICTION** |
| moog961 | v_out2 (out) | **gate** | "The second **V trigger output**, fired by the same sources as v_out1" | `trigger-convert-dsp.ts:117` — `const vOut2 = vTrig;` (identical to v_out1) | **CONTRADICTION** |

### moog962 (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog962 | shift (in) | trigger | "each **rising edge steps** the selector to the next input…; **it acts once per edge, not while held**" | `packages/dsp/src/moog962.ts:107-109` — the per-sample shift value is fed to `Moog962Switch`, described `:10` as a *"rising-edge counter"*; `:25` *"advances the selector on each rising edge"* | CLEAR |

### moog993 (5) — ⚠ DSP is NEUTRAL (see findings)

`moog993.ts:9-13`: *"**PASSIVE ROUTING — no DSP.** Pure Web Audio graph
(GainNodes only): each trigger output is a summing GainNode fed by BOTH trigger
sources through per-source 'select' gains."* Construction at `:92-101`. There is
**no edge detection and no level interpretation anywhere in the module** — the
signal is relayed sample-for-sample. The DSP therefore neither confirms nor
refutes either semantic; the unanimous prose and the modelled hardware (Moog 993
*Trigger* & Envelope Voltages) decide.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| moog993 | trig_from1 (in) | trigger | "**Trigger SOURCE 1**: a trigger/gate signal made available to any of the three outputs… Patch a **clock or trigger** here" | `moog993.ts:9-13` + `:92` `const src1 = ctx.createGain();` — passive relay, DSP **NEUTRAL** | CLEAR |
| moog993 | trig_from2 (in) | trigger | "**Trigger SOURCE 2**: a second trigger/gate source, selected by any output whose ROUTE is set to FROM 2" | `moog993.ts:9-13` + `:93` `const src2 = ctx.createGain();` — passive relay, DSP **NEUTRAL** | CLEAR |
| moog993 | trig_out1 (out) | trigger | "**Trigger output 1** — carries whichever source its ROUTE 1 switch selects (OFF, FROM 1, or FROM 2)" | `moog993.ts:9-13` + `:100-101` summing/select GainNodes — passive relay, DSP **NEUTRAL** | CLEAR |
| moog993 | trig_out2 (out) | trigger | "**Trigger output 2** — carries whichever source its ROUTE 2 switch selects" | `moog993.ts:9-13`, `:100-101` — DSP **NEUTRAL** | CLEAR |
| moog993 | trig_out3 (out) | trigger | "**Trigger output 3** — carries whichever source its ROUTE 3 switch selects" | `moog993.ts:9-13`, `:100-101` — DSP **NEUTRAL** | CLEAR |

### nibbles (3)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| nibbles | death (out) | trigger | "Gate output — **a 10 ms HIGH pulse** fired when the snake dies… **One pulse per death**" | `packages/web/src/lib/video/modules/nibbles.ts:356-361` `pulseGate`, `GATE_PULSE_S = 0.01` (`:79`); dispatch `:465` | CLEAR |
| nibbles | dir_change (out) | trigger | "Gate output — **a 10 ms HIGH pulse** on every accepted direction change" | `nibbles.ts:356-361`; dispatch `:467` | CLEAR |
| nibbles | pellet (out) | trigger | "Gate output — **a 10 ms HIGH pulse** fired each time the snake eats a pellet. Patch into an envelope **trigger**" | `nibbles.ts:356-361`; dispatch `:462` | CLEAR |

### numpadPlus (5)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| numpadPlus | clock (in) | trigger | "each **rising edge advances** the shared playhead one step" | `numpad-plus.ts:383` `createEdgeCounter({ ctx, analyser: clockInAnalyser })` — the shared windowed rising-edge counter (`:379-382`, import `:71`) | CLEAR |
| numpadPlus | l1_gate (out) | gate | "Layer 1's gate: **high on a lit step (or while a key is held** on layer 1), **low otherwise**" | `numpad-plus.ts:493` `layerOutputs[i]!.gate.offset.setTargetAtTime(1, …)` (manual held) / `:496` (lit step) / `:498` `setTargetAtTime(0, …)` — re-asserted from the LIVE held/lit state every tick, no pulse width | CLEAR |
| numpadPlus | l2_gate (out) | gate | "Layer 2's gate: **high on a lit step or held key, low otherwise**" | `numpad-plus.ts:493-498` (same per-layer loop, `i = 1`) | CLEAR |
| numpadPlus | l3_gate (out) | gate | "Layer 3's gate: **high on a lit step or held key, low otherwise**" | `numpad-plus.ts:493-498` (`i = 2`) | CLEAR |
| numpadPlus | l4_gate (out) | gate | "Layer 4's gate: **high on a lit step or held key, low otherwise**" | `numpad-plus.ts:493-498` (`i = 3`) | CLEAR |

### outlines (2)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| outlines | collide (in) | gate | "Live inter-shape collision mode (gate, **level — read every frame, not latched**). **While HIGH (>=0.5)** shapes bounce off each other" | `outlines.ts:97-105` — `OUTLINES_COLLIDE_PARAM_ID`, `COLLIDE_GATE_HIGH = 0.5`; `:182` *"the sim reads it each frame (HIGH → …)"*; `:256` *"read live every frame"* | CLEAR |
| outlines | gate (in) | trigger | "**Spawn trigger (edge). A rising edge spawns ONE shape**, which latches the LIVE D / V / Spd / Decay / Shape values **at the moment of the edge**" | `outlines.ts:179` *"into setParam(cv_gate, value); **a rising-edge detector spawns one shape**"*; `:255` (same, on the synthetic param) | CLEAR |

### picturebox (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| picturebox | asset_gate (in) | trigger | "the card **edge-detects the RISING edge** (level crosses ~0.5)… **Acts on edges, not the held level**" | `packages/web/src/lib/ui/modules/PictureboxCard.svelte:294` — `const rising = lastAssetGate < 0.5 && g >= 0.5;` | CLEAR |

### polyseqz (8)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| polyseqz | clock (in **and** out) | trigger | in: "each **rising edge advances** the playhead exactly one step (one chord)"; out: "A **short ~10 ms pulse** on every step advance" | in `polyseqz.ts:611` `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:322-323` `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| polyseqz | gate (out) | gate | "goes **high while ANY voice of the current chord is sounding**… Its **high time within the step follows the gate-length control**" | `polyseqz.ts:475-476` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + gateOffWindow)` | CLEAR |
| polyseqz | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the run state)" | `transport-cv.ts:107,121` | CLEAR |
| polyseqz | queue1_cv (in) | trigger | "A **rising edge** queues pattern slot 1" | `transport-cv.ts:107,121` | CLEAR |
| polyseqz | queue2_cv (in) | trigger | "A **rising edge** queues pattern slot 2" | `transport-cv.ts:107,121` | CLEAR |
| polyseqz | queue3_cv (in) | trigger | "A **rising edge** queues pattern slot 3" | `transport-cv.ts:107,121` | CLEAR |
| polyseqz | queue4_cv (in) | trigger | "A **rising edge** queues pattern slot 4" | `transport-cv.ts:107,121` | CLEAR |
| polyseqz | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to step 1 and **restarts** the progression" | `transport-cv.ts:107,121` | CLEAR |

### pong (2)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| pong | score_left (out) | trigger | "**Fires a 5 ms pulse** each time the LEFT side scores… **A trigger** you can route to a sound" | `pong.ts:155-156` — `src.offset.setValueAtTime(1, t); src.offset.setValueAtTime(0, t + GATE_PULSE_S)`, `GATE_PULSE_S = 0.005` (`:57`) | CLEAR |
| pong | score_right (out) | trigger | "**Fires a 5 ms pulse** each time the RIGHT side scores" | `pong.ts:155-156` (same emitter) | CLEAR |

### qbrt (1) — the known freebie

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| qbrt | ping (in) | trigger | "The excitation **TRIGGER**. Each **rising edge** across 0.5 fires two things at once… **Only the RISING edge matters: how long the signal stays high changes nothing**" | `packages/dsp/src/qbrt.dsp:14` — `edge(x) = (x >= 0.5) & (x' < 0.5);` — a textbook rising-edge detector, consumed by `qPingEnv` (`:25-28`) | CLEAR |

### rings (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| rings | strum (in) | trigger | "**A TRIGGER**: each **rising edge** re-ignites the resonator… **It fires on the edge only and ignores how long the level stays high**" | `packages/dsp/src/rings.ts:391-396` — `const risingEdge = strum >= 0.5 && this.lastStrum < 0.5; if (risingEdge) { this.symp.triggerStrum(sr); … this.modalPlucker.trigger(Math.floor(0.01 * sr)); }` | CLEAR |

### sampleHold (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| sampleHold | gate_in (in) | trigger | "The sample clock: **each rising edge latches** the current cv_in and holds it… **until the next rising edge**" | `packages/dsp/src/sample-hold.ts:129-132` — `if (g >= GATE_THRESHOLD && this.prevGate < GATE_THRESHOLD) { … }` (state `:81`, doc `:11-12`) | CLEAR |

### samsloop (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| samsloop | trig (in) | trigger | "**Rising-edge trigger** that STARTS playback per the current MODE… **a re-trigger restarts it** from the window edge" | `packages/dsp/src/samsloop.ts:235` — `if (this.lastTrig < TRIG_THRESHOLD && t >= TRIG_THRESHOLD) {` (state `:122`, doc `:32`) | CLEAR |

### score (8)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| score | clock (in **and** out) | trigger | in: "each **rising edge advances** the playhead one 16th-note"; out: "A **short pulse** on every 16th-note advance" | in `score.ts:569` `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:260-261` `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| score | gate (out) | gate | "Goes **high while a note sounds** and low between notes; **a tie holds the gate high across the whole tied span**" | `score.ts:378-379` `setValueAtTime(0, atTime + noteSec * 0.95)` (note-length derived) and `:390-391` `setValueAtTime(0, atTime + spanSec * 0.98)` (tie-span derived) | CLEAR |
| score | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the transport state)" | `transport-cv.ts:107,121` | CLEAR |
| score | queue1_cv (in) | trigger | "A **rising edge** queues saved pattern slot 1" | `transport-cv.ts:107,121` | CLEAR |
| score | queue2_cv (in) | trigger | "A **rising edge** queues saved pattern slot 2" | `transport-cv.ts:107,121` | CLEAR |
| score | queue3_cv (in) | trigger | "A **rising edge** queues saved pattern slot 3" | `transport-cv.ts:107,121` | CLEAR |
| score | queue4_cv (in) | trigger | "A **rising edge** queues saved pattern slot 4" | `transport-cv.ts:107,121` | CLEAR |
| score | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to the top of the piece and **restarts**" | `transport-cv.ts:107,121` | CLEAR |

### sequencer (15)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| sequencer | clock (in **and** out) | trigger | in: "each **rising edge advances** the playhead exactly one step"; out: "A **short ~10 ms pulse** fired on every step advance" | in `sequencer.ts:663` `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:283-284` `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| sequencer | gate (out) | gate | "Goes **high while a lit step is playing**… **how long it stays high** within the step is set by the gate-length control" | `sequencer.ts:446-447` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + gateOff)` | CLEAR |
| sequencer | next_cv (in) | trigger | "A **rising edge** latches a 'move to the next filled slot' request" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the current run state)" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | prev_cv (in) | trigger | "A **rising edge** latches a 'move to the previous filled slot' request" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue1_cv (in) | trigger | "A **rising edge** queues pattern slot 1" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue2_cv (in) | trigger | "A **rising edge** queues pattern slot 2" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue3_cv (in) | trigger | "A **rising edge** queues pattern slot 3" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue4_cv (in) | trigger | "A **rising edge** queues pattern slot 4" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue5_cv (in) | trigger | "A **rising edge** queues pattern slot 5" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue6_cv (in) | trigger | "A **rising edge** queues pattern slot 6" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue7_cv (in) | trigger | "A **rising edge** queues pattern slot 7" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | queue8_cv (in) | trigger | "A **rising edge** queues pattern slot 8" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | random_cv (in) | trigger | "A **rising edge** latches a 'jump to a random filled slot' request" | `transport-cv.ts:107,121` | CLEAR |
| sequencer | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to step 1 and **restarts** the loop" | `transport-cv.ts:107,121` | CLEAR |

### shapegen (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| shapegen | clock_in (in) | trigger | "shapes **re-roll only on each rising edge** (hysteresis ~0.6/0.4) and **freeze in between**" | `packages/web/src/lib/video/modules/shapegen.ts:457` — *"crosses LOW→HIGH (rise > 0.6, fall < 0.4 hysteresis)"*; `:193` *"a rising edge… triggers the next-frame shape regeneration"* | CLEAR |

### skifree (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| skifree | gate (out) | trigger | "**Fires a 10 ms pulse** on every crash event… **A rising-edge trigger** you can route to a crash sound" | `skifree.ts:212-213` — `gateSrc.offset.setValueAtTime(1, t); gateSrc.offset.setValueAtTime(0, t + SKIFREE_GATE_PULSE_S)`, `= 0.01` (`:47`) | CLEAR |

### slewSwitch (3)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| slewSwitch | eoc (out) | trigger | "End-of-cycle: **a short (~5 ms) gate pulse** each time the switch WRAPS back to channel 0" | `packages/dsp/src/slewswitch.ts:205-209` — `if (this.eocRemaining > 0) { eocOut[i] = 1; this.eocRemaining--; } else { eocOut[i] = 0; }`, armed with `EOC_PULSE_S = 0.005` (`:46`, `:100/107/115`) | CLEAR |
| slewSwitch | reset (in) | trigger | "**Resets** the switch index back to channel 0 **on each rising edge**" | `packages/dsp/src/slewswitch.ts:174-180` — `if (rs > 0.5 && this.prevReset <= 0.5) { … this.curIdx = 0; … } this.prevReset = rs;` | CLEAR |
| slewSwitch | step_clock (in) | trigger | "each **rising edge steps** the 4-to-1 sequential switch to the next channel" | `packages/dsp/src/slewswitch.ts:183-188` — `if (ck > 0.5 && this.prevClock <= 0.5) { … this.advance(len, mode); … } this.prevClock = ck;` | CLEAR |

### synesthesia (16)

⚠ **Prose is LOOP-GENERATED** at `synesthesia.ts:239-240`, inside a
`docs: (() => { … })()` IIFE (`:219`) — a per-port `docs.outputs.<id>` grep finds
nothing, which is exactly the trap called out in §4.5. Both templates are quoted
in full below and both agree with the DSP, so all sixteen are **CLEAR**.

All sixteen are OUTPUTS, and the two families come from two different detector
classes in `packages/dsp/src/lib/synesthesia-dsp.ts`, driven per sample at
`:476-477` (block path) and `:578-579` (offline path):

- **`*_gate`** → `GateDetector` (`:221-233`), a Schmitt trigger:
  `if (!this.on && env >= this.thrHigh) this.on = true; else if (this.on && env < this.thrLow) this.on = false; return this.on ? 1 : 0;`
  — level-tracking in **both** directions (0.05 / 0.02 hysteresis). **gate**.
- **`*_trig`** → `OnsetDetector` (`:276-325`), spectral-flux peak-pick latching a
  **fixed** `ONSET_PULSE_MS = 10` (`:237`) pulse per onset with an 80 ms debounce
  lockout (`:311-315`, `:320-323`). **trigger**.

The two prose templates (`synesthesia.ts:239-240`), which every row below quotes
from:

- `*_gate` — *"Copy {C} band {b} GATE — **goes high while** the {band}'s **level
  is above** a hysteresis threshold **and low when it falls below**; a
  **level-sensitive** gate that follows energy in that band."*
- `*_trig` — *"Copy {C} band {b} TRIGGER — a short **~10 ms pulse** on each
  spectral-flux onset (beat) detected in the {band}… Patch into envelopes/drum
  voices to **fire** on that band's hits."*

The def's header agrees too (`synesthesia.ts:7-8` *"a hysteresis gate, and a
per-band BEAT TRIGGER"*; `:82-83` *"Per-band beat triggers (spectral-flux onset;
~10 ms pulse)"*).

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| synesthesia | a_band1_gate (out) | gate | "Copy A band 1 GATE — **goes high while** the bass (20–200 Hz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232` `GateDetector.step` — Schmitt, level-tracking both ways; driven `:476` `gate[c] = this.gate[c]!.step(ef)` | CLEAR |
| synesthesia | a_band1_trig (out) | trigger | "Copy A band 1 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the bass (20–200 Hz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325` `OnsetDetector.step` — fixed `ONSET_PULSE_MS = 10` latch (`:237`); driven `:477` `trig[c] = this.onset[c]!.step(a)` | CLEAR |
| synesthesia | a_band2_gate (out) | gate | "Copy A band 2 GATE — **goes high while** the low-mid (200 Hz–1 kHz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; driven `:476` (band 1) | CLEAR |
| synesthesia | a_band2_trig (out) | trigger | "Copy A band 2 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the low-mid (200 Hz–1 kHz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; driven `:477` (band 1) | CLEAR |
| synesthesia | a_band3_gate (out) | gate | "Copy A band 3 GATE — **goes high while** the high-mid (1–4 kHz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; driven `:476` (band 2) | CLEAR |
| synesthesia | a_band3_trig (out) | trigger | "Copy A band 3 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the high-mid (1–4 kHz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; driven `:477` (band 2) | CLEAR |
| synesthesia | a_band4_gate (out) | gate | "Copy A band 4 GATE — **goes high while** the treble (4 kHz+) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; driven `:476` (band 3) | CLEAR |
| synesthesia | a_band4_trig (out) | trigger | "Copy A band 4 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the treble (4 kHz+) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; driven `:477` (band 3) | CLEAR |
| synesthesia | b_band1_gate (out) | gate | "Copy B band 1 GATE — **goes high while** the bass (20–200 Hz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; copy B, `:578` | CLEAR |
| synesthesia | b_band1_trig (out) | trigger | "Copy B band 1 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the bass (20–200 Hz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; copy B, `:579` | CLEAR |
| synesthesia | b_band2_gate (out) | gate | "Copy B band 2 GATE — **goes high while** the low-mid (200 Hz–1 kHz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; copy B, `:578` | CLEAR |
| synesthesia | b_band2_trig (out) | trigger | "Copy B band 2 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the low-mid (200 Hz–1 kHz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; copy B, `:579` | CLEAR |
| synesthesia | b_band3_gate (out) | gate | "Copy B band 3 GATE — **goes high while** the high-mid (1–4 kHz) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; copy B, `:578` | CLEAR |
| synesthesia | b_band3_trig (out) | trigger | "Copy B band 3 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the high-mid (1–4 kHz) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; copy B, `:579` | CLEAR |
| synesthesia | b_band4_gate (out) | gate | "Copy B band 4 GATE — **goes high while** the treble (4 kHz+) band's level is above a hysteresis threshold and low when it falls below; a **level-sensitive** gate that follows energy in that band." | `synesthesia-dsp.ts:226-232`; copy B, `:578` | CLEAR |
| synesthesia | b_band4_trig (out) | trigger | "Copy B band 4 TRIGGER — a short **~10 ms pulse** on each spectral-flux onset (beat) detected in the treble (4 kHz+) band (LZX-Sensory-Translator style). Patch into envelopes/drum voices to fire on that band's hits." | `synesthesia-dsp.ts:296-325`; copy B, `:579` | CLEAR |

### timelorde (16)

The twelve division taps **and** `swing` all come out of one pulse queue with a
**fixed** width: `packages/dsp/src/lib/timelorde-clock-core.ts:27`
`const PULSE_WIDTH_S = 0.01;`, `:76` *"Schedule a pulse to fire `delaySamples`
from now, **lasting PULSE_WIDTH samples**"*, sized at `:245`
`const pulseWidthSamples = Math.max(1, Math.round(PULSE_WIDTH_S * sr));`. Swing
rides the same queue (`:118`, `OUT_SWING` index 12) — it shifts *when* a pulse
lands, never *how long* it lasts.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| timelorde | 1/12 (out) | trigger | "**One pulse** every twelve beats — **once** every three bars" | `timelorde-clock-core.ts:27,76,245` — fixed `PULSE_WIDTH_S = 0.01` | CLEAR |
| timelorde | 1/16 (out) | trigger | "**One pulse** every sixteen beats — **once** every four bars" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/2 (out) | trigger | "Half-note **clock** — **one pulse** every two beats" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/3 (out) | trigger | "**One pulse** every three beats" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/32 (out) | trigger | "**One pulse** every thirty-two beats — **once** every eight bars" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/4 (out) | trigger | "**One pulse** every four beats… Like every divider it **fires** on the FIRST beat of its group" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/64 (out) | trigger | "**One pulse** every sixty-four beats — **once** every sixteen bars" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1/8 (out) | trigger | "**One pulse** every eight beats — **once** every two bars" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 1x (out) | trigger | "Quarter-note **clock** — **one pulse per beat** at the master BPM" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 2x (out) | trigger | "Eighth-note **clock** — **two pulses per beat**" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 4x (out) | trigger | "Sixteenth-note **clock** — **four pulses per beat**" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | 8x (out) | trigger | "32nd-note **clock** — **eight pulses per beat**" | `timelorde-clock-core.ts:27,76,245` | CLEAR |
| timelorde | clock (in) | trigger | "locks its master tempo to the **measured period between incoming rising edges**" | `timelorde-clock-core.ts:260-283` — per-sample rising-edge detection on `inputs[0]`, feeding `fireMaster`; the high duration is never read | CLEAR |
| timelorde | start_in (in) | trigger | "Transport START: **a rising edge resumes** the clock from wherever it was last stopped" | `timelorde.ts:492` — `const startEdges = startDet.scan(startBuf, start, startBuf.length);` → `:504` | CLEAR |
| timelorde | stop_in (in) | trigger | "Transport STOP: **a rising edge halts** the clock" | `timelorde.ts:493` — `const stopEdges = stopDet.scan(stopBuf, start, stopBuf.length);` → `:505` | CLEAR |
| timelorde | swing (out) | trigger | "A SHUFFLED copy of whichever division SRC selects…: its on-beats **fire** dead on time and its off-beats are **held back** by the SWING amount, so **the pulses alternate long-short**" | `timelorde-clock-core.ts:118` (same pending-pulse queue, `OUT_SWING`), `:240` `swingLagSamples` shifts the START only; width stays `PULSE_WIDTH_S` (`:27,245`) | CLEAR |

### twotracks (6)

Prose is **generated in a loop** at `twotracks.ts:302-304` (which is why a naive
`docs.inputs.<port>` grep misses it). DSP is `packages/dsp/src/twotracks.ts`
`:657` / `:664` / `:680`, all of the same shape
`if (reel.lastX < TRIG_THRESHOLD && xVal >= TRIG_THRESHOLD) { … }`.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| twotracks | overdub_a (in) | trigger | "Reel A OVERDUB gate: **a rising edge toggles** overdub (sound-on-sound) mode" (`twotracks.ts:304`) | `packages/dsp/src/twotracks.ts:680` — `if (reel.lastOverdubToggle < TRIG_THRESHOLD && overdubTogVal >= TRIG_THRESHOLD) { reel.overdubFlag = !reel.overdubFlag; … }` | CLEAR |
| twotracks | overdub_b (in) | trigger | "Reel B OVERDUB gate: **a rising edge toggles** overdub" (`twotracks.ts:304`) | `packages/dsp/src/twotracks.ts:680` (per-reel loop, reel B) | CLEAR |
| twotracks | rec_arm_a (in) | trigger | "Reel A record ARM gate: **a rising edge arms** reel A" (`twotracks.ts:303`) | `packages/dsp/src/twotracks.ts:657` — `if (reel.lastRecArm < TRIG_THRESHOLD && recArmVal >= TRIG_THRESHOLD) { reel.state = 'armed'; … }` | CLEAR |
| twotracks | rec_arm_b (in) | trigger | "Reel B record ARM gate: **a rising edge arms** reel B" (`twotracks.ts:303`) | `packages/dsp/src/twotracks.ts:657` (reel B) | CLEAR |
| twotracks | rec_start_a (in) | trigger | "Reel A record START gate: **a rising edge starts (or restarts)** recording" (`twotracks.ts:302`) | `packages/dsp/src/twotracks.ts:664` — `if (reel.lastRecStart < TRIG_THRESHOLD && recStartVal >= TRIG_THRESHOLD) { … }` | CLEAR |
| twotracks | rec_start_b (in) | trigger | "Reel B record START gate: **a rising edge starts (or restarts)** recording" (`twotracks.ts:302`) | `packages/dsp/src/twotracks.ts:664` (reel B) | CLEAR |

### vfpgaRunner (4) — ⚠ dual by design (see findings)

The prose **deliberately refuses to choose** ("Acts as a gate or a trigger per
which role uniforms it declares"), so there is no prose signal for the
declaration → DSP-ONLY. The host itself always maintains and publishes the
**held** state (`vfpga-runner.ts:420`
`add(pass.uniforms.get(role.heldUniform) ?? null, gateEdges[role.slot - 1]!.pressed ? 1 : 0)`,
plus `:556` *"Per-gate held state (card activity LEDs)"*), and additionally an
edge count (`:421`). `gate` is the superset that does not over-promise: it is
always true that the level matters here; it is not always true that only the
edge does.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| vfpgaRunner | g1 (in) | gate | prose declines to choose: "the loaded spec's gate role for this slot **chooses** level (gate…) or rising-edge count (trigger…)" | `vfpga-runner.ts:420` — held level published every frame (`gateEdges[0].pressed ? 1 : 0`); `:556` per-gate held state | DSP-ONLY |
| vfpgaRunner | g2 (in) | gate | "Acts as **a gate or a trigger** per which role uniforms it declares" | `vfpga-runner.ts:420` (`slot 2`), `:556` | DSP-ONLY |
| vfpgaRunner | g3 (in) | gate | "Held level (gate) and rising-edge count (trigger) **both available**… interpretation is the role's choice" | `vfpga-runner.ts:420` (`slot 3`), `:556` | DSP-ONLY |
| vfpgaRunner | g4 (in) | gate | "level + edge-count exposed to the loaded spec's gate-role-4 (**gate vs trigger per its uniforms**)" | `vfpga-runner.ts:420` (`slot 4`), `:556` | DSP-ONLY |

### videobox (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| videobox | play_trigger (in) | trigger | "TRIG (gate cable, **edge: trigger**). A **rising edge** across the gate threshold toggles play/pause — **it does NOT hold**" | `packages/web/src/lib/ui/modules/VideoboxCard.svelte:539-540` — `// Rising edge across 0.5: pulse → toggle.` / `if (lastGateValue < 0.5 && v >= 0.5) {` | CLEAR |

### videovarispeed (5)

All five poll one shared rising-edge predicate:
`packages/web/src/lib/ui/modules/VideovarispeedCard.svelte:831`
`return prev < 0.5 && v >= 0.5;`.

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| videovarispeed | asset_gate (in) | trigger | "Gate (**rising-edge / trigger**). **On the edge** it reads ASSET PITCH, maps it to a slot" | `VideovarispeedCard.svelte:831` `return prev < 0.5 && v >= 0.5;` | CLEAR |
| videovarispeed | cv_loop_toggle (in) | trigger | "Gate (**rising-edge / trigger**). **Each rising edge flips** the transport between LOOP and ONE-SHOT" | `VideovarispeedCard.svelte:831` | CLEAR |
| videovarispeed | cv_pause (in) | trigger | "Gate (**rising-edge / trigger**). Each **rising edge** toggles pause/unpause — **it is not level-held**" | `VideovarispeedCard.svelte:831` | CLEAR |
| videovarispeed | cv_reset (in) | trigger | "Gate (**rising-edge / trigger**). **On the edge** it seeks the playhead back to the START point" | `VideovarispeedCard.svelte:831` | CLEAR |
| videovarispeed | cv_start (in) | trigger | "Gate (**rising-edge / trigger**). **On the edge** it (re)starts playback from the START window point" | `VideovarispeedCard.svelte:831` | CLEAR |

### wavecel (1)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| wavecel | trigger (in) | gate | "**while the level is high the note is held** — a rising edge starts the ADSR attack (note-on) and the **falling edge starts its release** (note-off) — so it is **level-sensitive, not just a one-shot**" | `packages/dsp/src/wavecel.ts:299-302` — `if (trigGate && !this.prevTrigGate) this.env[0]!.triggerSoft(true); else if (!trigGate && this.prevTrigGate) this.env[0]!.triggerSoft(false); … this.prevTrigGate = trigGate;` — both edges | CLEAR |

### wavesculpt (4) — ⚠ WebGL attest basis

Prose is **generated in a loop** at `wavesculpt.ts:898` (inside the
`docs-hash-ignore` block, `:884-…`). DSP is `wavesculpt.ts:1406-1411`
`if (gateNow && !v.gateHigh) { v.gateHigh = true; … } else if (!gateNow && v.gateHigh) { v.gateHigh = false; … }`,
feeding the per-voice ADSR whose SUSTAIN stage holds at `sLevel` (`:514-515`)
and whose RELEASE runs from the fall (`:517-521`).

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| wavesculpt | gate1 (in) | gate | "Oscillator 1 (RED) GATE — its per-osc amp ADSR **holds open WHILE this gate is high** and **releases on the falling edge**, so **a held gate sustains**" (`wavesculpt.ts:898`) | `wavesculpt.ts:1406-1411` (both edges) + sustain `:514-515`, release `:517-521` | CLEAR |
| wavesculpt | gate2 (in) | gate | "Oscillator 2 (GREEN) GATE — … **holds open WHILE this gate is high** and **releases on the falling edge**" (`wavesculpt.ts:898`) | `wavesculpt.ts:1406-1411` (per-voice loop) | CLEAR |
| wavesculpt | gate3 (in) | gate | "Oscillator 3 (BLUE) GATE — … **holds open WHILE this gate is high** and **releases on the falling edge**" (`wavesculpt.ts:898`) | `wavesculpt.ts:1406-1411` | CLEAR |
| wavesculpt | gate4 (in) | gate | "Oscillator 4 (ALPHA) GATE — … **holds open WHILE this gate is high** and **releases on the falling edge**" (`wavesculpt.ts:898`) | `wavesculpt.ts:1406-1411` | CLEAR |

### writeseq (9)

| module | port | edge | prose evidence (quoted) | DSP evidence (file:line + clause) | confidence |
|---|---|---|---|---|---|
| writeseq | clock (in **and** out) | trigger | in: "each **rising edge advances** the playhead one step"; out: "A **short ~10 ms pulse** on every step advance" | in `writeseq.ts:701` `if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD)`; out `:427-428` `setValueAtTime(1, atTime); setValueAtTime(0, atTime + 0.01)` | CLEAR |
| writeseq | gate (in) | gate | "a rising edge while recording writes the sampled pitch+gate…; **and whenever the gate is held high it passes through live and overrides the sequenced output**" | `writeseq.ts:757` — `const liveGateHeld = latestSample(gateTap) >= CLOCK_THRESHOLD;` consumed at `:840-842` (`if (liveGateHeld) { … gateSrc.offset.setTargetAtTime(1, …) }`). The **held level** is read every tick. (The same port also feeds a rising-edge count at `:511`/`:533-541` for the quantize-record — see findings) | CLEAR |
| writeseq | gate (out) | gate | "Goes **high on each ON step** (**its width set by the gate-length control**) — unless a **live gate is held in**" | `writeseq.ts:650-651` — `setValueAtTime(1, atTime); setValueAtTime(0, atTime + stepDurForGate * gateLengthFrac)` | CLEAR |
| writeseq | play_cv (in) | trigger | "A **rising edge** toggles play/stop (**each pulse** flips the run state)" | `transport-cv.ts:107,121` | CLEAR |
| writeseq | queue1_cv (in) | trigger | "A **rising edge** queues pattern slot 1" | `transport-cv.ts:107,121` | CLEAR |
| writeseq | queue2_cv (in) | trigger | "A **rising edge** queues pattern slot 2" | `transport-cv.ts:107,121` | CLEAR |
| writeseq | queue3_cv (in) | trigger | "A **rising edge** queues pattern slot 3" | `transport-cv.ts:107,121` | CLEAR |
| writeseq | queue4_cv (in) | trigger | "A **rising edge** queues pattern slot 4" | `transport-cv.ts:107,121` | CLEAR |
| writeseq | rec (in) | trigger | "Record arm: **a rising edge toggles** the record-arm state on/off… hands-free from a footswitch" | `writeseq.ts:517-524` `pollRecEdges()` → `countEdges` `:511` `if (prev < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) edges++;` | CLEAR |
| writeseq | reset_cv (in) | trigger | "A **rising edge** snaps the playhead back to step 1 and **resets** the record position" | `transport-cv.ts:107,121` | CLEAR |

---

## 4 · FINDINGS

### 4.1 CONTRADICTIONS — 6 pairs across 3 modules (DSP wins; Phase 1 fixes the prose)

| # | pair | declared (DSP) | the prose that is wrong | why the DSP wins |
|---|---|---|---|---|
| 1 | **drummergirl.gate** (in) | `gate` | "its **level isn't sustained**, only the rising edge matters, so hit length is set by the Decay control **rather than how long the gate stays high**" (`drummergirl.ts:289`) | `drummergirl.dsp:76-84` is a real `en.adsr` with a **non-zero sustain on 7 of 16 shapes** (up to 0.5, `:35-37`), so the hit length genuinely *does* follow the gate for those shapes. **The def already contradicts itself** — `drummergirl.ts:77-79` says *"`en.adsr` is LEVEL-sensitive here… releases only when the gate reaches 0"*. |
| 2 | **flipper.in1** (in) | `gate` | "A toggle input: **each rising edge flips** the active output" (`flipper.ts:37`) — trigger vocabulary only | `flipper-dsp.ts:30` reads the level **every sample**; `:38` drops both outputs on the FALL; `:39` relays the held level at full width. The edge only *selects* the route. |
| 3 | **flipper.in2** (in) | `gate` | "A second toggle input: **each rising edge advances** the same FLIP/FLOP alternation" (`flipper.ts:38`) | same seam — `in2` enters the same `combined` OR (`flipper-dsp.ts:29-30`) |
| 4 | **moog961.s_in** (in) | `gate` | "**A trigger input** (the 'S' format): it passes straight through" (`moog961.ts:74-75`) | `trigger-convert-dsp.ts:108,116` + the in-source comment `:110-112`: *"driven HIGH **while the external S-trigger is held**… we **mirror the s_in gate for its full width** (duration-matched, like FLIPPER)"* |
| 5 | **moog961.v_out1** (out) | `gate` | "**A trigger output** fired by either the audio level detector… or the s_in pass-through" (`moog961.ts:82`) | `trigger-convert-dsp.ts:115-116` — high for the full width of a held `s_in`; the audio branch adds only a single-sample tick |
| 6 | **moog961.v_out2** (out) | `gate` | "The second **V trigger output**" (`moog961.ts:83`) | `trigger-convert-dsp.ts:117` `const vOut2 = vTrig;` — identical to v_out1 |

**Pattern worth naming:** 5 of the 6 are the *same shape* — a module whose
DECISION is edge-driven but whose SIGNAL PATH is width-preserving. The author
documented the decision and the contract needs the signal path. FLIPPER and
MOOG961 are explicitly cross-referenced in each other's source ("duration-matched,
like FLIPPER"), so they are one finding, not three.

### 4.2 Ports where the DSP suggests the CONSUMER may be wrong (owner decisions — NOT for Phase 1)

Per the plan §3 note, these are classified by what the code does; nobody should
change a consumer in Phase 1.

1. **`drummergirl.gate` — the docs describe a module the DSP is not.** This is
   the one place where a user-visible behaviour is genuinely in question, not
   just a wording choice. On the 7 shapes with `sustainOf > 0`, a *held* gate
   sustains the drum indefinitely; the authored prose promises it cannot. Either
   the prose is wrong (declare `gate`, fix the prose — what this table does) or
   the DSP should force `sustain = 0` for a true one-shot drum voice. **The
   second is a behaviour change and needs the owner.** Note `drummergirl.ts:212`
   also marks the gate `generator` "ON PURPOSE", so this has been thought about
   before.

2. **`vfpgaRunner.g1..g4` — the semantic is genuinely per-loaded-spec.** The host
   publishes *both* the held level and the edge count (`vfpga-runner.ts:420-421`)
   and lets the loaded FPGA spec's gate-role pick. **No single `edge` value is
   correct for all specs.** This table declares `gate` because the host itself
   always maintains held state, so `gate` never lies — but the honest answer is
   that `PortDef.edge` cannot express "depends on the loaded program". If the
   owner wants this exact, the options are a third semantic or a per-spec
   override; both are out of scope here.

3. **`writeseq.gate` (in) is genuinely dual and BOTH halves are load-bearing.**
   It feeds a rising-edge count (`:511`, `:533-541` — quantize-record and
   record-start) *and* a held-level read (`:757` → `:840-842` — live passthrough
   that overrides the sequenced output). Declared `gate` because the level read
   changes the audible output; the edge half is real and undocumented by the
   declaration. No bug, but the one-field contract loses information here.

4. **`moog993` (all 5) — the DSP is a WIRE.** `moog993.ts:9-13` is explicit:
   *"PASSIVE ROUTING — no DSP. Pure Web Audio graph (GainNodes only)."* Nothing
   in the module edge-detects or level-interprets, so **the DSP cannot settle
   these five and the classification rests on the unanimous prose plus the
   modelled hardware.** Declaring `trigger` means the generated sentence will
   read *"fires once per rising edge"* for a jack that in fact relays whatever
   width arrives. That is the least-wrong option, but it is a judgement, and it
   is the one place in this table where a reviewer could reasonably choose
   differently. **Flagged for the owner's eye during the table review.**

5. **`marbles.clk` is a 50 %-duty square, not a narrow pulse**
   (`marbles.ts:155` `clk[i] = masterPhase < 0.5 ? 1 : 0`). Declared `trigger`
   because it is a master clock and the repo vocabulary lists "clock" under
   trigger — but its waveform is the "held-square" shape `gate-trigger.ts`
   associates with a gate. Purely cosmetic (glyph + doc sentence); no behaviour
   depends on it.

### 4.3 Could not determine — **NONE**

Every one of the 276 pairs has a decision and a cited consumer. The four
"neither settles it" ports the plan anticipated turned out to be the five
`moog993` ports, and those are resolved above with the DSP's neutrality stated
explicitly rather than hidden.

### 4.4 ⚠ PHASE-1 BLOCKER — exactly **10** declarations will FAIL the vocabulary lint

`module-docs-lint.test.ts:273-278` requires a declared port's prose to contain
at least one word from its own vocabulary list (`:111-118`):

```
TRIGGER_VOCAB = rising edge, once, trigger, clock, reset, strike, sync,
                pulse, advance, restart, step, tick, fires
GATE_VOCAB    = while, held, hold, sustain, level, high, open, as long as,
                gate stays, note-on, note on, down
```

Note that the bare word **"gate" is NOT in `GATE_VOCAB`** — so prose that calls
a port "a gate" without also saying *while / held / high / level* does **not**
satisfy a `gate` declaration.

**This set was computed mechanically, not estimated:** the predicate above was
run verbatim against the LIVE prose in `module-docs.generated.ts` (which resolves
loop-generated docs correctly) for all 284 port-declarations this table proposes.
Result — **10 failures, all `gate`, 0 `trigger`:**

| # | declaration | the prose, and what it is missing |
|---|---|---|
| 1 | `flipper.in1` (in) | *"A toggle input: each rising edge flips the active output from FLIP to FLOP or back…"* — pure trigger vocabulary. Also a CONTRADICTION row. |
| 2 | `flipper.in2` (in) | *"A second toggle input: each rising edge advances the same FLIP/FLOP alternation as IN 1…"* — same. Also a CONTRADICTION row. |
| 3 | `kria.gate2` (out) | *"Track 2's gate, shaped by track 2's duration, probability and ratchet lanes."* — the word "gate" alone does not count; `gate1`'s longer prose ("how wide it **stays high**") passes, so **only the three short siblings fail**. |
| 4 | `kria.gate3` (out) | same shape as `gate2` |
| 5 | `kria.gate4` (out) | same shape as `gate2` |
| 6 | `marbles.t1` (out) | *"First random gate from the T section, **firing** per the selected model's logic…Patch into a drum/envelope **trigger**."* — reads as a trigger, is a variable-width gate |
| 7 | `marbles.t2` (out) | *"Second random gate from the T section — complementary or independent of t1…"* — no gate vocabulary at all |
| 8 | `moog961.s_in` (in) | *"A trigger input (the 'S' format): it passes straight through…"* — also a CONTRADICTION row |
| 9 | `moog961.s_out_b` (out) | *"A fixed-width one-shot: each rising edge on v_in_b emits a pulse of exactly SWITCH-ON TIME seconds here, so you can standardize ragged triggers to a known **gate length**."* — "gate length" ≠ `gate stays`, so it misses |
| 10 | `moog961.v_out2` (out) | *"The second V trigger output, fired by the same sources as v_out1…"* — also a CONTRADICTION row |

**Phase 1 must edit those 10 prose strings in the same commit as the
declaration**, or the lint goes red on its own change. Four of them
(`flipper.in1/in2`, `moog961.s_in/v_out2`) are already on the CONTRADICTION list
and were going to be rewritten anyway — so the *extra* prose work is the six
`kria`/`marbles`/`moog961.s_out_b` rows, where the semantic is right and only the
wording is thin.

⚠ Note the asymmetry this exposes: **`kria.gate1` passes and `gate2/3/4` fail on
the same semantic**, purely because the first sibling got the long sentence and
the rest got the short one. That is a property of the vocabulary check, not of
the ports.

### 4.5 Scope notes for Phase 1

- **Loop-generated docs — this bit me during Phase 0, it will bite Phase 1.**
  `synesthesia` (`:239-240`, inside a `docs: (() => {…})()` IIFE), `twotracks`
  (`:302-304`) and `wavesculpt` (`:898`) build their `docs` entries in a loop. A
  per-port `docs.outputs.<id>` grep finds **nothing** and reads as "this module
  has no prose" — I initially recorded all 16 synesthesia ports as DSP-ONLY on
  exactly that mistake, and the generated artifact caught it. **Resolve prose
  through `module-docs.generated.ts`, never through a source grep**, and
  remember one template edit moves N ports.
- **Ports that are BOTH an input and an output.** `cartesian.clock`,
  `drumseqz.clock`, `macseq.clock`, `polyseqz.clock`, `score.clock`,
  `sequencer.clock`, `writeseq.clock` and `writeseq.gate` each appear once in
  the ledger but are **two `PortDef`s**. Phase 1 must declare `edge` on **both**,
  and `writeseq.gate` is the one case where they are the same value (`gate`)
  for different reasons. That is **8 extra declarations beyond 276.**
- **Every one of the 284 declarations has live prose** — the vocabulary clause's
  `if (!desc) continue;` escape (`module-docs-lint.test.ts:272`) fires for
  **zero** of them, so nothing gets a free pass.
- `macrooscillator.trig` is also being declared by **open PR #1432** — coordinate
  or accept the conflict on that one line.

---

## 5 · SUMMARY

### 5.1 The split

Counted **per ledger pair** (the 276 `(module, port)` entries in
`UNDECLARED_EDGE_DEBT`). The table has **277 rows** because `writeseq.gate` is
listed twice — it is an INPUT *and* an OUTPUT with different evidence, and the
ledger dedupes by `(module, portId)`.

| confidence | pairs |
|---|---|
| **CLEAR** | **266** |
| **DSP-ONLY** | **4** (vfpgaRunner g1–g4 — prose declines to choose) |
| **CONTRADICTION** | **6** (drummergirl ×1, flipper ×2, moog961 ×3) |
| **total** | **276** |

| edge | pairs (276) | table rows (277) |
|---|---|---|
| **trigger** | **195** | 195 |
| **gate** | **81** | 82 |

(The one-row difference is the `writeseq.gate` in/out split; both halves are
`gate`.)

**Every number above is machine-computed from this file's own §3 rows, checked
against `UNDECLARED_EDGE_DEBT`: 0 missing, 0 extra, 0 unintended duplicates, and
the §5.2 per-module rows reconcile to the same totals.** (An earlier hand-typed
total in this section read 194/82 and was wrong by one in each column — which is
precisely the "a typed number in a shared file is a merge hazard" lesson the
parent plan's §7 is about. Phase 1 should re-derive rather than copy.)

### 5.2 Per-module counts (alphabetical — Phase 1's work list)

| module | pairs | trigger | gate |
|---|---|---|---|
| buggles | 3 | 3 | 0 |
| cartesian | 3 | 2 | 1 |
| clipplayer | 8 | 0 | 8 |
| clouds | 1 | 1 | 0 |
| cube | 1 | 0 | 1 |
| doom | 29 | 29 | 0 |
| drummergirl | 1 | 0 | 1 |
| drumseqz | 11 | 7 | 4 |
| flipper | 4 | 0 | 4 |
| fourplexer | 4 | 4 | 0 |
| frogger | 8 | 8 | 0 |
| gamepad | 12 | 0 | 12 |
| gibribbon | 11 | 10 | 1 |
| illogic | 4 | 0 | 4 |
| kria | 4 | 0 | 4 |
| macrooscillator | 1 | 1 | 0 |
| macseq | 15 | 14 | 1 |
| marbles | 3 | 1 | 2 |
| midiCvBuddy | 1 | 0 | 1 |
| midiLane | 2 | 1 | 1 |
| midiOutBuddy | 1 | 0 | 1 |
| midiclock | 3 | 3 | 0 |
| modtris | 7 | 7 | 0 |
| moog911 | 1 | 0 | 1 |
| moog911a | 4 | 4 | 0 |
| moog912 | 1 | 0 | 1 |
| moog956 | 1 | 0 | 1 |
| moog960 | 4 | 4 | 0 |
| moog961 | 7 | 1 | 6 |
| moog962 | 1 | 1 | 0 |
| moog993 | 5 | 5 | 0 |
| nibbles | 3 | 3 | 0 |
| numpadPlus | 5 | 1 | 4 |
| outlines | 2 | 1 | 1 |
| picturebox | 1 | 1 | 0 |
| polyseqz | 8 | 7 | 1 |
| pong | 2 | 2 | 0 |
| qbrt | 1 | 1 | 0 |
| rings | 1 | 1 | 0 |
| sampleHold | 1 | 1 | 0 |
| samsloop | 1 | 1 | 0 |
| score | 8 | 7 | 1 |
| sequencer | 15 | 14 | 1 |
| shapegen | 1 | 1 | 0 |
| skifree | 1 | 1 | 0 |
| slewSwitch | 3 | 3 | 0 |
| synesthesia | 16 | 8 | 8 |
| timelorde | 16 | 16 | 0 |
| twotracks | 6 | 6 | 0 |
| vfpgaRunner | 4 | 0 | 4 |
| videobox | 1 | 1 | 0 |
| videovarispeed | 5 | 5 | 0 |
| wavecel | 1 | 0 | 1 |
| wavesculpt | 4 | 0 | 4 |
| writeseq | 9 | 8 | 1 |
| **55 modules** | **276** | **195** | **81** |
