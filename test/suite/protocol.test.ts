import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The built server as a black box, driven over its own stdio.
 *
 * Every case here spawns dist/index.js with a stubbed global fetch injected
 * through --import, so no network is touched. The stub writes one marked line
 * per outbound request to stderr, which is how a case proves that a request was
 * or was not made.
 */

const READY_BANNER = "vercel-deployment-mcp ready (stdio)";
const REQUEST_MARKER = "__VREQ__";
const TOKEN = "vc_protocol_token_canary";
const TEAM_ID = "team_protocol_canary";

interface RpcFrame {
  jsonrpc?: string;
  id?: number;
  result?: {
    tools?: Array<{ name?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string };
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TestServer {
  child: ChildProcessWithoutNullStreams;
  send(message: unknown): void;
  rpc(id: number, method: string, params?: unknown): Promise<RpcFrame>;
  waitForFrame(id: number, timeoutMs?: number): Promise<RpcFrame>;
  initialize(): Promise<void>;
  waitForExit(timeoutMs: number): Promise<Exit>;
  stderr(): string;
  requests(): string[];
  stop(): void;
}

/** The stubbed fetch the child runs with: no network, one marked line per request. */
function buildPreload(): string {
  return [
    "globalThis.fetch = async (input, init = {}) => {",
    "  const url = new URL(String(input));",
    "  if (url.origin !== 'https://api.vercel.com') throw new Error('unexpected origin');",
    "  const headers = init.headers ?? {};",
    "  const record = {",
    "    url: url.toString(),",
    "    authIsBearer: String(headers.Authorization ?? '').startsWith('Bearer '),",
    "  };",
    `  process.stderr.write(${JSON.stringify(REQUEST_MARKER)} + JSON.stringify(record) + '\\n');`,
    "  const body = url.pathname.startsWith('/v9/projects/')",
    "    ? { id: 'prj_ok', name: 'demo', framework: null }",
    "    : { projects: [{ id: 'prj_ok', name: 'demo', framework: null }] };",
    "  return new Response(JSON.stringify(body), { status: 200 });",
    "};",
  ].join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describeFailure: () => string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(describeFailure());
    await sleep(20);
  }
}

async function startServer(extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const env = {
    ...process.env,
    VERCEL_TOKEN: TOKEN,
    VERCEL_TEAM_ID: TEAM_ID,
    VERCEL_MCP_MIN_INTERVAL_MS: "0",
    ...extraEnv,
  };
  delete env.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(buildPreload())}`, "dist/index.js"],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );

  const frames = new Map<number, RpcFrame>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exit: Exit | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as RpcFrame;
        if (parsed.id !== undefined) frames.set(parsed.id, parsed);
      } catch {
        /* a non-JSON line is not a response; the purity suite covers that */
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  // A destroyed stdout on this side makes the child's write fail, which is the
  // point of one case; the resulting EPIPE on our own pipe is not a failure.
  child.stdin.on("error", () => {});

  const server: TestServer = {
    child,
    send(message: unknown) {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    async rpc(id: number, method: string, params?: unknown) {
      server.send(params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params });
      return server.waitForFrame(id);
    },
    async waitForFrame(id: number, timeoutMs = 10_000) {
      await waitFor(
        () => frames.has(id),
        timeoutMs,
        () => `no response to id ${id}; stderr so far: ${stderrBuffer}`,
      );
      return frames.get(id)!;
    },
    async initialize() {
      const framed = await server.rpc(999, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "protocol-suite", version: "0.0.0" },
      });
      expect(framed.result).toBeDefined();
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await sleep(100);
    },
    async waitForExit(timeoutMs: number) {
      await waitFor(
        () => exit !== undefined,
        timeoutMs,
        () => `the server was still running; stderr so far: ${stderrBuffer}`,
      );
      return exit!;
    },
    stderr() {
      return stderrBuffer;
    },
    requests() {
      return stderrBuffer
        .split("\n")
        .filter((line) => line.startsWith(REQUEST_MARKER))
        .map((line) => line.slice(REQUEST_MARKER.length));
    },
    stop() {
      if (exit === undefined) child.kill();
    },
  };

  await waitFor(
    () => stderrBuffer.includes(READY_BANNER),
    15_000,
    () => `the server never reported itself ready; stderr so far: ${stderrBuffer}`,
  );
  return server;
}

describe("transport failures", () => {
  it(
    "exits cleanly when the host closes its read end of stdout",
    async () => {
      const server = await startServer();
      try {
        await server.initialize();
        server.child.stdout.destroy();
        server.send({ jsonrpc: "2.0", id: 9, method: "ping" });
        server.send({ jsonrpc: "2.0", id: 10, method: "tools/list" });
        const exit = await server.waitForExit(10_000);
        expect(exit.code).toBe(0);
        expect(exit.signal).toBeNull();
        expect(server.stderr()).toContain("vercel-deployment-mcp transport error: ");
        expect(server.stderr()).not.toContain("Unhandled 'error' event");
        expect(server.stderr()).not.toContain("node_modules");
      } finally {
        server.stop();
      }
    },
    20_000,
  );

  it(
    "drops a frame larger than the stated limit, reports it once, and keeps serving",
    async () => {
      const server = await startServer();
      try {
        await server.initialize();
        const megabyte = "x".repeat(1024 * 1024);
        for (let i = 0; i < 12; i++) server.child.stdin.write(megabyte);
        server.child.stdin.write("\n");
        const ping = await server.rpc(20, "ping");
        expect(ping.result).toBeDefined();
        const reported = server
          .stderr()
          .split("\n")
          .filter((line) => line.includes("stdin frame exceeded"));
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain("vercel-deployment-mcp transport error: ");
        expect(reported[0]).toContain("10485760");
        expect(server.child.exitCode).toBeNull();
      } finally {
        server.stop();
      }
    },
    20_000,
  );
});

describe("the initialization handshake", () => {
  it(
    "refuses tool requests until the handshake completes, and makes no upstream request",
    async () => {
      const server = await startServer();
      try {
        const pingBefore = await server.rpc(1, "ping");
        expect(pingBefore.result).toBeDefined();

        const listBefore = await server.rpc(2, "tools/list");
        expect(listBefore.error?.code).toBe(-32600);
        expect(listBefore.result).toBeUndefined();

        const callBefore = await server.rpc(3, "tools/call", {
          name: "get_project",
          arguments: { idOrName: "before_handshake" },
        });
        expect(callBefore.error?.code).toBe(-32600);
        expect(server.requests()).toHaveLength(0);

        await server.initialize();
        const listAfter = await server.rpc(4, "tools/list");
        expect(listAfter.result?.tools).toHaveLength(4);
        const callAfter = await server.rpc(5, "tools/call", {
          name: "get_project",
          arguments: { idOrName: "after_handshake" },
        });
        expect(callAfter.result?.isError).not.toBe(true);
        expect(server.requests()).toHaveLength(1);
        expect(server.requests()[0]).toContain("after_handshake");
      } finally {
        server.stop();
      }
    },
    20_000,
  );

  it(
    "refuses a tool request when the initialized notification is all that came before it",
    async () => {
      const server = await startServer();
      try {
        // The notification on its own, with no initialize request ever sent.
        server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

        const listAfterNotification = await server.rpc(1, "tools/list");
        expect(listAfterNotification.error?.code).toBe(-32600);
        expect(listAfterNotification.result).toBeUndefined();

        const callAfterNotification = await server.rpc(2, "tools/call", {
          name: "get_project",
          arguments: { idOrName: "notification_only" },
        });
        expect(callAfterNotification.error?.code).toBe(-32600);
        expect(callAfterNotification.result).toBeUndefined();
        expect(server.requests()).toHaveLength(0);

        // A real handshake after that still works, and only then is a tool served.
        await server.initialize();
        const listAfterHandshake = await server.rpc(3, "tools/list");
        expect(listAfterHandshake.result?.tools).toHaveLength(4);
      } finally {
        server.stop();
      }
    },
    20_000,
  );

  it(
    "serves a request written in the same chunk as the initialized notification",
    async () => {
      const server = await startServer();
      try {
        const framed = await server.rpc(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "protocol-suite", version: "0.0.0" },
        });
        expect(framed.result).toBeDefined();
        // One write carrying the notification and the next request, which is what
        // a client that does not wait between the two sends.
        server.child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
            "\n" +
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
            "\n",
        );
        const pipelined = await server.waitForFrame(2);
        expect(pipelined.error).toBeUndefined();
        expect(pipelined.result?.tools).toHaveLength(4);
      } finally {
        server.stop();
      }
    },
    20_000,
  );
});
