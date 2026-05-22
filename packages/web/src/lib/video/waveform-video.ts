// packages/web/src/lib/video/waveform-video.ts
//
// Audio waveform → mono-video texture renderer. Used by WAVVIZ, SWOLEVCO,
// and SCOPE to expose their audio output as a video-domain stream that
// can be patched into video-domain inputs (OUTPUT, MIXER, etc.).
//
// Design:
//   - Owns a WebGLFramebuffer + RGBA8 texture at engine resolution.
//   - Each draw() call uploads a Float32Array sample window to a 1-D
//     R32F texture (wave samples), then renders an oscilloscope-style
//     trace via a fullscreen-quad fragment shader. The trace is white on
//     a near-black background; the result is a mono-video stream
//     (R=G=B), suitable for direct upcast to RGB video.
//   - Works in head-less GL (the test path) and live WebGL2 alike.
//
// Why a custom shader rather than a 2D-canvas trace + texSubImage:
//   1. The 2D path requires a separate readback round-trip (canvas →
//      ImageData → uploadTex), which gets expensive at 60fps.
//   2. The shader is trivially extensible to color/intensity controls
//      and antialiasing once we have time.

const VERTEX_SRC = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uWave;     // 1-D R32F sample buffer (wave[i] in [-1, 1])
uniform float uSampleCount;  // number of valid samples in uWave
uniform float uTraceWidth;   // half-thickness of the trace, in NDC y-units (~0.01)
uniform float uRangeMax;     // vertical scale: ±uRangeMax fills the canvas (1.0 for audio)

void main() {
  // Read the waveform value at this column's x. uWave is a 1-D
  // texture; we read by uv.x. Texture filter is NEAREST — R32F is
  // core-WebGL2 sampleable but NOT core-WebGL2 filterable, and a
  // LINEAR read of an R32F texture returns 0.0 on conformant
  // browsers without OES_texture_float_linear (the Bug-2 root
  // cause: every column read as 0 → trace stayed at canvas center,
  // a "thin horizontal line"). NB: GLSL ES 3.0 reserves the
  // identifier "sample" so we use "wv" for the local float.
  float texX = vUv.x;
  float wv = texture(uWave, vec2(texX, 0.5)).r;

  // Map wv [-rangeMax, +rangeMax] to NDC [0, 1]. y=0.5 is center.
  float yCenter = 0.5 + (wv / uRangeMax) * 0.5;

  // Trace as a band around yCenter. smoothstep gives a soft edge.
  float dy = abs(vUv.y - yCenter);
  float w = max(uTraceWidth, 0.001);
  float intensity = 1.0 - smoothstep(w * 0.5, w, dy);

  // Background: near-black. Trace: white on top.
  vec3 bg = vec3(0.02, 0.03, 0.04);
  vec3 fg = vec3(1.0, 1.0, 1.0);
  vec3 col = mix(bg, fg, intensity);
  outColor = vec4(col, 1.0);

  // Reference uSampleCount in a no-op so it isn't optimized out (some
  // drivers fail uniform lookup if a uniform compiles away).
  outColor.r += 0.0 * uSampleCount;
}`;

/** Default sample buffer length. Power-of-two so most analyser fftSize
 *  values feed into us cleanly. */
export const DEFAULT_SAMPLE_COUNT = 1024;

export interface WaveformRendererOptions {
  /** Trace width as a fraction of canvas height. Default: ~1.5 px at
   *  360-tall video — visible without overpowering the trace's shape. */
  traceWidth?: number;
  /** Vertical fullscale. Audio is ±1; CV is ±5. Default 1.0. */
  rangeMax?: number;
  /** Max sample count the renderer can hold per frame. Caller can
   *  upload fewer samples; the rest of the texture rolls over. */
  sampleCount?: number;
}

/** Lightweight RAII over a fullscreen-quad VAO. Each renderer owns its
 *  own VAO so a teardown doesn't poison sibling renderers. */
function makeFullscreenQuad(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
} {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('waveform-video: createVertexArray failed');
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteVertexArray(vao);
    throw new Error('waveform-video: createBuffer failed');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buffer };
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('waveform-video: createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`waveform-video: shader compile failed: ${log}\n${src}`);
  }
  return sh;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader,
): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error('waveform-video: createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`waveform-video: program link failed: ${log}`);
  }
  return prog;
}

/**
 * Allocates an FBO + texture sized to (resWidth, resHeight) and a
 * shader pipeline that renders a waveform trace into it. Caller drives
 * the renderer each frame: `renderer.update(samples); renderer.draw();`.
 *
 * Output texture is RGBA8 mono (R=G=B) so it composes cleanly with
 * other video-domain modules via the implicit mono-video → video upcast.
 */
export interface WaveformRenderer {
  /** The output texture downstream video modules sample. */
  readonly texture: WebGLTexture;
  /** The output framebuffer. Owned by us; callers don't bind it themselves. */
  readonly fbo: WebGLFramebuffer;
  /** Push a window of audio samples (any length up to sampleCount). */
  update(samples: Float32Array): void;
  /** Render the current sample buffer into the FBO at full resolution.
   *  Caller must restore their own framebuffer + viewport after this if
   *  they were using a different one — the engine's per-module draw()
   *  contract already restores after each module's pass. */
  draw(width: number, height: number): void;
  /** Tear down GL objects. Idempotent. */
  dispose(): void;
}

export function createWaveformRenderer(
  gl: WebGL2RenderingContext,
  resWidth: number,
  resHeight: number,
  opts: WaveformRendererOptions = {},
): WaveformRenderer {
  const sampleCount = opts.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const traceWidth = opts.traceWidth ?? 0.012;
  const rangeMax = opts.rangeMax ?? 1.0;

  // Compile shaders.
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = linkProgram(gl, vs, fs);
  // Linker has its own copy.
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const uWave = gl.getUniformLocation(program, 'uWave');
  const uSampleCount = gl.getUniformLocation(program, 'uSampleCount');
  const uTraceWidth = gl.getUniformLocation(program, 'uTraceWidth');
  const uRangeMax = gl.getUniformLocation(program, 'uRangeMax');

  // 1-D R32F texture for the wave buffer. We use a 1-row 2D texture
  // (sampleCount × 1) since WebGL2 has no native 1D textures. LINEAR
  // filter so the trace interpolates between samples.
  const waveTex = gl.createTexture();
  if (!waveTex) throw new Error('waveform-video: createTexture(wave) failed');
  gl.bindTexture(gl.TEXTURE_2D, waveTex);
  // R32F: single-channel float, mapped 1:1 to sample value. We need
  // EXT_color_buffer_float for renderable, but as a SAMPLED texture
  // R32F is core in WebGL2.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    sampleCount,
    1,
    0,
    gl.RED,
    gl.FLOAT,
    null,
  );
  // R32F is core-WebGL2 SAMPLEABLE but NOT core-WebGL2 FILTERABLE. The
  // `OES_texture_float_linear` extension would unlock LINEAR — but it's
  // not universally available, and on conformant browsers without it
  // LINEAR-sampling an R32F texture returns 0.0 for every read (the
  // earlier "thin horizontal line at center" Bug-2 root cause). NEAREST
  // is core, always works, and the per-column step in the shader is
  // already small enough (1 sample per pixel column at sampleCount ≥
  // canvas-width) that LINEAR's interpolation isn't load-bearing for
  // the trace shape — only the shader's smoothstep along Y matters.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Output FBO + texture (RGBA8 — what every other video module produces).
  const outTexture = gl.createTexture();
  if (!outTexture) {
    gl.deleteTexture(waveTex);
    throw new Error('waveform-video: createTexture(out) failed');
  }
  gl.bindTexture(gl.TEXTURE_2D, outTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    resWidth,
    resHeight,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(waveTex);
    gl.deleteTexture(outTexture);
    throw new Error('waveform-video: createFramebuffer failed');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTexture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(waveTex);
    gl.deleteTexture(outTexture);
    gl.deleteFramebuffer(fbo);
    throw new Error(`waveform-video: framebuffer incomplete: 0x${status.toString(16)}`);
  }

  const { vao, buffer: vbo } = makeFullscreenQuad(gl);

  // Working sample buffer — caller writes into this on update().
  const sampleBuffer = new Float32Array(sampleCount);

  // Track last uploaded sample count so a partial update doesn't leave
  // stale tail data on screen — we zero the rest.
  let validSamples = 0;

  return {
    texture: outTexture,
    fbo,
    update(samples: Float32Array): void {
      const n = Math.min(samples.length, sampleCount);
      // Copy into our owned buffer, zero the rest.
      sampleBuffer.set(samples.subarray(0, n), 0);
      if (n < sampleCount) {
        for (let i = n; i < sampleCount; i++) sampleBuffer[i] = 0;
      }
      validSamples = n;
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0, 0,
        sampleCount,
        1,
        gl.RED,
        gl.FLOAT,
        sampleBuffer,
      );
    },
    draw(width: number, height: number): void {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(uWave, 0);
      gl.uniform1f(uSampleCount, validSamples);
      gl.uniform1f(uTraceWidth, traceWidth);
      gl.uniform1f(uRangeMax, rangeMax);

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    dispose(): void {
      try { gl.deleteVertexArray(vao); } catch { /* */ }
      try { gl.deleteBuffer(vbo); } catch { /* */ }
      try { gl.deleteProgram(program); } catch { /* */ }
      try { gl.deleteTexture(waveTex); } catch { /* */ }
      try { gl.deleteTexture(outTexture); } catch { /* */ }
      try { gl.deleteFramebuffer(fbo); } catch { /* */ }
    },
  };
}

// ----------------------------------------------------------------------
// Pure-CPU helper for tests / non-GL pixel-prediction. Renders the same
// trace into an Uint8ClampedArray sized (width × height × 4). Used by
// the unit tests that don't have a WebGL2 context.
// ----------------------------------------------------------------------

export interface CpuTraceOptions {
  /** Vertical fullscale. Same semantics as WaveformRendererOptions. */
  rangeMax?: number;
  /** Trace half-thickness in pixels. */
  traceWidthPx?: number;
}

/**
 * Render a waveform trace to RGBA8 pixels — pure JS, no GL. Used by
 * waveform-video.test.ts to verify the line-trace pixel pattern is
 * what we expect for known inputs (sine, square, noise) without a GL
 * context. Output convention matches the GL shader (white trace on
 * dark bg, R=G=B).
 */
export function renderWaveformCpu(
  samples: Float32Array,
  width: number,
  height: number,
  opts: CpuTraceOptions = {},
): Uint8ClampedArray {
  const rangeMax = opts.rangeMax ?? 1.0;
  const traceWidthPx = Math.max(1, opts.traceWidthPx ?? Math.max(2, Math.round(height * 0.012)));
  const out = new Uint8ClampedArray(width * height * 4);
  // Background fill — match shader's near-black bg.
  for (let i = 0; i < out.length; i += 4) {
    out[i + 0] = 5;
    out[i + 1] = 8;
    out[i + 2] = 10;
    out[i + 3] = 255;
  }
  if (samples.length === 0) return out;

  // Step through each column; sample-interpolate from the input buffer.
  for (let x = 0; x < width; x++) {
    const u = x / Math.max(1, width - 1);
    const fIdx = u * (samples.length - 1);
    const i0 = Math.floor(fIdx);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = fIdx - i0;
    const s = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t;
    // Map sample to pixel y. y=0 is top in 2D; trace center is at
    // (1 + s/range) / 2 of height.
    const yCenter = (1 - s / rangeMax) * 0.5 * (height - 1);
    const yMin = Math.max(0, Math.floor(yCenter - traceWidthPx));
    const yMax = Math.min(height - 1, Math.ceil(yCenter + traceWidthPx));
    for (let y = yMin; y <= yMax; y++) {
      const dy = Math.abs(y - yCenter);
      const intensity = Math.max(0, 1 - dy / traceWidthPx);
      const idx = (y * width + x) * 4;
      const v = Math.round(255 * intensity);
      out[idx + 0] = Math.max(out[idx + 0]!, v);
      out[idx + 1] = Math.max(out[idx + 1]!, v);
      out[idx + 2] = Math.max(out[idx + 2]!, v);
      out[idx + 3] = 255;
    }
  }
  return out;
}
