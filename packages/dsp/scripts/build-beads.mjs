// Compile the pinned upstream C++ directly. No generated JS runtime, network,
// filesystem, threads, or allocation on the audio callback path.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const root = fileURLToPath(new URL("..", import.meta.url));
const native = join(root, "src/native/beads");
const vendor = join(native, "vendor");
const sources = [
  "beads/dsp/processor.cc", "beads/dsp/synth.cc", "beads/dsp/mu_law.cc",
  "beads/dsp/delay_clock.cc", "beads/dsp/delay_controller.cc",
  "beads/dsp/trigger_generator.cc", "beads/resources.cc",
  "stmlib/utils/random.cc", "stmlib/dsp/units.cc",
];
export function buildBeads() {
  mkdirSync(join(root, "dist"), { recursive: true });
  const result = spawnSync("em++", [
    "-O3", "-std=c++17", "-DTEST", "-Wno-vla-cxx-extension", "-fno-builtin-printf", "-fno-exceptions", "-fno-rtti", "-I" + vendor,
    join(native, "bridge.cc"), ...sources.map(s => join(vendor, s)),
    "--no-entry", "-Wl,--wrap=printf", "-sSTANDALONE_WASM=1", "-sFILESYSTEM=0",
    "-sINITIAL_MEMORY=16777216", "-sALLOW_MEMORY_GROWTH=0", "-sSTACK_SIZE=262144",
    "-sEXPORTED_FUNCTIONS=[_beads_init,_beads_input,_beads_output,_beads_controls,_beads_process]",
    "-o", join(root, "dist/beads.wasm"),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Beads C++ build failed (${result.status})`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) buildBeads();
