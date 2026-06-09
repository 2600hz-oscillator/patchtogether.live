// packages/web/src/lib/video/worker/worker-proxy-handle.ts
//
// Fix E Phase 1 — the WorkerProxyHandle.
//
// Lives in the MAIN VideoEngine in place of a worker-locus module's normal
// factory surface. Its `surface.texture` is a real MAIN-GL texture; its
// `surface.draw()` drains the latest transferred ImageBitmap for this nodeId
// (from the bridge) into that texture via `gl.texImage2D(..., bitmap)` then
// `bitmap.close()`. Downstream modules + OUTPUT previews sample
// `surface.texture` exactly like a normal node — the worker is invisible to
// them.
//
// FALLBACK: if the worker isn't ready (still initialising) OR has failed (no
// worker WebGL2 / construction error), the proxy renders the node ON THE MAIN
// THREAD using the real module factory — so a worker-locus node is NEVER blank
// because of the worker. The proxy only switches to the worker texture once the
// bridge reports ready(); if the worker later dies (bridge.ready() flips false)
// it transparently re-materializes the main-thread fallback.
//
// setParam / readParam / read are forwarded BOTH to the worker (so the worker
// node tracks param + CV changes) AND to the fallback handle when it exists (so
// a fallback render stays correct). This keeps CV → param coupling working: the
// main engine's CV bridge calls setParam on this handle; we relay it over RPC.

import type {
  VideoNodeHandle,
  VideoNodeSurface,
  VideoEngineContext,
  VideoFrameContext,
  VideoModuleFactory,
} from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import type { RenderWorkerBridge } from './worker-bridge';

export class WorkerProxyHandle implements VideoNodeHandle {
  readonly domain = 'video' as const;
  readonly surface: VideoNodeSurface;

  private gl: WebGL2RenderingContext;
  private bridge: RenderWorkerBridge;
  private node: ModuleNode;
  private factory: VideoModuleFactory;
  private context: () => VideoEngineContext;

  /** The main-GL texture the worker frames are uploaded into. */
  private workerTexture: WebGLTexture | null = null;
  /** Whether the worker texture has received at least one bitmap (so we don't
   *  expose an uninitialized texture as a finished frame). */
  private workerTextureReady = false;

  /** Lazily-materialized main-thread fallback (only when the worker can't / isn't
   *  yet rendering). Null while the worker path is live. */
  private fallback: VideoNodeHandle | null = null;
  /** Last-applied param values, so a fallback materialized AFTER some setParam
   *  calls (e.g. worker died mid-session) starts from the right state. */
  private params: Record<string, number>;

  private disposed = false;

  constructor(opts: {
    gl: WebGL2RenderingContext;
    bridge: RenderWorkerBridge;
    node: ModuleNode;
    factory: VideoModuleFactory;
    /** Builds a fresh VideoEngineContext attributed to this node (for the
     *  fallback factory). The engine passes `() => this.context(node.id)`. */
    context: () => VideoEngineContext;
  }) {
    this.gl = opts.gl;
    this.bridge = opts.bridge;
    this.node = opts.node;
    this.factory = opts.factory;
    this.context = opts.context;
    this.params = { ...opts.node.params };

    // Tell the worker to start rendering this node.
    this.bridge.addNode(opts.node);

    const self = this;
    this.surface = {
      get fbo() {
        // Mirror the active path's fbo (fallback has a real one; worker path
        // has none — downstream only reads `texture`).
        return self.fallback ? self.fallback.surface.fbo : null;
      },
      get texture() {
        if (self.bridge.ready() && self.workerTextureReady) {
          // Worker has delivered at least one frame → sample the worker texture.
          return self.workerTexture;
        }
        // Initialising / warming up / failed → the main-thread fallback's
        // texture (it's drawn this frame in draw()), or null if not yet built.
        return self.fallback ? self.fallback.surface.texture : null;
      },
      draw(frame: VideoFrameContext) {
        self.draw(frame);
      },
      resize(width: number, height: number) {
        self.bridge.setResolution(width, height);
        self.fallback?.surface.resize?.(width, height);
        // Re-spec the worker texture so a post-resize bitmap uploads cleanly.
        if (self.workerTexture) {
          const gl = self.gl;
          gl.bindTexture(gl.TEXTURE_2D, self.workerTexture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Math.max(2, width), Math.max(2, height), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindTexture(gl.TEXTURE_2D, null);
          self.workerTextureReady = false;
        }
      },
      dispose() {
        self.dispose();
      },
    };
  }

  private ensureWorkerTexture(): WebGLTexture {
    if (this.workerTexture) return this.workerTexture;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('WorkerProxyHandle: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.workerTexture = tex;
    return tex;
  }

  private ensureFallback(): VideoNodeHandle {
    if (this.fallback) return this.fallback;
    // Materialize the real module on the main thread, seeded with the latest
    // params, so a node the worker can't render is still correct.
    const seeded: ModuleNode = { ...this.node, params: { ...this.params } };
    this.fallback = this.factory(this.context(), seeded);
    return this.fallback;
  }

  private releaseFallback(): void {
    if (!this.fallback) return;
    try { this.fallback.dispose(); } catch { /* */ }
    this.fallback = null;
  }

  private draw(frame: VideoFrameContext): void {
    if (this.disposed) return;
    if (this.bridge.ready()) {
      // Worker path: drain the latest transferred frame into our main-GL
      // texture so downstream + OUTPUT cards sample it like a normal node.
      const bmp = this.bridge.takeFrame(this.node.id);
      if (bmp) {
        const gl = this.gl;
        const tex = this.ensureWorkerTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // The worker renders bottom-left origin (GL); the main engine samples
        // textures the same way (no flip applied on the main path either), so
        // upload UNPACK_FLIP_Y false to keep parity with a main-thread FBO.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          this.workerTextureReady = true;
        } catch {
          // A bad upload shouldn't crash the frame; drop this bitmap.
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        try { bmp.close(); } catch { /* */ }
      }
      // Keep the fallback handle ticking IF one exists — it's only ever
      // materialized to serve a CPU-side `read()` the card polls (acidwarp's
      // `read('snapshot')`), whose animation state advances inside draw(). For
      // a module with no such read path the fallback is never created, so this
      // is a no-op and the worker fully owns the render. The fallback's GL
      // output lands in its own unused FBO; downstream samples the WORKER
      // texture (surface.texture), so there's no double-present.
      if (this.fallback && this.workerTextureReady) {
        try { this.fallback.surface.draw(frame); } catch { /* */ }
      } else if (!this.workerTextureReady) {
        // Worker is ready but hasn't delivered a first frame yet — keep the
        // node non-blank during warm-up by rendering the fallback this frame
        // (its texture is what surface.texture returns until the first bitmap).
        this.ensureFallback().surface.draw(frame);
      }
      return;
    }
    // Worker not usable (initialising or failed): render on the main thread.
    this.ensureFallback().surface.draw(frame);
  }

  setParam(paramId: string, value: number): void {
    this.params[paramId] = value; // guard:allow-raw-write — worker-side param cache (proxy object, not the live Y.Doc)
    this.bridge.setParam(this.node.id, paramId, value);
    this.fallback?.setParam(paramId, value);
  }

  setParamWave(paramId: string, window: Float32Array): void {
    this.fallback?.setParamWave?.(paramId, window);
  }

  readParam(paramId: string): number | undefined {
    if (this.fallback) {
      const v = this.fallback.readParam(paramId);
      if (v !== undefined) return v;
    }
    return this.params[paramId];
  }

  read(key: string): unknown {
    // The card preview path (e.g. acidwarp's `read('snapshot')`) is CPU-only and
    // identical regardless of where GL runs. We serve it from the fallback
    // handle, materializing it on demand so the card always has a live preview
    // even while the worker renders the downstream-facing texture.
    return this.ensureFallback().read?.(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge.removeNode(this.node.id);
    this.releaseFallback();
    if (this.workerTexture) {
      try { this.gl.deleteTexture(this.workerTexture); } catch { /* */ }
      this.workerTexture = null;
    }
    this.workerTextureReady = false;
  }
}
