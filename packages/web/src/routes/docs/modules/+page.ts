import { moduleManifest } from '$lib/docs/modules-manifest';

export const prerender = true;
export const ssr = true;
export const csr = true;

export const load = () => ({
  manifest: moduleManifest,
});
