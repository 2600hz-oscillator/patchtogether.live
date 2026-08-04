// packages/web/src/lib/audio/mono-normal-not-defeated.test.ts
//
// A FACTORY CAN SILENTLY DISAGREE WITH ITS DSP.
//
// Five modules shipped a stereo input whose RIGHT channel was digital silence
// for every mono patch the app can build. In each case the DSP was CORRECT: it
// declared a mono normal (`inputs[1]?.[0] ?? inputs[0]?.[0]`, cofefve even
// commenting "// R normals to L") so an unpatched R would follow L. The
// FACTORY then defeated it, two different ways:
//
//   * clouds / shimmershine / charlottes-echos / cofefve pinned a 0-valued
//     ConstantSource to worklet input 1 for "liveness". A connected input is
//     never absent, so Chrome handed the processor a permanently-silent
//     channel and the `??` fallback could never fire.
//   * resofilter carries its stereo on two CHANNELS of ONE input and set
//     `channelInterpretation: 'discrete'`, whose up-mix ZERO-FILLS channel 1
//     for a mono source — so `inAudio[1] ?? inAudio[0]` likewise never fell
//     through.
//
// Measured OUT R peak for a mono source into L, before → after:
//   clouds 0.0000e+0 → 6.8858e-1 | shimmershine 0.0000e+0 → 4.4212e-1
//   charlottes-echos 0.0000e+0 → 8.5852e-1 | cofefve 0.0000e+0 → 9.3254e-1
//   resofilter 0.0000e+0 → 4.9990e-1
//
// WHY NOTHING CAUGHT IT. Every existing gate reads the side that was right.
// The ART scenarios for all four pinned modules drive the DSP class DIRECTLY
// (`renderWorklet(new Proc(), { inputs: [input, null] })` and pure-TS core
// mirrors) — they never call `def.factory()`, so the pin is structurally
// invisible to ART, and charlottes-echos' ART actually EXERCISES the normal and
// passes. The per-port sweep measures through a SCOPE against a fixed floor and
// never compares a module's own L to its own R. The docs gate reads prose:
// cofefve's and resofilter's docs PROMISED the normal while the code delivered
// silence, and shimmershine's doc had been rewritten to describe the defect as
// intended ("the right tank sees silence"). Three surfaces, three different
// wrong answers, zero red.
//
// So this gate is textual and DENY-BY-DEFAULT: every mono normal found in
// packages/dsp/src must be reachable through its factory, or be named here with
// a reason. It is anchored to the ARTIFACT — a KNOWN_MONO_NORMALS entry that no
// longer exists in the source is RED, so a normal cannot silently vanish, and a
// stale exemption cannot sit unwatched.
//
// The behavioural counterpart is e2e/tests/stereo-mono-normal.spec.ts, which
// measures the real factory through the real engine.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dspDir = fileURLToPath(new URL('../../../../dsp/src/', import.meta.url));
const factoryDir = fileURLToPath(new URL('./modules/', import.meta.url));

/** A mono normal declared inside a worklet's `process()`. */
interface MonoNormal {
  /** DSP source file, e.g. `clouds.ts`. */
  dspFile: string;
  /**
   * `input`   — `inputs[N]?.[0] ?? inputs[M]?.[0]`: worklet INPUT N normals
   *             from input M. Defeated by connecting anything to input N.
   * `channel` — `x[N] ?? x[M]` where `x = inputs[K]`: CHANNEL N of input K
   *             normals from channel M. Defeated by a 'discrete' up-mix law.
   */
  kind: 'input' | 'channel';
  /** The index that falls back (the one that must stay genuinely absent). */
  normalled: number;
  /** The index it falls back TO. */
  from: number;
  /** For `channel`, the worklet input the channel array came from. */
  onInput?: number;
  line: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Detectors. Exported shape kept pure + string-in so the negative control below
// can feed them known-defective source WITHOUT touching the repo.
// ---------------------------------------------------------------------------

export function findMonoNormals(dspFile: string, src: string): MonoNormal[] {
  const found: MonoNormal[] = [];
  const lines = src.split('\n');

  // (a) input-index normals: inputs[N]?.[0] ?? inputs[M]?.[0]
  const inputRe = /inputs\[(\d+)\]\?\.\[0\]\s*\?\?\s*inputs\[(\d+)\]\?\.\[0\]/;
  // (b) channel normals: first bind `const x = inputs[K]`, then `x[N] ?? x[M]`.
  const bindRe = /(?:const|let)\s+(\w+)\s*=\s*inputs\[(\d+)\]/g;
  const bound = new Map<string, number>();
  for (const m of src.matchAll(bindRe)) bound.set(m[1]!, Number(m[2]));

  lines.forEach((line, i) => {
    const im = inputRe.exec(line);
    if (im) {
      found.push({
        dspFile, kind: 'input', normalled: Number(im[1]), from: Number(im[2]),
        line: i + 1, text: line.trim(),
      });
      return;
    }
    for (const [name, onInput] of bound) {
      const chRe = new RegExp(`\\b${name}\\[(\\d+)\\]\\s*\\?\\?\\s*${name}\\[(\\d+)\\]`);
      const cm = chRe.exec(line);
      if (cm) {
        found.push({
          dspFile, kind: 'channel', normalled: Number(cm[1]), from: Number(cm[2]),
          onInput, line: i + 1, text: line.trim(),
        });
        return;
      }
    }
  });
  return found;
}

/**
 * Does `factorySrc` DEFEAT `normal`? Returns the reason, or null if the normal
 * is reachable.
 *
 * A real patch cable is realised by the ENGINE (`sout.node.connect(din.node,
 * …)`) using the index the handle's `inputs` map declares — it never appears as
 * a literal `.connect(node, n, IDX)` inside a factory. So a literal connect to
 * the normalled input in the factory is, by construction, a pin.
 */
export function defeatReason(normal: MonoNormal, factorySrc: string): string | null {
  if (normal.kind === 'input') {
    const pinRe = new RegExp(`\\.connect\\(\\s*\\w+\\s*,\\s*\\d+\\s*,\\s*${normal.normalled}\\s*\\)`);
    const m = pinRe.exec(factorySrc);
    if (m) {
      return `factory pins worklet input ${normal.normalled} (\`${m[0]}\`), so Chrome always `
        + `hands process() a channel for it and \`${normal.text}\` can never fall through`;
    }
    return null;
  }
  // channel kind: a 'discrete' up-mix zero-fills the normalled channel.
  if (/channelInterpretation:\s*'discrete'/.test(factorySrc)) {
    return `factory sets channelInterpretation: 'discrete', whose up-mix ZERO-FILLS channel `
      + `${normal.normalled} for a mono source, so \`${normal.text}\` can never fall through `
      + `(channel ${normal.normalled} exists, it is merely silent). Use 'speakers'.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pinned population. Anchored to the artifact: each entry must still be
// found in the source. Add a row when you add a mono normal.
// ---------------------------------------------------------------------------

/** `${dspFile}:${kind}:${normalled}` for every mono normal that must exist. */
const KNOWN_MONO_NORMALS: readonly string[] = [
  'charlottes-echos.ts:input:1',
  'clouds.ts:input:1',
  'cofefve.ts:input:1',
  'shimmershine.ts:input:1',
  'sidecar.ts:input:1', // MAIN  audio_r → audio_l
  'sidecar.ts:input:3', // SIDECHAIN sc_r → sc_l
  'resofilter.ts:channel:1',
];

/**
 * Mono normals allowed to stay defeated, keyed `${dspFile}:${kind}:${normalled}`
 * with the reason. DENY BY DEFAULT — a module is not exempt because its file is
 * listed, only that exact normal is.
 *
 * EMPTY, and it should stay that way: a defeated normal is a silent channel.
 */
const DEFEAT_EXEMPT: Readonly<Record<string, string>> = {};

/** Maps a DSP file to its factory. Same basename for every module today. */
function factoryFor(dspFile: string): { path: string; src: string } {
  const path = `${factoryDir}${dspFile}`;
  return { path, src: readFileSync(path, 'utf8') };
}

function scanRepo(): MonoNormal[] {
  const out: MonoNormal[] = [];
  for (const f of readdirSync(dspDir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue;
    out.push(...findMonoNormals(f, readFileSync(`${dspDir}${f}`, 'utf8')));
  }
  return out;
}

const key = (n: MonoNormal) => `${n.dspFile}:${n.kind}:${n.normalled}`;

describe('mono normals are not defeated by their factory', () => {
  const normals = scanRepo();

  it('every mono normal in the DSP is REACHABLE through its factory', () => {
    const defeated: string[] = [];
    for (const n of normals) {
      if (key(n) in DEFEAT_EXEMPT) continue;
      const { src } = factoryFor(n.dspFile);
      const reason = defeatReason(n, src);
      if (reason) defeated.push(`${n.dspFile}:${n.line} — ${reason}`);
    }
    expect(
      defeated,
      'A DSP declared a mono normal and its factory defeats it, so the normalled '
      + 'channel renders DIGITAL SILENCE for every mono patch:\n  ' + defeated.join('\n  '),
    ).toEqual([]);
  });

  it('is ANCHORED to the artifact — no pinned normal has silently vanished', () => {
    const seen = new Set(normals.map(key));
    const missing = KNOWN_MONO_NORMALS.filter((k) => !seen.has(k));
    expect(
      missing,
      'These mono normals are pinned but no longer present in packages/dsp/src. A refactor '
      + 'that drops one silently re-opens the silent-channel defect — restore it, or remove '
      + `the row deliberately:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('states its own SCOPE, and ratchets the exemption list in BOTH directions', () => {
    // Only shrinks. A defeated normal is a user-audible silent channel.
    expect(Object.keys(DEFEAT_EXEMPT)).toHaveLength(0);

    // A stale exemption is one nobody is watching: every key must name a real,
    // currently-discovered normal.
    const seen = new Set(normals.map(key));
    for (const k of Object.keys(DEFEAT_EXEMPT)) {
      expect(seen.has(k), `DEFEAT_EXEMPT names "${k}", which is not a mono normal in the source`).toBe(true);
    }

    // SCOPE, stated in the gate: this reads packages/dsp/src only, and knows
    // exactly two ways to defeat a normal (a factory pin on the normalled
    // INPUT; a 'discrete' up-mix law on a normalled CHANNEL). A third mechanism
    // — e.g. a factory that up-mixes upstream of the worklet, or a normal
    // expressed with a shape these regexes miss — is INVISIBLE here. The
    // negative control below is what keeps that honest.
    expect(normals.length).toBeGreaterThanOrEqual(KNOWN_MONO_NORMALS.length);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROL — the permanent leg. After the fix every assertion above
  // passes, and a gate that detected NOTHING would look exactly the same. These
  // feed the detectors the real pre-fix source and require them to go red.
  // -------------------------------------------------------------------------
  describe('negative control: the detectors can actually FAIL', () => {
    const PRE_FIX_PIN = `
      const silenceL = ctx.createConstantSource();
      const silenceR = ctx.createConstantSource();
      silenceL.connect(workletNode, 0, 0);
      silenceR.connect(workletNode, 0, 1);
    `;
    const PRE_FIX_DISCRETE = `
      const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
    `;

    it('flags the ConstantSource pin that broke the four worklet-input modules', () => {
      const n: MonoNormal = {
        dspFile: 'clouds.ts', kind: 'input', normalled: 1, from: 0, line: 266,
        text: 'const inRBlock = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;',
      };
      expect(defeatReason(n, PRE_FIX_PIN)).toMatch(/pins worklet input 1/);
      // …and does NOT fire once the R pin is removed (the shipped fix).
      expect(defeatReason(n, PRE_FIX_PIN.replace('silenceR.connect(workletNode, 0, 1);', ''))).toBeNull();
    });

    it('flags the discrete up-mix that broke resofilter', () => {
      const n: MonoNormal = {
        dspFile: 'resofilter.ts', kind: 'channel', normalled: 1, from: 0, onInput: 0, line: 109,
        text: 'const inR = inAudio[1] ?? inAudio[0] ?? null;',
      };
      expect(defeatReason(n, PRE_FIX_DISCRETE)).toMatch(/discrete/);
      expect(defeatReason(n, PRE_FIX_DISCRETE.replace("'discrete'", "'speakers'"))).toBeNull();
    });

    it('does not confuse a pin on a DIFFERENT input with a pin on the normalled one', () => {
      // cofefve legitimately pins input 0 (audio L) and input 2 (clock). Only a
      // pin on input 1 defeats its normal — a detector that matched any connect
      // would be unable to tell the fix from the defect.
      const n: MonoNormal = {
        dspFile: 'cofefve.ts', kind: 'input', normalled: 1, from: 0, line: 138,
        text: 'const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;',
      };
      const fixed = `
        silenceL.connect(workletNode, 0, 0);
        silenceClk.connect(workletNode, 0, 2);
      `;
      expect(defeatReason(n, fixed)).toBeNull();
      expect(defeatReason(n, `${fixed}\nsilenceR.connect(workletNode, 0, 1);`)).toMatch(/pins worklet input 1/);
    });

    it('finds BOTH normal shapes in real source (the finder itself is controlled)', () => {
      const inputForm = findMonoNormals('x.ts', 'const inR = inputs[1]?.[0] ?? inputs[0]?.[0] ?? null;');
      expect(inputForm).toHaveLength(1);
      expect(inputForm[0]).toMatchObject({ kind: 'input', normalled: 1, from: 0 });

      const channelForm = findMonoNormals(
        'y.ts',
        'const inAudio = inputs[0] ?? [];\nconst inR = inAudio[1] ?? inAudio[0] ?? null;',
      );
      expect(channelForm).toHaveLength(1);
      expect(channelForm[0]).toMatchObject({ kind: 'channel', normalled: 1, from: 0, onInput: 0 });

      // and does not invent normals where there are none
      expect(findMonoNormals('z.ts', 'const inL = inputs[0]?.[0] ?? null;')).toEqual([]);
    });

    it('sidecar — the module that always WORKED — is detected, proving coverage is real', () => {
      // sidecar declares two normals and its factory pins nothing. If the
      // scanner silently missed it, "0 defeated" would be meaningless.
      const seen = scanRepo().filter((n) => n.dspFile === 'sidecar.ts');
      expect(seen.map(key).sort()).toEqual(['sidecar.ts:input:1', 'sidecar.ts:input:3']);
      for (const n of seen) expect(defeatReason(n, factoryFor('sidecar.ts').src)).toBeNull();
    });
  });
});
