// packages/web/src/lib/video/worker/worker-engine.ts
//
// Fix E Phase 1 — the WORKER-SIDE mini render engine (a "texture co-processor").
//
// This is NOT a replacement for the main VideoEngine. It owns its OWN
// OffscreenCanvas + WebGL2 context + a minimal FBO registry, and renders ONLY
// the modules that have been opted into `renderLocus: 'worker'` and forwarded
// here over the RPC channel. Each worker node renders into its own FBO; the
// render-worker then blits that FBO into the OffscreenCanvas drawing buffer and
// `transferToImageBitmap()`s it back to the main thread, where a
// WorkerProxyHandle uploads it into a MAIN-GL texture (so downstream + previews
// sample it exactly like a normal node).
//
// It re-implements just enough of VideoEngine's VideoEngineContext surface for
// pure-GL, DOM-free, no-video-input SOURCE factories (Phase 1 = acidwarp):
//   - compileFragment / createFbo / drawFullscreenQuad / res
//   - getInputTexture ALWAYS returns null here (no cross-worker input edges in
//     Phase 1 — worker nodes are leaf sources). A worker-resident module MUST
//     tolerate an unpatched input (the same contract as the main engine), which
//     all pure-GL sources already do.
//   - getMouse / isOutputConnected are stubbed (worker sources don't use them).
//   - NO AudioContext (audioCtx is undefined — worker modules can't emit audio).
//
// CV → param coupling still works: the MAIN engine's CV bridge samples the
// analyser on the main thread and calls setParam on the proxy handle, which
// forwards the value here over RPC → the worker node's setParam. No SAB needed
// for Phase 1.

import type { ModuleNode } from '$lib/graph/types';
import type {
  VideoEngineContext,
  VideoFrameContext,
  VideoNodeHandle,
} from '$lib/video/engine';
import type { VideoModuleFactory } from '$lib/video/engine';

/** A factory the worker is allowed to instantiate, keyed by module type. The
 *  render-worker registers exactly the worker-eligible factories (Phase 1 =
 *  acidwarp). Keeping this explicit (rather than importing the whole module
 *  barrel) means the worker bundle pulls in ONLY pure-GL, DOM-free factories —
 *  importing a DOM-coupled card/module would blow up in the worker realm. */
export type WorkerFactoryRegistry = Readonly<Record<string, VideoModuleFactory>>;

const VERT_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Pass-through fragment used to blit a node's FBO texture into the drawing
// buffer right before transferToImageBitmap (mirror of the main engine's
// blitOutputToDrawingBuffer copy shader).
const COPY_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() { outColor = texture(uTex, vUv); }`;

interface WorkerNode {
  id: string;
  handle: VideoNodeHandle;
}

/**
 * The worker-side mini-engine. One instance per render worker. Owns the
 * OffscreenCanvas + WebGL2 context and the worker-resident node handles.
 */
export class WorkerRenderEngine {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  private _res: { width: number; height: number };

  private factories: WorkerFactoryRegistry;
  private nodes = new Map<string, WorkerNode>();
  private managedFbos = new Map<string, Array<{ fbo: WebGLFramebuffer; texture: WebGLTexture }>>();
  private currentFactoryNodeId: string | null = null;

  private vertexShader: WebGLShader | null = null;
  private fullscreenVao: WebGLVertexArrayObject | null = null;
  private copyProgram: WebGLProgram | null = null;
  private copyUTex: WebGLUniformLocation | null = null;

  private startTime = performance.now();
  private lastStepTime = performance.now();
  private frameCount = 0;
  private timeDelta = 1 / 60;
  private frameRate = 60;

  constructor(
    factories: WorkerFactoryRegistry,
    res: { width: number; height: number },
  ) {
    this.factories = factories;
    this._res = { width: Math.max(2, res.width), height: Math.max(2, res.height) };
    this.canvas = new OffscreenCanvas(this._res.width, this._res.height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      // The drawing buffer is consumed by transferToImageBitmap each frame; no
      // need to preserve it across frames.
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WorkerRenderEngine: WebGL2 not supported in worker');
    this.gl = gl as WebGL2RenderingContext;
  }

  get res(): { readonly width: number; readonly height: number } {
    return this._res;
  }

  /** True iff the worker has at least one materialized node to render. */
  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /** Materialize a worker-resident node from a snapshot. No-op if the type
   *  isn't worker-eligible (the bridge only forwards eligible nodes, but we
   *  guard so an unexpected type fails soft rather than throwing in the worker). */
  addNode(node: ModuleNode): boolean {
    if (this.nodes.has(node.id)) return true;
    const factory = this.factories[node.type as string];
    if (!factory) return false;
    this.currentFactoryNodeId = node.id;
    let handle: VideoNodeHandle;
    try {
      handle = factory(this.context(node.id), node);
    } finally {
      this.currentFactoryNodeId = null;
    }
    this.nodes.set(node.id, { id: node.id, handle });
    return true;
  }

  removeNode(nodeId: string): void {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    try { n.handle.dispose(); } catch { /* */ }
    this.nodes.delete(nodeId);
    this.managedFbos.delete(nodeId);
  }

  setParam(nodeId: string, paramId: string, value: number): void {
    this.nodes.get(nodeId)?.handle.setParam(paramId, value);
  }

  setResolution(width: number, height: number): boolean {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (w === this._res.width && h === this._res.height) return false;
    this._res.width = w;
    this._res.height = h;
    try {
      this.canvas.width = w;
      this.canvas.height = h;
    } catch { /* */ }
    const gl = this.gl;
    // Re-spec every managed colour texture to the new res (the common case).
    for (const list of this.managedFbos.values()) {
      for (const { texture } of list) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const n of this.nodes.values()) {
      try { n.handle.surface.resize?.(w, h); } catch { /* */ }
    }
    return true;
  }

  /** Run one frame: draw every worker node into its FBO. Returns the node ids
   *  (in stable order) that have a non-null surface texture, so the caller can
   *  transfer one ImageBitmap per node. */
  step(): string[] {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastStepTime) / 1000));
    this.lastStepTime = now;
    this.timeDelta = dt;
    if (dt > 1e-4) this.frameRate = this.frameRate * 0.9 + (1 / dt) * 0.1;

    const ctx: VideoFrameContext = {
      gl: this.gl,
      time: (now - this.startTime) / 1000,
      frame: this.frameCount++,
      timeDelta: this.timeDelta,
      frameRate: this.frameRate,
      getMouse: () => [0, 0, 0, 0],
      // Phase 1 worker nodes are leaf sources with no cross-worker input edges.
      getInputTexture: () => null,
      isOutputConnected: () => true,
    };
    const ready: string[] = [];
    for (const n of this.nodes.values()) {
      try {
        n.handle.surface.draw(ctx);
        if (n.handle.surface.texture) ready.push(n.id);
      } catch { /* a throwing module shouldn't kill the whole worker frame */ }
    }
    return ready;
  }

  /** Blit a node's FBO texture into the OffscreenCanvas drawing buffer, then
   *  transfer the whole canvas as an ImageBitmap (zero-copy). The caller posts
   *  it back to the main thread. Mirrors VideoEngine.blitOutputToDrawingBuffer
   *  + the spike's transferToImageBitmap path. */
  transferNodeFrame(nodeId: string): ImageBitmap | null {
    const n = this.nodes.get(nodeId);
    const tex = n?.handle.surface.texture;
    if (!tex) return null;
    const gl = this.gl;
    if (!this.copyProgram) {
      this.copyProgram = this.compileFragmentImpl(COPY_FRAG_SRC);
      this.copyUTex = gl.getUniformLocation(this.copyProgram, 'uTex');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this._res.width, this._res.height);
    gl.useProgram(this.copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.copyUTex) gl.uniform1i(this.copyUTex, 0);
    this.drawFullscreenQuadImpl();
    return this.canvas.transferToImageBitmap();
  }

  dispose(): void {
    for (const n of this.nodes.values()) {
      try { n.handle.dispose(); } catch { /* */ }
    }
    this.nodes.clear();
    this.managedFbos.clear();
    const gl = this.gl;
    if (this.fullscreenVao) gl.deleteVertexArray(this.fullscreenVao);
    if (this.vertexShader) gl.deleteShader(this.vertexShader);
    if (this.copyProgram) gl.deleteProgram(this.copyProgram);
    this.fullscreenVao = null;
    this.vertexShader = null;
    this.copyProgram = null;
    this.copyUTex = null;
  }

  // -------- VideoEngineContext for worker factories --------

  private context(ownerNodeId: string | null): VideoEngineContext {
    const owner = ownerNodeId ?? this.currentFactoryNodeId ?? null;
    return {
      gl: this.gl,
      res: this._res,
      wideActive: false,
      compileFragment: (src) => this.compileFragmentImpl(src),
      createFbo: (opts) => this.createFboImpl(opts?.managed ?? true, owner),
      drawFullscreenQuad: () => this.drawFullscreenQuadImpl(),
      // No createFloatFbo / audioCtx in the worker — Phase 1 worker modules
      // (acidwarp) need neither. A module asserting their presence is not
      // worker-eligible.
    };
  }

  // -------- GL helpers (mirror VideoEngine's private impls) --------

  private getOrCreateVertexShader(): WebGLShader {
    if (this.vertexShader) return this.vertexShader;
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) throw new Error('WorkerRenderEngine: cannot create vertex shader');
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs);
      throw new Error(`WorkerRenderEngine: vertex shader compile failed: ${log}`);
    }
    this.vertexShader = vs;
    return vs;
  }

  private compileFragmentImpl(fragSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.getOrCreateVertexShader();
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) throw new Error('WorkerRenderEngine: cannot create fragment shader');
    gl.shaderSource(fs, fragSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      gl.deleteShader(fs);
      throw new Error(`WorkerRenderEngine: fragment shader compile failed: ${log}\n${fragSource}`);
    }
    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(fs);
      throw new Error('WorkerRenderEngine: cannot create program');
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`WorkerRenderEngine: program link failed: ${log}`);
    }
    return prog;
  }

  private createFboImpl(
    managed: boolean,
    owner: string | null,
  ): { fbo: WebGLFramebuffer; texture: WebGLTexture } {
    const gl = this.gl;
    const w = this._res.width;
    const h = this._res.height;
    const tex = gl.createTexture();
    if (!tex) throw new Error('WorkerRenderEngine: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) {
      gl.deleteTexture(tex);
      throw new Error('WorkerRenderEngine: createFramebuffer failed');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      throw new Error(`WorkerRenderEngine: framebuffer incomplete: 0x${status.toString(16)}`);
    }
    if (managed && owner) {
      let list = this.managedFbos.get(owner);
      if (!list) { list = []; this.managedFbos.set(owner, list); }
      list.push({ fbo, texture: tex });
    }
    return { fbo, texture: tex };
  }

  private drawFullscreenQuadImpl(): void {
    const gl = this.gl;
    if (!this.fullscreenVao) {
      const vao = gl.createVertexArray();
      if (!vao) throw new Error('WorkerRenderEngine: createVertexArray failed');
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      if (!buf) {
        gl.deleteVertexArray(vao);
        throw new Error('WorkerRenderEngine: createBuffer failed');
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.fullscreenVao = vao;
    }
    gl.bindVertexArray(this.fullscreenVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
