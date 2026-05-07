// packages/dsp/src/plaits-glue/worklet.cc
//
// Flat C-ABI shim around the vendored Plaits engines, compiled to wasm by
// `node packages/dsp/scripts/build-plaits.mjs`. The TS AudioWorkletProcessor
// in processor.ts loads the resulting Module and drives one PlaitsVoice per
// AudioWorkletNode instance.
//
// Engine-id constants match the conceptual numbering in the plan
// (.myrobots/plans/plaits-clone.md §4); only ENGINE_FM is wired up in this
// first cut — Modal / Granular / etc. follow on.
//
// The whole file is MIT (c) 2026 patchtogether.live; the vendored Plaits
// sources we link against carry their own MIT (c) Emilie Gillet headers,
// preserved verbatim. See THIRD_PARTY_LICENSES.md.

#include <cstdint>
#include <cstring>
#include <cstdlib>

// emcc with -fno-exceptions/-fno-rtti omits libc++abi's operator new/delete.
// Provide thin malloc/free wrappers so vanilla `new T()` works without
// pulling in libc++. Aborts on OOM (acceptable for an audio worklet
// where allocation only happens at voice-create time).
void* operator new(std::size_t size) {
  void* p = std::malloc(size);
  if (!p) std::abort();
  return p;
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

#include "plaits/dsp/dsp.h"
#include "plaits/dsp/engine/engine.h"
#include "plaits/dsp/engine/fm_engine.h"
#include "plaits/dsp/engine2/six_op_engine.h"
#include "plaits/dsp/fm/patch.h"
#include "stmlib/utils/buffer_allocator.h"

namespace {

// Per-voice scratch buffer for stmlib's BufferAllocator. The 2-op FMEngine
// allocates nothing, but SixOpEngine asks for ~9 KB of patch + voice scratch
// (kMaxBlockSize * (4 + 2) floats + 32 * sizeof(fm::Patch)). 32 KB is comfy.
constexpr size_t kScratchBytes = 32 * 1024;

// Engine-id constants. Match the conceptual numbering documented in
// .myrobots/plans/plaits-clone.md §4. PR-27 wired ENGINE_FM (the 2-op clone
// of Plaits' built-in FMEngine); this PR adds ENGINE_DX7 (the full 6-op
// SixOpEngine — Plaits' own DX7 emulation, marketed as the actual canonical
// FM engine for this codebase).
constexpr int ENGINE_FM = 9;
constexpr int ENGINE_DX7 = 10;

// 32-patch default user_data (32 * 128 = 4096 bytes) we feed SixOpEngine
// at boot. Each slot is the SAME baseline 6-op patch, but with the algorithm
// byte set to 0..31 — so the user's `algorithm` macro knob (which Plaits
// internally maps to harmonics → patch_index) selects between algorithms 1..32.
//
// Hand-built (not vendored) so we can ship without the Yamaha factory ROM
// banks bundled in plaits/resources.cc syx_bank_{0,1,2}. Those are dead-code
// eliminated by the wasm linker because nothing in this glue references them.
//
// SYX layout follows fm::Patch::Unpack (see plaits/dsp/fm/patch.h).
//   bytes  0..101 : 6 × 17-byte operator block
//   bytes 102..109: 4-byte pitch envelope rate + 4-byte pitch envelope level
//   bytes 110     : algorithm (0..31)
//   bytes 111     : feedback (0..7) + reset_phase << 3
//   bytes 112..116: lfo rate / delay / pmd / amd / reset+wave+pms
//   byte  117     : transpose (0..48; 24 = unity)
//   bytes 118..127: 10-byte ASCII name
constexpr size_t kPatchBytes = 128;
constexpr size_t kNumDefaultPatches = 32;

void WriteOperator(uint8_t* op, int level) {
  // 4-stage envelope rates (R1..R4, 0..99). Quick attack, full sustain, mid
  // release.
  op[0] = 80;  // R1 (attack rate)
  op[1] = 60;  // R2 (decay rate)
  op[2] = 40;  // R3 (sustain rate, ignored when L2 == L3)
  op[3] = 50;  // R4 (release rate)
  // 4-stage envelope levels (L1..L4, 0..99). Hold at 90 then fall.
  op[4] = 99;
  op[5] = 90;
  op[6] = 90;
  op[7] = 0;
  // KeyboardScaling (break_point, left_depth, right_depth, curves).
  op[8] = 39;   // break point ~ middle C
  op[9] = 0;    // left_depth
  op[10] = 0;   // right_depth
  op[11] = 0;   // curves: linear-/-linear-
  // rate_scaling (3 bits) | detune (4 bits) — packed in op[12].
  // detune 7 = neutral (range 0..14).
  op[12] = (7 << 3);
  // amp_mod_sensitivity (2 bits) | velocity_sensitivity (3 bits) packed
  // in op[13]. We turn velocity sensing off (0) for predictable sequencer
  // playback; users with a CV velocity rig can rebuild patches later.
  op[13] = 0;
  // operator output level 0..99.
  op[14] = static_cast<uint8_t>(level);
  // mode (1 bit, 0 = ratio, 1 = fixed) | coarse (5 bits, 0..31) — packed.
  // coarse=1 → ratio = 1.0 (lut_coarse[1] = 0.0 semitones).
  op[15] = (1 << 1) | 0;  // ratio mode, coarse=1
  // fine (0..99). 0 → no detune.
  op[16] = 0;
}

uint8_t* DefaultPatchData() {
  static uint8_t data[kNumDefaultPatches * kPatchBytes];
  static bool inited = false;
  if (inited) return data;

  // Slot 0..31: a "6-op stack" — op1 carrier at full level, ops 2..6 act
  // as modulators at moderate level. Plaits' 32 algorithms route the
  // operators differently, but every algorithm has at least op1 going
  // to OUTPUT, so we get *some* sound out of every algo slot.
  for (size_t s = 0; s < kNumDefaultPatches; ++s) {
    uint8_t* p = data + s * kPatchBytes;

    // Six 17-byte operator blocks. Plaits indexes ops in REVERSE physical
    // order (op[0] in struct = DX7 op6). We give the "output" operator
    // (op[5] in struct, i.e. op1 in DX7 nomenclature) a high level and
    // the rest moderate levels so the modulators speak.
    WriteOperator(p +  0 * 17, 70);  // op[0] — DX7 op6
    WriteOperator(p +  1 * 17, 70);  // op[1] — DX7 op5
    WriteOperator(p +  2 * 17, 75);  // op[2] — DX7 op4
    WriteOperator(p +  3 * 17, 80);  // op[3] — DX7 op3
    WriteOperator(p +  4 * 17, 85);  // op[4] — DX7 op2
    WriteOperator(p +  5 * 17, 99);  // op[5] — DX7 op1 (output for most algos)

    // Pitch envelope rates + levels (102..109). 50 = neutral level, mid
    // rates → no audible pitch envelope.
    p[102] = p[103] = p[104] = p[105] = 99;  // fast rates
    p[106] = p[107] = p[108] = p[109] = 50;  // neutral levels (no pitch swing)

    // Algorithm 0..31 (1..32 in DX7 marketing speak).
    p[110] = static_cast<uint8_t>(s & 0x1f);
    // Feedback 4 (0..7), reset_phase = 1 (osc resets on note-on for
    // deterministic ART comparisons).
    p[111] = 4 | (1 << 3);
    // LFO defaults — slow, no audible mod.
    p[112] = 30;  // rate
    p[113] = 0;   // delay
    p[114] = 0;   // pmd
    p[115] = 0;   // amd
    p[116] = 0;   // reset_phase=0 | waveform=triangle (0) | pms=0
    // Transpose: middle of range. Plaits' Voice doesn't actually consume
    // this directly (note arrives via EngineParameters), so leave neutral.
    p[117] = 24;
    // ASCII name "PT-DEFAULT".
    const char* name = "PT-DEFAULT";
    for (size_t i = 0; i < 10; ++i) p[118 + i] = static_cast<uint8_t>(name[i]);
  }

  inited = true;
  return data;
}

struct PlaitsVoice {
  int engine_id;
  plaits::Engine* engine;
  stmlib::BufferAllocator allocator;
  uint8_t scratch[kScratchBytes];

  // Per-block scratch — Plaits writes to two interleaved float arrays of
  // up to kMaxBlockSize. Render is called per kBlockSize (12) inner block.
  float out_block[plaits::kMaxBlockSize];
  float aux_block[plaits::kMaxBlockSize];

  // Trigger edge detector — the AudioWorklet feeds raw gate samples; Plaits'
  // engine API expects a TriggerState bitfield.  We hand-debounce.
  bool prev_gate_high;
};

// Construct a fresh engine of the requested type. Returns nullptr on
// unsupported id (so the JS shim can render silence and log).
plaits::Engine* CreateEngine(int engine_id, stmlib::BufferAllocator* alloc) {
  switch (engine_id) {
    case ENGINE_FM: {
      // emmalloc + raw new used here intentionally: -fno-exceptions means
      // the (std::nothrow) overload would need libc++ symbols we don't link.
      // Plain `new` aborts on OOM under emcc; for a synth voice that's fine.
      auto* e = new plaits::FMEngine();
      e->Init(alloc);
      return e;
    }
    case ENGINE_DX7: {
      auto* e = new plaits::SixOpEngine();
      e->Init(alloc);
      // Seed with our hand-built 32-patch default bank. Each slot uses the
      // same baseline 6-op patch but increments the algorithm byte so the
      // user's `algorithm` knob (mapped to harmonics → patch_index in
      // SixOpEngine::Render) selects DX7 algorithms 1..32.
      e->LoadUserData(DefaultPatchData());
      return e;
    }
    default:
      return nullptr;
  }
}

}  // namespace

// Parameters struct passed across the JS/wasm boundary. Layout-stable —
// processor.ts mirrors this byte-for-byte via HEAPF32 / HEAPI32 views.
extern "C" {

struct PlaitsParams {
  float note;        // semitones, 60 = middle C
  float harmonics;   // 0..1 — FM ratio
  float timbre;      // 0..1 — FM index
  float morph;       // 0..1 — feedback
  float accent;      // 0..1 — unused for FM but threaded for future engines
  float level;       // 0..1 — unused for FM (engine renders unenveloped)
  int   trigger;     // 0=low, 1=high (edge handled inside)
};

// Allocate + initialize a voice for a given engine_id. Returns an opaque
// handle (pointer) the JS side passes back into render/destroy/reset.
__attribute__((used)) PlaitsVoice* plaits_create(int engine_id) {
  auto* v = new PlaitsVoice();
  v->engine_id = engine_id;
  v->prev_gate_high = false;
  v->allocator.Init(v->scratch, kScratchBytes);
  v->engine = CreateEngine(engine_id, &v->allocator);
  if (!v->engine) {
    delete v;
    return nullptr;
  }
  return v;
}

__attribute__((used)) void plaits_destroy(PlaitsVoice* v) {
  if (!v) return;
  delete v->engine;
  delete v;
}

__attribute__((used)) void plaits_reset(PlaitsVoice* v) {
  if (!v || !v->engine) return;
  v->engine->Reset();
  v->prev_gate_high = false;
}

// Render one inner block (size <= kMaxBlockSize) and copy the carrier to
// `out_dst` and the aux/sub to `aux_dst`. The JS side calls this in 12-frame
// chunks per Plaits' kBlockSize convention.
__attribute__((used)) void plaits_render(
    PlaitsVoice* v,
    const PlaitsParams* p,
    float* out_dst,
    float* aux_dst,
    int size) {
  if (!v || !v->engine || size <= 0 || size > (int)plaits::kMaxBlockSize) {
    if (out_dst) std::memset(out_dst, 0, sizeof(float) * (size > 0 ? size : 0));
    if (aux_dst) std::memset(aux_dst, 0, sizeof(float) * (size > 0 ? size : 0));
    return;
  }

  plaits::EngineParameters params;
  params.note = p->note;
  params.harmonics = p->harmonics;
  params.timbre = p->timbre;
  params.morph = p->morph;
  params.accent = p->accent;

  // Map our int gate to Plaits' TriggerState bitfield.
  bool gate_now = p->trigger != 0;
  int trig = plaits::TRIGGER_LOW;
  if (gate_now) trig |= plaits::TRIGGER_HIGH;
  if (gate_now && !v->prev_gate_high) trig |= plaits::TRIGGER_RISING_EDGE;
  v->prev_gate_high = gate_now;
  params.trigger = trig;

  bool already_enveloped = false;
  v->engine->Render(params, v->out_block, v->aux_block, (size_t)size, &already_enveloped);

  std::memcpy(out_dst, v->out_block, sizeof(float) * size);
  std::memcpy(aux_dst, v->aux_block, sizeof(float) * size);
}

}  // extern "C"
