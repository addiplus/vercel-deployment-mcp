/**
 * Upstream failure modes and credential safety, as a black box over stdio.
 *
 * The built server is spawned as a child process with a stubbed global fetch
 * (the technique test/stdio-purity.test.ts uses), so nothing here touches the
 * network. The stub picks a scenario from the request itself: the path segment
 * for the single-item tools, the `search` / `projectId` query value for the list
 * tools. Every scenario therefore reaches the server through the normal tool
 * surface, and one long-lived child serves all of them, which is also the proof
 * that a failed call never takes the process down.
 *
 * The stub writes one `__VREQ__` line per outbound request to stderr. stderr is
 * not the protocol channel, so the recorded Authorization header there is not a
 * leak; every secret assertion below is scoped to stdout frames, which is where
 * the contract actually lives.
 *
 * Throttle spacing is switched off through the documented
 * VERCEL_MCP_MIN_INTERVAL_MS env var so the file stays fast; nothing here
 * depends on the throttle's behaviour.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "vc_upstream_canary_TOKEN_do_not_leak";
const TEAM_ID = "team_upstream_canary_ID";
const API_ORIGIN = "https://api.vercel.com";

interface RecordedRequest {
  url: string;
  rawMethod: string | null;
  hasBody: boolean;
  headers: Record<string, string>;
  hasSignal: boolean;
}

interface ToolFrame {
  id?: number;
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

/** The stubbed fetch. Kept free of template literals so it can be embedded in one. */
function buildPreload(token: string, teamId: string): string {
  return `
import { writeSync } from "node:fs";

const TOKEN = ${JSON.stringify(token)};
const TEAM = ${JSON.stringify(teamId)};
const counts = new Map();

function bump(key) {
  const n = (counts.get(key) || 0) + 1;
  counts.set(key, n);
  return n;
}

function headerBag(raw) {
  const out = {};
  if (!raw) return out;
  if (typeof Headers !== "undefined" && raw instanceof Headers) {
    raw.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  } else if (Array.isArray(raw)) {
    for (const pair of raw) out[String(pair[0]).toLowerCase()] = String(pair[1]);
  } else {
    for (const k of Object.keys(raw)) out[k.toLowerCase()] = String(raw[k]);
  }
  return out;
}

function record(url, init) {
  writeSync(2, "__VREQ__" + JSON.stringify({
    url: String(url),
    rawMethod: init.method === undefined ? null : String(init.method),
    hasBody: init.body !== undefined && init.body !== null,
    headers: headerBag(init.headers),
    hasSignal: Boolean(init.signal),
  }) + "\\n");
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
  });
}

function raw(status, text, headers) {
  return new Response(text, {
    status,
    headers: Object.assign({ "content-type": "text/plain" }, headers || {}),
  });
}

function named(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

const OK_BODIES = {
  listProjects: {
    projects: [{ id: "prj_1", name: "demo", framework: "nextjs", updatedAt: 1700000000000 }],
  },
  getProject: { id: "prj_ok", name: "demo", framework: null },
  listDeployments: {
    deployments: [
      { uid: "dpl_1", name: "app", readyState: "READY", target: "production", createdAt: 1700000000000 },
    ],
  },
  getDeployment: { uid: "dpl_ok", name: "app", state: "READY", target: "production" },
};

function scenario(kind, key) {
  switch (key) {
    case "s401":
      return json(401, { error: { code: "forbidden", message: "Not authorized" } });
    case "s401text":
      return raw(401, "unauthorized-plain-body-marker");
    case "s401echo":
      return json(401, {
        error: { code: "forbidden", message: "Token " + TOKEN + " is invalid for team " + TEAM },
      });
    case "s401long":
      return json(401, {
        error: {
          code: "forbidden",
          message: "B".repeat(250) + TOKEN + "C".repeat(250),
        },
      });
    case "s403":
      return json(403, { error: { code: "forbidden", message: "You do not have access" } });
    case "s403html":
      return raw(403, "<html><body>forbidden-html-body-marker</body></html>", {
        "content-type": "text/html",
      });
    case "s404":
      return json(404, { error: { code: "not_found", message: "Project not found" } });
    case "s404empty":
      return new Response(null, { status: 404 });
    case "s429after0":
      return bump("s429after0") === 1
        ? json(429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "0" })
        : json(200, OK_BODIES[kind]);
    case "s429always":
      return json(429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "0" });
    case "s429nohdr":
      return json(429, { error: { code: "rate_limited", message: "Slow down" } });
    case "s429badhdr":
      return json(429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "soon" });
    case "s429longhdr":
      return json(429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "30" });
    case "s500":
      return json(500, { error: { code: "internal_server_error", message: "Something broke upstream" } });
    case "s500malformed":
      return raw(500, '{"error": {"message": "trunc', { "content-type": "application/json" });
    case "s502text":
      return raw(502, "upstream-gateway-body-marker");
    case "ok200malformed":
      return raw(200, '{"projects": [', { "content-type": "application/json" });
    case "parseLeakTeam":
      return raw(200, TEAM + " x", { "content-type": "application/json" });
    case "parseLeakToken":
      return raw(200, TOKEN + " x", { "content-type": "application/json" });
    case "parseLeakBoth":
      return raw(200, TOKEN + " " + TEAM, { "content-type": "application/json" });
    case "ok200empty":
      return raw(200, "", { "content-type": "application/json" });
    case "nullBody":
      return json(200, null);
    case "arrayBody":
      return json(200, []);
    case "projectsString":
      return json(200, { projects: "not-an-array" });
    case "projectsNull":
      return json(200, { projects: null });
    case "projectsNumber":
      return json(200, { projects: 7 });
    case "collectionMissing":
      return json(200, { total: 3 });
    case "deploymentsObject":
      return json(200, { deployments: { first: "dpl_1" } });
    case "numericUid":
      return json(200, { uid: 12345, name: "app" });
    case "emptyObject":
      return json(200, {});
    case "leakyProject":
      return json(200, {
        id: "prj_leak",
        name: "leaky",
        framework: "nextjs",
        updatedAt: 1700000000000,
        accountId: TEAM,
        apiToken: TOKEN,
      });
    case "leakyDeployments":
      return json(200, {
        deployments: [
          { uid: "dpl_leak", name: "app", readyState: "READY", target: null, teamId: TEAM, ownerToken: TOKEN },
        ],
      });
    case "netfail":
      throw new Error("connect ECONNREFUSED " + ${JSON.stringify(API_ORIGIN)} + "/v9/projects?token=" + TOKEN);
    case "abort":
      throw named("AbortError", "The operation was aborted");
    case "timeoutErr":
      throw named("TimeoutError", "The operation timed out");
    case "throwString":
      throw "fetch-rejected-with-a-string";
    default:
      return json(200, OK_BODIES[kind]);
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  record(url, init);
  if (url.origin !== ${JSON.stringify(API_ORIGIN)}) throw new Error("unexpected origin: " + url.origin);
  if ((init.method || "GET") !== "GET") throw new Error("unexpected method");
  if (init.body !== undefined && init.body !== null) throw new Error("unexpected body");

  const path = url.pathname;
  if (path === "/v9/projects") return scenario("listProjects", url.searchParams.get("search") || "ok");
  if (path.startsWith("/v9/projects/")) {
    return scenario("getProject", decodeURIComponent(path.slice("/v9/projects/".length)));
  }
  if (path === "/v6/deployments") return scenario("listDeployments", url.searchParams.get("projectId") || "ok");
  if (path.startsWith("/v13/deployments/")) {
    return scenario("getDeployment", decodeURIComponent(path.slice("/v13/deployments/".length)));
  }
  throw new Error("unexpected path: " + path);
};
`;
}

class Harness {
  readonly stdoutLines: string[] = [];
  readonly requests: RecordedRequest[] = [];
  stderrBuffer = "";
  private readonly responses = new Map<number, ToolFrame>();
  private stdoutBuffer = "";
  private stderrLineBuffer = "";
  private nextId = 100;
  private fenceCounter = 0;
  private child: ChildProcessWithoutNullStreams | undefined;

  constructor(
    private readonly overrides: Record<string, string | undefined>,
    private readonly preload?: string,
  ) {}

  start(): void {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.NODE_OPTIONS;
    for (const [key, value] of Object.entries(this.overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const args = this.preload
      ? ["--import", `data:text/javascript,${encodeURIComponent(this.preload)}`, "dist/index.js"]
      : ["dist/index.js"];
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, idx);
        this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        this.stdoutLines.push(line);
        try {
          const parsed = JSON.parse(line) as ToolFrame;
          if (parsed.id !== undefined) this.responses.set(parsed.id, parsed);
        } catch {
          // Keep the raw line so the framing assertions can report it.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrBuffer += text;
      this.stderrLineBuffer += text;
      let idx: number;
      while ((idx = this.stderrLineBuffer.indexOf("\n")) >= 0) {
        const line = this.stderrLineBuffer.slice(0, idx);
        this.stderrLineBuffer = this.stderrLineBuffer.slice(idx + 1);
        if (!line.startsWith("__VREQ__")) continue;
        this.requests.push(JSON.parse(line.slice("__VREQ__".length)) as RecordedRequest);
      }
    });
  }

  stop(): void {
    this.child?.kill();
  }

  private send(msg: unknown): void {
    this.child!.stdin.write(JSON.stringify(msg) + "\n");
  }

  private waitForId(id: number, timeoutMs = 20_000): Promise<ToolFrame> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const frame = this.responses.get(id);
        if (frame !== undefined) {
          clearInterval(timer);
          resolve(frame);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for id ${id}; stderr so far: ${this.stderrBuffer}`));
        }
      }, 10);
    });
  }

  async rpc(method: string, params?: unknown): Promise<ToolFrame> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return this.waitForId(id);
  }

  async initialize(): Promise<ToolFrame> {
    const frame = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "upstream-lens", version: "0.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return frame;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolFrame> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  /**
   * Issue one more request and wait for its recorded line. stderr is ordered, so
   * once the fence's line is visible every earlier request line is too. This is
   * how exact request counts are asserted without sleeping.
   */
  async fence(): Promise<void> {
    const tag = `fence-${++this.fenceCounter}`;
    await this.callTool("get_project", { idOrName: tag });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (this.requests.some((req) => req.url.includes(tag))) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`fence ${tag} never reached the recorded requests`);
  }
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Assert the shared error-result shape and hand back the single text payload. */
function errorTextOf(frame: ToolFrame): string {
  expect(frame.error, jsonOf(frame.error)).toBeUndefined();
  expect(frame.result?.isError, jsonOf(frame.result)).toBe(true);
  expect(frame.result?.structuredContent).toBeUndefined();
  expect(frame.result?.content).toHaveLength(1);
  expect(frame.result?.content?.[0]?.type).toBe("text");
  return frame.result?.content?.[0]?.text ?? "";
}

function successOf(frame: ToolFrame): Record<string, unknown> {
  expect(frame.error, jsonOf(frame.error)).toBeUndefined();
  expect(frame.result?.isError, jsonOf(frame.result?.content)).not.toBe(true);
  expect(frame.result?.structuredContent, jsonOf(frame.result)).toBeDefined();
  return frame.result!.structuredContent!;
}

function expectNoSecrets(value: unknown, label = ""): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  expect(text, label).not.toContain(TOKEN);
  expect(text, label).not.toContain(TEAM_ID);
}

const CREDENTIAL_HINT = "Check that the configured credential";
const RATE_HINT = "Rate limited by the Vercel API";

describe("upstream failures over stdio", () => {
  const harness = new Harness(
    {
      VERCEL_TOKEN: TOKEN,
      VERCEL_TEAM_ID: TEAM_ID,
      VERCEL_MCP_MIN_INTERVAL_MS: "0",
      VERCEL_MCP_MAX_CONCURRENT: "4",
    },
    buildPreload(TOKEN, TEAM_ID),
  );

  beforeAll(async () => {
    harness.start();
    const init = await harness.initialize();
    expect(init.result).toBeDefined();
  }, 30_000);

  afterAll(() => harness.stop());

  // --- HTTP status codes -------------------------------------------------

  // Catches a 401 that is swallowed into a success, loses the status, or drops the auth hint.
  it("surfaces a JSON 401 as a tool error carrying the status, the upstream code and the credential hint", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "s401" }));
    expect(text).toContain("HTTP 401");
    expect(text).toContain("forbidden");
    expect(text).toContain(CREDENTIAL_HINT);
    expectNoSecrets(text);
  });

  // Catches an upstream body echoed verbatim when the 401 body is not JSON.
  it("does not echo a non-JSON 401 body, falling back to the generic status message", async () => {
    const text = errorTextOf(await harness.callTool("list_projects", { search: "s401text" }));
    expect(text).toContain("HTTP 401");
    expect(text).not.toContain("unauthorized-plain-body-marker");
    // No upstream code was parseable, so the status must stand alone.
    expect(text).toContain("(HTTP 401)");
  });

  // Catches a 403 that reaches the model as structured data instead of an error.
  it("surfaces a 403 from a list tool as an error with no structured content", async () => {
    const frame = await harness.callTool("list_deployments", { projectId: "s403" });
    const text = errorTextOf(frame);
    expect(text).toContain("HTTP 403");
    expect(text).toContain(CREDENTIAL_HINT);
    expect(frame.result).not.toHaveProperty("structuredContent");
  });

  // Catches an HTML error page (edge/proxy) being passed through to the client.
  it("does not echo an HTML 403 body", async () => {
    const text = errorTextOf(await harness.callTool("get_deployment", { idOrUrl: "s403html" }));
    expect(text).toContain("(HTTP 403)");
    expect(text).not.toContain("forbidden-html-body-marker");
    expect(text).not.toContain("<html>");
  });

  // Catches the auth hint being attached to every status instead of only 401/403.
  it("surfaces a 404 without the credential hint", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "s404" }));
    expect(text).toContain("HTTP 404");
    expect(text).toContain("not_found");
    expect(text).not.toContain(CREDENTIAL_HINT);
    expect(text).not.toContain(RATE_HINT);
  });

  // Catches a crash or a hang when the error body is absent entirely.
  it("surfaces a 404 with an empty body as the generic status message", async () => {
    const text = errorTextOf(await harness.callTool("get_deployment", { idOrUrl: "s404empty" }));
    expect(text).toContain("(HTTP 404)");
    expect(text.length).toBeGreaterThan(0);
  });

  // Catches a 5xx being treated as retryable-with-hint or as a success.
  it("surfaces a JSON 500 as an error with the upstream code and no hint", async () => {
    const text = errorTextOf(await harness.callTool("list_projects", { search: "s500" }));
    expect(text).toContain("HTTP 500");
    expect(text).toContain("internal_server_error");
    expect(text).not.toContain(CREDENTIAL_HINT);
    expect(text).not.toContain(RATE_HINT);
  });

  // Catches a truncated JSON error body crashing the JSON parse path instead of degrading.
  it("survives a 500 whose JSON error body is truncated", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "s500malformed" }));
    expect(text).toContain("(HTTP 500)");
    expect(text).not.toContain("trunc");
  });

  // Catches a gateway body (which can carry infrastructure detail) leaking to the client.
  it("does not echo a plain-text 502 gateway body", async () => {
    const text = errorTextOf(await harness.callTool("list_deployments", { projectId: "s502text" }));
    expect(text).toContain("(HTTP 502)");
    expect(text).not.toContain("upstream-gateway-body-marker");
  });

  // Catches any status whose failure shape diverges: a missing isError, extra content
  // parts, or structuredContent surviving on an error result.
  it.each([
    [401, "s401"],
    [403, "s403"],
    [404, "s404"],
    [429, "s429nohdr"],
    [500, "s500"],
    [502, "s502text"],
  ])("returns one uniform error result for HTTP %s", async (status, key) => {
    const frame = await harness.callTool("get_project", { idOrName: String(key) });
    const text = errorTextOf(frame);
    expect(text).toContain(`HTTP ${status}`);
    expectNoSecrets(frame, String(key));
  });

  // --- 429 and the documented single retry --------------------------------

  // Catches the documented Retry-After<=10 retry being dropped, or retried more than once.
  it("retries a 429 with Retry-After 0 exactly once and returns the second response", async () => {
    const before = harness.requests.length;
    const structured = successOf(await harness.callTool("get_project", { idOrName: "s429after0" }));
    await harness.fence();
    const mine = harness.requests.slice(before).filter((req) => req.url.includes("s429after0"));
    expect(mine).toHaveLength(2);
    expect(structured.item).toMatchObject({ id: "prj_ok", name: "demo" });
  });

  // Catches a retry loop: a persistently rate-limited endpoint must be attempted twice, not more.
  it("stops after one retry when the second attempt is also a 429", async () => {
    const before = harness.requests.length;
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "s429always" }));
    await harness.fence();
    const mine = harness.requests.slice(before).filter((req) => req.url.includes("s429always"));
    expect(mine).toHaveLength(2);
    expect(text).toContain("HTTP 429");
    expect(text).toContain(RATE_HINT);
  });

  // Catches a blind retry on a 429 that carries no Retry-After header.
  it("does not retry a 429 without a Retry-After header", async () => {
    const before = harness.requests.length;
    const text = errorTextOf(await harness.callTool("get_deployment", { idOrUrl: "s429nohdr" }));
    await harness.fence();
    expect(harness.requests.slice(before).filter((req) => req.url.includes("s429nohdr"))).toHaveLength(1);
    expect(text).toContain(RATE_HINT);
  });

  // Catches an HTTP-date or junk Retry-After being coerced to a number and slept on.
  it("does not retry a 429 whose Retry-After is not numeric", async () => {
    const before = harness.requests.length;
    errorTextOf(await harness.callTool("list_projects", { search: "s429badhdr" }));
    await harness.fence();
    expect(harness.requests.slice(before).filter((req) => req.url.includes("s429badhdr"))).toHaveLength(1);
  });

  // Catches an unbounded Retry-After wait: 30s is over the documented 10s ceiling, so the
  // call must come back immediately with one attempt rather than parking the server.
  it("refuses to wait on a Retry-After above the documented ceiling", async () => {
    const before = harness.requests.length;
    const startedAt = Date.now();
    const text = errorTextOf(await harness.callTool("list_deployments", { projectId: "s429longhdr" }));
    const elapsed = Date.now() - startedAt;
    await harness.fence();
    expect(harness.requests.slice(before).filter((req) => req.url.includes("s429longhdr"))).toHaveLength(1);
    expect(elapsed).toBeLessThan(5_000);
    expect(text).toContain("HTTP 429");
  });

  // --- 2xx bodies that are not what the mapper expects ---------------------

  // Catches a malformed 2xx body escaping the handler as a crash or an untyped success.
  it("turns a 2xx body with malformed JSON into a tool error", async () => {
    const frame = await harness.callTool("list_projects", { search: "ok200malformed" });
    errorTextOf(frame);
    expect(frame.result?.structuredContent).toBeUndefined();
  });

  // Catches an empty 2xx body (a truncated proxy response) crashing the parse.
  it("turns an empty 2xx body into a tool error", async () => {
    const frame = await harness.callTool("get_project", { idOrName: "ok200empty" });
    errorTextOf(frame);
    expect(frame.result?.structuredContent).toBeUndefined();
  });

  // Catches a literal `null` 2xx body being cast and mapped into a null-field item.
  it("rejects a 2xx body of literal null for a single project", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "nullBody" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches an array 2xx body passing the object guard and mapping to undefined fields.
  it("rejects an array 2xx body for a single project", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "arrayBody" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches `projects` present as a string: .map would throw a raw TypeError without the guard.
  it("rejects a 2xx body where data.projects is a string", async () => {
    const text = errorTextOf(await harness.callTool("list_projects", { search: "projectsString" }));
    expect(text).toContain("unexpected_response_shape");
    expect(text).not.toContain("not-an-array");
  });

  // Catches a `?? []` style fallback quietly turning an explicit null collection into an empty page.
  it("rejects a 2xx body where data.projects is null", async () => {
    const text = errorTextOf(await harness.callTool("list_projects", { search: "projectsNull" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches a numeric collection slipping through an `Array.isArray` check that was weakened to truthiness.
  it("rejects a 2xx body where data.projects is a number", async () => {
    const text = errorTextOf(await harness.callTool("list_projects", { search: "projectsNumber" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches the same guard missing on the deployments collection.
  it("rejects a 2xx body where data.deployments is an object", async () => {
    const text = errorTextOf(await harness.callTool("list_deployments", { projectId: "deploymentsObject" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches the guard over-reaching: an absent collection is a legitimate empty page, not an error.
  it("treats an absent projects collection as an empty page", async () => {
    const structured = successOf(await harness.callTool("list_projects", { search: "collectionMissing" }));
    expect(structured).toEqual({
      pageCount: 0,
      items: [],
      receipt: { scopeKind: "team", appliedFilters: ["search"], endpointProfile: "vercel-read-v1" },
    });
  });

  // Catches the same over-reach on the deployments side.
  it("treats an absent deployments collection as an empty page", async () => {
    const structured = successOf(await harness.callTool("list_deployments", { projectId: "collectionMissing" }));
    expect(structured).toMatchObject({ pageCount: 0, items: [] });
  });

  // Catches a non-string identity being mapped into the id field, which the output schema forbids.
  it("rejects a deployment whose uid is numeric", async () => {
    const text = errorTextOf(await harness.callTool("get_deployment", { idOrUrl: "numericUid" }));
    expect(text).toContain("unexpected_response_shape");
  });

  // Catches the deployment guard being tightened so a legitimate partial 2xx is refused.
  it("accepts an empty object deployment body as a partial success", async () => {
    const structured = successOf(await harness.callTool("get_deployment", { idOrUrl: "emptyObject" }));
    expect(structured.item).toEqual({ target: null });
  });

  // --- transport failures ---------------------------------------------------

  // Catches a raw network error message (which embeds the URL, and here the token) reaching the client.
  it("replaces a rejected fetch with a generic network error", async () => {
    const frame = await harness.callTool("list_projects", { search: "netfail" });
    const text = errorTextOf(frame);
    expect(text).toContain("HTTP 0");
    expect(text).toContain("network_error");
    expect(text).not.toContain("ECONNREFUSED");
    expectNoSecrets(frame);
  });

  // Catches an aborted request being reported as an upstream status or crashing the handler.
  it("reports an aborted request as a network error", async () => {
    const text = errorTextOf(await harness.callTool("get_project", { idOrName: "abort" }));
    expect(text).toContain("HTTP 0");
    expect(text).toContain("network_error");
    expect(text).not.toContain("timeout");
  });

  // Catches the request-timeout branch collapsing into the generic network branch.
  it("reports a TimeoutError distinctly from a plain network failure", async () => {
    const text = errorTextOf(await harness.callTool("get_deployment", { idOrUrl: "timeoutErr" }));
    expect(text).toContain("HTTP 0");
    expect(text).toContain("timeout");
    expect(text).not.toContain("network_error");
  });

  // Catches a non-Error rejection (`throw "..."`) reaching an `err.name` read and crashing.
  it("survives a fetch that rejects with a non-Error value", async () => {
    const text = errorTextOf(await harness.callTool("list_deployments", { projectId: "throwString" }));
    expect(text).toContain("HTTP 0");
    expect(text).not.toContain("fetch-rejected-with-a-string");
  });

  // Catches a failure taking the process down: the server must answer the next call normally.
  it("keeps serving after a run of the worst failures", async () => {
    for (const [tool, args] of [
      ["list_projects", { search: "netfail" }],
      ["get_project", { idOrName: "ok200empty" }],
      ["list_deployments", { projectId: "s500" }],
      ["get_deployment", { idOrUrl: "timeoutErr" }],
    ] as const) {
      errorTextOf(await harness.callTool(tool, args));
    }
    const structured = successOf(await harness.callTool("list_projects", {}));
    expect(structured).toMatchObject({ pageCount: 1 });
  });

  // --- credential safety ----------------------------------------------------

  // Catches an upstream error message echoing the credential straight back to the model.
  it("redacts a token and team id echoed back inside an upstream error message", async () => {
    const frame = await harness.callTool("get_project", { idOrName: "s401echo" });
    const text = errorTextOf(frame);
    expect(text).toContain("[redacted]");
    expectNoSecrets(frame);
  });

  // Catches redaction running after truncation, or the length bound being dropped so a
  // multi-kilobyte upstream body reaches the client.
  it("redacts before truncating and bounds the error text", async () => {
    const frame = await harness.callTool("list_projects", { search: "s401long" });
    const text = errorTextOf(frame);
    expectNoSecrets(frame);
    expect(text).toContain("[redacted]");
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.length).toBeGreaterThan(400);
  });

  // Catches a spread of the upstream object into the response: extra upstream fields carrying
  // account identifiers or credentials must be dropped by the fixed-field projection.
  it("drops upstream 2xx fields that carry the team id or token", async () => {
    const frame = await harness.callTool("get_project", { idOrName: "leakyProject" });
    const structured = successOf(frame);
    expect(structured.item).toEqual({
      id: "prj_leak",
      name: "leaky",
      framework: "nextjs",
      updatedAt: "2023-11-14T22:13:20.000Z",
    });
    expectNoSecrets(frame);
    expectNoSecrets(frame.result?.content?.[0]?.text ?? "");
  });

  // Same projection defect, on a list item rather than a single item.
  it("drops team id and token fields from listed deployment items", async () => {
    const frame = await harness.callTool("list_deployments", { projectId: "leakyDeployments" });
    const structured = successOf(frame);
    expect(structured.items).toEqual([
      { id: "dpl_leak", name: "app", state: "READY", target: null },
    ]);
    expectNoSecrets(frame);
  });

  // Catches a credential reaching stdout on ANY failure class: this is the whole-channel sweep.
  it("never writes the token or team id to a stdout frame across every failure class", async () => {
    const firstLine = harness.stdoutLines.length;
    for (const [tool, args] of [
      ["get_project", { idOrName: "s401echo" }],
      ["get_project", { idOrName: "s403" }],
      ["list_projects", { search: "s404" }],
      ["list_deployments", { projectId: "s429nohdr" }],
      ["get_deployment", { idOrUrl: "s500" }],
      ["list_projects", { search: "s502text" }],
      ["get_project", { idOrName: "ok200empty" }],
      ["list_projects", { search: "projectsString" }],
      ["list_projects", { search: "netfail" }],
      ["get_deployment", { idOrUrl: "timeoutErr" }],
      ["list_projects", { search: "s401long" }],
      ["get_project", { idOrName: "leakyProject" }],
    ] as const) {
      await harness.callTool(tool, args);
    }
    const produced = harness.stdoutLines.slice(firstLine);
    expect(produced.length).toBeGreaterThanOrEqual(12);
    for (const line of produced) expectNoSecrets(line, line.slice(0, 200));
  });

  // Catches a diagnostic (or a stray console.log added while handling a failure) landing in
  // the protocol channel and corrupting the stream for the host.
  it("keeps stdout a pure JSON-RPC channel while failures are served", async () => {
    const firstLine = harness.stdoutLines.length;
    for (const [tool, args] of [
      ["list_projects", { search: "abort" }],
      ["get_project", { idOrName: "throwString" }],
      ["list_deployments", { projectId: "s500malformed" }],
      ["get_deployment", { idOrUrl: "s404empty" }],
    ] as const) {
      await harness.callTool(tool, args);
    }
    const produced = harness.stdoutLines.slice(firstLine);
    expect(produced).toHaveLength(4);
    for (const line of produced) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, line.slice(0, 200)).toBe("2.0");
      expect(line).not.toContain("ready (stdio)");
    }
    expect(harness.stderrBuffer).toContain("vercel-deployment-mcp ready (stdio)");
  });

  // --- the request the server actually makes --------------------------------

  // Catches a method or body creeping onto a read-only client, a missing bearer header, a
  // second header carrying the credential, or the request timeout signal being dropped.
  it("sends a GET with no body, a bearer header and nothing else", async () => {
    const before = harness.requests.length;
    successOf(await harness.callTool("get_project", { idOrName: "shape-probe" }));
    await harness.fence();
    const [req] = harness.requests.slice(before).filter((entry) => entry.url.includes("shape-probe"));
    expect(req).toBeDefined();
    expect(req.rawMethod === null || req.rawMethod === "GET").toBe(true);
    expect(req.hasBody).toBe(false);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(req.headers).sort()).toEqual(["authorization", "content-type"]);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.hasSignal).toBe(true);
    expect(new URL(req.url).origin).toBe(API_ORIGIN);
    expect(new URL(req.url).protocol).toBe("https:");
  });

  // Catches the token being moved or copied into the query string, where it would land in
  // upstream access logs and in any error that quotes the URL.
  it("never puts the token in the request URL", async () => {
    const before = harness.requests.length;
    successOf(await harness.callTool("list_projects", { search: "url-probe" }));
    await harness.fence();
    for (const req of harness.requests.slice(before)) {
      expect(req.url).not.toContain(TOKEN);
      expect(req.url).not.toContain("Bearer");
    }
  });

  // Catches the configured team scope being dropped on any endpoint, which would silently
  // widen or narrow every read to the personal scope.
  it("passes the team id as a teamId query parameter on all four endpoints", async () => {
    const before = harness.requests.length;
    await harness.callTool("list_projects", { search: "team-probe" });
    await harness.callTool("get_project", { idOrName: "team-probe" });
    await harness.callTool("list_deployments", { projectId: "team-probe" });
    await harness.callTool("get_deployment", { idOrUrl: "team-probe" });
    await harness.fence();
    const mine = harness.requests.slice(before).filter((req) => req.url.includes("team-probe"));
    expect(mine).toHaveLength(4);
    expect(new Set(mine.map((req) => new URL(req.url).pathname.split("/")[1]))).toEqual(
      new Set(["v9", "v6", "v13"]),
    );
    for (const req of mine) {
      expect(new URL(req.url).searchParams.get("teamId"), req.url).toBe(TEAM_ID);
    }
  });

  // Catches a hand-built query string: an unencoded value would let a search term inject a
  // second parameter (here, a limit of 999) into the upstream request.
  it("percent-encodes query values so a search term cannot inject a parameter", async () => {
    // The non-ASCII char is written as an escape so the file itself stays plain ASCII.
    const hostile = "a b&limit=999#frag/\u00fc";
    const before = harness.requests.length;
    successOf(await harness.callTool("list_projects", { search: hostile }));
    await harness.fence();
    const [req] = harness.requests.slice(before).filter((entry) => entry.url.includes("/v9/projects?"));
    expect(req).toBeDefined();
    const url = new URL(req.url);
    expect(url.searchParams.get("search")).toBe(hostile);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.hash).toBe("");
    expect(req.url).toContain("%26");
    expect(req.url).toContain("%3D");
    expect(req.url).toContain("%C3%BC");
    expect(req.url).not.toContain("&limit=999");
  });

  // Catches an unencoded path segment: a crafted id would otherwise walk off the documented
  // endpoint (extra path segments, a query, or a fragment).
  it("percent-encodes the path segment so an id cannot leave its endpoint", async () => {
    const hostile = "pj/../../v13/deployments?x=1#f";
    const before = harness.requests.length;
    await harness.callTool("get_project", { idOrName: hostile });
    await harness.fence();
    const [req] = harness.requests
      .slice(before)
      .filter((entry) => entry.url.startsWith(`${API_ORIGIN}/v9/projects/`));
    expect(req).toBeDefined();
    const url = new URL(req.url);
    const segments = url.pathname.split("/");
    expect(segments).toHaveLength(4);
    expect(segments.slice(0, 3)).toEqual(["", "v9", "projects"]);
    expect(decodeURIComponent(segments[3])).toBe(hostile);
    expect(url.hash).toBe("");
    // Nothing but the configured team scope may reach the query string from an id.
    expect([...url.searchParams.keys()].filter((key) => key !== "teamId")).toEqual([]);
  });
});

describe("startup configuration", () => {
  const noToken = new Harness(
    { VERCEL_TOKEN: undefined, VERCEL_TEAM_ID: TEAM_ID, VERCEL_MCP_MIN_INTERVAL_MS: "0" },
    buildPreload(TOKEN, TEAM_ID),
  );
  const noTeam = new Harness(
    { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: undefined, VERCEL_MCP_MIN_INTERVAL_MS: "0" },
    buildPreload(TOKEN, TEAM_ID),
  );

  beforeAll(async () => {
    noToken.start();
    noTeam.start();
    await Promise.all([noToken.initialize(), noTeam.initialize()]);
  }, 30_000);

  afterAll(() => {
    noToken.stop();
    noTeam.stop();
  });

  // Catches a missing token becoming a startup crash: README makes the token required at call
  // time, and TESTING.md exercises "a call with no configuration at all", so the process must
  // come up and stay listable.
  it("starts and lists its tools with no VERCEL_TOKEN configured", async () => {
    const frame = (await noToken.rpc("tools/list")) as unknown as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect((frame.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual([
      "get_deployment",
      "get_project",
      "list_deployments",
      "list_projects",
    ]);
    expect(noToken.stderrBuffer).toContain("vercel-deployment-mcp ready (stdio)");
  });

  // Catches a missing token surfacing as a JSON-RPC protocol error, an opaque crash, or a
  // message that does not name the variable the operator has to set.
  it("answers a call with no token as a tool error naming VERCEL_TOKEN", async () => {
    const frame = await noToken.callTool("list_projects", {});
    const text = errorTextOf(frame);
    expect(text).toContain("Configuration problem");
    expect(text).toContain("VERCEL_TOKEN");
    expect(frame.result?.structuredContent).toBeUndefined();
  });

  // Catches an unauthenticated request being sent upstream anyway (a bearer-less call, or one
  // carrying the literal string "undefined" as the credential).
  it("makes no upstream request at all when the token is missing", async () => {
    const before = noToken.requests.length;
    await noToken.callTool("get_project", { idOrName: "never-requested" });
    await noToken.callTool("list_deployments", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(noToken.requests.slice(before)).toEqual([]);
  });

  // Catches a whitespace-only token passing the presence check and being sent as "Bearer   ".
  it("treats a whitespace-only token as missing", async () => {
    const blank = new Harness(
      { VERCEL_TOKEN: "   ", VERCEL_TEAM_ID: TEAM_ID, VERCEL_MCP_MIN_INTERVAL_MS: "0" },
      buildPreload(TOKEN, TEAM_ID),
    );
    blank.start();
    try {
      await blank.initialize();
      const text = errorTextOf(await blank.callTool("list_projects", {}));
      expect(text).toContain("Configuration problem");
      expect(text).toContain("VERCEL_TOKEN");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(blank.requests).toEqual([]);
    } finally {
      blank.stop();
    }
  }, 30_000);

  // Catches an unset team id being sent as an empty or literal-"undefined" teamId parameter,
  // and catches the receipt claiming a team scope that was never configured.
  it("omits the teamId parameter and reports personal scope when no team is configured", async () => {
    const before = noTeam.requests.length;
    const structured = successOf(await noTeam.callTool("list_projects", { search: "scope-probe" }));
    await noTeam.fence();
    expect(structured.receipt).toEqual({
      scopeKind: "personal",
      appliedFilters: ["search"],
      endpointProfile: "vercel-read-v1",
    });
    const mine = noTeam.requests.slice(before).filter((req) => req.url.includes("scope-probe"));
    expect(mine).toHaveLength(1);
    expect([...new URL(mine[0].url).searchParams.keys()].sort()).toEqual(["limit", "search"]);
  });
});

/**
 * A deliberately short token and team id.
 *
 * The only production path that puts upstream bytes into an error message which
 * has NOT already been redacted is a 2xx body that fails to parse: vercelGet
 * redacts before it builds an ApiError, but the JSON.parse failure on a
 * successful response escapes as a plain Error, and formatToolError's own
 * redactValues call is then the single thing standing between the body and the
 * client. V8 quotes only a short window of the offending document in that
 * SyntaxError, so a long canary would be truncated out of the message and the
 * assertions below would pass no matter what the code did.
 */
const SHORT_TOKEN = "vc_leak";
const SHORT_TEAM = "tm_leak";

describe("credential redaction on the parse-failure path", () => {
  const leaky = new Harness(
    {
      VERCEL_TOKEN: SHORT_TOKEN,
      VERCEL_TEAM_ID: SHORT_TEAM,
      VERCEL_MCP_MIN_INTERVAL_MS: "0",
    },
    buildPreload(SHORT_TOKEN, SHORT_TEAM),
  );

  beforeAll(async () => {
    leaky.start();
    const init = await leaky.initialize();
    expect(init.result).toBeDefined();
  }, 30_000);

  afterAll(() => leaky.stop());

  // Catches the team id being dropped from formatToolError's own redaction list. Every other
  // route to the client is redacted a second time inside vercelGet, so this is the one
  // black-box path on which that call is load-bearing.
  it("redacts the team id out of a 2xx body that fails to parse", async () => {
    const text = errorTextOf(await leaky.callTool("list_projects", { search: "parseLeakTeam" }));
    // The placeholder is the proof that the quoted body really did reach the formatter: if the
    // message ever stops quoting it, this fails loudly instead of passing vacuously.
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(SHORT_TEAM);
  });

  // Same defect on the token half of the same redaction list.
  it("redacts the token out of a 2xx body that fails to parse", async () => {
    const text = errorTextOf(await leaky.callTool("get_project", { idOrName: "parseLeakToken" }));
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(SHORT_TOKEN);
  });

  // Catches a redaction that stops after the first match, leaving the second credential in a
  // message that carries both.
  it("redacts both credentials from one unparseable body", async () => {
    const text = errorTextOf(await leaky.callTool("list_deployments", { projectId: "parseLeakBoth" }));
    expect(text.match(/\[redacted\]/g) ?? []).toHaveLength(2);
    expect(text).not.toContain(SHORT_TOKEN);
    expect(text).not.toContain(SHORT_TEAM);
    expect(text).toContain("Unexpected error");
  });

  // The whole-channel version: no stdout frame produced while these failures are served may
  // carry either credential, in the text content or anywhere else in the envelope.
  it("keeps both credentials off stdout across every parse-failure call", async () => {
    const firstLine = leaky.stdoutLines.length;
    for (const [tool, args] of [
      ["list_projects", { search: "parseLeakTeam" }],
      ["list_projects", { search: "parseLeakToken" }],
      ["get_deployment", { idOrUrl: "parseLeakBoth" }],
      ["get_project", { idOrName: "parseLeakBoth" }],
    ] as const) {
      await leaky.callTool(tool, args);
    }
    const produced = leaky.stdoutLines.slice(firstLine);
    expect(produced.length).toBeGreaterThanOrEqual(4);
    for (const line of produced) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, line.slice(0, 200)).toBe("2.0");
      expect(line, line.slice(0, 200)).not.toContain(SHORT_TOKEN);
      expect(line, line.slice(0, 200)).not.toContain(SHORT_TEAM);
    }
  });
});
