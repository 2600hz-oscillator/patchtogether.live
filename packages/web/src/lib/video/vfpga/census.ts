// packages/web/src/lib/video/vfpga/census.ts
//
// Fabric RESOURCE CENSUS + fit advisory (hardware-accuracy A2).
//
// The audit flagged two "a feeling" gaps: the fabric's only resource cap is the
// self-declared `budget` (validated against itself), and a net source may drive
// UNLIMITED fan-out for free. A real FPGA has a FIXED part with finite LUTs / FFs
// / DSP slices and finite interconnect, and place-and-route FAILS when a design
// doesn't fit. This module models that honestly:
//
//   • censusFabric()    — count the silicon a fabric actually uses, mapping each
//                         tile type onto its primitive: clb + lut16 → a LUT,
//                         reg → a flip-flop, dsp → a DSP slice, bram → BRAM rows,
//                         iob_* → an IOB; plus the worst per-source fan-out.
//   • fabricAdvisories()— compare that census to the spec's optional fixed
//                         `device` (VfpgaDevice) and return human-readable
//                         "doesn't fit" / "fan-out too high" strings.
//
// ADVISORY by design (per the A2 verdict): these do NOT reject a fabric (a hard
// gate would reject the current catalog) — they are pure, GL-free diagnostics a
// caller can surface or escalate. No consumer wires them as a gate yet.

import type { VfpgaFabric, VfpgaDevice } from './types';

export interface VfpgaCensus {
  /** LUTs used = clb + lut16 tiles (each a LUT-configured cell). */
  luts: number;
  /** Flip-flops used = reg tiles (each a 1-frame register). */
  ffs: number;
  /** Hard DSP slices used = dsp tiles. */
  dsp: number;
  /** BRAM rows used = Σ bram-tile `rows`. */
  bramRows: number;
  /** I/O blocks used = iob_in + iob_out tiles. */
  iobs: number;
  /** Compute tiles = everything that emits a render pass (non-IOB). */
  computeTiles: number;
  /** Worst fan-out: the most net sinks driven by any single source. */
  maxFanout: number;
  /** The `net.from` source behind `maxFanout` (null when there are no nets). */
  maxFanoutSource: string | null;
}

/** Count the silicon a fabric uses (pure; tile-type → primitive mapping). */
export function censusFabric(fabric: VfpgaFabric): VfpgaCensus {
  let luts = 0;
  let ffs = 0;
  let dsp = 0;
  let bramRows = 0;
  let iobs = 0;
  let computeTiles = 0;
  for (const t of fabric.tiles) {
    switch (t.type) {
      case 'clb':
      case 'lut16':
        luts++;
        computeTiles++;
        break;
      case 'reg':
        ffs++;
        computeTiles++;
        break;
      case 'dsp':
        dsp++;
        computeTiles++;
        break;
      case 'bram':
        bramRows += t.config.rows ?? 0;
        computeTiles++;
        break;
      case 'iob_in':
      case 'iob_out':
        iobs++;
        break;
    }
  }

  // Fan-out per source: how many nets share each `net.from`.
  const fanout = new Map<string, number>();
  for (const net of fabric.nets) fanout.set(net.from, (fanout.get(net.from) ?? 0) + 1);
  let maxFanout = 0;
  let maxFanoutSource: string | null = null;
  for (const [src, n] of fanout) {
    if (n > maxFanout) {
      maxFanout = n;
      maxFanoutSource = src;
    }
  }

  return { luts, ffs, dsp, bramRows, iobs, computeTiles, maxFanout, maxFanoutSource };
}

/** Compare a fabric's census to an optional fixed `device` and return advisory
 *  (non-fatal) "doesn't fit" / fan-out strings. Empty = fits (or no device set).
 *  Uses `fabric.device` unless `device` is passed explicitly. */
export function fabricAdvisories(fabric: VfpgaFabric, device: VfpgaDevice | undefined = fabric.device): string[] {
  if (!device) return [];
  const c = censusFabric(fabric);
  const out: string[] = [];
  if (device.luts !== undefined && c.luts > device.luts) {
    out.push(`LUTs over device: uses ${c.luts} > ${device.luts} available`);
  }
  if (device.ffs !== undefined && c.ffs > device.ffs) {
    out.push(`flip-flops over device: uses ${c.ffs} > ${device.ffs} available`);
  }
  if (device.dsp !== undefined && c.dsp > device.dsp) {
    out.push(`DSP slices over device: uses ${c.dsp} > ${device.dsp} available`);
  }
  if (device.maxFanout !== undefined && c.maxFanout > device.maxFanout) {
    out.push(
      `fan-out over device: source "${c.maxFanoutSource}" drives ${c.maxFanout} sinks > ${device.maxFanout} max ` +
        `(real interconnect needs replication/buffering past this)`,
    );
  }
  return out;
}
