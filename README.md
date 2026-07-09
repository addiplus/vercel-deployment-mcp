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

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `VERCEL_TOKEN` | yes | Vercel access token (create in account settings) |
| `VERCEL_TEAM_ID` | no | Scope requests to a team |

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

Dated 2026-07-08. Each claim below is implemented in code and verified by the
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
4. **Stateless by design.** There is no module-level mutable state
   (`src/tools.ts`, `src/vercel.ts`), and configuration is re-read from the
   environment on every tool call (verified in `test/tools.test.ts`), so
   behavior is identical on long-lived hosts and short-lived workers.

## Roadmap

- Deployment actions with an explicit out-of-band approval step (exploring the
  patterns discussed in MCP spec issues #2919/#2920 around multi-round tool
  results on stateless transports).
- Standardizing how `server.json` describes stdio package install manifests
  and how clients convert them into local configuration files (spec issue
  #2963, registry issue #749).

## License

MIT
