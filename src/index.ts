#!/usr/bin/env node
/**
 * vercel-deployment-mcp: reference MCP server (stdio).
 *
 * Stateless by design: no session data is held between requests, so the
 * server behaves identically on long-lived hosts and short-lived workers.
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 *
 * serveStdio owns the transport and the era decision. It calls buildServer
 * once per connection (and once more for a discarded server/discover probe),
 * so every instance registers its own tools. The legacy option is left at its
 * default of 'serve', which keeps 2025-era clients on the same wire bytes they
 * saw before this change.
 *
 * serveStdio reports every out-of-band error through options.onerror: a send
 * failure, a frame that arrives before the era is negotiated, a revision claim
 * the server does not serve, a 2025-era request on a modern-pinned connection.
 * Those are reported on stderr as one redacted, size-bounded line each, and
 * nothing else: never a stack, never the error object.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./tools.js";
import { formatTransportError } from "./vercel.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "vercel-deployment-mcp",
    version: "0.2.0",
  });
  registerTools(server);
  return server;
}

serveStdio(buildServer, {
  onerror: (error) => {
    console.error(formatTransportError(error));
  },
});
console.error("vercel-deployment-mcp ready (stdio)");
