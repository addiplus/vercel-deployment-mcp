# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

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

- A protocol frame larger than 10485760 bytes is dropped, one line on
  stderr says so, and the connection keeps serving. There was no limit at
  all before, so a peer that never sent a newline grew the process without
  bound and stalled its own next request.

- A transport failure repeated back to back is written to stderr twice at
  most: once for the failure, and once to say that further identical
  reports are suppressed. A peer decides how often a transport failure
  happens, so without this it decided how many lines this process wrote to
  the host log.

### Fixed

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
