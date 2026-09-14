#!/usr/bin/env node
/**
 * vercel-deployment-mcp: reference MCP server (stdio).
 *
 * Stateless by design: no session data is held between requests, so the
 * server behaves identically on long-lived hosts and short-lived workers.
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 */
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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

// Requests that are legal before the handshake finishes. Everything else waits.
const OPEN_BEFORE_INITIALIZE = new Set(["initialize", "ping"]);
const INITIALIZED_NOTIFICATION = "notifications/initialized";
const PRE_INITIALIZE_MESSAGE = "Received a request before initialization completed.";

let initialized = false;
server.server.oninitialized = () => {
  initialized = true;
};

const MAX_FRAME_BYTES = 10 * 1024 * 1024;

// Only whole lines reach the transport, and a line longer than the limit is
// dropped rather than buffered, so a peer that never sends a newline cannot
// grow this process without bound.
const framed = new PassThrough();
let frameParts: Buffer[] = [];
let frameBytes = 0;
let droppingFrame = false;

process.stdin.on("data", (chunk: Buffer) => {
  let from = 0;
  while (from < chunk.length) {
    const newlineAt = chunk.indexOf(0x0a, from);
    const end = newlineAt === -1 ? chunk.length : newlineAt + 1;
    const piece = chunk.subarray(from, end);
    frameBytes += piece.length;
    if (!droppingFrame && frameBytes > MAX_FRAME_BYTES) {
      droppingFrame = true;
      frameParts = [];
      reportTransportError(
        new Error(`stdin frame exceeded the ${MAX_FRAME_BYTES} byte limit and was dropped`),
      );
    }
    if (!droppingFrame) frameParts.push(piece);
    if (newlineAt !== -1) {
      if (!droppingFrame && frameParts.length > 0) framed.write(Buffer.concat(frameParts));
      frameParts = [];
      frameBytes = 0;
      droppingFrame = false;
    }
    from = end;
  }
});
process.stdin.on("end", () => framed.end());
process.stdin.on("error", (err: Error) => reportTransportError(err));

const transport = new StdioServerTransport(framed, process.stdout);
await server.connect(transport);

// connect() installs the dispatcher on the transport. Wrap it so a request that
// arrives before the handshake finishes is answered rather than executed.
const dispatch = transport.onmessage;
transport.onmessage = (message) => {
  const frame = message as { method?: unknown; id?: unknown };
  const isRequest =
    typeof frame.method === "string" && frame.id !== undefined && frame.id !== null;
  // Initialization ends as this notification goes past, rather than a turn
  // later when its handler runs, so a client that puts its first request in the
  // same write as the notification is not refused.
  if (!isRequest && frame.method === INITIALIZED_NOTIFICATION) initialized = true;
  if (isRequest && !initialized && !OPEN_BEFORE_INITIALIZE.has(frame.method as string)) {
    const refusal: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: frame.id as string | number,
      error: { code: -32600, message: PRE_INITIALIZE_MESSAGE },
    };
    void transport.send(refusal);
    return;
  }
  dispatch?.(message);
};

console.error("vercel-deployment-mcp ready (stdio)");
