// Shared domain / cable colour language — the MOCKUP hues (owner decision).
//
// Cables are the patch language: their hues stay CONSTANT across every
// palette so muscle memory + the cable legend read the same regardless of
// which surface palette is active. A palette swaps surfaces / ink / accent,
// not the cable language. (A future palette MAY override an individual cable
// token, but the curated set ships them identical.)
//
// The 5 PRIMARY domain hues come straight from ux-proposal-b.html:13-18:
//   audio → teal · cv → green · gate → amber · video → violet · poly → pink
// The 4 SECONDARY cable types are tints of their parent domain so per-type
// reading survives inside a domain.

export const CABLE_VARS = {
  '--cable-audio': '#38d3c8', // audio    — teal        (domain primary)
  '--cable-pitch': '#9be08a', // pitch    — light green (cv domain)
  '--cable-gate': '#f2c14e', // gate     — amber       (domain primary)
  '--cable-cv': '#7bd66a', // cv       — green       (domain primary)
  '--cable-polyPitchGate': '#ff7bc2', // poly     — pink        (domain primary)
  '--cable-keys': '#ff9dd4', // keys     — light pink  (poly domain)
  '--cable-image': '#c99bff', // image    — light violet(video domain)
  '--cable-mono-video': '#a56bf0', // m-video  — deep violet (video domain)
  '--cable-video': '#b57bff', // video    — violet      (domain primary)
} as const;
