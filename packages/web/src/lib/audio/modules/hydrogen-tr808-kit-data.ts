// packages/web/src/lib/audio/modules/hydrogen-tr808-kit.ts
//
// Bundled Roland TR-808-emulation drumkit, sourced from the Hydrogen
// drum-machine project's stock TR808EmulationKit.
//   * upstream:  https://github.com/hydrogen-music/hydrogen
//   * kit author: ArtemioLabs (http://artemiolabs.com)
//   * upstream license: GPL (kit-specific; the surrounding Hydrogen
//     project is GPL-2.0+). Compatible with patchtogether.live's
//     AGPL-3.0-or-later relicense (PR #210).
//
// 16 single-layer instruments — no velocity-stacked samples, no mute
// groups defined in the source XML. We add the canonical hihat-triad
// choke (closed/open/pedal share a mute group) because that's what
// users expect from a drum machine even when Hydrogen's data file
// doesn't model it. Per-instrument defaults (gain, pan, A/D/S/R-ms)
// mirror the values from drumkit.xml; everything is also user-tunable
// via the HydrogenCard knobs.
//
// Samples live in /drumkits/tr808/*.flac (SvelteKit static dir). The
// factory fetches + decodeAudioData()s each one once per AudioContext
// and caches the AudioBuffer keyed by sample url.

export interface TR808Instrument {
  /** Stable per-kit index (0..15) — used as a port id suffix and as the
   *  row id in the pattern grid. */
  id: number;
  /** Short display label for the pattern editor row + handle label. */
  label: string;
  /** Display name (the human-friendly version from drumkit.xml). */
  name: string;
  /** GM-MIDI note this instrument maps to in Hydrogen. Useful for
   *  external MIDI-driven workflows once we add MIDI-CV-BUDDY pairing. */
  midiNote: number;
  /** Sample URL relative to the SvelteKit static dir root. */
  sampleUrl: string;
  /** Per-instrument default gain (0..2). Maps to drumkit.xml `gain`. */
  defaultGain: number;
  /** Per-instrument default pan (-1 = full left, +1 = full right).
   *  Derived from drumkit.xml's pan_L / pan_R pair. */
  defaultPan: number;
  /** Default amplitude ADSR. attack/decay/release in seconds (the XML
   *  is milliseconds; we normalize here). sustain is 0..1. The TR808
   *  XML uses A=0, D=0, S=1, R=1 — i.e. a pass-through envelope; the
   *  user can dial in shaping via the per-instrument knobs. */
  defaultA: number;
  defaultD: number;
  defaultS: number;
  defaultR: number;
  /** Mute group id. Voices sharing a mute group choke each other on
   *  re-trigger (the classic hihat-triad behaviour). 0 = no group. */
  muteGroup: number;
}

const HAT_GROUP = 1;

export const TR808_INSTRUMENTS: readonly TR808Instrument[] = [
  { id:  0, label: 'KICK1',  name: 'Kick Long',  midiNote: 35, sampleUrl: '/drumkits/tr808/808_Kick_Long.flac',  defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  1, label: 'KICK2',  name: 'Kick Short', midiNote: 36, sampleUrl: '/drumkits/tr808/808_Kick_Short.flac', defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  2, label: 'SNR1',   name: 'Snare 1',    midiNote: 38, sampleUrl: '/drumkits/tr808/808_Snare_1.flac',    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  3, label: 'SNR2',   name: 'Snare 2',    midiNote: 40, sampleUrl: '/drumkits/tr808/808_Snare_2.flac',    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  4, label: 'CLAP',   name: 'Clap',       midiNote: 39, sampleUrl: '/drumkits/tr808/808_Clap.flac',       defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  5, label: 'HHc',    name: 'Hat Closed', midiNote: 42, sampleUrl: '/drumkits/tr808/808_Hat_Closed.flac', defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: HAT_GROUP },
  { id:  6, label: 'HHo',    name: 'Hat Open',   midiNote: 46, sampleUrl: '/drumkits/tr808/808_Hat_Open.flac',   defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: HAT_GROUP },
  { id:  7, label: 'HHp',    name: 'Hat Pedal',  midiNote: 44, sampleUrl: '/drumkits/tr808/808_Hat_Pedal.flac',  defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: HAT_GROUP },
  { id:  8, label: 'TomH',   name: 'Tom Hi',     midiNote: 50, sampleUrl: '/drumkits/tr808/808_Tom_Hi.flac',     defaultGain: 1.0, defaultPan: 0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id:  9, label: 'TomM',   name: 'Tom Mid',    midiNote: 47, sampleUrl: '/drumkits/tr808/808_Tom_Mid.flac',    defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 10, label: 'TomL',   name: 'Tom Low',    midiNote: 43, sampleUrl: '/drumkits/tr808/808_Tom_Low.flac',    defaultGain: 1.0, defaultPan: -0.4, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 11, label: 'CONGA',  name: 'Conga',      midiNote: 63, sampleUrl: '/drumkits/tr808/808_Conga.flac',      defaultGain: 1.0, defaultPan: 0, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 12, label: 'CYMB',   name: 'Cymbal',     midiNote: 49, sampleUrl: '/drumkits/tr808/808_Cymbal.flac',     defaultGain: 0.85, defaultPan: 0.3, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 13, label: 'SHAKE',  name: 'Shaker',     midiNote: 70, sampleUrl: '/drumkits/tr808/808_Shaker.flac',     defaultGain: 0.9, defaultPan: -0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 14, label: 'CLAVE',  name: 'Clave',      midiNote: 75, sampleUrl: '/drumkits/tr808/808_Clave.flac',      defaultGain: 0.9, defaultPan: 0.2, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
  { id: 15, label: 'CWBLL',  name: 'Cowbell',    midiNote: 56, sampleUrl: '/drumkits/tr808/808_Cowbell.flac',    defaultGain: 0.85, defaultPan: 0.25, defaultA: 0, defaultD: 0, defaultS: 1, defaultR: 1.0, muteGroup: 0 },
];

export const TR808_INSTRUMENT_COUNT = TR808_INSTRUMENTS.length;

/** Look up an instrument by its 0..15 id; throws on out-of-range so
 *  callers can rely on a non-null return. */
export function tr808InstrumentById(id: number): TR808Instrument {
  const inst = TR808_INSTRUMENTS[id];
  if (!inst) throw new Error(`TR808 instrument id ${id} out of range`);
  return inst;
}

// ---------------- Sample cache ----------------
//
// One AudioBuffer per sample url per AudioContext. The cache survives
// multiple HYDROGEN node instances in the same rack — spawning N
// hydrogens shares the decoded buffers.

const sampleCache = new WeakMap<AudioContext, Map<string, Promise<AudioBuffer>>>();

export async function loadTR808Sample(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let perCtx = sampleCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    sampleCache.set(ctx, perCtx);
  }
  const cached = perCtx.get(url);
  if (cached) return cached;
  const pending = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HYDROGEN sample fetch ${url} → ${r.status}`);
      return r.arrayBuffer();
    })
    .then((ab) => ctx.decodeAudioData(ab));
  perCtx.set(url, pending);
  return pending;
}

/** Eagerly prime the cache for every kit sample. The factory calls this
 *  once on instantiation so first-trigger latency stays bounded — without
 *  the prefetch a `gate-on → fetch(url) → decode → BufferSource.start()`
 *  round-trip would smear a few hundred ms of jitter across the first
 *  pattern bar. */
export async function preloadTR808Kit(ctx: AudioContext): Promise<void> {
  await Promise.all(TR808_INSTRUMENTS.map((i) => loadTR808Sample(ctx, i.sampleUrl)));
}
