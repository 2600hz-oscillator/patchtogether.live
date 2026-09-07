Title: toybox.patchtogether.live — public sandbox subsite for pasting shaders and uploading OBJ/assets that run in TOYBOX
Labels: enhancement, p3
---
> **Status: NOT scheduled.** This issue records the vision and its prerequisites so the
> in-flight TOYBOX randomize work (see the companion issue *"TOYBOX randomize:
> context-aware curated random patches…"*) can front-load the right architecture. Do not
> start building the subsite off this issue without an explicit owner go.

## Vision

A public subsite at **toybox.patchtogether.live** — think Shadertoy or a video-synth
sandbox site, but backed by the real TOYBOX renderer:

- **Paste shader code and run it.** GLSL-ES fragment shaders, including Shadertoy-style
  `mainImage(out vec4, in vec2)` sources — TOYBOX already ships a Shadertoy compatibility
  shim (full uniform block: `iResolution`/`iTime`/`iMouse`/`iChannel0-3`/…, multi-buffer
  pass support) — with immediate live preview and compile errors surfaced inline.
- **Upload OBJ models** (and matcaps/textures) and see them rendered with TOYBOX's
  material/projection pipeline.
- **Declare controls in the source**: annotated uniforms
  (`// @param(min,max,default,curve)`) become on-screen faders — the same params that are
  CV-routable and randomizable inside the app.
- **Share**: a permalink per creation; browse/search a public gallery.
- **One-click "open in patchtogether.live"**: pull a sandbox creation into a TOYBOX
  module in a real rack as layer content — the bridge that turns visitors into users, and
  turns the community into a content pipeline for the app's asset bank (with license
  provenance captured at upload).

## Why

TOYBOX's content bank is currently a hand-maintained static manifest
(`packages/web/static/toybox/shaders|models` + `manifest.json`); adding one asset is a
repo PR. A sandbox subsite converts that into a community pipeline, gives TOYBOX a public
face that demos the engine in the browser with zero install, and feeds the in-app
randomizer an ever-growing pool.

## Prerequisites the randomize issue intentionally front-loads

These land inside the companion randomize issue's architecture phase (owner sequencing
directive: subsite-serving architecture first, randomize built on top). When this issue is
picked up, they should already exist:

1. **Dynamic asset provider seam** — asset enumeration/fetch behind an interface
   (static-manifest provider + runtime provider for session-registered assets), replacing
   direct reads of the hand-maintained manifest. The subsite's upload/paste path plugs in
   as one more provider; the randomizer and card already consume the seam.
2. **First-class params for arbitrary GLSL** — `uniform float` + `// @param` annotation
   extraction producing the same param schema as bundled assets, so pasted shaders get
   faders/CV targets without manifest entries.
3. **Shader compile-validation probe** — offscreen compile with structured errors, the
   building block for the subsite's inline error UX.
4. **License/provenance discipline** — per-entry license tags gated for shaders as well as
   models, the policy substrate for upload provenance capture.

## What this issue still owns (NOT covered by the randomize work)

- **Hosting/routing**: the `toybox.patchtogether.live` subdomain on the existing
  Cloudflare Pages/Workers deploy stack; anonymous-visitor experience; how much of the
  web package the subsite reuses vs. a slim standalone shell.
- **Storage**: uploaded assets need durable storage + CDN (R2 or similar) and a metadata
  DB; size quotas (the in-app custom-source cap is 2 MB per shader today) and rate limits.
- **Safety/moderation**: user-submitted GLSL is untrusted code for the GPU — needs a
  sandbox/validation story beyond compile-check (loop-bound/complexity limits, GPU-hang
  mitigation, context-loss recovery), plus content moderation and takedown for uploads.
- **Accounts and identity**: anonymous paste-and-run vs. sign-in to save/publish
  (existing Clerk auth), attribution, and license selection at upload.
- **Gallery/discovery**: browse, search, tags, featured; embed/permalink pages.
- **The app bridge**: "open in patchtogether.live" hand-off format, and an editorial path
  for promoting community assets into the bundled bank.

## Acceptance sketch (to be firmed when scheduled)

- A visitor with no account pastes a Shadertoy-style shader and sees it render within
  seconds, with compile errors readable inline.
- A visitor uploads a small OBJ and sees it shaded/rotating via TOYBOX's material path.
- Annotated uniforms appear as working faders.
- A saved creation has a stable shareable URL and declares its license.
- A signed-in app user opens a sandbox creation as TOYBOX layer content in a rack.
- Malicious/pathological GLSL cannot wedge other users' sessions and degrades gracefully
  for the author.

## Open questions

- Standalone slim build vs. the full web bundle behind a route?
- Which upload kinds at launch (GLSL + OBJ only, or images/matcaps too)? Video explicitly
  out (size/rights).
- Moderation model: pre-publish review, report-driven, or allowlist-first?
- Default license for published creations (CC0 requested at publish?), and whether
  non-commercial licenses are accepted at all.

Supporting context (evidence, not required): `.myrobots/2026-08-13-toybox-randomize-plan.md`,
`.myrobots/2026-08-13-random-preset-prior-art.md`.
