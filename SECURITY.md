# Security Policy

## Supported versions

Only the latest published `0.x` release is supported. Fixes land as a new
0.x release; older releases do not receive backports.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
https://github.com/addiplus/vercel-deployment-mcp/security/advisories/new

Do not open a public issue for a suspected vulnerability.

## Scope

In scope:

- Credential handling and redaction — `VERCEL_TOKEN` / `VERCEL_TEAM_ID`
  leaking into logs, errors, or tool responses.
- stdout protocol purity — anything other than JSON-RPC frames reaching
  stdout.
- The read-only guarantee — any path by which a tool call could mutate a
  Vercel project or deployment rather than only observing it.

Out of scope: vulnerabilities in the Vercel API itself, in the
`@modelcontextprotocol/sdk` dependency, or in the MCP client/host running
this server — report those upstream.

## Response

Best-effort acknowledgement within 7 days. There is no bug bounty.
