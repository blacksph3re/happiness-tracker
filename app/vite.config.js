import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// The production bundle is emitted into the backend so that a single FastAPI
// process (and a single shipped artifact) serves both the API and the frontend.
// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    svelte(),
    VitePWA({
      // Prompted, never automatic. A worker that swaps itself mid-session is
      // wrong for an app being typed into, and worse for one holding a queue.
      registerType: 'prompt',
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
      workbox: {
        // ECharts is most of this and is not optional weight: the patterns page
        // has to draw with no connection, so the charting library is part of
        // the offline product rather than something to fetch when needed.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Every navigation is the same shell; the router does the rest. Without
        // this a reload on /time/record with no connection is a browser error
        // page rather than the app.
        navigateFallback: 'index.html',
        // The API is never cached. What the app knows offline is in IndexedDB,
        // deliberately, and a stale response pretending to be fresh would be a
        // second source of truth with no way to tell them apart.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
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
