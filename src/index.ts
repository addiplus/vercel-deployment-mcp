#!/usr/bin/env node
/**
 * vercel-deployment-mcp: reference MCP server (stdio).
 *
 * Stateless by design: no session data is held between requests, so the
 * server behaves identically on long-lived hosts and short-lived workers.
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { getConfig, redactValues, type VercelConfig } from "./vercel.js";

const server = new McpServer({
  name: "vercel-deployment-mcp",
  version: "0.2.0",
});

registerTools(server);

const TRANSPORT_ERROR_PREFIX = "vercel-deployment-mcp transport error: ";
const MAX_TRANSPORT_MESSAGE_LEN = 400;

/**
 * Report an out of band transport failure on stderr: one line, whitespace
 * collapsed, configured values replaced, and bounded in length. stdout is the
 * protocol channel, so nothing here may write there.
 */
function reportTransportError(err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  let config: VercelConfig | undefined;
  try {
    config = getConfig();
  } catch {
    /* nothing is configured, so there is nothing to replace */
  }
  const safe = redactValues(raw.replace(/\s+/g, " ").trim(), [config?.token, config?.teamId]).slice(
    0,
    MAX_TRANSPORT_MESSAGE_LEN,
  );
  try {
    console.error(TRANSPORT_ERROR_PREFIX + safe);
  } catch {
    /* the diagnostic channel is gone as well; there is nowhere left to report */
  }
}

// The protocol channel is gone, so there is nothing left to serve. Report it and
// leave with a status that reads as an ordinary shutdown.
process.stdout.on("error", (err: Error) => {
  reportTransportError(err);
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("vercel-deployment-mcp ready (stdio)");
