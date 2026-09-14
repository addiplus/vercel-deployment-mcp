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
      await waitFor(
        () => frames.has(id),
        10_000,
        () => `no response to ${method} (id ${id}); stderr so far: ${stderrBuffer}`,
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
});
