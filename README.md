# vercel-deployment-mcp

[![CI](https://github.com/addiplus/vercel-deployment-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/addiplus/vercel-deployment-mcp/actions/workflows/ci.yml)

A reference [Model Context Protocol](https://modelcontextprotocol.io) server for
observing Vercel projects and deployments over stdio.

This is a community reference implementation focused on deployment-workflow
patterns — it is not a replacement for Vercel's own MCP offering. Its purpose
is to demonstrate, in a small and readable codebase, how a deployment-focused
MCP server can handle configuration cleanly and behave predictably on
short-lived infrastructure.

## Tools

| Tool | Description |
| --- | --- |
| `list_projects` | List projects visible to the configured account/team (search, limit) |
| `get_project` | Fetch one project by ID or name |
| `list_deployments` | List recent deployments (filter by project, state, limit) |
| `get_deployment` | Fetch one deployment by ID or URL, including current state |

`list_projects` and `list_deployments` each return a single page of up to
`limit` results (default 20, max 100). There is no cursor pagination; narrow
the request with `search`, `projectId`, or `state` to see more specific
results.

## Install

From npm:

```bash
npm install @addiplus/vercel-deployment-mcp
```

Or run it directly without installing:

```bash
npx @addiplus/vercel-deployment-mcp
```

From source:

```bash
git clone https://github.com/addiplus/vercel-deployment-mcp.git
cd vercel-deployment-mcp
npm install
npm run build
npm test
```

Building and testing this repo requires Node 22+ (CI runs 22 and 24); the
published package runs on Node >=18 per `engines`.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `VERCEL_TOKEN` | yes | Vercel access token (create in account settings) |
| `VERCEL_TEAM_ID` | no | Scope requests to a team |
| `VERCEL_MCP_MIN_INTERVAL_MS` | no | Minimum milliseconds between the start of one Vercel API request and the next (default `250`) |
| `VERCEL_MCP_MAX_CONCURRENT` | no | Maximum number of Vercel API requests in flight at once (default `4`) |

On an HTTP 429 with a numeric `Retry-After` header of 10 seconds or less, the
server waits that long and retries the request once; any other 429 is
surfaced as an error on the first attempt.

Example client configuration (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "vercel-deployment": {
      "command": "npx",
      "args": ["-y", "@addiplus/vercel-deployment-mcp"],
      "env": { "VERCEL_TOKEN": "…" }
    }
  }
}
```

When running from a source checkout, use `"command": "node"` with
`"args": ["/path/to/vercel-deployment-mcp/dist/index.js"]` instead.

## Design principles

Dated 2026-07-10. Each claim below is implemented in code and verified by the
test suite where testable (`test/`); design properties cite the implementing
code.

1. **Configuration values never appear in output.** The access token is read
   only from the environment. Error messages are shaped, size-bounded, and
   passed through a redaction guard so upstream API messages cannot echo the
   value back (`src/vercel.ts`).
2. **stdout belongs to the protocol.** All diagnostics go to stderr
   (`src/index.ts`), so no log line can leak into a tool response.
3. **Minimal footprint.** v0.1 tools are read-only observations of projects
   and deployments; the server requests nothing beyond what those reads need.
4. **Stateless by design.** Configuration is re-read from the environment on
   every tool call (verified in `test/tools.test.ts`), so behavior is
   identical on long-lived hosts and short-lived workers. The one piece of
   module-level state is a request throttle (`src/vercel.ts`) that spaces out
   and caps concurrent Vercel API calls; its interval and concurrency
   settings are read once at first use, and it holds no credentials or
   response data.

## Roadmap

- Deployment actions with an explicit out-of-band approval step (exploring the
  patterns discussed in MCP spec issues #2919/#2920 around multi-round tool
  results on stateless transports).
- Standardizing how `server.json` describes stdio package install manifests
  and how clients convert them into local configuration files (spec issue
  #2963, registry issue #749).

## License

MIT
