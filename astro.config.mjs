// @ts-check
import { defineConfig } from 'astro/config';

const configuredBase = process.env.PUBLIC_BASE_PATH || '/';
const base =
  configuredBase === '/' || configuredBase.endsWith('/')
    ? configuredBase
    : `${configuredBase}/`;
const site = process.env.SITE_URL || 'https://example.github.io';

export default defineConfig({
  output: 'static',
  site,
  base,
  build: {
    format: 'directory',
  },
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
});
