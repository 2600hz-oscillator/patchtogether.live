// Mobile matrix helpers — pure-core unit tests against the REAL defs
// (mixmstrs stereo pairs + sections, audioOut L/R, analogVco mono outputs).

import { describe, expect, it } from 'vitest';
import { getModuleDef } from '$lib/audio/module-registry';
import '$lib/audio/modules';
import {
  buildInputRows,
  inputJacks,
  outputJacks,
  mixmstrsSection,
  mixmstrsSectionRows,
  planPairPatch,
  splitRowsByCompatibility,
  stereoSiblingOutput,
  type DefLike,
} from './matrix-mobile';

const mixDef = getModuleDef('mixmstrs') as unknown as DefLike;
const outDef = getModuleDef('audioOut') as unknown as DefLike;
const vcoDef = getModuleDef('analogVco') as unknown as DefLike;
const adsrDef = getModuleDef('adsr') as unknown as DefLike;

describe('jack filtering', () => {
  it('outputs×inputs pre-filter: only outputs on the FROM side, inputs on the TO side', () => {
    expect(outputJacks(vcoDef).every((j) => j.direction === 'output')).toBe(true);
    expect(inputJacks(mixDef).every((j) => j.direction === 'input')).toBe(true);
    // mixmstrs: 16 audio + 61 CV inputs = 77.
    expect(inputJacks(mixDef)).toHaveLength(77);
  });
});

describe('stereo-pair rows', () => {
  it('mixmstrs ch/ret L+R inputs merge into pair rows (declared stereoPairs)', () => {
    const rows = buildInputRows(mixDef);
    const pairs = rows.filter((r) => r.kind === 'pair');
    // 6 channels + 2 returns = 8 pairs.
    expect(pairs).toHaveLength(8);
    const ch1 = pairs.find((p) => p.kind === 'pair' && p.left.portId === 'ch1L');
    expect(ch1 && ch1.kind === 'pair' && ch1.right.portId).toBe('ch1R');
  });

  it('audioOut bare L/R merges into one L+R row (naming fallback, no stereoPairs)', () => {
    const rows = buildInputRows(outDef);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('pair');
  });

  it('non-paired inputs stay single rows (adsr gate + cv inputs)', () => {
    const rows = buildInputRows(adsrDef);
    expect(rows.every((r) => r.kind === 'single')).toBe(true);
  });
});

describe('stereo tap plan', () => {
  it('mono source (analogVco.saw) double-patches BOTH sides of the pair', () => {
    const rows = buildInputRows(mixDef);
    const ch1 = rows.find((r) => r.kind === 'pair' && r.left.portId === 'ch1L');
    expect(ch1?.kind).toBe('pair');
    const plan = planPairPatch(outputJacks(vcoDef), 'saw', ch1 as never);
    expect(plan).toEqual([
      { sourcePortId: 'saw', targetPortId: 'ch1L' },
      { sourcePortId: 'saw', targetPortId: 'ch1R' },
    ]);
  });

  it('recognizable stereo source (mixmstrs.masterL) goes L→L / R→R', () => {
    const rows = buildInputRows(outDef);
    const plan = planPairPatch(outputJacks(mixDef), 'masterL', rows[0] as never);
    expect(plan).toEqual([
      { sourcePortId: 'masterL', targetPortId: 'L' },
      { sourcePortId: 'masterR', targetPortId: 'R' },
    ]);
  });

  it('stereoSiblingOutput recognizes masterL/R + send pairs, rejects mono outputs', () => {
    const outs = outputJacks(mixDef);
    expect(stereoSiblingOutput(outs, 'masterL')?.portId).toBe('masterR');
    expect(stereoSiblingOutput(outs, 'send2L')?.portId).toBe('send2R');
    expect(stereoSiblingOutput(outputJacks(vcoDef), 'saw')).toBeNull();
  });
});

describe('row compatibility filter', () => {
  it('hides rows no FROM output can reach (vco outputs cannot feed a video input)', () => {
    const fakeVideoIn: DefLike = {
      inputs: [
        { id: 'in', type: 'video' },
        { id: 'gain', type: 'cv' },
      ],
      outputs: [],
    };
    const rows = buildInputRows(fakeVideoIn);
    const { compatible, hidden } = splitRowsByCompatibility(rows, outputJacks(vcoDef));
    // The video input is hidden; the cv input is reachable (audio outputs
    // can't drive cv, but the vco has no cv outputs either — check both).
    expect(hidden).toBeGreaterThanOrEqual(1);
    expect(compatible.every((r) => r.kind === 'single' && r.jack.type !== 'video')).toBe(true);
  });

  it('adsr.env (cv) reaches mixmstrs volume CV rows', () => {
    const rows = buildInputRows(mixDef);
    const { compatible } = splitRowsByCompatibility(rows, outputJacks(adsrDef));
    expect(
      compatible.some((r) => r.kind === 'single' && r.jack.portId === 'ch1_volume'),
    ).toBe(true);
  });
});

describe('mixmstrs sections', () => {
  it('classifies every input into a section', () => {
    expect(mixmstrsSection('ch1L')).toBe('ch1');
    expect(mixmstrsSection('ch3_volume')).toBe('ch3');
    expect(mixmstrsSection('comp6')).toBe('ch6');
    expect(mixmstrsSection('ret2R')).toBe('ret');
    expect(mixmstrsSection('master_volume')).toBe('master-cv');
  });

  it('scopes rows to one section with the audio/cv split (CH1 = 1 pair + 10 cv)', () => {
    const rows = buildInputRows(mixDef);
    const { audio, cv } = mixmstrsSectionRows(rows, 'ch1');
    expect(audio).toHaveLength(1); // the ch1 L+R pair
    expect(audio[0]!.kind).toBe('pair');
    // 9 ch1_* params + comp1 = 10 CV inputs.
    expect(cv).toHaveLength(10);
  });

  it('every one of the 77 inputs lands in exactly one section', () => {
    const rows = buildInputRows(mixDef);
    let count = 0;
    for (const s of ['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6', 'ret', 'master-cv'] as const) {
      const { audio, cv } = mixmstrsSectionRows(rows, s);
      for (const r of [...audio, ...cv]) count += r.kind === 'pair' ? 2 : 1;
    }
    expect(count).toBe(77);
  });
});
