/**
 * Tool contracts and schemas, over the wire.
 *
 * Lens: the four tools as a client sees them. What the published input schema
 * promises, what the input boundary actually accepts and rejects, what the
 * published output schema promises, and whether the structured content the
 * server emits keeps that promise for varied upstream shapes.
 *
 * Method: the black-box harness from test/stdio-purity.test.ts - the built
 * dist/index.js spawned as a child with a stubbed global fetch that refuses any
 * request outside https://api.vercel.com and any non-GET or bodied request.
 * Nothing here touches the network. Two sessions are started once for the whole
 * file (one with a team id configured, one without) and every test reuses them;
 * the server is stateless, so the tests are order independent.
 *
 * Assertions are on shapes, fields, codes, presence and absence. Sentences
 * produced inside node_modules are never asserted; where an error text is
 * checked it is checked for this repo's own schema keys and for the absence of
 * a JSON-RPC numeric code, never for vendor wording.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const ENDPOINT_PROFILE = "vercel-read-v1";
const EPOCH_MS = 1_700_000_000_000;
const ISO = new Date(EPOCH_MS).toISOString();

const PROJECT_FIELDS = ["framework", "id", "name", "updatedAt"];
const DEPLOYMENT_FIELDS = ["createdAt", "id", "name", "state", "target", "url"];

const LIST_TOOLS = ["list_projects", "list_deployments"] as const;
const ITEM_TOOLS = ["get_project", "get_deployment"] as const;
const ALL_TOOLS = ["get_deployment", "get_project", "list_deployments", "list_projects"] as const;

/**
 * Upstream bodies, keyed by the one argument value each call carries. The stub
 * derives the key from the request URL, so a test selects its fixture purely
 * through the tool arguments it sends.
 */
const SCENARIOS: Record<string, { status?: number; body: unknown }> = {
  "projects:default": {
    body: { projects: [{ id: "prj_1", name: "demo", framework: "nextjs", updatedAt: EPOCH_MS }] },
  },
  "projects:demo": {
    body: { projects: [{ id: "prj_1", name: "demo", framework: "nextjs", updatedAt: EPOCH_MS }] },
  },
  "projects:empty": { body: { projects: [] } },
  "projects:many": {
    body: {
      projects: Array.from({ length: 25 }, (_unused, i) => ({
        id: `prj_${i}`,
        name: `project-${i}`,
        framework: i % 2 === 0 ? "nextjs" : null,
        updatedAt: EPOCH_MS + i,
      })),
    },
  },
  "projects:leaky": {
    body: {
      projects: [
        {
          id: "prj_leaky",
          name: "leaky",
          framework: "nextjs",
          updatedAt: EPOCH_MS,
          accountId: "acct_should_not_appear",
          live: true,
          latestDeployments: [{ uid: "dpl_should_not_appear" }],
          targets: { production: { id: "dpl_x" } },
          link: { type: "github", repo: "o/r" },
          passwordProtection: null,
        },
      ],
    },
  },
  "projects:bare": { body: { projects: [{ id: "prj_bare", name: "bare" }] } },
  "projects:noname": { body: { projects: [{ id: "prj_nameless" }] } },
  "project:prj_wire": {
    body: {
      id: "prj_wire",
      name: "demo",
      framework: "nextjs",
      updatedAt: EPOCH_MS,
      accountId: "acct_should_not_appear",
      nodeVersion: "22.x",
      crons: { enabledAt: 1 },
    },
  },
  "project:prj_bare": { body: { id: "prj_bare", name: "bare" } },
  "project:forbidden": {
    status: 403,
    body: { error: { code: "forbidden", message: "not authorized for this scope" } },
  },
  "deployments:default": {
    body: {
      deployments: [
        {
          uid: "dpl_a",
          name: "app",
          url: "app.vercel.app",
          state: "READY",
          target: "production",
          createdAt: EPOCH_MS,
        },
      ],
    },
  },
  "deployments:READY": {
    body: {
      deployments: [
        {
          uid: "dpl_a",
          name: "app",
          url: "app.vercel.app",
          state: "READY",
          target: "production",
          createdAt: EPOCH_MS,
        },
      ],
    },
  },
  "deployments:prj_wire": {
    body: {
      deployments: [
        {
          uid: "dpl_a",
          name: "app",
          url: "app.vercel.app",
          state: "READY",
          target: "production",
          createdAt: EPOCH_MS,
        },
      ],
    },
  },
  "deployments:EMPTY": { body: { deployments: [] } },
  "deployments:MANY": {
    body: {
      deployments: Array.from({ length: 30 }, (_unused, i) => ({
        uid: `dpl_${i}`,
        name: "app",
        url: `d${i}.vercel.app`,
        readyState: "READY",
        target: i % 2 === 0 ? "production" : null,
        createdAt: EPOCH_MS + i,
      })),
    },
  },
  "deployments:LEAKY": {
    body: {
      deployments: [
        {
          uid: "dpl_leaky",
          id: "id_should_not_win",
          name: "app",
          url: "app.vercel.app",
          state: "READY",
          readyState: "QUEUED",
          target: "production",
          createdAt: EPOCH_MS,
          creator: { uid: "u_should_not_appear", username: "someone" },
          meta: { githubCommitSha: "deadbeef" },
          aliasAssigned: true,
          inspectorUrl: "https://vercel.com/inspect",
          buildingAt: EPOCH_MS,
        },
      ],
    },
  },
  "deployments:BARE": { body: { deployments: [{ uid: "dpl_bare" }] } },
  "deployments:BADSTATE": { body: { deployments: [{ uid: "dpl_bad", state: 99 }] } },
  "deployment:dpl_wire": {
    body: {
      uid: "dpl_wire",
      name: "app",
      url: "app.vercel.app",
      state: "READY",
      target: "production",
      createdAt: EPOCH_MS,
      ownerId: "owner_should_not_appear",
      plan: "pro",
    },
  },
  "deployment:dpl_bare": { body: { uid: "dpl_bare" } },
};

/**
 * The stubbed fetch, as source injected into the child. Mirrors the guard in
 * test/stdio-purity.test.ts: foreign origin, non-GET and bodied requests all
 * throw, so a test can never reach the real Vercel API.
 */
const FETCH_PRELOAD = [
  `const SCENARIOS = ${JSON.stringify(SCENARIOS)};`,
  "globalThis.fetch = async (input, init = {}) => {",
  "  const url = new URL(String(input));",
  "  if (url.origin !== 'https://api.vercel.com') throw new Error('unexpected origin');",
  "  if ((init.method ?? 'GET') !== 'GET' || init.body !== undefined) {",
  "    throw new Error('unexpected request');",
  "  }",
  "  const path = url.pathname;",
  "  let key;",
  "  if (path === '/v9/projects') {",
  "    key = 'projects:' + (url.searchParams.get('search') ?? 'default');",
  "  } else if (path.startsWith('/v9/projects/')) {",
  "    key = 'project:' + decodeURIComponent(path.slice('/v9/projects/'.length));",
  "  } else if (path === '/v6/deployments') {",
  "    const sel = url.searchParams.get('state') ?? url.searchParams.get('projectId') ?? 'default';",
  "    key = 'deployments:' + sel;",
  "  } else if (path.startsWith('/v13/deployments/')) {",
  "    key = 'deployment:' + decodeURIComponent(path.slice('/v13/deployments/'.length));",
  "  } else {",
  "    key = 'unroutable:' + path;",
  "  }",
  "  const hit = SCENARIOS[key];",
  "  if (!hit) {",
  "    return new Response(",
  "      JSON.stringify({ error: { code: 'no_fixture', message: 'no fixture for ' + key } }),",
  "      { status: 599 },",
  "    );",
  "  }",
  "  return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });",
  "};",
].join("\n");

type Schema = {
  $schema?: string;
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  additionalProperties?: boolean;
  minLength?: number;
  maximum?: number;
  minimum?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: unknown[];
  const?: unknown;
};

type Tool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, boolean>;
  inputSchema?: Schema;
  outputSchema?: Schema;
};

type Content = { type?: string; text?: string };

type Frame = {
  id?: number;
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: Content[];
    structuredContent?: Record<string, unknown>;
    tools?: Tool[];
  };
};

interface Session {
  child: ChildProcessWithoutNullStreams;
  tools: Tool[];
  tool(name: string): Tool;
  call(name: string, args?: Record<string, unknown>): Promise<Frame>;
  stderr(): string;
}

async function startSession(extraEnv: Record<string, string | undefined>): Promise<Session> {
  // The politeness throttle's 250 ms start-to-start spacing is real-time and is
  // covered by test/vercel.test.ts with an injected clock. Disable the spacing
  // here so this file's ~90 upstream round trips cost no wall-clock sleep; the
  // concurrency cap and every contract under test are unaffected.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VERCEL_MCP_MIN_INTERVAL_MS: "0",
    ...extraEnv,
  };
  delete env.NODE_OPTIONS;
  for (const [key, value] of Object.entries(extraEnv)) if (value === undefined) delete env[key];

  const child = spawn(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(FETCH_PRELOAD)}`, "dist/index.js"],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );

  const responses = new Map<number, Frame>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Frame;
        if (parsed.id !== undefined) responses.set(parsed.id, parsed);
      } catch {
        /* a non-JSON stdout line is the purity suite's problem, not this one */
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  const waitForId = (id: number): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const frame = responses.get(id);
        if (frame !== undefined) {
          clearInterval(timer);
          resolve(frame);
        } else if (Date.now() - start > 20_000) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for id ${id}; stderr so far: ${stderrBuffer}`));
        }
      }, 10);
    });

  let nextId = 1;
  const send = (msg: unknown): void => {
    child.stdin.write(JSON.stringify(msg) + "\n");
  };

  const initId = nextId++;
  send({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contracts-lens", version: "0.0.0" },
    },
  });
  await waitForId(initId);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listId = nextId++;
  send({ jsonrpc: "2.0", id: listId, method: "tools/list" });
  const listed = await waitForId(listId);
  const tools = listed.result?.tools ?? [];

  return {
    child,
    tools,
    tool(name: string): Tool {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`tool not listed: ${name}`);
      return found;
    },
    async call(name: string, args?: Record<string, unknown>): Promise<Frame> {
      const id = nextId++;
      const params: Record<string, unknown> = { name };
      if (args !== undefined) params.arguments = args;
      send({ jsonrpc: "2.0", id, method: "tools/call", params });
      return waitForId(id);
    },
    stderr: () => stderrBuffer,
  };
}

const TOKEN = "vc_contract_token_canary";
const TEAM_ID = "team_contract_canary";

let team: Session;
let solo: Session;
const validators = new Map<string, ValidateFunction>();
let ajv: InstanceType<typeof Ajv>;

beforeAll(async () => {
  [team, solo] = await Promise.all([
    startSession({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM_ID }),
    startSession({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: undefined }),
  ]);
  ajv = new Ajv({ strict: false });
  for (const tool of team.tools) {
    validators.set(tool.name, ajv.compile(tool.outputSchema as object));
  }
}, 60_000);

afterAll(() => {
  team?.child.kill();
  solo?.child.kill();
});

/** A rejected or failed call: a tool result, never a protocol error frame. */
function expectToolError(frame: Frame): string {
  expect(frame.error).toBeUndefined();
  expect(frame.result?.isError).toBe(true);
  expect(frame.result?.structuredContent).toBeUndefined();
  expect(frame.result?.content).toHaveLength(1);
  expect(frame.result?.content?.[0]?.type).toBe("text");
  const text = frame.result?.content?.[0]?.text ?? "";
  expect(text.length).toBeGreaterThan(0);
  // No JSON-RPC numeric code may be smuggled into human-facing tool-error text.
  expect(text).not.toMatch(/-3\d{4}\b/);
  expect(text).not.toMatch(/-\d{5}\b/);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(TEAM_ID);
  return text;
}

/** A successful call: structured content that validates against its own schema. */
function expectToolSuccess(frame: Frame, toolName: string): Record<string, unknown> {
  expect(frame.error).toBeUndefined();
  expect(frame.result?.isError, frame.result?.content?.[0]?.text).not.toBe(true);
  const structured = frame.result?.structuredContent;
  expect(structured).toBeDefined();
  const validate = validators.get(toolName)!;
  expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
  return structured as Record<string, unknown>;
}

function receiptOf(structured: Record<string, unknown>): {
  scopeKind?: string;
  appliedFilters?: string[];
  endpointProfile?: string;
} {
  return structured.receipt as { scopeKind?: string; appliedFilters?: string[]; endpointProfile?: string };
}

function itemsOf(structured: Record<string, unknown>): Array<Record<string, unknown>> {
  return structured.items as Array<Record<string, unknown>>;
}

describe("published tool schemas", () => {
  it("lists exactly the four documented tools, each with both schemas", async () => {
    // Catches a fifth tool (or a missing schema) shipping without the README table changing.
    expect(team.tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS]);
    for (const tool of team.tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect((tool.description ?? "").length).toBeGreaterThan(0);
    }
  });

  it("declares the JSON Schema 2020-12 dialect on every output schema", async () => {
    // Catches an output schema emitted under an older dialect, where the same keywords mean something else.
    for (const tool of team.tools) {
      expect(tool.outputSchema?.$schema, tool.name).toBe(DIALECT_2020_12);
      expect(ajv.validateSchema(tool.outputSchema as object), tool.name).toBe(true);
    }
  });

  it("declares the JSON Schema 2020-12 dialect on every input schema", async () => {
    // Catches an input schema a 2020-12 client cannot compile, so it silently stops pre-validating calls.
    for (const tool of team.tools) {
      expect(tool.inputSchema?.$schema, tool.name).toBe(DIALECT_2020_12);
      expect(tool.inputSchema?.type, tool.name).toBe("object");
      expect(ajv.validateSchema(tool.inputSchema as object), tool.name).toBe(true);
    }
  });

  it("publishes exactly the documented input knobs and nothing else", async () => {
    // Catches an undocumented input (a raw passthrough parameter, say) appearing on the tool surface.
    const expected: Record<string, string[]> = {
      list_projects: ["limit", "search"],
      get_project: ["idOrName"],
      list_deployments: ["limit", "projectId", "state"],
      get_deployment: ["idOrUrl"],
    };
    for (const [name, props] of Object.entries(expected)) {
      expect(Object.keys(team.tool(name).inputSchema?.properties ?? {}).sort(), name).toEqual(props);
    }
  });

  it("marks only the identifier inputs as required", async () => {
    // Catches a filter becoming mandatory, or an identifier becoming optional and the tool losing its subject.
    expect(team.tool("get_project").inputSchema?.required).toEqual(["idOrName"]);
    expect(team.tool("get_deployment").inputSchema?.required).toEqual(["idOrUrl"]);
    for (const name of LIST_TOOLS) {
      expect(team.tool(name).inputSchema?.required ?? [], name).toEqual([]);
    }
  });

  it("publishes the non-empty-string guard on every string input", async () => {
    // Catches min(1) surviving in code but vanishing from the published schema, so clients stop pre-rejecting blanks.
    const stringInputs: Array<[string, string]> = [
      ["list_projects", "search"],
      ["list_deployments", "projectId"],
      ["list_deployments", "state"],
      ["get_project", "idOrName"],
      ["get_deployment", "idOrUrl"],
    ];
    for (const [tool, field] of stringInputs) {
      const prop = team.tool(tool).inputSchema?.properties?.[field];
      expect(prop?.type, `${tool}.${field}`).toBe("string");
      expect(prop?.minLength, `${tool}.${field}`).toBe(1);
    }
  });

  it("publishes limit as an integer bounded to the documented 1..100", async () => {
    // Catches the README's "default 20, max 100" drifting away from the schema clients validate against.
    for (const name of LIST_TOOLS) {
      const limit = team.tool(name).inputSchema?.properties?.limit;
      expect(limit?.type, name).toBe("integer");
      expect(limit?.minimum, name).toBe(1);
      expect(limit?.maximum, name).toBe(100);
    }
  });

  it("mentions no cursor-pagination vocabulary anywhere on the tool surface", async () => {
    // Catches hasMore/nextCursor appearing in a schema while the README still promises a single uncursored page.
    for (const tool of team.tools) {
      const json = JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema });
      expect(json, tool.name).not.toMatch(/hasMore|nextCursor|"cursor"/i);
    }
  });

  it("promises no pagination in any tool title or description", async () => {
    // Catches the prose the model reads offering a second page the schema cannot express;
    // a different surface from the schema scan above, which never looks at the text fields.
    for (const tool of team.tools) {
      const prose = `${tool.title ?? ""} ${tool.description ?? ""}`;
      expect(prose, tool.name).not.toMatch(/hasMore|nextCursor|cursor|next page|paginat/i);
    }
  });

  it("closes the list envelope to exactly pageCount, items and receipt", async () => {
    // Catches a field added to the page envelope itself (hasMore, nextCursor, total) by name-independent
    // key comparison, so a paging field that dodges the vocabulary scan above is still caught.
    for (const name of LIST_TOOLS) {
      const out = team.tool(name).outputSchema!;
      expect(out.type, name).toBe("object");
      expect(out.additionalProperties, name).toBe(false);
      expect(Object.keys(out.properties ?? {}).sort(), name).toEqual([
        "items",
        "pageCount",
        "receipt",
      ]);
      expect(out.required?.slice().sort(), name).toEqual(["items", "pageCount", "receipt"]);
      expect(out.properties?.items?.type, name).toBe("array");
      expect(out.properties?.pageCount?.type, name).toBe("integer");
      expect(out.properties?.pageCount?.minimum, name).toBe(0);
    }
  });

  it("closes the single-item envelope to exactly item and receipt", async () => {
    // Same defect on the item tools: an envelope field appearing beside the projected item.
    for (const name of ITEM_TOOLS) {
      const out = team.tool(name).outputSchema!;
      expect(out.type, name).toBe("object");
      expect(out.additionalProperties, name).toBe(false);
      expect(Object.keys(out.properties ?? {}).sort(), name).toEqual(["item", "receipt"]);
      expect(out.required?.slice().sort(), name).toEqual(["item", "receipt"]);
    }
  });

  it("returns a list payload whose own keys match the published envelope", async () => {
    // The runtime half of the envelope contract: a field added to the response but not to the
    // schema (or the reverse) makes the two halves disagree, which is what a strict client trips on.
    for (const [name, args] of [
      ["list_projects", { search: "demo" }],
      ["list_deployments", {}],
    ] as const) {
      const structured = expectToolSuccess(await team.call(name, args), name);
      expect(Object.keys(structured).sort(), name).toEqual(["items", "pageCount", "receipt"]);
      const declared = Object.keys(team.tool(name).outputSchema?.properties ?? {}).sort();
      expect(Object.keys(structured).sort(), name).toEqual(declared);
    }
  });

  it("annotates all four tools read-only with no write hint", async () => {
    // Catches a tool shipping without the read-only hints, which is what a host uses to skip an approval prompt.
    for (const tool of team.tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      expect(Object.keys(tool.annotations ?? {}).sort(), tool.name).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
      ]);
    }
  });

  it("closes every projected item sub-schema to exactly the documented fields", async () => {
    // Catches a leaked upstream field becoming legal in the schema, which is how the projection quietly widens.
    const projected: Record<string, string[]> = {
      list_projects: PROJECT_FIELDS,
      get_project: PROJECT_FIELDS,
      list_deployments: DEPLOYMENT_FIELDS,
      get_deployment: DEPLOYMENT_FIELDS,
    };
    for (const [name, fields] of Object.entries(projected)) {
      const out = team.tool(name).outputSchema!;
      const item = out.properties?.items?.items ?? out.properties?.item;
      expect(item?.type, name).toBe("object");
      expect(item?.additionalProperties, name).toBe(false);
      expect(Object.keys(item?.properties ?? {}).sort(), name).toEqual(fields);
    }
  });

  it("requires exactly the always-present fields on each item sub-schema", async () => {
    // Catches framework or target becoming omittable, so clients that read them unconditionally start seeing undefined.
    for (const name of ["list_projects", "get_project"]) {
      const out = team.tool(name).outputSchema!;
      const item = out.properties?.items?.items ?? out.properties?.item;
      expect(item?.required?.slice().sort(), name).toEqual(["framework", "id", "name"]);
    }
    for (const name of ["list_deployments", "get_deployment"]) {
      const out = team.tool(name).outputSchema!;
      const item = out.properties?.items?.items ?? out.properties?.item;
      expect(item?.required?.slice().sort(), name).toEqual(["target"]);
    }
  });

  it("pins the receipt sub-schema on every tool", async () => {
    // Catches a tool dropping part of the receipt, or the endpoint profile stopping being a fixed constant.
    for (const tool of team.tools) {
      const receipt = tool.outputSchema?.properties?.receipt;
      expect(receipt?.type, tool.name).toBe("object");
      expect(receipt?.additionalProperties, tool.name).toBe(false);
      expect(Object.keys(receipt?.properties ?? {}).sort(), tool.name).toEqual([
        "appliedFilters",
        "endpointProfile",
        "scopeKind",
      ]);
      expect(receipt?.required?.slice().sort(), tool.name).toEqual([
        "appliedFilters",
        "endpointProfile",
        "scopeKind",
      ]);
      expect(receipt?.properties?.endpointProfile?.const, tool.name).toBe(ENDPOINT_PROFILE);
      expect(receipt?.properties?.scopeKind?.enum?.slice().sort(), tool.name).toEqual([
        "personal",
        "team",
      ]);
    }
  });

  it("bounds appliedFilters to each tool's own filter vocabulary", async () => {
    // Catches a receipt schema that would accept a filter name the tool cannot apply, or a repeated one.
    const projects = team.tool("list_projects").outputSchema?.properties?.receipt?.properties
      ?.appliedFilters;
    expect(projects?.maxItems).toBe(1);
    expect(projects?.items?.const).toBe("search");

    const deployments = team.tool("list_deployments").outputSchema?.properties?.receipt?.properties
      ?.appliedFilters;
    expect(deployments?.maxItems).toBe(2);
    expect(deployments?.items?.enum?.slice().sort()).toEqual(["projectId", "state"]);
    expect(deployments?.uniqueItems).toBe(true);

    for (const name of ITEM_TOOLS) {
      const item = team.tool(name).outputSchema?.properties?.receipt?.properties?.appliedFilters;
      expect(item?.maxItems, name).toBe(0);
    }
  });
});

describe("input schema boundary", () => {
  it("rejects a blank search instead of silently listing everything", async () => {
    // Catches the min(1) guard being dropped, which turns a blank filter into an unfiltered listing.
    const text = expectToolError(await team.call("list_projects", { search: "" }));
    expect(text).toContain("search");
  });

  it("rejects a blank projectId instead of silently listing every project's deployments", async () => {
    // Catches a blank project filter widening the scope of a deployment listing.
    const text = expectToolError(await team.call("list_deployments", { projectId: "" }));
    expect(text).toContain("projectId");
  });

  it("rejects a blank state instead of silently listing every state", async () => {
    // Catches a blank state filter widening the scope of a deployment listing.
    const text = expectToolError(await team.call("list_deployments", { state: "" }));
    expect(text).toContain("state");
  });

  it("rejects a blank idOrName rather than requesting an empty project path", async () => {
    // Catches a blank identifier reaching the URL builder and requesting the collection endpoint by accident.
    const text = expectToolError(await team.call("get_project", { idOrName: "" }));
    expect(text).toContain("idOrName");
  });

  it("rejects a blank idOrUrl rather than requesting an empty deployment path", async () => {
    // Catches a blank identifier reaching the URL builder and requesting the collection endpoint by accident.
    const text = expectToolError(await team.call("get_deployment", { idOrUrl: "" }));
    expect(text).toContain("idOrUrl");
  });

  it("rejects a call that omits a required identifier", async () => {
    // Catches a required identifier becoming optional, so the tool fetches something the caller never named.
    expect(expectToolError(await team.call("get_project", {}))).toContain("idOrName");
    expect(expectToolError(await team.call("get_deployment", {}))).toContain("idOrUrl");
  });

  it("rejects a non-string identifier", async () => {
    // Catches a number or object being coerced into a path segment instead of refused at the boundary.
    expect(expectToolError(await team.call("get_project", { idOrName: 42 }))).toContain("idOrName");
    expect(expectToolError(await team.call("get_deployment", { idOrUrl: null }))).toContain(
      "idOrUrl",
    );
  });

  it("rejects a string limit rather than coercing it", async () => {
    // Catches a schema that coerces "20" to 20, which would make the declared integer type a lie.
    expect(expectToolError(await team.call("list_projects", { limit: "20" }))).toContain("limit");
  });

  it("rejects a non-integer limit", async () => {
    // Catches a fractional limit reaching the upstream query string as "1.5".
    expect(expectToolError(await team.call("list_projects", { limit: 1.5 }))).toContain("limit");
  });

  it("rejects a limit outside the documented 1..100 at both ends", async () => {
    // Catches the bounds being dropped, letting limit=0 return nothing and limit=100000 hammer the API.
    expect(expectToolError(await team.call("list_projects", { limit: 0 }))).toContain("limit");
    expect(expectToolError(await team.call("list_projects", { limit: 101 }))).toContain("limit");
    expect(expectToolError(await team.call("list_deployments", { limit: 0 }))).toContain("limit");
    expect(expectToolError(await team.call("list_deployments", { limit: 101 }))).toContain("limit");
  });

  it("reports every rejection as a tool result, never as a protocol error frame", async () => {
    // Catches argument validation escaping as a JSON-RPC error, which a host renders as a transport fault, not a tool answer.
    const battery: Array<[string, Record<string, unknown>]> = [
      ["list_projects", { search: "" }],
      ["list_projects", { limit: -1 }],
      ["list_deployments", { state: "" }],
      ["list_deployments", { projectId: 7 }],
      ["get_project", {}],
      ["get_project", { idOrName: [] }],
      ["get_deployment", { idOrUrl: "" }],
      ["get_deployment", { idOrUrl: { a: 1 } }],
    ];
    for (const [name, args] of battery) {
      const frame = await team.call(name, args);
      expect(frame.error, `${name} ${JSON.stringify(args)}`).toBeUndefined();
      expectToolError(frame);
    }
  });

  it("ignores an unknown argument property without turning it into a filter", async () => {
    // Catches an unknown key being forwarded upstream or counted in the receipt as a filter that was never applied.
    const clean = expectToolSuccess(
      await team.call("list_projects", { search: "demo" }),
      "list_projects",
    );
    const withExtra = expectToolSuccess(
      await team.call("list_projects", { search: "demo", bogus: "x", limit_: 9 }),
      "list_projects",
    );
    expect(withExtra).toEqual(clean);
    expect(receiptOf(withExtra).appliedFilters).toEqual(["search"]);
  });

  it("treats an omitted arguments object as no arguments for the list tools", async () => {
    // Catches a crash or an error result when a client sends tools/call with no arguments key at all.
    for (const name of LIST_TOOLS) {
      const structured = expectToolSuccess(await team.call(name), name);
      expect(receiptOf(structured).appliedFilters, name).toEqual([]);
    }
  });

  it("still rejects an omitted arguments object for the identifier tools", async () => {
    // Catches an absent arguments key bypassing the required-identifier check the same call with {} would hit.
    expect(expectToolError(await team.call("get_project"))).toContain("idOrName");
    expect(expectToolError(await team.call("get_deployment"))).toContain("idOrUrl");
  });

  it("gives list_projects the same verdict a client gets from the published input schema", async () => {
    // Catches drift between what the schema tells a client to expect and what the server actually accepts.
    const validate = ajv.compile(team.tool("list_projects").inputSchema as object);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ search: "demo" }, true],
      [{ search: "demo", limit: 100 }, true],
      [{ search: "" }, false],
      [{ limit: 0 }, false],
      [{ limit: 101 }, false],
      [{ limit: 1.5 }, false],
      [{ limit: "20" }, false],
    ];
    for (const [args, schemaSaysValid] of cases) {
      expect(validate(args), JSON.stringify(args)).toBe(schemaSaysValid);
      const frame = await team.call("list_projects", args);
      expect(frame.result?.isError !== true, JSON.stringify(args)).toBe(schemaSaysValid);
    }
  });

  it("gives list_deployments the same verdict a client gets from the published input schema", async () => {
    // Catches drift between what the schema tells a client to expect and what the server actually accepts.
    const validate = ajv.compile(team.tool("list_deployments").inputSchema as object);
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ projectId: "prj_wire" }, true],
      [{ state: "READY" }, true],
      [{ projectId: "prj_wire", state: "READY", limit: 100 }, true],
      [{ projectId: "" }, false],
      [{ state: "" }, false],
      [{ limit: 0 }, false],
      [{ limit: 101 }, false],
    ];
    for (const [args, schemaSaysValid] of cases) {
      expect(validate(args), JSON.stringify(args)).toBe(schemaSaysValid);
      const frame = await team.call("list_deployments", args);
      expect(frame.result?.isError !== true, JSON.stringify(args)).toBe(schemaSaysValid);
    }
  });

  it("gives the identifier tools the same verdict a client gets from the published input schema", async () => {
    // Catches drift between what the schema tells a client to expect and what the server actually accepts.
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ["get_project", { idOrName: "prj_wire" }, true],
      ["get_project", {}, false],
      ["get_project", { idOrName: "" }, false],
      ["get_project", { idOrName: 42 }, false],
      ["get_deployment", { idOrUrl: "dpl_wire" }, true],
      ["get_deployment", {}, false],
      ["get_deployment", { idOrUrl: "" }, false],
      ["get_deployment", { idOrUrl: null }, false],
    ];
    for (const [name, args, schemaSaysValid] of cases) {
      const validate = ajv.compile(team.tool(name).inputSchema as object);
      expect(validate(args), `${name} ${JSON.stringify(args)}`).toBe(schemaSaysValid);
      const frame = await team.call(name, args);
      expect(frame.result?.isError !== true, `${name} ${JSON.stringify(args)}`).toBe(
        schemaSaysValid,
      );
    }
  });
});

describe("structured output contract", () => {
  it("returns an empty page as pageCount 0 with an empty items array", async () => {
    // Catches an empty upstream list becoming a missing items key or a null, which breaks every client loop.
    const projects = expectToolSuccess(
      await team.call("list_projects", { search: "empty" }),
      "list_projects",
    );
    expect(projects.pageCount).toBe(0);
    expect(projects.items).toEqual([]);
    const deployments = expectToolSuccess(
      await team.call("list_deployments", { state: "EMPTY" }),
      "list_deployments",
    );
    expect(deployments.pageCount).toBe(0);
    expect(deployments.items).toEqual([]);
  });

  it("keeps pageCount equal to items.length on a single-item page", async () => {
    // Catches pageCount being sourced from anywhere other than the array the client actually receives.
    const structured = expectToolSuccess(
      await team.call("list_projects", { search: "demo" }),
      "list_projects",
    );
    expect(structured.pageCount).toBe(1);
    expect(itemsOf(structured)).toHaveLength(1);
  });

  it("keeps a 25-project page self-consistent and free of pagination fields", async () => {
    // Catches a count/array mismatch or a cursor field appearing once a page is large enough to want one.
    const structured = expectToolSuccess(
      await team.call("list_projects", { search: "many" }),
      "list_projects",
    );
    expect(itemsOf(structured)).toHaveLength(25);
    expect(structured.pageCount).toBe(25);
    expect(structured).not.toHaveProperty("hasMore");
    expect(structured).not.toHaveProperty("nextCursor");
    for (const item of itemsOf(structured)) {
      expect(Object.keys(item).sort()).toEqual(PROJECT_FIELDS);
    }
  });

  it("keeps a 30-deployment page self-consistent and free of pagination fields", async () => {
    // Catches a count/array mismatch or a cursor field appearing once a page is large enough to want one.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { state: "MANY" }),
      "list_deployments",
    );
    expect(itemsOf(structured)).toHaveLength(30);
    expect(structured.pageCount).toBe(30);
    expect(structured).not.toHaveProperty("hasMore");
    expect(structured).not.toHaveProperty("nextCursor");
  });

  it("round-trips the text content to the same object at page scale", async () => {
    // Catches the text block and the structured block diverging, so a text-only client reads different data.
    for (const [name, args] of [
      ["list_projects", { search: "many" }],
      ["list_deployments", { state: "MANY" }],
      ["get_project", { idOrName: "prj_wire" }],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const frame = await team.call(name, args as Record<string, unknown>);
      const structured = expectToolSuccess(frame, name);
      expect(JSON.parse(frame.result?.content?.[0]?.text ?? ""), name).toEqual(structured);
    }
  });

  it("carries exactly one text content block on a successful call", async () => {
    // Catches a second content block (a stray log or image) appearing beside the JSON a client parses.
    for (const [name, args] of [
      ["list_projects", {}],
      ["list_deployments", {}],
      ["get_project", { idOrName: "prj_wire" }],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const frame = await team.call(name, args as Record<string, unknown>);
      expectToolSuccess(frame, name);
      expect(frame.result?.content, name).toHaveLength(1);
      expect(frame.result?.content?.[0]?.type, name).toBe("text");
    }
  });

  it("projects a project to exactly the four documented fields", async () => {
    // Catches upstream fields such as accountId or link leaking through the projection into a client's hands.
    const listed = expectToolSuccess(
      await team.call("list_projects", { search: "leaky" }),
      "list_projects",
    );
    const item = itemsOf(listed)[0];
    expect(Object.keys(item).sort()).toEqual(PROJECT_FIELDS);
    expect(JSON.stringify(listed)).not.toMatch(/accountId|latestDeployments|passwordProtection/);

    const fetched = expectToolSuccess(
      await team.call("get_project", { idOrName: "prj_wire" }),
      "get_project",
    );
    expect(Object.keys(fetched.item as object).sort()).toEqual(PROJECT_FIELDS);
    expect(JSON.stringify(fetched)).not.toMatch(/accountId|nodeVersion|crons/);
  });

  it("projects a deployment to exactly the six documented fields", async () => {
    // Catches upstream fields such as creator or inspectorUrl leaking through the projection into a client's hands.
    const listed = expectToolSuccess(
      await team.call("list_deployments", { state: "LEAKY" }),
      "list_deployments",
    );
    const item = itemsOf(listed)[0];
    expect(Object.keys(item).sort()).toEqual(DEPLOYMENT_FIELDS);
    expect(JSON.stringify(listed)).not.toMatch(/creator|inspectorUrl|aliasAssigned|buildingAt/);

    const fetched = expectToolSuccess(
      await team.call("get_deployment", { idOrUrl: "dpl_wire" }),
      "get_deployment",
    );
    expect(Object.keys(fetched.item as object).sort()).toEqual(DEPLOYMENT_FIELDS);
    expect(JSON.stringify(fetched)).not.toMatch(/ownerId|"plan"/);
  });

  it("never exposes readyState as its own field", async () => {
    // Catches the raw upstream state key being passed through beside the projected state field.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { state: "MANY" }),
      "list_deployments",
    );
    expect(JSON.stringify(structured)).not.toContain("readyState");
    for (const item of itemsOf(structured)) expect(item.state).toBe("READY");
  });

  it("prefers state over readyState when upstream sends both", async () => {
    // Catches the fallback order inverting, which would report a stale queued state for a ready deployment.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { state: "LEAKY" }),
      "list_deployments",
    );
    expect(itemsOf(structured)[0].state).toBe("READY");
  });

  it("prefers uid over id for deployment identity", async () => {
    // Catches the identity fallback inverting, so the tool reports an id that does not address the deployment.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { state: "LEAKY" }),
      "list_deployments",
    );
    expect(itemsOf(structured)[0].id).toBe("dpl_leaky");
  });

  it("emits framework as an explicit null and omits an absent updatedAt", async () => {
    // Catches framework becoming absent (clients read it unconditionally) or updatedAt appearing as a null or "undefined".
    const listed = expectToolSuccess(
      await team.call("list_projects", { search: "bare" }),
      "list_projects",
    );
    const item = itemsOf(listed)[0];
    expect(Object.keys(item).sort()).toEqual(["framework", "id", "name"]);
    expect(item.framework).toBeNull();
    expect("updatedAt" in item).toBe(false);

    const fetched = expectToolSuccess(
      await team.call("get_project", { idOrName: "prj_bare" }),
      "get_project",
    );
    expect(Object.keys(fetched.item as object).sort()).toEqual(["framework", "id", "name"]);
  });

  it("emits target as an explicit null and omits every other absent deployment field", async () => {
    // Catches target becoming absent, or absent optional fields being materialised as nulls the schema forbids.
    const fetched = expectToolSuccess(
      await team.call("get_deployment", { idOrUrl: "dpl_bare" }),
      "get_deployment",
    );
    const item = fetched.item as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(["id", "target"]);
    expect(item.target).toBeNull();
    expect(item.id).toBe("dpl_bare");
  });

  it("projects upstream epoch milliseconds as ISO-8601 UTC strings", async () => {
    // Catches a raw millisecond number reaching a client that the schema promised a string to.
    const project = expectToolSuccess(
      await team.call("get_project", { idOrName: "prj_wire" }),
      "get_project",
    );
    expect((project.item as Record<string, unknown>).updatedAt).toBe(ISO);
    const deployment = expectToolSuccess(
      await team.call("get_deployment", { idOrUrl: "dpl_wire" }),
      "get_deployment",
    );
    expect((deployment.item as Record<string, unknown>).createdAt).toBe(ISO);
    expect(String((deployment.item as Record<string, unknown>).createdAt)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("never lets structured content that violates its own output schema reach the client", async () => {
    // Catches a projection that drops a required field (an upstream project with no name) being served as valid data.
    const frame = await team.call("list_projects", { search: "noname" });
    const text = expectToolError(frame);
    expect(text).toContain("name");
  });

  it("never lets a wrongly typed projected field reach the client", async () => {
    // Catches a non-string upstream state being passed through where the schema promised a string.
    const frame = await team.call("list_deployments", { state: "BADSTATE" });
    const text = expectToolError(frame);
    expect(text).toContain("state");
  });

  it("returns an upstream 403 as a tool error with no structured content", async () => {
    // Catches an upstream denial surfacing as half a success (structured content beside an error flag).
    const text = expectToolError(await team.call("get_project", { idOrName: "forbidden" }));
    expect(text).toContain("403");
  });
});

describe("receipt", () => {
  it("reports search as the only applied filter when search is given", async () => {
    // Catches a receipt that under-reports the narrowing actually applied to the listing.
    const structured = expectToolSuccess(
      await team.call("list_projects", { search: "demo" }),
      "list_projects",
    );
    expect(receiptOf(structured).appliedFilters).toEqual(["search"]);
  });

  it("reports no applied filters when list_projects is called bare", async () => {
    // Catches a receipt claiming a filter that was never given, which would hide an unfiltered listing.
    const structured = expectToolSuccess(await team.call("list_projects", {}), "list_projects");
    expect(receiptOf(structured).appliedFilters).toEqual([]);
  });

  it("reports projectId alone when only projectId is given", async () => {
    // Catches the deployment receipt reporting a state filter that was never applied.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { projectId: "prj_wire" }),
      "list_deployments",
    );
    expect(receiptOf(structured).appliedFilters).toEqual(["projectId"]);
  });

  it("reports state alone when only state is given", async () => {
    // Catches the deployment receipt reporting a project filter that was never applied.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { state: "READY" }),
      "list_deployments",
    );
    expect(receiptOf(structured).appliedFilters).toEqual(["state"]);
  });

  it("reports both filters, in a stable order, when both are given", async () => {
    // Catches a duplicated or reordered receipt, which the schema's uniqueItems rule would then reject.
    const structured = expectToolSuccess(
      await team.call("list_deployments", { projectId: "prj_wire", state: "READY" }),
      "list_deployments",
    );
    expect(receiptOf(structured).appliedFilters).toEqual(["projectId", "state"]);
  });

  it("reports no applied filters when list_deployments is called bare", async () => {
    // Catches a receipt claiming a filter that was never given, which would hide an unfiltered listing.
    const structured = expectToolSuccess(await team.call("list_deployments", {}), "list_deployments");
    expect(receiptOf(structured).appliedFilters).toEqual([]);
  });

  it("does not count limit as an applied filter", async () => {
    // Catches a page-size knob being reported as a narrowing filter, which misleads a reader about coverage.
    const projects = expectToolSuccess(
      await team.call("list_projects", { limit: 5 }),
      "list_projects",
    );
    expect(receiptOf(projects).appliedFilters).toEqual([]);
    const deployments = expectToolSuccess(
      await team.call("list_deployments", { limit: 5 }),
      "list_deployments",
    );
    expect(receiptOf(deployments).appliedFilters).toEqual([]);
  });

  it("reports no applied filters on the identifier tools", async () => {
    // Catches an item fetch claiming a filter, which its own schema caps at zero entries.
    for (const [name, args] of [
      ["get_project", { idOrName: "prj_wire" }],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const structured = expectToolSuccess(
        await team.call(name, args as Record<string, unknown>),
        name,
      );
      expect(receiptOf(structured).appliedFilters, name).toEqual([]);
    }
  });

  it("reports team scope when a team id is configured", async () => {
    // Catches the receipt mislabelling a team-scoped read as personal, which misreports what the data covers.
    for (const [name, args] of [
      ["list_projects", {}],
      ["get_project", { idOrName: "prj_wire" }],
      ["list_deployments", {}],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const structured = expectToolSuccess(
        await team.call(name, args as Record<string, unknown>),
        name,
      );
      expect(receiptOf(structured).scopeKind, name).toBe("team");
    }
  });

  it("reports personal scope when no team id is configured", async () => {
    // Catches a hardcoded scope, or configuration being cached from a previous process rather than read per call.
    for (const [name, args] of [
      ["list_projects", {}],
      ["get_project", { idOrName: "prj_wire" }],
      ["list_deployments", {}],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const frame = await solo.call(name, args as Record<string, unknown>);
      const structured = expectToolSuccess(frame, name);
      expect(receiptOf(structured).scopeKind, name).toBe("personal");
    }
  });

  it("stamps the same endpoint profile on every tool result", async () => {
    // Catches one tool drifting onto a different endpoint family without the receipt saying so.
    for (const [name, args] of [
      ["list_projects", {}],
      ["get_project", { idOrName: "prj_wire" }],
      ["list_deployments", {}],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const structured = expectToolSuccess(
        await team.call(name, args as Record<string, unknown>),
        name,
      );
      expect(receiptOf(structured).endpointProfile, name).toBe(ENDPOINT_PROFILE);
    }
  });

  it("never echoes the configured token or team id in any tool result", async () => {
    // Catches a credential reaching the wire through a receipt or an error path that skipped redaction.
    for (const [name, args] of [
      ["list_projects", { search: "demo" }],
      ["get_project", { idOrName: "forbidden" }],
      ["list_deployments", { projectId: "prj_wire", state: "READY" }],
      ["get_deployment", { idOrUrl: "dpl_wire" }],
    ] as const) {
      const frame = await team.call(name, args as Record<string, unknown>);
      const serialized = JSON.stringify(frame);
      expect(serialized, name).not.toContain(TOKEN);
      expect(serialized, name).not.toContain(TEAM_ID);
    }
  });
});
