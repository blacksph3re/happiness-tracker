import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Baked in at build time from the one place the frontend declares it. The
// backend reads the same number out of `pyproject.toml`, and a test holds the
// two files equal — they ship as one image, so a build where they disagreed
// would be a build nobody could name.
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'))

// The production bundle is emitted into the backend so that a single FastAPI
// process (and a single shipped artifact) serves both the API and the frontend.
// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    tailwindcss(),
    svelte(),
    VitePWA({
      // Prompted, never automatic. A worker that swaps itself mid-session is
      // wrong for an app being typed into, and worse for one holding a queue.
      registerType: 'prompt',
      // Ours rather than generated, because a `push` handler cannot be added to
      // a worker Workbox writes. The cost is real and easy to miss in a diff
      // that reads as "add push": the precache manifest, the navigation
      // fallback and the `/api/` denylist stop being configuration and become
      // code in `src/sw.js`.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Daily Tracker',
        short_name: 'Daily Tracker',
        description: 'Answers and tracked time, with or without a connection',
        // Relative, so a build works on whatever host serves it: the domain is
        // deployment's business and never the repository's.
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#191627',
        theme_color: '#191627',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  // Unit tests cover the parts that must agree with the server — the
  // derivations ported for offline use — while Playwright keeps covering the
  // app as a whole. `e2e` is excluded or vitest would collect the specs too.
  test: {
    include: ['src/**/*.test.js'],
    environment: 'node',
  },
  server: {
    // During `pnpm dev` the Svelte dev server proxies API calls to the
    // separately running `uv run fastapi dev` backend.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
