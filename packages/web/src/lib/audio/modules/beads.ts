import type { AudioModuleDef } from "$lib/audio/module-registry";
import type { AudioDomainNodeHandle } from "$lib/audio/engine";
import { createWorkletNode } from "$lib/audio/worklet-guard";
import { BEADS_PARAMS, BEADS_INPUTS } from "../../../../../dsp/src/lib/beads-contract";
import workletUrl from "@patchtogether.live/dsp/dist/beads.js?url";
import wasmUrl from "@patchtogether.live/dsp/dist/beads.wasm?url";

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
let compiled: Promise<WebAssembly.Module> | undefined;
function firmware(): Promise<WebAssembly.Module> {
  return compiled ??= fetch(wasmUrl).then(async response => {
    if (!response.ok) throw new Error(`Beads firmware: HTTP ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { compiled = undefined; throw error; });
}

export const beadsDef: AudioModuleDef = {
  type: "beads", label: "beads", domain: "audio", category: "effects",
  size: "3u", hp: 3,
  palette: { top: "Audio modules", sub: "Effects" },
  ossAttribution: { author: "Émilie Gillet" },
  stereoPairs: [["in_l", "in_r"], ["out_l", "out_r"]],
  inputs: [
    { id: "in_l", type: "audio" }, { id: "in_r", type: "audio" },
    { id: "pitch", type: "pitch" },
    { id: "seed", type: "gate", edge: "gate" },
    { id: "freeze_gate", type: "gate", edge: "gate" },
    { id: "time_cv", type: "cv", cvScale: { mode: "passthrough" } },
    { id: "size_cv", type: "cv", cvScale: { mode: "passthrough" } },
    { id: "shape_cv", type: "cv", cvScale: { mode: "passthrough" } },
    { id: "pitch_cv", type: "cv", cvScale: { mode: "passthrough" } },
    { id: "density_cv", type: "cv", cvScale: { mode: "passthrough" } },
    { id: "blend_cv", type: "cv", paramTarget: "blend", cvScale: { mode: "linear" } },
    { id: "feedback_cv", type: "cv", paramTarget: "feedback", cvScale: { mode: "linear" } },
    { id: "reverb_cv", type: "cv", paramTarget: "reverb", cvScale: { mode: "linear" } },
  ],
  outputs: [{ id: "out_l", type: "audio" }, { id: "out_r", type: "audio" }],
  params: BEADS_PARAMS,
  face: {
    order: ["time", "size", "density", "pitch", "blend", "freeze", "shape", "seed",
      "time_random", "size_random", "shape_random", "pitch_random", "feedback", "reverb", "quality", "source", "mono"],
    glyph: "scope", // Reads out_l, the first declared audio output.
    pages: [
      { id: "grains", label: "Grains", controls: ["time", "size", "density", "pitch", "shape", "freeze", "seed"] },
      { id: "modulation", label: "Random / CV", controls: ["time_random", "size_random", "shape_random", "pitch_random"] },
      { id: "sound", label: "Sound", controls: ["blend", "feedback", "reverb", "quality", "source", "mono"] },
    ],
    rear: { audioRate: [...BEADS_INPUTS] },
  },
  docs: {
    explanation: "A direct WebAssembly port of the Beads firmware released by Émilie Gillet in October 2026. Record stereo audio, scatter it into grains, freeze a moment, or use the internal wavetable voice. The original grain engines, random modulation, delay transition, quality modes, feedback, reverb and limiters run from the published C++ source. Auto selects the wavetable voice when both audio inputs are unpatched; patching either input selects audio processing immediately. Select Audio explicitly to hold a frozen recording after unplugging its source. SIZE fully clockwise enters the original delay mode after its transition. The browser uses explicit source and mono controls instead of hardware normalization timers, and does not emulate the analogue input gain stage, calibration, persistent audio backup, or repurposing the right audio jack as a gate output. All quality modes keep their native processing clocks with band-limited sample-rate conversion to the audio device.",
    inputs: {
      in_l: "Left audio written into the buffer. An unpatched right input follows this channel; a connected silent right input stays silent.",
      in_r: "Right audio written into the stereo buffer. A cable here selects audio processing in Auto even if the left input is unpatched.",
      pitch: "V/oct pitch added to the Pitch control. Zero volts leaves the native wavetable voice at its reference pitch, or leaves recorded grains untransposed.",
      seed: "Seed gate: in External mode, held high enables grain generation and low stops new grains; near centre Density a rising edge creates one grain. In Latch mode a patched gate supplies the clock for the original divider/probability logic. Hold combines the button level with this gate.",
      freeze_gate: "Freeze gate: while high, stops buffer recording; low resumes recording unless the Freeze switch remains on. This is level-sensitive, not a toggle on an edge.",
      time_cv: "External modulation for Time. Time amount controls its influence; with no cable that control uses the original internal randomness.",
      size_cv: "External modulation for Size, scaled by Size amount. Negative amounts use positive CV to control random spread.",
      shape_cv: "External modulation for Shape, scaled by Shape amount. With no cable, the amount selects internal random modulation.",
      pitch_cv: "Pitch modulation in volts per octave, processed by Pitch amount and the original pitch randomizer. The separate pitch input always adds V/oct directly.",
      density_cv: "Density modulation using the original linear/exponential FM mapping; it also moves the divider/probability selection when clocked.",
      blend_cv: "CV added to the dry/wet Blend control.",
      feedback_cv: "CV added to Feedback; in Wavetable mode it selects the wavetable bank.",
      reverb_cv: "CV added to the Reverb control.",
    },
    outputs: {
      out_l: "Left output of the original grain or wavetable engine, dry/wet mix, reverb and limiter.",
      out_r: "Right output of the same stereo engine. The two jacks carry independent channels, including in mono-buffer mode where grains may spread across stereo.",
    },
    controls: {
      time: "Position in the recorded buffer; in wavetable mode, position within the selected wavetable. Modulated by Time amount and time_cv.",
      size: "Original bipolar grain duration and direction control. Below centre grains run backwards; above centre they run forwards. Fully clockwise enters delay mode after the firmware transition; moving back returns to grains.",
      shape: "Grain envelope shape, from percussive contours through smooth windows to harder rectangular shapes.",
      pitch: "Transpose grains or the wavetable voice by -24 to +24 semitones, summed with the V/oct pitch input.",
      density: "Original density law: periodic grains below centre, random grains above, and manual taps around centre. In clocked Latch mode it chooses division or probability. It is not a linear rate control.",
      blend: "Original dry/wet crossfade. In wavetable mode blends the continuous voice with granular wavetable playback. Pristine dry audio has the firmware gain of 0.75, not unity.",
      feedback: "Feedback into the recorded audio buffer. In Wavetable mode this same control selects one of the original twelve banks.",
      reverb: "Original stereo reverb amount, with linked decay mapping and quality-dependent tone.",
      time_random: "Time attenurandomizer. With no CV, positive and negative amounts select the original random distributions. With CV, positive scales modulation and negative lets CV set random spread.",
      size_random: "Size attenurandomizer, using the same internal-random/external-CV rules as Time amount.",
      shape_random: "Shape attenurandomizer, using the same internal-random/external-CV rules as Time amount.",
      pitch_random: "Pitch attenurandomizer. With no cable it spreads grain pitch; with a cable positive values scale CV and negative values randomize pitch under CV control.",
      freeze: "Latching Freeze switch. On holds the recorded buffer; off resumes recording when freeze_gate is low. Rewriting the same setting never toggles it. Wavetable mode applies the original freeze behavior to its voices.",
      seed: "External leaves grain generation to the Seed input; Hold keeps generation enabled; Latch free-runs without a cable and uses the clock divider/probability engine with a cable. At centre Density, External accepts individual rising-edge taps and Latch is silent on the wet path without a clock.",
      quality: "Scorched cassette: 8-bit companded audio at 24 kHz with wow/flutter. Warm tape: 12-bit at an internal 24 kHz. Sunny digital: 12-bit at 32 kHz. Pristine: 16-bit at 48 kHz. In Wavetable mode the original per-quality bit depths apply at 48 kHz. Switching reinterprets buffer memory as on the firmware.",
      source: "Auto chooses Wavetable when neither audio input has a cable, otherwise Audio. Audio always records or plays the buffer, including after disconnecting its source. Wavetable always uses the original internal synthesizer. Selection follows cable presence, not signal level.",
      mono: "Latching mono-buffer mode. On uses the firmware mono recording layout for longer history; output remains stereo. Off keeps separate stereo input channels.",
    },
  },
  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(workletUrl).catch(error => { loaded.delete(ctx); throw error; }));
    const [, wasm] = await Promise.all([loaded.get(ctx), firmware()]);
    const worklet = createWorkletNode(node, ctx, "beads", {
      numberOfInputs: BEADS_INPUTS.length, numberOfOutputs: 2, outputChannelCount: [1, 1],
      channelCount: 1, channelCountMode: "explicit",
      processorOptions: { wasm },
    });
    // No keep-alive input: presence selects Auto mode and the R normal.
    // process() returns true until disposal; output connections keep it alive.
    const audioParams = worklet.parameters as unknown as Map<string, AudioParam>;
    for (const p of BEADS_PARAMS) audioParams.get(p.id)!.value = node.params?.[p.id] ?? p.defaultValue;
    const inputs: AudioDomainNodeHandle["inputs"] = new Map(
      BEADS_INPUTS.map((id, input) => [id, { node: worklet, input }]),
    );
    for (const id of ["blend", "feedback", "reverb"]) {
      inputs.set(`${id}_cv`, { node: worklet, input: 0, param: audioParams.get(id)! });
    }
    return {
      domain: "audio", inputs,
      outputs: new Map([["out_l", { node: worklet, output: 0 }], ["out_r", { node: worklet, output: 1 }]]),
      setParam(id, value) { const p = audioParams.get(id); if (p) p.value = value; },
      readParam(id) { return audioParams.get(id)?.value; },
      dispose() { worklet.port.postMessage("dispose"); worklet.disconnect(); worklet.port.close(); },
    };
  },
};
