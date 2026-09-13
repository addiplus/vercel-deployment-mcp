/**
 * Invariants and regression lens.
 *
 * Black-box over the built server, reusing the child-process + stubbed-fetch
 * approach of test/stdio-purity.test.ts: dist/index.js is spawned with a
 * preloaded global fetch that answers only https://api.vercel.com, so nothing
 * here touches the network. This file does not re-assert what the purity and
 * era files already pin (annotations, schema validity, credential redaction,
 * the 2026 era handshake). It pins the things that must not drift between
 * calls, between connections, between a payload and its own serialization, and
 * between the source, the package manifest and the built artifact.
 *
 * Two long-lived children are shared: one scoped to a team, one personal. Both
 * are opened with the 2025 initialize handshake in beforeAll, so every test
 * below runs on a legacy-pinned connection and no test can change the era out
 * from under another. Request ids come from a single counter, so tests stay
 * independent of order.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST_INDEX = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const TOOLS_SOURCE = readFileSync(new URL("../../src/tools.ts", import.meta.url), "utf8");
const require_ = createRequire(import.meta.url);
const pkg = require_("../../package.json") as {
  name: string;
  version: string;
  type?: string;
  main?: string;
  bin?: Record<string, string>;
  files?: string[];
  exports?: unknown;
  engines?: Record<string, string>;
};

const TOKEN = "vc_invariants_token_canary";
const TEAM_ID = "team_invariants_canary";

/** Names used as fixture keys; kept out of the range of the echo branch. */
const UNICODE_NAME = "caf\u00e9 \u4e2d\u6587 \u65e5\u672c\u8a9e \u{1F680}\u{1F308} \u00df\u00e7";
const TRICKY_NAME = 'quote " backslash \\ slash / newline \n tab \t end';
const LONG_NAME = "x".repeat(10000);
const UNICODE_ARG = "proj \u{1F680}/\u00e9 ?a=b&c#d";

/**
 * The stubbed upstream. Deterministic fixtures keyed by query, plus an echo
 * branch that reflects the request URL back through a projected field, so the
 * outbound request shape is observable without any file or network side channel.
 */
const FETCH_PRELOAD = [
  "const UNICODE = " + JSON.stringify(UNICODE_NAME) + ";",
  "const TRICKY = " + JSON.stringify(TRICKY_NAME) + ";",
  "globalThis.fetch = async (input, init = {}) => {",
  "  const url = new URL(String(input));",
  "  if (url.origin !== 'https://api.vercel.com') throw new Error('unexpected origin');",
  "  if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined) {",
  "    throw new Error('unexpected request');",
  "  }",
  "  const p = url.pathname;",
  "  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });",
  "  if (p === '/v9/projects') {",
  "    const s = url.searchParams.get('search');",
  "    if (s === 'big') {",
  "      return ok({ projects: Array.from({ length: 1000 }, (_, i) => ({",
  "        id: 'prj_' + i, name: 'p' + i, framework: i % 2 === 0 ? null : 'next',",
  "        updatedAt: 1700000000000 + i, accountId: 'acct_should_be_dropped', live: true,",
  "      })) });",
  "    }",
  "    if (s === 'empty') return ok({ projects: [] });",
  "    if (s === 'unicode') return ok({ projects: [{ id: 'prj_u', name: UNICODE, framework: null }] });",
  "    if (s === 'tricky') return ok({ projects: [{ id: 'prj_t', name: TRICKY, framework: null }] });",
  "    if (s === 'long') return ok({ projects: [{ id: 'prj_l', name: 'x'.repeat(10000), framework: null }] });",
  "    return ok({ projects: [{ id: 'prj_q', name: url.search, framework: null }] });",
  "  }",
  "  if (p.startsWith('/v9/projects/')) {",
  "    const seg = p.slice('/v9/projects/'.length);",
  "    if (seg === 'forbidden') {",
  "      return new Response(",
  "        JSON.stringify({ error: { code: 'forbidden', message: 'denied' } }),",
  "        { status: 403 },",
  "      );",
  "    }",
  "    return ok({ id: 'prj_echo', name: decodeURIComponent(seg), framework: p, region: 'drop' });",
  "  }",
  "  if (p === '/v6/deployments') {",
  "    const pid = url.searchParams.get('projectId');",
  "    if (pid === 'big') {",
  "      return ok({ deployments: Array.from({ length: 1000 }, (_, i) => ({",
  "        uid: 'dpl_' + i, name: 'd' + i, url: 'd' + i + '.vercel.app', readyState: 'READY',",
  "        target: i % 2 === 0 ? null : 'production', createdAt: 1700000000000 + i,",
  "        creator: { uid: 'should_be_dropped' },",
  "      })) });",
  "    }",
  "    if (pid === 'empty') return ok({ deployments: [] });",
  "    return ok({ deployments: [{",
  "      uid: 'dpl_1', name: url.search, url: 'one.vercel.app', readyState: 'READY',",
  "      target: null, createdAt: 1700000000000,",
  "    }] });",
  "  }",
  "  if (p.startsWith('/v13/deployments/')) {",
  "    const seg = p.slice('/v13/deployments/'.length);",
  "    return ok({ uid: 'dpl_echo', name: decodeURIComponent(seg), url: p, readyState: 'READY', target: null });",
  "  }",
  "  return new Response(",
  "    JSON.stringify({ error: { code: 'no_fixture', message: 'no fixture' } }),",
  "    { status: 404 },",
  "  );",
  "};",
].join("\n");

interface Frame {
  jsonrpc?: string;
  id?: string | number;
  error?: { code?: number; message?: string; data?: unknown };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    serverInfo?: { name?: string; version?: string };
    tools?: WireTool[];
  };
}

interface WireTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: Record<string, unknown>;
}

interface Harness {
  send(msg: unknown): void;
  wait(id: string | number, timeoutMs?: number): Promise<Frame>;
  lines(): string[];
  stderr(): string;
  kill(): void;
  initFrame?: Frame;
}

let idCounter = 1000;
function nextId(): number {
  idCounter += 1;
  return idCounter;
}

function startChild(env: NodeJS.ProcessEnv, withStub: boolean): Harness {
  const args = withStub
    ? ["--import", `data:text/javascript,${encodeURIComponent(FETCH_PRELOAD)}`, DIST_INDEX]
    : [DIST_INDEX];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const stdoutLines: string[] = [];
  const frames = new Map<string, Frame>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      stdoutLines.push(line);
      try {
        const parsed = JSON.parse(line) as Frame;
        if (parsed.id !== undefined) frames.set(String(parsed.id), parsed);
      } catch {
        // Non-JSON output is retained so a purity-style assertion can report it.
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  return {
    send(msg: unknown) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    wait(id: string | number, timeoutMs = 30_000) {
      const key = String(id);
      return new Promise<Frame>((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
          const found = frames.get(key);
          if (found) {
            clearInterval(timer);
            resolve(found);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`timed out waiting for id ${key}; stderr so far: ${stderrBuffer}`));
          }
        }, 10);
      });
    },
    lines: () => stdoutLines.slice(),
    stderr: () => stderrBuffer,
    kill: () => child.kill(),
  };
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

async function initialize(h: Harness): Promise<Frame> {
  const id = nextId();
  h.send({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "invariants-suite", version: "0.0.0" },
    },
  });
  const frame = await h.wait(id);
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  h.initFrame = frame;
  return frame;
}

function callFrame(h: Harness, name: string, args: Record<string, unknown>): Promise<Frame> {
  const id = nextId();
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return h.wait(id);
}

async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const frame = await callFrame(h, name, args);
  expect(frame.error, JSON.stringify(frame.error)).toBeUndefined();
  expect(frame.result?.isError, frame.result?.content?.[0]?.text).not.toBe(true);
  return frame.result?.structuredContent as Record<string, unknown>;
}

async function listTools(h: Harness): Promise<WireTool[]> {
  const id = nextId();
  h.send({ jsonrpc: "2.0", id, method: "tools/list" });
  const frame = await h.wait(id);
  expect(frame.error).toBeUndefined();
  return frame.result?.tools ?? [];
}

function items(structured: Record<string, unknown>): Array<Record<string, unknown>> {
  return structured.items as Array<Record<string, unknown>>;
}

/** The echoed upstream query string for the single-row echo fixtures. */
function echoedQuery(structured: Record<string, unknown>): string {
  return items(structured)[0].name as string;
}

let team: Harness;
let personal: Harness;

beforeAll(async () => {
  team = startChild(baseEnv({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM_ID }), true);
  personal = startChild(baseEnv({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "" }), true);
  await Promise.all([initialize(team), initialize(personal)]);
}, 60_000);

afterAll(() => {
  team?.kill();
  personal?.kill();
});

describe("invariants: repeat calls are identical", () => {
  // Catches hidden per-connection state (a cache, a counter, a mutated fixture)
  // that makes the second identical call return something different.
  it("returns byte-identical structured output for the same list_projects call twice", async () => {
    const first = await call(team, "list_projects", { search: "alpha", limit: 7 });
    const second = await call(team, "list_projects", { search: "alpha", limit: 7 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // Catches a serialization change between calls (indent, key order) that would
  // make the text channel unstable for diff-based consumers.
  it("returns byte-identical text content for the same get_project call twice", async () => {
    const a = await callFrame(team, "get_project", { idOrName: "prj_repeat" });
    const b = await callFrame(team, "get_project", { idOrName: "prj_repeat" });
    expect(b.result?.content?.[0]?.text).toBe(a.result?.content?.[0]?.text);
    expect(a.result?.content?.[0]?.text).toBeTruthy();
  });

  // Catches an appliedFilters array that is built once and mutated/accumulated
  // across calls instead of derived fresh from each call's arguments.
  it("does not accumulate receipt filters across repeated list_deployments calls", async () => {
    const withBoth = await call(team, "list_deployments", { projectId: "p1", state: "READY" });
    const withNone = await call(team, "list_deployments", {});
    const withBothAgain = await call(team, "list_deployments", { projectId: "p1", state: "READY" });
    expect((withNone.receipt as { appliedFilters: string[] }).appliedFilters).toEqual([]);
    expect((withBothAgain.receipt as { appliedFilters: string[] }).appliedFilters).toEqual(
      (withBoth.receipt as { appliedFilters: string[] }).appliedFilters,
    );
  });

  // Catches nondeterministic tool metadata (regenerated schemas, re-registration
  // on each list, Map/Set iteration drift) between two tools/list calls.
  it("returns byte-identical tools/list payloads across calls", async () => {
    const first = await listTools(team);
    const second = await listTools(team);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  // Catches shared error state: one failing call must not change the result of
  // the next successful call on the same connection.
  it("leaves the next call unaffected after an upstream error", async () => {
    const before = await call(team, "list_projects", { search: "beta" });
    const failed = await callFrame(team, "get_project", { idOrName: "forbidden" });
    expect(failed.result?.isError).toBe(true);
    const after = await call(team, "list_projects", { search: "beta" });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  // Catches a drift between the two result representations: the text channel
  // must be the same value, pretty-printed with two spaces, in the same order.
  it("serializes text content as the two-space JSON of structuredContent", async () => {
    const frame = await callFrame(team, "list_projects", { search: "gamma" });
    const structured = frame.result?.structuredContent as Record<string, unknown>;
    expect(frame.result?.content?.[0]?.text).toBe(JSON.stringify(structured, null, 2));
    expect(Object.keys(structured)).toEqual(["pageCount", "items", "receipt"]);
    expect(Object.keys(structured.receipt as Record<string, unknown>)).toEqual([
      "scopeKind",
      "appliedFilters",
      "endpointProfile",
    ]);
  });
});

describe("invariants: request/response correlation", () => {
  // Catches a crossed response: ten in-flight requests on one connection must
  // each come back under their own id carrying their own arguments.
  it("answers ten interleaved tool calls each with its own id and payload", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const id = nextId();
      ids.push(id);
      const params =
        i % 2 === 0
          ? { name: "list_projects", arguments: { search: `k${i}` } }
          : { name: "get_project", arguments: { idOrName: `id${i}` } };
      team.send({ jsonrpc: "2.0", id, method: "tools/call", params });
    }
    const frames = await Promise.all(ids.map((id) => team.wait(id, 40_000)));
    frames.forEach((frame, i) => {
      expect(frame.id).toBe(ids[i]);
      expect(frame.error).toBeUndefined();
      const structured = frame.result?.structuredContent as Record<string, unknown>;
      if (i % 2 === 0) {
        expect(echoedQuery(structured)).toContain(`search=k${i}`);
      } else {
        expect((structured.item as { name?: string }).name).toBe(`id${i}`);
      }
    });
  }, 60_000);

  // Catches a duplicated or stray response frame: every id must be answered
  // exactly once, and no id the client never sent may appear.
  it("emits exactly one response frame per request id", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = nextId();
      ids.push(id);
      team.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_projects", arguments: { search: `dup${i}` } },
      });
    }
    await Promise.all(ids.map((id) => team.wait(id, 40_000)));
    const seen = new Map<string, number>();
    for (const line of team.lines()) {
      const parsed = JSON.parse(line) as Frame;
      if (parsed.id === undefined) continue;
      const key = String(parsed.id);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const id of ids) expect(seen.get(String(id))).toBe(1);
  }, 60_000);

  // Catches an id coerced to a number (or regenerated) on the way back: the
  // JSON-RPC id must be echoed with its original type and value.
  it("echoes a string JSON-RPC id back unchanged", async () => {
    const id = "invariants-string-id";
    team.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "list_projects", arguments: { search: "strid" } },
    });
    const frame = await team.wait(id);
    expect(frame.id).toBe(id);
    expect(typeof frame.id).toBe("string");
    expect(frame.jsonrpc).toBe("2.0");
  });

  // Catches a dispatcher that serializes or drops non-tool methods when tool
  // calls are in flight on the same connection.
  it("answers mixed methods interleaved with tool calls", async () => {
    const listId = nextId();
    const pingId = nextId();
    const callId = nextId();
    const ping2Id = nextId();
    team.send({ jsonrpc: "2.0", id: listId, method: "tools/list" });
    team.send({ jsonrpc: "2.0", id: pingId, method: "ping" });
    team.send({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: "list_projects", arguments: { search: "mixed" } },
    });
    team.send({ jsonrpc: "2.0", id: ping2Id, method: "ping" });
    const [listed, ping, called, ping2] = await Promise.all([
      team.wait(listId),
      team.wait(pingId),
      team.wait(callId, 40_000),
      team.wait(ping2Id),
    ]);
    expect(listed.result?.tools).toHaveLength(4);
    expect(ping.error).toBeUndefined();
    expect(ping2.error).toBeUndefined();
    expect(echoedQuery(called.result?.structuredContent as Record<string, unknown>)).toContain(
      "search=mixed",
    );
  }, 60_000);
});

describe("invariants: large upstream pages", () => {
  // Catches silent truncation or a cap applied to an upstream page that is
  // larger than the requested limit.
  it("projects a 1000-project upstream page without dropping rows", async () => {
    const structured = await call(team, "list_projects", { search: "big" });
    expect(structured.pageCount).toBe(1000);
    expect(items(structured)).toHaveLength(1000);
  }, 60_000);

  // Catches upstream fields leaking through the projection at scale (the
  // fixture rows carry accountId and live, which must never be returned).
  it("keeps every row of a large page to the declared field set", async () => {
    const structured = await call(team, "list_projects", { search: "big" });
    for (const row of items(structured)) {
      expect(Object.keys(row).sort()).toEqual(["framework", "id", "name", "updatedAt"]);
    }
  }, 60_000);

  // Catches a large text payload that is cut short (an error-style size bound
  // wrongly applied to a successful result) or chunked badly over stdio.
  it("round-trips a large page through the text channel intact", async () => {
    const frame = await callFrame(team, "list_projects", { search: "big" });
    const structured = frame.result?.structuredContent as Record<string, unknown>;
    const text = frame.result?.content?.[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(50_000);
    expect(JSON.parse(text)).toEqual(structured);
  }, 60_000);

  // Catches a projection that reorders rows (a sort, a Map round-trip, a
  // parallel map) instead of preserving upstream order.
  it("preserves upstream row order across a large page", async () => {
    const structured = await call(team, "list_projects", { search: "big" });
    const rows = items(structured);
    expect(rows[0].id).toBe("prj_0");
    expect(rows[999].id).toBe("prj_999");
    expect(rows.map((r) => r.id)).toEqual(
      Array.from({ length: 1000 }, (_, i) => `prj_${i}`),
    );
  }, 60_000);

  // Catches a large deployment page losing the readyState fallback or the
  // target normalization on some rows only.
  it("projects a 1000-deployment page with the state fallback on every row", async () => {
    const structured = await call(team, "list_deployments", { projectId: "big" });
    expect(structured.pageCount).toBe(1000);
    const rows = items(structured);
    expect(rows).toHaveLength(1000);
    expect(rows.every((r) => r.state === "READY")).toBe(true);
    expect(rows[0].target).toBeNull();
    expect(rows[1].target).toBe("production");
    expect(rows.every((r) => !("creator" in r))).toBe(true);
  }, 60_000);

  // Catches an empty upstream collection being turned into an error or into a
  // missing items field instead of an empty page.
  it("returns an empty page rather than an error for an empty upstream list", async () => {
    const projects = await call(team, "list_projects", { search: "empty" });
    expect(projects.pageCount).toBe(0);
    expect(projects.items).toEqual([]);
    const deployments = await call(team, "list_deployments", { projectId: "empty" });
    expect(deployments.pageCount).toBe(0);
    expect(deployments.items).toEqual([]);
  });
});

describe("invariants: text fidelity", () => {
  // Catches mojibake or a lossy encode of non-ASCII names on the way out
  // (latin1 stream writes, escaped-unicode re-encoding, surrogate splitting).
  it("carries unicode names through both result representations unchanged", async () => {
    const frame = await callFrame(team, "list_projects", { search: "unicode" });
    const structured = frame.result?.structuredContent as Record<string, unknown>;
    expect(items(structured)[0].name).toBe(UNICODE_NAME);
    const parsed = JSON.parse(frame.result?.content?.[0]?.text ?? "") as Record<string, unknown>;
    expect(items(parsed)[0].name).toBe(UNICODE_NAME);
  });

  // Catches a framing bug: an embedded newline in a value must stay inside the
  // JSON string and must not split the stdio frame.
  it("keeps quotes, backslashes, newlines and tabs inside one JSON-RPC frame", async () => {
    const before = team.lines().length;
    const frame = await callFrame(team, "list_projects", { search: "tricky" });
    const structured = frame.result?.structuredContent as Record<string, unknown>;
    expect(items(structured)[0].name).toBe(TRICKY_NAME);
    for (const line of team.lines().slice(before)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // Catches a length bound wrongly applied to successful payloads: only errors
  // are size-capped, a long project name must survive whole.
  it("does not truncate a 10000-character name in a successful result", async () => {
    const structured = await call(team, "list_projects", { search: "long" });
    expect(items(structured)[0].name).toBe(LONG_NAME);
    expect((items(structured)[0].name as string).length).toBe(10000);
  });

  // Catches a path segment that is not percent-encoded (or double-encoded):
  // the argument must reach the upstream encoded and come back decoded.
  it("percent-encodes a unicode path argument and returns the decoded value", async () => {
    const structured = await call(team, "get_project", { idOrName: UNICODE_ARG });
    const item = structured.item as Record<string, unknown>;
    expect(item.name).toBe(UNICODE_ARG);
    expect(item.framework).toBe(`/v9/projects/${encodeURIComponent(UNICODE_ARG)}`);
    expect(item.framework).not.toContain("?");
    expect(item.framework).not.toContain("#");
  });
});

describe("invariants: filter and scope composition", () => {
  // Catches a filter that is recorded in the receipt but never reaches the
  // upstream request, or the reverse.
  it("composes both deployment filters into the query and the receipt", async () => {
    const structured = await call(team, "list_deployments", {
      projectId: "prj_compose",
      state: "READY,ERROR",
    });
    const query = echoedQuery(structured);
    expect(query).toContain("projectId=prj_compose");
    expect(query).toContain(`state=${encodeURIComponent("READY,ERROR")}`);
    expect((structured.receipt as { appliedFilters: string[] }).appliedFilters).toEqual([
      "projectId",
      "state",
    ]);
  });

  // Catches one filter bleeding into a call that did not pass it (a retained
  // default, a shared params object).
  it("sends only the filter that was supplied", async () => {
    const structured = await call(team, "list_deployments", { state: "ERROR" });
    const query = echoedQuery(structured);
    expect(query).toContain("state=ERROR");
    expect(query).not.toContain("projectId=");
    expect((structured.receipt as { appliedFilters: string[] }).appliedFilters).toEqual(["state"]);
  });

  // Catches an unfiltered list that quietly carries a filter parameter, and
  // pins the default page size that the README documents.
  it("sends only limit and teamId when no filter is supplied", async () => {
    const structured = await call(team, "list_deployments", {});
    const query = echoedQuery(structured);
    const params = new URLSearchParams(query);
    expect([...params.keys()].sort()).toEqual(["limit", "teamId"]);
    expect(params.get("limit")).toBe("20");
    expect((structured.receipt as { appliedFilters: string[] }).appliedFilters).toEqual([]);
  });

  // Catches a limit that is ignored, clamped, or not defaulted to 20 on either
  // list tool.
  it("defaults limit to 20 and forwards an explicit limit on both list tools", async () => {
    const projectsDefault = await call(team, "list_projects", {});
    const projectsExplicit = await call(team, "list_projects", { limit: 100 });
    const deploymentsExplicit = await call(team, "list_deployments", { limit: 1 });
    expect(new URLSearchParams(echoedQuery(projectsDefault)).get("limit")).toBe("20");
    expect(new URLSearchParams(echoedQuery(projectsExplicit)).get("limit")).toBe("100");
    expect(new URLSearchParams(echoedQuery(deploymentsExplicit)).get("limit")).toBe("1");
  });

  // Catches a team-scoped configuration that stops scoping its requests, or a
  // receipt that reports a scope the request does not carry.
  it("scopes every request to the configured team", async () => {
    const list = await call(team, "list_projects", {});
    const single = await call(team, "get_project", { idOrName: "prj_scope" });
    expect(new URLSearchParams(echoedQuery(list)).get("teamId")).toBe(TEAM_ID);
    expect((list.receipt as { scopeKind: string }).scopeKind).toBe("team");
    expect((single.receipt as { scopeKind: string }).scopeKind).toBe("team");
  });

  // Catches a blank VERCEL_TEAM_ID being treated as a team: the personal
  // connection must send no teamId and must report the personal scope.
  it("sends no teamId and reports personal scope without a team configured", async () => {
    const list = await call(personal, "list_projects", {});
    const query = echoedQuery(list);
    expect(query).not.toContain("teamId");
    expect((list.receipt as { scopeKind: string }).scopeKind).toBe("personal");
    const deployments = await call(personal, "list_deployments", {});
    expect((deployments.receipt as { scopeKind: string }).scopeKind).toBe("personal");
  });

  // Catches an endpoint version bump or a tool repointed at the wrong resource.
  it("pins each tool to its documented endpoint", async () => {
    const projects = await call(team, "list_projects", {});
    const project = await call(team, "get_project", { idOrName: "prj_endpoint" });
    const deployments = await call(team, "list_deployments", {});
    const deployment = await call(team, "get_deployment", { idOrUrl: "dpl_endpoint" });
    expect(echoedQuery(projects).startsWith("?")).toBe(true);
    expect((project.item as { framework: string }).framework).toBe("/v9/projects/prj_endpoint");
    expect(items(deployments)[0].url).toBe("one.vercel.app");
    expect((deployment.item as { url: string }).url).toBe("/v13/deployments/dpl_endpoint");
    const receipts = [projects, project, deployments, deployment].map(
      (r) => (r.receipt as { endpointProfile: string }).endpointProfile,
    );
    expect(receipts).toEqual(Array(4).fill("vercel-read-v1"));
  });
});

describe("invariants: listed metadata agrees with the source", () => {
  // Catches a reordered or renamed registration: the wire order must be the
  // registerTool order in src/tools.ts, and every name must be non-empty.
  it("lists tools in the order they are registered in src/tools.ts", async () => {
    const wire = (await listTools(team)).map((t) => t.name);
    const source = [...TOOLS_SOURCE.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(source).toHaveLength(4);
    expect(wire).toEqual(source);
    for (const name of wire) expect(name.trim().length).toBeGreaterThan(0);
  });

  // Catches a stale dist or a dist-only edit: every title and description on
  // the wire must appear verbatim in the checked-in source.
  it("serves non-empty titles and descriptions that exist verbatim in the source", async () => {
    for (const tool of await listTools(team)) {
      expect(tool.title?.trim().length ?? 0).toBeGreaterThan(0);
      expect(tool.description?.trim().length ?? 0).toBeGreaterThan(0);
      expect(TOOLS_SOURCE).toContain(tool.title);
      expect(TOOLS_SOURCE).toContain(tool.description);
    }
  });

  // Catches a change to the public input surface: property names, which tools
  // require an argument, and which do not.
  it("pins each tool's input properties and required arguments", async () => {
    const byName = new Map((await listTools(team)).map((t) => [t.name, t]));
    const expected: Record<string, { props: string[]; required: string[] }> = {
      list_projects: { props: ["limit", "search"], required: [] },
      get_project: { props: ["idOrName"], required: ["idOrName"] },
      list_deployments: { props: ["limit", "projectId", "state"], required: [] },
      get_deployment: { props: ["idOrUrl"], required: ["idOrUrl"] },
    };
    for (const [name, want] of Object.entries(expected)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool!.inputSchema?.properties ?? {}).sort()).toEqual(want.props);
      expect((tool!.inputSchema?.required ?? []).slice().sort()).toEqual(want.required);
      for (const prop of want.props) expect(TOOLS_SOURCE).toContain(prop);
    }
  });

  // Catches a tool that loses its output contract, which is what lets a client
  // trust structuredContent at all.
  it("gives every listed tool an output schema", async () => {
    for (const tool of await listTools(team)) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(typeof tool.outputSchema).toBe("object");
    }
  });
});

describe("invariants: package manifest agrees with the build", () => {
  // Catches a bin or main entry that points at a file the build does not
  // produce, which breaks npx and a plain require/import of the package.
  it("points bin and main at the built entry file, which carries a shebang", () => {
    expect(pkg.bin).toEqual({ "vercel-deployment-mcp": "dist/index.js" });
    expect(pkg.main).toBe("dist/index.js");
    const built = readFileSync(DIST_INDEX, "utf8");
    expect(built.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(pkg.files ?? []).toContain("dist");
  });

  // Catches a module-system mismatch: package.json declares ESM, so the built
  // entry must be ESM and its relative imports must exist next to it.
  it("ships an ESM entry whose relative imports resolve inside dist", () => {
    expect(pkg.type).toBe("module");
    const built = readFileSync(DIST_INDEX, "utf8");
    expect(built).toMatch(/^import .+ from ".+";$/m);
    expect(built).not.toMatch(/\brequire\(/);
    const relative = [...built.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
    expect(relative.length).toBeGreaterThan(0);
    for (const spec of relative) {
      const resolved = new URL(spec, new URL("../../dist/", import.meta.url));
      expect(() => readFileSync(resolved, "utf8"), spec).not.toThrow();
    }
  });

  // Catches an exports map that would resolve the package to something other
  // than the entry main and bin name, leaving the three disagreeing.
  it("keeps any exports map in agreement with main", () => {
    if (pkg.exports === undefined) {
      expect(pkg.main).toBe(pkg.bin?.["vercel-deployment-mcp"]);
      return;
    }
    const flattened = JSON.stringify(pkg.exports);
    expect(flattened).toContain("dist/index.js");
  });

  // Catches an engines floor raised above the runtimes CI proves, or a README
  // that advertises a different floor than the manifest enforces.
  it("keeps the engines floor at or below the lowest CI runtime and the README claim", () => {
    const declared = pkg.engines?.node ?? "";
    const floor = Number(/>=\s*(\d+)/.exec(declared)?.[1]);
    expect(Number.isInteger(floor)).toBe(true);
    const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const matrixMajors = [...workflow.matchAll(/node:\s*\[([^\]]+)\]/g)].flatMap((m) =>
      m[1].split(",").map((v) => Number(v.trim())),
    );
    expect(matrixMajors.length).toBeGreaterThan(0);
    expect(floor).toBeLessThanOrEqual(Math.min(...matrixMajors));
    expect(floor).toBeLessThanOrEqual(Number(process.versions.node.split(".")[0]));
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`>=${floor}`);
  });

  // Catches a package identity drift between the manifest and the handshake
  // the server answers with.
  it("answers the handshake with the package name and version", () => {
    expect(team.initFrame?.result?.serverInfo?.version).toBe(pkg.version);
    expect(pkg.name.endsWith(`/${team.initFrame?.result?.serverInfo?.name}`)).toBe(true);
  });

  // Catches a built CLI that no longer starts, hangs, or announces itself on
  // the protocol channel instead of stderr.
  it("starts the built CLI and answers a handshake within five seconds", async () => {
    const fresh = startChild(baseEnv({ VERCEL_TOKEN: TOKEN }), false);
    try {
      const started = Date.now();
      const id = nextId();
      fresh.send({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cold-start", version: "0.0.0" },
        },
      });
      const frame = await fresh.wait(id, 5_000);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(frame.result?.serverInfo?.name).toBe("vercel-deployment-mcp");
      expect(fresh.stderr()).toContain("vercel-deployment-mcp ready (stdio)");
      for (const line of fresh.lines()) expect(JSON.parse(line).jsonrpc).toBe("2.0");
      expect(fresh.lines().some((l) => l.includes("ready (stdio)"))).toBe(false);
    } finally {
      fresh.kill();
    }
  }, 30_000);
});

describe("invariants: protocol surface", () => {
  // Catches a change to the revision served to a 2025 client; 2025-06-18 is
  // what the recorded state (43c0e88) opened with and was answered on.
  it("answers a 2025 client on the 2025-06-18 revision", () => {
    expect(team.initFrame?.error).toBeUndefined();
    expect(team.initFrame?.result?.protocolVersion).toBe("2025-06-18");
    expect(personal.initFrame?.result?.protocolVersion).toBe("2025-06-18");
  });

  // Catches capabilities advertised for features this server does not
  // implement, which would make a client issue calls that cannot be served.
  it("advertises only the tools capability", async () => {
    const capabilities = team.initFrame?.result?.capabilities ?? {};
    expect(Object.keys(capabilities)).toEqual(["tools"]);
    const resourcesId = nextId();
    const promptsId = nextId();
    team.send({ jsonrpc: "2.0", id: resourcesId, method: "resources/list" });
    team.send({ jsonrpc: "2.0", id: promptsId, method: "prompts/list" });
    const [resources, prompts] = await Promise.all([
      team.wait(resourcesId),
      team.wait(promptsId),
    ]);
    expect(resources.error?.code).toBe(-32601);
    expect(prompts.error?.code).toBe(-32601);
    expect(resources.result).toBeUndefined();
  });

  // Catches the modern-era discovery handler being installed on a connection
  // already pinned to the legacy era, which would blur the era boundary.
  it("refuses server/discover on a legacy-pinned connection", async () => {
    const id = nextId();
    team.send({ jsonrpc: "2.0", id, method: "server/discover", params: {} });
    const frame = await team.wait(id);
    expect(frame.error?.code).toBe(-32601);
    expect(frame.result).toBeUndefined();
  });

  // Catches an unknown tool name answered as a successful or merely
  // isError result instead of a JSON-RPC error frame.
  it("rejects an unknown tool name with a JSON-RPC error frame", async () => {
    const id = nextId();
    team.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    const frame = await team.wait(id);
    expect(frame.error?.code).toBe(-32602);
    expect(frame.result).toBeUndefined();
  });

  // Catches diagnostics moving onto the protocol channel: after every exchange
  // above, stdout must still be nothing but JSON-RPC frames.
  it("keeps stdout free of non-protocol output across the whole session", () => {
    const lines = team.lines();
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Frame;
      expect(parsed.jsonrpc).toBe("2.0");
    }
    expect(team.stderr()).toContain("vercel-deployment-mcp ready (stdio)");
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});
