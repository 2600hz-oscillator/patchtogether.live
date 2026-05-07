import { testingManifest } from '$lib/docs/testing-manifest';

export const prerender = true;
export const ssr = true;
export const csr = true;

export const load = () => testingManifest;
