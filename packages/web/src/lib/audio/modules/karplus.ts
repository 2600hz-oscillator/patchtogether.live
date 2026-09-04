// packages/web/src/lib/audio/modules/karplus.ts
//
// KARPLUS — an extended Karplus-Strong string / percussive-harp VOICE, built
// on the COFEFVE DELAY fundamentals (owner directive): the string loop is
// cofefve's own DelayChannel (packages/dsp/src/lib/analog-delay-core.ts —
// fractional ring buffer + Catmull-Rom cubic read + eased read pointer),
// imported by the pure core (packages/dsp/src/lib/karplus-dsp.ts) rather
// than re-implemented.
//
// The control set is CURATED from the literature and hardware lineage
// (Karplus & Strong 1983; Jaffe–Smith 1983 CMJ extensions; CCRMA EKS;
// Mutable Instruments Rings/Elements vocabulary): a strike excites a
// recirculating delay-line "string"; six voice knobs pick the string and
// how it's struck —
//   DECAY  — t60 in SECONDS, frequency-compensated (ρ = 0.001^(1/(f0·t60)))
//            so low notes don't ring 10× longer than high ones.
//   BRIGHT — loop damping low-pass whose cutoff TRACKS the note (the Rings
//            damping vocabulary): nylon/felt ↔ steel/glass at any pitch.
//   POS    — pick-position feedforward comb (β of the period): bridge-thin
//            ↔ hollow mid-pluck (β = 0.5 cancels even harmonics).
//   STIFF  — dispersion allpasses stretch upper partials sharp: piano-ish
//            stiffness into detuned bell/metallic.
//   COLOR  — exciter burst low-pass, 200 Hz felt mallet → 10 kHz hard pick.
//   BURST  — exciter length in PERIODS of the note: 0.1 = percussive tick /
//            mallet, 1 = classic K-S pluck, 4 = scraped/bowed attack.
//
// Trigger/gate semantics (declared, per CLAUDE.md):
//   trigger_in edge:'trigger' — ONE pluck per rising edge (burst reseeded,
//     accent latched). Per-sample edge-detect in the worklet.
//   damp_in edge:'gate' — level-sensitive palm mute: chokes the ring WHILE
//     high, releases on the falling edge (both-edge behavior).
//
// 1 V/oct: f0 = TUNE × 2^V. Fractional-delay tuning is compensated for every
// loop stage's exact phase delay at f0 — unit-gated at < 3 cents across
// C2–C7 (measured ≤ 0.1 cents) — so melodic sequences track for real.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { fireTrigger } from '$lib/audio/gate-trigger';
import workletUrl from '@patchtogether.live/dsp/dist/karplus.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'karplus';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const karplusDef: AudioModuleDef = {
  type: 'karplus',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'karplus',
  category: 'sources',

  inputs: [
    // The STRIKE: one pluck per rising edge; accent is read from accent_in
    // at that exact edge (per-hit latch), so the two ports work as a pair.
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    // 1 V/oct — transposes the whole voice as a frequency multiplier.
    { id: 'pitch',      type: 'pitch' },
    { id: 'accent_in',  type: 'cv' },
    // Level-sensitive palm mute (string damp / harp étouffé).
    { id: 'damp_in',    type: 'gate', edge: 'gate' },
    // Per-param CV for the curated voice controls (cofefve convention).
    { id: 'decay_cv',    type: 'cv', paramTarget: 'decay',      cvScale: { mode: 'log' } },
    { id: 'bright_cv',   type: 'cv', paramTarget: 'brightness', cvScale: { mode: 'linear' } },
    { id: 'position_cv', type: 'cv', paramTarget: 'position',   cvScale: { mode: 'linear' } },
    { id: 'stiff_cv',    type: 'cv', paramTarget: 'stiffness',  cvScale: { mode: 'linear' } },
    { id: 'color_cv',    type: 'cv', paramTarget: 'color',      cvScale: { mode: 'linear' } },
    { id: 'tune_cv',     type: 'cv', paramTarget: 'tune',       cvScale: { mode: 'log' } },
    { id: 'burst_cv',    type: 'cv', paramTarget: 'burst',      cvScale: { mode: 'log' } },
    { id: 'level_cv',    type: 'cv', paramTarget: 'level',      cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    { id: 'tune',       label: 'Tune',   defaultValue: 220, min: 55,   max: 1760, curve: 'log',    units: 'Hz' },
    { id: 'decay',      label: 'Decay',  defaultValue: 2,   min: 0.1,  max: 10,   curve: 'log',    units: 's' },
    { id: 'brightness', label: 'Bright', defaultValue: 0.7, min: 0,    max: 1,    curve: 'linear' },
    { id: 'position',   label: 'Pos',    defaultValue: 0.2, min: 0.02, max: 0.5,  curve: 'linear' },
    { id: 'stiffness',  label: 'Stiff',  defaultValue: 0,   min: 0,    max: 1,    curve: 'linear' },
    { id: 'color',      label: 'Color',  defaultValue: 0.6, min: 0,    max: 1,    curve: 'linear' },
    { id: 'burst',      label: 'Burst',  defaultValue: 1,   min: 0.1,  max: 4,    curve: 'log' },
    { id: 'level',      label: 'Level',  defaultValue: 0,   min: -24,  max: 12,   curve: 'linear', units: 'dB' },
  ],

  // THE PLUCK, declared as a control family (one member). It is the module's
  // defining affordance and it is NOT a param: `strike` as a ParamDef would
  // persist a one-shot 0/1 into the Y.Doc, add a ninth parameterDescriptor the
  // worklet does not have (karplus.test.ts pins descriptors 1:1 with these
  // params), and force an ART re-pin of both baselines through
  // art/scenarios/karplus/profile.test.ts's dspSourceSha. The audition is a
  // host-side ConstantSource fired through the factory's `manualTrigger` read
  // key below — it writes NOTHING to the graph.
  //
  // ⚠ IT IS A "FAMILY" ONLY BECAUSE THE PLATFORM HAS NO `face.actions` YET.
  // `face.order` can rank exactly three things — a param id, a control-family
  // template, or a numbered-legend static — and karplus has no legend file
  // (e2e/vrt/__annotated__ holds adsr/lfo/sequencer only). So a family of one
  // is the only key `order` can address. kickdrum reached the same conclusion
  // for the same reason (kickdrum.ts `kickdrum-strike`); when `face.actions`
  // lands, both retire and the contract loses two lines.
  controlFamilies: [
    { id: 'karplus-strike', label: 'Pluck', kind: 'other', testidPrefix: 'karplus-strike' },
  ],

  // ── RACKLINE face (UI curation only, NOT the I/O contract; see ModuleFace
  // in $lib/graph/types). Designed from what the module IS — a monophonic
  // plucked/struck STRING played from an external trigger — rather than
  // transcribed from the legacy card's fader bands.
  //
  // ⚠ `order` and `pages` ANSWER DIFFERENT QUESTIONS AND MAY DISAGREE. `order`
  // is a PRIORITY ranking, consumed by the tiers that show a SUBSET; `pages` is
  // FUNCTION order, consumed by the one tier that shows EVERYTHING. The PLUCK
  // ranks 7th and leads its band: rank 7 says "the lane cannot usefully paint
  // this", page-first says "when the band IS painted, this is what you reach
  // for". Do not "fix" one to match the other.
  //
  // THE RANKING descends from one sentence: karplus has no oscillator and no
  // envelope generator, so the note's shape IS the string losing energy. The
  // lane answers, in order, the questions a player asks about a struck string:
  //   1 DECAY  — how long does it ring? It is the ONLY envelope in the module.
  //   2 BRIGHT — what is it made of? Felt-damped nylon … ringing steel; and it
  //              is the one knob that can shorten a note behind DECAY's back
  //              (the loop-gain cap below BRIGHT ≈0.1 — see docs.controls.decay).
  //   3 TUNE   — which note, when nothing is patched to 1 V/oct. A SET-ONCE
  //              transpose in a rack: the note usually arrives on the pitch in.
  //   4 COLOR / 5 BURST — how it is struck: the exciter's tone and its length,
  //              the second-biggest character move (mallet ↔ pick ↔ scrape).
  //   6 LEVEL  — how loud the result is, which nothing else on the tile decides.
  //
  // WHY LEVEL IS IN THE LANE AND POSITION IS NOT — the one rank that moved, and
  // the argument is specific to this module, not "level goes last on every
  // face" (which is what this comment used to say, and it was generic reasoning
  // dressed as a rule):
  //   * `out` is tapped BEFORE the damping filter, the brightest point of the
  //     loop, and scaled by LEVEL alone (docs.outputs.out). Nothing in the
  //     module normalises loudness across settings, and the two knobs that
  //     cause the swing — DECAY and BRIGHT — are ranks 1 and 2 in the same
  //     tile (docs.controls.level: "a bright, long, hard-picked note is far
  //     hotter than a dark mallet thump"). A lane that can create the problem
  //     and not correct it is an incomplete performance surface.
  //   * POS is a feedforward comb on the EXCITER, so it colours each hit and
  //     not the ring-out (docs.controls.position), and its own CV prose asks
  //     for a per-step sample-and-hold rather than a hand on the knob
  //     (docs.inputs.position_cv). That is a sound-design choice, not a ride
  //     knob — rank 8, dock-only.
  //   * STIFF stays last: it ships at 0, so the knob is inert by default, and
  //     its travel LEAVES the instrument ("detuned metallic clang and bell").
  //
  // WHY THE PLUCK IS RANK 7 AND NOT RANK 1, though it is the defining
  // affordance. The reason is RENDER, and it is checked in the code, not felt:
  // ModuleShell paints an `action` cell as `label={view === 'dock-full' ?
  // cell.label : '▸'}` with no `cell-cap` outside the dock — an unlabelled
  // triangle in a 46 px column, named only by a title tooltip. Promoting it
  // buys a mystery glyph and costs LEVEL its slot; rank 7 buys a captioned
  // `pluck` Button under a band header that names it, one `shell-open-dock`
  // click away at every tier. Same call, same reason, as kickdrum's rank-7
  // `kickdrum-strike-{n}`. If ModuleShell ever captions lane action cells,
  // swap ranks 6 and 7 — that is the whole revert.
  //
  // ⚠ RANKS 7+ RENDER NOWHERE IN THE LANE. laneBodyPlan's plate is 3 cols × 2
  // whole rows = 6 cells (LANE_PLATE_MAX_CELLS), so rank 7 is DOCK-ONLY.
  //
  // GLYPH: 'scope' → a LIVE analyser trace on `out`. The legacy card showed
  // NOTHING; on a plucked voice the decay envelope IS the instrument, so the
  // trace is the most informative pixel budget on the tile AT MINI, COMPACT AND
  // AS THE DOCK HERO. ⚠ It is NOT painted at the `full` tier: six selected
  // cells ⇒ 2 plate rows ⇒ `glyph = hasGlyph && rows <= 1` is false
  // (module-shell-model.ts laneBodyPlan). The previous comment claimed the
  // glyph unconditionally.
  //
  // PAGES — TWO, not three. The old `out` band spent a whole ~88 px section on
  // ONE knob, which is the purchase the band mechanism exists to refuse (the
  // same merge kickdrum made for `dynamics · out`). Page 1 is THE STRING —
  // what rings, and for how long. Page 2 is EVERYTHING THAT IS NOT THE STRING:
  // the thing that hits it and what comes out. On a Karplus-Strong voice the
  // pick and the strike are one event — COLOR is the pick's tone, BURST its
  // length, POS where it lands — so `pick · strike · out` names one idea plus
  // the trim, not three ideas in a bag. (The tempting argument, that LEVEL
  // belongs here because the exciter settings cause the level swing, is only
  // half true: "bright" and "long" are page-1 knobs. Said plainly instead.)
  // Each page is also where its knobs' CV jacks land on the rear card.
  face: {
    order: [
      // hero ladder: mini = DECAY / compact = DECAY + BRIGHT + glyph
      'decay',
      'brightness',
      // the note, then the strike's own two knobs
      'tune',
      'color',
      'burst',
      // the trim for a voice nothing else normalises — ranks 1–6 END HERE
      'level',
      // ── dock-only tail, in FACEPLATE reading order ──
      'karplus-strike-{n}',
      'position',
      'stiffness',
    ],
    pages: [
      { id: 'string', label: 'string · ring', controls: ['tune', 'decay', 'brightness', 'stiffness'] },
      { id: 'pick', label: 'pick · strike · out', controls: ['karplus-strike-{n}', 'color', 'burst', 'position', 'level'] },
    ],
    glyph: 'scope',
    // REAR CARD curation (rear-card-model). The eight per-knob CVs need no
    // curation at all — each carries an explicit `paramTarget`, so every one
    // lands under its own face page in page-control order (TUNE/DECAY/BRIGHT/
    // STIFF under 'string · ring'; COLOR/BURST/POS/LEVEL under 'pick · strike
    // · out', LEVEL_CV having followed LEVEL out of the retired one-knob
    // 'output' band). Totality, counted: play 4 + string 4 + pick 4 = the 12
    // declared inputs, + the outputs rail's 1 = 13 holes, zero orphans, no
    // `cv` tail band. Two real exceptions the derivation cannot see:
    //
    //   * the leading band is renamed to what it DOES — the four holes that
    //     PLAY the instrument — and split into the two HANDS of playing a
    //     string, which is the actual grouping: the striking hand fires the
    //     pluck and weights it (accent is LATCHED at the trigger edge, so
    //     those two jacks are one gesture, not two), while the fretting hand
    //     chooses the note and palm-mutes the ring.
    //   * audioRate = `pitch` ALONE. The worklet reads the 1 V/oct input RAW
    //     per sample (packages/dsp/src/karplus.ts:150 — `p.pitchCv = inPitch ?
    //     (inPitch[s] ?? 0) : 0`, inside the per-sample loop; the knob CVs go
    //     through the 80 Hz WtParamSmoothers set up at :90-99)
    //     with the delay line's ~10 ms read-pointer ease as the only
    //     smoothing, so it is genuinely FM-able. Every KNOB CV goes through
    //     an 80 Hz WtParamSmoother one-pole before it reaches the DSP —
    //     a-rate on paper, control-rate in the ear — so ticking those would
    //     be a lie. trigger_in and damp_in carry their meaning in the ▲/▬
    //     edge glyphs, and accent_in is only read at the latch.
    rear: {
      groups: [
        { id: 'voice', label: 'play', ports: ['trigger_in', 'accent_in', 'pitch', 'damp_in'] },
      ],
      clusters: [
        { group: 'voice', label: 'striking hand', ports: ['trigger_in', 'accent_in'] },
        { group: 'voice', label: 'fretting hand', ports: ['pitch', 'damp_in'] },
      ],
      audioRate: ['pitch'],
    },
  },

  docs: {
    explanation:
      "A plucked/struck STRING voice — the extended Karplus-Strong algorithm, physical-modeling's original trick: instead of an oscillator plus filter, a short burst of noise is fired into a recirculating delay-line 'string' and everything you hear is that burst ringing around the loop, decaying naturally like a real vibrating string. There is no envelope generator anywhere in it: the note's shape IS the string losing energy. KARPLUS builds the loop on the COFEFVE DELAY's own fractional delay-line core and extends it the Jaffe–Smith/CCRMA way: the loop delay is tuned with sub-sample precision (1 V/oct is unit-gated under 3 cents across five octaves, C2–C7, at 44.1 and 48 kHz and with the tone knobs off their defaults — a naively rounded delay would be audibly sour above C5), and the per-period loop loss is frequency-COMPENSATED so the DECAY knob reads in real seconds at every pitch (classic K-S low notes drone for tens of seconds while high notes choke in milliseconds — fixed here). Six voice knobs then span the string and how it is struck: BRIGHT is the material (an in-loop damping low-pass whose cutoff tracks the note — felt-damped nylon to ringing steel), POS is where you pluck it (a comb filter: bridge-thin to hollow mid-string), STIFF bends the partials sharp toward piano wire, bells and gongs (dispersion allpasses), and COLOR + BURST shape the EXCITER itself — from a soft dark mallet thump (short, low-passed) through the classic pluck (exactly one period of noise) to a scraped/bowed attack (several periods of bright noise). It has no exciter of its own, so it needs a STRIKE: patch any trigger, clock or drum-lane gate (the PLUCK button — on the faceplate, and on the dock faceplate\'s pick/strike band — auditions one hit with nothing patched). ACCENT gives each hit its own velocity — louder AND brighter, latched at the strike edge — DAMP is a palm mute while held, and EVERY one of the eight knobs has its own CV input. One mono voice: patch several for chords, or clock it fast for harp arpeggios.",
    inputs: {
      trigger_in:
        "The STRIKE/pluck: each rising edge fires one excitation burst into the string. At that instant the burst noise is re-seeded (so hit N sounds bit-identical to hit 1) and the ACCENT input and BURST length are both sampled. How long the signal stays high doesn't matter — it's a trigger, not a hold. The string is NOT cleared first, so a still-ringing note is re-plucked on top of its own ring-over, exactly like a real string. Patch a sequencer gate, clock or drum-seq lane here; the PLUCK button on either surface fires the same pulse for auditioning.",
      pitch:
        "1 V/oct pitch input: transposes the whole voice as a true frequency multiplier (f0 = Tune × 2^volts, clamped to 30 Hz–4.2 kHz). Note that 0 V plays the TUNE knob itself (220 Hz = A3 by default), not a fixed C4 — this is a free-tuned voice, like a VCO's coarse tune. Tuning is compensated stage by stage, so melodic sequences from a quantizer/sequencer play in tune (measured ≤ 0.1 cents across C2–C7). This is the ONE input the DSP reads raw at audio rate — the delay line's ~10 ms read-pointer ease is the only smoothing on it, so slow moves glide like a slide guitar and fast ones are real FM.",
      accent_in:
        "Per-hit velocity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO or sequencer accent lane gives each pluck its own dynamics. A full-scale accent makes the hit both LOUDER (burst amplitude 0.55 → 0.95, about +4.7 dB) and BRIGHTER (COLOR is pushed +0.25 up its 0–1 scale for that hit only), which is what plucking harder actually does.",
      damp_in:
        "Palm-mute gate (level-sensitive): WHILE the level is high the string's decay collapses to ~50 ms — the ring chokes like a hand laid on a harp string — and on the falling edge the mute releases so the next strike rings freely again. Both edges matter: hold it to keep the string dead, pulse it to clip tails. Striking INTO a held mute still works and gives you a short muted-picking thunk, so a gate lane running alongside the trigger lane articulates the part.",
      decay_cv:
        "CV modulation of DECAY (log-scaled): ±1 multiplies or divides the ring-out time by 10 around the knob — from the 2 s default that is 0.2 s … 10 s. Sequence it to alternate staccato plinks with long ringing notes. Like all eight knob CVs it is smoothed by an 80 Hz one-pole inside the worklet, so it is a control-rate input, not an audio-rate one.",
      bright_cv:
        "CV modulation of BRIGHT (linear): ±1 moves the material ±0.5 up its 0–1 scale, so the pair of extremes spans the whole knob centred on your setting. A decaying envelope here mimics a real string whose tone darkens as it fades.",
      position_cv:
        "CV modulation of POS (linear): ±1 moves the virtual pluck point ±0.24 along its 0.02–0.5 travel — comb-filter animation like a player drifting between the bridge and the middle of the string. Sample-and-hold it per step for a different pluck point on every note.",
      stiff_cv:
        "CV modulation of STIFF (linear): ±1 moves inharmonicity ±0.5 up its 0–1 scale. From the 0 default a positive CV alone reaches 0.5 (piano-wire to early bell); raise the knob first if you want the full metallic zone under CV. Great per-step for alternating string and chime timbres.",
      color_cv:
        "CV modulation of COLOR (linear): ±1 moves the exciter's tone ±0.5 up its 0–1 scale — soft mallet strikes to hard bright picks under sequencer control. It only shapes noise WHILE the burst is being generated (a few ms), so in practice a change lands on the NEXT strike.",
      tune_cv:
        "CV modulation of TUNE (log-scaled): ±1 multiplies or divides the string's base pitch by √(1760/55) ≈ 5.66 — about ±2½ octaves each way around the knob, so the two extremes span the knob's full 55–1760 Hz range (clamped at the ends). An LFO gives vibrato, a sequencer plays melodic runs. Distinct from the 1 V/oct pitch input, and unlike it this one is smoothed at 80 Hz before the loop retunes.",
      burst_cv:
        "CV modulation of BURST (log-scaled): ±1 multiplies or divides the exciter length by √(4/0.1) ≈ 6.3 around the knob, morphing the attack from percussive tick to scraped/bowed. The length is LATCHED at the strike edge, so a change is heard on the next strike.",
      level_cv:
        "CV modulation of LEVEL (linear): ±1 moves the output gain ±18 dB around the knob (the two extremes span its full 36 dB range) — an envelope or LFO here gives the voice tremolo or dynamic swells.",
    },
    outputs: {
      out:
        "The string itself — the mono voice output, tapped straight off the delay line BEFORE the damping filter (the brightest point of the loop), scaled by LEVEL. Stability is proven rather than hoped: every loop mode above the fundamental is bounded below unity by the decay law, and an f0-tracked DC blocker inside the loop pins the lowest mode, so the line cannot run away or drift onto an offset at any knob setting. Feed it to a VCA/mixer or straight to an output — the voice's own envelope IS the string decay, no ADSR needed.",
    },
    controls: {
      tune:
        "TUNE — the string's base pitch (55–1760 Hz, log; default 220 Hz = A3). This is a coarse tune, not a keyboard reference: the pitch input multiplies it at 1 V/oct, so 0 V plays whatever TUNE says. Together they cover 30 Hz–4.2 kHz, where the voice clamps.",
      decay:
        "DECAY — ring-out time to −60 dB in SECONDS (0.1–10, log), frequency-compensated (the Jaffe–Smith ρ law): 2 s means 2 s at C2 AND at C6, instead of the classic Karplus-Strong behaviour where low notes drone and high notes choke. Short = plucked staccato/koto; long = open piano strings. ONE caveat, and it is audible: compensating a very dark string would need more loop gain than is safe, so the loop gain is capped. The full 0.1–10 s range is honoured down to BRIGHT ≈0.1 (the same threshold at every pitch); BELOW that the note decays SOONER than the knob says — at BRIGHT 0 the real ceiling is about 0.3 s at A3 and 0.07 s at A5. That is a heavily muted string, which cannot physically ring for ten seconds either. The DAMP gate overrides the knob entirely to ~50 ms while it is held.",
      brightness:
        "BRIGHT — the string material: an in-loop damping low-pass whose cutoff TRACKS the note (fc = f0 · 2^(0.5 + 5.5·knob), i.e. ≈1.4×f0 at 0 up to 64×f0 at 1), so the knob means the same thing at every pitch. 0 = felt-muted nylon, where even the 2nd partial is heavily damped; 1 = ringing steel/glass with a near-lossless top. Its phase delay at the fundamental is compensated in closed form, so moving this knob NEVER detunes the string. It does interact with DECAY at the dark end — below ≈0.1 the loop-gain cap shortens the note (see DECAY).",
      position:
        "POS — pick position β along the string (0.02–0.5): a feedforward comb on the exciter that subtracts a copy of the burst delayed by β of the period. 0.5 = plucked dead-centre: even harmonics cancel for a hollow, clarinet-ish pluck; small values = plucked at the bridge: thin, bright, all harmonics present. 0.12–0.25 is the natural guitar/harp zone. It shapes the EXCITER, not the loop, so it colours each hit rather than the ring-out.",
      stiffness:
        "STIFF — string stiffness/inharmonicity (0–1): two dispersion allpasses in the loop make upper partials run ahead of the fundamental, stretching them SHARP like real piano wire — and well past it. 0 = a perfectly harmonic string (the allpasses stay in the loop but become plain unit delays, so the knob is continuous with no topology switch); small amounts = piano realism; high values = detuned metallic clang and bell. The taper is set so the knob is audible at EVERY pitch, not just the top octaves — at A3 the third partial walks ≥ +45 cents sharp by full travel (unit-gated). Above ≈A5 the dispersion is capped at half the period so the loop stays tunable, which softens the effect on the very highest notes. The fundamental itself stays in tune at any setting: the tuning compensation accounts for the allpasses exactly.",
      color:
        "COLOR — the exciter's tone: a low-pass on the noise burst sweeping 200 Hz → 10 kHz exponentially (0 = soft felt mallet / thumb, 1 = hard pick / metal tine). Dark bursts put proportionally more energy into the string's lower modes, so the whole note sounds rounder — not just the attack. An accented hit pushes this up +0.25 for that hit only.",
      burst:
        "BURST — exciter length in PERIODS of the note (0.1–4, log). 0.1 = a near-impulse tick (percussive harp/marimba attack), 1 = the classic Karplus-Strong pluck (fills the string exactly once), 4 = a noisy scraped/bowed onset. Energy-normalized (1/√periods) so short ticks and long scrapes land at comparable loudness. Because it is measured in periods rather than milliseconds, the attack character stays consistent across the keyboard. The length is fixed at the strike edge, so it takes effect on the next hit.",
      level:
        "LEVEL — output gain in dB (−24..+12, default 0). The string loop is stability-bounded on its own, but nothing normalizes the voice's loudness across settings — a bright, long, hard-picked note is far hotter than a dark mallet thump, so use LEVEL to sit it in the mix or to drive a downstream stage. That is why it earns a lane rank on this module rather than sitting in the dock: the two knobs that cause the swing, DECAY and BRIGHT, are the two knobs beside it.",
      "karplus-strike-{n}":
        "PLUCK — the audition button: one strike, exactly as if a rising edge had arrived at trigger_in. karplus has no exciter of its own, so with nothing patched into trigger_in it is not quiet, it is MUTE — this is how you hear the string while you are dialling it in, which is most of the time you are dialling it in. Mechanically it is a host-side source summed into the same trigger input a cable feeds, fired through the shared trigger waveform, so it behaves identically to a patched sequencer gate: the burst noise is re-seeded, BURST length and accent_in are latched at that instant (unpatched accent reads 0, i.e. an un-accented pluck), and the string is NOT cleared first, so hitting it again over a ringing note re-plucks on top of the ring-over. It writes NOTHING to the patch — no param moves, nothing is shared with the rackspace, nothing is persisted or undoable — and a cable already patched into trigger_in keeps working while you use it (Web Audio sums the two, and the worklet edge-detects the crossing).",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 4 audio-rate node inputs: trigger (0), pitch (1), accent (2), damp (3).
    // One mono output.
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even
    // when nothing is patched yet. One ConstantSource, four connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(worklet, 0, 0);
    silence.connect(worklet, 0, 1);
    silence.connect(worklet, 0, 2);
    silence.connect(worklet, 0, 3);

    // Manual STRIKE (the PLUCK audition, fired from the card button AND the
    // RACKLINE face's `karplus-strike` action cell): a dedicated
    // ConstantSource summed into the trigger input, fired through the
    // SHARED $lib/audio/gate-trigger waveform (never re-derived). Works
    // whether or not a cable is patched into trigger_in — Web Audio sums
    // the connections, and the worklet edge-detects the crossing.
    const strikeCs = ctx.createConstantSource();
    strikeCs.offset.value = 0;
    strikeCs.start();
    strikeCs.connect(worklet, 0, 0);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of karplusDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['trigger_in',  { node: worklet, input: 0 }],
        ['pitch',       { node: worklet, input: 1 }],
        ['accent_in',   { node: worklet, input: 2 }],
        ['damp_in',     { node: worklet, input: 3 }],
        // Per-param CV → AudioParam routing (the cofefve convention).
        ['decay_cv',    { node: worklet, input: 0, param: params.get('decay')! }],
        ['bright_cv',   { node: worklet, input: 0, param: params.get('brightness')! }],
        ['position_cv', { node: worklet, input: 0, param: params.get('position')! }],
        ['stiff_cv',    { node: worklet, input: 0, param: params.get('stiffness')! }],
        ['color_cv',    { node: worklet, input: 0, param: params.get('color')! }],
        ['tune_cv',     { node: worklet, input: 0, param: params.get('tune')! }],
        ['burst_cv',    { node: worklet, input: 0, param: params.get('burst')! }],
        ['level_cv',    { node: worklet, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['out', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      // Manual STRIKE (the PLUCK audition — both surfaces): the samsloop
      // manualTrigger read-key seam — returns a function that fires one
      // canonical trigger pulse at the worklet, the same effect as a
      // trigger_in rising edge.
      read(key: string): unknown {
        if (key === 'manualTrigger') {
          return () => {
            try { fireTrigger(strikeCs, ctx.currentTime); } catch { /* */ }
          };
        }
        return undefined;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { strikeCs.stop(); } catch { /* */ }
        try { strikeCs.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
