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
#include "stmlib/utils/buffer_allocator.h"

namespace {

// Per-voice scratch buffer for stmlib's BufferAllocator. The FM engine
// itself doesn't allocate (Init is a no-op for FM), but other Plaits engines
// do, and we want this glue to generalize when more engines come online.
constexpr size_t kScratchBytes = 32 * 1024;

constexpr int ENGINE_FM = 9;

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
