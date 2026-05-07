// packages/web/src/lib/docs/types.ts
//
// Shape of the module manifest emitted by scripts/build-module-manifest.mjs.
// Imported by lib/docs/modules-manifest.ts (auto-generated) and the /docs
// route loaders.

export type CableType = 'audio' | 'cv' | 'pitch' | 'gate' | 'polyPitchGate';

export interface ManifestPort {
  id: string;
  type: CableType | string;
  paramTarget?: string;
  note?: string;
}

export interface ManifestParam {
  id: string;
  label: string;
  defaultValue: number | null;
  min: number | null;
  max: number | null;
  curve: string;
  units?: string;
}

export interface ManifestModule {
  type: string;
  label: string;
  category: string;
  description: string;
  schemaVersion?: number;
  maxInstances?: number;
  inputs: ManifestPort[];
  outputs: ManifestPort[];
  params: ManifestParam[];
  file: string;
  sourceUrl: string;
}

export interface ModuleManifest {
  moduleCount: number;
  categories: readonly string[];
  modules: readonly ManifestModule[];
  warnings: readonly string[];
}

export interface ScenarioRef {
  group: string;
  file: string;
  path: string;
}

export interface TestingManifest {
  artScenarios: readonly ScenarioRef[];
  artBaselines: readonly ScenarioRef[];
  vrtImplemented: boolean;
  e2eSpecs: readonly string[];
}
