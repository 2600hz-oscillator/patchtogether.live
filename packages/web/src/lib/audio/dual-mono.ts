// packages/web/src/lib/audio/dual-mono.ts
//
// DUAL-MONO — a module with ONE audio input runs its DSP TWICE, one instance
// per channel, so a stereo signal is not destroyed the first time it meets a
// mono module. Owner decision, 2026-08-07 (.myrobots/stereo-audio-plan/plan.md
// §0b): "if we pass a stereo signal through a module which is, at present,
// mono, we do not want to lose the stereo data." 2× CPU on those modules is
// accepted deliberately.
//
// There is NO "is the input really stereo?" heuristic. A runtime guess about
// whether two channels "are the same signal" is exactly the class of instrument
// that fails silently, and it is banned by name in the plan. A module is wrapped
// because of what it IS (its class below), never because of what is flowing.
//
// ── ⚠ THE HAZARD THIS FILE EXISTS TO AVOID ───────────────────────────────────
//
// `ChannelSplitter` is spec'd `channelCount = 2, channelCountMode = 'explicit',
// channelInterpretation = 'discrete'`, and DISCRETE UP-MIX ZERO-FILLS the
// missing channels. So feeding a 1-channel signal straight into the splitter
// gives instance B digital silence, the merger emits signal-on-L /
// silence-on-R, and EVERY EXISTING MONO PATCH BECOMES LEFT-ONLY.
//
// That is not hypothetical. It is the bug this repo already shipped and fixed:
// resofilter's silent right channel (plan §1b), then five more modules in
// #1343, all from `channelInterpretation: 'discrete'` zero-filling channel 1 —
// see `defeatReason()` in mono-normal-scan.ts, which greps factories for
// exactly that string. Doing it in the ENGINE would re-introduce it everywhere
// at once, and mono-normal-scan could not see it (it reads factories, not the
// engine).
//
// The fix is `upmix`: a GainNode pinned to `channelCount = 2,
// channelCountMode = 'explicit', channelInterpretation = 'speakers'` placed
// BEFORE the splitter. The speakers up-mix law DUPLICATES mono to both
// channels; a signal that is already 2-channel passes through untouched. By
// the time the splitter sees the stream it always has exactly 2 channels, so
// the splitter's own discrete law never converts anything.
//
// Measured against real Web Audio (node-web-audio-api, the ART lane), 1-channel
// 0.5 in:
//     speakers  → L 0.5  R 0.5     ← correct
//     discrete  → L 0.5  R 0       ← the bug, reproduced
// Both legs are asserted permanently in art/scenarios/stereo-dual-mono/, so the
// negative control runs on every ART lane rather than once at authoring time.
//
// ── SCOPE, STATED (asserted in dual-mono.test.ts) ────────────────────────────
// Read the `SCOPE` export. The headline limitation: this is an ENGINE seam.
// ART's `renderOfflineDef` and every unit test that calls `def.factory(...)`
// directly BYPASS it entirely, so neither can catch a dual-mono regression —
// the ledger gate and the ART stereo-dual-mono scenario own that.

import type { AudioModuleDef } from './module-registry';
import type { AudioDomainNodeHandle, AudioModuleFactory } from './engine';
import type { ModuleNode, PortDef } from '$lib/graph/types';

// ---------------------------------------------------------------------------
// The classification.
// ---------------------------------------------------------------------------

/**
 * What the engine does with a module that declares exactly ONE audio input.
 *
 * DENY BY DEFAULT: this is not "one audio input ⇒ wrap it". Every module in the
 * population is named individually with a written reason, and a mono-in module
 * that is NOT named here is RED (`auditDualMonoLedger().unclassified`).
 */
export type DualMonoClass =
  /**
   * Two instances behind an up-mix + `ChannelSplitter(2)`, recombined by a
   * `ChannelMerger(2)`. The DSP genuinely collapses a stereo stream to one
   * channel today, so duplicating it is the only way to keep both.
   *
   * ⚠ THIS CLASS ASSUMES THE DSP IS A DETERMINISTIC FUNCTION OF
   * (input, params). That is what makes "two instances fed one mono signal"
   * equal to "that signal on two channels". A DSP carrying its own entropy
   * belongs in 'mono-fanout' instead — see the measurement there.
   */
  | 'dual-mono'
  /**
   * ⚠ DECLARES DUAL-MONO, BUT IS ACTUALLY MONO. ONE instance, its audio input
   * DOWN-MIXED to (L+R)/2, and its single output FANNED to BOTH inputs of the
   * `ChannelMerger`. The module still emits a 2-channel stream at the same
   * per-channel level, so nothing downstream moves — but the two channels are
   * now the SAME SIGNAL BY CONSTRUCTION rather than by hope.
   *
   * ⚠⚠ DO NOT "SIMPLIFY" A MEMBER BACK TO 'dual-mono'. This class exists
   * because dual-mono rests on a premise that is FALSE for these modules:
   *
   *     dual-mono's premise — the DSP is a deterministic function of
   *     (input, params), so two instances fed one mono signal ARE that signal
   *     on two channels.
   *
   * A DSP that carries its OWN ENTROPY breaks that premise, and it breaks it in
   * the way this repo keeps getting bitten by: INVISIBLY ON A SCOPE, LOUDLY ON
   * EVERY METER. An `AnalyserNode` mono-down-mixes its input, and every level
   * surface in the app is a bare analyser tap — the faceplate `live-audio`
   * glyph and every `createLevelTap` VuMeter both. Two
   * same-amplitude sines with an arbitrary relative phase Δφ down-mix to
   * A·|cos(Δφ/2)|: a fresh draw on every spawn, not a measurement.
   *
   * MEASURED — moog904a self-oscillating (regeneration 1, range 2, cutoff 800),
   * 25 spawns rendered through THIS seam with the SHIPPING worklet
   * (art/scenarios/stereo-dual-mono/dual-mono-signal.test.ts, which re-measures
   * it on every ART lane rather than trusting this comment):
   *
   *     single leg            1.0622   every spawn, bit stable
   *     mono sum, built TWICE 0.0449 … 1.0592   (spread 1.0143)
   *     mono sum, built ONCE  1.0622   every spawn (spread 7.2e-7)
   *
   * The residual 7e-7 is the DSP's OWN spawn-to-spawn jitter — the dither is
   * still `Math.random()` inside the one instance — and no graph change removes
   * it. What IS exact is that L and R are the same samples.
   *
   * So ~30 % of spawns painted the meter at under half the true level while the
   * module was audibly ringing, and ~0.3 % read as near-silence — which is also
   * what parked `EXEMPT_OUTPUT_EMIT['moog904a.audio']` until this landed.
   * Owner ruling 2026-09-04, option (a): build it once and fan it.
   *
   * ⚠ THE COST, STATED RATHER THAN BURIED: a genuinely stereo signal patched
   * into one of these is COLLAPSED to its down-mix, where 'dual-mono' would
   * have filtered L and R separately. That is the deliberate trade — it is what
   * the real hardware mono unit does, and the thing it replaces was not a
   * stereo image either, it was two DECORRELATED channels. The cheaper-looking
   * alternative (share one dither stream between two instances) was ruled out:
   * it edits the DSP, and a DSP edit on this path costs an ART re-pin.
   *
   * ⚠ MEMBERSHIP IS A PROPERTY OF THE DSP, NOT A PREFERENCE. A module belongs
   * here only if its DSP carries a random source. Swept 2026-09-04 across
   * `packages/dsp/src/**` for `Math.random` / `getRandomValues`: of the seven
   * modules classed 'dual-mono', ONLY moog904a has one (destroy / filter /
   * reverb are Faust with no noise primitive; moog904b / moog904c / moog905 and
   * moog904a's own shared libs — moog-ladder-dsp, wavetable-osc — are clean).
   * The other DSP files that DO carry entropy back modules outside this
   * population entirely, where building twice never happens. If you are adding
   * a member here, re-run that sweep first.
   */
  | 'mono-fanout'
  /**
   * UNTOUCHED, because the module's audio path is built from native Web Audio
   * nodes (Gain / Delay / Biquad), which are per-channel by construction: a
   * 2-channel stream in gives a 2-channel stream out with independent filter
   * and delay-line state per channel. That IS dual-mono, natively, at 1× cost.
   * Wrapping these would be pure CPU for zero behavioural change.
   *
   * ⚠ This claim is a MEASUREMENT, not a reading of the source. Each of these
   * is rendered with a genuinely different L and R in the ART scenario and must
   * come out still different. If a future edit puts a mono worklet in one of
   * these paths, that test goes red and the module moves to 'dual-mono'.
   */
  | 'native-stereo'
  /**
   * SINGLE instance, audio inputs DOWN-MIXED to the sum (L+R)/2.
   *
   * Sinks, analyzers and modulation inputs. They emit CV / gate / video (or
   * nothing), so there is no audio merger to recombine two instances with and
   * NO DEFINED ANSWER to "which instance's CV wins" — and duplicating doubles
   * an FFT for nothing. For a meter, the sum is the CORRECT reading, not a
   * compromise; without the down-mix the analyzer would silently read L only,
   * which is the instrument-blindness class this repo keeps getting bitten by.
   *
   * The down-mix is a NO-OP for a 1-channel input (an explicit 1-channel
   * GainNode passes mono through unchanged), so no mono patch moves.
   */
  | 'sum'
  /**
   * UNTOUCHED, awaiting an owner call. Behaviour is byte-identical to before
   * this PR. Groups D and E of the plan's PR-3b spec: multi-tap outputs whose
   * taps are VARIANTS rather than L/R, and mono→stereo generators that already
   * widen. Both change what a very common module does to audio, which is not
   * an implementer's choice to make.
   */
  | 'deferred'
  /**
   * Has an audio input but is NOT materialized by `AudioEngine` — a
   * video-domain def, whose audio input is fed by the engine's video↔audio
   * bridge. The audio-domain wrapper never sees it, so classifying it anything
   * else would be a green gate over nothing.
   */
  | 'video-domain';

export interface DualMonoEntry {
  readonly cls: DualMonoClass;
  readonly why: string;
}

/**
 * THE LEDGER. One NAMED entry per module — never a filename, never a predicate.
 *
 * Anchored to the artifact: the population is derived from the LIVE registry
 * (`monoAudioInputTypes`), and an entry naming a module that no longer has
 * exactly one audio input is RED, exactly like a stale VRT exemption. A stale
 * entry is one nobody is watching.
 */
export const DUAL_MONO_LEDGER: ReadonlyMap<string, DualMonoEntry> = new Map<string, DualMonoEntry>([
  // ── dual-mono: the DSP really is mono, so run it twice ────────────────────
  ['destroy', {
    cls: 'dual-mono',
    why: "Faust MONO worklet — destroy.dsp is `process(audio) = …`, a 1-in/1-out "
      + 'DSP hosted by FaustMonoAudioWorkletNode. A second channel is discarded.',
  }],
  ['filter', {
    cls: 'dual-mono',
    why: 'Faust MONO worklet — filter.dsp is `process(audio, cutoffCv, resCv)`, one '
      + 'audio channel in, one out.',
  }],
  ['reverb', {
    cls: 'dual-mono',
    why: 'Faust MONO worklet — reverb.dsp is `process(audio) = …`. NOTE this makes '
      + 'the two channels two INDEPENDENT reverbs, not a true stereo reverb with '
      + 'cross-feedback; genuine stereo DSP for reverb/delay is the deferred '
      + 'option C in plan §0b, per-module and with owner ears.',
  }],
  ['moog904b', {
    cls: 'dual-mono',
    why: 'AudioWorkletNode declared `outputChannelCount: [1]`.',
  }],
  ['moog904c', {
    cls: 'dual-mono',
    why: 'AudioWorkletNode declared `outputChannelCount: [1]`.',
  }],
  ['moog905', {
    cls: 'dual-mono',
    why: 'AudioWorkletNode declared `outputChannelCount: [1]`.',
  }],

  // ── mono-fanout: declares dual-mono, but the DSP is NOT deterministic ─────
  ['moog904a', {
    cls: 'mono-fanout',
    why: 'AudioWorkletNode declared `outputChannelCount: [1]`, so it reads as dual-mono '
      + '— but the ladder bootstraps its self-oscillation from its OWN per-sample '
      + '`Math.random()` thermal dither (moog904a.ts), the ONLY random source in the '
      + 'one-audio-input population. Two instances therefore share a frequency and have '
      + 'INDEPENDENT phase, and every meter in the app is an AnalyserNode, which '
      + 'mono-down-mixes: A·|cos(Δφ/2)|, a fresh draw per spawn. Measured through this '
      + 'seam on the shipping worklet at regen 1 / range 2 / cutoff 800, 25 spawns — '
      + 'single leg 1.0622 bit-stable; built TWICE the mono sum ranged 0.0449…1.0592, '
      + 'built ONCE it is 1.0622 ± 7e-7 every spawn. Built once and fanned per the ruling '
      + 'of 2026-09-04 (option a): Δφ = 0 by construction, the meter reads the true '
      + 'level, and the module behaves like the real hardware mono 904A. ⚠ Do NOT '
      + 'reclassify to `dual-mono` to "restore stereo" — that restores DECORRELATION, '
      + 'not an image; and do NOT touch the dither, which costs an ART re-pin.',
  }],

  // ── native-stereo: already channel-transparent, at 1× cost ────────────────
  ['delay', {
    cls: 'native-stereo',
    why: 'Pure native graph — GainNode → DelayNode → feedback GainNode. A DelayNode '
      + 'keeps an independent delay line per channel, so a 2-channel stream comes '
      + 'out 2-channel with per-channel state. Wrapping would double the CPU of the '
      + 'single most common time-effect for no behavioural change.',
  }],
  ['scaler', {
    cls: 'native-stereo',
    why: 'A single GainNode. Channel-transparent by construction.',
  }],
  ['moog907a', {
    cls: 'native-stereo',
    why: 'buildFilterBank — a fan GainNode into BiquadFilterNodes into a summing '
      + 'GainNode. BiquadFilterNode keeps independent state per channel, so the bank '
      + 'is already per-channel.',
  }],
  ['moog914', {
    cls: 'native-stereo',
    why: 'buildFilterBank, as moog907a. (It also declares a `read` key for its level '
      + "meter, which is another reason not to duplicate it — see the read() note "
      + 'below.)',
  }],

  // ── sum: single instance, inputs down-mixed ───────────────────────────────
  ['dockscope', {
    cls: 'sum',
    why: 'Scope. NO outputs at all — a pure sink. Nothing to recombine, and the sum '
      + 'is what a scope should show.',
  }],
  ['spectrograph', {
    cls: 'sum',
    why: 'Analyzer → 2× mono-video. No audio output; duplicating doubles an FFT and '
      + 'leaves two competing video streams for one declared port.',
  }],
  ['featurecv', {
    cls: 'sum',
    why: 'Analyzer → cv, cv, gate, cv. No defined answer to "which instance\'s CV '
      + 'wins", and the loudness/brightness of the SUM is the correct reading.',
  }],
  ['moog912', {
    cls: 'sum',
    why: 'Envelope follower → cv, gate. Same as featurecv: the envelope of the sum is '
      + 'the reading a follower should give.',
  }],
  ['moog961', {
    cls: 'sum',
    why: 'Interface → 4× gate. Gate outputs cannot be merged into a stereo pair.',
  }],
  ['foxy', {
    cls: 'sum',
    why: 'The audio-typed input is `fm` — a MODULATION input, not a signal path. '
      + 'Nobody wants two oscillators because a stereo LFO got patched into FM. '
      + '(foxy already emits its own out_l/out_r pair.)',
  }],
  ['wavecel', {
    cls: 'sum',
    why: 'The audio-typed input is `fm` — modulation, not a signal path. Already '
      + 'emits out_l/out_r.',
  }],
  ['swolevco', {
    cls: 'sum',
    why: 'The audio-typed input is `fm` — modulation, not a signal path.',
  }],

  // ── deferred: owner call pending (plan §0b groups D and E) ────────────────
  ['vca', {
    cls: 'deferred',
    why: 'GROUP D. Two audio outputs (`audio` + `audio_inv`) that are VARIANTS, not '
      + 'L/R — two instances would give 2N streams for N declared ports and the '
      + 'merger story is undefined. ⚠ vca is the single most common module in any '
      + 'patch, so leaving it EXACTLY as it is today is the deliberate choice for '
      + 'this PR, not an oversight. Blocked on the plan §0b owner question.',
  }],
  ['moog902', {
    cls: 'deferred',
    why: 'GROUP D — the ladder amplifier, `audio` + `audio_inv`, exactly as vca. Same '
      + 'undefined merger story, same owner question.',
  }],
  ['rings', {
    cls: 'deferred',
    why: "GROUP D — `even`/`odd` are different TIMBRES (odd vs even partials), which "
      + "is why they are already the sole COLLAPSE_EXEMPT entry in stereo-pairs.ts. "
      + 'Not an image pair, so pairing two instances by tap index is meaningless.',
  }],
  ['moog923', {
    cls: 'deferred',
    why: 'GROUP D — hp / lp / pink / white are four independent taps.',
  }],
  ['resofilter', {
    cls: 'deferred',
    why: 'GROUP E — already a genuine mono→stereo widener (`audio` → `out_l`/`out_r`). '
      + 'Feeding it two legs and merging two widened pairs is incoherent.',
  }],
  ['warrensspectrum', {
    cls: 'deferred',
    why: 'GROUP E, and NOT the clean mono→mono pipe plan §0b listed it as. Its worklet '
      + 'declares `outputChannelCount: [2]`, reads ONLY inputs[0][0], and equal-power '
      + 'PANS each band across L/R — i.e. it is a widener like resofilter. Two '
      + 'instances would emit four channels for one declared port.',
  }],
  ['rasterize', {
    cls: 'deferred',
    why: 'HYBRID, and also NOT the clean mono→mono pipe plan §0b listed it as: `in` '
      + '(audio) → `thru` (audio) AND `out` (mono-video). Duplicating gives two '
      + 'RasterPainters and two competing video streams for one port; down-mixing '
      + "would COLLAPSE `thru`, which is a bare GainNode and therefore already "
      + 'channel-transparent. Both available treatments are regressions, so it is '
      + 'untouched and joins the group-D/E owner question.',
  }],

  // ── video-domain: not materialized by AudioEngine at all ──────────────────
  ['gibribbon', {
    cls: 'video-domain',
    why: '`domain: video`. The audio-driven Vib-Ribbon-spirit game (2026-08-29 '
      + 'redirect): ONE mono `audio_in` feeds the module\'s own AnalyserNode '
      + '(the graphicEq shape — the VIDEO engine materializes it and the '
      + 'audio arrives over the video↔audio bridge into `audioInputs`), which '
      + 'the module folds into four musical bands to derive the course. The '
      + 'input is an ANALYSIS TAP, deliberately mono like the original '
      + 'game\'s CD analysis — a stereo pair would add nothing the '
      + 'relative-prominence extractor could use.',
  }],
  ['milkdrop', {
    cls: 'video-domain',
    why: '`domain: video`. Butterchurn visualizer with one audio input and a video '
      + 'output; the VIDEO engine materializes it and the audio arrives over the '
      + "engine's video↔audio bridge, so the audio-domain wrapper never sees it. "
      + 'Plan §0b\'s corrected count of 26 silently dropped it by filtering on '
      + 'domain=audio; the real population is 27.',
  }],
]);

// ---------------------------------------------------------------------------
// The ARTIFACT — derived from the live registry, never from the ledger.
// ---------------------------------------------------------------------------

/** Minimal def shape this file needs. Any AudioModuleDef/VideoModuleDef fits. */
export interface DualMonoDefLike {
  type: string;
  domain?: string;
  inputs?: readonly PortDef[];
  outputs?: readonly PortDef[];
}

const audioPorts = (ports: readonly PortDef[] | undefined) =>
  (ports ?? []).filter((p) => p.type === 'audio');

/**
 * GROUND TRUTH: every module in the live registry that declares EXACTLY ONE
 * audio input. This is the population the ledger must explain, and it is read
 * from the defs — not from contract-lock.txt, not from a hand list.
 *
 * ⚠ The filter is "an audio-typed INPUT port", with NO domain restriction. That
 * is deliberate: filtering to `domain === 'audio'` is what dropped `milkdrop`
 * from the plan's own corrected count, and a filter applied before the check
 * silently redefines the check's subject.
 */
export function monoAudioInputTypes(defs: readonly DualMonoDefLike[]): string[] {
  return defs
    .filter((d) => audioPorts(d.inputs).length === 1)
    .map((d) => d.type)
    .sort();
}

/** Why a ledger entry disagrees with the module's live port shape. */
export interface ShapeMismatch {
  type: string;
  cls: DualMonoClass;
  problem: string;
}

export interface LedgerAudit {
  /** In the registry with one audio input, absent from the ledger. RED. */
  unclassified: string[];
  /** In the ledger, no longer a one-audio-input module. RED. */
  stale: string[];
  /** Classified, but the live port shape contradicts the class. RED. */
  shapeMismatch: ShapeMismatch[];
  /** The population actually seen (the non-vacuity denominator). */
  population: string[];
  byClass: Record<DualMonoClass, string[]>;
}

/**
 * Audit the ledger against the live registry.
 *
 * The shape rules are what make a classification FALSIFIABLE rather than a
 * label. `dual-mono` in particular requires that every output be audio: the
 * whole mechanism is "merge the two instances back into a stereo pair", and
 * there is no merger for a cv/gate/video output.
 */
export function auditDualMonoLedger(defs: readonly DualMonoDefLike[]): LedgerAudit {
  const byType = new Map(defs.map((d) => [d.type, d]));
  const population = monoAudioInputTypes(defs);
  const popSet = new Set(population);

  const unclassified = population.filter((t) => !DUAL_MONO_LEDGER.has(t));
  const stale = [...DUAL_MONO_LEDGER.keys()].filter((t) => !popSet.has(t)).sort();

  const shapeMismatch: ShapeMismatch[] = [];
  const byClass = {
    'dual-mono': [], 'mono-fanout': [], 'native-stereo': [], sum: [], deferred: [],
    'video-domain': [],
  } as Record<DualMonoClass, string[]>;

  for (const type of population) {
    const entry = DUAL_MONO_LEDGER.get(type);
    if (!entry) continue;
    byClass[entry.cls].push(type);
    const def = byType.get(type)!;
    const outs = def.outputs ?? [];
    const audioOuts = audioPorts(outs);
    const isAudioDomain = (def.domain ?? 'audio') === 'audio';

    if (entry.cls === 'video-domain') {
      if (isAudioDomain) {
        shapeMismatch.push({ type, cls: entry.cls,
          problem: "classed 'video-domain' but domain is audio — AudioEngine DOES "
            + 'materialize it, so it needs a real class' });
      }
      continue;
    }
    if (!isAudioDomain) {
      shapeMismatch.push({ type, cls: entry.cls,
        problem: `domain is '${def.domain}', not audio — AudioEngine never materializes `
          + "it, so this class is decoration; use 'video-domain'" });
      continue;
    }
    if (entry.cls === 'dual-mono') {
      if (audioOuts.length === 0) {
        shapeMismatch.push({ type, cls: entry.cls,
          problem: 'no audio output — two instances cannot be merged back into a pair' });
      }
      if (outs.length !== audioOuts.length) {
        const other = outs.filter((p) => p.type !== 'audio').map((p) => `${p.id}:${p.type}`);
        shapeMismatch.push({ type, cls: entry.cls,
          problem: `non-audio output(s) ${other.join(', ')} — there is no merger for these, `
            + "so \"which instance wins\" is undefined; classify 'sum' or 'deferred'" });
      }
    }
    // 'mono-fanout' carries BOTH shape obligations, because it is both halves:
    // the OUTPUT side still goes through a ChannelMerger (so every output must
    // be audio, exactly as for 'dual-mono'), and the INPUT side interposes the
    // 'sum' down-mix (so the audio input must not resolve to an AudioParam).
    if (entry.cls === 'mono-fanout') {
      if (audioOuts.length === 0) {
        shapeMismatch.push({ type, cls: entry.cls,
          problem: 'no audio output — there is nothing to fan into a merger; the class '
            + "would be the 'sum' down-mix wearing another name" });
      }
      if (outs.length !== audioOuts.length) {
        const other = outs.filter((p) => p.type !== 'audio').map((p) => `${p.id}:${p.type}`);
        shapeMismatch.push({ type, cls: entry.cls,
          problem: `non-audio output(s) ${other.join(', ')} — a ChannelMerger carries audio, `
            + "so these would be dropped from the handle; classify 'sum' or 'deferred'" });
      }
    }
    if (entry.cls === 'sum' || entry.cls === 'mono-fanout') {
      const summable = audioPorts(def.inputs).filter((p) => !p.paramTarget);
      if (summable.length === 0) {
        shapeMismatch.push({ type, cls: entry.cls,
          problem: 'its one audio input declares a paramTarget, so the engine connects it '
            + 'to an AudioParam and the down-mix stage can never be interposed — the '
            + `'${entry.cls}' class would be a no-op label` });
      }
    }
  }

  return { unclassified, stale, shapeMismatch, population, byClass };
}

/** The class for a module type, or null if it is not in the population. */
export function dualMonoClassOf(type: string): DualMonoClass | null {
  return DUAL_MONO_LEDGER.get(type)?.cls ?? null;
}

// ---------------------------------------------------------------------------
// SCOPE — stated here, asserted in dual-mono.test.ts.
// ---------------------------------------------------------------------------

export const SCOPE = {
  /**
   * The population is "a def with exactly ONE audio-typed input port". A module
   * with TWO audio inputs is out of scope by construction — it is already
   * stereo-capable or genuinely takes two signals — and a module with none has
   * nothing to preserve.
   */
  population: 'defs with exactly one audio-typed input port, ANY domain',
  /**
   * ⚠ THE BIG ONE. This is an `AudioEngine.addNode` seam. Anything that calls
   * `def.factory(ctx, node)` directly does not go through it and therefore
   * CANNOT observe dual-mono at all:
   *   - every ART scenario (`art/setup/offline.ts` renderOfflineDef),
   *   - the behavioral lane's engine-class drivers,
   *   - the video domain's WorkerProxyHandle.
   * ART is structurally blind to a dual-mono regression. That is why the ART
   * stereo-dual-mono scenario builds the wrapper EXPLICITLY rather than relying
   * on a module profile to notice.
   */
  bypassedBy: [
    'art/setup/offline.ts renderOfflineDef (drives def.factory directly)',
    'unit tests calling def.factory(...) directly',
    'packages/web/src/lib/video/worker/worker-proxy-handle.ts (video domain)',
  ] as const,
  /**
   * BOTH stereo representations are handled, and it took two mechanisms:
   *   - a 2-CHANNEL STREAM on one cable → the `mono` bus → `upmix`. This is
   *     what a dual-mono module emits, so it is what CHAINS.
   *   - TWO SEPARATE CABLES from a stereo source's out_l/out_r, which is what
   *     `planAudioCommit` writes → `AudioEngine.addEdge` places them on the
   *     `left`/`right` leg inputs via `legInputsFor` + `resolveDualMonoInput`,
   *     because Web Audio would otherwise SUM them.
   *
   * What is still NOT handled, stated so it cannot read as coverage: leg
   * placement is decided from the SOURCE port's stereo pair. A stereo source
   * whose two outputs are NOT a derived pair (no declaration, no L/R id token)
   * is invisible to `legChannelOfEdge` and both cables land on the mono bus and
   * sum — the same answer the whole app gives such a module everywhere else,
   * since the commit planner reads the same derivation.
   */
  notHandled: 'a stereo source whose outputs are not a DERIVED pair — both legs '
    + 'land on the mono bus and sum, as they do everywhere else in the app',
  /** The leg-placement seam, named so a regression has something to assert on. */
  legPlacement: 'AudioEngine.addEdge → legInputsFor + resolveDualMonoInput, sided by '
    + 'legChannelOfEdge (the SHARED stereo-pair derivation, not a second heuristic)',
  /**
   * `read()` is single-instance and there is no defined answer for two. So a
   * 'dual-mono' handle is FORBIDDEN from declaring `read` / `write` /
   * `videoSources`, checked at materialization AND by a source grep in the
   * gate. None of the six declares one today; if one ever does, both go red
   * and force a per-key decision instead of silently metering the left channel.
   * (`setParam` / `scheduleParam` / `readParam` are well defined and DO fan
   * out — the two instances are param-identical by construction.)
   *
   * ⚠ THE BAN IS SCOPED TO 'dual-mono' AND MUST STAY THAT WAY. 'mono-fanout'
   * builds ONE instance, so `read` has exactly one defined answer and passes
   * straight through the handle — the same reason 'sum' and 'native-stereo' are
   * unrestricted. Widening the ban to every wrapped class would forbid a key
   * that is well defined.
   */
  readPolicy: 'dual-mono handles may not declare read/write/videoSources',
  /**
   * ⚠ 'mono-fanout' KEEPS THE LEGS, AND THE REASON IS LEVEL, NOT WIDTH. It has
   * one instance, so it has no stereo image to protect — but leg placement is
   * also what stops Web Audio SUMMING the two cables a stereo→mono patch
   * writes. Without legs the DSP would receive L+R instead of (L+R)/2: up to
   * 6 dB hot into DSP that is nonlinear by design. So the two cables land on
   * separate legs, become a real 2-channel stream, and ONE down-mix averages
   * them — the same answer every other mono path in the app gives.
   *
   * ⚠ It was built without legs first, on the reasoning that one instance has
   * nothing to side. That is true and it is the wrong conclusion; the note
   * stays so the next person does not re-derive it and re-introduce the
   * doubling.
   */
  monoFanoutLegs: 'mono-fanout KEEPS leg inputs — not for width (there is one '
    + 'instance) but so a stereo source\'s two cables AVERAGE instead of summing 6 dB hot',
  classes: [
    'dual-mono', 'mono-fanout', 'native-stereo', 'sum', 'deferred', 'video-domain',
  ] as const,
} as const;

// ---------------------------------------------------------------------------
// THE RUNTIME SEAM.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LEG PLACEMENT — the seam that stops two cables summing.
// ---------------------------------------------------------------------------

/** One end of a cable, as the engine's `inputs` map spells it. */
export interface AudioInputRef { node: AudioNode; input: number }

/**
 * The three places an edge into a dual-mono module's audio input can land.
 *
 * `mono` is the default and the safe one: it feeds the up-mix, so one cable
 * carrying either 1 or 2 channels behaves exactly as it did before leg
 * placement existed. `left` / `right` are used ONLY when the SOURCE port is a
 * declared/derived member of a stereo output pair, which is what
 * `planAudioCommit` writes for a stereo→mono patch.
 */
export interface DualMonoLegInputs {
  mono: AudioInputRef;
  left: AudioInputRef;
  right: AudioInputRef;
  /** Tell the wrapper a left/right leg attached (+1) or detached (−1), so it
   *  can close the mono normal on that side. MUST be paired with the teardown. */
  noteLeg(side: 'left' | 'right', delta: number): void;
  /** Live leg counts — exported so a gate can assert the normals, not just the
   *  wiring. (A normal stuck open is inaudible on a stereo patch: it would sum
   *  L into R, which still LOOKS like two channels.) */
  counts(): { left: number; right: number };
}

/**
 * Side-channel, deliberately NOT a field on `AudioDomainNodeHandle`.
 *
 * Leg placement concerns exactly one wrapper; putting it on the shared handle
 * type would invite every other factory to grow a half-implemented version of
 * it. A WeakMap also means a disposed handle takes its entry with it — there is
 * no registry to leak or to forget to clean up.
 */
const LEG_INPUTS = new WeakMap<object, Map<string, DualMonoLegInputs>>();

/** The leg inputs for `portId` on `handle`, or null when it is not wrapped. */
export function legInputsFor(
  handle: object | undefined,
  portId: string,
): DualMonoLegInputs | null {
  if (!handle) return null;
  return LEG_INPUTS.get(handle)?.get(portId) ?? null;
}

/**
 * WHERE an edge lands, given its leg side. ONE function, called by
 * `AudioEngine.addEdge` **and** by the ART signal scenario — so the thing the
 * gate proves is the thing the engine runs, rather than a re-derivation that
 * can drift from it (the "a gate that reads only one side" failure).
 *
 * `null` (neither endpoint is paired) → the MONO bus. That is the case for
 * every ordinary cable in every existing patch, and for the 2-channel stream a
 * dual-mono module emits, whose output port `audio` is unpaired.
 */
export function resolveDualMonoInput(
  legs: DualMonoLegInputs,
  side: 'left' | 'right' | null,
): AudioInputRef {
  if (side === 'left') return legs.left;
  if (side === 'right') return legs.right;
  return legs.mono;
}

/** Everything the wrapper built, so `dispose` can tear it all down. */
interface Scaffold {
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
}

const teardown = (s: Scaffold) => {
  for (const src of s.sources) { try { src.stop(); } catch { /* already stopped */ } }
  for (const n of s.nodes) { try { n.disconnect(); } catch { /* already torn down */ } }
};

/**
 * Materialize a module for the audio engine, applying its dual-mono class.
 *
 * This is the ONLY thing `AudioEngine.addNode` should call; it replaces the
 * bare `def.factory(...)`.
 */
export async function materializeAudioHandle(
  ctx: AudioContext,
  def: AudioModuleDef,
  node: ModuleNode,
): Promise<AudioDomainNodeHandle> {
  const cls = dualMonoClassOf(String(def.type));
  const factory = def.factory as AudioModuleFactory;
  if (cls === 'dual-mono') return buildDualMono(ctx, def, node, factory);
  if (cls === 'mono-fanout') return buildMonoFanout(ctx, def, node, factory);
  if (cls === 'sum') return buildSummedInputs(ctx, def, node, factory);
  return factory(ctx, node);
}

/** Everything `buildStereoInputFrontEnd` hands back. */
interface StereoInputFrontEnd {
  /** The 2-CHANNEL node carrying whatever arrived, however it arrived. */
  tail: AudioNode;
  /** What the engine's default `inputs` entry points at — the mono bus. */
  mono: AudioInputRef;
  /** The sided entries + the normals, for `LEG_INPUTS`. */
  legs: DualMonoLegInputs;
}

/**
 * THE INPUT FRONT-END, shared by 'dual-mono' and 'mono-fanout'.
 *
 * TWO ways a stereo signal can arrive, and they need different plumbing:
 *
 *   (1) as a 2-CHANNEL STREAM on one cable — what a dual-mono module emits,
 *       so this is what CHAINS. Goes to `monoBus`, and `upmix` makes it 2ch
 *       (duplicating a 1-channel mono patch, passing 2 channels through).
 *   (2) as TWO SEPARATE CABLES from a stereo source's out_l/out_r — what the
 *       PR-3 commit planner writes. Web Audio SUMS two connections to one
 *       input, so these must land on DIFFERENT nodes. For 'dual-mono' that is
 *       because the stereo image would otherwise die at the first mono module;
 *       for 'mono-fanout' the image is going away regardless, but the LEVEL
 *       still must not double — a summed L+R hits a tanh ladder 6 dB hot,
 *       where (L+R)/2 is the down-mix every other mono path in the app applies.
 *       `AudioEngine.addEdge` places them via `legInputsFor`.
 *
 * Both paths sum into `stereoSum`, which is 2-channel by then either way.
 *
 *       legL ──────────────────► legMerger.0 ──┐
 *         └──normalLR(gain)────► legMerger.1   │
 *       legR ──────────────────► legMerger.1   ├─► stereoSum ─► (the consumer)
 *         └──normalRL(gain)────► legMerger.0   │
 *       monoBus ─► upmix ──────────────────────┘
 *
 * ⚠ NODE CREATION ORDER IS LOAD-BEARING FOR THE TOPOLOGY TEST, which recovers
 * the two normals by tag (`gain4` / `gain5`). Adding a gain above them moves
 * what those assertions read; the test would still pass while checking the
 * wrong node. Append, do not insert.
 */
function buildStereoInputFrontEnd(
  ctx: AudioContext,
  scaffold: Scaffold,
): StereoInputFrontEnd {
  const monoBus = ctx.createGain();
  const upmix = ctx.createGain();
  // ⚠⚠ THE MONO-PATCH GUARD. 'speakers' DUPLICATES a 1-channel stream to both
  // channels; 'discrete' (the ChannelSplitter default, and what we would get by
  // omitting this stage) ZERO-FILLS channel 1 and makes every mono patch
  // left-only. Do not "simplify" this away. See the header.
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';

  // ⚠ A ChannelMerger has the SAME zero-fill hazard in a different costume: an
  // unconnected merger input renders as silence, so a lone leg would give
  // signal-on-L / silence-on-R exactly like a discrete up-mix. These two gains
  // are the MONO NORMAL that closes it — the Web Audio spelling of the
  // `inputs[1]?.[0] ?? inputs[0]?.[0]` fallback the DSP layer already uses
  // (see mono-normal-scan.ts). Each is OPEN (1) by default and closed by the
  // engine only once the opposite leg genuinely exists, so the failure
  // direction is duplication, never silence.
  const legL = ctx.createGain();
  const legR = ctx.createGain();
  const legMerger = ctx.createChannelMerger(2);
  const normalLR = ctx.createGain();
  const normalRL = ctx.createGain();
  normalLR.gain.value = 1;
  normalRL.gain.value = 1;
  legL.connect(legMerger, 0, 0);
  legR.connect(legMerger, 0, 1);
  legL.connect(normalLR);
  normalLR.connect(legMerger, 0, 1);
  legR.connect(normalRL);
  normalRL.connect(legMerger, 0, 0);

  const stereoSum = ctx.createGain();
  stereoSum.channelCount = 2;
  stereoSum.channelCountMode = 'explicit';
  stereoSum.channelInterpretation = 'speakers';

  monoBus.connect(upmix);
  upmix.connect(stereoSum);
  legMerger.connect(stereoSum);
  scaffold.nodes.push(
    monoBus, upmix, legL, legR, legMerger, normalLR, normalRL, stereoSum,
  );

  let leftLegs = 0;
  let rightLegs = 0;
  return {
    tail: stereoSum,
    mono: { node: monoBus, input: 0 },
    legs: {
      mono: { node: monoBus, input: 0 },
      left: { node: legL, input: 0 },
      right: { node: legR, input: 0 },
      noteLeg(side, delta) {
        if (side === 'left') leftLegs = Math.max(0, leftLegs + delta);
        else rightLegs = Math.max(0, rightLegs + delta);
        // Open the normal only while the opposite side is genuinely absent.
        normalLR.gain.value = rightLegs === 0 ? 1 : 0;
        normalRL.gain.value = leftLegs === 0 ? 1 : 0;
      },
      counts: () => ({ left: leftLegs, right: rightLegs }),
    },
  };
}

/**
 * TWO instances, one per channel, presented as one handle.
 *
 *   in → inGain → upmix(2ch, EXPLICIT, SPEAKERS) → splitter ─ch0→ A ─→ merger.0
 *                                                          └─ch1→ B ─→ merger.1
 *
 * Every non-audio input becomes a passthrough that fans to BOTH instances, so
 * one LFO drives both channels identically rather than only the left.
 */
async function buildDualMono(
  ctx: AudioContext,
  def: AudioModuleDef,
  node: ModuleNode,
  factory: AudioModuleFactory,
): Promise<AudioDomainNodeHandle> {
  const audioIns = audioPorts(def.inputs);
  if (audioIns.length !== 1) {
    throw new Error(
      `dual-mono ${def.type}: expected exactly 1 audio input, found ${audioIns.length} `
      + `(${audioIns.map((p) => p.id).join(', ')}). The ledger and the def disagree.`,
    );
  }
  const audioInId = audioIns[0]!.id;

  const [a, b] = await Promise.all([factory(ctx, node), factory(ctx, node)]);

  for (const [name, h] of [['A', a], ['B', b]] as const) {
    if (h.read || h.write || h.videoSources) {
      a.dispose(); b.dispose();
      throw new Error(
        `dual-mono ${def.type}: instance ${name} declares read/write/videoSources, which `
        + 'is single-instance by nature and has NO defined answer for two instances. '
        + 'Reclassify the module in DUAL_MONO_LEDGER, or decide the key explicitly.',
      );
    }
  }

  const scaffold: Scaffold = { nodes: [], sources: [] };
  const inputs = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();

  // ---- the audio input: up-mix, then split ---------------------------------
  const aAudio = a.inputs.get(audioInId);
  const bAudio = b.inputs.get(audioInId);
  if (!aAudio || !bAudio) {
    a.dispose(); b.dispose();
    throw new Error(`dual-mono ${def.type}: handle has no input '${audioInId}'`);
  }
  if (aAudio.param) {
    a.dispose(); b.dispose();
    throw new Error(
      `dual-mono ${def.type}: audio input '${audioInId}' resolves to an AudioParam, which `
      + 'cannot be channel-split. Reclassify.',
    );
  }

  const front = buildStereoInputFrontEnd(ctx, scaffold);
  const splitter = ctx.createChannelSplitter(2);
  front.tail.connect(splitter);
  splitter.connect(aAudio.node, 0, aAudio.input);
  splitter.connect(bAudio.node, 1, bAudio.input);
  scaffold.nodes.push(splitter);

  // The DEFAULT entry is the MONO bus. Every caller that does not know about
  // legs — the cross-domain bridges, `getInputNode`, any future consumer — gets
  // byte-identical behaviour to before leg placement existed.
  inputs.set(audioInId, front.mono);
  const legs = front.legs;

  // ---- every other input: fan to both --------------------------------------
  for (const port of def.inputs) {
    if (port.id === audioInId) continue;
    const ai = a.inputs.get(port.id);
    const bi = b.inputs.get(port.id);
    if (!ai || !bi) continue; // declared but not materialized — leave it absent

    // The node path (what the engine uses when the entry has no `param`).
    const fan = ctx.createGain();
    fan.connect(ai.node, 0, ai.input);
    fan.connect(bi.node, 0, bi.input);
    scaffold.nodes.push(fan);

    if (!ai.param || !bi.param) {
      inputs.set(port.id, { node: fan, input: 0 });
      continue;
    }

    // The AudioParam path. The engine connects the (optionally CV-scaled)
    // source straight to `din.param`, so we cannot simply hand it A's param —
    // B would never be modulated and the right channel would sit at the knob
    // value while the left swept. A ConstantSourceNode whose `offset` is 0
    // outputs exactly the sum of whatever is connected to that offset, so it
    // re-emits the CV as a signal we can fan into BOTH real params.
    const cvFan = ctx.createConstantSource();
    cvFan.offset.value = 0;
    cvFan.connect(ai.param);
    cvFan.connect(bi.param);
    cvFan.start();
    scaffold.nodes.push(cvFan);
    scaffold.sources.push(cvFan);
    inputs.set(port.id, { node: fan, input: 0, param: cvFan.offset });
  }

  // ---- outputs: merge the two instances into a stereo pair -----------------
  const outputs = new Map<string, { node: AudioNode; output: number }>();
  for (const port of def.outputs ?? []) {
    const ao = a.outputs.get(port.id);
    const bo = b.outputs.get(port.id);
    if (!ao || !bo) continue;
    const merger = ctx.createChannelMerger(2);
    ao.node.connect(merger, ao.output, 0);
    bo.node.connect(merger, bo.output, 1);
    scaffold.nodes.push(merger);
    outputs.set(port.id, { node: merger, output: 0 });
  }

  const handle: AudioDomainNodeHandle = {
    domain: 'audio',
    inputs,
    outputs,
    setParam(paramId, value) { a.setParam(paramId, value); b.setParam(paramId, value); },
    scheduleParam(paramId, value, atTime, ramp) {
      a.scheduleParam?.(paramId, value, atTime, ramp);
      b.scheduleParam?.(paramId, value, atTime, ramp);
    },
    // Instance A. The two are param-identical by construction (setParam and
    // scheduleParam both fan out, and readParam reads a param, not a signal),
    // so there is no left/right ambiguity here — unlike read(), which is banned
    // above precisely because it CAN observe a per-channel signal.
    readParam(paramId) { return a.readParam(paramId); },
    dispose() {
      teardown(scaffold);
      a.dispose();
      b.dispose();
    },
  };
  LEG_INPUTS.set(handle, new Map([[audioInId, legs]]));
  return handle;
}

/**
 * ONE instance, DOWN-MIXED in and FANNED out — the 'mono-fanout' class.
 *
 *   the SHARED front-end ─► down(1ch, EXPLICIT, SPEAKERS) ─► the ONE instance
 *                                                                  │
 *                                                    merger.0 ◄─────┤
 *                                                    merger.1 ◄─────┘
 *
 * Read the 'mono-fanout' doc-comment on `DualMonoClass` before changing
 * anything here; the measurement that forced this shape is written down there.
 * The short version: these modules' DSP carries its OWN entropy, so building it
 * twice does not give two copies of one signal — it gives two DIFFERENT signals
 * at the same frequency, and every meter in the app (an `AnalyserNode`, which
 * mono-down-mixes) then reads A·|cos(Δφ/2)| for an arbitrary Δφ.
 *
 * ⚠ IT KEEPS THE FULL LEG FRONT-END EVEN THOUGH IT HAS ONE INSTANCE, and that
 * is a LEVEL decision, not a stereo one. A stereo source patched here is
 * collapsed either way — but the commit planner writes a stereo→mono patch as
 * TWO CABLES, and Web Audio SUMS two connections to one input. Landing both on
 * a bare down-mix would feed the DSP L+R instead of (L+R)/2, i.e. up to 6 dB
 * hot into a tanh ladder that distorts when driven. Through the front-end the
 * two cables land on separate legs, become a real 2-channel stream, and the
 * down-mix then averages them like every other mono path in the app. A single
 * mono cable is untouched: `upmix` duplicates it and the down-mix averages the
 * duplicate back to itself.
 *
 * ⚠ THE FAN IS THE POINT, AND IT IS NOT DECORATION. Emitting the instance's
 * single output directly would ALSO make L == R once something downstream
 * up-mixed it — but only once something did. Going through the merger keeps the
 * port a 2-channel stream with the SAME per-channel level 'dual-mono' produced,
 * so the class changes WHICH SIGNAL each channel carries and nothing else. Do
 * not "simplify" it to a bare passthrough: that hands the next module a
 * 1-channel stream where the ledger's chaining case promises 2.
 */
async function buildMonoFanout(
  ctx: AudioContext,
  def: AudioModuleDef,
  node: ModuleNode,
  factory: AudioModuleFactory,
): Promise<AudioDomainNodeHandle> {
  const audioIns = audioPorts(def.inputs);
  if (audioIns.length !== 1) {
    throw new Error(
      `mono-fanout ${def.type}: expected exactly 1 audio input, found ${audioIns.length} `
      + `(${audioIns.map((p) => p.id).join(', ')}). The ledger and the def disagree.`,
    );
  }
  const audioInId = audioIns[0]!.id;

  const inner = await factory(ctx, node);
  const innerAudio = inner.inputs.get(audioInId);
  if (!innerAudio) {
    inner.dispose();
    throw new Error(`mono-fanout ${def.type}: handle has no input '${audioInId}'`);
  }
  if (innerAudio.param) {
    inner.dispose();
    throw new Error(
      `mono-fanout ${def.type}: audio input '${audioInId}' resolves to an AudioParam, which `
      + 'cannot have the down-mix interposed in front of it. Reclassify.',
    );
  }

  const scaffold: Scaffold = { nodes: [], sources: [] };
  const inputs = new Map(inner.inputs);

  // ---- the audio input: the shared front-end, then the down-mix -------------
  const front = buildStereoInputFrontEnd(ctx, scaffold);
  const down = ctx.createGain();
  down.channelCount = 1;
  down.channelCountMode = 'explicit';
  down.channelInterpretation = 'speakers';
  front.tail.connect(down);
  down.connect(innerAudio.node, 0, innerAudio.input);
  scaffold.nodes.push(down);
  inputs.set(audioInId, front.mono);

  // Every OTHER input is left exactly as the factory returned it — there is one
  // instance, so there is nothing to fan and no CV re-emitter to build.

  // ---- outputs: ONE source, BOTH merger inputs ------------------------------
  // Δφ = 0 by construction: the two channels are literally the same node.
  const outputs = new Map(inner.outputs);
  for (const port of def.outputs ?? []) {
    const out = inner.outputs.get(port.id);
    if (!out) continue;
    const merger = ctx.createChannelMerger(2);
    out.node.connect(merger, out.output, 0);
    out.node.connect(merger, out.output, 1);
    scaffold.nodes.push(merger);
    outputs.set(port.id, { node: merger, output: 0 });
  }

  const handle: AudioDomainNodeHandle = {
    ...inner,
    inputs,
    outputs,
    dispose() { teardown(scaffold); inner.dispose(); },
  };
  LEG_INPUTS.set(handle, new Map([[audioInId, front.legs]]));
  return handle;
}

/**
 * ONE instance, with every plain audio input DOWN-MIXED to the sum.
 *
 * A GainNode pinned to `channelCount = 1, channelCountMode = 'explicit',
 * channelInterpretation = 'speakers'` applies the standard down-mix,
 * (L + R) / 2, and is a pure pass-through for a signal that is already mono —
 * so this cannot move a mono patch.
 */
async function buildSummedInputs(
  ctx: AudioContext,
  def: AudioModuleDef,
  node: ModuleNode,
  factory: AudioModuleFactory,
): Promise<AudioDomainNodeHandle> {
  const inner = await factory(ctx, node);
  const scaffold: Scaffold = { nodes: [], sources: [] };
  const inputs = new Map(inner.inputs);

  for (const port of audioPorts(def.inputs)) {
    const entry = inner.inputs.get(port.id);
    // An AudioParam target cannot have a node interposed in front of it (the
    // engine connects the source to the param, never through `node`). The
    // ledger audit rejects a 'sum' module whose only audio input is one.
    if (!entry || entry.param) continue;
    const down = ctx.createGain();
    down.channelCount = 1;
    down.channelCountMode = 'explicit';
    down.channelInterpretation = 'speakers';
    down.connect(entry.node, 0, entry.input);
    scaffold.nodes.push(down);
    inputs.set(port.id, { node: down, input: 0 });
  }

  return {
    ...inner,
    inputs,
    dispose() { teardown(scaffold); inner.dispose(); },
  };
}
