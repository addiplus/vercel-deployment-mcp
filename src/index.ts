#!/usr/bin/env node
/**
 * vercel-deployment-mcp: reference MCP server (stdio).
 *
 * Stateless by design: no session data is held between requests, so the
 * server behaves identically on long-lived hosts and short-lived workers.
 * stdout carries the MCP protocol; all diagnostics go to stderr.
 *
 * serveStdio owns the connection and the era decision. It calls buildServer
 * once per connection (and once more for a discarded server/discover probe),
 * so every instance registers its own tools. The legacy option is left at its
 * default of 'serve', which keeps 2025-era clients on the same wire bytes they
 * saw before this change.
 *
 * The transport underneath it is built here rather than left to the default,
 * because three things have to sit between the peer and the protocol: a bound
 * on how large one message may be, a bound on how much a failing peer can
 * write to the host's log, and the rule that a 2025-era client is served only
 * after its handshake is complete.
 *
 * serveStdio reports every out-of-band error through options.onerror: a send
 * failure, a frame that arrives before the era is negotiated, a revision claim
 * the server does not serve, a 2025-era request on a modern-pinned connection.
 * Those are reported on stderr as one redacted, size-bounded line each, and
 * nothing else: never a stack, never the error object.
 */
import { PassThrough } from "node:stream";
import {
  isInitializeRequest,
  isInitializedNotification,
  isJSONRPCRequest,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerTools } from "./tools.js";
import { formatTransportError, TRANSPORT_ERROR_PREFIX } from "./vercel.js";

const REPEAT_SUPPRESSED_SUFFIX = " (repeated; further identical reports suppressed)";
/** The most reports one process will write before it stops writing them. */
const MAX_TRANSPORT_REPORTS = 100;
const REPORTS_EXHAUSTED_MESSAGE = `further transport errors suppressed after ${MAX_TRANSPORT_REPORTS} reports`;

// The peer decides how often a transport failure happens, so it would otherwise
// decide how many lines this process writes to someone else's log. Two bounds
// answer that: the previous report is remembered, which is all a run of
// identical failures needs, and the total is capped, which is what a peer that
// varies its input runs into.
let lastReport: string | undefined;
let repeatAnnounced = false;
let reportsWritten = 0;
let reportsExhausted = false;

function writeLine(line: string): void {
  try {
    console.error(line);
  } catch {
    /* the diagnostic channel is gone as well; there is nowhere left to report */
  }
}

/** Writes one report, or the single line that says reports have stopped. */
function writeReport(line: string): void {
  if (reportsWritten >= MAX_TRANSPORT_REPORTS) {
    if (reportsExhausted) return;
    reportsExhausted = true;
    writeLine(TRANSPORT_ERROR_PREFIX + REPORTS_EXHAUSTED_MESSAGE);
    return;
  }
  reportsWritten += 1;
  writeLine(line);
}

/**
 * Report an out of band transport failure on stderr: one line, whitespace
 * collapsed, configured values replaced, and bounded in length. The same report
 * repeated back to back is written twice at most, the second time to say the
 * rest are not being written. stdout is the protocol channel, so nothing here
 * may write there.
 */
function reportTransportError(err: unknown): void {
  const line = formatTransportError(err);
  if (line === lastReport) {
    if (repeatAnnounced) return;
    repeatAnnounced = true;
    writeReport(line + REPEAT_SUPPRESSED_SUFFIX);
    return;
  }
  lastReport = line;
  repeatAnnounced = false;
  writeReport(line);
}

// The protocol channel is gone, so there is nothing left to serve. Report it and
// leave with a status that reads as an ordinary shutdown. This handler is
// installed before serveStdio starts the transport, so it runs before the
// transport's own stdout handler and the process leaves with one line.
process.stdout.on("error", (err: Error) => {
  reportTransportError(err);
  process.exit(0);
});

// Requests that are legal before the handshake finishes. Everything else waits.
const OPEN_BEFORE_INITIALIZE = new Set(["initialize", "ping"]);
const PRE_INITIALIZE_MESSAGE = "Received a request before initialization completed.";
const INVALID_REQUEST_CODE = -32600;

let initialized = false;
// Both halves of the handshake are required, and in that order. An initialize
// request is the half a peer cannot simply assert, so an initialized
// notification that arrives before any initialize ends nothing.
//
// The request is counted here, as its frame goes past, rather than read back
// from the server afterwards: the server records the client's capabilities a
// turn later than the frame arrives, and a client that writes its whole
// handshake in one go does not wait that long. Only a request the server can
// answer counts, which is why the reading below is the SDK's own predicate for
// one rather than a second opinion about what one looks like.
let initializeRequested = false;
const endInitialization = () => {
  if (initializeRequested) initialized = true;
};

/**
 * Whether a frame negotiates its own protocol revision. A request that claims a
 * revision in its per-request envelope carries the whole negotiation with it,
 * so there is no earlier handshake for it to wait on; serveStdio judges the
 * claim itself. Only a claim-less request, which is 2025-era traffic, waits.
 */
function carriesRevisionClaim(message: JSONRPCMessage): boolean {
  const params = (message as { params?: unknown }).params;
  if (params === null || typeof params !== "object") return false;
  const meta = (params as { _meta?: unknown })._meta;
  return meta !== null && typeof meta === "object" && PROTOCOL_VERSION_META_KEY in meta;
}

/** The largest message this server accepts, the newline that ends it excluded. */
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
//
// The transport is given the same number plus one, because its own read buffer
// counts the delimiter that this framer does not. Stating it there as well
// keeps the two in agreement: a message this framer passes on can never be one
// the transport refuses.
const framed = new PassThrough();
const inner = new StdioServerTransport(framed, process.stdout, {
  maxBufferSize: MAX_FRAME_BYTES + 1,
});

// A transport that closes while stdin is still open is a fault and not a
// shutdown. A supervisor reads status 0 as an intentional stop, so leave with
// a status that says otherwise.
const TRANSPORT_FAULT_STATUS = 70;
let stdinEnded = false;

// serveStdio installs its own onmessage, onerror and onclose on whatever
// transport it is given, so the checks above cannot live on the transport it
// uses. They live on the transport underneath instead, and this object is what
// serveStdio sees: it forwards every call through, and passes a message on only
// once the checks are satisfied.
const wire: Transport = {
  start: () => inner.start(),
  // The options a message may be sent with carry resumption and task-relation
  // hints that this transport has no place to put: its own send takes the
  // message alone. Passing them no further is what would happen anyway had the
  // transport been handed over directly rather than through this object.
  send: (message: JSONRPCMessage, _options?: TransportSendOptions) => inner.send(message),
  close: () => inner.close(),
};

inner.onerror = (error: Error) => {
  wire.onerror?.(error);
};
inner.onclose = () => {
  if (!stdinEnded) process.exitCode = TRANSPORT_FAULT_STATUS;
  wire.onclose?.();
};
inner.onmessage = (message: JSONRPCMessage) => {
  const isRequest = isJSONRPCRequest(message);
  if (isRequest && isInitializeRequest(message)) initializeRequested = true;
  // Initialization ends as this notification goes past, rather than a turn
  // later when its handler runs, so a client that puts its first request in the
  // same write as the notification is not refused.
  if (!isRequest && isInitializedNotification(message)) endInitialization();
  if (
    isRequest &&
    !initialized &&
    !carriesRevisionClaim(message) &&
    !OPEN_BEFORE_INITIALIZE.has(message.method)
  ) {
    void inner.send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: INVALID_REQUEST_CODE, message: PRE_INITIALIZE_MESSAGE },
    });
    return;
  }
  wire.onmessage?.(message);
};

function buildServer(): McpServer {
  const server = new McpServer({
    name: "vercel-deployment-mcp",
    version: "0.2.0",
  });
  registerTools(server);
  return server;
}

serveStdio(buildServer, {
  transport: wire,
  onerror: (error) => reportTransportError(error),
});

// Reading stdin starts after serveStdio has started the transport, so the first
// frame is handed to a transport that is already listening and no frame waits
// in the stream between them.
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
process.stdin.on("end", () => {
  stdinEnded = true;
  framed.end();
});
process.stdin.on("error", (err: Error) => reportTransportError(err));

console.error("vercel-deployment-mcp ready (stdio)");
