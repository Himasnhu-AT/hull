// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Set `site` to the production URL before deploying: canonical, OG and sitemap depend on it.
// Placeholder until the public name and domain are decided (see src/data/site.ts).
export default defineConfig({
  site: 'https://hull.marl.studio',
  integrations: [sitemap()],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'auto' },
  image: { responsiveStyles: false },
});
