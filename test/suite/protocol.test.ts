import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Protocol conformance over stdio, for both protocol eras, as a black box.
 *
 * The server is spawned exactly as a host would spawn it (`node dist/index.js`),
 * every frame is hand written, and no client library is involved: a client
 * library would paper over the wire defects this file exists to catch.
 *
 * Hermetic: global `fetch` is replaced in the child before `dist/index.js` loads
 * (the preload technique `test/stdio-purity.test.ts` uses) with a function that
 * throws, so a test can never reach the network and a regression that made the
 * protocol layer call out would fail loudly instead of hanging on a socket.
 * Credentials are stripped from the child environment so a developer's real
 * VERCEL_TOKEN cannot change any outcome here.
 *
 * Waiting is barrier based, never timer based: after sending frames that must
 * produce no answer, the test sends one request whose answer it does wait for.
 * The entry processes its inbound queue in order, so the barrier's answer proves
 * every earlier frame was already handled. No test sleeps.
 */

// Every test spawns a child process, so give a loaded machine room. The in-test wait
// below stays under this so a stall reports the child's stdout and stderr instead of a
// bare "test timed out". The whole file still finishes in a few seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const pkg = createRequire(import.meta.url)("../../package.json") as {
  name: string;
  mcpName: string;
  version: string;
  bin: Record<string, string>;
};

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/** JSON-RPC / MCP wire codes this file pins. Values come from the MCP specification. */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** `_meta` keys of the 2026-07-28 per-request envelope. */
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const MODERN_REVISION = "2026-07-28";
const BANNER = "vercel-deployment-mcp ready (stdio)";
const TOOL_NAMES = ["get_deployment", "get_project", "list_deployments", "list_projects"];

/** A 2026-era envelope claiming `revision`, carried as `params._meta`. */
function envelope(revision: string = MODERN_REVISION): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: revision,
    [META_CLIENT_INFO]: { name: "protocol-lens", version: "0.0.0" },
    [META_CLIENT_CAPABILITIES]: {},
  };
}

/** A 2025-era `initialize` request frame. */
function initializeFrame(id: string | number, protocolVersion = "2025-06-18"): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "protocol-lens", version: "0.0.0" },
    },
  };
}

interface Frame {
  jsonrpc?: unknown;
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: Record<string, unknown> };
  method?: string;
}

const FETCH_STUB =
  "globalThis.fetch = async () => { throw new Error('protocol lens is hermetic: no network'); };";

const live = new Set<Session>();

/** One spawned server process plus the framing the tests need around its stdio. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  /** Every non-blank line the child wrote to stdout, in order, unparsed. */
  readonly stdoutLines: string[] = [];
  stderrBuffer = "";
  private stdoutBuffer = "";
  private readonly frames = new Map<string, Frame>();
  private readonly waiters = new Map<string, (frame: Frame) => void>();
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor() {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.VERCEL_TOKEN;
    delete env.VERCEL_TEAM_ID;
    this.child = spawn(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(FETCH_STUB)}`, SERVER_ENTRY],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
    });
    live.add(this);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      this.stdoutLines.push(line);
      let parsed: Frame;
      try {
        parsed = JSON.parse(line) as Frame;
      } catch {
        // Kept in stdoutLines so the purity assertions can report the offender.
        continue;
      }
      if (parsed.id === undefined) continue;
      const key = Session.key(parsed.id);
      this.frames.set(key, parsed);
      const waiter = this.waiters.get(key);
      if (waiter !== undefined) {
        this.waiters.delete(key);
        waiter(parsed);
      }
    }
  }

  /** Distinguishes the string id "1" from the number id 1. */
  private static key(id: string | number): string {
    return `${typeof id}:${JSON.stringify(id)}`;
  }

  /** Writes one JSON value as a newline-delimited frame. */
  send(message: unknown): this {
    this.child.stdin.write(JSON.stringify(message) + "\n");
    return this;
  }

  /** Writes bytes verbatim, for frames JSON.stringify cannot express. */
  raw(text: string): this {
    this.child.stdin.write(text);
    return this;
  }

  /** Resolves with the answer carrying exactly this id. */
  waitFor(id: string | number, timeoutMs = 20_000): Promise<Frame> {
    const key = Session.key(id);
    const existing = this.frames.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(
          new Error(
            `timed out waiting for id ${JSON.stringify(id)}; stdout so far: ` +
              `${JSON.stringify(this.stdoutLines)}; stderr so far: ${this.stderrBuffer}`,
          ),
        );
      }, timeoutMs);
      this.waiters.set(key, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  /**
   * Sends one request and waits for its answer. Because the entry drains its
   * inbound queue in order, this proves every frame written before it has been
   * processed -- the deterministic replacement for a sleep.
   */
  async barrier(kind: "legacy" | "modern" = "legacy"): Promise<void> {
    const id = `barrier-${this.barrierCount++}`;
    if (kind === "legacy") this.send({ jsonrpc: "2.0", id, method: "ping" });
    else this.send({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: envelope() } });
    await this.waitFor(id);
  }

  private barrierCount = 0;

  /** Closes stdin and resolves with how the process exited. */
  endStdin(timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exited !== undefined) return Promise.resolve(this.exited);
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`process still running ${timeoutMs}ms after stdin closed`));
        }, timeoutMs);
        this.child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    this.child.stdin.end();
    return done;
  }

  kill(): void {
    live.delete(this);
    if (this.exited === undefined) this.child.kill();
  }
}

function start(): Session {
  return new Session();
}

/** Parses every stdout line and fails on anything that is not a JSON-RPC 2.0 frame. */
function expectPureStdout(session: Session): Frame[] {
  const frames: Frame[] = [];
  for (const line of session.stdoutLines) {
    let parsed: Frame;
    try {
      parsed = JSON.parse(line) as Frame;
    } catch {
      throw new Error(`stdout carried a line that is not JSON: ${JSON.stringify(line)}`);
    }
    expect(parsed.jsonrpc, `stdout line is not a JSON-RPC frame: ${line}`).toBe("2.0");
    frames.push(parsed);
  }
  return frames;
}

afterEach(() => {
  for (const session of [...live]) session.kill();
});

describe("2025 era over stdio", () => {
  // Catches a server that answers initialize with a revision the client never asked for,
  // or that adds/drops a member of InitializeResult.
  it("answers initialize on the requested revision with exactly the three result members", async () => {
    const s = start();
    s.send(initializeFrame(1));
    const frame = await s.waitFor(1);
    expect(frame.error).toBeUndefined();
    expect(frame.result?.protocolVersion).toBe("2025-06-18");
    expect(Object.keys(frame.result ?? {}).sort()).toEqual([
      "capabilities",
      "protocolVersion",
      "serverInfo",
    ]);
  });

  // Catches a server that has silently dropped support for an older 2025-era revision
  // and forces every host onto the newest one.
  it("echoes an older supported revision instead of upgrading the client", async () => {
    const s = start();
    s.send(initializeFrame(1, "2024-11-05"));
    const frame = await s.waitFor(1);
    expect(frame.error).toBeUndefined();
    expect(frame.result?.protocolVersion).toBe("2024-11-05");
  });

  // Catches the classic handshake bug of parroting back whatever protocolVersion arrived,
  // which makes the server claim to speak a revision it does not implement.
  it("does not parrot an unknown revision back at the client", async () => {
    const s = start();
    const requested = "1999-01-01";
    s.send(initializeFrame(1, requested));
    const frame = await s.waitFor(1);
    expect(frame.error).toBeUndefined();
    const negotiated = frame.result?.protocolVersion;
    expect(typeof negotiated).toBe("string");
    expect(negotiated).not.toBe(requested);
    // A 2025-era handshake may only settle on a 2025-era revision.
    expect(String(negotiated) < MODERN_REVISION).toBe(true);
    expect(String(negotiated)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // Catches over-advertising: a capability announced here that the server cannot serve
  // makes hosts issue requests this server answers with "method not found".
  it("advertises tools and nothing it cannot serve", async () => {
    const s = start();
    s.send(initializeFrame(1));
    const frame = await s.waitFor(1);
    const capabilities = frame.result?.capabilities as Record<string, unknown>;
    expect(Object.keys(capabilities)).toEqual(["tools"]);
    expect(capabilities.tools).toBeTypeOf("object");
    for (const absent of ["resources", "prompts", "logging", "completions", "experimental"]) {
      expect(capabilities).not.toHaveProperty(absent);
    }
  });

  // Catches a 2025 result frame that leaks 2026-era result members (resultType/_meta) or
  // invents pagination this server does not implement.
  it("returns a bare tools/list result on the 2025 era", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const frame = await s.waitFor(2);
    expect(frame.error).toBeUndefined();
    expect(Object.keys(frame.result ?? {})).toEqual(["tools"]);
    expect(frame.result).not.toHaveProperty("nextCursor");
    const tools = frame.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  // Catches an inputSchema that stops being a JSON Schema object, or that loses the
  // required-argument declaration a host needs to prompt for the argument.
  it("declares each tool's inputSchema as an object schema with the right required list", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const frame = await s.waitFor(2);
    const tools = frame.result?.tools as Array<{
      name: string;
      title?: unknown;
      description?: unknown;
      inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    }>;
    const required: Record<string, string[]> = {
      list_projects: [],
      get_project: ["idOrName"],
      list_deployments: [],
      get_deployment: ["idOrUrl"],
    };
    for (const tool of tools) {
      expect(tool.title).toBeTypeOf("string");
      expect(tool.description).toBeTypeOf("string");
      expect(tool.inputSchema?.type).toBe("object");
      expect(tool.inputSchema?.properties).toBeTypeOf("object");
      expect(tool.inputSchema?.required ?? []).toEqual(required[tool.name]);
      for (const name of required[tool.name]) {
        expect(Object.keys(tool.inputSchema?.properties ?? {})).toContain(name);
      }
    }
  });

  // Catches a ping that answers with anything but an empty result, which breaks the
  // liveness check every 2025-era host runs.
  it("answers ping with an empty result object", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const frame = await s.waitFor(2);
    expect(frame.error).toBeUndefined();
    expect(frame.result).toEqual({});
  });

  // Catches a server that refuses every request until initialize has run: an opening frame
  // with no era claim must pin the 2025 era and be served, not dropped.
  it("serves a claim-less opening frame without a prior initialize", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await s.waitFor(1)).result).toEqual({});
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await s.waitFor(2);
    expect((listed.result?.tools as unknown[]).length).toBe(4);
    // The connection pinned the 2025 era, so initialize is still the handshake it answers.
    s.send(initializeFrame(3));
    expect((await s.waitFor(3)).result?.protocolVersion).toBe("2025-06-18");
  });

  // Catches an unknown method answered with a result, an internal error, or silence
  // instead of the JSON-RPC code hosts branch on.
  it("answers an unknown method with -32601 and no result member", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "no/such/method" });
    const frame = await s.waitFor(2);
    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(METHOD_NOT_FOUND);
    expect(frame.error?.message).toBeTypeOf("string");
  });

  // Catches a server that half-implements a capability it never advertised: every one of
  // these must be method-not-found, matching the capabilities it announced.
  it("answers every unimplemented spec method with -32601", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    const methods = [
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "prompts/list",
      "prompts/get",
      "completion/complete",
      "logging/setLevel",
    ];
    methods.forEach((method, index) => {
      s.send({ jsonrpc: "2.0", id: 100 + index, method, params: {} });
    });
    for (const [index, method] of methods.entries()) {
      const frame = await s.waitFor(100 + index);
      expect(frame.error?.code, `${method} should be method-not-found`).toBe(METHOD_NOT_FOUND);
      expect(frame.result, method).toBeUndefined();
    }
  });

  // Catches an unknown tool name leaking back as a tool result: the model would read the
  // miss as tool output instead of the host seeing a protocol error.
  it("rejects an unknown tool name as a protocol error, not a tool result", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });
    const frame = await s.waitFor(2);
    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(INVALID_PARAMS);
  });

  // Catches an id that is coerced (number to string, string to number) or renumbered:
  // a host correlating answers by id would attach the answer to the wrong request.
  it("echoes every request id back unchanged, type included", async () => {
    const s = start();
    s.send(initializeFrame("init"));
    await s.waitFor("init");
    const ids: Array<string | number> = [
      0,
      -7,
      1,
      9007199254740991,
      "1",
      "",
      'id with spaces and "quotes"',
      "0",
    ];
    for (const id of ids) s.send({ jsonrpc: "2.0", id, method: "ping" });
    for (const id of ids) {
      const frame = await s.waitFor(id);
      expect(frame.id, `id ${JSON.stringify(id)} came back changed`).toBe(id);
      expect(typeof frame.id).toBe(typeof id);
      expect(frame.result).toEqual({});
    }
  });

  // Catches dropped or duplicated answers under a burst: every request must be answered
  // exactly once, and a host may not assume answers arrive in request order.
  it("answers every request in a burst exactly once", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    const ids = [10, 11, 12, 13, 14, 15, 16, 17];
    for (const id of ids) {
      s.send(
        id % 2 === 0
          ? { jsonrpc: "2.0", id, method: "ping" }
          : { jsonrpc: "2.0", id, method: "tools/list" },
      );
    }
    for (const id of ids) expect((await s.waitFor(id)).error).toBeUndefined();
    await s.barrier();
    const answered = expectPureStdout(s)
      .map((frame) => frame.id)
      .filter((id) => typeof id === "number" && ids.includes(id));
    expect(answered.sort((a, b) => Number(a) - Number(b))).toEqual(ids);
  });

  // Catches a notification answered with a frame: a response to a notification is a
  // protocol violation and desynchronises a strict client.
  it("never answers a notification", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    s.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1 } });
    s.send({ jsonrpc: "2.0", method: "notifications/not-a-real-notification" });
    await s.barrier();
    const frames = expectPureStdout(s);
    // Only the initialize answer and the barrier answer may be on the wire.
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.id !== undefined)).toBe(true);
  });

  // Catches a parser that dies, hangs, or writes a diagnostic to stdout when a host or a
  // wrapper script sends a line that is not JSON.
  it("survives malformed JSON lines without answering or polluting stdout", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.raw("this is not json at all\n");
    s.raw('{"jsonrpc":"2.0", "id": 5, broken\n');
    s.raw("{\n");
    s.raw("\n");
    s.raw("   \n");
    await s.barrier();
    const frames = expectPureStdout(s);
    expect(frames).toHaveLength(2);
    // The connection is still usable afterwards.
    s.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    expect((await s.waitFor(9)).result).toEqual({});
  });

  // Catches a crash on a well-formed JSON value that is not a JSON-RPC object, the shape a
  // careless client or a log line tee'd into stdin produces.
  it("survives non-object JSON frames without answering or polluting stdout", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    for (const value of ['"a bare string"', "42", "true", "null", "[1,2,3]", "[]", "{}"]) {
      s.raw(value + "\n");
    }
    await s.barrier();
    expect(expectPureStdout(s)).toHaveLength(2);
    s.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    expect((await s.waitFor(9)).result).toEqual({});
  });

  // Catches a transport that accepts frames violating the JSON-RPC envelope (wrong version,
  // missing method, non-integer or non-scalar id) instead of discarding them.
  it("discards frames that violate the JSON-RPC envelope and keeps serving", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "1.0", id: 20, method: "ping" });
    s.send({ jsonrpc: "2.0", id: 21 });
    s.send({ jsonrpc: "2.0", id: 22, method: 5 });
    s.send({ id: 23, method: "ping" });
    s.send({ jsonrpc: "2.0", id: 1.5, method: "ping" });
    s.send({ jsonrpc: "2.0", id: null, method: "ping" });
    s.send({ jsonrpc: "2.0", id: { nested: true }, method: "ping" });
    s.send({ jsonrpc: "2.0", id: true, method: "ping" });
    await s.barrier();
    expect(expectPureStdout(s)).toHaveLength(2);
    s.send({ jsonrpc: "2.0", id: 30, method: "ping" });
    expect((await s.waitFor(30)).result).toEqual({});
  });

  // Catches a stray response frame (a confused client echoing back) pinning an era, being
  // answered, or crashing the process before the real handshake arrives.
  it("discards a response frame received before any era is negotiated", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 77, result: {} });
    s.send({ jsonrpc: "2.0", id: 78, error: { code: -1, message: "x" } });
    s.send(initializeFrame(1));
    const frame = await s.waitFor(1);
    expect(frame.result?.protocolVersion).toBe("2025-06-18");
    expect(expectPureStdout(s)).toHaveLength(1);
  });

  // Catches a reader that does not strip the carriage return, which makes every frame from
  // a Windows host fail to parse.
  it("accepts CRLF-terminated frames", async () => {
    const s = start();
    s.raw(JSON.stringify(initializeFrame(1)) + "\r\n");
    expect((await s.waitFor(1)).result?.protocolVersion).toBe("2025-06-18");
    s.raw(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\r\n");
    expect((await s.waitFor(2)).result).toEqual({});
  });

  // Catches a reader that assumes one stdin chunk is one frame: pipes coalesce and split
  // writes freely, so both directions must work.
  it("handles several frames in one write and one frame split across writes", async () => {
    const s = start();
    s.raw(
      JSON.stringify(initializeFrame(1)) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) +
        "\n",
    );
    expect((await s.waitFor(1)).result?.protocolVersion).toBe("2025-06-18");
    expect((await s.waitFor(2)).result).toEqual({});
    expect((await s.waitFor(3)).result).toEqual({});
    const split = JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }) + "\n";
    s.raw(split.slice(0, 11));
    s.raw(split.slice(11));
    expect((await s.waitFor(4)).result).toEqual({});
    expect(expectPureStdout(s)).toHaveLength(4);
  });

  // Catches any diagnostic that reaches stdout: one non-JSON line there corrupts the
  // protocol channel for every host that parses stdout line by line.
  it("keeps stdout free of everything but JSON-RPC frames across a mixed session", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.raw("garbage\n");
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await s.waitFor(2);
    s.send({ jsonrpc: "2.0", id: 3, method: "no/such/method" });
    await s.waitFor(3);
    s.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });
    await s.waitFor(4);
    await s.barrier();
    const frames = expectPureStdout(s);
    expect(frames.length).toBeGreaterThanOrEqual(5);
    for (const frame of frames) {
      expect(frame.id).toBeDefined();
      expect("result" in frame || "error" in frame).toBe(true);
    }
    expect(s.stdoutLines.some((line) => line.includes(BANNER))).toBe(false);
  });

  // Catches a banner written before the transport is wired, or written to stdout: the host
  // sees the readiness line on stderr and an empty protocol channel until it asks something.
  it("writes the readiness banner to stderr and nothing to stdout until asked", async () => {
    const s = start();
    // No request is sent; the barrier is the first frame this process ever receives.
    await s.barrier();
    expect(s.stderrBuffer).toContain(BANNER);
    expect(s.stdoutLines).toHaveLength(1);
    expect(JSON.parse(s.stdoutLines[0]).id).toBe("barrier-0");
  });

  // Catches a server that hangs, or exits non-zero, when the host closes the pipe: a host
  // would report a crashed MCP server on every normal shutdown.
  it("exits 0 when stdin closes after a session", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await s.waitFor(2);
    expect(await s.endStdin()).toEqual({ code: 0, signal: null });
  });

  // Catches a process that stays alive forever when a host spawns it and immediately gives
  // up: orphaned server processes accumulate on the user's machine.
  it("exits 0 when stdin closes with no traffic at all", async () => {
    const s = start();
    expect(await s.endStdin()).toEqual({ code: 0, signal: null });
    expect(s.stdoutLines).toHaveLength(0);
    expect(s.stderrBuffer).toContain(BANNER);
  });
});

describe("2026-07-28 era over stdio", () => {
  // Catches a drift between the revision the server advertises and the revision it will
  // actually accept in an envelope: an auto-negotiating client would be told yes then no.
  it("accepts an envelope claiming exactly the revision it advertises", async () => {
    const advertise = start();
    advertise.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } });
    const discovered = await advertise.waitFor(1);
    const versions = discovered.result?.supportedVersions as string[];
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version >= MODERN_REVISION).toBe(true);

    const use = start();
    use.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope(versions[0]) } });
    const listed = await use.waitFor(1);
    expect(listed.error).toBeUndefined();
    expect((listed.result?.tools as unknown[]).length).toBe(4);
  });

  // Catches a revision refusal that does not name what the server does support, or that
  // tears the connection down instead of leaving it open for a correct opening.
  it("refuses an unsupported revision claim with -32022 and stays open", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope("2027-01-01") } });
    const refused = await s.waitFor(1);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(refused.error?.data?.requested).toBe("2027-01-01");
    expect(refused.error?.data?.supported).toEqual([MODERN_REVISION]);
    // The refusal did not pin an era: a correct modern opening still works.
    s.send({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: envelope() } });
    const discovered = await s.waitFor(2);
    expect(discovered.error).toBeUndefined();
    expect(discovered.result?.supportedVersions).toEqual(refused.error?.data?.supported);
  });

  // Catches an incomplete envelope being silently accepted (the server would serve a modern
  // request it cannot attribute) or refused without naming the key that is missing.
  it("refuses an incomplete envelope with -32602 naming the missing key and stays open", async () => {
    const s = start();
    s.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { [META_PROTOCOL_VERSION]: MODERN_REVISION } },
    });
    const refused = await s.waitFor(1);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.code).toBe(INVALID_PARAMS);
    const detail = refused.error?.data?.envelope as { key?: string; problem?: string };
    expect(detail?.key).toBe(META_CLIENT_CAPABILITIES);
    expect(detail?.problem).toBeTypeOf("string");
    s.send({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: envelope() } });
    expect((await s.waitFor(2)).error).toBeUndefined();
  });

  // Catches an envelope requirement that is only enforced on the opening frame: after the
  // era is pinned every request still has to carry it, or client identity silently vanishes.
  it("requires the envelope on every request of a pinned modern connection", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const refused = await s.waitFor(2);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.code).toBe(INVALID_PARAMS);
  });

  // Catches a ping answered on the modern era: ping is not defined there, and a server that
  // answers it teaches hosts a liveness check the specification removed.
  it("does not answer ping on the modern era while the same frame works on the 2025 era", async () => {
    const modern = start();
    modern.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await modern.waitFor(1);
    modern.send({ jsonrpc: "2.0", id: 2, method: "ping", params: { _meta: envelope() } });
    const modernPing = await modern.waitFor(2);
    expect(modernPing.result).toBeUndefined();
    expect(modernPing.error?.code).toBe(METHOD_NOT_FOUND);

    const legacy = start();
    legacy.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await legacy.waitFor(2)).result).toEqual({});
  });

  // Catches an unknown method on the modern era answered with anything but method-not-found,
  // including the era's own -32022 (which would tell the client to renegotiate for nothing).
  it("answers an unknown modern-era method with -32601", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "no/such/method", params: { _meta: envelope() } });
    const frame = await s.waitFor(2);
    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(METHOD_NOT_FOUND);
  });

  // Catches a modern notification answered with a frame, the same desynchronisation risk as
  // on the 2025 era but through the envelope-carrying path.
  it("never answers a modern-era notification", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: envelope() } });
    s.send({ jsonrpc: "2.0", method: "notifications/whatever", params: { _meta: envelope() } });
    await s.barrier("modern");
    expect(expectPureStdout(s)).toHaveLength(2);
  });

  // Catches the server identity stamp disappearing from modern results, or leaking into 2025
  // results where a strict 2025 client would reject the unexpected member.
  it("stamps the server identity on modern results only", async () => {
    const modern = start();
    modern.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    const modernFrame = await modern.waitFor(1);
    const meta = modernFrame.result?._meta as Record<string, unknown>;
    expect(meta?.[META_SERVER_INFO]).toEqual({ name: "vercel-deployment-mcp", version: pkg.version });
    expect(modernFrame.result?.resultType).toBe("complete");

    const legacy = start();
    legacy.send(initializeFrame(1));
    await legacy.waitFor(1);
    legacy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const legacyFrame = await legacy.waitFor(2);
    expect(legacyFrame.result).not.toHaveProperty("_meta");
    expect(legacyFrame.result).not.toHaveProperty("resultType");
  });

  // Catches a modern-pinned connection that hangs on shutdown: the pinned instance and the
  // transport both have to tear down when the host closes the pipe.
  it("exits 0 when stdin closes on a modern connection", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await s.waitFor(1);
    expect(await s.endStdin()).toEqual({ code: 0, signal: null });
  });
});

describe("era is decided per connection", () => {
  // Catches server/discover pinning the connection: an auto-negotiating client probes first
  // and then falls back to initialize, and that fallback has to still be served.
  it("does not pin the era on server/discover alone", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } });
    expect((await s.waitFor(1)).error).toBeUndefined();
    s.send(initializeFrame(2));
    const initialized = await s.waitFor(2);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.protocolVersion).toBe("2025-06-18");
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const listed = await s.waitFor(3);
    expect(Object.keys(listed.result ?? {})).toEqual(["tools"]);
  });

  // Catches a connection that switches era mid-stream: once pinned to 2025 it must refuse
  // the modern discovery method and must not start emitting modern result envelopes.
  it("keeps a 2025-pinned connection on the 2025 era", async () => {
    const s = start();
    s.send(initializeFrame(1));
    await s.waitFor(1);
    s.send({ jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: envelope() } });
    const discover = await s.waitFor(2);
    expect(discover.result).toBeUndefined();
    expect(discover.error?.code).toBe(METHOD_NOT_FOUND);
    // An envelope on a pinned 2025 connection changes nothing about the framing.
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: envelope() } });
    const listed = await s.waitFor(3);
    expect(Object.keys(listed.result ?? {})).toEqual(["tools"]);
  });

  // Catches a modern-pinned connection that falls back to the 2025 handshake: it must refuse
  // initialize by revision instead of quietly answering on a revision it is not serving.
  it("keeps a modern-pinned connection from answering initialize", async () => {
    const s = start();
    s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    await s.waitFor(1);
    s.send(initializeFrame(2));
    const refused = await s.waitFor(2);
    expect(refused.result).toBeUndefined();
    expect(refused.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(refused.error?.data?.requested).toBe("2025-06-18");
  });

  // Catches shared or leaked state between two servers running at once: the era, the frames
  // and the ids of one connection must never reach the other.
  it("runs two connections on different eras without crossing frames", async () => {
    const modern = start();
    const legacy = start();
    modern.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } });
    legacy.send(initializeFrame(1));
    expect((await modern.waitFor(1)).result?.supportedVersions).toEqual([MODERN_REVISION]);
    expect((await legacy.waitFor(1)).result?.protocolVersion).toBe("2025-06-18");

    // Same id on both connections, different method, different era.
    modern.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: envelope() } });
    legacy.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    const modernList = await modern.waitFor(2);
    const legacyPing = await legacy.waitFor(2);
    expect(modernList.result?.resultType).toBe("complete");
    expect(legacyPing.result).toEqual({});

    // Each connection keeps its own era for the rest of its life.
    modern.send(initializeFrame(3));
    legacy.send(initializeFrame(3, "2024-11-05"));
    expect((await modern.waitFor(3)).error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect((await legacy.waitFor(3)).result?.protocolVersion).toBe("2024-11-05");

    expect(expectPureStdout(modern)).toHaveLength(3);
    expect(expectPureStdout(legacy)).toHaveLength(3);
  });

  // Catches the two eras registering different tool sets or different input contracts from
  // the one factory: a host must see the same server whichever era it speaks.
  it("serves the same tool contract on both eras", async () => {
    const modern = start();
    const legacy = start();
    modern.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope() } });
    legacy.send(initializeFrame(1));
    await legacy.waitFor(1);
    legacy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const modernTools = (await modern.waitFor(1)).result?.tools;
    const legacyTools = (await legacy.waitFor(2)).result?.tools;
    expect(modernTools).toEqual(legacyTools);
    expect((modernTools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(
      TOOL_NAMES,
    );
  });

  // Catches a server identity that drifts between the two eras or away from the package it
  // ships as: the host, the registry and the binary name would then disagree.
  it("reports one server identity on both eras, matching the package", async () => {
    const expectedName = pkg.name.split("/").pop();
    const modern = start();
    const legacy = start();
    modern.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope() } });
    legacy.send(initializeFrame(1));
    const modernMeta = (await modern.waitFor(1)).result?._meta as Record<string, unknown>;
    const modernIdentity = modernMeta?.[META_SERVER_INFO];
    const legacyIdentity = (await legacy.waitFor(1)).result?.serverInfo;

    expect(legacyIdentity).toEqual(modernIdentity);
    expect(legacyIdentity).toEqual({ name: expectedName, version: pkg.version });
    // The same name the package publishes, registers and installs as a binary.
    expect(pkg.mcpName.split("/").pop()).toBe(expectedName);
    expect(Object.keys(pkg.bin)).toEqual([expectedName]);
  });
});
