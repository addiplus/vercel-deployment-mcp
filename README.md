# vercel-deployment-mcp

[![CI](https://github.com/addiplus/vercel-deployment-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/addiplus/vercel-deployment-mcp/actions/workflows/ci.yml)

A reference [Model Context Protocol](https://modelcontextprotocol.io) server for
observing Vercel projects and deployments over stdio.

This is a community reference implementation focused on deployment-workflow
patterns. It is not a replacement for Vercel's own MCP offering. Its purpose
is to demonstrate, in a small and readable codebase, how a deployment-focused
MCP server can handle configuration cleanly and behave predictably on
short-lived infrastructure.

One binary serves both MCP protocol eras over stdio, through the SDK's
`serveStdio` helper. A client that opens with the 2025 `initialize`
handshake is served as it was before; a client that opens with the
2026-07-28 exchange is served on that revision. The SDK's
[Protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)
document defines the two eras and what differs between them.

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

Building and testing this repo requires Node 20 or newer, the same floor the
published package declares in `engines` (`>=20`) and the floor set by the
`@modelcontextprotocol/server` 2.0 line. CI runs the build, the suite and the
packed-consumer smoke on Node 20, 22 and 24.

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

### Limits

| Limit | Value |
| --- | --- |
| Longest `search` value | 4096 characters |
| Longest `projectId`, `state`, `idOrName`, `idOrUrl` value | 512 characters |
| Largest accepted protocol frame | 10485760 bytes |
| Highest accepted `VERCEL_MCP_MIN_INTERVAL_MS` | 60000 |
| Most transport reports written to stderr | 100 |

The frame limit counts the message and not the newline that delimits it, so a
message of exactly 10485760 bytes is accepted. Everything before that newline is
the message, a carriage return sitting just in front of it included.

Each of these limits has its own behaviour above the value in the table. An
over-long argument fails input validation: the call comes back as a tool result
carrying `isError: true` whose text reports the validation failure, no Vercel
API request is made, and nothing is written to stderr for it. A frame above the
frame limit is dropped, one line on stderr says so, and the connection keeps
serving; the request inside that frame is never answered, because the id is not
recoverable from a message that was refused before it was parsed, so a client
waiting on that id waits for its own timeout while later requests are answered
normally. An interval above the ceiling is not refused, it is reduced to the
ceiling: the server runs with the reduced value, and one line on stderr says so
the first time it makes a Vercel API request. The same stderr report repeated
back to back is written twice at most, the second time to say that further
identical reports are suppressed. Across the life of one process at most one
hundred reports are written in total; the line that would follow the hundredth
says that further reports are suppressed, and nothing is written after it.

`initialize` and `ping` are answered at any time. `tools/list` and `tools/call`
are answered only once the client has completed the initialization handshake:
an `initialize` request the server can answer, followed by
`notifications/initialized`. Both halves are required, so the notification on
its own completes nothing, and neither does an `initialize` the server rejects.
This applies to a request that claims no protocol revision, which is every
2025-era request. A client that writes both halves and its first call in a
single write is served, rather than being refused for not waiting for the
initialize response. Before the handshake, those two methods are refused with
JSON-RPC error `-32600` and no Vercel API request is made.

A request that claims revision `2026-07-28` in its `params._meta` envelope
carries its own negotiation and is answered without an `initialize`,
`tools/call` included. On that revision the first message a connection ever
sends can be a tool call, and it leaves for the Vercel API carrying the
configured token. What the server checks is the claimed revision, which has to
be one it serves, and that the envelope carries the capabilities that revision
requires; it does not check who sent the request, and nothing in the envelope
could tell it. Read the handshake requirement as protocol order rather than as
a door: this transport has no notion of who the peer is in either era, and a
2025-era caller reaches the same tool by writing the handshake and the call
together in one go, which the suite covers. Give the process a token whose
scope you would give anything that can write to its stdin.

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

First written 2026-07-10 and kept current with the code since; claim 1 was
restated when error text began being redacted once, where it becomes
client-visible. Each claim below is implemented in code and verified by the
test suite where testable (`test/`); design properties cite the implementing
code.

1. **Configured values never appear in an error the server composes.** The
   access token is read
   only from the environment. Error text is shaped, size-bounded, and passed
   through a redaction guard once, where it becomes client-visible text, so
   an upstream API message cannot echo the token or the team id back
   (`src/vercel.ts`); the fixed hint appended after that bound is text this
   server writes and carries nothing to replace. A successful result is a fixed
   projection of the
   upstream body and is not redacted, so a team identifier that the Vercel
   API itself returns inside a deployment URL still appears there. A protocol
   field the client itself sent, such as a claimed protocol revision, is still
   echoed back to that same client in the protocol error that rejects it, even
   when its bytes happen to equal a configured value; the report that failure
   writes to stderr is redacted (`test/stdio-era.test.ts` asserts both halves).
2. **stdout belongs to the protocol.** All diagnostics go to stderr
   (`src/index.ts`), so no log line can leak into a tool response. stderr
   carries a readiness banner and, when the transport reports an out-of-band
   failure, one line per failure within the two bounds the Limits section
   states, a repeated failure written twice at most and one hundred reports
   all a process writes, in the form
   `vercel-deployment-mcp transport error: <message>`: a single line, passed
   through the same redaction as tool errors and cut to its own 400-character
   bound on the message, tighter than the 500-character bound a tool error
   takes (`src/vercel.ts`), never a stack and never the raw error object. The
   bound is on the message, so an ordinary report is 439 characters at its
   widest; the line that says a repeat is suppressed appends its 49-character
   suffix after the bound, which makes 488 the widest line this server writes.
3. **Minimal footprint.** The tools are read-only observations of projects
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
