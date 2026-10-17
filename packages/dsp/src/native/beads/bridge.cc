// Browser host for the unmodified MIT-licensed Beads DSP by Emilie Gillet.
// One WASM instance per node owns all state, including upstreams global RNG.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include "beads/dsp/processor.h"
#include "beads/dsp/synth.h"
#include "stmlib/utils/random.h"

namespace {
constexpr int kQuantum = 128;
constexpr int kBlock = 12; // The original firmware processing quantum.
constexpr int kRing = 256;
constexpr int kTaps = 48;
constexpr int kPhases = 256;
beads::Processor processor;
beads::Synth synth;
uint8_t delay_memory[3][256 * 1024];
uint16_t processor_reverb[32768], synth_reverb[32768];
float input[10][kQuantum], output[2][kQuantum], controls[17];
beads::FloatFrame in_block[kBlock], out_block[kBlock];
bool freeze_block[kBlock];
stmlib::GateFlags seed_block[kBlock], previous_seed = 0;
float in_history[2][kRing], out_history[2][kRing];
float in_filter[kPhases][kTaps], out_filter[kPhases][kTaps];
double host_rate, ratio;
int64_t host_frame = 0, native_frame = 0;
int block_fill = 0, media = -1, source = -1, mono = -1;

float clamp(float x, float lo, float hi) { return std::max(lo, std::min(hi, x)); }

void MakeFilter(float table[kPhases][kTaps], double cutoff) {
  for (int phase = 0; phase < kPhases; ++phase) {
    double total = 0;
    for (int tap = 0; tap < kTaps; ++tap) {
      const double x = tap - (kTaps / 2 - 1) - double(phase) / kPhases;
      const double a = 3.141592653589793 * x;
      const double sinc = std::abs(x) < 1e-10 ? cutoff : std::sin(a * cutoff) / a;
      const double window = 0.5 + 0.5 * std::cos(a / (kTaps / 2));
      table[phase][tap] = sinc * window;
      total += table[phase][tap];
    }
    for (int tap = 0; tap < kTaps; ++tap) table[phase][tap] /= total;
  }
}

float Read(float* ring, double position, float table[kPhases][kTaps]) {
  const int64_t base = std::floor(position);
  const int phase = std::min(kPhases - 1, int((position - base) * kPhases));
  float sum = 0;
  for (int tap = 0; tap < kTaps; ++tap) {
    const int64_t index = base + tap - (kTaps / 2 - 1);
    if (index >= 0) sum += ring[index & (kRing - 1)] * table[phase][tap];
  }
  return sum;
}

void Configure(int next_media, int next_source, int next_mono) {
  media = next_media;
  source = next_source;
  mono = next_mono;
  processor.Configure(beads::Processor::Media(media), mono != 0);
  ratio = (source ? 48000.0 : processor.sample_rate()) / host_rate;
  MakeFilter(in_filter, std::min(1.0, ratio) * 0.94);
  MakeFilter(out_filter, std::min(1.0, 1.0 / ratio) * 0.94);
  host_frame = native_frame = block_fill = 0;
  previous_seed = 0;
  std::memset(in_history, 0, sizeof(in_history));
  std::memset(out_history, 0, sizeof(out_history));
}

beads::RandomizedParameter RandomParam(int base, int amount, int channel, int mask, int frame, float scale = 1) {
  beads::RandomizedParameter p;
  p.base = controls[base];
  p.attenuverter = controls[amount];
  p.has_cv = (mask & (1 << channel)) != 0;
  p.cv = input[channel][frame] * scale;
  return p;
}

void RenderBlock(int mask, int frame) {
  beads::Parameters p;
  p.time = RandomParam(0, 8, 5, mask, frame);
  p.size = RandomParam(1, 9, 6, mask, frame);
  p.shape = RandomParam(2, 10, 7, mask, frame);
  p.pitch = RandomParam(3, 11, 8, mask, frame, 12);
  p.pitch.base = clamp(p.pitch.base + input[2][frame] * 12, -60, 60);
  p.monophonic_mode = false;
  beads::ModulatedParameter density = { controls[4], input[9][frame] };
  beads::Processor::MixParameters mix = { controls[6], controls[5], controls[7], false };
  const auto seed = beads::SeedButtonState(int(controls[13]));
  const auto* external_seed = mask & (1 << 3) ? seed_block : nullptr;
  if (source) {
    synth.Render(seed, external_seed, freeze_block, beads::Synth::Resolution(media), density, p, mix, out_block, kBlock);
  } else {
    processor.Process(seed, external_seed, freeze_block, density, p, mix, in_block, out_block, kBlock);
  }
  for (int i = 0; i < kBlock; ++i) {
    const auto index = (native_frame - kBlock + i) & (kRing - 1);
    out_history[0][index] = out_block[i].l;
    out_history[1][index] = out_block[i].r;
  }
}
}

extern "C" {
// TEST enables portable stmlib arithmetic and one upstream voice-steal printf.
// AudioWorklet has no stdout; discard that diagnostic without a WASI runtime.
int __wrap_printf(const char*, ...) { return 0; }
float* beads_input() { return &input[0][0]; }
float* beads_output() { return &output[0][0]; }
float* beads_controls() { return controls; }
void beads_init(double rate, uint32_t seed) {
  host_rate = rate;
  stmlib::Random::Seed(seed ? seed : 1);
  uint8_t* buffers[] = { delay_memory[0], delay_memory[1], delay_memory[2] };
  processor.Init(buffers, processor_reverb);
  synth.Init(synth_reverb);
}
void beads_process(int mask, float gate_hi) {
  const int next_media = int(clamp(controls[14], 0, 3));
  // Auto follows cable presence, never signal level. No 10-second hardware
  // normalization timeout is needed when the browser tells us about cables.
  const int next_source = controls[15] < 0.5f ? !(mask & 3) : controls[15] > 1.5f;
  const int next_mono = controls[16] > 0.5f;
  if (next_media != media || next_source != source || next_mono != mono) Configure(next_media, next_source, next_mono);
  for (int frame = 0; frame < kQuantum; ++frame, ++host_frame) {
    in_history[0][host_frame & (kRing - 1)] = input[0][frame];
    in_history[1][host_frame & (kRing - 1)] = input[1][frame];
    // Preserve the native 48/32/24 kHz clocks at every AudioContext rate.
    // Windowed-sinc conversion is band-limited in BOTH directions. At equal
    // rates use the original samples, without an unnecessary filter.
    while (double(native_frame) / ratio <= host_frame) {
      const double at = double(native_frame) / ratio - kTaps / 2;
      in_block[block_fill].l = ratio == 1 ? input[0][frame] : Read(in_history[0], at, in_filter);
      in_block[block_fill].r = ratio == 1 ? input[1][frame] : Read(in_history[1], at, in_filter);
      freeze_block[block_fill] = controls[12] >= gate_hi || input[4][frame] >= gate_hi;
      previous_seed = seed_block[block_fill] = stmlib::ExtractGateFlags(previous_seed, input[3][frame] >= gate_hi);
      ++native_frame;
      if (++block_fill == kBlock) {
        RenderBlock(mask, frame);
        block_fill = 0;
      }
    }
    for (int channel = 0; channel < 2; ++channel) {
      const double at = host_frame * ratio - (kBlock + kTaps / 2 + 1);
      const int64_t equal_rate_index = host_frame - kBlock;
      const float sample = ratio == 1
          ? (equal_rate_index >= 0 ? out_history[channel][equal_rate_index & (kRing - 1)] : 0)
          : Read(out_history[channel], at, out_filter);
      output[channel][frame] = sample;
    }
  }
}
}
