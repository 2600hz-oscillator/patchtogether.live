# DSP correctness bugs — owner decision needed (from blind analysis §7)

The blind analysis found 7 verified DSP correctness bugs (all independently re-confirmed). I did NOT auto-fix them because **several change the sound of existing patches** — that's your call, not mine to ship silently. Sorted by risk so you can green-light per item. Reply with which to fix and I'll do each as a tested PR.

## Tier A — SAFE to fix now (no change to existing patches; I'll just do these unless you say stop)
- **`rbj-biquad.ts` `updatePeaking` Q not in cache key** — a Q-only change would return stale coefficients. *This is my own kick-drum code.* Zero behavior change today (both callers pass constant Q), pure latent-defect guard. One-line fix + a unit test that varies Q. **Recommend: fix.**
- **`wavesculpt.ts` `master_gain` dead knob** — declared "overall output level" (0..2) but the bus gains are pinned to 1 and never read it; moving the knob does nothing. Fixing it wires the knob to the bus gain. Existing patches sit at the default — as long as I keep the default = unity (1.0), no existing patch changes; only someone who *moves* the (currently dead) knob is affected, which is the intended behavior. **Recommend: fix (default-unity, verified).**

## Tier B — ADDS missing sound (currently silent/broken; fixing can only add, not alter existing intended output)
- **`helm.ts` 7th voice silent + slot-leaked** — `allocateVoice(8)` hands out 8 slots but render/free only cover 6, so the 7th held note is silent AND leaks its slot. Fixing makes 7+ note polyphony audible. Low risk (no one's relying on a note being silent). **Recommend: fix.**
- **`elements.ts` `rawBuffer` never written** — at low `space` (≤0.05) the aux channel is zeroed because the crossfade reads an all-zero buffer. Fixing restores aux audio at low space. Changes output only in the currently-broken (silent) region. **Recommend: fix, but it's an Elements/MI port so worth an ear-check after.**
- **`toybox-combine-graph.ts` `wouldCreateCycle` false-positive** — a valid forward wiring is wrongly rejected as a cycle when a layer-input feedback edge exists first (video, not audio). Fixing lets a legal patch connect. **Recommend: fix.**

## Tier C — CHANGES existing patch sound (needs your explicit OK — do NOT ship without it)
- **`helm.ts` LFO + step-glide run once per BLOCK, not per sample (HIGH)** — every Helm LFO and glide runs **~128× too slow** (a "4 Hz" LFO is really ~0.03 Hz). Fixing makes them correct — i.e. every existing Helm patch's modulation suddenly runs ~128× faster. Huge audible change. Options: (a) fix + accept existing patches shift; (b) fix + rescale the rate param so the *knob* stays visually the same but now accurate; (c) leave as-is (the bug has effectively defined Helm's LFO feel). **Needs your call.**
- **`macrooscillator.ts` hihat phase-wrap DC latch** — above ~5.4 kHz × ratio the square latches to DC, collapsing high-ratio partials. Fixing changes the hihat timbre at high pitch/ratio. **Needs your call (ear-dependent).**
- **`elements.ts` `setMeta` clamps to wrong bound** — at max strike it selects exciter model FLOW instead of the intended PARTICLES range. Fixing changes which exciter you get at the top of the strike knob. **Needs your call.**

## Non-DSP, separately actionable (from other lanes)
- **CI applies only `001_init.sql`** (never 002_feedback / 003_saved_groups) → feedback + saved-groups DB paths are untested in CI. Safe infra fix, no product risk. **Recommend: fix (can auto-merge).**
- **Relay silent-loss-on-final-store** — narrower than the blind report framed it (the swallow is deliberate crash-prevention; Hocuspocus re-stores on the next debounce while loaded). The real gap is the last-client-leaves final store. Fixing it trades crash-safety vs durability — **your engineering call**, worth a short discussion before I touch the deliberate crash-guard.
