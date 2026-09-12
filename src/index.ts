#!/usr/bin/env node
/**
 * vercel-deployment-mcp: reference MCP server (stdio).
 *
 * Stateless by design: no session data is held between requests, so the
 * server behaves identically on long-lived hosts and short-lived workers.
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "vercel-deployment-mcp",
  version: "0.2.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("vercel-deployment-mcp ready (stdio)");
