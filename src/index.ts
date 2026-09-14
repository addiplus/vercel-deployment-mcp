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
import { InitializeRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { getConfig, redactValues, type VercelConfig } from "./vercel.js";

const server = new McpServer({
  name: "vercel-deployment-mcp",
  version: "0.2.1",
});

registerTools(server);

const TRANSPORT_ERROR_PREFIX = "vercel-deployment-mcp transport error: ";
const MAX_TRANSPORT_MESSAGE_LEN = 400;
const REPEAT_SUPPRESSED_SUFFIX = " (repeated; further identical reports suppressed)";

// The peer decides how often a transport failure happens, so it would otherwise
// decide how many lines this process writes to someone else's log. Only the
// previous report is remembered, which is all a run of identical failures needs.
let lastReport: string | undefined;
let repeatAnnounced = false;

function writeReport(line: string): void {
  try {
    console.error(line);
  } catch {
    /* the diagnostic channel is gone as well; there is nowhere left to report */
  }
}

/**
 * Report an out of band transport failure on stderr: one line, whitespace
 * collapsed, configured values replaced, and bounded in length. The same report
 * repeated back to back is written twice at most, the second time to say the
 * rest are not being written. stdout is the protocol channel, so nothing here
 * may write there.
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
  if (safe === lastReport) {
    if (repeatAnnounced) return;
    repeatAnnounced = true;
    writeReport(TRANSPORT_ERROR_PREFIX + safe + REPEAT_SUPPRESSED_SUFFIX);
    return;
  }
  lastReport = safe;
  repeatAnnounced = false;
  writeReport(TRANSPORT_ERROR_PREFIX + safe);
}

// The protocol channel is gone, so there is nothing left to serve. Report it and
// leave with a status that reads as an ordinary shutdown.
process.stdout.on("error", (err: Error) => {
  reportTransportError(err);
  process.exit(0);
});

// Requests that are legal before the handshake finishes. Everything else waits.
const INITIALIZE_REQUEST = "initialize";
const OPEN_BEFORE_INITIALIZE = new Set([INITIALIZE_REQUEST, "ping"]);
const INITIALIZED_NOTIFICATION = "notifications/initialized";
const PRE_INITIALIZE_MESSAGE = "Received a request before initialization completed.";

let initialized = false;
// Both halves of the handshake are required, and in that order. An initialize
// request is the half a peer cannot simply assert, so an initialized
// notification that arrives before any initialize ends nothing.
//
// The request is counted here, as its frame goes past, rather than read back
// from the server afterwards: the server records the client's capabilities a
// turn later than the frame arrives, and a client that writes its whole
// handshake in one go does not wait that long. Only a request the server can
// answer counts, which is why the reading below is the server's own schema for
// it rather than a second opinion about what one looks like. The server's own
// record still counts too, which covers a request this wrapper never saw.
let initializeRequested = false;
const initializeAnswered = () =>
  initializeRequested || server.server.getClientCapabilities() !== undefined;
const endInitialization = () => {
  if (initializeAnswered()) initialized = true;
};
server.server.oninitialized = endInitialization;

const MAX_FRAME_BYTES = 10 * 1024 * 1024;

// Only whole lines reach the transport, and a line longer than the limit is
// dropped rather than buffered, so a peer that never sends a newline cannot
// grow this process without bound.
//
// The limit is on the message, not on the message plus its delimiter. A
// message is the bytes before the newline that ends it, so the newline itself
// is not counted and a message of exactly the limit is accepted. A carriage
// return sitting just in front of that newline is one of the bytes before it,
// so it counts as part of the message like any other byte.
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
    frameBytes += newlineAt === -1 ? piece.length : piece.length - 1;
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
  if (
    isRequest &&
    frame.method === INITIALIZE_REQUEST &&
    InitializeRequestSchema.safeParse(message).success
  ) {
    initializeRequested = true;
  }
  // Initialization ends as this notification goes past, rather than a turn
  // later when its handler runs, so a client that puts its first request in the
  // same write as the notification is not refused.
  if (!isRequest && frame.method === INITIALIZED_NOTIFICATION) endInitialization();
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
