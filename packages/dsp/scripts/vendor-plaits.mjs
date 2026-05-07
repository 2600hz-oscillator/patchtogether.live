// packages/dsp/scripts/vendor-plaits.mjs
//
// One-shot helper that copies the minimal subset of Mutable Instruments'
// Plaits + stmlib source we need to compile the FM engine to wasm into
// packages/dsp/vendor/plaits/. License: MIT (per-file headers preserved).
//
// Source root is taken from PLAITS_SRC env (default
// /Users/2600hz/Documents/workspace/eurorack — the user's local checkout).
// stmlib is a submodule of the eurorack repo; this script will exit with
// a clear error if the source tree isn't initialized.
//
// We vendor on a per-file basis (not git submodules) to keep the deployed
// repo self-contained and reproducible across CI. The set is minimal —
// only what fm_engine.cc and its include graph reach. Adding more engines
// (Modal, Granular, Speech, ...) means appending to the FILES array and
// rerunning this script.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = join(__dirname, '..', 'vendor', 'plaits');
const SRC_ROOT = process.env.PLAITS_SRC || '/Users/2600hz/Documents/workspace/eurorack';

// Files to vendor.  Format: [src-relative-to-SRC_ROOT, dst-relative-to-VENDOR_ROOT].
// Plaits' #include directives use 'plaits/...' and 'stmlib/...' so the
// vendored layout mirrors that — VENDOR_ROOT goes on the include path as
// the only -I, and the includes resolve naturally.
const FILES = [
  // Plaits — DSP scaffolding
  ['plaits/dsp/dsp.h',                              'plaits/dsp/dsp.h'],
  ['plaits/dsp/engine/engine.h',                    'plaits/dsp/engine/engine.h'],
  // FM engine (PR-27)
  ['plaits/dsp/engine/fm_engine.h',                 'plaits/dsp/engine/fm_engine.h'],
  ['plaits/dsp/engine/fm_engine.cc',                'plaits/dsp/engine/fm_engine.cc'],
  // FM-engine deps
  ['plaits/dsp/oscillator/sine_oscillator.h',       'plaits/dsp/oscillator/sine_oscillator.h'],
  ['plaits/dsp/downsampler/4x_downsampler.h',       'plaits/dsp/downsampler/4x_downsampler.h'],
  // 6-op DX7 engine (this PR — Plaits' canonical full-DX7 emulation,
  // exposed in patchtogether.live as the DX7 module).
  ['plaits/dsp/engine2/six_op_engine.h',            'plaits/dsp/engine2/six_op_engine.h'],
  ['plaits/dsp/engine2/six_op_engine.cc',           'plaits/dsp/engine2/six_op_engine.cc'],
  ['plaits/dsp/fm/algorithms.h',                    'plaits/dsp/fm/algorithms.h'],
  ['plaits/dsp/fm/algorithms.cc',                   'plaits/dsp/fm/algorithms.cc'],
  ['plaits/dsp/fm/dx_units.h',                      'plaits/dsp/fm/dx_units.h'],
  ['plaits/dsp/fm/dx_units.cc',                     'plaits/dsp/fm/dx_units.cc'],
  ['plaits/dsp/fm/envelope.h',                      'plaits/dsp/fm/envelope.h'],
  ['plaits/dsp/fm/lfo.h',                           'plaits/dsp/fm/lfo.h'],
  ['plaits/dsp/fm/operator.h',                      'plaits/dsp/fm/operator.h'],
  ['plaits/dsp/fm/patch.h',                         'plaits/dsp/fm/patch.h'],
  ['plaits/dsp/fm/voice.h',                         'plaits/dsp/fm/voice.h'],
  // Resources (LUTs). NB: this file also contains plaits' `syx_bank_0/1/2`
  // arrays of curated DX7 patches — patches we deliberately do NOT use
  // (they include Yamaha factory ROM data of uncertain redistribution
  // status). The wasm linker DCEs the unused statics at -O2.
  ['plaits/resources.h',                            'plaits/resources.h'],
  ['plaits/resources.cc',                           'plaits/resources.cc'],
  // stmlib core
  ['stmlib/stmlib.h',                               'stmlib/stmlib.h'],
  ['stmlib/dsp/dsp.h',                              'stmlib/dsp/dsp.h'],
  ['stmlib/dsp/units.h',                            'stmlib/dsp/units.h'],
  ['stmlib/dsp/units.cc',                           'stmlib/dsp/units.cc'],
  ['stmlib/dsp/parameter_interpolator.h',           'stmlib/dsp/parameter_interpolator.h'],
  ['stmlib/dsp/rsqrt.h',                            'stmlib/dsp/rsqrt.h'],
  ['stmlib/dsp/hysteresis_quantizer.h',             'stmlib/dsp/hysteresis_quantizer.h'],
  ['stmlib/utils/buffer_allocator.h',               'stmlib/utils/buffer_allocator.h'],
  ['stmlib/utils/random.h',                         'stmlib/utils/random.h'],
  ['stmlib/utils/random.cc',                        'stmlib/utils/random.cc'],
];

async function copyOne(src, dst) {
  const srcPath = join(SRC_ROOT, src);
  const dstPath = join(VENDOR_ROOT, dst);
  if (!existsSync(srcPath)) {
    throw new Error(
      `Missing upstream source: ${srcPath}\n` +
        `Make sure PLAITS_SRC points at your eurorack checkout and stmlib is checked out\n` +
        `(\`git -C ${SRC_ROOT} submodule update --init stmlib\`).`,
    );
  }
  await mkdir(dirname(dstPath), { recursive: true });
  const content = await readFile(srcPath);
  await writeFile(dstPath, content);
}

async function main() {
  if (!existsSync(SRC_ROOT)) {
    throw new Error(
      `PLAITS_SRC not found: ${SRC_ROOT}\n` +
        `Set the env var to your local eurorack checkout. Example:\n` +
        `  PLAITS_SRC=/path/to/eurorack flox activate -- task dsp:vendor:plaits`,
    );
  }
  for (const [src, dst] of FILES) {
    await copyOne(src, dst);
    console.log(`  vendored ${src}`);
  }
  console.log(`\nVendored ${FILES.length} file(s) → ${VENDOR_ROOT}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
