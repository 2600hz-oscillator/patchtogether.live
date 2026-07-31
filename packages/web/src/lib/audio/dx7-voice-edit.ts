// packages/web/src/lib/audio/dx7-voice-edit.ts
//
// THE EDIT MODEL for a DX7 voice: unwrap it off the Y.Doc, change one field,
// copy an envelope, ask whether it still matches its preset — all pure, all
// returning fresh plain-JS objects, none of it touching the store or the
// engine. The UI layers (PR 5's stamp, PR 6's panels) own the writes; this
// file owns the arithmetic.
//
// ==========================================================================
// THE MIGRATION THIS FILE EXISTS FOR
// ==========================================================================
// `DX7OpData` stored only the DERIVED `ratio` until now — `parsePackedVoice`
// read the coarse and fine bytes and threw them away. So **every rack already
// saved has `node.data.userPatches[i].operators[j]` with no `coarse` and no
// `fine`**, and a pitch row that reads `op.coarse` straight would render
// nothing at all for an imported cartridge. That is the failure mode, and it
// is why `coarse`/`fine` are OPTIONAL on the type (a required field would be
// a lie TypeScript enforces) and why `resolveOpCoarseFine()` is the ONLY
// supported way to read them.
//
// The fallback is a defined `ratio -> (coarse, fine)` INVERSE. It is exact
// for every ratio the DX7 can actually produce, which is every ratio any real
// cartridge or built-in contains — see `ratioToCoarseFine` for the search and
// the tie-break, and the test for the exhaustive 32x100 round-trip proof.
//
// ⚠ THE ONE TRAP, AND IT IS AN AUDIBLE ONE. The ratio inverse must NEVER be
// used to reconstruct a FIXED-mode operator's frequency. Fixed mode is
// `10^((coarse & 3) + fine/100)`, so the coarse byte means a decade, not a
// multiplier: ratio 4.5 inverts to (coarse 3, fine 50), and `dx7FixedHz(3,50)`
// is 3162 Hz where the original (coarse 4, fine 13) reading would be 1.35 Hz.
// Three and a half decades of error. `resolveOpCoarseFine` therefore takes a
// DIFFERENT path for a fixed-mode operator, recovering the fine byte from the
// stored `fixedHz` (which is exact) and only then the coarse byte from the
// ratio. And nothing here changes `ratio` or `fixedHz` on an existing voice —
// backfilling coarse/fine is strictly ADDITIVE, so migrating a saved rack
// cannot move a single sample of audio.

import type { DX7OpData, DX7Voice } from './dx7-syx';
import { dx7DetuneFactor, dx7FixedHz, dx7FixedHzFromRatio, dx7Ratio } from './dx7-syx';

// ---------------- Yjs-proof primitive readers ----------------
//
// Voices read out of SyncedStore are Yjs PROXIES: the operator objects are
// Y.Map proxies and `op.r` / `op.l` are Y.Array proxies. `structuredClone`
// throws "[object Array] could not be cloned" on them, which is a SHIPPED bug
// (see modules/dx7.ts:261-273) — SYX-loaded voices silently failed to reach
// the worklet while built-ins worked. So: never clone, never spread. Read
// every leaf by index and coerce it.

function readIndex(src: unknown, i: number): unknown {
  if (src == null) return undefined;
  if (Array.isArray(src)) return src[i];
  const anyV = src as Record<number, unknown> & {
    get?: (i: number) => unknown;
    toArray?: () => unknown[];
  };
  const direct = anyV[i];
  if (direct !== undefined) return direct;
  if (typeof anyV.get === 'function') {
    try { return anyV.get(i); } catch { /* not a Y.Array after all */ }
  }
  if (typeof anyV.toArray === 'function') {
    try { return anyV.toArray()[i]; } catch { /* ditto */ }
  }
  return undefined;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function byte(v: unknown, hi = 99, fallback = 0): number {
  const n = Math.round(num(v, fallback));
  return n < 0 ? 0 : n > hi ? hi : n;
}

function quad(src: unknown, hi = 99): [number, number, number, number] {
  return [
    byte(readIndex(src, 0), hi),
    byte(readIndex(src, 1), hi),
    byte(readIndex(src, 2), hi),
    byte(readIndex(src, 3), hi),
  ];
}

function field(src: unknown, key: string): unknown {
  if (src == null || typeof src !== 'object') return undefined;
  return (src as Record<string, unknown>)[key];
}

// ---------------- The ratio inverse ----------------

export interface Dx7CoarseFine {
  /** 0..31. 0 is the special half-pitch base (ratio 0.5). */
  coarse: number;
  /** 0..99. */
  fine: number;
}

/**
 * The `ratio -> (coarse, fine)` INVERSE, for a voice saved before the raw
 * bytes were stored.
 *
 * Forward law: `dx7Ratio(c, f) = base(c) * (1 + f/100)`, `base(0) = 0.5`,
 * `base(c) = c`. That map is MANY-TO-ONE — ratio 3.0 is both (3, 0) and
 * (2, 50) — so an inverse has to choose. We search all 32 bases, take the
 * best `fine` for each (the rounded exact solution), keep the smallest ratio
 * error, and TIE-BREAK ON THE LARGER BASE, i.e. the smaller fine. That is the
 * reading a DX7 player would recognise: ratio 3.0 comes back as COARSE 3 /
 * FINE 0, not as COARSE 2 / FINE 50.
 *
 * Searching every base rather than just `floor(ratio)` matters. Ratio 3.10 is
 * NOT representable on base 3 (its fine steps are 0.03) but is exact on base
 * 2 as fine 55 — `floor` would have returned (3, 3) = 3.09 and quietly
 * detuned the operator by 6 cents on every round trip. With the search, the
 * inverse reproduces the RATIO exactly — zero error, not merely small — for
 * all 3200 reachable (coarse, fine) pairs; the test proves that exhaustively
 * rather than spot-checking.
 *
 * ⚠ EXACT IN RATIO, NOT IN BYTES, and the distinction matters. The forward map
 * has 588 aliases among its 3200 inputs, so 588 pairs come back as their
 * canonical twin — (2, 50) reads back as (3, 0), the same ×3.00. Nothing
 * audible moves (the ratio is identical), but a test asserting BYTE equality
 * on a round trip would fail on those 588 and be right to: the bytes are
 * genuinely unrecoverable once only the ratio was stored. That is the whole
 * reason this PR stores them.
 *
 * ⚠ NOT VALID FOR FIXED MODE — see the file header. Use
 * `resolveOpCoarseFine`, which routes fixed-mode operators elsewhere.
 */
export function ratioToCoarseFine(ratio: number): Dx7CoarseFine {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  let best: Dx7CoarseFine = { coarse: 1, fine: 0 };
  let bestErr = Number.POSITIVE_INFINITY;
  for (let c = 0; c <= 31; c++) {
    const base = c === 0 ? 0.5 : c;
    const fine = Math.max(0, Math.min(99, Math.round((r / base - 1) * 100)));
    const err = Math.abs(dx7Ratio(c, fine) - r);
    // `<=` so that on an exact tie the LARGER base (smaller fine) wins.
    if (err <= bestErr) {
      bestErr = err;
      best = { coarse: c, fine };
    }
  }
  return best;
}

/**
 * The FIXED-mode inverse: recover the raw bytes of an operator that stored
 * only `ratio` + `fixedHz`.
 *
 * `fixedHz = 10^((coarse & 3) + fine/100)` gives the fine byte EXACTLY (it is
 * the fractional decade) but only the low two bits of coarse. The full coarse
 * byte is then recovered from the ratio, which was computed from the SAME
 * pair: `base = ratio / (1 + fine/100)`. If the two disagree (a hand-written
 * or corrupted voice) we keep the decade, because that is the byte the audible
 * frequency actually depends on.
 */
export function fixedHzToCoarseFine(fixedHz: number, ratio: number): Dx7CoarseFine {
  const hz = Number.isFinite(fixedHz) && fixedHz > 0 ? fixedHz : 1;
  const log = Math.log10(hz);
  const decade = Math.max(0, Math.min(3, Math.floor(log)));
  const fine = Math.max(0, Math.min(99, Math.round((log - decade) * 100)));
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const base = r / (1 + fine / 100);
  let coarse = base < 0.75 ? 0 : Math.round(base);
  if (!Number.isInteger(coarse) || coarse < 0 || coarse > 31 || (coarse & 3) !== decade) {
    coarse = decade;
  }
  return { coarse, fine };
}

/**
 * READ AN OPERATOR'S PITCH BYTES. The only supported way — `op.coarse` may
 * legitimately be `undefined` on any voice that predates the field.
 *
 * Returns the stored bytes when present, and otherwise inverts whatever the
 * voice does have, taking the FIXED-mode path when the operator is in fixed
 * mode. Never returns `undefined`, so a pitch row built on it cannot come up
 * empty.
 */
export function resolveOpCoarseFine(op: Partial<DX7OpData> | null | undefined): Dx7CoarseFine {
  const c = op?.coarse;
  const f = op?.fine;
  if (typeof c === 'number' && Number.isFinite(c) && typeof f === 'number' && Number.isFinite(f)) {
    return { coarse: byte(c, 31), fine: byte(f, 99) };
  }
  const ratio = num(op?.ratio, 1);
  if (op?.fixedMode) {
    const hz = op?.fixedHz;
    if (typeof hz === 'number' && Number.isFinite(hz) && hz > 0) {
      return fixedHzToCoarseFine(hz, ratio);
    }
    // NO STORED `fixedHz`, AND THIS MUST NOT FALL THROUGH. Reaching the ratio
    // inverse below would do exactly what this file's header forbids: in fixed
    // mode the coarse byte is a DECADE, not a multiplier, so inverting the
    // ratio mislabels the frequency by up to three and a half decades. A voice
    // in this shape is not hypothetical — `fixedMode` predates `fixedHz` on the
    // type, so every rack saved before it has one.
    //
    // Instead derive the frequency the way the RENDERER derives it, then invert
    // that: `dx7FixedHzFromRatio` is the same mapping `dx7-render.ts` applies,
    // so the bytes we hand back describe the pitch the engine actually plays.
    return fixedHzToCoarseFine(dx7FixedHzFromRatio(ratio), ratio);
  }
  return ratioToCoarseFine(ratio);
}

// ---------------- deepUnwrapVoice ----------------

/**
 * A COMPLETE `DX7Voice` as plain JS, safe to `postMessage`, `structuredClone`,
 * write into the Y.Doc as a fresh value, or diff.
 *
 * ⚠ THIS IS A NEW FUNCTION, NOT AN EXTRACTION of `sendPatch`'s unwrap in
 * modules/dx7.ts. That one builds the worklet's `PatchMessage` operator
 * payload — a DIFFERENT shape, with no `pitchEg`, no `lfo`, and no
 * name/algorithm/feedback/transpose wrapper. Two functions with two jobs;
 * collapsing them loses half the voice on every stamp.
 *
 * The input is deliberately `unknown`: it is usually a Yjs proxy, sometimes a
 * plain built-in, and occasionally `undefined` (a rack whose preset name no
 * longer resolves). Every leaf is read by index and coerced, so nothing here
 * can throw on a proxy and nothing can carry a Y type out.
 *
 * MIGRATION: this also BACKFILLS `coarse`/`fine` through
 * `resolveOpCoarseFine`, so an edit buffer stamped from a legacy voice opens
 * with a populated pitch row. The backfill is strictly ADDITIVE — `ratio`,
 * `detuneFactor` and `fixedHz` are carried across untouched — so migrating a
 * saved rack cannot change what it sounds like.
 */
export function deepUnwrapVoice(input: unknown): DX7Voice {
  const src = (input ?? {}) as Record<string, unknown>;

  const rawOps = field(src, 'operators');
  const operators: DX7OpData[] = [];
  for (let i = 0; i < 6; i++) {
    const o = readIndex(rawOps, i);
    const ratio = num(field(o, 'ratio'), 1);
    const detune = byte(field(o, 'detune'), 14, 7);
    const fixedMode = Boolean(field(o, 'fixedMode'));
    const rawFixedHz = field(o, 'fixedHz');
    const fixedHz =
      typeof rawFixedHz === 'number' && Number.isFinite(rawFixedHz) && rawFixedHz > 0
        ? rawFixedHz
        : undefined;
    const detuneFactorRaw = field(o, 'detuneFactor');
    const { coarse, fine } = resolveOpCoarseFine({
      coarse: typeof field(o, 'coarse') === 'number' ? (field(o, 'coarse') as number) : undefined,
      fine: typeof field(o, 'fine') === 'number' ? (field(o, 'fine') as number) : undefined,
      ratio,
      fixedMode,
      fixedHz,
    });
    operators.push({
      r: quad(field(o, 'r')),
      l: quad(field(o, 'l')),
      coarse,
      fine,
      ratio,
      level: byte(field(o, 'level')),
      detune,
      // Recomputed ONLY when absent — a stored factor is authoritative so an
      // unwrap is a pure copy for any voice that already has one.
      detuneFactor:
        typeof detuneFactorRaw === 'number' && Number.isFinite(detuneFactorRaw)
          ? detuneFactorRaw
          : dx7DetuneFactor(detune),
      velocitySens: byte(field(o, 'velocitySens'), 7),
      fixedMode,
      ...(fixedHz === undefined ? {} : { fixedHz }),
    });
  }

  const pe = field(src, 'pitchEg');
  const lfo = field(src, 'lfo');
  const rawName = field(src, 'name');

  return {
    name: typeof rawName === 'string' ? rawName : String(rawName ?? ''),
    algorithm: byte(field(src, 'algorithm'), 32, 1) || 1,
    feedback: byte(field(src, 'feedback'), 7),
    operators,
    pitchEg: { r: quad(field(pe, 'r')), l: quad(field(pe, 'l')) },
    lfo: {
      speed: byte(field(lfo, 'speed')),
      delay: byte(field(lfo, 'delay')),
      pmd: byte(field(lfo, 'pmd')),
      amd: byte(field(lfo, 'amd')),
      sync: Boolean(field(lfo, 'sync')),
      waveform: byte(field(lfo, 'waveform'), 5),
      pitchModSens: byte(field(lfo, 'pitchModSens'), 7),
    },
    // RAW SYX transpose byte 0..48, biased by +24 (24 = middle C). Default to
    // 24, never 0 — 0 would drop every migrated voice two octaves.
    transpose: byte(field(src, 'transpose'), 48, 24),
  };
}

// ---------------- Editing ----------------

/** Every operator field the panel can edit. Derived values (`ratio`,
 *  `detuneFactor`, `fixedHz`) are NOT in this list — they are recomputed. */
export type Dx7OpField =
  | 'coarse'
  | 'fine'
  | 'detune'
  | 'level'
  | 'velocitySens'
  | 'fixedMode'
  | 'r0' | 'r1' | 'r2' | 'r3'
  | 'l0' | 'l1' | 'l2' | 'l3';

const FIELD_MAX: Record<string, number> = {
  coarse: 31, fine: 99, detune: 14, level: 99, velocitySens: 7,
  r0: 99, r1: 99, r2: 99, r3: 99, l0: 99, l1: 99, l2: 99, l3: 99,
};

/**
 * Set ONE operator field, returning a fresh voice. The input may be a Yjs
 * proxy — it is unwrapped first, so the result is always plain JS and the
 * caller can write it back in a single store mutation.
 *
 * DERIVED VALUES ARE RECOMPUTED HERE, which is the whole point of routing
 * edits through one function: `coarse`/`fine` rewrite `ratio` AND `fixedHz`,
 * `detune` rewrites `detuneFactor`. An editor that wrote `op.coarse` directly
 * would move the pitch row and leave the engine playing the old ratio — a
 * control lying about its own value, the exact class of bug the card-vs-def
 * rule in CLAUDE.md exists for.
 *
 * Out-of-range values are clamped to the field's real domain, and an unknown
 * field or operator index returns the unwrapped voice unchanged rather than
 * throwing.
 */
export function setOpField(
  voice: unknown,
  opIndex: number,
  fieldName: Dx7OpField,
  value: number | boolean,
): DX7Voice {
  const v = deepUnwrapVoice(voice);
  if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex > 5) return v;
  const op = v.operators[opIndex];
  if (!op) return v;

  if (fieldName === 'fixedMode') {
    op.fixedMode = Boolean(value);
  } else if (fieldName.length === 2 && (fieldName[0] === 'r' || fieldName[0] === 'l')) {
    const slot = Number(fieldName[1]);
    // Guard the slot even though `Dx7OpField` already forbids `r9`: this
    // function's `voice` is `unknown` by design, so it is the model layer's
    // untyped edge, and an out-of-range write would GROW the 4-tuple rather
    // than fail — a corrupt voice that typechecks.
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return v;
    const target = fieldName[0] === 'r' ? op.r : op.l;
    target[slot as 0 | 1 | 2 | 3] = byte(value, 99);
  } else if (fieldName in FIELD_MAX) {
    const clamped = byte(value, FIELD_MAX[fieldName]!);
    if (fieldName === 'coarse') op.coarse = clamped;
    else if (fieldName === 'fine') op.fine = clamped;
    else if (fieldName === 'detune') op.detune = clamped;
    else if (fieldName === 'level') op.level = clamped;
    else if (fieldName === 'velocitySens') op.velocitySens = clamped;
  } else {
    return v;
  }

  // Re-derive — but ONLY what this edit actually invalidated.
  //
  // Rewriting `ratio` on every edit would be a silent audio change: a voice
  // whose stored ratio is not exactly representable as a (coarse, fine) pair
  // would have that ratio quantised the first time somebody nudged R1, an
  // unrelated field. Real cartridges never contain such a ratio — every one
  // came out of `dx7Ratio` — but "editing the envelope retuned the operator"
  // is not a failure mode worth leaving reachable.
  const { coarse, fine } = resolveOpCoarseFine(op);
  op.coarse = coarse;
  op.fine = fine;
  if (fieldName === 'coarse' || fieldName === 'fine') {
    op.ratio = dx7Ratio(coarse, fine);
    op.fixedHz = dx7FixedHz(coarse, fine);
  }
  if (fieldName === 'detune') op.detuneFactor = dx7DetuneFactor(op.detune);
  return v;
}

/**
 * Copy operator `fromOp`'s ENVELOPE — its four rates and four levels — onto
 * operator `toOp`, returning a fresh voice. The `COPY EG ->` action.
 *
 * Deliberately does NOT copy the OUTPUT LEVEL: on the DX7 the envelope is the
 * shape and the output level is how loud that shape is in the mix, so copying
 * both would silently re-balance the patch. Same-index or out-of-range copies
 * are a no-op.
 */
export function copyEg(voice: unknown, fromOp: number, toOp: number): DX7Voice {
  const v = deepUnwrapVoice(voice);
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i <= 5;
  if (!ok(fromOp) || !ok(toOp) || fromOp === toOp) return v;
  const src = v.operators[fromOp];
  const dst = v.operators[toOp];
  if (!src || !dst) return v;
  dst.r = [src.r[0], src.r[1], src.r[2], src.r[3]];
  dst.l = [src.l[0], src.l[1], src.l[2], src.l[3]];
  return v;
}

// ---------------- isDirty ----------------

/**
 * A canonical, comparable form of a voice.
 *
 * PITCH IS KEYED ON WHAT THE ENGINE PLAYS, NOT ON THE RAW BYTES, and that is
 * the one non-obvious decision in this file. The forward ratio law has 588
 * ALIASES among its 3200 (coarse, fine) pairs — ×7.00 is both (7, 0) and
 * (5, 40) — and which one a voice holds is EXACTLY the information a legacy
 * voice lost. So a byte comparison lights the dirty chip on a rack nobody
 * touched: the built-in TUB BELLS authors op5 as COARSE 5 / FINE 40, a saved
 * rack has only its ratio, and the inverse canonicalises that back to the
 * larger base (7, 0). Same ×7.00, same audio, different bytes, false chip.
 * (Found by the migration test, which is why that test loads the real
 * built-ins rather than a hand-written fixture.)
 *
 * Keying on the ENGINE's number closes it for good, and is what this
 * function's caller already promises — `isDirty` compares the SOUND. The
 * expression below is verbatim what `dx7-render.ts` feeds the oscillator:
 * fixed mode plays `fixedHz` (falling back to the legacy ratio derivation),
 * everything else plays `ratio`.
 *
 * THE TRADE, stated so nobody re-litigates it silently: moving COARSE 2 /
 * FINE 50 to COARSE 3 / FINE 0 by hand no longer reads as dirty. Nothing
 * audible changed, so the chip is right to stay clean — and a false chip on
 * every migrated rack is a far worse failure than an unflagged inaudible
 * nudge. `detuneFactor` stays out for the same "derived, don't double-count"
 * reason as before; `detune` (the byte) is in, and it has no aliases.
 */
function canonicalVoice(voice: unknown): string {
  const v = deepUnwrapVoice(voice);
  const ops = v.operators.map((o) => {
    const pitch = o.fixedMode
      ? typeof o.fixedHz === 'number' && Number.isFinite(o.fixedHz) && o.fixedHz > 0
        ? o.fixedHz
        : dx7FixedHzFromRatio(o.ratio)
      : o.ratio;
    return [pitch, o.level, o.detune, o.velocitySens, o.fixedMode ? 1 : 0, ...o.r, ...o.l];
  });
  return JSON.stringify([
    v.algorithm,
    v.feedback,
    v.transpose,
    ops,
    v.pitchEg.r,
    v.pitchEg.l,
    [v.lfo.speed, v.lfo.delay, v.lfo.pmd, v.lfo.amd, v.lfo.sync ? 1 : 0, v.lfo.waveform, v.lfo.pitchModSens],
  ]);
}

/**
 * Has the edit buffer diverged from the preset it was stamped from? — the
 * `E.PIANO 1 ✱` dirty chip.
 *
 * Compares the SOUND, not the label — literally: `name` is excluded (the
 * origin name is a display label held separately in `node.data.preset`, and
 * renaming happens at STORE time, not as an edit), and PITCH is compared as
 * the frequency the engine plays rather than as raw bytes. See
 * `canonicalVoice` for why the second half is load-bearing and not merely
 * tidy — without it, every migrated rack holding an ALIASED ratio (the
 * built-in TUB BELLS is one) opens with a false dirty chip.
 *
 * A missing preset (an unresolvable name) reads as NOT dirty rather than
 * permanently dirty; there is nothing to have diverged from.
 */
export function isDirty(voice: unknown, preset: unknown): boolean {
  if (voice == null || preset == null) return false;
  return canonicalVoice(voice) !== canonicalVoice(preset);
}
