import { defineConfig } from 'astro/config';

// Site URL is configured for the GitHub Pages default
// (https://<owner>.github.io/<repo>). When the repo is renamed or moved
// behind a custom domain, update both `site` and `base` accordingly.
export default defineConfig({
  site: 'https://2600hz-oscillator.github.io',
  base: '/patchtogether.live',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
