# Testing

How this server is validated. Everything below is reproducible from a clean clone with
`npm install && npm test` (the test script builds first).

## Test suite

Four files, run with vitest.

- `test/vercel.test.ts`: the API client. Configuration handling, credential redaction
  (token and team id, applied once where an error becomes client-visible text, including an
  upstream message long enough that a configured value straddles the cut), error shaping and
  the single 500-char bound on client-visible error text, which is applied to the shaped
  message before the fixed hint is appended so a long upstream message cannot push the hint
  out, rate-limit and auth hints,
  network failures, the 30-second request timeout, non-JSON error bodies,
  the hardcoded fallback for non-Error throws, the request throttle (minimum start-to-start
  spacing and the concurrency cap, both driven by an injected fake clock/sleep, no
  real-time waits), `resolveThrottleOptions` env parsing (defaults of 250ms / 4, a
  non-numeric or negative value falling back to the default, `minIntervalMs: 0` disabling
  spacing, `maxConcurrent` flooring at 1, a configured interval above the 60000 ms ceiling
  being reduced to it with one line on stderr while a value at the ceiling passes
  silently), and the HTTP 429 retry rule: a numeric
  `Retry-After` of 10 seconds or less waits that long (through the injected sleep) and
  retries exactly once, while an absent, non-numeric, or over-10 `Retry-After` does not
  retry and surfaces the 429 as-is; a retried request still redacts credentials from
  whatever error it eventually surfaces.
- `test/tools.test.ts`: the four tools at handler level. Exactly four tools registered;
  every request is a GET with only the documented query parameters and no body; responses
  project a fixed field set (extra upstream fields are dropped); `limit` defaults to 20;
  path segments are percent-encoded; deployment state falls back from `state` to
  `readyState`; configuration is re-read from the environment on every call (two calls with
  different tokens produce different auth headers); concurrent calls stay isolated; error
  results carry `isError: true` with shaped text that never contains configured values;
  `list_projects.search`, `list_deployments.projectId`, and `list_deployments.state` are
  declared non-empty (`.min(1)`), so a blank string fails at the input-schema boundary
  instead of silently widening to an unfiltered list (asserted by parsing against each
  tool's captured input schema),
  while a non-empty value still produces the matching `receipt.appliedFilters`;
  string arguments are bounded above as well (`search` at 4096 characters, `projectId`,
  `state`, `idOrName` and `idOrUrl` at 512, with the bound published in the input schema);
  an identifier made only of dots is refused, and every accepted identifier leaves exactly
  one path segment under the tool's endpoint; an unreadable timestamp is omitted from that
  one item instead of failing the page, a timestamp of 0 is reported as the epoch, a numeric
  timestamp that reads as a date before the year 2000 (a seconds-resolution value, say) is
  omitted rather than reported while a date delivered as text from before that point is still
  read; and
  a 2xx body where `data.projects` or `data.deployments` is present but not an array is
  rejected before it reaches the response mapping, as `isError: true`.
- `test/stdio-purity.test.ts`: the built server as a black box. Spawns `dist/index.js`
  with a stubbed global `fetch` (rejecting any request outside `https://api.vercel.com` or
  with a body or a non-GET method) and runs a real initialize / tools/list / tools/call
  session over stdio. Asserts: exactly the four documented tools are listed, each with the
  read-only annotation set and an `outputSchema` that is valid JSON Schema, is an object
  with `additionalProperties: false`, and has `required` matching `properties` exactly; a
  successful call's `structuredContent` matches the projected fields, round-trips through
  the text content, validates against its own `outputSchema`, and fails validation if
  `receipt.appliedFilters` is tampered into a combination the schema doesn't allow; the
  list tools' structured output has no `hasMore` or `nextCursor` property; an upstream 403
  comes back as `isError: true` with no `structuredContent`; a call missing a required
  argument produces a JSON-RPC `-32602` invalid-params result, whether the SDK returns it
  as a top-level error or a shaped tool error; every stdout line is a JSON-RPC frame; the
  startup banner goes to stderr and never to stdout; and no tool-call response frame (the
  successful calls and the 403 error) contains the configured token or team id.
- `test/suite/protocol.test.ts`: the built server as a black box, at the transport and
  handshake boundary. A tool request sent before the initialization handshake completes is
  refused with JSON-RPC `-32600` and no upstream request is made for it, while `ping` is
  answered throughout and the same calls succeed once the handshake is done; a tool request
  whose only predecessor is an `initialized` notification that no `initialize` request came
  before is refused the same way, with no upstream request, and the handshake still completes
  normally afterwards; a request written in the same chunk as the notification of a real
  handshake is served rather than refused; closing the
  host's read end of stdout produces one transport error line on stderr and exit status 0,
  with no Node stack and no installation paths; a frame above the 10485760-byte limit is
  dropped with exactly one stderr line naming the limit, and the next request is answered
  normally.

## Beyond the suite

- Fresh-install check: clean clone, then the README install commands verbatim. The npm
  tarball ships `dist`, `README.md`, and `LICENSE` only.
- MCP Inspector (CLI mode) against the built server: tool listing, a call with a
  deliberately invalid token (shaped HTTP 403, credential never echoed), a call with a
  missing required argument, and a call with no configuration at all.
- End-to-end against the live Vercel API from a real stdio client: all four tools return
  correct live data; diagnostics stay on stderr.
- Memory check, run by hand rather than in the suite because the reading is not portable:
  write 256 MB to stdin with no newline and watch resident memory stay flat while one line
  on stderr reports the dropped frame.
- CI runs build + tests on ubuntu-latest and windows-latest with Node 22 and 24.

## Notes

- The suite uses fake fixture values for credentials; no test needs network access or a
  real token.
- Throttle and 429-retry tests use an injected fake clock and sleep, never a real-time
  wait, so the suite stays fast regardless of the configured interval.
- TypeScript 7.0.2 (the native compiler); no lint dependency, so build and tests are the
  quality gates.
