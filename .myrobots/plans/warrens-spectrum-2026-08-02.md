# Warren's Spectrum — kill two modules, ship one

**Date:** 2026-08-02 · **Status:** PLAN (docs-only; no code in this PR)
**Owner directive, verbatim:**

> "for callsine yes we need to do the rewrite as the vst. but also look at our warren's
> spectrum module. i want to get rid of our existing warren's spectrum and callsine modules,
> and have a single module called Warren's Spectrum that is a 1:1 copy of the callsine vst"

> "i think we want to completely kill the existing warren's spectrum module, i believe this
> will be a total rewrite"

Both existing modules are DELETED. One new module — **Warren's Spectrum** — is built from the
`../callsine` VST. Total rewrite, not a merge.

**Supersedes PR #1295** (`.myrobots/plans/callsine-rectification-2026-08-02.md`), which planned
*incremental* improvements to `callsine` — a module this plan deletes. Its VST signal-path
analysis was verified accurate and is folded in here: the digit-for-digit port evidence (§0.3),
the `setSliceMs` clamp (§3.2.1), and the two optimisations that measured **negative** (§4.5).
Its two errors are corrected rather than inherited: the claimed ART "harness hole" (§8.1) and
the "% of one core" CPU framing (§4.2).

**Revised 2026-08-02 after an adversarial review** that found three critical defects. Each is
corrected **in place, with the wrong version quoted**, so the reasoning that produced it stays
visible: §1.1 (a false "no precedent" claim — there are 18 deletions and 2 renames), §1.3 (the
migration's central argument, which delivered **zero** for one of the two modules it covered),
and §2 (a deletion list that missed five red gates and named two ratchets that do not move).

---

## 0. Corrections to the brief — read these first

Three load-bearing premises in the task brief are wrong. Each was re-verified against source.

### 0.1 The VST has **104** runtime parameters, not 49

`49` is the number of `layout.add(...)` **call sites** in `PluginParams.h`. Seven of them are
inside `for (int i = 0; i < 8; ++i)` (the filterbank, `PluginParams.h:241-299`) and six inside
`for (int s = 1; s <= 2; ++s)` (the FX slots, `:334-365`). Expanded:

| group | call sites | runtime params |
|---|---:|---:|
| Master output (`gain`) | 1 | 1 |
| Filterbank dry/wet routing (`inputMix`, `resynthLevel`) | 2 | 2 |
| Spectral engine | 15 | 15 |
| **8-band resonant filterbank** (×8) | 7 | **56** |
| Feedback loop | 5 | 5 |
| **Two FX slots** (×2) | 6 | **12** |
| Wavetable insert | 9 | 9 |
| Global master filter | 4 | 4 |
| **TOTAL** | **49** | **104** |

The brief's parameter list omits the filterbank and the FX slots **entirely** — i.e. it omits
68 of the 104 params, including the subsystem (`FilterBank`) that every drop of audio passes
through. Any face/phasing plan built on "49 params" is sized for a different plugin.

*(Verified by brace-depth expansion of `PluginParams.h`. My first two attempts at this script
both returned 49 because the loop-scope flag reset one line early — the `for` line carries no
brace. Stated because a wrong count here reads exactly like a right one.)*

### 0.2 There is a **third** engine mode: MASSPASS

The brief lists `Mode` without its values. `engineMode` is a 3-way choice —
`{ "SPECTRAL", "WAVETABLE", "MASSPASS" }` (`PluginParams.h:126`) — and MASSPASS is a whole
separate 326-line DSP class (`dsp/MassPass.cpp`) with its own band-count parameter
(16/24/33/48/66/99). It is the plugin's most recent work: phases 39-42, four of the last six
commits (`ec707d3`, `99128d1`, `0c7f8a6`, `88f4886`). A plan that ships "the spectral engine"
ships one of three.

### 0.3 Our `callsine` does **not** share "nothing" with the VST — it shares the CORE ALGORITHM

The brief says our `callsine` is "a Plaits-style MACRO-OSCILLATOR, sharing NOTHING with the
VST." Its *control surface* is Plaits-style. Its *engine* is a direct port of the VST's
`SpectralResynth`:

| stage | VST `dsp/SpectralResynth.cpp` | our `packages/dsp/src/callsine.ts` |
|---|---|---|
| window | Hann, precomputed | Hann, precomputed (`:78-81`) |
| FFT | `juce::dsp::FFT`, order 11 → **2048** | hand-rolled radix-2, **1024** (`:62`, `:109-118`) |
| hop | `fftSize/4` = 512, Slice-overridable | `FFT_SIZE/4` = **256**, fixed (`:64`) |
| peak detect | parabolic interp in log-mag (`:474-486`) | same |
| F0 | harmonic sum, 60–800 Hz, 8 harmonics (`:244-246`) | same, `F0_LO_HZ 60` / `F0_HI_HZ 800` / `F0_MAX_HARMONICS 8` (`:71-73`) |
| tracking | McAulay-Quatieri-lite, 5 % rel tolerance (`:226`) | same (`callsine.ts:11-12`) |
| bank | up to **892** partials | up to **64** (`N_TRACKS`, `:65`) |

`packages/dsp/src/callsine.ts:5` says so outright: *"Algorithmic port of Warren's Spectrum
(a.k.a. CallSine), MIT-licensed."* And `oss-attribution.test.ts:55` already credits
`"callsine contributors (Warren's Spectrum)"`.

**And it is not "two implementations of a known algorithm" — the same ARBITRARY choices are
carried across digit for digit** (salvaged from the superseded #1295, re-verified):

| | VST | ours |
|---|---|---|
| MQ match tolerance | `kMatchTolerance = 0.05f` | `bestDist = 0.05` |
| Nyquist alias ramp | `nyquist*0.85` / `nyquist*0.75` | the same two literals |
| F0 band / harmonics / weighting | 60-800 Hz, k=1..8, `1/√k` | identical |
| Peak interpolation | parabolic in **log** magnitude | identical |
| Amplitude scale | Hann coherent gain `4/N` | identical |

⚠ **Why this was missed twice.** The original assessment compared **parameter names** and
concluded "zero overlap". A name diff is **invariant to the algorithm underneath**, so it
returns a confident, plausible, false answer for a faithful port that renamed its knobs — the
exact failure class CLAUDE.md's *VALIDATE THE INSTRUMENT* section describes. The 30-second
negative control was: open the worklet and look for an FFT.

**Why this matters for the plan, in both directions:**
- It is *good* news for feasibility: the hardest half (a real-time STFT partial tracker in an
  AudioWorklet) is **already shipped and tested in this repo**. This is not a green-field port.
- It is *bad* news for the "1:1 copy" framing: our port is the VST's engine with 15 spectral
  params collapsed into 4 macros, a 4× smaller FFT and a 14× smaller bank. The gap to 1:1 is
  large, and it is mostly **the 68 params the brief omitted** plus the two other engines.

### 0.4 The VST is already called Warren's Spectrum

`callsine` is only the CMake project id. `PRODUCT_NAME` is `"Warren's Spectrum 0.6 FP"`
(`CMakeLists.txt:62`), `COMPANY_NAME "Warren"` (`:52`), presets are `.wspr`, the fingerprint
type marker is `"wsp-fp"` (`Fingerprint.cpp:8`), and `README.md:1` is `# Warren's Spectrum`.
So the owner's naming instruction is a *restoration*, not a rename: the module takes the name
the plugin already has. Nothing in the VST needs renaming to match.

---

## 1. THE MIGRATION — this is the part that destroys user data

**Lead with this because it is irreversible and currently silent.**

### 1.1 What this repo actually does today — the precedent, corrected

> **CORRECTION (adversarial review, 2026-08-02).** An earlier draft of this section asserted
> *"there is no precedent for renaming or replacing a node type, and no hook to add one to."*
> **Both halves are false.** There are **18 deleted types** across two commits, **two renamed
> types**, and the hook existed under the name `LEGACY_TYPE_ALIASES` until four weeks ago —
> when this repo deliberately deleted it. Asserting a blank slate is what let §1.3 propose a
> mechanism the repo had already built, used, and retired. The record below is what actually
> happened, and it changes the recommendation.

**A. Deleting a shipped node type — 18 precedents, and the resolution is already written down.**

| commit | PR | types deleted |
|---|---|---|
| `71235f093` | #1013 | `helm`, `polyhelm`, `hydrogen` (3) |
| `537ed4b14` | #1033 | `chowkick`, `riotgirls`, `scenechange`, `grids`, `negativity`, `peaks`, `stages`, `symbiote`, `veils`, `warps`, `aquatank`, `elements`, `tides2`, `qbert`, `snes9x` (15) |

#1033's commit message states the resolution verbatim:

> "Old patches containing a deleted type degrade gracefully: persistence `loadEnvelope` skips
> unknown types with a `LoadDiagnostic` and drops their edges (covered by
> `persistence.test.ts`)."

That is the repo's **declared** answer to "what happens to a user's rack?", and it has been
exercised 18 times. #1013's message doubles as the **deletion checklist** — see §2, which is
now re-derived from it rather than from a grep the author happened to think of.

**B. Renaming a shipped node type — two precedents, both with a real alias hook.**

`ruttetra → reshaper` and `circles → outlines`. The mechanism lived in the **video** registry:
`LEGACY_TYPE_ALIASES` + a `getVideoModuleDef` legacy fallback + `canonicalizeVideoType()`,
which the persistence load loop called to **rewrite `node.type` in place**, so a re-save
persisted the canonical id. Its comment (recovered from `git show 8cfb7897`) is almost
word-for-word the argument §1.3 was about to make from scratch:

> "RUNTIME type aliases for RENAMED modules. When a module type is renamed we register it
> under the NEW id only (one def, one palette entry), but nodes saved before the rename — in a
> user's localStorage, a live collab Y.Doc, or a hand-exported .json — still carry the OLD type
> string. **Without a remap the patch loader can't resolve the def and drops the node to a
> placeholder error card, LOSING that node's wiring + params.**"

**C. …and this repo DELETED that hook on 2026-07-05** — `8cfb7897` (in `68ff41386` / #1027),
"cleanup 4/5". Its stated reason:

> "`canonicalizeVideoType` rewrote `node.type` in place on load, so a new save already persists
> the canonical `outlines` — a new patch never carried `circles`. A pre-#699 `circles` node now
> drops to a placeholder error card."

So the alias was **designed with a finite life**: it exists to convert live patches, and once
they have been re-saved it is retired and the drop path resumes. That is the shape any new
alias must take, and it is a strictly stronger version of the "grace period" §1.3 proposed by
guesswork.

**D. The condition both precedents satisfied, and which decides §1.3.**

⚠ **Both renames aliased a type onto an IDENTICAL contract.** #1027's own message:

> "the node's ports `z`/`xDisp`/`yDisp`/`out` + params `intensity`/`xDisp`/`yDisp` already
> match `reshaperDef`, **since ruttetra-v1 IS today's reshaper**"

and for the other, the def was literally shared: `export const circlesDef = outlinesDef`.
Neither precedent ever aliased a type onto a **different** contract. The repo has renamed
identities; it has never re-pointed one instrument at another. **That is the test §1.3 must
pass**, and §1.3 applies it below — with the port tables that were missing.

**E. What is genuinely gone: the per-module `schemaVersion` substrate.** This part of the
earlier draft stands. `persistence.ts:13-15`:

> "The per-module `schemaVersion` / `moduleSchemas` migration substrate was collapsed in the
> schema cleanup (envelope v2) — a patch now stores TOPOLOGY + authored / sequenced values
> only, and **is never reshaped on load**."

`schema-cleanup-roundtrip-golden.test.ts:16` keeps it collapsed. So **value reshaping** has no
hook and re-opening it is off the table. **Type aliasing is a different, shallower thing** —
it never needed `schemaVersion` (the video alias didn't use it) — and conflating the two is
what produced the false "no precedent" claim.

### 1.2 What happens today to a rack containing `callsine` or `warrenspectrum`

Exactly this, traced through `loadEnvelopeIntoStore` (`persistence.ts:342-449`):

1. `isKnownModuleType(node.type)` (`:31-35`) checks all three registries. After deletion both
   types resolve to `undefined` → **false**.
2. `:369-376` — the node is **silently dropped**. A `LoadDiagnostic { nodeId, type, reason:
   'module type not registered in this build' }` is pushed. The code comment reads
   `// Phase 1: skip. Future: insert placeholder error node.` — the placeholder was never built.
3. `:409-418` — **every edge touching that node is also dropped**, each with its own
   `'edge references a dropped node'` diagnostic.
4. `Canvas.svelte:2952-2954` — the diagnostics are emitted with **`console.warn`**. Nothing
   else. No toast, no modal, no banner, no count in the UI.

**Net user-visible behaviour: the modules and all their cables vanish, the rack loads
"successfully", and the only evidence is in a devtools console nobody has open.**

The blast radius is *not* limited to the two cards. `warrenspectrum` has 8 per-band sends and
8 per-band returns, so a rack using it as an insert bank loses up to **16 cables plus the
external FX chain's connectivity** — the FX modules survive as orphans, silently unpatched.

The three shipped example patches are clean (checked by decoding each envelope's Yjs update
and scanning for both type strings: `gibribbon-demo`, `glitches`, `media-burn` — all clean;
independently re-confirmed by grep across `example-patches/`, `e2e/fixtures/` and
`packages/web/static/`), so no in-repo fixture breaks. User racks are the exposure, and they
are not in the repo.

⚠ **This drop path is not a bug to be routed around — it is the repo's declared answer**, and
it has run 18 times (§1.1-A). What is missing is not the mechanism but its **visibility**
(step 4 above). §1.3 keeps the drop for `warrenspectrum` and fixes step 4 instead.

### 1.3 The decision: **ALIAS `callsine`. DROP `warrenspectrum`, loudly.**

> **CORRECTION (adversarial review, 2026-08-02).** An earlier draft aliased **both**
> predecessors onto the new type, and called the surviving-cable argument *"the single
> strongest argument for REPLACE-over-DROP"* — **without ever listing the ports that argument
> rests on.** Listed below, they say the opposite for one of the two modules: an aliased
> `warrenspectrum` keeps **zero** of its 43 cables. The claim was not merely unsupported; the
> data inverts it. The port table is now the first thing in this section, and the decision is
> split.

#### 1.3.1 The port tables (from `contract-lock.txt` — the pinned contract, not memory)

**`warrenspectrum` — 43 ports (32 in / 11 out)**, `contract-lock.txt:3623-3684`:

| dir | ports | n |
|---|---|---:|
| in | `in_l` `in_r` | 2 |
| in | `band1_in` … `band8_in` | 8 |
| in | `ping1` … `ping8` | 8 |
| in | `global_ping` | 1 |
| in | `level1_cv` … `level8_cv` | 8 |
| in | `viznoise_cv` `root_cv` `spread_cv` `q_cv` `decay_cv` | 5 |
| out | `out_l` `out_r` | 2 |
| out | `band1_out` … `band8_out` | 8 |
| out | `viz_out` (**mono-video**) | 1 |
| | plus `stereo in_l+in_r` / `stereo out_l+out_r` pair declarations | |

**`callsine` — 10 ports (9 in / 1 out)**, `contract-lock.txt:343-353`:

`audio_in`(audio) `pitch`(pitch) `gate`(gate) `model_cv` `note_cv` `harm_cv` `timb_cv`
`morph_cv` `level_cv` → `out`(audio)

**The new module, phase 1** is **MONO** (§3.1, §6) and is an **analysis effect**, so its
contract is `audio_in` → `out` plus FREEZE and a CV port per spectral param.

#### 1.3.2 Edge survival, per predecessor — the number the argument needed

An edge survives iff **both** endpoints resolve and `validateEdge` (`persistence.ts:429-437`)
finds the saved `portId` on the new def. So survival is decided **port id by port id**:

| predecessor | ports | survive on the phase-1 contract | why |
|---|---:|---:|---|
| **`warrenspectrum`** | 43 | **0** | Phase 1 is MONO, so `in_l`/`in_r`/`out_l`/`out_r` **cannot exist**. There is no filterbank until phase 2, so no `band*_in`/`band*_out`. There is no ping model at all, so no `ping*`/`global_ping`. Every CV port names a param (`level1..8`, `root`, `q`, `spread`, `viznoise`, `ping_decay`) that has no counterpart. `viz_out` is **mono-video** — the new module has no video domain. |
| **`callsine`** | 10 | **4** | `audio_in`, `pitch`, `gate`, `out` — **and all four map to the SAME function on both sides**, not merely the same string (next table). The 6 that die are exactly the Plaits macro CVs (`model/note/harm/timb/morph/level`), which have no meaning in a spectral contract. |

**Why the four `callsine` survivors are semantically honest, not a string coincidence:**

| port | callsine today | Warren's Spectrum | verdict |
|---|---|---|---|
| `audio_in` | "Audio under analysis. Mono." (`callsine.ts:536-537`) | audio under analysis, mono | identical |
| `pitch` | "V/oct → transposes the entire resynth output post-analysis" (`:538-539`) | `spectralCenter`, the post-analysis transpose (§3.2) | identical function |
| `gate` | "Rising edge TOGGLES the FREEZE latch (mirrors CallSine's FREEZE button)" (`:540-541`) | FREEZE (§3.2) | identical function |
| `out` | resynth output | resynth output | identical |

**This makes the port ids a load-bearing design constraint, not an afterthought.** The new def
**must** name these four `audio_in` / `pitch` / `gate` / `out`. If a later draft renames them,
the alias delivers nothing and must be dropped along with `warrenspectrum`. §3.5's
fingerprint-interchange argument constrains **param** ids (the `.wspr` JSON is keyed on
`RangedAudioParameter` ids); it says nothing about port ids, so there is no conflict.

#### 1.3.3 Why `warrenspectrum` is DROPPED, and why that is the *safer* option

Aliasing it would produce a node that is **present and plausible while being an entirely
different instrument**:

- **0 of 43 cables survive** — the node lands fully unpatched, including the 16 send/return
  cables of an insert-bank rack, whose external FX chain is orphaned either way.
- **0 of 16 params survive** — every one resets.
- **The rack geometry changes underneath it**: `rack-sizes.ts:144` gives `warrenspectrum`
  **3u / 3hp** (481×440 px); the new module is sized like `callsine`'s **1u / 2hp** (196×340,
  `:36`). The replacement is ~⅕ the area, so the surrounding rack layout shifts too.
- **It is not the same class of DSP.** §2.5: `warrenspectrum` is a stereo 8-band vactrol-ping
  resonator bank — much closer to the VST's `FilterBank` than to its `SpectralResynth`.

So an aliased `warrenspectrum` node = same id, same position, **nothing else** — a card
wearing the old node's identity with none of its behaviour, patching, or size. This plan
already rejects the weaker version of that move: *"Silently reinterpreting `morph` as
something else would be worse than resetting."* The same logic, applied one level up,
condemns silently reinterpreting a whole module. **A dropped node is visibly absent and the
user knows to rebuild. A silently-migrated one lies.**

It also fails §1.1's test **D**: both repo rename precedents aliased onto an *identical*
contract. `warrenspectrum → warrensspectrum` shares **zero** ports and **zero** params. It is
not a rename; it is a deletion wearing a rename's clothes. `callsine → warrensspectrum` is a
weaker case than the precedents but a real one — same engine family (§0.3), 4 ports with
matching semantics.

#### 1.3.4 The mechanism — one entry, not two

```ts
/** RETIRED module types → the type that replaces them. Consulted ONCE, at load,
 *  before the unknown-type drop. NOT a general migration substrate: no value
 *  reshaping, no per-module hooks, no schemaVersion — this is the shallow
 *  TYPE-only aliasing the video registry carried as LEGACY_TYPE_ALIASES until
 *  #1027 retired it (see §1.1), re-introduced with the same finite life.
 *
 *  `warrenspectrum` is deliberately ABSENT: it shares 0 of its 43 ports and 0
 *  of its 16 params with this contract, so an aliased node would keep no cable
 *  and no value — a different instrument wearing the old node's id. It takes
 *  the ordinary unknown-type drop path (#1033), which is VISIBLE (§1.3.5).
 *
 *  REMOVAL CONDITION: drop this table two minor releases after ship, at which
 *  point live patches have been re-saved under the canonical id and the drop
 *  path handles the stragglers — exactly the argument #1027 used to retire the
 *  video aliases. */
const RETIRED_TYPE_ALIASES: Readonly<Record<string, string>> = {
  callsine: 'warrensspectrum',
};
```

**Semantics, stated precisely because each clause is testable:**

- **The node survives, at its saved position, with its saved id.** Position and id are the
  parts a user cannot reconstruct.
- **`params` are dropped, not mapped.** `callsine`'s `model/note/harmonics/timbre/morph/level`
  are Plaits macros over the spectral engine; none is a spectral quantity. The node loads at
  the new module's defaults.
- **Edges are re-validated, not blanket-dropped** — existing machinery (`validateEdge`,
  `:429-437`), which the alias changes nothing about. Expected survival: the 4 ports above.
- **A distinct diagnostic per migrated node.** Not the generic "controls reset": ⚠ **callsine
  declares `chainWiring: { role: 'source' }`** (`callsine.ts:533`) — it is used as a *voice*
  (pitch + gate in, tone out), while the new module is an *effect* that resynthesises whatever
  is patched into `audio_in`. **A migrated node with nothing patched into `audio_in` is
  silent.** The diagnostic must say so —
  `'migrated from callsine; Warren\'s Spectrum ANALYSES audio — patch a source into audio_in'`
  — because "it's there and it makes no sound" is the one failure this migration can still
  produce, and it is the failure a user is least likely to diagnose.

#### 1.3.5 The DROP path must become VISIBLE — this is the real deliverable

The alias is ~10 LOC for one module. **The load-diagnostic UI is the change that matters**,
and it is worth more than the alias: today `Canvas.svelte:2952-2954` emits every diagnostic
through `console.warn` and nothing else, so **all 18 previously-deleted types degrade
"gracefully" into a rack that silently lost nodes and cables.** #1033 promised graceful
degradation and delivered it *in the loader*; the user-facing half was never built.

**`Canvas.svelte` must surface a non-blocking summary on any load with non-empty
diagnostics** — counts by reason, naming the types: *"1 module migrated to Warren's Spectrum
(controls reset); 1 `warrenspectrum` module could not be loaded and 16 cables were removed."*
That single change makes the DROP honest, which is the whole reason dropping
`warrenspectrum` is acceptable. **Ship it in the same PR as the deletion, or the deletion is
silent data loss with a plan attached.**

### 1.4 Testability — with a REAL saved-rack fixture

The seam already has a test to extend: `persistence.test.ts:302` —
`'drops nodes whose module type is not registered, plus edges referencing them'`.

**Fixture, generated once and committed** (`packages/web/src/lib/graph/__fixtures__/retired-warrenspectrum.imp.json`):
a v2 envelope built on a branch where both modules still exist, containing —

- one `callsine` node with non-default params, cabled on **all four surviving ports**
  (`audio_in`, `pitch`, `gate`, `out`) **and** on two that must die (`morph_cv`, `note_cv`),
- one `warrenspectrum` node with two band send/return pairs patched through a `delay` — the
  **DROP** leg,
- one unrelated module (`vco`) that must survive **untouched** — the negative control for
  "the migration didn't just eat the graph".

**Assertions — the two legs assert OPPOSITE outcomes, which is the point:**

*ALIAS leg (`callsine`):*

1. The node is present after load, with its **original id and position**.
2. `type === 'warrensspectrum'`.
3. Params equal the new module's **defaults** — asserted against `warrensSpectrumDef.params`,
   never against literals, so a default change cannot silently pass.
4. Edge survival asserted **per edge by port id**, never by count: the `audio_in` / `pitch` /
   `gate` / `out` edges are **present**; the `morph_cv` / `note_cv` edges are **absent** and
   each carries its own `invalid edge dropped` diagnostic.
5. One diagnostic naming `callsine`, carrying the **analyses-audio** wording from §1.3.4.

*DROP leg (`warrenspectrum`):*

6. The node is **ABSENT** — `keptNodes` has no entry for its id.
7. One `'module type not registered in this build'` diagnostic naming `warrenspectrum`.
8. **All** of its edges are absent, each with an `'edge references a dropped node'`
   diagnostic — count asserted exactly, so a future accidental alias entry flips this red.

*Shared:*

9. The `vco` node and its edges are **byte-identical** to pre-load.

**The negative control this test needs**, in both directions — the review's lesson is that a
gate reading one side of a two-sided contract proves nothing about the other:

- **Empty `RETIRED_TYPE_ALIASES`** → assertions 1-5 must go red, *specifically assertion 1, on
  node presence*. If they stay green, the fixture never contained a `callsine` node and the
  alias leg proves nothing.
- **Add `warrenspectrum` to the table** → assertions 6-8 must go red. Without this leg the
  drop is only ever asserted by the absence of a table entry, and "we chose not to alias it"
  would silently become "someone aliased it and nothing noticed". Assertion 8's exact count is
  what makes that visible.

Run both, watch them fail, restore, and record the verbatim failures in the PR.

⚠ **What this test cannot cover:** the fixture is generated on a branch where the old modules
exist and is then frozen. It proves the *loader* handles a retired type; it does **not** prove
the fixture resembles any real user's rack. That gap is unclosable in-repo and should be
stated rather than papered over.

---

## 2. WHAT IS BEING DELETED — the exhaustive list

> **CORRECTION (adversarial review, 2026-08-02).** An earlier draft of this section called
> itself exhaustive on the strength of a grep the author thought to run. It **missed at least
> five gates that go red on merge**, and it named **the wrong two ratchets**. The list below is
> re-derived from **#1013's commit message as the checklist** (§1.1-A — it enumerates the
> categories a module deletion touches, because someone already did this twice) and every row
> re-verified by grep + by *reading the assertion*, not by recognising a filename.
>
> **What the earlier draft missed** — recorded so the next deletion inherits the checklist,
> not the blind spot:
>
> | missed | why it goes red |
> |---|---|
> | `packages/web/src/lib/graph/patch-convenience-columns.test.ts:159` | `'callsine'` sits in the live `DECLARED_SOURCES` array and the test does `expect(d, \`${t} not found\`).toBeDefined()` then derefs `d!` — **guaranteed red**, and it was invisible because the file's name suggests routing, not a module list. |
> | `packages/web/src/lib/ui/rack-sizing.test.ts:169-173` | a **stale-key** gate: every `RACK_SIZE_DEFAULTS` key must be a registered module. The draft listed `rack-sizes.ts` as an edit but never said *why it is mandatory*. |
> | `packages/web/src/lib/docs/module-docs-lint.test.ts:258-273` | `STRICT_DOCS.size >= 172`. Removing two entries → 170 → red. **The draft named no docs ratchet at all.** |
> | `art/scenarios/_meta/audio-profile-gate.test.ts:96-112` | `ART_BACKLOG_MAX` must equal `ART_BACKLOG.length` **exactly**; and `:113-117` rejects backlog ids absent from the (re-pinned) contract-lock. Two ways red. |
> | `packages/web/src/lib/audio/modules/vrt-meta.test.ts:153` | "every `VRT_SCENES` key is a registered module type" — the draft listed the scene block for deletion but not the gate that forces it. |
> | `packages/web/src/lib/ui/modules-card-map.test.ts` is **two-sided** (`:291` dropped, `:316` extra) | delete the cards but keep the list rows → red; delete the defs but keep the `*Card.svelte` → red. The draft treated it as one list row. |
>
> ⚠ **And the two ratchets the draft named do not move.** It claimed `vrt-meta.test.ts`'s
> `SHARED_LINUX_PAIR_CEILING` (91) and the linux-deficit ceiling (**148**, not 91) must be
> lowered "in the same commit". **Neither does** — verified: neither id has a live
> `EXEMPT_BASELINE_PAIRS` entry (`warrenspectrum` appears there only in a *drained*-batch
> comment, `vrt-exemptions.ts:1392`), `warrenspectrum` has baselines on **both** platforms so
> deleting it removes a *covered* scene rather than a *gap*, and it is **not** in
> `STRICT_VRT_MODULES` (floor 48 unaffected). Naming a ratchet that does not move is the same
> error class as missing one that does: it makes the section *look* audited. The two that
> genuinely move are in §2.4.

Every row below was located by grep **and** confirmed by reading the assertion it would trip.

### 2.1 `callsine` — 4 files, 1,838 LOC

| path | LOC |
|---|---:|
| `packages/web/src/lib/audio/modules/callsine.ts` | 639 |
| `packages/web/src/lib/audio/modules/callsine.test.ts` | 383 |
| `packages/dsp/src/callsine.ts` | 728 |
| `packages/web/src/lib/ui/modules/CallsineCard.svelte` | 88 |

⚠ **`packages/dsp/src/callsine.ts` is the file the new module should be built FROM, not
deleted outright.** See §6. It is the only working STFT partial tracker in the repo.

### 2.2 `warrenspectrum` — 10 files, 2,428 LOC

| path | LOC |
|---|---:|
| `packages/web/src/lib/audio/modules/warrenspectrum.ts` | 479 |
| `packages/dsp/src/warrenspectrum.ts` | 437 |
| `packages/web/src/lib/audio/modules/warrenspectrum-draw.ts` | 153 |
| `packages/web/src/lib/audio/modules/warrenspectrum-draw.test.ts` | 179 |
| `packages/web/src/lib/audio/warrenspectrum-math.ts` | 185 |
| `packages/web/src/lib/audio/warrenspectrum-math.test.ts` | 262 |
| `packages/web/src/lib/ui/modules/WarrenspectrumCard.svelte` | 259 |
| `art/scenarios/warrenspectrum/warrenspectrum.test.ts` | 165 |
| `art/scenarios/warrenspectrum/ping-rings.test.ts` | 213 |
| `e2e/tests/warrenspectrum.spec.ts` | 96 |

### 2.3 Baselines

**ART:** `find art/baselines -iname '*warren*' -o -iname '*callsine*'` → **zero files**.
Neither module has a `.f32`/`.sha` golden. Both ART scenarios are **assertion-based**, not
golden-pinned (`warrenspectrum.test.ts` asserts band-3 isolation and ping ringing by FFT
magnitude ratios; `ping-rings.test.ts` asserts top-3 band ranking and bleed). **So no ART
re-pin and no `art:fingerprints:accept` is needed for the deletion** — but see §8, because it
also means the deletion destroys *no* golden and the new module starts with none.

**VRT:** exactly two PNGs, both for `warrenspectrum`:
- `e2e/vrt/__screenshots__/vrt.spec.ts/darwin/warrenspectrum.png`
- `e2e/vrt/__screenshots__/vrt.spec.ts/linux/warrenspectrum.png`

`callsine` has **no** baseline — it is exempt (`vrt-exemptions.ts:631`, *"VRT baseline
pending"*).

⚠ **Directory scope, stated because an unstated scope reads as full coverage** (CLAUDE.md's
one-directory-blindness rule, which has bitten this repo three times). The search was **not**
limited to `__screenshots__/vrt.spec.ts/`: there is exactly one `__screenshots__` root
(`e2e/vrt/__screenshots__`) containing **30** per-spec subdirs — `vrt.spec.ts`,
`workflow-shell-faces`, `vrt-toybox`, `vrt-composite`, `playhead`, `vrt-clap`,
`vrt-colourofmagic`, `vrt-quadralogical`, `workflow-rear-card`, `workflow-shell-zoom`,
`vrt-wavesculpt-blink`, `vrt-karplus-tomtom-states`, and 18 more — and **all 30 were
searched on both platforms**. Two files match, in `vrt.spec.ts/` only.

⚠ **Delete BOTH platforms together, and never hand-edit anything under
`__screenshots__/*/linux/`.** `vrt-platform-gaps.ts:94` defines a gap as *a darwin baseline
with no linux sibling* — so removing only the linux PNG manufactures an **UNDECLARED** gap and
turns `vrt-meta.test.ts` red. Removing both deletes a **covered** scene, which is a no-op for
every VRT ratchet (§2.4). A pure deletion needs **no `vrt-update.yml` dispatch** (the scene is
gone, so nothing re-renders it); the dispatch is needed only for the NEW module — see §8.

### 2.4 Registry / list / golden edits — **17 files**, each with the gate that enforces it

Ordered by consequence. "**RED**" = the unit or e2e lane fails on merge if the row is missed.

| file | what | gate if missed |
|---|---|---|
| `packages/web/src/lib/docs/contract-lock.txt` | **17** `callsine` lines (`:343-359`) + **62** `warrenspectrum` lines (`:3623-3684`) = **79**. GENERATED — never hand-edit; `task docs:accept` re-pins. | **RED** — `contract-lock.test.ts:41-64` string-compares the golden against the live registry. |
| `packages/web/src/lib/docs/strict-docs.ts` | `'callsine'` (`:167`), `'warrenspectrum'` (`:264`) + comments `:154,156,249,253` | **RED** — `module-docs-lint.test.ts:258-273`, `STRICT_DOCS.size >= 172`. **Ratchet, see below.** |
| `art/setup/profile-coverage.ts` | `'callsine'` (`:71`), `'warrenspectrum'` (`:111`) in `ART_BACKLOG` | **RED ×2** — `audio-profile-gate.test.ts:96-112` (`MAX === length`, strict) and `:113-117` (backlog ids must exist in contract-lock). **Ratchet, see below.** |
| `packages/web/src/lib/graph/patch-convenience-columns.test.ts` | `'callsine'` in `DECLARED_SOURCES` (`:159`); comments `:155,176` | **RED** — `expect(d, '… not found').toBeDefined()` then `d!`. |
| `packages/web/src/lib/ui/rack-sizes.ts` | `callsine: 1u/2hp` (`:36`), `warrenspectrum: 3u/3hp` (`:144`) | **RED** — `rack-sizing.test.ts:169-173` stale-key check. |
| `packages/web/src/lib/ui/modules-card-map.test.ts` | `EXPECTED_NODE_TYPES` — both (`:38`, `:59`) | **RED, two-sided** — `:291` (list row without a card) and `:316` (card without a def). Delete rows **and** `*Card.svelte` together. |
| `packages/web/src/lib/audio/modules/oss-attribution.test.ts` | `import { callsineDef }` (`:32`) + roster row (`:55`) | **RED** — unresolved import fails the whole file. |
| `e2e/vrt/vrt-scenes.ts` | the whole `VRT_SCENES.warrenspectrum` block (`~:618-659`) incl. the `__warrenspectrumVrtSeed` hook (`:651-652`) | **RED** — `vrt-meta.test.ts:153` "every `VRT_SCENES` key is a registered module type". |
| `packages/web/src/lib/docs/module-manifest.ts` | `DESCRIPTIONS.warrenspectrum` (`:310`), `DESCRIPTIONS.callsine` (`:366-367`) | green either way (no orphan-key check) — remove for hygiene / conflict surface. |
| `packages/web/src/lib/docs/interactive/interactive-doc-modules.ts` | `'callsine'` (`:122`) + comments `:115,162` | doc-page list. |
| `e2e/vrt/vrt-exemptions.ts` | `callsine` `EXEMPT_FROM_VRT` entry (`:631`) — **the only live entry for either id**; comments `:51,627,956,1392` | green either way (`vrt-meta.test.ts:147` only asserts the *reason* is non-empty — there is **no** ghost check on `EXEMPT_FROM_VRT` keys). Remove anyway. |
| `e2e/tests/per-module-per-port-behavioral.spec.ts` | **22** `warrenspectrum.*` exemption rows (`:1419-1440`) — 8 `level*_cv` + 8 `ping*` + `global_ping`/`root_cv`/`spread_cv`/`q_cv`/`decay_cv`/`viznoise_cv`. `callsine`: **0**. Comments `:474,1406,1418,1580`. *(An earlier draft said 24; it is 22.)* | |
| `e2e/tests/coverage-groups-6-7-8-9.spec.ts` | one whole `test()` (`:125-143`) — "warrenspectrum: stereo input → out_l emits audio" | **RED** — spawns a type that no longer exists. |
| `e2e/tests/warrenspectrum.spec.ts` | whole file (§2.2) | **RED** |
| `e2e/vrt/vrt-geom-probe.spec.ts` | the entire second test (`:247-356`), incl. `.svelte-flow__node-warrenspectrum` | **RED** |
| `e2e/tests/midi-learn.spec.ts` | **spawns a real `callsine` node** (`:126-160`, `type: 'callsine'`, `params: { level: 0.8 }`) | **RED** — ⚠ needs **repointing to another 6-fader module**, not a line delete, or the MIDI-learn fader coverage is lost. Precedent: #1013 repointed 5 fixtures from `hydrogen` to `drumseqz` rather than deleting them. |
| `e2e/tests/docs-virtual-module.spec.ts` | `callsine` doc-page fixture (`:391-397`: `controlParam: 'harmonics'`, `cvPort: 'note_cv'`); comments `:356,480` | **RED** — the doc page 404s. Repoint or delete. |
| `docs/testing/test-ledger.generated.md` | **23** rows — `callsine` 1 (`:70`), `warrenspectrum` 22 (`:322-343`). GENERATED — `task test:ledger:accept`, **never hand-merge**. | |

**Comment-only / cosmetic** (no gate, sweep for tidiness): `audio/module-registry.ts:104`,
`audio/modules/cube.ts:212`, `audio/modules/spectrograph.ts:21`,
`packages/dsp/src/lib/treeohvox-dsp.ts:358`, `graph/patch-convenience.ts:437`,
`e2e/vrt/vrt-live-surfaces.ts` (9 lines), `e2e/vrt/vrt-capture.ts:61`,
`e2e/tests/video-orientation.spec.ts:480`, `scripts/vrt-geom-audit.sh:24`,
`e2e/MODULE-COVERAGE-PLAN.md`, and **`e2e/vrt/build_gallery.py:92`** (an orphan gallery
description string — no gate, easy to leave behind).
*(False positive to ignore: `packages/web/native/doomgeneric/.../d_englsh.h:167` —
`"E3M9: Warrens"` is a DOOM level name.)*

**The TWO ratchets that genuinely move, in the SAME commit:**

1. **`STRICT_DOCS` floor 172 → 170** (`module-docs-lint.test.ts:273`). A *real un-promotion via
   deletion*, not a gate dodge — write the reason into the comment block, which already
   carries the precedent line for the 2026-07-07 15-module deletion (`178→169`).
2. **`ART_BACKLOG_MAX` 46 → 44** (`art/setup/profile-coverage.ts:120`). Asserted **strictly
   equal** to `ART_BACKLOG.length` (`audio-profile-gate.test.ts:108-112`) precisely so a
   shrinking batch cannot leave headroom — so this is forced, not optional.

**NOT ratchets here** (verified, see the §2 correction box): `SHARED_LINUX_PAIR_CEILING` (91),
`LINUX_DEFICIT_CEILING` (148), `STRICT_VRT_MODULES` floor (48). All three are untouched by
this deletion.

**Verified CLEAN — no edit needed** (each checked explicitly, zero matches): the whole
`packages/web/src/lib/control/push2/` directory (`push-card-config.ts`,
`push-card-schema.test.ts`), `packages/web/src/lib/art/fingerprints.generated.json`,
`e2e/vrt/vrt-composite-scenes.ts`, `e2e/vrt/vrt-platform-gaps.ts`,
`e2e/tests/per-module-per-port.spec.ts`, `e2e/tests/per-module.spec.ts`,
`e2e/tests/_per-port-drivers.ts`, all three `example-patches/*.imp.json`, `e2e/fixtures/`,
`packages/web/static/`, `.github/`, `Taskfile.yml`. ⚠ **The new module WILL need a
`PUSH_CARD_CONTROLS` entry** — neither predecessor had one, so the new card would be
auto-derived from param order and would silently re-rank as params are added (CLAUDE.md's
push-card drift warning). Give it an explicit entry.

**Registration itself needs no edit.** Registration is glob-driven — `audio/modules/index.ts:29`
(`import.meta.glob`), `ui/modules-card-map.ts:26` (`./modules/*Card.svelte`),
`packages/dsp/scripts/build.mjs:114` (`readdir(SRC_DIR)`) — so deleting the files
de-registers the modules. `Canvas.svelte`, `module-categories.ts` and `graph/types.ts` are
**not** part of this deletion.

### 2.5 What is being destroyed, recorded — the owner asked for this

**`warrenspectrum` (the existing module) is not a spectral resynthesizer at all.** It is a
**stereo 8-band resonator bank with vactrol ping excitation** — much closer to the VST's
`FilterBank` than to its `SpectralResynth`:

- 8 RBJ bandpass filters, octave-spaced 80/160/320/640/1280/2560/5120/10240 Hz, Q=6, or
  retuned as harmonic partials of a `root` MIDI note (`tuning_mode`).
- Per-band **ping gates**: a rising edge fires a vactrol envelope (soft attack 10-30 ms ±10 %
  jitter, exp decay 100-800 ms ±10 % jitter, tanh-saturated) which *both* injects a ~1 ms
  broadband click into the bandpass input *and* pumps the band's post-filter gain. Energy
  bleeds to n±1, n±2 with weights `[1.0, 0.35, 0.12] × bleed`.
- **Per-band sends and returns** — 8 mono outs + 8 mono ins; a patched return *replaces* that
  band in the mix, making it an 8-way parallel insert bank.
- A `viz_out` **mono-video** acidwarp EQ-curve render — a cross-domain audio→video bridge.

**Capabilities that die with it and have no home in the VST design:** the video output, the
per-band send/return insert matrix, the harmonic-partial tuning mode, and the whole ping/
vactrol/bleed excitation model. The VST's `FilterBank` has 8 bands with cutoff/Q/type/pan and
three sends (MAIN/FX1/FX2) — it has **no ping, no returns, no video**. If any of those four
matter to the owner, they need to be raised **now**, because this plan does not preserve them.

---

## 3. THE VST, FOR REAL — signal path, not parameter names

Read: `PluginProcessor.cpp` (532), `dsp/SpectralResynth.{h,cpp}` (237+1010), `dsp/MassPass.cpp`
(326), `dsp/FilterBank.cpp` (138), `dsp/Wavetabler.h` (253), `Fingerprint.cpp` (84).

### 3.1 The block-level chain

`PluginProcessor::processBlock` (`:85-476`) is explicit and ordered:

```
stereo in ──┬─ mono sum (0.5·(L+R))  ─────────────► ENGINE ──► resynthBuf_ (MONO)
            └─ inputL/inputR kept for dry paths          │
                                                          ▼
   [1] engine: SPECTRAL → SpectralResynth::process   (:292-294)
               MASSPASS → MassPass::process          (:296-298)
               WAVETABLE→ resynthBuf_ zeroed         (:300-303)
                                                          ▼
   [2] FilterBank::process(mono) → SIX buses:        (:307-311)
         mainL/R  +  fx1L/R  +  fx2L/R      (post-EQ, post-pan, post-send)
                                                          ▼
   [3] FILTERBANK WET crossfade + INPUT MIX add      (:324-339)
         main = wet·bankOut + (1-wet)·drySrc + inputMix·rawIn
         drySrc = resynth output (SPECTRAL/MASSPASS) or raw input (WAVETABLE)
                                                          ▼
   [4] FeedbackLoop::processInPlace per channel      (:342-343)
                                                          ▼
   [4.5] Wavetabler insert  (ONLY when MODE==WAVETABLE)  (:354-397)
         source = raw input in WAVETABLE mode, main bus otherwise
         + post-WT sends accumulate onto fx1/fx2
                                                          ▼
   [5] FxSlot 1 (Reverb) / FxSlot 2 (Delay), in place (:405-408)
                                                          ▼
   [6] sum main + fx1·mix + fx2·mix → master SVF morph → gain → out (:419-451)
```

Two structural facts the parameter list hides:

- **The engine is MONO.** `resynthBuf_` is one channel; stereo appears only at the
  filterbank's per-band pan (`FilterBank::setPan`, equal-power, `:59-67`). The plugin is
  mono-in-stereo-out in its core.
- **FX slot type is hard-wired despite being a parameter.** `fxType(s)` exists in the layout
  and is saved in presets, but `processBlock:267-268` forces slot 1 = Reverb and slot 2 =
  Delay unconditionally. **Do not port `fxType` as a control** — it is dead in the shipped
  plugin, kept only for preset back-compat.

### 3.2 SPECTRAL — what actually analyses and what actually resynthesises

`SpectralResynth::process` (`:888-1008`) is a **per-sample** loop; the FFT is *not* an
overlap-add. Per sample:

1. Push input into a circular buffer, `++samplesSinceHop_`; when it reaches `hopSize_`, run
   `analyzeFrame()` — **unless frozen** (`:923-930`).
2. Render **every live track** as a continuously-running oscillator and sum (`:934-979`).
3. Add the SMS residual noise bank (`:985-1004`).

`analyzeFrame()` (`:413-784`), in order:

- Hann-window the linearised circular buffer → `performRealOnlyForwardTransform` (`:421-430`).
- Magnitude + phase per bin; track `maxMag` and `totalEnergy` (`:441-450`).
- **Adaptive threshold** `thr = maxMag · 10^(FLOOR/20)` — FLOOR is **relative to the loudest
  bin**, not absolute dBFS (`:453`).
- **F0 detection** (`detectF0`, `:232-340`): harmonic sum over 60-800 Hz candidates, harmonics
  1..8 weighted `1/√k`. Confidence is a **z-score of the winner against the candidate
  distribution**, normalised by `√(log N)` (`:305-311`) — noise lands ≈1.0-1.2, pitched
  material ≈1.7-2.5, threshold 1.4. Parabolic sub-bin interpolation on the winner.
- **Peak picking**: local maxima above `thr`, parabolic interpolation in **log-magnitude**
  space, amplitude scaled by Hann coherent gain `4/N` (`:467-498`).
- **Salience ranking** (`peakSalience`, `:110-137`): `amp × bonus`, where a peak within 25
  cents of `k·F0` gets `bonus = 1 + 3·(1/√k)·confTerm·harmonicLock`. `partial_sort` keeps the
  top `activePartials_` **by salience, not amplitude** (`:504-519`) — so reducing PARTIALS
  collapses toward F0 and low harmonics rather than toward whichever formant bin was loudest.
- **F0 force-inject** (`:530-619`): if confident and F0 is absent from the surviving set,
  inject it — using `max(F0 bin amplitude, strongest surviving peak amplitude)`. The comment
  at `:566-585` is worth reading: an earlier gate blocked injection when F0 was weak, which
  fired constantly on formant-heavy vocals and left the bank playing a formant instead of the
  perceived pitch.
- **Harmonic LOCK** (`:627-652`): snap each peak toward `round(f/F0)·F0`, by
  `harmonicLock × clamp((conf-1.3)/1.1, 0, 1)`. **Only peaks within ~100 cents** of a harmonic
  are snapped (`relErr > 0.06 → continue`, `:648`); everything else passes through so formants
  and noise are not forced onto the comb.
- **MQ tracking** (`:661-747`): each peak seeks the nearest alive track within **5 % relative
  Hz**. Matched → frequency is *smoothed* toward the peak at the per-hop SLEW coefficient (not
  snapped — `:689`, and the comment says why: bin-to-bin migration otherwise sounds like
  chirped beeps), amplitude target updated, `framesAlive++`. Unmatched peak → birth in the
  first free slot; **amp is deliberately NOT reset and phase is only adopted if the slot is
  already silent** (`:715-727`) — both to avoid click discontinuities. Unmatched alive track →
  `ampTarget = 0`, `alive = false`.
- **SMS residual** (`:749-783`): mask ±3 bins around every surviving peak, integrate the
  *unclaimed* bin energy into 16 log-spaced bands (80 Hz → min(12 kHz, 0.45·SR)), store as
  per-band targets. In `process()` those drive 16 bandpass-filtered white-noise generators
  (`:986-1004`), each envelope-smoothed at ~25 ms.

**So, precisely, the four params the brief asked about:**

- **FREEZE** — `frozen_` skips `analyzeFrame()` on hop boundaries (`:928`). The bank keeps
  playing its last-acquired frequencies and amplitudes forever. It does **not** loop a buffer;
  it holds an oscillator state. That is why it is a *sustain* rather than a *stutter*.
- **LOCK** — the harmonic-comb snap above. Its strength is multiplied by F0 confidence, so on
  unpitched material it self-disengages. Default **0.75** — biased on.
- **RESIDUAL** — the SMS stochastic half: filtered noise carrying the energy the sinusoidal
  tracker discarded (sibilants, breath, noise floor). Range 0..2, default **0.5**. Header
  comment `:96-99` calls it *"the #1 fix for 'vocoder/robot vibe'"*. Additionally scaled by
  `cbrt((activePartials-1)/47)` (`:904-907`) so collapsing PARTIALS also cleans up the noise.
- **STABILITY** — `minBirthFrames_`: a track must be matched on N consecutive hops before it
  is audible, and it **ramps in linearly over the gate window** rather than hard-muting
  (`:968-971`). Default 3 hops ≈30 ms at hop 512/48 kHz. It is the anti-"robot beep" control
  that FLOOR alone cannot provide.

Two more that matter and are easy to mis-port:
- **SHAPE** morphs every voice sine→saw→square via PolyBLEP (`voiceWaveform`, `:83-98`), and
  there is an anti-alias gain ramp from `0.75·Nyquist` to `0.85·Nyquist` per partial
  (`:957-961`).
- **SLICE** is the analysis hop. ⚠ **Read §3.2.1 before porting it or declaring its range —
  most of SLICE's declared behaviour does not happen in the shipped plugin.**

### 3.2.1 ⚠ SLICE: the declared range and the host-sync grid are both mostly unreachable

**This corrects an earlier draft of §3.2 above, which described SLICE as "host-tempo locked,
aligned to the bar grid … the signature Panharmonium feel, on by default." That is what the
parameter layout says. It is not what the DSP does.** Every number below is arithmetic over
three cited lines; check it rather than believing it.

**The fixed premise:** `fftOrder` is **not a parameter** — `PluginProcessor.cpp:55` is
`resynth_.prepare(sampleRate, 11)`, hardcoded, so `fftSize_` is **always 2048** and
`prepare()`'s own `std::clamp(fftOrder, 8, 14)` (`SpectralResynth.cpp:146`) never binds.

**(a) FREE mode — the top ~61 % of the knob's travel is dead.** `setSliceMs`
(`SpectralResynth.cpp:362-373`) clamps the hop to

```
clamp(ms·SR/1000,  2 ms·SR,  fftSize·0.5)  →  clamp(·, 96, 1024) samples @48 kHz
                                           →  reachable hop = 2.00 … 21.33 ms
```

but the parameter is declared `NormalisableRange<float>(2.0f, 200.0f, 0.1f, 0.4f)`
(`PluginParams.h:163-166`). So **178.7 of the declared 198 ms — 90 % of the numeric range —
is clamped away.** In knob *travel* it is less lopsided but still severe: JUCE skew 0.4 means
`value = 2 + 198·p^2.5`, so the 21.33 ms ceiling is hit at `p ≈ 0.394`. **Turning SLICE past
~39 % of its sweep changes nothing.**

→ **Any SLICE range we declare must be `2 … fftSize/2` in ms, derived from the FFT size, not
copied from the VST's layout.** At our proposed FFT 2048 that is **2 … 21.3 ms**. Hardcoding
`2..200` would reproduce a control that lies about its own range — the exact defect
CLAUDE.md's *"A CARD can silently disagree with its DEF"* section exists for, except here the
DEF would disagree with the DSP.

**(b) Host-sync — the grid alignment does not engage at any musical tempo.**
`setHostSyncedHop` (`:374-387`) clamps to `[32, fftSize_-1]` = `[32, 2047]` samples =
**0.67 … 42.65 ms**, while `PluginProcessor.cpp:160-175` computes
`sps = (60/BPM)·SR·(4/effDenom)`. Solving `sps ≤ 2047` gives the **minimum BPM at which each
division actually fits**:

| division | effDenom | min BPM for the grid to engage |
|---|---:|---:|
| 1/4 | 4 | 1407 |
| 1/8 | 8 | 704 |
| **1/16 (the DEFAULT, choice index 3)** | 16 | **352** |
| 1/32 | 32 | 176 |
| 1/4T · 1/8T · 1/16T | 6 · 12 · 24 | 938 · 469 · 235 |

**At 120 BPM the default 1/16 requests 6000 samples and receives 2047.** And because
`prime = clamp(hopSize_ - samplesUntilNext, 0, hopSize_-1)` primes against the **already
clamped** hop, the bar-grid phase is discarded too: analysis fires every 2047 samples,
unrelated to the beat. Only `1/32` above 176 BPM is reachable in normal use.

⚠ The comment on `setHostSyncedHop` says *"Ceiling at `fftSize_-1` matches `setSliceMs`."*
It does not — `setSliceMs` ceilings at `fftSize_·0.5`. The two paths disagree by 2×, which is
a second, independent tell that this ceiling was never exercised.

**Consequences for this plan, all of which were wrong before this section existed:**

1. **§5.2 rank 6** justified SLICE's lane cell as *"the one control whose default (host-synced
   1/16) makes a fresh instance sound like Panharmonium."* At any sane tempo the default is a
   **fixed 42.65 ms hop** (≈23 analyses/s). The lane rank still stands — SLICE *is* the
   rhythmic axis over its live 2-21 ms range — but **the justification must be the live range,
   not the grid**.
2. **§4.3 item 3** proposed flooring SLICE at ~5 ms because 2 ms means "a hop in every
   quantum". That still holds and is now the *dominant* constraint: with a 21.3 ms ceiling the
   usable span is 5-21 ms, i.e. **one octave of control**, not the two decades the VST's layout
   advertises. If a slower "pad" hop is wanted it needs a **larger FFT**, not a bigger SLICE
   number — 200 ms would need `fftSize ≥ 19200`, i.e. order 15, which `prepare()`'s own
   `clamp(fftOrder, 8, 14)` forbids. **The VST cannot reach its own advertised range.**
3. **§6 phase 5 (host-tempo SLICE)** is porting a feature that does not work upstream. Either
   drop it, or port it **fixed** — raise the ceiling to `fftSize-1` on both paths and say
   plainly that we deviate from the VST. Do not port the bug and call it fidelity.

*(Instrument check: this finding is arithmetic on three cited constants — `prepare(sr, 11)`,
the two `clamp` calls, and the `NormalisableRange`. It needs no benchmark and no listening
test, and any reader can falsify it by changing one of the three.)*

### 3.3 MASSPASS — the other resynthesiser

`MassPass::process` (`:225-323`). Not FFT-based at all:

- N bandpass filters (N ∈ 16/24/33/48/66/99), log-spaced 50 Hz → 12 kHz, Q derived so each
  band's edges sit at `center/√ratio .. center·√ratio` (`:146-150`).
- Per band: envelope follower on `|bp|/Q` (3 ms attack / 80 ms release, `:170-173`) **and**
  zero-crossing pitch estimate smoothed at ~30 ms (`:179-180`, `:290-292`).
- **SLICE snapshots** `(env, smoothedHz)` into `(heldAmp, heldHz)`; the oscillator uses the
  *held* values between snapshots (`:260-269`). That sample-and-hold is what gives MASSPASS
  its stepping.
- Only the loudest `activeBands_` sound (`selectLoudestBands`, `:108-131`); phase advances even
  for inactive bands so re-activation does not pop (`:296-299`).
- Output normalised by `1/√N` (`:318-322`).

It shares the SHAPE knob and reuses the PARTIALS slider as a band limiter
(`PluginProcessor.cpp:204-220`).

### 3.4 FilterBank, FeedbackLoop, Wavetabler

- **FilterBank** (`:93-136`): 8 SVFs, each morphed LP→BP→HP by a continuous `typeMorph`
  (`morphSvf`), equal-power panned, fanned into three buses by MAIN/FX1/FX2 sends. A band with
  all three sends at 0 is **skipped entirely** (`:107-110`) — a real CPU optimisation worth
  keeping. Defaults: lows HP, mids BP, highs LP (`PluginParams.h:260-264`).
- **FeedbackLoop**: delay 0.5-1000 ms with an in-loop morphable SVF. At the **0.5 ms default**
  it is a comb resonator with a ~2 kHz fundamental, and moving FB CUTOFF reads as FM
  (`PluginParams.h:306-311`) — not an echo. That default is a character choice, not a neutral.
- **Wavetabler** (`Wavetabler.h`): 8 cells, per-cell length 0.1-100 ms, continuously captured
  from the post-feedback bus; playback triangular-blends cells centred at `morph` with width
  `spread`, L2-normalised, L/R centres fanned by `width`. Freeze stops the writer only. Note
  the **startup passthrough** at `:215-219` — if no cell has closed yet it passes input
  through rather than outputting silence.

### 3.5 Fingerprint — a portable preset format we should reuse

`Fingerprint.cpp` serialises every `RangedAudioParameter` to JSON as
`{ type: "wsp-fp", version: 1, pluginVersion, params: { id: value } }`, and `apply()` skips
unknown keys for forward-compat (`:71`) and clamps to range (`:76-78`). **This is a
ready-made, already-versioned preset interchange format**, and it means a user can copy a
patch out of the VST and into the module (and back) if we keep the param ids. That is a real
"1:1 copy" affordance worth far more than matching knob layouts, and it should be a phase-1
consideration rather than an afterthought — it constrains param naming.

---

## 4. BROWSER FEASIBILITY — with numbers

**All figures measured on Apple M5 / node v22.22.2 via `flox activate -- node`, pure-JS
`Float32Array` loops faithful to `packages/dsp/src/callsine.ts` structure.** Scratch
benchmarks, not committed. ⚠ Node/V8 on a fast dev machine is an **optimistic** proxy for an
AudioWorklet on a user's laptop — treat every number as a floor, and see §4.4.

### 4.1 The three hot loops

**(a) Radix-2 complex FFT — ms per transform**

| N | ms |
|---:|---:|
| 1024 | 0.0247 |
| 2048 | 0.0453 |
| 4096 | 0.0948 |

**(b) K-partial sine bank — 1.0 s of audio @ 48 kHz**

| K | render ms | % of one realtime core |
|---:|---:|---:|
| 16 | 6.0 | 0.6 % |
| 64 | 10.7 | 1.1 % |
| 128 | 19.1 | 1.9 % |
| 256 | 37.1 | 3.7 % |
| 512 | 68.0 | 6.8 % |
| 892 | 113.9 | 11.4 % |

**(c) MQ matcher — the `O(peaks × tracks)` loop at `SpectralResynth.cpp:663-698`**

| peaks | tracks | ms/hop | @ hop 512 (93.75/s) | @ hop 96 (500/s) |
|---:|---:|---:|---:|---:|
| 64 | 64 | 0.0152 | 0.14 % | 0.8 % |
| 128 | 128 | 0.0230 | 0.22 % | 1.2 % |
| 256 | 256 | 0.0825 | 0.77 % | 4.1 % |
| 512 | 512 | 0.3056 | 2.87 % | 15.3 % |
| 892 | 1024 | 1.0681 | **10.01 %** | **53.4 %** |

**(d) The rest of `analyzeFrame()` — the stages an earlier draft omitted entirely.**
The review flagged that peak-picking and F0 detection were absent from the cost model. They
are now measured (same machine, same method, `numBins = 1024` for FFT 2048):

| stage | source | ms/hop |
|---|---|---:|
| magnitude + phase, 1024 bins (`sqrt` + `atan2` per bin) | `SpectralResynth.cpp:441-450` | 0.00762 |
| peak pick + parabolic log-mag interp @ FLOOR −60 dB | `:467-498` | 0.00359 |
| `detectF0` harmonic sum | `:232-340` | 0.00020 |
| **subtotal** | | **0.0114** |

⚠ **`detectF0` is 32 candidates, not "~700".** `binHz = 48000/2048 = 23.44 Hz`, so
`binLo = max(2, ⌈60/23.44⌉) = 3` and `binHi = min(1024/8, ⌊800/23.44⌋) = min(128, 34) = 34` —
**32 candidates × 8 harmonics = 256 multiply-adds per hop.** The review's framing of this as
`O(N·k)` in the bin count is wrong: it is `O(B·K)` in the *candidate* count, and B is tiny.
The VST's own comment at `:296-299` reasons about *"~700 F0 candidates"* — that number is not
reachable at the order-11 FFT the plugin hardcodes. (The confidence normalisation itself is
unaffected: `√(2 ln N)/√(ln N) = √2` for any N, so the z-score threshold of 1.4 survives the
correction. Worth knowing before anyone "fixes" it.)

⚠ **Instrument check, both directions.** Halving the bin count halved the magnitude+phase
cost (**2.12×**, must be ~2 if it is really `O(bins)`), and dropping the peak threshold to 0
so every bin becomes a peak candidate **raised** the peak-pick cost **1.20×**. Both numbers
moved with the dimension under test, so neither is measuring loop overhead. A flat response
would have looked equally authoritative and meant nothing.

### 4.2 The finding: the **matcher** is the wall, not the FFT and not the bank

At the VST's maximum (892 partials, 1024 track slots) the FFT is **0.4 %** of a core while the
matcher is **10 %** — 24× more expensive — because it is quadratic where the FFT is
`N log N`. Every intuition that says "an FFT in a worklet is the scary part" is wrong here.

**And the average is the wrong statistic.** An AudioWorklet renders 128-sample quanta with a
**2.67 ms** deadline. The hop cost is a **spike inside one quantum**, not an amortised load.
At 892/1024 with hop 512, the quantum in which the hop fires costs:

```
bank         113.9 ms/s × 128/48000  = 0.304 ms
matcher                               = 1.068 ms
FFT (N=2048)                          = 0.045 ms
mag+phase / peak-pick / F0   (§4.1d)  = 0.011 ms
                                        ─────────
                                        1.429 ms  =  53.5 % of the 2.67 ms deadline
```

**53 % of a single quantum's entire budget, on an M5, for ONE instance, with nothing else in
the rack.** A machine 2× slower blows the deadline outright. This is the number that decides
the design.

*(The §4.1d stages the earlier draft omitted move this from 1.417 → 1.429 ms and the proposed
cap from 0.227 → 0.239 ms — **0.8 % and 5 % respectively. The omission was real; it was not
material, and saying so is the honest close.** They are folded in above so the arithmetic is
complete rather than approximately right, and so the next reader does not have to re-derive
whether they mattered. The three dominant terms remain matcher ≫ bank > FFT.)*

⚠ **"% of one core" would have been the wrong statistic**, and an earlier analysis of this
module used it. Audio does not die on an average; it dies on a **per-quantum deadline**
(128 samples = 2.667 ms at 48 kHz). Our worklet calls `analyzeFrame()` **inline in the
per-sample loop** — `packages/dsp/src/callsine.ts:657`, `if (!this.frozen)
this.analyzeFrame(...)` inside the `for (let i = 0; i < out.length; i++)` at `:651` — so the
whole FFT + peak-pick + F0 + MQ burst lands **inside one `process()` call**, and at small hop
sizes inside **every** one. A budget expressed as a percentage of a core is invariant to that,
which is exactly the property that makes it useless here.

### 4.3 What must be simplified — and what would be a lie to claim

**Must be simplified:**

1. **Cap partials at 256, not 892.** At 256/256 the matcher is 0.77 % and the bank 3.7 %; the
   hop-quantum cost is `0.099 + 0.083 + 0.045 + 0.011 = 0.239 ms` — **8.9 % of the deadline**.
   That is a **6.0×** headroom improvement for a partial count already past the point of
   perceptual return on most material. The VST's own default is **64** (`PluginParams.h:149`)
   with a **128** cap (`:156`), so a 256 ceiling is *above the plugin's own shipping default*.
2. **Replace the linear matcher with a frequency-sorted scan.** Peaks come out of the FFT in
   ascending bin order already; keeping tracks sorted by frequency makes matching a merge
   rather than a nested scan, turning `O(P·T)` into `O(P + T)`. This is the single
   highest-value deviation from the C++ and it changes no audible behaviour.
3. **Floor the SLICE range — and derive its CEILING from the FFT (§3.2.1).** The VST allows
   2 ms (hop ≈96 at 48 kHz → 500 hops/s). Even at 256 partials that is 4.1 % continuous plus a
   spike every 96 samples — i.e. a hop in **every quantum**. Floor SLICE at ~5 ms, or make the
   short end reduce the partial cap automatically. ⚠ The *upper* end is not ours to choose:
   `setSliceMs` ceilings the hop at `fftSize·0.5`, so at FFT 2048 the whole usable span is
   **5-21.3 ms** — one octave. **Declare that range; do not copy the VST's `2..200`, which is
   90 % unreachable in the plugin itself.**
4. **One instance, not N voices — the engine is MONOPHONIC.** `SpectralResynth` takes one
   mono input and produces one mono output (`resynthBuf_`, §3.1); there is no voice
   allocation anywhere in it. This is an *effect* that analyses whatever is patched in, so
   "N voices" is not an axis at all — **N voices means N instances**. At 256 partials the
   answer is roughly 3-4 instances before a single core is saturated. State that in the
   module's docs, because a user reading "spectral resynthesizer" will reasonably assume
   polyphony.

**What would be a lie to claim:**

- **"1:1 with the VST at 892 partials."** Not on a mid-range laptop. See the deadline
  arithmetic above.
- **"Sample-accurate host-tempo SLICE sync."** The VST reads `getPlayHead()` for BPM and bar
  position (`PluginProcessor.cpp:151-177`). We have a clock, but the worklet would need the
  grid phase pushed to it per block; the alignment will be **quantum-accurate (±2.67 ms), not
  sample-accurate**. Say so.
- **"All three engines in phase 1."** MASSPASS at 99 bands is a second full DSP with its own
  cost profile; it is not measured here at all. **UNCONFIRMED: MASSPASS browser cost.**
- **"Zero added CI wall-time."** An ART scenario that renders several seconds of spectral
  resynth is not free. Measure it before merging (§8).

### 4.4 Against what `packages/dsp/` already does

`packages/dsp/src/callsine.ts` is the **only** FFT-using worklet in the repo (`grep -l FFT
packages/dsp/src/*.ts` → one file). It runs FFT 1024 / hop 256 / 64 tracks — i.e. **187.5
hops/s** with a 64×64 matcher. From the tables: bank 1.1 % + matcher 0.29 % + FFT 0.46 % ≈
**1.9 % of a core**, and its hop-quantum spike is `0.029 + 0.015 + 0.025 = 0.068 ms` —
**2.6 % of the deadline**. It has shipped without CPU complaints, which is the empirical
anchor: the proposed 256-partial configuration is **3.3× that spike** (8.5 % vs 2.6 %) and
still ~12× inside the deadline, where the VST's maximum (53 %) is not.

⚠ **The instrument, negative-controlled.** The bank benchmark scales 16→892 as
6.0/10.7/19.1/37.1/68.0/113.9 ms — from 128 upward each doubling of K costs 1.94×/1.83×/1.67×,
i.e. linear in K plus a fixed ~3 ms loop overhead. The matcher scales superlinearly with P·T
as expected. Both respond to the dimension under test, so neither is measuring loop overhead
alone. Had the numbers been flat, they would have looked equally authoritative and meant
nothing.

---

### 4.5 Two optimisations measured **NEGATIVE** — recorded so nobody spends a day on them

Salvaged from the superseded #1295, which benchmarked both on this machine (node/V8 arm64 —
the same engine that runs AudioWorklets):

| "optimisation" | expected | **measured** | why |
|---|---|---:|---|
| Port the VST's `fastSin2Pi` polynomial in place of `Math.sin` | ~4× (what it gets over libm in C++) | **1.01×** | V8's `Math.sin` is already a fast intrinsic; the C++ win does not exist in JS. |
| Hoist the model `switch` out of the per-sample inner loop | ~2.5× | **1.11×** | the branch is perfectly predicted and JIT-hoisted already. |

⚠ **The 2.5× figure came from #1295's own first two benchmarks**, which appeared to support it
and were wrong — only a **single-variable** experiment (change the hoist, change nothing else)
disproved it. That is the lesson worth more than the two numbers: a micro-benchmark that
varies two things at once will confirm whichever hypothesis you brought to it.

⚠ Also from #1295, and the reason its CPU numbers are quoted here only as *ranges*: it
measured the same partial bank four ways and got **7.5 % / 21.2 % / 30.1 % / 51.7 %** of a
core. **That spread is itself the finding.** Every design choice in §4.3 survives the
pessimistic end of it; none should be defended on the optimistic end.

---

## 5. THE FACE — 104 params against a 6-cell lane

### 5.1 The budget, measured

From `curated-face.ts` / `curated-face.test.ts:243-259`:

| tier | cells |
|---|---:|
| mini | 1 |
| compact (with glyph) | 2 |
| compact (no glyph) | 3 |
| **full (in-lane plate)** | **6** = `PLATE_COLS(3) × PLATE_MAX_ROWS(2)` |
| dock | all, grouped by `pages` |

So **6 of 104** reach the lane. 98 live in the dock. The ratio is ~17:1 — worse than DX7,
which is the current largest face.

⚠ **The brief names face fields — `readouts`, page `title`/`hint`, `sidebar` blocks, `hero`
slot — that do NOT exist in this worktree.** `ModuleFace` at `graph/types.ts:540-618` carries
exactly: `order`, `pages` (with `clusters`), `glyph`, `glyphDepthGain`, `paramCells`,
`momentary`, `rear`. **UNCONFIRMED: the sibling agent's platform additions.** Everything below
is written against the *shipped* platform so it cannot rot; where a new affordance would
obviously help, it is flagged rather than assumed.

### 5.2 Proposed `order` — the 6 that reach the lane

```ts
order: [
  'engineMode',        // 1
  'spectralPartials',  // 2
  'spectralLock',      // 3
  'engineFreeze',      // 4
  'spectralResidual',  // 5
  'spectralSlice',     // 6
  // ── dock tail below the lane budget ──
  'spectralFloor', 'spectralStab', 'spectralShape', 'spectralSlew',
  'spectralCenter', 'spectralPartialCap', 'spectralSliceMode', 'spectralBandCount',
  'ws-filterbank-{n}', 'ws-feedback-{n}', 'ws-fx-{n}', 'ws-wavetable-{n}',
  'resynthLevel', 'inputMix', 'masterFiltOn', 'masterFiltCutoff',
  'masterFiltQ', 'masterFiltType', 'gain',
]
```

Each of the six has an argument that would be **wrong for a different module** (the Step-3
bar):

1. **`engineMode`** — it selects between **three different DSP classes**. No other control can
   change more. On a single-engine module this rank would be absurd.
2. **`spectralPartials`** — the module's one true macro: it sets density *and* is the CPU
   dial *and* (via `cbrt((n-1)/47)`, `SpectralResynth.cpp:904-907`) scales the residual. Three
   jobs in one knob.
3. **`spectralLock`** — decides whether the output is musical or warbly, defaults **on**
   (0.75), and self-disengages on unpitched input. It is the difference between "instrument"
   and "artefact".
4. **`engineFreeze`** — the only *performative* control on the module: press it and the
   spectrum becomes a held pad. Ranked above RESIDUAL because it is a gesture, not a setting.
5. **`spectralResidual`** — the sine/noise balance; the plugin's own header calls it the #1
   fix for the robot-vocoder character.
6. **`spectralSlice`** — the rhythmic axis: it decouples the analysis rate from the FFT size,
   so it alone decides whether the module tracks transients or smears into a pad. ⚠ Its rank
   is earned by its **live 5-21 ms range**, *not* by the host-synced 1/16 default — see
   §3.2.1, where that default is shown to collapse to a fixed 42.65 ms hop at any musical
   tempo. (The earlier draft ranked it on the grid-sync story, which is not real.)

Deliberately **not** in the lane: `gain` (every module has one; it earns no scarce cell),
`spectralFloor` (interacts with STABILITY — a pair, and pairs belong in a band), and the
filterbank (56 params cannot be represented by one cell honestly).

### 5.3 Proposed `pages` — 6 dock bands

```ts
pages: [
  { id: 'engine',     label: 'engine · what resynthesises',
    controls: ['engineMode', 'spectralBandCount', 'engineFreeze',
               'spectralPartials', 'spectralPartialCap'] },
  { id: 'analysis',   label: 'analysis · what gets heard',
    controls: ['spectralFloor', 'spectralStab', 'spectralLock',
               'spectralResidual', 'spectralCenter'],
    clusters: [
      { label: 'peak gate',    controls: ['spectralFloor', 'spectralStab'] },
      { label: 'harmonic',     controls: ['spectralLock', 'spectralResidual'] },
    ] },
  { id: 'motion',     label: 'motion · how fast it follows',
    controls: ['spectralSlice', 'spectralSliceMode', 'spectralSlew', 'spectralShape'] },
  { id: 'bands',      label: 'filterbank · 8 bands · everything passes here',
    controls: ['ws-filterbank-{n}', 'resynthLevel', 'inputMix'] },
  { id: 'fx',         label: 'feedback · reverb · delay',
    controls: ['ws-feedback-{n}', 'ws-fx-{n}'] },
  { id: 'out',        label: 'wavetable · master',
    controls: ['ws-wavetable-{n}', 'masterFiltOn', 'masterFiltCutoff',
               'masterFiltQ', 'masterFiltType', 'gain'] },
]
```

**The load-bearing decision: four subsystems become PANELS, not param lists.**

A `ControlFamily` renders one cell that opens a purpose-built editor. Applied to:

| family | replaces | params absorbed |
|---|---|---:|
| `ws-filterbank` | 8 bands × (cutoff, Q, type, pan, main, fx1, fx2) | **56** |
| `ws-fx` | 2 slots × (on, p0, p1, p2, mix) — `fxType` **excluded**, see §3.1 | **10** |
| `ws-wavetable` | size, spread, morph, width, mix, →fx1, →fx2 (+2 legacy bools) | **9** |
| `ws-feedback` | amount, time, cutoff, Q, type | **5** |
| | | **80** |

That is the only honest way to fit this module: **80 of 104 params never appear as individual
cells at all.** 104 − 80 = 24 discrete controls, of which 6 reach the lane and 18 fill the
dock bands — which is DX7-scale, and DX7 already works.

The filterbank panel should be a **curve editor**, not 56 knobs — the VST already ships one
(`visual/FilterCurveComponent.h`, 297 lines), and its vertical axis is the MAIN send over
0..1 with centre at 0.5 (`PluginParams.h:281-284`). Porting that interaction is a far better
use of effort than 56 dials.

**Page-id collision warning, from DX7's scar** (`dx7.ts` face comment): a page id colliding
with a curated rear group id renders that band **twice** and fails the rear-derivation
totality gate. `'engine'`, `'analysis'`, `'motion'`, `'bands'`, `'fx'`, `'out'` are chosen to
avoid `'voice'`/`'signal'`.

### 5.4 Glyph

`glyph: 'scope'` for phase 1. The obviously-right glyph is a **live spectrum with the tracked
partials marked** — which is not a supported kind, and `graph/types.ts:560-563` is explicit
that `'algorithm'` is *"NOT YET A GENERAL PRECEDENT"* and that a second topology-bearing
module should **widen the binding**, not add a third literal. So: ship `'scope'`, and if a
partial-spectrum glyph is wanted, do it as the layout-source widening that comment asks for —
in its own PR.

---

## 6. PHASING — and an honest statement of scope

### 6.0 The scope, said plainly

**"A 1:1 copy of the CallSine VST" is not a batch item. It is months of DSP work.** The
honest inventory: **104 runtime parameters** (§0.1) across **three independent engines**
(§0.2 — `SpectralResynth` 1,010 LOC + `MassPass` 326 + `Wavetabler` 253), an 8-band morphing
filterbank, a feedback loop, two FX slots, a master filter, **and** a curve-editor UI the
plugin ships as a 297-line component. Nobody should read the phase list below as five sprints.
**Phases 2-5 are each a multi-PR project in their own right**, and phase 4 (MASSPASS) has
never had its browser cost measured at all (§4.3, UNCONFIRMED).

**What that means for how this gets approved:** phase 1 is the only phase this document
scopes with enough confidence to start. Phases 2-5 are a *direction*, not estimates. Do not
schedule against them.

### 6.1 Phase 1 must SHIP, and be recognisably the VST in ONE testable respect

**Phase 1 must not be scaffolding.** The single identifiable respect in which it is the VST —
the one an owner listening test can adjudicate and an ART golden can pin — is:

> **A harmonically-locked sinusoidal partial tracker with the SMS stochastic residual**, i.e.
> speech and instruments resynthesised as tracked partials **plus** the noise the tracker
> discarded. That is the difference between "vocoder robot" and CallSine, the plugin's own
> header calls RESIDUAL *"the #1 fix for the 'vocoder/robot vibe'"* (§3.2), and it is
> **falsifiable**: at `RESIDUAL = 0` a sibilant disappears; at `RESIDUAL = 2` it returns.

That test — sibilant energy present at RESIDUAL 2, absent at RESIDUAL 0 — is the phase-1
acceptance criterion. It is reachable because the tracker half is already shipped and tested
in this repo (§0.3).

### Phase 1 — the module ships (SPECTRAL only)

- New `warrensspectrum` module: def, card, worklet, docs, `STRICT_DOCS`, `rack-sizes`,
  `DESCRIPTIONS`, `PUSH_CARD_CONTROLS` (§2.4).
- **Port ids are constrained**: `audio_in` / `pitch` / `gate` / `out` — the four the alias
  depends on (§1.3.2). Renaming any of them silently voids the migration.
- Worklet **derived from `packages/dsp/src/callsine.ts`** (do not start over), with:
  - FFT 1024 → **2048**, hop from SLICE (**range 5-21.3 ms, derived from the FFT — §3.2.1**),
    partial cap **256** (§4.3).
  - Frequency-sorted merge matcher replacing the linear scan (§4.3 item 2).
  - The full spectral parameter set: FLOOR, STABILITY, LOCK, RESIDUAL, SHAPE, SLEW, SLICE,
    CENTER, PARTIALS, PARTIAL CAP, FREEZE. **SMS residual is in phase 1**, not deferred — see
    §6.1; without it phase 1 has no claim to be the VST at all.
- **`RETIRED_TYPE_ALIASES` (callsine only) + the two-legged fixture test + the load-diagnostic
  UI** (§1). Migration ships **with** the thing that breaks the racks, never after it — and
  the diagnostic UI is what makes dropping `warrenspectrum` honest rather than silent.
- Both old modules deleted, every §2 row drained, **`STRICT_DOCS` 172→170 and
  `ART_BACKLOG_MAX` 46→44** in the same commit.
- Face: `order` + a reduced `pages` (`engine` / `analysis` / `motion` / `out`).

**Phase 1 explicitly does NOT:**

| not in phase 1 | consequence a user will notice |
|---|---|
| the 8-band filterbank (56 params) | **no stereo** — pan lives in the bank (§3.1). Mono in, mono out. |
| WAVETABLE mode + the `Wavetabler` insert | one of the plugin's three engines is absent |
| MASSPASS (the third engine, 326 LOC) | ditto — and its cost is unmeasured |
| feedback loop, 2 FX slots, master filter | no built-in reverb/delay/comb — **patch them; we have a rack** |
| host-tempo SLICE | no grid sync (and §3.2.1 shows it does not work upstream either) |
| `.wspr` fingerprint interchange | patches do not move between plugin and module |
| the filter-curve editor UI | n/a until phase 2 |

That is **~24 of 104 params**. `engineMode` ships declared but SPECTRAL-only (single option)
so phase 2 does not change the contract shape — a deliberate cost paid now to avoid a second
`contract-lock` churn later.

### Phase 2 — the filterbank

8-band bank + `resynthLevel` (FILTERBANK WET) + `inputMix`, plus the `ws-filterbank` curve
panel. This is where it starts sounding *stereo* — the engine is mono and pan lives here
(§3.1).

### Phase 3 — feedback, FX slots, master filter, wavetable

`ws-feedback`, `ws-fx` (Reverb + Delay, types hard-wired per §3.1), master SVF, `ws-wavetable`.

### Phase 4 — MASSPASS

Second engine, after its browser cost is actually measured (§4.3, currently UNCONFIRMED).

### Phase 5 — `.wspr`/fingerprint interchange (+ host-tempo SLICE, *if* it is fixed)

JSON fingerprint import/export (§3.5) so patches move between plugin and module.

⚠ **Host-tempo SLICE is demoted to conditional.** §3.2.1 shows the VST's grid sync does not
engage at any musical tempo — the hop clamp swallows it. Porting it faithfully would ship a
control that does nothing. Either **drop it**, or **fix it** (raise the ceiling to
`fftSize-1` on both the free and synced paths, reconciling the 2× disagreement between them)
and document the deviation. Decide before writing code; do not port the bug and call it 1:1.

---

## 7. Naming

Module type id: **`warrensspectrum`** (one word, lowercase, no apostrophe). `label:` must be
lowercase per the repo's `lowercase-module-labels` guard: **`warren's spectrum`**.

⚠ **Do not reuse the type string `warrenspectrum`. This is now load-bearing, not cosmetic.**
§1.3 deliberately does **not** alias `warrenspectrum` — the drop is the whole point. But a
type string is resolved by **exact match against the registry**
(`persistence.ts:31-35`), so registering the new module under the old id would make every old
resonator-bank node resolve **silently, with no alias entry and no diagnostic at all** —
reinstating by accident the exact behaviour §1.3.3 rejects on purpose, and doing it *below*
the layer that would have reported it. The distinct id is what makes the drop observable.

The double-s spelling (`warrensspectrum`) is deliberate; its reason belongs in a comment on
the def, and the §1.4 fixture's DROP leg (assertions 6-8) is what keeps it enforced — if
someone later renames the new module to `warrenspectrum`, those assertions go red.

---

## 8. TESTABILITY

### 8.1 What an ART golden looks like for a spectral engine

**Today neither module has a `.f32` baseline** (§2.3) — both ART scenarios are
assertion-based. For the new module that is not good enough: a spectral resynth has a huge
state space and a "produces non-silent output" assertion passes for an engine that is subtly
broken.

⚠ **First, what the ART gate actually IS — because the superseded #1295 got this wrong and
built a recommendation on it.** #1295 claimed ART's protection is a *"long-term-average
spectrum"* fingerprint and therefore *"structurally invariant to SLICE, FREEZE, STABILITY and
SLEW"* — a "harness hole". **It is not.** The real gate is `assertBaseline`
(`art/setup/capture.ts:176-197`):

1. a **source-SHA pin** — `expect(existingSha).toBe(srcSha)`, so a DSP edit fails loudly until
   deliberately re-pinned; then
2. `compareBuffers(..., tier 'B', 1e-4)` (`art/setup/render.ts:135-169`) — a **length-equality
   check plus the RMS of the sample-wise difference over the whole buffer**, against a
   threshold of `1e-4`.

That is a **time-domain, sample-aligned** comparison. It is not invariant to SLICE or FREEZE
or anything else — a one-hop timing shift moves it far past `1e-4`.
`fingerprints.generated.json` is **display / provenance data** (peak/RMS labels + a spectrum
summary, pinned to each `.f32`'s sha256 so the two artifacts cannot drift, per CLAUDE.md). It
**never renders audio and gates nothing on its own.** Do not design around a hole that is not
there. *(Both modules have zero `.f32` and zero fingerprint entries today — §2.3 — so the
deletion needs no `art:update` and no `art:fingerprints:accept`.)*

**Proposal — two tiers, deliberately:**

**(a) Byte-exact goldens for DETERMINISTIC configurations.** The engine is deterministic given
a fixed input, sample rate and params — *except* the residual noise generator, which is an
`xorshift32` seeded to a constant (`SpectralResynth.cpp:200`, `residualNoiseState_ =
0x9E3779B9u`). **Seed it identically in the port and the whole engine is byte-reproducible.**
That is what makes a golden possible at all, and it must be an explicit design constraint on
the worklet, not an accident. Pin:
- `spectral/sine-440` — a pure tone: the bank should converge to one partial. The cleanest
  possible regression signal.
- `spectral/voice-lock` — a pitched vocal clip at LOCK=0.75, RESIDUAL=0.5 (the defaults).
- `spectral/freeze-hold` — freeze mid-clip, render 2 s: asserts the hold is *steady*, which is
  where an amp-smoothing bug shows up as drift.
- `spectral/residual-only` — PARTIALS=1, RESIDUAL=2: isolates the noise bank.

Re-pin via `task art:update` (which chains `art:fingerprints:accept` — never re-pin a baseline
by another route).

**(b) Property assertions where a golden would be brittle.** SLICE and PARTIALS sweeps change
output continuously; pin *relationships*, not bytes:
- partial count monotonic in PARTIALS,
- LOCK=1 on a pitched input → detected peaks land within 25 cents of `k·F0`,
- STABILITY↑ → fewer track births per second,
- FLOOR↑ (stricter) → fewer surviving peaks.

**Each of these needs a negative control**: break the specific thing and watch that specific
assertion go red. A partial-count assertion that passes when the tracker is disabled is
measuring the harness.

### 8.2 What can never be covered

State it plainly rather than pretending:

- **"Does it sound like the VST?"** No automated test answers this. The C++ and the TS will
  never be sample-identical (different FFT implementations, different float ordering). Only
  an A/B listening session against the plugin settles it, and it should be an explicit
  owner-review gate before phase 1 merges — precedent: the `video-aspect-resolution-review-
  before-merge` and Milkdrop preview-PR rules.
- **The real-user rack fixture** (§1.4) — the loader is testable; representativeness is not.
- **CPU under real load.** The §4 numbers are node-on-M5. Worklet-thread behaviour under a
  loaded rack is only observable in the browser, and the CI runner is not a proxy for a user's
  machine in either direction.
- **Host-tempo SLICE alignment** (phase 5) — quantum-granular by construction.

### 8.3 The rest of the gate set

- `per-module-per-port` + `behavioral` + `vrt.spec` auto-enroll the new module. Run those rows
  specifically, not just the suites they live in.
- **VRT baselines**: darwin renders locally; **linux must be dispatched** —
  `gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux`, **unscoped** (never
  `-f grep=`, which dies as `startup_failure`), and **verify the bot actually committed PNGs**.
  A green dispatch that committed nothing is a red flag, not a no-op.
- `task docs:accept` after the contract lands; the diff should show 79 lines removed
  (17 `callsine` + 62 `warrenspectrum`) plus the new module's lines. **State the exact delta in
  the PR.**
- `task test:ledger:accept` — regenerate, never hand-merge. Expect **23** rows to disappear
  (`callsine` 1, `warrenspectrum` 22) plus the new module's.
- **The two ratchets, lowered in the SAME commit** (§2.4): `STRICT_DOCS` **172→170**
  (`module-docs-lint.test.ts:273`) and `ART_BACKLOG_MAX` **46→44**
  (`profile-coverage.ts:120`, asserted *strictly equal* to the array length). Each gets a
  dated justification line in the existing comment block — "un-promotion via deletion", the
  same wording the 2026-07-07 15-module deletion used.
- **Run the deletion-sensitive unit files explicitly** before pushing, because they are the
  ones the earlier draft missed and none of them lives in a file named after a module:
  `patch-convenience-columns`, `rack-sizing`, `modules-card-map`, `module-docs-lint`,
  `contract-lock`, `oss-attribution`, `vrt-meta`, `audio-profile-gate`.
- `task typecheck` = 0 errors, full web unit lane (the CV-port registry gates only fail there).
- **Flake-check 3×** in separate processes for every new/changed test.
- **CI wall-time**: the new ART scenarios are the risk. Measure the delta; anything over
  ~2 min needs owner sign-off before merge. ⚠ Deleting 6 e2e/ART specs *reshuffles Playwright
  sharding*, which is how #1033 turned three unrelated specs red — expect it and do not read
  it as flake.

---

## 9. Open questions for the owner

1. **§2.5 — four capabilities die with the old `warrenspectrum`**: the `viz_out` video bridge,
   the 8-way per-band send/return insert matrix, harmonic-partial tuning, and the ping/vactrol
   excitation model. The VST design has homes for none of them. Are any of them wanted, or do
   they go?
2. **§4.3 — the 256-partial cap.** It is 4× the VST's own default (64) and 2× its default cap
   (128), but it is not 892. Acceptable?
3. **§6 — phase 1 is SPECTRAL only.** No filterbank means no stereo and no per-band routing on
   first ship. Acceptable, or should phase 1 wait for phase 2?
4. **§3.5 — fingerprint interchange.** Worth constraining our param ids to the VST's so
   `.wspr`/JSON patches move both ways? (It constrains **param** ids only — port ids stay ours,
   which is what makes §1.3.2's alias possible.)
5. **§1.3 — grace period.** Two minor releases for `RETIRED_TYPE_ALIASES`, then removal —
   matching how #1027 retired the video aliases (§1.1-C). Right length?
6. **§1.3 — the split migration.** `callsine` is **aliased** (4 of 10 ports survive with
   matching semantics); `warrenspectrum` is **dropped** (0 of 43). Confirm you would rather see
   an old warrenspectrum node **visibly absent** than present-but-empty at ⅕ the size running
   a different DSP. *(This is the one place the plan chooses data loss on purpose, so it should
   be an explicit decision, not an inference.)*
7. **§1.3.5 — the load-diagnostic UI.** It is scoped into phase 1 and it benefits **all 18
   previously-deleted types**, whose racks have been degrading through a `console.warn` since
   #1013. Confirm it ships here rather than being split into its own PR — splitting it means
   the deletion lands silent.
8. **§3.2.1 — SLICE.** The VST's declared `2..200 ms` is ~90 % unreachable and its host-sync
   grid does not engage below ~352 BPM. We can be **faithful** (port the clamps, ship a knob
   whose top 61 % does nothing) or **correct** (declare the live 5-21 ms range, fix the
   ceiling). "1:1 copy" points one way and a usable module points the other. Which?
