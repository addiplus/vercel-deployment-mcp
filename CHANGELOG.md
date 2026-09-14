# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Transport-level errors are now reported on stderr as one redacted line.
  `serveStdio` surfaces out-of-band failures through an optional `onerror`
  callback; the server now supplies one, which writes
  `vercel-deployment-mcp transport error: <message>`: a single line with
  whitespace collapsed, the configured token and team id replaced with
  `[redacted]`, the message cut to 400 characters (so the line is at most
  that plus its 39-character prefix), and never a stack or the error
  object. Commit `6b0b39e`, which moved stdio onto `serveStdio`, recorded
  this silence as a known gap in its own message; this closes it. stdout is
  unchanged, and the stderr contract's two files, `test/stdio-purity.test.ts`
  and `test/stdio-era.test.ts`, now assert the whole of stderr rather than a
  substring, so a diagnostic appearing on a quiet path fails the suite.
- CI now covers Node 20 as well as 22 and 24 in both matrices: the test job
  runs the build and the suite, the packed-consumer job runs the build and
  the packed-consumer smoke. `engines.node` has said
  `>=20` since the 2.0 SDK line landed; until now nothing exercised the
  floor it declares, so the floor was a claim rather than a result.

### Changed

- **Breaking:** `engines.node` moves from `>=18` to `>=20`. The
  `@modelcontextprotocol/server` 2.0 line requires Node 20, so the
  published package no longer installs cleanly on Node 18. Consumers
  still on Node 18 must upgrade Node or stay on 0.2.0.
- The server is built against the `@modelcontextprotocol` 2.0 SDK line.
  `@modelcontextprotocol/server` (root barrel plus the `/stdio` subpath)
  replaces `@modelcontextprotocol/sdk` for `McpServer` and
  `ToolAnnotations`. Five consequences are visible on the wire. Tool
  schemas are emitted under JSON Schema 2020-12 rather than draft-07. A
  call with invalid arguments still comes back as a tool result
  with `isError: true`, but its text no longer carries
  `MCP error -32602:`; a client that matched `-32602` in that text must
  match the validation message or the field name instead. A call naming
  a tool that does not exist comes back as a JSON-RPC error frame with
  code `-32602` rather than as a tool result with `isError: true`, so a
  client that read the miss out of the result's text now reads it off
  the error member. A call whose `arguments` member is present but is
  not a JSON object, an array or `null` say, comes back with code
  `-32602` and a message opening `Invalid tools/call request:`, where
  the 1.x line answered the same call with `-32603` and no prefix, so a
  client that branched on the internal-error code now sees an
  invalid-params one. And a tool entry in a `tools/list` result no longer
  carries an `execution` member: the 1.x SDK added one saying
  `taskSupport: "forbidden"` to every tool, which this server never set
  and this SDK line does not emit, so a client reading that member was
  reading the SDK rather than the server and now finds nothing there.
- stdio is now served through the SDK's `serveStdio` helper, so one
  binary serves both protocol eras from one tool registration. A client
  that claims protocol revision `2026-07-28` in a per-request `_meta`
  envelope is served that revision: `server/discover` is answered with
  `supportedVersions: ["2026-07-28"]`, results carry `resultType` and an
  `io.modelcontextprotocol/serverInfo` stamp, and once the connection is
  pinned to that era a 2025 `initialize` on it is refused with `-32022`
  rather than answered. A client that opens with `initialize`, which is
  every 2025-era client, still negotiates the revision it requests and
  receives the same frames it received before stdio moved to `serveStdio`; that is the
  helper's `legacy: 'serve'` default, and nothing in this release
  overrides it.
- `@modelcontextprotocol/sdk` 1.x stays in `devDependencies` only. The
  packed-consumer smoke test drives this server with a v1 client, which
  is the backward-compatibility proof.
- `@modelcontextprotocol/core` is no longer a direct dependency. It is
  still installed, as an exact-pinned dependency of
  `@modelcontextprotocol/server` 2.0.0.

- `tools/list` and `tools/call` are answered only after the client has
  completed the initialization handshake: an `initialize` request the
  server can answer, followed by `notifications/initialized`. Both halves
  are required, and a notification that arrives before any `initialize`
  request, or after one the server rejects, ends nothing, so it does not
  make a following tool request answerable. A client that
  writes both halves and its first call in a single write is served: the
  handshake is counted as its frames go past, so the client does not have
  to wait for the initialize response before sending anything else. A tool
  request that arrives before the handshake is complete is refused with
  JSON-RPC error `-32600`, and no Vercel API request is made for it.
  `initialize` and `ping` are answered at any time, as before. Previously a
  tool request sent before the handshake was served, and the request left
  for the Vercel API carrying the configured token.

- String tool arguments now declare a maximum length: 4096 characters for
  `search`, and 512 characters for `projectId`, `state`, `idOrName` and
  `idOrUrl`. The published input schemas carry the bound, so an over-long
  value is refused as invalid input instead of being composed into an
  outbound URL.

- A protocol frame whose message is larger than 10485760 bytes is
  dropped, one line on stderr says so, and the connection keeps serving.
  The count is of the message itself, so the newline that ends the frame
  is not part of it and a message of exactly that size is served. There
  was no limit at all before, so a peer that never sent a newline grew
  the process without bound and stalled its own next request.

- A transport failure repeated back to back is written to stderr twice at
  most: once for the failure, and once to say that further identical
  reports are suppressed. A peer decides how often a transport failure
  happens, so without this it decided how many lines this process wrote to
  the host log.

- The handshake requirement applies only to a request that claims no
  protocol revision. A request that claims revision `2026-07-28` in its
  `params._meta` envelope carries its own negotiation, so it is answered
  without an `initialize` and the 2026-07-28 era is unchanged. That
  includes `tools/call`: on that revision the first message a connection
  sends can be a tool call, and it leaves for the Vercel API carrying the
  configured token. The server checks that the claimed revision is one it
  serves and that the envelope carries the capabilities that revision
  requires; it does not check who sent the request, and neither era does.
  Writing to this server's stdin is what reaches its tools, on the 2025
  era in three frames of a single write and on this one in one frame.
  `initialize` and `ping` are answered at any time, as before.

- Documentation: `README.md` records the bound on how many transport
  reports one process writes, states that the handshake requirement
  applies only to a request claiming no protocol revision, and describes
  an over-long argument the way this line answers it, as a tool result
  carrying `isError: true` rather than as a JSON-RPC `-32602` frame. Its
  design principles carry the two bounds on a
  transport report inside the claim that states it, and name the one
  error text that carries a value the client itself sent: the frame
  refusing a claimed protocol revision echoes that claim back to its
  sender, while the report of it on stderr is redacted.
  `TESTING.md` counts the eight test files of this line and describes the
  transport and handshake cases.

### Fixed

- `initialize` reported `serverInfo.version` as `0.1.0` while the package
  was already `0.2.0`, so the handshake under-reported the server across a
  breaking result-shape change. The version in `src/index.ts` now matches
  `package.json`, and `test/stdio-purity.test.ts` asserts that parity
  against `package.json` on every run.

- A closed stdout no longer crashes the server. The write error is
  reported as one line on stderr and the process exits with status 0,
  instead of an unhandled error event, status 1, and a stack carrying
  installation paths.

- `get_project` and `get_deployment` refuse an identifier made only of
  dots. `.` or `..` was accepted and the URL parser then removed the
  segment, so the request went to a different endpoint while the result's
  receipt still reported the documented one.

- `VERCEL_MCP_MIN_INTERVAL_MS` is capped at 60000. A larger value was
  accepted as written, which spaced requests so far apart that the server
  answered one tool call and then never answered another, while `ping` and
  `tools/list` kept reporting it healthy and nothing was written to
  stderr. A value above the cap is now reduced to it, and one line on
  stderr says so.

- A timestamp the server cannot read no longer fails the whole page. An
  unreadable `updatedAt` or `createdAt` is omitted from that one item and
  the rest of the page is returned, where the whole call previously ended
  as an error. A timestamp of 0 is now reported as the epoch rather than
  dropped as missing.

- An `updatedAt` or `createdAt` given as a number is read as milliseconds
  since the epoch, and a number that reads as a date before the year 2000
  is omitted rather than reported. A seconds-resolution number such as
  1700000000 previously came back as a date in January 1970, stated as
  confidently as a correct one; the field is now absent instead, which the
  published output schema already allows. Zero still reports the epoch,
  the one value both readings agree on, and a date delivered as text is
  unaffected.

- A message above the frame limit no longer ends the process. It is dropped
  before it reaches the transport, one line on stderr says so, and the
  connection keeps answering; previously the transport's read buffer refused
  the message, closed the connection, and the process left with status 0,
  which reads to a supervisor as an intentional shutdown. The transport's own
  buffer limit is set to the stated message limit plus the one byte its
  delimiter takes, so the two agree and a message of exactly the stated size
  is served. A transport close that still happens while stdin is open leaves
  status 70 behind rather than 0, which covers a close the message limit does
  not prevent. With that limit in place a peer cannot provoke one, since the
  reader hands the transport no more than its buffer holds, so an ordinary
  session still ends with status 0 and no case in the suite reaches 70. A
  dropped message is not answered on the protocol channel: the id inside it
  is not recoverable from a message refused before it was parsed, so a client
  waiting on that id waits for its own timeout while every later request is
  answered as usual.

- There is now a bound on how many lines a transport failure can write to
  stderr. A report repeated back to back is written twice at most, as
  before, and at most one hundred reports are written in total, after which
  one line says that further reports are suppressed and nothing more is
  written. A peer that varied its malformed input could otherwise write one
  line per message with no bound, on the channel the reporter exists to
  write to.

### Security

- Redaction of the configured token and team id in error text replaced
  the values one at a time. When the configured token was contained in
  the configured team id, the token was replaced first and the remainder
  of the team id survived in a tool result error message. The same
  happened when the two values overlapped each other partially, or when
  a value overlapped itself; a team id contained in the token was
  removed whole. Every occurrence of every configured value is now
  located in the original text, overlapping occurrences are joined, one
  marker replaces each joined range, and the replacement text is never
  rescanned within a call. This applied to every release so far.

- Error text is now redacted once, where it becomes client-visible text,
  rather than once when the upstream message is read and again when the
  tool result is composed. Redacting twice rewrote the marker itself
  whenever a configured value was a substring of the word inside it, so a
  tool result could show a marker that had been cut apart. Redaction also
  runs before the 500-character bound is applied, so a configured value
  that straddles the cut can no longer leave its first characters behind.

- A long upstream message no longer pushes the credential or rate-limit
  hint out of the error a client sees. The 500-character bound is applied
  to the shaped message first and the hint is appended after it, so the
  cut can no longer land inside the hint or remove it. This also names a
  change that came with redacting once at the boundary: the separate
  400-character cut that used to shorten an upstream message before the
  two were composed is gone, so more of a long upstream message now
  appears inside the same 500-character result.

- Documentation: the credential statement in `README.md` now says the
  guarantee covers the error text the server composes, and that a
  successful result is a fixed projection of the upstream body that is not
  redacted, so a team identifier the Vercel API itself returns inside a
  deployment URL still appears there. `TESTING.md` describes the single
  redaction point and the single bound.

## [0.2.0] - 2026-07-10

### Changed

- **Breaking:** tool results are now structured. Every tool declares an
  `outputSchema` and returns `structuredContent` alongside the JSON text
  content, and list results changed shape from `{count, projects|deployments}`
  to `{pageCount, items, receipt}`, where `receipt` reports the request's
  `scopeKind`, `appliedFilters`, and `endpointProfile`. Clients parsing the
  previous text shape must update, hence 0.2.0 rather than 0.1.1.
- Blank strings are no longer accepted for the optional `search`, `projectId`,
  and `state` inputs (`.min(1)`). Previously a blank string was silently
  treated as "filter not applied", widening the result scope.

### Added

- Read-only tool annotations (`readOnlyHint`, `destructiveHint: false`,
  `idempotentHint`, `openWorldHint`) on all four tools.
- Politeness throttle on Vercel API calls: a minimum start-to-start interval
  and a concurrency cap, configurable via `VERCEL_MCP_MIN_INTERVAL_MS`
  (default 250) and `VERCEL_MCP_MAX_CONCURRENT` (default 4); invalid values
  fall back to the defaults.
- HTTP 429 responses with a numeric `Retry-After` of 10 seconds or less are
  retried exactly once after waiting; all other 429s surface immediately.
- Minimal response-shape validation on 2xx bodies before casting, so a
  malformed upstream response surfaces as a shaped
  `unexpected_response_shape` error instead of an unhandled exception.
- `SECURITY.md` with private reporting via GitHub Security Advisories.
- Test suite grown from 35 to 64 tests; throttle and retry tests run on an
  injected fake clock (no real-time waits).
- Documentation: single-page listing scope for the list tools, throttle
  configuration, contributor Node 22+ note, and a refreshed `TESTING.md`
  that matches the current test files.

## [0.1.0] - 2026-07-09

Initial release.

### Added

- Four read-only observation tools over stdio: `list_projects`, `get_project`,
  `list_deployments`, `get_deployment`.
- Configuration read from environment only (`VERCEL_TOKEN`, optional
  `VERCEL_TEAM_ID`); no credential is ever included in a tool response.
- Redaction guard on upstream error messages so the access token cannot be
  echoed back through the Vercel API response path.
- Bounded, size-limited error messages for all tool failures.
- 30 second request timeout on all Vercel API calls.
- Stateless request handling: configuration is re-read from the environment
  on every call, with no module-level mutable state.
- stdio purity: all diagnostics go to stderr, keeping stdout reserved for
  protocol messages.
- Test suite covering the above (35 tests), run on Linux and Windows against
  Node 22 and 24 in CI.

[Unreleased]: https://github.com/addiplus/vercel-deployment-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/addiplus/vercel-deployment-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/addiplus/vercel-deployment-mcp/releases/tag/v0.1.0
