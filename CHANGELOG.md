# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** `engines.node` moves from `>=18` to `>=20`. The
  `@modelcontextprotocol/server` 2.0 line requires Node 20, so the
  published package no longer installs cleanly on Node 18. Consumers
  still on Node 18 must upgrade Node or stay on 0.2.0.
- The server is built against the `@modelcontextprotocol` 2.0 SDK line.
  `@modelcontextprotocol/server` (root barrel plus the `/stdio` subpath)
  replaces `@modelcontextprotocol/sdk` for `McpServer`,
  `ToolAnnotations`, and `StdioServerTransport`. Two consequences are
  visible on the wire: tool schemas are emitted under JSON Schema
  2020-12 rather than draft-07, and a call with invalid arguments comes
  back as a tool result with `isError: true` instead of a JSON-RPC
  `-32602` error frame. A client that matched on the `-32602` code must
  read the tool result instead.
- `@modelcontextprotocol/sdk` 1.x stays in `devDependencies` only. The
  packed-consumer smoke test drives this server with a v1 client, which
  is the backward-compatibility proof.
- `@modelcontextprotocol/core` is no longer a direct dependency. It is
  still installed, as an exact-pinned dependency of
  `@modelcontextprotocol/server` 2.0.0.

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
