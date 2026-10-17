// ABI order shared by the worklet and module def. The native bridge consumes
// these positions; its tests drive every control through the shipping worklet.
export const BEADS_CONTROLS = [
  { id: "time", label: "Time", min: 0, max: 1, defaultValue: 0.25 },
  { id: "size", label: "Size", min: 0, max: 1, defaultValue: 0.65 },
  { id: "shape", label: "Shape", min: 0, max: 1, defaultValue: 0.5 },
  { id: "pitch", label: "Pitch", min: -24, max: 24, defaultValue: 0 },
  { id: "density", label: "Density", min: 0, max: 1, defaultValue: 0.25 },
  { id: "blend", label: "Blend", min: 0, max: 1, defaultValue: 0.5 },
  { id: "feedback", label: "Feedback / Bank", min: 0, max: 1, defaultValue: 0 },
  { id: "reverb", label: "Reverb", min: 0, max: 1, defaultValue: 0.15 },
  { id: "time_random", label: "Time amount", min: -1, max: 1, defaultValue: 0 },
  { id: "size_random", label: "Size amount", min: -1, max: 1, defaultValue: 0 },
  { id: "shape_random", label: "Shape amount", min: -1, max: 1, defaultValue: 0 },
  { id: "pitch_random", label: "Pitch amount", min: -1, max: 1, defaultValue: 0 },
  { id: "freeze", label: "Freeze", min: 0, max: 1, defaultValue: 0 },
  { id: "seed", label: "Seed", min: 0, max: 2, defaultValue: 2 },
  { id: "quality", label: "Quality", min: 0, max: 3, defaultValue: 3 },
  { id: "source", label: "Source", min: 0, max: 2, defaultValue: 0 },
  { id: "mono", label: "Mono buffer", min: 0, max: 1, defaultValue: 0 },
] as const;
const choices: Record<string, string[]> = {
  seed: ["External", "Hold", "Latch"],
  quality: ["Scorched cassette", "Warm tape", "Sunny digital", "Pristine"],
  source: ["Auto", "Audio", "Wavetable"],
};
const discrete = new Set(["freeze", "seed", "quality", "source", "mono"]);
export const BEADS_PARAMS = BEADS_CONTROLS.map(p => ({
  ...p,
  curve: discrete.has(p.id) ? "discrete" as const : "linear" as const,
  ...(p.id === "pitch" ? { units: "st" } : {}),
  ...(choices[p.id] ? { options: choices[p.id]!.map((label, value) => ({ label, value })) } : {}),
}));

export const BEADS_INPUTS = [
  "in_l", "in_r", "pitch", "seed", "freeze_gate",
  "time_cv", "size_cv", "shape_cv", "pitch_cv", "density_cv",
] as const;
export type BeadsExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  _initialize(): void;
  beads_init(rate: number, seed: number): void;
  beads_input(): number;
  beads_output(): number;
  beads_controls(): number;
  beads_process(mask: number, gateHi: number): void;
};
