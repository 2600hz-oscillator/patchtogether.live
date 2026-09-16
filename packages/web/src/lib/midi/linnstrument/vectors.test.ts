// Runs every acceptance vector V01–V16 through the pure ops and asserts its
// `expected[]`. SYNTHETIC corpus (vectors.ts header). Negative control: each
// vector names one byte whose corruption must make ITS OWN entry fail, so a
// green run is known to be a run the instrument could have failed.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LINN_PROFILE } from './profile';

/** packages/web/src/lib/midi/linnstrument → <repo>/e2e/tests */
const REPO_E2E_TESTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'e2e', 'tests');
import { createRawDecodeState, decodePhysicalMidi, reconnectRawDecode, type RawDecodeState } from './raw-decode';
import { createSurfaceMapState, mapSurface, type SurfaceMapState } from './surface-map';
import { createSelectionState, intentsFromRuntimeEvent, persistedSelection, reduceAll } from './selection-reducer';
import { ACCEPTANCE_VECTORS, VECTOR_EVIDENCE_KIND, VECTOR_IDS, type AcceptanceVector, type VectorExpectation } from './vectors';
import type { LinnProfile, MusicalRegion, RawEvent, RuntimeEvent, SelectionState } from './types';
import { activeVoices, applyTouch, createMpeState, decodeMpe, resetMpe, voicePitchCv, type MpeEvent, type MpeState } from '../mpe-state';

interface Run {
  raw: RawEvent[];
  surface: RuntimeEvent[];
  voiceEvents: Record<MusicalRegion | 'stock', MpeEvent[]>;
  mpe: Record<MusicalRegion | 'stock', MpeState>;
  selection: SelectionState;
  selectionAfter: SelectionState[];
  activeAfter: Record<MusicalRegion | 'stock', number>[];
}

function execute(vector: AcceptanceVector): Run {
  const profile: LinnProfile = { ...DEFAULT_LINN_PROFILE, ...vector.profile };
  let rawState: RawDecodeState = createRawDecodeState(1, true); // the instrument has confirmed User Mode
  let mapState: SurfaceMapState = createSurfaceMapState();
  let selection = createSelectionState(profile);
  const mpe = { keys: createMpeState({ lanes: profile.lanesPerRegion }), pad: createMpeState({ lanes: profile.lanesPerRegion }), stock: createMpeState({ lanes: vector.lanes ?? 16 }) };
  const run: Run = { raw: [], surface: [], voiceEvents: { keys: [], pad: [], stock: [] }, mpe, selection, selectionAfter: [], activeAfter: [] };
  const counts = () => ({ keys: mpe.keys.voices.size, pad: mpe.pad.voices.size, stock: mpe.stock.voices.size });

  const consume = (events: RawEvent[]) => {
    for (const r of events) {
      run.raw.push(r);
      const m = mapSurface(mapState, r, profile);
      mapState = m.state;
      for (const s of m.events) {
        run.surface.push(s);
        selection = reduceAll(selection, intentsFromRuntimeEvent(s, profile), profile).state;
        if (s.kind === 'session') {
          run.voiceEvents.keys.push(...resetMpe(mpe.keys, s.time));
          run.voiceEvents.pad.push(...resetMpe(mpe.pad, s.time));
        } else if (s.kind !== 'pointer' && s.kind !== 'control_edge') {
          run.voiceEvents[s.region].push(...applyTouch(mpe[s.region], s));
        }
      }
    }
  };

  vector.bytes.forEach((message, i) => {
    const t = vector.sourceTime[i] ?? i;
    if (vector.pipeline === 'stock_mpe') {
      run.voiceEvents.stock.push(...decodeMpe(mpe.stock, message, t));
    } else {
      const r = decodePhysicalMidi(rawState, message, t);
      rawState = r.state;
      consume(r.events);
      if (vector.reconnectAfter === i) {
        const rc = reconnectRawDecode(rawState, t + 0.0005);
        rawState = rc.state;
        consume(rc.events);
      }
      if (vector.roundTripAfter === i) {
        // V05: persist the durable subset, rebuild everything else from scratch.
        const persisted = JSON.parse(JSON.stringify(persistedSelection(selection))) as ReturnType<typeof persistedSelection>;
        selection = reduceAll(createSelectionState(profile), [{ kind: 'hydrate', ...persisted }], profile).state;
        mpe.keys = createMpeState({ lanes: profile.lanesPerRegion });
        mpe.pad = createMpeState({ lanes: profile.lanesPerRegion });
        rawState = createRawDecodeState(rawState.epoch, true);
        mapState = createSurfaceMapState();
      }
    }
    run.selectionAfter.push(selection);
    run.activeAfter.push(counts());
  });
  run.selection = selection;
  return run;
}

const isSubset = (actual: unknown, match: unknown): boolean => {
  if (typeof match !== 'object' || match === null) {
    return typeof match === 'number' && typeof actual === 'number' ? Math.abs(actual - match) < 1e-9 : actual === match;
  }
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.entries(match as Record<string, unknown>).every(([k, v]) => isSubset((actual as Record<string, unknown>)[k], v));
};
const countMatches = <T>(items: readonly T[], match: unknown): number => items.filter((i) => isSubset(i, match)).length;
const pairClose = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/** Returns the failures an expectation produces against a run (empty = pass). */
function check(vector: AcceptanceVector, run: Run, e: VectorExpectation): string[] {
  const stockRegion = vector.pipeline === 'stock_mpe' ? 'stock' : undefined;
  const regionOf = (r?: MusicalRegion): MusicalRegion | 'stock' => r ?? stockRegion ?? 'keys';
  switch (e.kind) {
    case 'raw': {
      const n = countMatches(run.raw, e.match);
      return (e.count === undefined ? n >= 1 : n === e.count) ? [] : [`raw ${JSON.stringify(e.match)}: ${n} matches`];
    }
    case 'raw_rejected': {
      const n = countMatches(run.raw, { kind: 'rejected', reason: e.reason });
      return n === e.count ? [] : [`raw_rejected ${e.reason}: ${n} ≠ ${e.count}`];
    }
    case 'surface': {
      const n = countMatches(run.surface, e.match);
      return (e.count === undefined ? n >= 1 : n === e.count) ? [] : [`surface ${JSON.stringify(e.match)}: ${n} matches`];
    }
    case 'selection': {
      const s = e.after === undefined ? run.selection : run.selectionAfter[e.after]!;
      const out: string[] = [];
      for (const [id, on] of Object.entries(e.mask ?? {})) if (s.mask[id as 'r'] !== on) out.push(`mask.${id} = ${s.mask[id as 'r']} ≠ ${on}`);
      for (const [id, p] of Object.entries(e.pairs ?? {})) if (!pairClose(s.pairs[id as 'r'], p!)) out.push(`pairs.${id} = ${JSON.stringify(s.pairs[id as 'r'])} ≉ ${JSON.stringify(p)}`);
      if (e.pointerFree && s.pointer.touch !== null) out.push('pointer not free');
      return out;
    }
    case 'voice_active': {
      const region = regionOf(e.region);
      const n = e.after === undefined ? run.mpe[region].voices.size : run.activeAfter[e.after]![region];
      return n === e.count ? [] : [`voice_active ${region}: ${n} ≠ ${e.count}`];
    }
    case 'voice': {
      const voices = activeVoices(run.mpe[regionOf(e.region)]);
      const hits = voices.filter((v) => isSubset(v, e.match) && (e.pitchCv === undefined || Math.abs(voicePitchCv(v) - e.pitchCv) < 1e-9));
      const ok = e.count === undefined ? hits.length >= 1 : hits.length === e.count;
      return ok ? [] : [`voice ${JSON.stringify(e.match)}${e.pitchCv === undefined ? '' : ` pitchCv=${e.pitchCv}`}: ${hits.length} matches`];
    }
    case 'voice_event': {
      const events = run.voiceEvents[regionOf(e.region)];
      const n = events.filter((ev) => ev.kind === e.event && (e.voice === undefined || isSubset(ev.voice, e.voice)) && (e.reason === undefined || (ev.kind === 'voice_end' && ev.reason === e.reason))).length;
      return (e.count === undefined ? n >= 1 : n === e.count) ? [] : [`voice_event ${e.event}${e.reason ? `/${e.reason}` : ''}: ${n} matches`];
    }
    case 'deferred':
    case 'audible':
      return [];
  }
}

const failuresOf = (vector: AcceptanceVector): string[] => {
  const run = execute(vector);
  return vector.expected.flatMap((e) => check(vector, run, e));
};

describe('acceptance vectors: corpus shape', () => {
  it('keeps V01–V16 as its index, in order, every entry labelled synthetic', () => {
    expect(VECTOR_IDS).toEqual(Array.from({ length: 16 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`));
    for (const v of ACCEPTANCE_VECTORS) {
      expect(v.evidenceKind).toBe(VECTOR_EVIDENCE_KIND);
      expect(v.sourceTime).toHaveLength(v.bytes.length);
      expect(v.bytes.length).toBeGreaterThan(0);
      expect(v.negativeControl.message).toBeLessThan(v.bytes.length);
      expect(v.negativeControl.byte).toBeLessThan(v.bytes[v.negativeControl.message]!.length);
    }
  });

  it('exactly V12, V13 and V16 defer a claim to a later WP — and each still asserts state here', () => {
    const deferred = ACCEPTANCE_VECTORS.filter((v) => v.expected.some((e) => e.kind === 'deferred'));
    expect(deferred.map((v) => v.id)).toEqual(['V12', 'V13', 'V16']);
    for (const v of deferred) expect(v.expected.filter((e) => e.kind !== 'deferred').length).toBeGreaterThan(0);
  });

  it('V15 alone names the e2e spec that owns its audible half — and that spec exists', () => {
    const audible = ACCEPTANCE_VECTORS.filter((v) => v.expected.some((e) => e.kind === 'audible'));
    expect(audible.map((v) => v.id)).toEqual(['V15']);
    for (const v of audible) {
      expect(v.expected.filter((e) => e.kind !== 'audible').length).toBeGreaterThan(0);
      for (const e of v.expected) {
        if (e.kind !== 'audible') continue;
        expect(existsSync(join(REPO_E2E_TESTS, e.spec)), `${v.id}: ${e.spec} must exist under e2e/tests/`).toBe(true);
      }
    }
  });
});

describe('acceptance vectors: every entry passes through the pure ops', () => {
  it.each(ACCEPTANCE_VECTORS.map((v) => [v.id, v.name, v] as const))('%s %s', (_id, _name, vector) => {
    expect(failuresOf(vector)).toEqual([]);
  });
});

describe('acceptance vectors: negative control — a corrupted byte fails its own entry', () => {
  it.each(ACCEPTANCE_VECTORS.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    const { message, byte, value } = vector.negativeControl;
    const bytes = vector.bytes.map((m) => [...m]);
    expect(bytes[message]![byte]).not.toBe(value);
    bytes[message]![byte] = value;
    const failures = failuresOf({ ...vector, bytes });
    expect(failures.length).toBeGreaterThan(0);
  });
});
