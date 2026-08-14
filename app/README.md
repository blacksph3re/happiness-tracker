# Daily Tracker frontend

Svelte 5 SPA built with Vite, styled with Tailwind CSS v4 + Flowbite, managed with
`pnpm`.

```bash
pnpm install
pnpm dev     # dev server on :5173, proxies /api and /health to the backend on :8000
pnpm build   # emits the bundle into ../backend/static, where FastAPI serves it
```

In development, run the backend alongside it with `uv run fastapi dev` from `backend/`.
In production only the backend runs: it serves the API and the built SPA from one
process.
