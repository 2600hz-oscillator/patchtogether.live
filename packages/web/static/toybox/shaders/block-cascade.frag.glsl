// TOYBOX GEN — block-cascade (falling tetromino blocks, SHADERTOY single-pass)
//
// A cascading wall of falling four-cell BLOCKS down a recessed grid well — an
// homage to the 80s/90s falling-blocks puzzler. Each column drops bevelled blocks
// at its own phase/speed; cells light up in the classic primary-colour tetromino
// palette over a dim grid. `speed` sets the fall rate, `density` how full the well
// is, `hue` rotates the block palette. Generative, no scene input.
//
// === LICENSE / PROVENANCE ===
// MIT — Original clean-room TOYBOX shader. Per-column hashed fall + bevelled cell
// shading. Aesthetic HOMAGE only; no copyrighted shapes, logos or source text used.
//
// Manifest: shadertoy:true, input:none (GEN). Params:
//   speed   — block fall rate
//   density — how many columns carry falling blocks (well fullness)
//   hue     — palette rotation of the block colours

float hash11(float n) { return fract(sin(n * 91.17) * 43758.5453); }
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy; // 0..1
  float t = iTime * (0.5 + speed);

  const float COLS = 12.0;
  const float ROWS = 18.0;
  vec2 g = uv * vec2(COLS, ROWS);
  vec2 cell = fract(g);
  vec2 id = floor(g);

  // base: dim recessed well + grid lines.
  vec3 col = vec3(0.04, 0.05, 0.08);
  float grid = smoothstep(0.0, 0.04, cell.x) * smoothstep(0.0, 0.04, 1.0 - cell.x)
             * smoothstep(0.0, 0.04, cell.y) * smoothstep(0.0, 0.04, 1.0 - cell.y);
  col = mix(vec3(0.10, 0.12, 0.16), col, grid);

  // each column drops a stack of blocks at its own phase.
  float ch = hash11(id.x + 1.0);
  float colSpeed = 0.6 + ch * 1.4;
  float fall = t * colSpeed + ch * ROWS;        // moving "read head" down the column
  // a block occupies this cell if its hashed pattern + density says so AND it is
  // at-or-below the falling read head (so the stack builds from the bottom up).
  float pat = hash11(id.x * 7.0 + id.y * 3.0);
  float headRow = ROWS - mod(fall, ROWS + 6.0); // sweeps down then wraps
  float active = step(pat, 0.25 + density * 0.55) * step(id.y, headRow + 0.5);

  if (active > 0.5) {
    // tetromino-ish colour per cell from a hashed palette index.
    float idx = floor(hash11(id.x * 2.3 + floor(id.y / 2.0) * 5.1) * 6.0);
    vec3 blk = hsv2rgb(vec3(fract(idx / 6.0 + hue), 0.85, 1.0));
    // bevel: lighten top/left, darken bottom/right.
    float bevel = (cell.y - 0.5) * -0.5 + (0.5 - cell.x) * 0.4;
    blk *= 1.0 + bevel;
    // inset border.
    float inset = smoothstep(0.0, 0.10, cell.x) * smoothstep(0.0, 0.10, 1.0 - cell.x)
                * smoothstep(0.0, 0.10, cell.y) * smoothstep(0.0, 0.10, 1.0 - cell.y);
    blk *= mix(0.55, 1.0, inset);
    // freshly-landed glow at the read head row.
    float fresh = smoothstep(1.5, 0.0, abs(id.y - headRow));
    blk += blk * fresh * 0.6;
    col = blk;
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
