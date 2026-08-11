/**
 * Generates a typed client from the backend's own OpenAPI document, so the
 * frontend cannot drift from the API by hand-copying paths and field names.
 * Regenerate with `pnpm api:generate` after changing an endpoint.
 */
export default {
  input: './openapi.json',
  output: { path: './src/lib/generated', format: false, lint: false },
  plugins: ['@hey-api/client-fetch', '@hey-api/sdk', '@hey-api/typescript'],
}
