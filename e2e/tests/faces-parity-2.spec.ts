// e2e/tests/faces-parity-2.spec.ts
//
// PARTITION 2 OF 4 of the registry-driven face parity sweep.
//
// ⚠ THERE IS NOTHING MODULE-SPECIFIC IN THIS FILE AND THERE MUST NOT BE. It
// declares WHICH partition it runs and nothing else; the set is derived from
// `STRICT_FACES` by a stable hash of each module's own name
// (`support/faces-parity-suite.ts`), so a newly promoted face joins exactly one
// partition with no file to edit and no list to forget.
//
// The split's whole argument — why the sweep could not stay one file, why the
// partition is by name-hash rather than by domain or index, and how N was
// derived from measured cost — lives in the suite module beside the code that
// implements it, so it cannot drift from 4 copies of a comment.
//
// ⚠ DO NOT add a test here. A one-off belongs in `faces-parity.spec.ts`, which
// calls `registerFacesParityOneOffs()`; anything added here would run ONCE for
// this partition and silently not at all for the others.

import { registerFacesParityTests } from './support/faces-parity-suite';

registerFacesParityTests(1);
