# Tile CV-motion investigation (owner ruling 9, 2026-09-03)

Read-only investigation. No product changes. Probes were throwaway scripts in
the session scratchpad against a local `task e2e:serve` dev server (headless
Chromium via the repo's Playwright, torn down after each run; `task e2e:stop`
run at the end).

## Verdict

**The face architecture is NOT the freeze.** ModuleShell passes the motorized
seam (`readLive={params.live(pd.id)}`) at every one of its seven param call
sites, the lane tile renders through the same `controlCell` snippet as the dock
(`ModuleShell.svelte:1828`), and a live measurement shows the shell lane tile
painting full-range CV motion for the same module and cable the legacy card
paints it for. What freezes is decided **per module by its CV-routing
convention**, and it freezes the legacy card and the shell tile **identically**
— the S2 impression "legacy moved, tile didn't" is two different module
classes (or a param outside the tile's ranked cells) being compared, not a
surface difference. Deliberate-vs-accident: **accident (a seam gap), shared by
both surfaces** — nothing in the design layer asks tiles to be still, and the
strict-faces prose explicitly sells promotion as making dead-to-CV cards "live
by construction" (`strict-faces.ts:2394-2401`, warrensvisions defect 1).

## Mechanism — the paint path, both sides

One seam, used by both surfaces:

- Control primitives poll `readLive` once per rAF while idle and paint that
  value: `Knob.svelte:52-56,159-179`, `KnobConic.svelte:145-162` (paints
  `aria-valuenow`, `--v`, `.ptr` rotate at :266-283), same pattern in
  `NeonFader/Toggle/Segmented/Selector/HueWheel/ParamGrid`.
- `readLive` comes from `cardParams().live(k)` → `engine.readParam(node, k)`
  (`card-kit.ts:130-135`). Legacy cards wire it by hand; ModuleShell wires it
  for every param cell (`ModuleShell.svelte:268-276` and
  `:1013,1035,1059,1119,1212,1236,1258`). Exceptions that pass no `readLive`:
  the `warped-fader` branch (`:970-985`), `XyPad`, `ColorField`.
- `AudioEngine.readParam` (`engine.ts:803-813`) returns
  `knobValues intrinsic + modulator-tap tail sample`. The tap is an
  `AnalyserNode` teed onto every **CV→AudioParam** edge at `addEdge`
  (`engine.ts:489-497`), keyed by `nodeId:portId` — but the readParam lookup
  keys by **paramId** (`engine.ts:807`).

That key mismatch partitions the fleet into three classes (all measured live,
LFO rate 2-5 Hz, depth 1, real `cv` cable types, engine booted):

| class | example | tap exists | engine.readParam | paint on legacy card | paint on shell tile |
|---|---|---|---|---|---|
| A: CV→AudioParam, port id == param id | qbrt `cutoff` (`qbrt.ts:214-222`) | yes, key matches | **moves** (span 19 968 Hz) | **moves** (span 19 968) | **moves** (span 19 968) |
| B: CV→AudioParam, port `x_cv` ≠ param `x` | clouds `position_cv`→`position` (`clouds.ts:595-600`) | yes, keyed `position_cv` | frozen (span 0; the tap itself is live, span 1.0) | frozen | frozen |
| C: CV→DSP signal input (Faust merger; no AudioParam) | filter `cutoff` (`filter.ts:64-90`) | none | frozen | frozen | frozen |

Parity holds column-for-column: **no case was found where the legacy card
paints motion and the face tile does not for the same module+cable.** The one
legacy card that hand-fixes class B — WavecelCard folding
`readModulatorTap(id,'morph_cv')` into its viz (`WavecelCard.svelte:190-194`)
— is carried onto the face as the same panel component
(`shell-cells.ts:1314-1317`), so even that motion survives promotion.

Two honest ways the S2 measurement produced its impression:

1. **Different modules compared.** The only e2e that asserts visible CV motion
   (`e2e/tests/lfo-modulation-visible.spec.ts`) runs qbrt + drummergirl —
   class A — and runs **legacy-only** (the `rack` fixture is
   `?shell=legacy`, `_fixtures.ts:91-93`). A class-B/C module probed on the
   shell against a class-A memory of legacy reads exactly as "tile frozen,
   legacy moved". Nothing asserts motion on the default shell surface at all.
2. **The tile ranks 2-3 cells** (`laneBodyPlan`); a modulated param outside the
   rank paints nothing on the tile no matter what — motion exists only in the
   dock. The engine audibly moves; the tile looks inert.

Class B's gap is old and documented-but-never-built: the comment at
`engine.ts:815-819` says the per-port tap is "used by PatchEngine.readParam to
fold in modulator samples" — `PatchEngine.readParam` (`engine.ts:2220-2222`)
does no such fold. The commit that added `readModulatorTap` (dfc8b9c8f, #120)
added it as a per-card workaround for wavecel instead of fixing the lookup.

Video domain, for completeness: the CV bridge writes a transient onto the
handle (`video/engine.ts:899-913`, the post-#719 render-local path) and
`VideoEngine.readParam` reads the handle — so video faces DO see modulation
through the same `readLive` seam, at bridge frame rate.

## Do the adjacent rulings forbid render-side motion? No.

- **CV-write-storm ruling** ("CV modulation must not write Y.Doc",
  `toybox.test.ts` guard): `readLive` polling **reads** the engine and writes
  a component-local `$state` — zero store writes, zero `ydoc.update`. The
  ruling constrains the write path, not the paint path.
- **VRT determinism**: face VRT scenes never boot the engine, and
  `cardParams.live` returns `undefined` → the control paints the committed
  param ("keeping the ungated VRT scenes at the deterministic defaults",
  `ModuleShell.svelte:400-409`). Motorized class-A knobs have shipped on both
  surfaces for months under this exact freeze. `simPin` covers video-frame
  determinism and is orthogonal to control DOM. **Caveat**: any VRT/e2e scene
  that boots audio AND patches CV would see a newly-alive knob if class B/C is
  fixed — those go through the existing `vrt-live-surfaces` registry
  discipline, not a new mechanism.

## Measured cost of animating tiles

Setup: default shell, 32 qbrt tiles (all in viewport; 131 ranked KnobConic
cells — note **every one already runs its own per-control rAF poll loop
today, modulated or not**) + 1 LFO at 5 Hz fanned into N `cutoff` cells.
Headless Chromium (120 Hz rAF), Apple-silicon dev machine, dev build. Values
are CDP `Performance.getMetrics` deltas per rAF frame over 5 s windows; two
sweeps agreed; all 32 knobs verified actually repainting under N=32.

| condition | task ms/frame | script ms/frame | style-recalc ms/frame |
|---|---|---|---|
| empty rack | 0.12 | 0.06 | 0.00 |
| 32 tiles, 0 modulated | 0.33-0.36 | 0.19-0.21 | 0.00 |
| 1 modulated | 0.64 | 0.21-0.23 | 0.03-0.04 |
| 8 modulated | 0.70-0.73 | 0.23-0.24 | 0.07 |
| 32 modulated | 0.95-1.20 | 0.31-0.39 | 0.18-0.21 |

Readings:

- **Marginal cost of full-rate motion on 32 visible controls ≈ 0.6-0.86
  ms/frame ≈ 4-5 % of a 60 Hz frame budget** on this machine (scale ×3-5 for
  a weak laptop and it is still single-digit ms). No long tasks, no frame
  drops (rAF held vsync throughout).
- The first animated control pays ~0.3 ms/frame (the per-frame Svelte flush +
  first style-recalc pass); each additional one ~10-18 µs/frame.
- The analyser read is free at this scale: `readParam` with a live tap
  micro-benched at **0.11 µs/call** (same as tap-less). The cost is DOM
  writes + style recalc, not Web Audio.
- The 131 standing poll loops (today's shipped behavior) already cost
  ~0.21 ms/frame of the baseline — the app pays most of the "motion tax"
  now, for stillness.
- **VideoTileThumb-style 15 fps throttle** (`VideoTileThumb.svelte:16,50`
  min-frame-gap pattern) applied to the motorized paint would cut the marginal
  cost to roughly a quarter (~0.15-0.25 ms/frame at 32 controls) — but at
  5 Hz modulation, 15 fps is only 3 paints per LFO cycle: legible as "alive",
  not as a waveform. Given full rate is already ≤5 % of budget, the throttle
  buys little on this hardware; its value is low-end headroom.
- **Memory constraint for class C** (`cv-shadow.ts:43-68`, measured there via
  CDP): each `AnalyserNode` tap permanently retains one Blink AudioHandler.
  Class A/B animate off taps the engine **already builds**; making class C
  live would mean a new tap per cabled Faust-CV port (+1 retained handler
  each) or Faust-side readback — a real cost the other classes don't pay.

## Options (owner picks)

1. **Fix the readParam fold (class B live everywhere, both surfaces).** In
   `AudioEngine.readParam`, when no tap is keyed by `paramId`, resolve the
   def's CV input whose `paramTarget` is this param and read that tap
   (`readModulatorTap` already exists; the tap already carries the
   cvScale-scaled signal, so `intrinsic + tap` is the correct combined value).
   Delete the stale comment at `engine.ts:815-819` or make it true. Cost: small
   engine diff; zero new analysers; zero doc writes; paint cost only where
   cables exist (table above); legacy cards get the same fix for free. Leaves
   class C (filter-style Faust merger CVs) honestly frozen — flag it in module
   docs, or pay the per-port analyser retention knowingly, per module.
2. **Option 1 + lane-tier throttle.** Same fold, plus the thumb-throttle
   (15 fps min-frame gap) in the poll loop when `view === 'lane'`, full rate in
   the dock. Cuts tile cost to ~¼ for low-end headroom; dock keeps smooth
   motion where the player is actually looking. Slightly more code; two
   cadences to reason about in VRT/e2e waits. (A larger, separable win exists
   here: 131 independent per-control rAF loops could ride the shared
   meter-frame tick instead — architecture cleanup, not needed for motion.)
3. **Declare stillness on tiles (motion only in the dock).** Withhold
   `readLive` when not `faceplateView`. Cheapest, VRT-safest — but it is a
   REGRESSION for class-A modules whose tiles move today, contradicts the
   "live by construction" design prose, and per the functional-parity ruling
   deletes a capability the legacy card has. Included for completeness; the
   evidence does not support it.

Not proposed as a gate (per the 2026-08-25 no-new-gates ruling), but worth the
owner knowing: `lfo-modulation-visible.spec.ts` covers motion on the legacy
surface only; if option 1/2 lands, a `rackDefault` twin of that spec inside the
same PR would be the shell-side regression hold.
