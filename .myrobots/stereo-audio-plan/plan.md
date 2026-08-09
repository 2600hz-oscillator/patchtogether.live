# Stereo audio normalization — implementation plan

> # ⚠ AMENDED 2026-08-07 — Q1 IS REVERSED. READ §0b BEFORE ANYTHING ELSE.
>
> The owner rejected the sum-to-mono policy: **"if we pass a stereo signal
> through a module which is, at present, mono, we do not want to lose the
> stereo data."** That invalidates decision **Q1** and the parts of **PR-3**
> and **PR-4** built on it. The architecture (projection / leg groups) SURVIVES
> — cables, ports, Y.Doc schema and migration story are untouched. What changes
> is what happens INSIDE a mono module. See §0b.

**Status: CORE COMPLETE 2026-08-09 — PR-0 through PR-4 are ALL on `main`. What remains is {PR-5, PR-6}.**
*(Table updated 2026-08-09 per this doc's own "keep this table current" rule; verified against the merge log, not against this doc.)*

| PR | state |
|---|---|
| PR-0 reconciler guard | ✅ **LANDED #1397** (2026-08-07) |
| ~~PR-1 rename~~ | ⛔ **STRUCK** — deferred to the faceplate work (§1a) |
| PR-2a per-channel taps | ✅ **LANDED #1402** (2026-08-07) |
| PR-2b pairing infrastructure | ✅ **LANDED #1404** (2026-08-08) |
| PR-3 leg-group planner | ✅ **LANDED #1407** (2026-08-08 — "ONE audio commit planner — every cable is a LEG GROUP, and stereo→mono keeps both channels") |
| PR-3b dual-mono engine wrapper | ✅ **LANDED #1408** (2026-08-08) |
| PR-4 THE FLIP (jack collapse + only-L/R menu + one bezier per leg group) | ✅ **LANDED #1409** (2026-08-08); follow-on **#1426** (2026-08-09) added per-leg patching — right-click any output, drill a stereo target into L/R, ES-9 jacks treated as mono points |
| PR-5 declared-pairs parity + attest batch | ⏳ backlog — not started, no open PR as of 2026-08-09 |
| PR-6 mixmstrs per-channel pan | ⏳ backlog — not started, no open PR as of 2026-08-09 |

**PR-2 was SPLIT into 2a (instrument) and 2b (pairing).** They share no files
and are independently reviewable; the plan's single PR-2 was two unrelated
concerns wearing one number.

*(The pre-2026-08-07 status line claimed "none of the 7 PRs has landed" and that
`reconciler.ts:143` was still unguarded. Both are now false — PR-0 fixed the
reconciler. Keep this table current; a stale status line here reads as fact.)*
Source: 12-agent ultracode analysis (8 subsystem surveys → 2 competing designs → adversarial + completeness critics), all findings verified against the actual code with file:line cites. Draft questions + owner answers recorded in §1.

## 0. Executive summary

Owner directive: all audio patch cables carry L&R; mono modules are "effectively stereo" via normalling (no new stereo DSP); right-clicking an audio output adds "patch only L" / "patch only R" (a stereo cable with one silent channel); mixmstrs gains per-channel panning; the Stereo VCA is renamed to **ringmod** (not deleted).

**Architecture: the PROJECTION (Option B).** Port ids, the `Edge` shape, the Y.Doc schema, `engine.addEdge`, and every module def's ports stay byte-identical. "One stereo cable" is a **leg group** of the existing per-channel edges, co-created / co-deleted by the wiring layer and rendered as one bezier. "Patch only L" writes exactly one leg. Pairing is derived centrally — declared `stereoPairs` ∪ the existing L/R id-token fallback, **audio-typed ports only**, minus named exemptions. Jack collapse happens **inside PatchPanel**, not per-card.

Why this wins (each alternative measured by the surveys):

- **Zero saved-rack migration** across all five persisted surfaces (file envelopes, live relay Y.Docs, Postgres `saved_groups`, `.ptperf.zip` bundles, committed fixtures). A legacy single-leg edge reinterprets as an only-L cable — audio byte-identical.
- **Zero engine/DSP changes** on the default path. Web Audio already carries N-channel on one connect; mono→stereo normalling = the double-patch both-legs pattern `planSendToMixer`/`planColumnChain` already ship (patch-convenience.ts:391, :564-584).
- **No collab re-attest** except the one PR that adds the `stereovca→ringmod` persistence alias; **no WebGL GPU re-attest** until the deliberately-quarantined PR-5.
- **VRT blast radius is ~20 PNGs (upper 40) of 426, not "every faceplate"** — canvas card faces (the 190 vrt.spec baselines) render NO visible jacks (corner-variant PatchPanel drill-down); only compact lane tiles, rear cards, the audio-io surface, and 2 interaction scenes shift, plus the stereovca→ringmod baseline rename.
- Option A (true port-id merge) was measured at ~2–3× total cost (contract-lock rewrite of ~35 modules, STRICT_DOCS re-key, registry schemaVersion 2→3, a new Edge field in the collab basis, a brand-new port-alias migration substrate) with **zero user-visible gain**.

**Difficulty: ~8–11 agent person-days, 7 PRs, ~10–12 CI cycles (~21–28 min each measured) + 1–2 vrt-update dispatches (~15 min/platform) + one local collab re-attest (~7 min, PR-1) + one trusted-GPU webgl re-attest (PR-5).** Riskiest step: PR-4 (the flip: leg-group semantics + jack collapse + VRT regen).

---

## 0b. DUAL-MONO — the 2026-08-07 amendment

### What was wrong

Q1 locked *unity-sum via double-connection*: a stereo leg group into a mono
input sums L+R. That is faithful to Eurorack and it is cheap, and it also means
**a stereo signal is destroyed the moment it meets a mono module** — everything
downstream carries the sum on both legs. "All cables carry L&R" would have been
cosmetic past the first filter.

**Measured blast radius** (from `contract-lock.txt`, the generated contract —
not a grep): of 86 modules with an audio path, **21 have exactly one audio
input**, and they are the pass-through spine of most patches:

```
delay  destroy  filter  reverb  vca  resofilter  rings  scaler  swolevco
wavecel  warrensspectrum  foxy  rasterize
moog902  moog904a  moog904b  moog904c  moog905  moog907a  moog914  moog923
```

(29 modules already take ≥2 audio inputs; 30 are sources with none.)

### The decision (owner, 2026-08-07)

**DUAL-MONO, unconditionally.** A mono module fed a stereo leg group runs its
DSP **twice** — one instance per channel, independent state — exactly as a DAW
instantiates a mono plugin on a stereo track.

**ALWAYS two instances. No "is the input really stereo?" detection.** The owner
was explicit: *"i want our purely mono sources to eventually go away so i don't
want to harden for them."* This removes the one genuinely dangerous piece —
a runtime heuristic deciding whether two legs "are the same signal" is exactly
the class of instrument that fails silently. There is no such heuristic.

**2× CPU on mono modules is accepted**, deliberately, by the owner.

### Shape of the implementation

A **generic wrapper in the engine**, not 21 module edits. When materializing a
mono-in module the engine builds the factory TWICE and presents one synthetic
handle:

- `ChannelSplitter(2)` at the audio input: ch0 → instance A, ch1 → instance B.
- `ChannelMerger(2)` at the audio output: A → ch0, B → ch1.
- Every **CV / non-audio input** port is a passthrough `GainNode` fanning to
  BOTH instances (one source may connect to two destinations), so a single LFO
  drives both channels identically.
- `setParam` fans to both. `dispose` tears down both.

No module factory changes, no DSP rewrites, and the 21 modules above need no
per-module work.

### Known sharp edges — settle these during implementation, do not discover them

1. **`read()` is single-instance.** Card meters/scopes reading through the
   handle would see instance A (left) only. Decide per read key: some want L,
   some want a sum, some want both. A silent L-only meter is exactly the
   instrument-blindness class this repo keeps getting bitten by.
2. **Side-effecting factories.** Any module whose factory writes `node.data`,
   claims a hardware port, or registers a singleton must NOT be duplicated —
   needs a named opt-out list, deny-by-default, ratcheted.
3. **Nondeterministic DSP decorrelates.** Two instances of a noise/random module
   produce different L and R. Often desirable (width), occasionally surprising.
   Name it per module rather than assuming.
4. **ART is mostly blind to this** (most scenarios drive DSP cores directly, not
   the factory path) — which means ART will NOT catch a dual-mono regression.
   The 6 real-def scenarios plus new e2e own this gate.

### Sequencing

Dual-mono becomes **its own PR between PR-3 and PR-4** (call it PR-3b): the
planner must know that a mono target still receives BOTH legs, so it lands with
the planner and before the visible flip.

### ⚠ PR-3b SPEC — "a generic wrapper, not 21 module edits" DOES NOT SURVIVE THE REGISTRY

Measured 2026-08-07 against the **live** `contract-lock.txt`, not the month-old
figures above. **Every count in §0b is wrong**, and more importantly the
*shape* is wrong: the mono-in set is not one homogeneous group that one wrapper
can serve.

| §0b claimed | actual |
|---|---|
| 86 modules with an audio path | **73** |
| **21** with exactly one audio input | **26** |
| 29 with ≥2 audio inputs | 27 |
| 30 sources with none | 20 |

§0b's list also omits five modules entirely: `dockscope`, `featurecv`,
`moog912`, `moog961`, `spectrograph` — and those five are exactly the ones that
break the generic story.

**The 26 split FIVE ways, and only the first can use the wrapper as designed:**

**A. 13 clean mono→mono pipes — the wrapper works verbatim.**
`delay destroy filter moog904a moog904b moog904c moog905 moog907a moog914
rasterize reverb scaler warrensspectrum`
One audio in, one audio out. `ChannelSplitter(2)` → two instances →
`ChannelMerger(2)`, exactly as §0b describes.

**B. 5 SINKS / ANALYZERS — must NOT be duplicated.**
`dockscope` (no outputs at all), `spectrograph` (→ 2× mono-video),
`featurecv` (→ cv,cv,gate,cv), `moog912` (→ cv,gate), `moog961` (→ 4× gate).
They consume audio and emit **CV / gate / video**. There is no audio merger to
recombine them, and **no defined answer to "which instance's CV wins"** — the
plan simply never considered a non-audio output. Duplicating also doubles an
FFT for zero benefit, and §0b sharp-edge 1 (`read()` is single-instance) means
the card would silently show **L only**.
→ **Single instance, fed the SUM.** For a meter/analyzer, summing L+R is the
*correct* reading, not a compromise.

**C. 3 FM / MODULATION inputs — duplicating is meaningless.**
`foxy.fm`, `wavecel.fm`, `swolevco.fm`. The audio-typed input is a modulation
input, not a signal path. Nobody wants two oscillators because a stereo LFO got
patched into FM.
→ **Single instance, fed the sum** (or L — decide, but do not duplicate).

**D. 5 MULTI-TAP outputs — the outputs are variants, NOT L/R.**
`vca` (audio + audio_inv), `moog902` (audio + audio_inv), `rings` (even/odd —
already `COLLAPSE_EXEMPT`), `moog923` (hp/lp/pink/white), `swolevco`
(mod_out/out/sum_out). Two instances × N taps = 2N streams for N declared
ports. **The merger story is undefined.** ⚠ NOTE `vca` — the single most
common module in any patch — is in this group, so this is not an edge case.

**E. 1 genuine mono→stereo generator.** `resofilter` (in `audio` → `out_l`/`out_r`).
It already widens; feeding it two legs and merging two widened pairs is
incoherent.

**What this changes about PR-3b:**

1. **Dual-mono needs a DENY-BY-DEFAULT LEDGER**, per CLAUDE.md's gate
   discipline — an explicit per-module classification (`dual-mono` / `sum` /
   `first-leg`), ratcheted both directions, anchored to the artifact so a module
   that changes port shape reddens. It is NOT "wrap everything with one audio
   input". §0b's own sharp-edge 2 already demanded an opt-out list for
   side-effecting factories; groups B–E make that list the *primary* mechanism
   rather than an exception.
2. **Groups B and C are decidable now** and I would decide them as above.
3. **Groups D and E need an OWNER CALL** — they change what `vca` and
   `resofilter` do to audio, which is not mine to choose. See the question
   below.

**OPEN QUESTION FOR THE OWNER (blocks group D, not the PR):**
> A stereo signal reaches `vca`, which has one audio input and two outputs
> (`audio` + `audio_inv`, an inverted copy — not L/R). Options: **(i)** treat
> D as group B — one instance fed the sum, so stereo collapses at a VCA;
> **(ii)** duplicate and pair the taps by index, so `audio` becomes L/R and
> `audio_inv` becomes L/R — doubling the declared port count, a contract
> change; **(iii)** per-module hand-treatment. Groups A–C can ship without
> this answer.

### ⚠ PR-3b AS BUILT — group A was 13 on paper and **7** in the DSP

Measured 2026-08-07 while implementing (`packages/web/src/lib/audio/dual-mono.ts`).
The spec above is right about the *shape* of the problem and wrong about group A's
*membership*, because it classified on the DECLARED PORTS and never looked at what
each module's audio path is actually made of. Two corrections and one omission:

| spec said | as built | why |
|---|---|---|
| group A = **13** | **7** wrapped | 4 of the 13 are already channel-transparent |
| 26 mono-in modules | **27** | `milkdrop` (domain=video) was filtered out |
| `rasterize`, `warrensspectrum` ∈ A | **deferred** | neither is a mono→mono pipe |

1. **4 of the 13 need NOTHING — they are already dual-mono, natively, at 1× cost.**
   `delay` (Gain→Delay→feedback Gain), `scaler` (one GainNode), `moog907a` and
   `moog914` (`buildFilterBank`: Gain → BiquadFilters → Gain). Native Web Audio
   nodes keep independent state per channel, so 2 channels in gives 2 channels
   out already. Wrapping them would have doubled the CPU of the most common
   time-effect in the app for **zero** behavioural change. They are classed
   `native-stereo` and the claim is a MEASUREMENT — all four are rendered with a
   genuinely different L and R in `art/scenarios/stereo-dual-mono/` and must come
   out still different, so the classification reddens if anyone drops a mono
   worklet into one of those paths.
2. **`warrensspectrum` is a group-E WIDENER, not a pipe.** Its worklet declares
   `outputChannelCount: [2]`, reads only `inputs[0][0]`, and equal-power PANS each
   band across L/R. It is resofilter's shape. Two instances would emit four
   channels for one declared port.
3. **`rasterize` is a HYBRID** — `in`(audio) → `thru`(audio) **and** `out`
   (mono-video). Duplicating gives two `RasterPainter`s competing for one video
   port; down-mixing collapses `thru`, which is a bare GainNode and therefore
   already channel-transparent. Both treatments are regressions, so it joins the
   D/E owner question.
4. **The population is 27, not 26.** The correction table above filtered on
   `domain=audio` and silently dropped `milkdrop`. It is classed `video-domain`
   (the VIDEO engine materializes it; the audio wrapper never sees it) and the
   gate asserts the population is NOT domain-filtered, because that filter is
   exactly the "a filter applied before the check redefines the check's subject"
   defect.

So the wrapped set is **`destroy filter reverb moog904a moog904b moog904c
moog905`** — the Faust mono worklets and the `outputChannelCount: [1]` ones.
No group-A module turned out to be side-effecting (sharp edge 2): none of the
seven writes `node.data`, claims hardware, or registers a singleton, and none
declares `read`/`write`/`videoSources` — which is now **enforced**, not observed
(the wrapper throws, and a source grep in the gate is the independent instrument).

**Two mechanism notes for PR-3/PR-4:**

- **An AudioParam CV input needs a fan, not a hand-off.** `destroy`
  (decimate/bits/wet) and `moog904c` (cutoff_cv) resolve to real AudioParams, and
  `addEdge` connects the CV source straight to `din.param`. Handing it instance
  A's param would leave the RIGHT channel unmodulated. A `ConstantSourceNode`
  with `offset = 0` re-emits whatever is connected to its offset as a signal,
  which fans into both real params — and keeps the engine's CV scaling and param
  tap on the normal path.
- **THE SEAM IS CLOSED — but it needed a SECOND mechanism, not a bigger one.**
  #1407 writes stereo→mono as TWO separate cables into the same mono port, and
  Web Audio sums two connections to one input. A handle's `inputs` map has ONE
  entry per port id, so a handle cannot express the difference; the decision is
  per-EDGE, in `AudioEngine.addEdge`.

  The wrapper's audio input is therefore **two** paths summed at a 2-channel
  bus, because each covers a case the other destroys:

  | arrives as | path | why the other path breaks it |
  |---|---|---|
  | 2-channel stream on ONE cable (what a dual-mono module emits → what CHAINS) | `mono` bus → `upmix` | a ChannelMerger INPUT is 1-channel by spec, so it would down-mix the pair away |
  | two cables from `out_l`/`out_r` (what `planAudioCommit` writes) | `legL`/`legR` → `ChannelMerger(2)` | a shared bus SUMS them, which is the failure dual-mono exists to prevent |

  `addEdge` picks with `legChannelOfEdge` — the SHARED derivation the commit
  planner itself uses, deliberately not a sixth private heuristic (#1404).
  `null` (neither endpoint paired) → the mono bus, so every existing cable is
  byte-identical.

  ⚠ **A ChannelMerger has the discrete zero-fill hazard in a different costume:
  an unconnected merger input renders as SILENCE.** A lone `out_l` would have
  gone left-only — the same bug as the up-mix one, on a different node, and the
  first fix would have re-introduced it. Two engine-controlled **mono normal**
  gains (`legL`→merger.1 and `legR`→merger.0) close it: OPEN by default, closed
  only once the opposite leg genuinely lands, and re-opened on unpatch. The
  failure direction is duplication, never silence. This is the Web Audio
  spelling of the `inputs[1]?.[0] ?? inputs[0]?.[0]` normal the DSP layer
  already uses (mono-normal-scan.ts).

  All five cases are pinned with REAL Web Audio in
  `art/scenarios/stereo-dual-mono/`, each with a live negative control:
  distinct-legs-stay-distinct (vs. placement-off, which must show the sum),
  lone-leg-reaches-both (both sides), mono-still-equal-and-non-zero, and
  chaining. `SCOPE.legPlacement` names the seam; `SCOPE.notHandled` now names
  only the true residual — a stereo source whose outputs are **not a derived
  pair** is invisible to the shared derivation and still sums, exactly as it
  does everywhere else in the app.

### Follow-up: option C, deferred by owner decision

Once B is shipped **and all UIs, VRTs and ARTs are updated**, revisit making
selected modules *genuinely* stereo rather than two independent copies —
`reverb` and `delay` are the obvious candidates, where real stereo DSP buys
cross-feedback and ping-pong that dual-mono cannot express. Per-module, on its
own merits, with owner ears. NOT part of this sequence.

---

## 1. Owner decisions (LOCKED, 2026-08-03)

| # | Question | Decision |
|---|---|---|
| 1 | ~~Mono-input consumption policy~~ **REVERSED 2026-08-07 — see §0b (DUAL-MONO)** | ~~**Unity-sum via double-connection** (both legs into the mono input; Web Audio sums). The planner special-cases a mono-source leg group into a mono input by writing ONE leg, so a correlated mono round-trip does not gain +6 dB. ART stays byte-identical.~~ |
| 2 | mixmstrs panning | **ADD per-channel pan: 8 params + a row of pan control knobs** on the card. New Faust DSP, contract + ART re-pin, explicit PUSH_CARD_CONTROLS entry, owner audio preview before merge. PR-6 is in scope. |
| 3 | stereovca | **KEEP. Rename to `ringmod` DEFERRED — owner, 2026-08-07: _"just leave it called stereovca for now, i don't want to touch that many files. we'll do it when we do the faceplate for it."_** Measured footprint: **44 files**. The rename is now a rider on that module's FACEPLATE work (phase 4), not a step in this sequence. PR-1 is struck (§3). Nothing downstream depends on it — see §1a. |
| 4 | Mixed-source stereo | **Leg-level occupancy**: a full-stereo patch replaces both legs of the target; an only-X patch replaces only the X leg — so A-only-L + B-only-R into one input coexist. |
| 5 | Look-and-feel | **Recommendations accepted**: dashed stroke + channel tag for only-L/R cables; unpatch-menu "(L only)" labels; one lane-rail dot per stereo port; rear card gets a single stereo hole (pair-tie retired). Pre-approved; PR-4 still posts a preview deploy as confirmation before the VRT dispatch bakes baselines. |
| 6 | Attest machine | **Available whenever needed.** PR-5 unblocked. Note the machine-access grant does not fix the 2 failing cameraInput tests (webgl-attest-video-orientation-camera-fail memory) — verifying/fixing those is the first task of PR-5. |
| 7 | CI cost | **Approved.** |

### 1a. PR-1 IS STRUCK — resequenced 2026-08-07

The rename was never load-bearing for stereo. Verified against the plan's own
dependency claims before dropping it:

- **PR-2/3/4 do not consume it.** They turn on *pairing* and *leg-group wiring*,
  which key off port ids and cable types. `stereovca`'s ports are unchanged by
  the rename by design (that is what made the type alias safe), so every list
  that mentions it — collapse exemptions, `STRICT_VRT_MODULES`, the per-port
  specs — simply keeps the current spelling.
- **The `strength_l`/`strength_r` decision survives verbatim.** They stay
  cv-typed and therefore stay two independent jacks (§1 defaults). That was
  always about the port TYPE, never the module name.
- **PR-0 was the prerequisite of the RENAME, not of the sequence** — and it has
  landed anyway (#1397), on its own merit: an unguarded `addNode` wedging every
  peer is a live hazard whether or not a type is ever renamed.

**Two consequences, both simplifications:**

1. **The sequence now carries NO collab re-attest.** PR-1 was the only
   basis-toucher (the `persistence.ts` alias). PR-2/3/4 touch no attest basis;
   PR-5 still carries the one WebGL re-attest.
2. **No `RETIRED_TYPE_ALIASES` entry, no live-relay alias seam, no ART key
   move, no VRT baseline rename.** The riskiest non-visual choreography in the
   whole plan is deferred with the rename.

New order: **PR-0 ✅ → PR-2 → PR-3 → PR-3b (dual-mono) → PR-4 → {PR-5, PR-6}.**

⚠ When the rename does happen with the faceplate, §3's PR-1 body is still the
correct recipe — including the trap that `ci.yml`'s behavioral-smoke grep and
`behavioral-smoke-subset.test.ts` must move in the SAME commit.

### Decidable defaults (locked with the above)

- **Only-L/R representation = single-leg edge**, never an Edge field: no Y.Doc schema change; the reconciler's id-only diff (reconciler.ts:153) and endpoint-derived edge-id collisions rule out a mutable `channels` field anyway.
- **Derived pairs apply to audio-typed ports ONLY.** ringmod's `strength_l`/`strength_r` are cv-typed → they stay two independent jacks, preserving independent per-channel gain/ring depth. (This is what keeps Q3's capability intact.)
- **Collapse exemptions** (semantic non-pairs stay two jacks): rings `['odd','even']` (two timbre taps — but it KEEPS its declared-pair autowire behavior, which is shipped and e2e-pinned at stereo-autowire.spec.ts:90; jack-collapse and autowire consult SEPARATE lists), scope ch1/ch2, synesthesia band outs, es9's 16 class-tagged hardware jacks (es9 `spdif_l/r` DOES collapse). Collapse includes: audioOut L/R, audioin, mixmstrs channel pairs + masterL/R + send pairs, qbrt, meowbox, ringback, cube, hypercube, wavesculpt, samsloop in-pair, ringmod in/out pairs, all 16 declared stereoPairs, 9 video-def pairs.
- **behavioral-smoke subset**: unchanged membership — rename `stereovca`→`ringmod` in ci.yml:2146's grep AND INTENDED_SUBSET (behavioral-smoke-subset.test.ts:58) in the SAME commit.
- **Old racks**: `RETIRED_TYPE_ALIASES { stereovca: 'ringmod' }` (persistence.ts:73-88) — identical port ids mean the alias keeps ALL cables on file/performance load. Live relay docs: PR-0's reconciler hardening prevents wedging; add a cheap registry/engine-level type alias so live 'stereovca' nodes materialize as ringmod too (decide exact seam at implementation — if it turns out invasive, fall back to skip-with-warning + optional elected-writer rename per the singleton-cleanup pattern).
- **ART capture labels keep their names**; stereovca ART scenario/baselines/fingerprint keys rename to ringmod → `task art:update` re-pin (content byte-identical, keys move).
- **No visible mono-policy param** on modules — policy is a wiring constant (avoids push-card re-ranking + contract churn).
- **VRT regen route**: ONE unscoped both-platform vrt-update dispatch (measured 14–16 min/platform, sequential).

---

## 2. Load-bearing facts (measured by the surveys)

- **Edge realization**: plain audio edge = one `sout.node.connect(din.node, sout.output, din.input)` at engine.ts:500; port handles are `Map<portId,{node,output/input}>` (engine.ts:37-40). Cross-domain bridges connect independently at engine.ts:1797/:1802/:1865.
- **`stereoPairs` today**: declared on 16 defs (naming inconsistent: `in_l`/`inL`/`audio_l`/`L`); consumed by stereo-autowire (both-defs-must-declare, stereo-autowire.ts:100-129), patch-convenience (declared → id-token fallback chain at resolveMainAudioOut :247), docs (contract-signature :113 "stereo l+r" lines, io-explain :143), column-reconcile, module-manifest (its `parseStereoPairs` regex at :1084 CANNOT parse mixmstrs' backtick-computed pairs — live doc-parity bug), registry manifest schemaVersion 2.
- **The registry doc-comment lies**: "engine virtually duplicates to R" — engine.ts contains ZERO stereoPairs/normalling code. Today a drag-patched mono→L leaves R silent unless the module normals internally or a convenience planner double-patched. Any plan assuming engine normalling would build on sand.
- **19 audio modules + 9 video modules have L/R pairs with NO declaration** — paired only by patch-convenience's id-token fallback (LEFT/RIGHT_WORDS, :82-86). A **fifth independent pairing heuristic** lives in rear-card-model.ts:178-189 (`pairWithPrev`) and must be unified.
- **Faceplates**: 208 cards; 188 import PatchPanel; 144 derive ports via `portsFromDef` (card-kit.ts:57) — collapse there is free. ~44 hand-build descriptor lists; MixmstrsCard hand-picks ids and `pickInputs` SILENTLY DROPS unknown ids (:62-88). WebGL-basis cards (CubeCard :996-998, HypercubeCard :816-818, WavesculptCard :2904-2905 hand-list L/R descriptors; FoxyCard :48-49 overrides labels "OUT L"/"OUT R") must stay byte-identical until PR-5 → **collapse must be implemented centrally in PatchPanel keyed on derived pairs, not by editing card files**.
- **Instruments are mono-blind**: AnalyserNode analyzes a mono downmix per spec. The terminal e2e audibility tap (audio-out.ts:138-142, `read('outputSnapshot')`) reads ~half-level for only-L and ~0 for anti-phase stereo — only-L vs only-R are INDISTINGUISHABLE on it. Per-channel taps must land BEFORE any only-L/R e2e. ~25 module files call getFloatTimeDomainData; ~8 e2e specs read outputSnapshot with level asserts that shift +6 dB once UI patches write both legs — sweep them.
- **ART is structurally blind to this change**: captures are 48 kHz MONO per label; only 6 scenarios use the real-def factory path; the rest drive DSP cores directly. The projection forces NO ART re-pin beyond the ringmod key rename — and ART can NEVER see the graph normalling policy; e2e must own that gate.
- **Persistence**: edges dead-drop on stale portId at file load (visible diagnostic); on live relay sync a deleted/unknown node type **permanently wedges every peer's reconcile** (unguarded engine.addNode throw at reconciler.ts:143 aborts the pass, re-throws every snapshot). Hardening is a hard prerequisite of the rename.
- **mike AI patching** writes audio edges via its own `ydoc.transact` (mike/driver.ts:79-105), bypassing all three Canvas commit paths — it must route through the leg-group planner or AI patches stay single-leg.
- **Canvas handleDelete (:4069)** deletes exactly the xyflow payload edge ids — with sibling legs deduped to one rendered edge, deletion must expand to the leg group or Backspace orphans a dashed only-R cable. Same for the wcol-detach branch (:4077).
- **CI**: required = typecheck+unit+ART+E2E umbrella (includes GATING webgl-attest) + vrt-strict. collab-attest is informational at PR time BUT behavioral-watchdog screams P0 on main for a stale collab hash — attest before merge. Measured green-run total 21–28 min; vrt-update 14–16 min/platform; concurrency cancel-in-progress punishes drip-pushing — batch pushes.
- **vrt-strict prediction**: strict faces are dock/corner variants that render no jacks → expected GREEN through the flip. VERIFY locally with `task vrt` before the first push (the two designs disagreed here; settle it with a measurement, not a belief).

---

## 3. PR sequence

### PR-0 — reconciler hardening (tiny, prereq)
Wrap the unguarded `engine.addNode` at reconciler.ts:143 in the same per-item try/catch as addEdge (:165-172): warn once per node id, record in a failed set, continue so later nodes/edges/params materialize. Unit test: snapshot with an unknown-type node + valid later nodes asserts the later ones apply and the failure logs once. reconciler.ts is in NO attest basis.
Gates: web unit lane; `REPEAT=3 task test:one -- reconciler`; typecheck. 1 CI cycle.

### ~~PR-1~~ — STRUCK 2026-08-07, deferred to the FACEPLATE work (see §1a)
*Kept verbatim below as the recipe for when it does happen — the registry-key
list and the ci.yml/behavioral-smoke same-commit trap are the expensive parts
to re-derive. It is NOT part of this sequence.*

### ~~PR-1 — rename stereovca → ringmod (+ persistence alias + collab attest)~~
The module survives with identical ports (`in_l/in_r/out_l/out_r` audio, `strength_l/strength_r` cv, level/offset params) and identical DSP; its identity becomes the ring modulator.
- **Files rename**: stereovca.ts → ringmod.ts (def `id`/`label` → lowercase `ringmod`; registration is glob-driven per #551 so the rename auto-registers), stereovca.test.ts → ringmod.test.ts, StereovcaCard.svelte → RingmodCard.svelte, packages/dsp/src/stereovca.ts → ringmod.ts. Re-author co-located `docs` as THE ring modulator (audio-rate unsmoothed multiply; strength_l/r stay independent cv jacks) — module stays in STRICT_DOCS (key renamed).
- **Alias**: `RETIRED_TYPE_ALIASES { stereovca: 'ringmod' }` in persistence.ts (identical port ids → alias keeps ALL cables); fixture test copying retired-type-migration.test.ts asserting edge survival. Live-doc story per §1 defaults.
- **Registry key renames** (same lines the deletion would have hit): module-manifest.ts DESCRIPTIONS :314 (new ring-mod prose) + PORT_NOTES :689-694; strict-docs.ts:142; modules-card-map.test.ts:54; interactive-doc-modules.ts:103; mike/catalog.ts:71 (out of `vcas`, into an fx/ringmod role); rack-sizes.ts:133 + rack-sizing.test.ts:121-124 (stays the 1u reference, key renamed); cv-scale-registry.test.ts:125 (PASSTHROUGH entry key); vrt-exemptions.ts:899 STRICT_VRT_MODULES; build_gallery.py:142; behavioral spec :888 param-override key; coverage-groups-3-4-5.spec.ts:721-756 (test SURVIVES renamed — keeps the independent per-channel strength-CV coverage); sidecar.spec.ts:151; docs-virtual-module.spec.ts:304; **ci.yml:2146 grep + behavioral-smoke-subset.test.ts:58 in the SAME commit**; docs prose: docs/testing/README.md:42, e2e/MODULE-COVERAGE-PLAN.md:110.
- **VRT**: `git rm` vrt.spec.ts stereovca.png (darwin+linux pair, gap-neutral); the renamed scene's baselines are MISSING → captured by dispatch or local darwin run (missing always writes). STRICT entry renamed keeps vrt-meta green only once baselines exist — capture in-PR.
- **ART**: rename art/scenarios/stereovca/ + art/baselines/stereovca/ → ringmod; fingerprint keys `stereovca/out_l|out_r` → `ringmod/...`; `task art:update` (content-identical, keys move; .sha last).
- Accept loops in order: `task docs:accept` (contract-lock: stereovca block → ringmod block) → `task art:update` → `task test:ledger:accept`. ONE batched push.
- **Attest**: persistence.ts is in the collab basis → run `task collab:attest` after the final source commit, as the last unmerged basis-toucher.
Gates: full local `task test` + `task art` from clean dsp dist; REPEAT=3 on renamed/edited specs. 1–2 CI cycles. Then `task pr:conflict-sweep`.

### PR-2 — instruments + pairing infrastructure (behavior-invisible) — ✅ DONE, as 2a + 2b

**(a) → PR-2a, LANDED #1402.** Per-channel terminal taps: `ChannelSplitter(2)` off the SAME post-limiter `tail` node feeding two analysers; read keys `outputSnapshotL`/`outputSnapshotR` beside the mono one. Measured blindness, in Chrome on the real default chain: **mono 0.15507, L 0.31015, R 0 — mono is exactly L/2**, so only-L and only-R were the same number. Red-first verified against four mis-wirings (both taps ch0, both ch1, swapped, pre-limiter).

> ⚠ **The plan said "Gates: unit lane" for (a). That was WRONG and structurally so.** `packages/web/vitest.config.ts` runs in `node` and does not pull in the audio module factories (they import WASM/worklet `?url` assets only Vite resolves). The test lives in **ART**, the only lane with `node-web-audio-api` + the `?url`→filesystem worklet seam. ART is a required check, so nothing is lost. A Chrome liveness leg rides `e2e/tests/workflow-mode.spec.ts` (no new page load) because ART cannot see a Chrome analyser that silently fails to be pulled and returns all-zeros — which would make every future only-L/R e2e **vacuous rather than red**.
>
> §2's tap cite `audio-out.ts:138-142` had rotted to ~199–203 / 238–242.
>
> **Side finding, load-bearing for PR-4:** the workflow **default chain is LEFT-ONLY** — a mono VCO into mixmstrs `ch1L` reaches AUDIO OUT's L and nothing else. The mono tap could never say so. Any PR-4 e2e that spawns the default chain and expects both channels is asserting something that is not true today.

**(b)(c)(d) → PR-2b, #1404.** `parseStereoPairs` computed-tuple fix (module-manifest.ts **:1100**, not :1084) + a deny-by-default manifest↔def parity gate; new `graph/stereo-pairs.ts` with `idWords`/`LEFT_WORDS`/`RIGHT_WORDS` lifted out of patch-convenience (which now imports them); `markStereoPairs` in **`lib/ui/workflow/rear-card-model.ts:179`** (the plan's `lib/ui/rear-card-model.ts` does not exist) rewired onto `derivedStereoPairs`. **59 derived pairs across 35 modules of 195 defs**, ratcheted both directions.

> ⚠ **`COLLAPSE_EXEMPT` needs ONE entry, not the four the plan listed.** Only `rings` odd/even is real. `scope` ch1/ch2, synesthesia band outs and es9's hardware ins **derive no pair at all** under audio-only + L/R-token, so listing them would have created stale exemptions — caught on day one by the artifact anchor. (`es9 spdif_l/r` does collapse, correctly; and es9 has **14** class-tagged ins, not 16.)
>
> ⚠ **`docs:check` does NOT move for (b).** `contract-lock.txt` reads the LIVE def and already carried all 10 mixmstrs pairs; the drift was confined to the doc-page manifest. No `docs:accept` needed.
>
> ⚠ **A LIVE BUG the plan did not know about:** `gamepad`'s **gate-typed** d-pad `dl`/`dr` (⬅/⮕) have been rendering a stereo pair tie on the rear card — two arrow buttons drawn as a stereo pair. The unification removes it. Rear-card blast radius is 3 modules (gamepad −1 tie, sidecar +1, audioIn +1), **none covered by a VRT baseline**.
>
> `stereovca`'s `strength_l`/`strength_r` cv exclusion was **verified, not assumed** — the audio-only rule handles it with no exemption. The rings autowire e2e is at **:92**, not :90.
>
> **Deliberate deviation:** `resolveVerboseLabel('out_l')` still returns `'OUT L'`. Changing it would be visible behaviour in a PR that promises none, and the collapsed jack does not exist until PR-4. The policy is recorded as data instead — `stereoPairStemId()` (`out_l`+`out_r` → `out` → `OUT`) — pinned for PR-4 to consume.

Gates as run: typecheck; FULL web unit suite (13 099 → 13 255 passed); `docs:check` no-op; REPEAT=3 on every changed file; no attest basis touched. **Measured CI delta ≈ +1 s** (8 ART tests, 259 ms; zero new e2e page loads).

### PR-3 — wiring semantics: universal leg-group planner

> ⚠ **THIS SECTION PRE-DATES THE Q1 REVERSAL. `stereo→mono` IS NO LONGER
> UNITY-SUM.** §0b replaced summing with **DUAL-MONO**, and the paragraph below
> was written against the old policy. Read §0b as authoritative wherever the
> two disagree. Restating the corrected matrix, because "unity-sum" appearing
> in an implementation section is exactly how a reversed decision gets built
> anyway:
>
> | source → target | what the planner writes |
> |---|---|
> | stereo → stereo | L→L, R→R (unchanged) |
> | mono → stereo | double-patch both legs (unchanged) |
> | **stereo → mono** | **BOTH legs, to a target the engine has wrapped DUAL-MONO** — two DSP instances, one per channel. NOT a sum. Nothing is mixed down. |
> | mono → mono | one leg (unchanged) |
>
> The old "mono-source-round-trip special case writing one leg" existed **only**
> to stop a correlated signal gaining +6 dB when summed. **Dual-mono never
> sums, so that special case has no reason to exist** — and keeping it would be
> worse than useless, since it is a runtime heuristic guessing whether two legs
> "are the same signal", which §0b explicitly rules out ("ALWAYS two instances.
> No 'is the input really stereo?' detection"). **Delete it; do not port it.**
>
> Consequence for sequencing: the planner must know a mono target still
> RECEIVES both legs, so **PR-3b (dual-mono) is what makes this true** — see
> §0b "Sequencing". PR-3 writes both legs; PR-3b makes the engine honour them.
> Between the two, a stereo→mono patch sums in the Web Audio graph as before.
> That window is why they land adjacently.

Generalize `planStereoAutowire` → the universal audio commit planner over derivedStereoPairs, per the corrected matrix above; `channelMode: 'both'|'left'|'right'` selects legs. Route ALL audio edge writers through it. **Leg-level occupancy** (Q4): full patch replaces both legs; only-X replaces only the X leg. Leg-group deletion expands to the group; "(L only)" label.

**Verified call sites (re-checked 2026-08-07 — GREP THE SYMBOL, the line numbers drift):**

| symbol | file | line (2026-08-07) | plan's original |
|---|---|---|---|
| `writeStereoSiblingEdge` | `packages/web/src/lib/ui/Canvas.svelte` | 3669 | :3641 |
| `handleConnect` | ″ | 3801 | :3773 |
| `handleDelete` | ″ | 4097 | :4069 |
| `commitCarriedEdge` | ″ | 6271 | :6243 |
| `pickPortMenuTarget` | ″ | 6352 | :6324 |
| wcol-detach branch | ″ | ~4125 | :4077 |
| `ydoc.transact` (AI patching) | `packages/web/src/lib/mike/driver.ts` | 79 | :79-105 ✓ |
| unpatch menu | `unpatch-menu.ts` / `UnpatchMenu.svelte` | — | — |

⚠ Two traps in that table. **The plan gave the wrong DIRECTORY** — it is
`lib/ui/Canvas.svelte`, not `lib/ui/canvas/Canvas.svelte`; the latter does not
exist, so a `grep` scoped to the wrong path returns nothing and reads as "the
symbol is gone". And every Canvas line had drifted **+28** (the file is 8849
lines and grew above 3641). All five symbols are intact — nothing was renamed
or removed. **Search by symbol name, never by line.**
Tests: stereo-autowire.test.ts rewritten (mandatory legs, only-L/R, leg occupancy, and the stereo→mono **dual-mono** policy — which gets its FIRST explicit assert anywhere; assert BOTH legs are written and that NO round-trip special case collapses them to one); patch-convenience{,-columns}.test.ts updated; schema-cleanup-roundtrip golden untouched (no Edge field change).
Gates: REPEAT=3 every changed unit file; e2e stereo-autowire.spec.ts rewritten (keeps the only full jack-click→carry→picker→commit e2e). NOT in any attest basis. Lands back-to-back with PR-4 (merge PR-3 only when PR-4 is ready for review, so main never sits long in the two-jacks-render-but-patch-writes-both state). 1–2 CI cycles.

### PR-4 — THE FLIP: jack collapse + only-L/R menu + cable rendering + VRT regen (riskiest)
- **PatchPanel-central collapse**: render one jack/row per derived pair, keyed on module type — card files pass their existing descriptors; PatchPanel merges pair rows. WebGL-basis cards (Cube/Hypercube/Wavesculpt/Foxy + video cards) stay BYTE-IDENTICAL; their faces still collapse because the collapse lives in PatchPanel. Both hidden xyflow handles remain co-located so either leg anchors.
- MixmstrsCard sections (:62-88): verify every hand-picked id survives (pickInputs drops unknowns SILENTLY — count rendered rows in a test); audit the ~44 hand-descriptor cards (17 reference L/R ids).
- AudioIoSurface.svelte:57,85 (workflow dock AUDIO I/O rows) collapse + only-L/R handling; RearCard.svelte:321 tie → single stereo hole (Q5).
- **PortContextMenu**: "patch only L"/"patch only R" rows when source is an audio output with a derived pair; `portMenuChannelMode` threaded into the commit paths; bind the currently-dead unpatched-output-row contextmenu on PatchPanel (:393) without fighting the patched-row unpatch menu. (Video/game raw-handle cards get the menu via the existing document-level contextmenu path — parity from day one since pairing is derived, not declared.)
- **Cable rendering**: flowEdges mapper (Canvas:2567) dedupes sibling legs to one rendered edge; single-leg gets `cable-left-only`/`cable-right-only` dashed class + channel tag (global.css:99-135); PickupCable ghost matched.
- **New e2e**: right-click → only-L → assert `outputSnapshotL` audible AND `outputSnapshotR` silent; inverted for only-R (PR-2 instrument; audio RMS, no frame waits). A leg-occupancy e2e: A-only-L + B-only-R coexist. Sweep the ~8 existing outputSnapshot-consuming specs for +6 dB threshold shifts.
- **Example patches**: audit/re-save ui/example-patches/*.imp.json (glitches.imp.json has 3 single-leg out_l→in_l edges that would render dashed) + e2e/fixtures/cold-load-patch.ptperf.zip.
- **VRT cycle** (drain-first discipline): run every affected scene locally on darwin, READ printed pixel diffs; classify over-tolerance (dispatch rewrites) vs under-tolerance-changed (`git rm` as darwin+linux PAIRS — the #1213 trap); drain the 5 pending linux EXEMPT_BASELINE_PAIRS in the blast set (dx7/qbrt/shimmershine/sixstrum/tomtom) + lower LINUX_DEFICIT_CEILING(148) + SHARED_LINUX_PAIR_CEILING(91) + `task test:ledger:accept` in ONE commit; preview deploy for owner confirmation (pre-approved Q5); push once; ONE unscoped both-platform `gh workflow run vrt-update.yml -f ref=<branch>` (never `-f grep`); approve `action_required` follow-ons; **COUNT bot-committed PNGs vs the local failure list**; revalidate close+reopen; merge on final-commit green. Apply the `behavioral` label pre-merge (6-shard lane runs before it can trip the push-only watchdog).
Gates: vrt-strict expected green (verify with local `task vrt` BEFORE first push); expected shift ~20 PNGs (upper 40). 2–3 CI cycles + 1 dispatch. Then conflict-sweep.

### PR-5 — declared-pairs parity + attest batch (UNBLOCKED per Q6)
First task: verify/fix the 2 failing cameraInput tests that block `task webgl:attest` (webgl-attest-video-orientation-camera-fail memory; parked since #979) — they are a test problem, not a machine-access problem, and Q6 grants the machine.
Then: declare `stereoPairs` on the 19 undeclared audio modules + add optional `stereoPairs` to VideoModuleDef + declare on the 9 video defs; clean Foxy/Cube/Hypercube/Wavesculpt card L/R descriptor rows and labels; deny-by-default lint: every L/R-token audio pair must declare stereoPairs or sit in the named opt-out list, ratcheted both directions; then shrink the id-token fallback in derivedStereoPairs toward declarations-only. Capstone items ride along: delete the then-unreachable id-token fallback branch in patch-convenience resolveMainAudioOut/In; io-explain prose sweep; memory updates.
Gates: `task docs:accept` (+~26 additive stereo lines, review per-module — beware precedence interaction: declarations enter resolveMainAudioOut ahead of the fallback; patch-convenience.test.ts:499-506 pins mixer behavior); trusted-GPU `env WEBGL_ATTEST_ALLOW_BUSY=1 task webgl:attest` as the LAST unmerged basis-toucher (kill 5173/4173 + clear node_modules/.vite first — stale-bundle false refusal). 1–2 CI cycles.

### PR-6 — mixmstrs per-channel pan (IN SCOPE per Q2)
New per-channel pan in packages/dsp/src/mixmstrs.dsp (equal-power law — reuse equal-power-pan.dsp's approach; pan placement: post-EQ/comp, pre-master sum) + 8 `pan1..pan8` params in mixmstrs.ts + **a row of 8 pan knobs** on MixmstrsCard + explicit PUSH_CARD_CONTROLS entry (new params re-rank the generic push card — pin it) + contract re-pin (`docs:accept`) + mixmstrs ART re-pin (`art:update`, entry-by-entry review; pan@center should be level-neutral — a moving entry NOT attributable to the pan law is a regression) + mixmstrs VRT baselines (card face changes: knob row) + **owner audio preview before merge** (level-affecting). 1–2 CI cycles + possible small vrt dispatch (can share PR-4's if sequenced adjacently, but keep the PRs separate — DSP + look changes both want isolated review).

---

## 4. CI fast-path summary

- Strict sequence PR-0 → 1 → 2 → 3 → 4 → {5, 6 in either order}. PR-2 and PR-3 can develop in parallel worktrees (cap 10, `task worktree:guard`) but LAND sequentially — they collide on module-manifest.ts/contract-lock/ledger.
- Front-load each PR exactly per repo discipline: `rm -rf packages/dsp/dist` + `task dsp:build` → `task typecheck` → full `task test` (all accept-loop gates live in the web unit lane) → accepts with reviewed diffs → `task e2e:serve` + targeted `REPEAT=3 task e2e:one/vrt:one` → `E2E_SWIFTSHADER=1` for renderer-dependent asserts → ONE batched push (cancel-in-progress).
- Attest choreography: PR-1 carries the only collab re-attest (persistence alias); PR-5 carries the only webgl re-attest. PR-0/2/3/4 touch NO attest basis — keep it that way during implementation and re-verify against the basis lists before each merge.
- Hazards: mass-PNG rewrite invalidates the lfs-vrt cache key (one-time giant LFS pull, no retry loop — the 502-incident shape); pre-regen informational vrt lane may hit its 20-min ceiling (acceptable; vrt-strict has 2× headroom); vrt-update bot pushes land follow-ons in `action_required` — approve, don't wait.

## 5. Migration story

Near-none, by construction. All five persisted surfaces load unchanged; legacy single-leg edges render as dashed only-L cables (audio-identical); legacy double-patched pairs render as one stereo cable. stereovca racks: `RETIRED_TYPE_ALIASES` renames the node and keeps every cable on file/performance load (identical port ids); live relay docs materialize via the registry-level alias (or skip-with-warning fallback per §1). Committed example patches are re-saved in PR-4 so shipped content doesn't render dashed.

## 6. Top risks

1. **PR-4 leg-group semantics** — occupancy, deletion, dedupe across three commit paths + mike. Mitigation: PR-3 lands the planner with exhaustive unit coverage first; the e2e rewrite keeps the only full click→commit flow gate.
2. **Sub-tolerance VRT invisibility** (#1213 class) — a removed jack dot « DOCK_MAX_DIFF commits nothing on a green dispatch. Mitigation: measure every affected scene locally; `git rm` pairs; count bot PNGs.
3. **MixmstrsCard silent id-filtering** — mitigations: row-count assert + the PatchPanel-central collapse minimizes card edits.
4. **Instrument blindness** — only-L/R e2e MUST use the PR-2 per-channel taps; never the mono downmix tap. Residual: non-terminal taps (scope, behavioral metric) stay mono-downmix — a dead-R inside a chain reads −6 dB, not failure, anywhere but the master out. Accepted + documented; revisit if it bites.
5. ~~**Unity-sum audibility edges**~~ **— RETIRED by the Q1 reversal (§0b).** Dual-mono never sums, so the +6 dB correlated-round-trip hazard and the special case that contained it are both gone. **Its replacement risks are different and worse to diagnose, so do not simply cross this off:**
   - **2× CPU on every mono-in module** (21 of them, the pass-through spine). Owner-accepted deliberately, but it is now a real perf surface: a patch with a long mono chain doubles its DSP cost. Watch for output underrun (`clock-perf-glitch-output-underrun` memory) rather than assuming a glitch is the clock.
   - **Nondeterministic DSP decorrelates** — two instances of a noise/random module give genuinely different L and R. Often desirable width, occasionally a surprise. Name it per module (§0b sharp edge 3).
   - **`read()` is single-instance** (§0b sharp edge 1): card meters/scopes read instance A (left) only. A silent-R inside a chain would be invisible on the card — the same instrument-blindness class the per-channel taps fixed at the terminal, now reappearing per-module. Decide per read key.
   - **Side-effecting factories must NOT be duplicated** (§0b sharp edge 2) — anything claiming a hardware port, writing `node.data`, or registering a singleton needs a named, deny-by-default opt-out list, ratcheted.
   - **ART is structurally blind to all of it** (§0b sharp edge 4): most scenarios drive DSP cores directly, not the factory path, so ART will NOT catch a dual-mono regression. The 6 real-def scenarios plus new e2e own this gate.
6. **mixmstrs pan** (PR-6) — new DSP on the most-connected module; pan@center must be bit-transparent or every mixmstrs ART entry moves. Gate: fingerprint diff attribution before re-pin + owner ears.

## 7. Verified-clean surfaces (do not re-sweep)

Control surfaces (push2/launchpad/electra/monome — port-blind; Launchpad "L/R" are device units), packages/server/src (byte-opaque), interactive docs hover panes, grand attest (grand-integration.attest.spec.ts already pins BOTH masterL/R legs at :330-331 — mandatory both-legs does not move the golden), PUSH_CARD_CONTROLS (ports are provably invisible to push-card ranking — only a new PARAM re-ranks; mixmstrs' new pan params in PR-6 are exactly that case and get a pinned entry).
