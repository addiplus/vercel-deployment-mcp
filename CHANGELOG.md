# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/addiplus/vercel-deployment-mcp/releases/tag/v0.1.0
