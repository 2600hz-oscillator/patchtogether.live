// butterchurn.d.ts — ambient module declarations for the (untyped) Milkdrop
// engine + preset packs used by the MILKDROP video module.
//
// `@webamp/butterchurn` (the maintained fork) and `butterchurn-presets` ship no
// `.d.ts`, so this declares the slice of their runtime surface that
// `$lib/video/modules/milkdrop.ts` actually touches. Kept at the package src
// ROOT (NOT under lib/video/**) so it stays OUT of the WebGL attest hash basis —
// a type-only file should never churn the GPU attest.

declare module '@webamp/butterchurn' {
  export interface ButterchurnVisualizerOpts {
    width: number;
    height: number;
    /** Warp-mesh resolution (default 48×36). Kept MODEST for the SwiftShader
     *  CI renderer — this is per-vertex CPU equation eval each frame. */
    meshWidth?: number;
    meshHeight?: number;
    /** Internal texture = width·height·pixelRatio·textureRatio. */
    pixelRatio?: number;
    textureRatio?: number;
    outputFXAA?: boolean;
  }

  /** The live AudioLevels instance — `bass`/`mid`/`treb` (+`_att`) are GETTERS
   *  on its prototype that the renderer reads each frame to build globalVars.
   *  MILKDROP redefines these on the instance to splice in CV overrides. */
  export interface ButterchurnAudioLevels {
    bass: number;
    mid: number;
    treb: number;
    bass_att: number;
    mid_att: number;
    treb_att: number;
  }

  export interface ButterchurnRenderAudioLevels {
    timeByteArray: Uint8Array;
    timeByteArrayL?: Uint8Array;
    timeByteArrayR?: Uint8Array;
  }

  export interface ButterchurnVisualizer {
    /** Renderer holds the live AudioLevels instance (CV-override seam). */
    renderer: { audioLevels: ButterchurnAudioLevels };
    connectAudio(node: AudioNode): void;
    disconnectAudio(node: AudioNode): void;
    /** Async: may compile preset equation WASM (no-op for classic JS presets). */
    loadPreset(preset: unknown, blendTime?: number): Promise<void>;
    setRendererSize(width: number, height: number): void;
    setInternalMeshSize(width: number, height: number): void;
    /** Pass `audioLevels` to use OUR bytes instead of the internal analyser;
     *  `elapsedTime` (seconds) advances butterchurn's internal clock. */
    render(opts?: {
      audioLevels?: ButterchurnRenderAudioLevels;
      elapsedTime?: number;
    }): void;
    launchSongTitleAnim(text: string): void;
  }

  const butterchurn: {
    createVisualizer(
      audioContext: BaseAudioContext,
      canvas: HTMLCanvasElement | OffscreenCanvas,
      opts: ButterchurnVisualizerOpts,
    ): ButterchurnVisualizer;
  };
  export default butterchurn;
}

declare module 'butterchurn-presets/lib/butterchurnPresetsMinimal.min.js' {
  /** name → opaque preset object (fed straight to visualizer.loadPreset). */
  const presets: { getPresets(): Record<string, unknown> };
  export default presets;
}
