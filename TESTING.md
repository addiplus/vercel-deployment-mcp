# Testing

How this server is validated. Everything below is reproducible from a clean clone with
`npm install && npm test` (the test script builds first).

## Test suite

35 tests across three files, run with vitest.

- `test/vercel.test.ts` — the API client. Configuration handling, credential redaction
  (token and team id, at both the request site and the client boundary), error shaping and
  size bounds (upstream messages are cut to 400 chars, client strings to 500), rate-limit
  and auth hints, network failures, the 30-second request timeout, non-JSON error bodies,
  and the hardcoded fallback for non-Error throws.
- `test/tools.test.ts` — the four tools at handler level. Exactly four tools registered;
  every request is a GET with only the documented query parameters and no body; responses
  project a fixed field set (extra upstream fields are dropped); `limit` defaults to 20;
  path segments are percent-encoded; deployment state falls back from `state` to
  `readyState`; configuration is re-read from the environment on every call (two calls with
  different tokens produce different auth headers); concurrent calls stay isolated; error
  results carry `isError: true` with shaped text that never contains configured values.
- `test/stdio-purity.test.ts` — the built server as a black box. Spawns `dist/index.js`,
  runs a real initialize / tools/list / tools/call session over stdio, and asserts every
  stdout line is a JSON-RPC frame, the startup banner goes to stderr, a call without
  configuration fails with guidance naming `VERCEL_TOKEN`, and invalid arguments produce a
  clean validation error rather than a crash.

## Beyond the suite

- Fresh-install check: clean clone, then the README install commands verbatim. The npm
  tarball ships `dist`, `README.md`, and `LICENSE` only.
- MCP Inspector (CLI mode) against the built server: tool listing, a call with a
  deliberately invalid token (shaped HTTP 403, credential never echoed), a call with a
  missing required argument, and a call with no configuration at all.
- End-to-end against the live Vercel API from a real stdio client: all four tools return
  correct live data; diagnostics stay on stderr.
- CI runs build + tests on ubuntu-latest and windows-latest with Node 22 and 24.

## Notes

- The suite uses fake fixture values for credentials; no test needs network access or a
  real token.
- TypeScript 7.0.2 (the native compiler); no lint dependency — build and tests are the
  quality gates.
