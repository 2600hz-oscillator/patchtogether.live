# DSP correctness bugs — owner decision needed (from blind analysis §7)

> **STATUS RE-VERIFIED 2026-08-04 against `origin/main`.** **Not one item below has
> been fixed.** Four are now **MOOT** because the module was deleted out from under
> them; **five are still fully open** and one (the CI schema) is partially addressed
> by an unrelated change. Per-item status is inline (`▸ 2026-08-04:`). Nothing here
> has been answered, so the document stands as written — it is a **pending decision
> record**, not a history, which is why it is kept intact rather than trimmed.
>
> | tier | item | 2026-08-04 |
> |---|---|---|
> | A | rbj-biquad `updatePeaking` Q not in cache key | **STILL OPEN** |
> | A | wavesculpt `master_gain` dead knob | **STILL OPEN** (and the shipped doc string is now false — see below) |
> | B | helm 7th voice silent + slot-leaked | MOOT — helm deleted |
> | B | elements `rawBuffer` never written | MOOT — elements deleted |
> | B | toybox `wouldCreateCycle` false-positive | **STILL OPEN** |
> | C | helm LFO/glide per-BLOCK | MOOT — helm deleted |
> | C | macrooscillator hihat phase-wrap DC latch | **STILL OPEN — needs your call** |
> | C | elements `setMeta` wrong clamp bound | MOOT — elements deleted |
> | — | CI applies an incomplete DB schema | **PARTIAL** — 005 was added, 002/003 still never applied |
> | — | relay silent-loss-on-final-store | **STILL OPEN** — the engineering call was never made |

The blind analysis found 7 verified DSP correctness bugs (all independently re-confirmed). I did NOT auto-fix them because **several change the sound of existing patches** — that's your call, not mine to ship silently. Sorted by risk so you can green-light per item. Reply with which to fix and I'll do each as a tested PR.

## Tier A — SAFE to fix now (no change to existing patches; I'll just do these unless you say stop)
- **`rbj-biquad.ts` `updatePeaking` Q not in cache key** — a Q-only change would return stale coefficients. *This is my own kick-drum code.* Zero behavior change today (both callers pass constant Q), pure latent-defect guard. One-line fix + a unit test that varies Q. **Recommend: fix.**
  - ▸ **2026-08-04: STILL OPEN.** `packages/dsp/src/lib/rbj-biquad.ts:56` is still `if (bq.k1 === fc && bq.k2 === dbGain) return;` — Q is a parameter of the function and absent from the guard.
- **`wavesculpt.ts` `master_gain` dead knob** — declared "overall output level" (0..2) but the bus gains are pinned to 1 and never read it; moving the knob does nothing. Fixing it wires the knob to the bus gain. Existing patches sit at the default — as long as I keep the default = unity (1.0), no existing patch changes; only someone who *moves* the (currently dead) knob is affected, which is the intended behavior. **Recommend: fix (default-unity, verified).**
  - ▸ **2026-08-04: STILL OPEN, and now worse.** `wavesculpt.ts:1038-1039` still pins `busL.gain.value = 1; busR.gain.value = 1;` with no `setParam` handler for `master_gain`. Meanwhile the param DID acquire a consumer — but a **video** one: `WavesculptCard.svelte:2352` feeds it to the `uMasterGain` shader uniform. So the knob is live on the picture and dead on the audio, while the shipped co-located doc string (`wavesculpt.ts:932`) still tells the user it is the "overall output level of the summed audio mix (L/R)". **That doc sentence is currently false** — a docs gate reading only the def cannot see it.

## Tier B — ADDS missing sound (currently silent/broken; fixing can only add, not alter existing intended output)
- **`helm.ts` 7th voice silent + slot-leaked** — `allocateVoice(8)` hands out 8 slots but render/free only cover 6, so the 7th held note is silent AND leaks its slot. Fixing makes 7+ note polyphony audible. Low risk (no one's relying on a note being silent). **Recommend: fix.**
  - ▸ **2026-08-04: MOOT.** `helm`, `polyhelm` and `hydrogen` were deleted in **#1013**; no `helm*` file exists in the tree.
- **`elements.ts` `rawBuffer` never written** — at low `space` (≤0.05) the aux channel is zeroed because the crossfade reads an all-zero buffer. Fixing restores aux audio at low space. Changes output only in the currently-broken (silent) region. **Recommend: fix, but it's an Elements/MI port so worth an ear-check after.**
  - ▸ **2026-08-04: MOOT.** `elements` was deleted in the 15-module purge **#1033**.
- **`toybox-combine-graph.ts` `wouldCreateCycle` false-positive** — a valid forward wiring is wrongly rejected as a cycle when a layer-input feedback edge exists first (video, not audio). Fixing lets a legal patch connect. **Recommend: fix.**
  - ▸ **2026-08-04: STILL OPEN.** `validateConnect` gained an exemption at `toybox-combine-graph.ts:940` — but it only exempts the edge **being added** (`!isLayerInputEdge(g, to, toPort)`). `wouldCreateCycle` (`:866-883`) still builds its adjacency from **all** of `g.edges`, so a layer-input feedback edge that is **already present** still closes a false cycle for the next forward wiring. That is exactly the reported case.

## Tier C — CHANGES existing patch sound (needs your explicit OK — do NOT ship without it)
- **`helm.ts` LFO + step-glide run once per BLOCK, not per sample (HIGH)** — every Helm LFO and glide runs **~128× too slow** (a "4 Hz" LFO is really ~0.03 Hz). Fixing makes them correct — i.e. every existing Helm patch's modulation suddenly runs ~128× faster. Huge audible change. Options: (a) fix + accept existing patches shift; (b) fix + rescale the rate param so the *knob* stays visually the same but now accurate; (c) leave as-is (the bug has effectively defined Helm's LFO feel). **Needs your call.**
  - ▸ **2026-08-04: MOOT.** helm deleted in **#1013**. The decision this asked for is no longer needed.
- **`macrooscillator.ts` hihat phase-wrap DC latch** — above ~5.4 kHz × ratio the square latches to DC, collapsing high-ratio partials. Fixing changes the hihat timbre at high pitch/ratio. **Needs your call (ear-dependent).**
  - ▸ **2026-08-04: STILL OPEN — this is the one Tier-C decision that is still live.** `HihatEngine.tick` (`packages/dsp/src/macrooscillator.ts:1038-1039`) is still the single-subtraction wrap `this.phases[i] += (freq*ratio)/sr; if (this.phases[i] >= 1) this.phases[i] -= 1;`, over `HIHAT_RATIOS` topping out at **8.21**. ⚠ **The identical pattern also sits at `:445-446` in a second engine** — whoever takes the decision should check whether that one is reachable at the same increments before fixing only the hihat.
- **`elements.ts` `setMeta` clamps to wrong bound** — at max strike it selects exciter model FLOW instead of the intended PARTICLES range. Fixing changes which exciter you get at the top of the strike knob. **Needs your call.**
  - ▸ **2026-08-04: MOOT.** elements deleted in **#1033**.

## Non-DSP, separately actionable (from other lanes)
- **CI applies only `001_init.sql`** (never 002_feedback / 003_saved_groups) → feedback + saved-groups DB paths are untested in CI. Safe infra fix, no product risk. **Recommend: fix (can auto-merge).**
  - ▸ **2026-08-04: PARTIALLY ADDRESSED, and the gap is now narrower than the headline.** All 14 schema-apply steps across the workflows now run `001_init.sql -f 005_rackspace_mode.sql`. `002_feedback.sql`, `003_saved_groups.sql` and `004_rack_update_journal.sql` all exist in `db/schema/` and are still **never applied in CI**. So the finding holds for 002/003/004; only 005 got picked up (and by a different PR, not this decision).
- **Relay silent-loss-on-final-store** — narrower than the blind report framed it (the swallow is deliberate crash-prevention; Hocuspocus re-stores on the next debounce while loaded). The real gap is the last-client-leaves final store. Fixing it trades crash-safety vs durability — **your engineering call**, worth a short discussion before I touch the deliberate crash-guard.
  - ▸ **2026-08-04: STILL OPEN.** `packages/server/src/db.ts:190-208` still swallows and still logs `persist FAILED (transient — relay stays up, will retry)`. The discussion this asks for has not happened.
