import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// The production bundle is emitted into the backend so that a single FastAPI
// process (and a single shipped artifact) serves both the API and the frontend.
// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  server: {
    // During `pnpm dev` the Svelte dev server proxies API calls to the
    // separately running `uv run fastapi dev` backend.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
