// packages/web/src/lib/audio/modules/hydrogen-kit-registry.ts
//
// Central registry of every HYDROGEN drumkit. The `kit` param on a
// HYDROGEN node indexes into KITS to pick the active kit; switching
// the param re-points fireInstrument() at the new kit's instrument
// table (sample url + synth fn + default mix), and the factory
// preloads any sample assets the new kit needs.
//
// Kit count = 4 today (1 sample + 3 synth). Adding more is a 2-line
// change: import the new KitDef + push it into the array.

import type { KitDef } from './hydrogen-kit-types';
import { tr808ToKitInstrument } from './hydrogen-kit-types';
import { TR808_INSTRUMENTS } from './hydrogen-tr808-kit-data';
import { TR909_KIT } from './hydrogen-tr909-kit';
import { FMPERC_KIT } from './hydrogen-fmperc-kit';
import { EIGHT_BIT_KIT } from './hydrogen-8bit-kit';

/** TR-808 entry — wraps the legacy sample-table into the new
 *  KitDef shape so the registry is uniform. */
const TR808_KIT: KitDef = {
  id: 'tr808',
  name: 'TR-808',
  attribution: 'Hydrogen-music TR808EmulationKit (GPL-2.0+, ArtemioLabs)',
  instruments: TR808_INSTRUMENTS.map(tr808ToKitInstrument),
};

/** Ordered registry — the index is the value the `kit` param stores.
 *  Insertion order is the order kits appear in the picker dropdown.
 *  Reordering will change which kit a saved patch resolves to, so add
 *  new kits at the END of the array. */
export const KITS: readonly KitDef[] = [
  TR808_KIT,
  TR909_KIT,
  FMPERC_KIT,
  EIGHT_BIT_KIT,
];

export const KIT_COUNT = KITS.length;

/** Default kit (TR-808) — the value `kit` initializes to. */
export const DEFAULT_KIT_INDEX = 0;

/** Look up a kit by its numeric index (clamped). */
export function kitByIndex(idx: number): KitDef {
  const clamped = Math.max(0, Math.min(KITS.length - 1, Math.round(idx)));
  // Length-checked via clamp above, so the bang is safe.
  return KITS[clamped]!;
}

/** Look up a kit by its stable id. Useful for round-tripping legacy
 *  patches that stored the id as a string instead of an index. */
export function kitById(id: string): KitDef | undefined {
  return KITS.find((k) => k.id === id);
}

/** Every distinct sample URL across every kit. The factory's preload
 *  step uses this to prime the cache on first-spawn. */
export function allSampleUrls(): string[] {
  const out = new Set<string>();
  for (const kit of KITS) {
    for (const inst of kit.instruments) {
      if (inst.kind === 'sample') out.add(inst.sampleUrl);
    }
  }
  return [...out];
}
