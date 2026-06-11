// scripts/webgl-attest-hash.ts
//
// Prints the deterministic WebGL content-hash to stdout (and nothing else, so
// it's shell-substitutable: HASH=$(node --import tsx scripts/webgl-attest-hash.ts)).
//
// `--list` prints the resolved basis file set (one per line) instead — for
// debugging "what's in the hash" and for the coverage guard's drift output.
//
// See scripts/webgl-attest-lib.ts for the basis + algorithm and
// .myrobots/plans/webgl-attestation-semaphore.md for the full design.

import { computeWebglHash, resolveWebglBasis } from './webgl-attest-lib';

if (process.argv.includes('--list')) {
  for (const f of resolveWebglBasis()) process.stdout.write(f + '\n');
} else {
  process.stdout.write(computeWebglHash() + '\n');
}
