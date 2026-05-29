// packages/web/src/lib/audio/modules/foxy-shapes-draw.ts
//
// FOXY 3dShapeGen — on-card renderer. The actual draw logic has moved to
// `packages/web/src/lib/video/modules/shapegen-draw.ts` so the new
// SHAPEGEN video module can share it byte-for-byte (FOXY's COMBINED
// video out + the new SHAPEGEN module both call the same shared
// renderer). This file is a re-export shim so FOXY's existing import
// surface (`drawFoxyShapes` + `foxyShapeTypeLabels` from
// './foxy-shapes-draw') stays unchanged.

export {
  drawFoxyShapes,
  foxyShapeTypeLabels,
  type FoxyShapesDrawOptions,
} from '$lib/video/modules/shapegen-draw';
