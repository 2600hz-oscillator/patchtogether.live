// packages/web/src/lib/audio/modules/clap.ts
//
// CLAP — analog-modeled handclap voice, the fourth member of the drum
// family (KICK DRUM / SNARE DRUM / TOM DRUM), at deliberately CURATED
// complexity: one synthesis engine, eight voice knobs + level, spanning
// the classic analog clap lineage in one continuous space:
//
//   808-canonical — band-passed noise through the twin-VCA topology: a
//                   3-pulse ~10 ms comparator retrigger burst (the final
//                   discharge rings 2× longer) + the smooth "reverb"
//                   envelope summed in. The shipping default.
//   909-dense     — 4-5 fast bright pulses, white digital-register noise,
//                   burst-forward: PULSES up, SPREAD down, TONE up,
//                   COLOR 0, SNAP up.
//   ClapTrap      — the Simmons 1980 clap box's adjustable spread:
//                   SPREAD long (each pulse its own micro-clap), WIDTH
//                   narrow for the tuned disco slap.
//   LinnDrum-era  — dark roomy sampled-clap read: COLOR up, TAIL long,
//                   SNAP low (room-dominant).
//
// DSP: packages/dsp/src/lib/clap-dsp.ts (seeded noise → COLOR pole →
// Chamberlin band-pass at TONE/WIDTH with ×√q loudness compensation →
// PULSES×SPREAD retrigger burst VCA + reverb-TAIL VCA fired at the last
// pulse, SNAP equal-power balance, 2×-oversampled warm-tanh DRIVE, DC
// block, true-peak bound). Mono voice, mono output.
//
// Trigger semantics (declared, per CLAUDE.md): trigger_in edge:'trigger' —
// ONE clap per rising edge (burst geometry + accent latched at that
// instant); per-sample edge-detect in the worklet. The card's CLAP pad
// writes the `strike` param (the bluebox press-param pattern) which the
// worklet ORs with trigger_in.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/clap.js?url';

import { createWorkletNode } from '$lib/audio/worklet-guard';
const PROCESSOR_NAME = 'clap';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const clapDef: AudioModuleDef = {
  type: 'clap',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'clap',
  category: 'sources',
  // Measured card box ≈ 200×460 px → 2u tall × 3 tiles wide (rack-sizes
  // rule: new modules declare size/hp on the def).
  size: '2u',
  hp: 3,

  inputs: [
    // The STRIKE: one clap per rising edge. Accent is read from accent_in
    // at that exact edge (per-hit latch), and the burst geometry (pulse
    // count + spacing incl. spread_cv) latches at the same instant.
    { id: 'trigger_in', type: 'gate', edge: 'trigger' },
    { id: 'accent_in',  type: 'cv' },
    // Per-knob CV for the voice's musical core.
    { id: 'tone_cv',    type: 'cv' },
    { id: 'tail_cv',    type: 'cv' },
    { id: 'spread_cv',  type: 'cv' },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    { id: 'pulses', label: 'Pulses', defaultValue: 3,    min: 2,   max: 5,    curve: 'discrete' },
    { id: 'spread', label: 'Spread', defaultValue: 10,   min: 4,   max: 25,   curve: 'log',    units: 'ms' },
    { id: 'tone',   label: 'Tone',   defaultValue: 1000, min: 400, max: 3000, curve: 'log',    units: 'Hz' },
    { id: 'width',  label: 'Width',  defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'tail',   label: 'Tail',   defaultValue: 150,  min: 30,  max: 800,  curve: 'log',    units: 'ms' },
    { id: 'color',  label: 'Color',  defaultValue: 0.15, min: 0,   max: 1,    curve: 'linear' },
    { id: 'snap',   label: 'Snap',   defaultValue: 0.5,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'drive',  label: 'Drive',  defaultValue: 0.2,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'level',  label: 'Level',  defaultValue: 0,    min: -24, max: 12,   curve: 'linear', units: 'dB' },
    // The card's manual CLAP pad (held 0/1; the worklet ORs it with
    // trigger_in — its rising edge fires exactly one clap).
    { id: 'strike', label: 'Clap',   defaultValue: 0,    min: 0,   max: 1,    curve: 'discrete' },
  ],

  // ── RACKLINE face (face batch 3 — the fourth drum-family voice, and the
  // SECOND PF-20 faceplate after kickdrum). UI CURATION ONLY, outside the I/O
  // contract — see ModuleFace in $lib/graph/types.
  //
  // WHAT THIS MODULE IS, in one sentence: TWO ENVELOPES ON ONE NOISE SOURCE.
  // A burst train of N hard onsets SPREAD ms apart, and a room tail that fires
  // at the LAST onset — not at the strike. Everything a player hears is the
  // interaction of those two, and the legacy card said none of it: nine peer
  // faders in three boxes, four of which change the same duration.
  //
  // ⚠ `order` and `pages` ANSWER DIFFERENT QUESTIONS. `order` is a PRIORITY
  // ranking for the tiers that show a SUBSET; `pages` is FUNCTION order for the
  // one tier that shows EVERYTHING. They disagree here on purpose.
  //
  // THE TIER LADDER, read back as a sentence (glyph 'scope' ⇒ mini 1 /
  // compact 2 / plate 6 — faceTierCap):
  //   mini    (1)   SPREAD — the identity knob, and the only control that
  //                 changes THREE quantities at once (onset spacing, each
  //                 pulse's own decay, and when the room starts).
  //   compact (2)   + PULSES. Spread is meaningless without knowing how many
  //                 hands land; the two together ARE the clap.
  //   plate   (6)   + SNAP, TONE, WIDTH, TAIL — the burst/room balance, the
  //                 band-pass pair, and the room's ring time.
  //   dock    (11)  everything, in the four bands below, under a hero.
  //
  // ⚠ WIDTH IS RANKED 5 BECAUSE ITS LOUDNESS BUG WAS FIXED (290dcdb5,
  // 2026-08-03). The face spec was written against the broken version, where
  // `1/√q` was applied on top of the band-pass's own `1/q` and WIDTH was an
  // 18.06 dB fader wearing a shape control's label. It is a shape control now:
  // measured on the real core at LEVEL −24 / DRIVE 0, RMS moves −44.33 →
  // −45.44 dB across the whole travel (1.11 dB) while Q sweeps 5.56 → 0.63.
  //
  // ⚠ THE AUDITION RANKS 7, NOT 6 — the kickdrum/tomtom precedent. A momentary
  // pad in a 46 px lane knob column is a bare glyph (laneBodyPlan's no-clip
  // guarantee is derived entirely from knob-column geometry), and rank 7 is
  // where the faceplate reads it anyway: hear it, see it, know what it is.
  // Reachability is not lost — the hero slot promotes it to the top of the
  // dock, which is where a voice that makes NO SOUND AT ALL until something
  // strikes it needs its pad.
  face: {
    order: [
      // ── the lane budget: ranks 1–6, and it ends HERE ──
      'spread', 'pulses', 'snap',
      'tone', 'width', 'tail',
      // ── dock-only tail, in FACEPLATE reading order ──
      // The audition heads it exactly as it heads the faceplate.
      'strike',
      // THE HERO PICTURE — the two-envelope graph. A panel's first legal rank
      // is 7 (module-face-lint fails any panel SELECTED at a lane tier: "a
      // 380px panel in a 46px knob column"), and it sits behind the audition
      // because that is the faceplate's own reading order.
      'clap-hero-{n}',
      // the bus, in DSP order
      'color', 'drive', 'level',
    ],
    // FUNCTION order: the four stages of the DSP, in the DSP's own order. Each
    // merge I considered fuses two different ideas — `noise` + `room` share
    // TONE but not a mechanism (one is the band, the other a pole downstream of
    // it), and merging `burst` + `room` would hide that SNAP is what balances
    // them, which is the module's whole design.
    //
    // ⚠ THE THREE PROMOTED KEYS ARE LISTED IN BAND 1, and they must be.
    // `face.hero` does not ADD a cell — it MOVES one, and `heroFacePlan` can
    // only move a key some band already claims.
    pages: [
      {
        id: 'burst',
        label: '1 · burst — the hands',
        hint: 'PULSES onsets, SPREAD ms apart; each decays over SPREAD, the last over twice that. Both numbers LATCH at the strike, so a hit’s geometry is fixed the instant the hands land.',
        controls: ['clap-hero-{n}', 'strike', 'spread', 'pulses'],
      },
      {
        id: 'noise',
        label: '2 · noise — the material',
        hint: 'one reseeded xorshift source through the COLOR pole (9 kHz → 700 Hz), then a band-pass at TONE whose Q is WIDTH — 5.6 down to 0.6.',
        controls: ['color', 'tone', 'width'],
      },
      {
        id: 'room',
        label: '3 · room — the tail',
        hint: 'fires at the LAST onset, one pole darker than the band, decaying over TAIL — the only envelope read LIVE every sample rather than latched at the strike.',
        controls: ['tail', 'snap'],
      },
      {
        id: 'out',
        label: 'bus · drive · out',
        hint: '2× oversampled tanh, a 20 Hz DC block, then LEVEL — which runs INTO the final clipper, not past it, so a hot level saturates rather than escaping the bound.',
        controls: ['drive', 'level'],
      },
    ],
    glyph: 'scope',
    // STRIKE is a PAD, not a value: the worklet ORs this param with trigger_in
    // and fires on the RISING EDGE, so the control must press-and-release. Its
    // ParamDef shape is IDENTICAL to a latching switch's, which is why the
    // intent is DECLARED here — and why the shell's press path writes the
    // ENGINE only, never the Y.Doc ($lib/audio/momentary-params: a rack must
    // not be saveable with the pad held down). graph/types.ts cites
    // "tomtom/clap `strike`" as the canonical example.
    momentary: ['strike'],

    // ── PF-20 — THE FACEPLATE STRUCTURE (dock-only) ──────────────────────
    title: 'Voice',
    hint:
      'Two envelopes on one band-passed noise source: a train of PULSES onsets ' +
      'SPREAD apart, and a room tail that fires at the LAST onset — not at the ' +
      'strike. SNAP crossfades them, and in doing so decides how long the whole ' +
      'voice is.',

    // THE HERO. SPREAD leads because it is the only knob that moves three
    // quantities; the pad rides beside it because this voice is SILENT until
    // something strikes it; the graph is what tells you what the voice IS
    // before you strike it.
    hero: {
      cell: 'clap-hero-{n}',
      control: 'spread',
      action: 'strike',
    },

    // REAR CARD curation (rear-card-model). Two curations, each a real
    // exception the derivation cannot see:
    //   * the leading band is renamed from the generic 'voice' to what its two
    //     holes actually DO — strike the voice, and weight that strike. Both
    //     are LATCHED at the same edge, which is why they belong together.
    //   * audioRate = the CVs that are genuinely read AND USED per sample.
    //     TONE_CV and TAIL_CV are (`clapToneHz`/`clapTailMs` are evaluated
    //     inside the per-sample loop with no smoothing on the node inputs), so
    //     patching audio into either is real modulation. SPREAD_CV is
    //     deliberately NOT ticked: the worklet reads it per sample but the core
    //     LATCHES it at the strike edge, so "audio-rate" would be a lie about
    //     the only jack whose value is consumed once per hit.
    rear: {
      groups: [
        { id: 'voice', label: 'strike · accent', ports: ['trigger_in', 'accent_in'] },
      ],
      audioRate: ['tone_cv', 'tail_cv'],
    },
  },

  // THE ONE BESPOKE CELL THIS FACE NEEDS — the two-envelope graph promoted into
  // the hero slot. Everything else the faceplate says (the chain, the presets,
  // the numbers) is DECLARED data the shared platform paints; a per-module
  // component for any of those is how faces drift apart.
  controlFamilies: [
    { id: 'clap-hero', label: 'Burst + room envelope', kind: 'cell', testidPrefix: 'clap-hero' },
  ],

  docs: {
    explanation:
      "An analog-modeled HANDCLAP voice that spans the classic clap circuits with eight curated knobs — TR-808 canonical, TR-909 dense, Simmons-ClapTrap spread, LinnDrum-dark are all corners of one continuous space, not presets. The model is the circuit every analog clap since the 808 has used, because a real clap is two palms' broadband impulse plus the ROOM: (1) a BURST of band-passed noise pulses — several hands landing milliseconds apart — retriggered PULSES times, SPREAD ms apart, each pulse decaying to −60 dB in exactly the spacing (the 808's quad-comparator sawtooth cycles) with the FINAL pulse ringing 2× longer (its uninterrupted last discharge), and (2) a separate smooth 'reverb' TAIL envelope summed in parallel — the fake room ring-out, fired at the last pulse and fed through one extra low-pass pole so the room sits darker than the crack. TONE places the band-pass center (the 808 sits near 1 kHz; the 909 near 1.14 kHz and brighter), WIDTH morphs the filter from ringy tuned slap (Q≈5.5) to broad splash with loudness compensation, COLOR darkens the noise source itself (white 909 registers → dark LinnDrum-era heft), and SNAP is the equal-power burst↔room balance (1 = bone-dry machine clap, 0 = room only). DRIVE is a 2×-oversampled warm tanh saturator, and the output stage ends in a true-peak bound so the voice never clips downstream. Recipes: 808 = the shipping defaults; 909 = Pulses 5, Spread ~5 ms, Tone 2.2k, Color 0, Snap up, Drive up; disco slap = Width near 0, Spread 15+; big dark room = Color 0.8+, Tail 500+, Snap 0.25. Strike it from any trigger/gate/sequencer source or the faceplate\'s CLAP pad; ACCENT makes a hit both louder and roomier, exactly like a harder clap.",
    inputs: {
      trigger_in:
        "The STRIKE: each rising edge fires one clap — the burst geometry (pulse count + spacing, including spread_cv) and the accent are latched at that instant, the noise source reseeds (every hit is bit-identical), and the pulse scheduler arms. How long the signal stays high doesn't matter; it's a trigger, not a hold. Patch a sequencer gate, drum-seq lane, or clock here.",
      accent_in:
        "Per-hit intensity CV (0..1), LATCHED at the strike edge only — between hits it's ignored, so an LFO here gives every hit its own velocity. An accented clap lands hotter (up to +80 % velocity ≈ +5 dB into the output bound, which compresses it musically) AND pumps the room disproportionately (up to +60 % tail excitation) — a harder clap is bigger, not just louder.",
      tone_cv:
        "Band-center CV: ±1.5 octaves per volt on TONE (multiplied, clamped 200 Hz–4.2 kHz) — a full ±1 V swing covers the knob's whole 400–3000 Hz range from the 1 kHz default (the house CV full-swing rule). Sequence it to alternate dark thuds and bright snaps from the same voice.",
      tail_cv:
        "Room-size CV: 2 octaves of TAIL time per volt — +1 V = ×4 tail, −1 V = ×¼ (clamped 15 ms–1.6 s), so ±1 V spans close to the knob's full 30–800 ms range. Ride it with an envelope or sequencer step to open the room up on the backbeat.",
      spread_cv:
        "Burst-geometry CV: ±1.3 octaves per volt on SPREAD (clamped 2–50 ms), LATCHED per hit at the strike edge — ±1 V covers the knob's whole 4–25 ms range, so a slow LFO here makes each clap's hand-timing subtly different (the Simmons ClapTrap's 'random spread' trick, deterministic).",
    },
    outputs: {
      audio_out:
        "The mono clap voice: burst + room tail through the drive and the true-peak output bound (|out| < 1 always, so it patches hot safely). Layer it a few ms behind a snare for the classic 909 backbeat, or run SNAP low for a pure room layer under a dry snare.",
    },
    controls: {
      pulses: "How many hands land (2–5 burst onsets, latched per hit). 3 = the 808's comparator cycles, 4–5 = the 909's denser 'T-T-T' machine burst, 2 = a tight flam. The last pulse always rings 2× longer (the final discharge) and hands off to the room tail.",
      spread: "Milliseconds between burst onsets (4–25, log, latched per hit). Short = one thick crack; the 808 sits at 10 ms; long reads as distinct micro-claps — the ClapTrap's spread into small-crowd 'applause' territory. Each pulse's decay time equals the spacing, so the sawtooth troughs stay deep at every setting. spread_cv adds ±1.3 oct/V.",
      tone: "Band-pass center (400–3000 Hz, log). ~1 kHz = the 808's palm-cavity resonance; up = the 909's brighter snap; down = a soft dark pat. The room tail tracks it one pole darker. tone_cv sweeps ±1.5 oct/V.",
      width: "Filter shape (0–1): 0 = ringy tuned slap (Q≈5.5 — the narrow disco clap that almost pitches), 1 = a broad noise splash. Loudness-compensated (the band trim scales with √q, normalised at the 0.5 default), so it changes the shape of the noise, not the volume: measured RMS moves 0.85 dB across the whole travel.",
      tail: "The room's −60 dB ring time (30–800 ms, log). The 808's fake-reverb envelope sits near 100–150 ms; short = a dry stage, long = a hall bloom. Fired at the LAST burst pulse so the crack stays articulated. tail_cv doubles/halves per volt.",
      color: "Noise color (0–1): a log-swept low-pass on the noise source from ~white (9 kHz pole — 909 shift-register bright) down to dark 700 Hz heft (the LinnDrum-era read), gain-compensated so dark stays loud. Upstream of the band-pass, so it tilts the whole voice including the room.",
      snap: "Burst ↔ room balance (0–1, equal-power): 1 = bone-dry machine-gun burst only, 0 = the room envelope only (a ghost clap / reverb layer), 0.5 = the classic 808 sum. This is the 'how close is the mic' knob.",
      drive: "Analog warmth (0–1): a 2×-oversampled warm tanh soft-clip on the summed voice. Low = clean; up = the crack fattens and the burst leans into the output bound instead of clipping — the 909-on-a-hot-mixer move.",
      level: "Output level in dB (−24..+12). The chain ends in a true-peak tanh bound, so a hot Level saturates musically rather than clipping the rack.",
      // ⚠ THE FINAL CLAUSE WAS FALSE and is corrected here.
      // packages/dsp/src/clap.ts does `Math.max(inTrig[s], strike)`, so while the
      // pad is held the combined line is PINNED HIGH and no incoming rising edge
      // can occur. tomtom documents the identical circuit correctly; this now
      // matches it.
      strike: "The manual CLAP pad: press to fire exactly one clap (the pad's press edge is the strike — holding it does not retrigger). Handy for dialing the voice in without patching a trigger source. It is OR-ed with trigger_in, which means that while you hold it the combined trigger stays high and incoming trigger edges are masked until you let go; released, it sits at 0 and is a no-op. The pad is sampled once per audio block, so a press lands on the next block boundary rather than the exact sample (2.67 ms at 48 kHz).",
      "clap-hero-{n}": "THE BURST + ROOM GRAPH — the picture of what this clap IS before anything strikes it. The filled spikes are the BURST train: PULSES onsets, the first at the strike and each one SPREAD ms after the last, every pulse decaying to \u221260 dB in exactly that spacing (the 808's comparator sawtooth) except the final one, which rings twice as long. The second, smoother curve is the ROOM \u2014 and where it starts is the whole point: it fires at the LAST onset, (PULSES \u2212 1) \u00d7 SPREAD after the strike, NOT at the strike, so at low SNAP this voice has a hard silent pre-delay that no control on the panel is named after. The two curves are scaled by \u221aSNAP and \u221a(1 \u2212 SNAP) \u2014 the equal-power crossfade \u2014 so the graph shows the balance you are actually hearing rather than two envelopes at full height. Everything is computed from the LIVE knob values through the worklet's own control laws (clapSpreadMs / clapPulseCount / clapTailMs), so the picture moves the instant you turn SPREAD, PULSES, TAIL or SNAP; it is not an illustration. The BURST / ROOM AT / VOICE readouts under it name what the picture shows \u2014 at the factory defaults 40 ms of burst, the room starting at 20 ms, and 170 ms of voice \u2014 and that last number is the one no knob can give you: turning SNAP to 1 removes the room entirely and the voice drops to 40 ms while the TAIL knob still reads 150 ms. The rendered length runs about 10\u201315 ms longer than the plotted envelope because the 20 Hz DC blocker has a tail of its own. The window button flips the plotted span for a long room that outruns the short view \u2014 a display setting, private to your screen: it is not shared with the rackspace and not saved with the patch. CV is not drawn: clap's tone/tail/spread jacks are worklet NODE INPUTS rather than AudioParam connections, so no host-side reader can see them, and every curve here is the knob position at cv = 0.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 5 audio-rate node inputs: trigger (0), accent (1), tone (2),
    // tail (3), spread (4). ONE mono output.
    const worklet = createWorkletNode(node, ctx, PROCESSOR_NAME, {
      numberOfInputs: 5,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and can be struck immediately) even
    // when nothing is patched yet. One ConstantSource, five connections.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 5; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of clapDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('trigger_in', { node: worklet, input: 0 });
    inputsMap.set('accent_in',  { node: worklet, input: 1 });
    inputsMap.set('tone_cv',    { node: worklet, input: 2 });
    inputsMap.set('tail_cv',    { node: worklet, input: 3 });
    inputsMap.set('spread_cv',  { node: worklet, input: 4 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['audio_out', { node: worklet, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
