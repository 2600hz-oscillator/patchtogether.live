// packages/web/src/lib/video/modules/index.ts
//
// Auto-registers all video modules on first import. Mirrors
// packages/web/src/lib/audio/modules/index.ts so the registration entry
// points are symmetric across domains; UI just imports both barrels.
//
// Phase 0 (engine spike):  LINES, OUTPUT.
// Phase 1 (this slab):     INWARDS, PICTUREBOX, DESTRUCTOR, CHROMA,
//                          LUMA, COLORIZER, FEEDBACK, V-MIXER.

import { registerVideoModule } from '$lib/video/module-registry';
import { exposeModuleSpecsForTests } from '$lib/dev/module-specs';
import { linesDef } from './lines';
import { videoOutDef } from './video-out';
import { inwardsDef } from './inwards';
import { pictureboxDef } from './picturebox';
import { destructorDef } from './destructor';
import { chromaDef } from './chroma';
import { lumaDef } from './luma';
import { colorizerDef } from './colorizer';
import { feedbackDef } from './feedback';
import { mixerVideoDef } from './mixer';
import { cameraInputDef } from './camera-input';
import { shapesDef } from './shapes';
import { monoglitchDef } from './monoglitch';
import { ruttetraDef } from './ruttetra';
import { shapedrampsDef } from './shapedramps';
import { vdelayDef } from './vdelay';
import { bentboxDef } from './bentbox';
import { acidwarpDef } from './acidwarp';
import { doomDef } from './doom';

let registered = false;

export function registerVideoModules(): void {
  if (registered) return;
  registered = true;
  // Phase 0
  registerVideoModule(linesDef);
  registerVideoModule(videoOutDef);
  // Phase 1
  registerVideoModule(inwardsDef);
  registerVideoModule(pictureboxDef);
  registerVideoModule(destructorDef);
  registerVideoModule(chromaDef);
  registerVideoModule(lumaDef);
  registerVideoModule(colorizerDef);
  registerVideoModule(feedbackDef);
  registerVideoModule(mixerVideoDef);
  // Camera input (local-only)
  registerVideoModule(cameraInputDef);
  // SHAPES — geometry source.
  registerVideoModule(shapesDef);
  // MONOGLITCH — luma → vertical-scanline displacement OUTPUT (the
  // original "Rutt-Etra-style" effect from PR-99, renamed when the real
  // raster-coordinate-remap RUTTETRA landed alongside SHAPEDRAMPS).
  registerVideoModule(monoglitchDef);
  // RUTTETRA — true Rutt/Etra raster-scan-coordinate processor. Inputs
  // X/Y are mono-video coordinate fields, Z is the source video.
  registerVideoModule(ruttetraDef);
  // SHAPEDRAMPS — sync-locked ramp generator. Stable linear (h_lin/
  // v_lin) outputs for clean raster passthrough, plus shaped (h_out/
  // v_out) outputs for morphable raster-coordinate fields.
  registerVideoModule(shapedrampsDef);
  // VDELAY — video delay + feedback echo (visual analog to CHARLOTTE'S
  // ECHOS). Ring buffer of FBO textures, configurable delay/feedback/mix.
  registerVideoModule(vdelayDef);
  // BENTBOX — CRT output simulating an NTSC composite signal bent through
  // an Archer-Video-Enhancer-style "AVEmod" feedback circuit. 12 CV-controllable
  // bending knobs (timing drift, chroma corruption, wavefolding, recursion).
  registerVideoModule(bentboxDef);
  // ACIDWARP — 320×240 plasma video source with scene cycler. NTSC-aspect
  // 4:3 so BENTBOX downstream sees no aspect distortion.
  registerVideoModule(acidwarpDef);
  // DOOM — single-instance interactive video module. WASM-backed
  // doomgeneric runs on the host; spectators receive framebuffers via
  // Yjs awareness at ~10 Hz. 7 cv-gate inputs (w/a/s/d/space/ctrl/alt)
  // edge-detect into the key queue; stereo audio outputs via the
  // PR-A video→audio bridge (silent until slice 8). maxInstances: 1.
  registerVideoModule(doomDef);
  // Re-expose module specs so the (audio + video) combined snapshot
  // lands on window.__moduleSpecs. The audio barrel already calls this
  // after registering its own defs; we redo it here so the e2e
  // io-spec-consistency suite (which iterates over the published
  // specs) sees the video defs too.
  exposeModuleSpecsForTests();
}

registerVideoModules();
