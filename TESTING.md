# Testing

How this server is validated. Everything below is reproducible from a clean clone with
`npm install && npm test` (the test script builds first).

## Test suite

Eight files, run with vitest.

- `test/vercel.test.ts`: the API client. Configuration handling, credential redaction
  (token and team id, applied once where an error becomes client-visible text, including an
  upstream message long enough that a configured value straddles the cut), error shaping and
  the single 500-char bound on client-visible error text, which is applied to the shaped
  message before the fixed hint is appended so a long upstream message cannot push the hint
  out, alongside the tighter 400-character bound a transport diagnostic's message takes,
  rate-limit and auth hints,
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
  argument comes back as a tool result and not as a JSON-RPC error frame: no top-level
  `error` member, `isError: true`, and text that reports an argument validation failure
  and names the missing field `idOrName`; every stdout line is a JSON-RPC frame; and no
  tool-call response frame (the successful calls and the 403 error) contains the configured
  token or team id. The stderr contract is asserted exactly, not by substring: on a 2025-era
  session the server's entire stderr output is the single line
  `vercel-deployment-mcp ready (stdio)`, so a diagnostic that appears on a path that should
  be quiet fails the test rather than passing unnoticed.
  The session is opened as a 2025-06-18 client, which is the era `serveStdio` pins for
  any opening `initialize`.
- `test/stdio-era.test.ts`: the same built server as a black box on the other protocol
  era. Spawns `dist/index.js` with no fetch stub (nothing here reaches the network) and
  drives hand-written frames that carry a `params._meta` envelope claiming protocol
  revision `2026-07-28`, except the bare 2025 `initialize` sent to prove the refusal; no
  client library is involved. Asserts: `server/discover` is answered rather than refused,
  and reports `supportedVersions` of exactly `["2026-07-28"]`, the tool capability,
  `resultType: "complete"`, and the server identity under
  `_meta["io.modelcontextprotocol/serverInfo"]`; `tools/list` on that era returns the
  same four tools, each with an `outputSchema`, and pins the connection to it; a 2025
  `initialize` sent on the pinned connection is then refused with `-32022` carrying
  `data.supported` of `["2026-07-28"]`, which is the frame the pre-`serveStdio` wiring
  could not produce; every stdout line is a JSON-RPC frame; and the startup banner goes to
  stderr and never to stdout. stderr is asserted exactly here too, and in this test it is
  two lines: the banner, then one transport-error line reporting the refusal the server
  just sent, in the form `vercel-deployment-mcp transport error: <message>`. Two lines are a
  property of that provoked refusal and not of the era: a 2026-07-28 session that provokes
  nothing gets the banner and nothing else. That line is one line, never a stack, its message capped
  at 400 characters (the line is that plus its 39-character prefix), and passed through the same credential redaction the API client uses,
  which a second case in the file proves by claiming the configured token as a protocol
  revision and asserting the reporter writes `[redacted]`.
- `test/suite/`: four lenses on the same built server, all hand-written frames, no client
  library. `protocol.test.ts` pins protocol conformance on both eras, that the era is
  decided per connection, and the transport and handshake boundary: a claim-less tool
  request sent before the initialization handshake completes is refused with JSON-RPC
  `-32600` and no upstream request is made for it, while a request claiming revision
  `2026-07-28` is answered without any handshake at all; a `tools/call` carrying that
  claim as the connection's first and only frame is served, with one upstream request
  made for it carrying the configured token, while the same first-frame call claiming a
  revision the server does not serve is refused with none; `ping` is answered throughout and
  the same calls succeed once the handshake is done; a tool request whose only predecessor
  is an `initialized` notification that no `initialize` request came before is refused the same
  way, with no upstream request, and the handshake still completes normally afterwards; a
  tool request whose handshake rests on an `initialize` the server rejected is refused the
  same way, so only a request the server can answer counts as the first half; a request
  written in the same chunk as the notification of a real handshake is served rather than
  refused, and so is a call written in the same chunk as the whole handshake, `initialize`
  request included, with each response carrying its own request's id and the handshake
  answered first; closing the host's read end of stdout produces one transport error line
  on stderr and exit status 0, with no Node stack and no installation paths; one 128 MB
  frame with no newline in it, written no faster than the server takes it in, is dropped
  with exactly one stderr line naming the 10485760-byte limit, and the request after the
  newline that ends that frame is answered normally, which is what ties the limit to the
  stream the transport reads rather than to the stderr line alone; a message of exactly
  10485760 bytes, the newline that ends its frame not counted, is answered with nothing
  written to stderr while the same message one byte longer is dropped and the request after
  it is still answered, which pins the limit to the message rather than to the message plus
  its delimiter; three oversized frames in a row produce two lines rather than three, the
  second saying that further identical reports are suppressed; and five hundred malformed
  frames of alternating shape produce one hundred and one lines, the last of which says
  that further reports are suppressed.
  `contracts.test.ts` pins what the published input and output
  schemas promise and whether the structured content keeps that promise; `upstream.test.ts`
  pins upstream failure modes and credential safety; `invariants.test.ts` pins what must
  not drift between calls, between connections, between a payload and its own
  serialization, and between the source, the package manifest and the built artifact.

## Beyond the suite

- Fresh-install check: clean clone, then the README install commands verbatim. The npm
  tarball ships `dist`, `README.md`, and `LICENSE` only.
- MCP Inspector (CLI mode) against the built server: tool listing, a call with a
  deliberately invalid token (shaped HTTP 403, credential never echoed), a call with a
  missing required argument, and a call with no configuration at all.
- End-to-end against the live Vercel API from a real stdio client: all four tools return
  correct live data; diagnostics stay on stderr.
- Memory check, run by hand rather than in the suite because only the reading is not
  portable; the effect of the limit on what the transport receives is in the suite:
  write 256 MB to stdin with no newline and watch resident memory rise over the first
  hundred megabytes or so and then stop, well short of tracking the input, while one line on
  stderr reports the dropped frame. A sample run here went from 85 MB before the write to
  160 MB after 200 MB of input, with the last 60 MB of input adding 2 MB.
- CI runs build + tests on ubuntu-latest and windows-latest with Node 20, 22 and 24, and
  the packed-consumer smoke on ubuntu-latest with the same three versions. Node 20 is the
  floor `engines.node` declares, so the declared floor is a tested one.

## Notes

- The suite uses fake fixture values for credentials; no test needs network access or a
  real token.
- Throttle and 429-retry tests use an injected fake clock and sleep, never a real-time
  wait, so the suite stays fast regardless of the configured interval.
- TypeScript 7.0.2 (the native compiler); no lint dependency, so build and tests are the
  quality gates.
